#!/usr/bin/env bun
/**
 * A SYNTHETIC hub and the Dot gateway in front of it, on THIS PC, for the gateway's staging proof (r11). Never the live hub,
 * never the Ryzen staging pair (8086/8096), never Tailscale: both listen on 127.0.0.1 only and nothing is exposed.
 *
 *   bun scripts/gateway/staging-local.ts seed   [--data D:\AgenticOS-r11-data\gw]       a new folder, seeded with fake records
 *   bun scripts/gateway/staging-local.ts start  [--data ...] [--hub-port 8194] [--gateway-port 8195] [--memory on] [--ui dist/client]   (--ui: the built UI bundle, scripts/gateway/build-ui.ts)
 *   bun scripts/gateway/staging-local.ts proof  [--data ...] [--gateway-port 8195] [--out docs/programme-20261001/evidence-notes/...md]
 *   bun scripts/gateway/staging-local.ts stop   [--data ...]
 *   bun scripts/gateway/staging-local.ts status [--hub-port 8194] [--gateway-port 8195]
 *
 * The hub: the worktree's own dev server in the server role with MU_GATEWAY_TRUST=1 and MU_SYNTHETIC_HUB=1, its data in the
 * synthetic folder, a synthetic HOME (no CLI sign-ins, no keys), memory off, Hindsight off, no Jev key (so Jev is
 * "unavailable" and only exact commands run, as on any hub without the key). Every inherited variable whose NAME looks like a
 * credential is dropped (names only; values are never read or printed), and so is every MU_/AGENTIC_OS_/provider variable.
 *
 * `proof` drives the gateway the way Dot's program would (bearer mode, from outside the hub), with a SYNTHETIC enrolment code
 * minted in-process against the synthetic folder, and writes request/response SUMMARIES (method, path, status, a few safe
 * fields) to a markdown file. No code, key, token, cookie or body text is written.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCli } from "./cli";
import { gatewayDir } from "./config";

const argv = process.argv.slice(2);
const action = argv[0] ?? "status";
const arg = (n: string, d = "") => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] ?? d) : d);
const repo = resolve(import.meta.dir, "..", "..");
const data = resolve(arg("data", "D:\\AgenticOS-r11-data\\gw"));
const side = `${data}-side`;
const hubPort = Number(arg("hub-port", "8194"));
const gatewayPort = Number(arg("gateway-port", "8195"));
const pidFile = join(side, "pids.json");

for (const p of [hubPort, gatewayPort]) if (!(p >= 8120 && p <= 8199) || [8081, 8085, 8086, 8090, 8092, 8096, 8443, 8445].includes(p)) throw new Error(`Refusing port ${p}: this synthetic pair runs on 8120-8199 only.`);
if (!/AgenticOS-r\d+-data/i.test(data) || /\.operator-data|mu-hub|production/i.test(data)) throw new Error(`Refusing ${data}: the data folder must be under a D:\\AgenticOS-r<N>-data folder.`);

const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSW|AUTH|CREDENTIAL|COOKIE|SESSION|(^|_)PAT($|_)|BEARER|PRIVATE)/i;
const DROPPED_PREFIX = /^(MU_|AGENTIC_OS_|HINDSIGHT_|HERMES_|CODEX_|CLAUDE_|OPENCLAW|CLINE|OLLAMA|LMSTUDIO|OPENROUTER|ANTHROPIC|OPENAI|GROQ|GEMINI|ELEVEN|TWILIO|RETELL|STRIPE|TELEGRAM|TYPESAFE|JEV_|OneDrive)/i;
function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SENSITIVE_NAME.test(k) && !DROPPED_PREFIX.test(k)) env[k] = v;
  for (const k of Object.keys(extra)) for (const e of Object.keys(env)) if (e.toLowerCase() === k.toLowerCase()) delete env[e];
  return { ...env, ...extra };
}

async function answers(url: string, ms = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.status;
  } catch {
    return 0;
  }
}

function seed() {
  // The acceptance seed (fake people, leads and bots, the .gate-seed.json marker) and the CRM schema migration.
  const r = spawnSync(process.execPath, [join(repo, "scripts", "acceptance", "r7", "hub.ts"), "seed", "--data", data, "--repo", repo], { cwd: repo, encoding: "utf8", env: scrubbedEnv({}) });
  process.stdout.write(r.stdout ?? "");
  if (r.status !== 0) throw new Error(`seed failed: ${(r.stderr || "").slice(0, 400)}`);
  mkdirSync(join(side, "designs", "synthetic-dental"), { recursive: true });
  writeFileSync(join(side, "designs", "synthetic-dental", "index.html"), "<!doctype html><title>Synthetic Dental Co</title><h1>Synthetic Dental Co (concept)</h1>\n");
  mkdirSync(join(side, "release-logs"), { recursive: true });
  writeFileSync(join(side, "release-logs", "release-20261004T090000.json"), JSON.stringify({ time: "2026-10-04T09:00:00+10:00", oldHead: "82d6962d", newHead: "82d6962d", rollbackTag: "rollback/synthetic-staging", backup: "SYNTHETIC-NO-BACKUP", envCopy: "SYNTHETIC-NO-ENV", crmMigrated: false }, null, 1));
  writeFileSync(join(data, ".synthetic-hub"), "r11 gateway staging: synthetic data only\n");
  console.log(`Seeded ${data} (synthetic). Designs and release receipts for the proof are in ${side}.`);
}

async function start() {
  if (!existsSync(join(data, ".gate-seed.json"))) throw new Error(`${data} was not made by the seed; run "seed" first.`);
  if (await answers(`http://127.0.0.1:${hubPort}/__health`)) throw new Error(`Something already answers on ${hubPort}.`);
  if (await answers(`http://127.0.0.1:${gatewayPort}/gw/health`)) throw new Error(`Something already answers on ${gatewayPort}.`);
  const home = join(side, "home");
  for (const d of [home, join(home, ".config"), join(home, "Desktop"), join(home, "AppData", "Roaming"), join(home, "AppData", "Local"), join(side, "logs"), join(side, "vite-cache"), join(side, "bin"), join(data, "lead-site-builds")]) mkdirSync(d, { recursive: true });
  // A signed-out `vercel` stub first on PATH, as the acceptance hub has (the real CLI would open a browser to sign in).
  writeFileSync(join(side, "bin", "vercel.cmd"), "@echo Error: No existing credentials found (synthetic stub) 1>&2\r\n@exit /b 1\r\n");
  const hubEnv = scrubbedEnv({
    MU_DATA_DIR: data,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    MU_HUB_ROLE: "server",
    MU_SYNTHETIC_HUB: "1",
    MU_GATEWAY_TRUST: "1",
    HINDSIGHT_URL: "off",
    MU_WIKI_ROOT: join(data, "synthetic-vault"),
    MEMORY_STATE_DIR: join(data, "memory"),
    // --memory on: local memory writes on, confined to the synthetic folder (Hindsight stays off).
    MU_MEMORY_WRITES: arg("memory", "off") === "on" ? "on" : "off",
    MU_TRIGGERS: "off",
    MU_TRIGGERS_NOTIFY: "0",
    AGENTIC_OS_NO_CODEX: "1",
    AGENTIC_OS_VITE_CACHE_DIR: join(side, "vite-cache"),
    MU_DESIGN_PROJECTS_DIR: join(side, "designs"),
    MU_RELEASE_RECEIPTS_DIR: join(side, "release-logs"),
    MU_LEAD_SITE_BUILDS: join(data, "lead-site-builds"),
    MU_SEARXNG_URL: "http://127.0.0.1:9",
    BROWSER: "none",
    PATH: `${join(side, "bin")};${process.env.PATH ?? ""}`,
    CI: "1",
  });
  const out = openSync(join(side, "logs", "hub.out.log"), "a");
  const err = openSync(join(side, "logs", "hub.err.log"), "a");
  const hub = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--configLoader", "native", "--port", String(hubPort), "--strictPort", "--host", "127.0.0.1"], { cwd: repo, env: hubEnv, detached: true, stdio: ["ignore", out, err], windowsHide: true });
  hub.unref();
  const end = Date.now() + 240_000;
  while (Date.now() < end && !(await answers(`http://127.0.0.1:${hubPort}/__health`, 3000))) await Bun.sleep(1500);
  if (!(await answers(`http://127.0.0.1:${hubPort}/__health`, 3000))) throw new Error(`The hub did not answer; see ${join(side, "logs")}.`);
  const gwOut = openSync(join(side, "logs", "gateway.out.log"), "a");
  const gateway = spawn(process.execPath, ["scripts/gateway/main.ts"], {
    cwd: repo,
    env: scrubbedEnv({ MU_DATA_DIR: data, MU_GATEWAY_PORT: String(gatewayPort), MU_GATEWAY_UPSTREAM: `http://127.0.0.1:${hubPort}`, MU_GATEWAY_PUBLIC_ORIGIN: `http://127.0.0.1:${gatewayPort}`, ...(arg("ui") ? { MU_GATEWAY_UI_DIR: resolve(arg("ui")) } : {}) }),
    detached: true,
    stdio: ["ignore", gwOut, gwOut],
    windowsHide: true,
  });
  gateway.unref();
  for (let i = 0; i < 100 && !(await answers(`http://127.0.0.1:${gatewayPort}/gw/health`)); i++) await Bun.sleep(200);
  writeFileSync(pidFile, JSON.stringify({ hub: hub.pid, gateway: gateway.pid, hubPort, gatewayPort }));
  console.log(JSON.stringify({ started: true, hub: { port: hubPort, health: await answers(`http://127.0.0.1:${hubPort}/__health`) }, gateway: { port: gatewayPort, health: await answers(`http://127.0.0.1:${gatewayPort}/gw/health`) } }));
}

function stop() {
  if (!existsSync(pidFile)) return console.log("Nothing recorded as running.");
  const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { hub?: number; gateway?: number };
  for (const pid of [pids.gateway, pids.hub]) if (pid && Number.isInteger(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  rmSync(pidFile, { force: true });
  console.log("Stopped the synthetic hub and its gateway.");
}

// ── the proof ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function proof() {
  const origin = `http://127.0.0.1:${gatewayPort}`;
  const dir = gatewayDir(repo, { MU_DATA_DIR: data });
  const rows: string[] = [];
  const secrets: string[] = [];
  let step = 0;
  const say = (heading: string) => rows.push("", `### ${heading}`, "", "| # | Request | Status | What came back (summary) |", "|---|---|---|---|");
  const cell = (s: unknown) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 300);
  let bearer = "";
  async function req(method: string, path: string, body?: unknown, opts: { auth?: string | null; headers?: Record<string, string>; summary?: (j: any, text: string) => string } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const token = opts.auth === undefined ? bearer : opts.auth;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const started = Date.now();
    const res = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* a page */
    }
    const summary = opts.summary ? opts.summary(json, text) : json?.error ? `error: ${json.error}` : text.slice(0, 120);
    rows.push(`| ${++step} | \`${method} ${path.replace(/\?.*$/, (q) => q.slice(0, 60))}\` | ${res.status} | ${cell(summary)} (${Date.now() - started} ms) |`);
    return { status: res.status, json, text };
  }
  const cli = (...a: string[]) => {
    const lines: string[] = [];
    const code = runCli(a, dir, (l) => lines.push(l));
    return { code, text: lines.join("\n") };
  };

  say("1. The public surface: the gateway only");
  await req("GET", "/gw/health", undefined, { auth: null });
  await req("GET", "/__version", undefined, { auth: null, summary: (j) => `anonymous: ${j?.error}; renew path ${j?.renew}` });
  await req("GET", "/src/main.tsx", undefined, { auth: null, summary: (j) => `anonymous: ${j?.error ?? "refused"}` });

  say("2. Enrol with a synthetic one-time code (bearer mode, as Dot's program); reconnect key shown once");
  const minted = cli("enrol-code", "--by", "usman", "--label", "Dot (staging proof)", "--minutes", "5", "--identity-days", "1");
  const code = /code for Dot: ([A-Z0-9-]+)/.exec(minted.text)?.[1] ?? "";
  secrets.push(code, code.replace(/-/g, ""));
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts enrol-code --by usman --label "Dot (staging proof)" --minutes 5 --identity-days 1\` | exit ${minted.code} | a one-time code was printed (not recorded here) |`);
  await req("POST", "/gw/enrol", { code: "AAAAA-AAAAA-AAAAA-AAAAA", mode: "bearer" }, { auth: null, headers: { "X-MU-Gateway-Enrol": "1" } });
  const enrolled = await req("POST", "/gw/enrol", { code, mode: "bearer" }, { auth: null, headers: { "X-MU-Gateway-Enrol": "1" }, summary: (j) => `identity ${j?.identity?.id} "${j?.identity?.label}", enrolled by ${j?.identity?.enrolledBy}; reconnect key: ${j?.reconnectKey ? "returned once (not recorded)" : "missing"}; access: ${j?.access?.mode}, idle ${j?.access?.idleMinutes} min` });
  const reconnectKey = String(enrolled.json?.reconnectKey ?? "");
  bearer = String(enrolled.json?.access?.accessToken ?? "");
  const identityId = String(enrolled.json?.identity?.id ?? "");
  secrets.push(reconnectKey, bearer);
  await req("POST", "/gw/enrol", { code, mode: "bearer" }, { auth: null, headers: { "X-MU-Gateway-Enrol": "1" }, summary: (j) => `the same code again: ${j?.error}` });
  await req("GET", "/gw/me", undefined, { summary: (j) => `person ${j?.person}; session mode ${j?.session?.mode}; capabilities ${j?.capabilities?.map((c: { name: string }) => c.name).join(", ")}` });
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts identities\` | exit 0 | ${cell(cli("identities").text.replace(/\s+/g, " ").slice(0, 160))} |`);

  say("3. Deny by default, then a founder grants the operating set");
  await req("GET", "/__gateway/capabilities", undefined, { summary: (j) => (j?.rows ?? []).map((r: { capability: string; state: string }) => `${r.capability}: ${r.state}`).join("; ") });
  await req("POST", "/__gateway/crm/ops", { name: "crm.company.create", input: { name: "Synthetic Staging Dental Co" } });
  const granted = cli("grant", "operate", "--by", "usman", "--until-identity");
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts grant operate --by usman --until-identity\` | exit ${granted.code} | ${cell(granted.text.split("\n").length - 1)} capabilities granted until the identity ends |`);
  await req("GET", "/gw/me", undefined, { summary: (j) => `identity ends ${j?.expiry?.identity?.expiresAt ? new Date(j.expiry.identity.expiresAt).toISOString() : "?"}; ${j?.expiry?.grants?.length} grants with expiry; renewSoon ${j?.expiry?.renewSoon}` });
  await req("GET", "/__gateway/capabilities", undefined, { summary: (j) => (j?.rows ?? []).map((r: { capability: string; state: string }) => `${r.capability}: ${r.state}`).join("; ") });

  say("4. Business records: read and reversibly update a synthetic CRM record");
  const created = await req("POST", "/__gateway/crm/ops", { name: "crm.company.create", input: { name: "Synthetic Staging Dental Co", locality: "Mount Druitt", notes: "synthetic staging record" } }, { summary: (j) => `ok ${j?.ok}; company ${j?.data?.id} v${j?.data?.version}, locality ${j?.data?.locality}` });
  const id = String(created.json?.data?.id ?? "");
  await req("POST", "/__gateway/crm/read", { name: "crm.record.get", input: { ref: { kind: "company", id } } }, { summary: (j) => `ok ${j?.ok}; read back: ${JSON.stringify(j?.data?.company?.name ?? j?.data?.name ?? "").slice(0, 60)}` });
  const changed = await req("POST", "/__gateway/crm/ops", { name: "crm.company.update", input: { id, expectedVersion: created.json?.data?.version, patch: { locality: "Rooty Hill" } } }, { summary: (j) => `ok ${j?.ok}; locality now ${j?.data?.locality} (v${j?.data?.version})` });
  await req("POST", "/__gateway/crm/ops", { name: "crm.company.update", input: { id, expectedVersion: changed.json?.data?.version, patch: { locality: "Mount Druitt" } } }, { summary: (j) => `ok ${j?.ok}; reverted: locality ${j?.data?.locality} (v${j?.data?.version})` });
  await req("POST", "/__gateway/crm/ops", { name: "crm.activity.add", input: { ref: { kind: "company", id }, eventId: "staging-proof:note-1", kind: "note", title: "Drafted an intro (not sent)", communicationState: "drafted" } }, { summary: (j) => `ok ${j?.ok}; a draft note, recorded as Dot's` });
  await req("POST", "/__gateway/crm/ops", { name: "crm.activity.add", input: { ref: { kind: "company", id }, eventId: "staging-proof:sent-1", kind: "email", title: "Sent", communicationState: "sent" } }, { summary: (j) => `${j?.error ?? j?.text} (outbound stays the owner's)` });
  await req("POST", "/__gateway/crm/ops", { name: "crm.document.create", input: { companyId: id, title: "Invoice", status: "issued" } }, { summary: (j) => `${j?.error ?? j?.text}` });
  await req("POST", "/__gateway/crm/ops", { name: "crm.company.update", input: { id, expectedVersion: 3, patch: { emailAllowed: true } } }, { summary: (j) => `${j?.error ?? j?.text}`.slice(0, 160) });
  const deal = await req("POST", "/__gateway/crm/ops", { name: "crm.deal.create", input: { companyId: id, title: "Synthetic website", service: "website", oneOffCents: 150000, recurringCents: 0, gstTreatment: "exclusive", commercialBasis: "agreed" } }, { summary: (j) => `ok ${j?.ok}; deal ${j?.data?.id}` });
  await req("POST", "/__gateway/crm/ops", { name: "crm.invoice.draft", input: { dealId: deal.json?.data?.id, expectedVersion: deal.json?.data?.version } }, { summary: (j) => `ok ${j?.ok}; document status ${j?.data?.document?.status}; total ${j?.data?.totalCents} c; ${j?.text}` });
  await req("POST", "/__gateway/crm/ops", { name: "crm.csv.export", input: { kind: "companies" } }, { summary: (j) => `ok ${j?.ok}; ${j?.text}` });
  await req("POST", "/__gateway/crm/read", { name: "crm.automations.list", input: {} }, { summary: (j) => `ok ${j?.ok}; ${(j?.data ?? []).length} rules` });

  say("4b. Business finance and authorised mailboxes");
  await req("GET", "/__gateway/finance/summary?period=all", undefined, { summary: (j) => `scope ${j?.scope}; ${j?.rows} business rows; ${j?.note ?? j?.error ?? ""}` });
  await req("GET", "/__gateway/finance/stripe", undefined, { summary: (j) => `${j?.note ?? j?.error}` });
  await req("GET", "/__gateway/mail/threads?mailbox=hello@synthetic.example", undefined, { summary: (j) => `before authorising: ${j?.error ?? "listed"}` });
  const authorised = cli("authorise-mailbox", "hello@synthetic.example", "--by", "usman");
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts authorise-mailbox hello@synthetic.example --by usman\` | exit ${authorised.code} | a synthetic mailbox authorised |`);
  await req("GET", "/__gateway/mail/mailboxes", undefined, { summary: (j) => `${(j?.mailboxes ?? []).length} authorised mailboxes${j?.error ? `; ${j.error}` : ""}` });
  await req("GET", "/__gateway/mail/threads?mailbox=hello@synthetic.example", undefined, { summary: (j) => `${j?.error ?? `${(j?.threads ?? []).length} threads (the synthetic archive is empty)`}` });
  await req("GET", "/__gateway/release", undefined, { summary: (j) => `${j?.error ?? `${(j?.releases ?? []).length} releases`}` });

  say("5. Files in the approved roots");
  await req("GET", "/__gateway/files/roots", undefined, { summary: (j) => (j?.roots ?? []).map((r: { name: string; writable: boolean; ready: boolean }) => `${r.name} (${r.writable ? "rw" : "ro"}, ${r.ready ? "ready" : "not set up"})`).join(", ") });
  const page = await req("GET", "/__gateway/files/read?root=designs&path=synthetic-dental/index.html", undefined, { summary: (j) => `${j?.bytes} bytes, ${j?.encoding}, sha256 ${String(j?.sha256).slice(0, 12)}` });
  const w1 = await req("POST", "/__gateway/files/write", { root: "drafts", path: "staging-proof/note.md", content: "# Staging proof\nsynthetic\n", expectedSha256: "absent" }, { summary: (j) => `created ${j?.created}; sha256 ${String(j?.sha256).slice(0, 12)}` });
  await req("POST", "/__gateway/files/write", { root: "drafts", path: "staging-proof/note.md", content: "# Staging proof\nchanged\n", expectedSha256: w1.json?.sha256 }, { summary: (j) => `previous ${String(j?.previousSha256).slice(0, 12)} -> ${String(j?.sha256).slice(0, 12)}` });
  await req("GET", "/__gateway/files/read?root=drafts&path=../../control.json", undefined);
  void page;

  say("6. A harmless Jarvis task through the Jev-led command path, and its result");
  const task = await req("POST", "/__gateway/tasks", { text: "open the leads page", eventId: `staging-proof-${Date.now()}` }, { summary: (j) => `job ${j?.jobId}; ok ${j?.ok}; kind ${j?.kind}; said: ${j?.said}` });
  if (task.json?.jobId) {
    for (let i = 0; i < 20; i++) {
      const j = await fetch(`${origin}/__gateway/jobs/${task.json.jobId}`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json() as Promise<any>);
      if (["succeeded", "failed", "cancelled"].includes(j?.job?.state)) break;
      await Bun.sleep(500);
    }
    await req("GET", `/__gateway/jobs/${task.json.jobId}`, undefined, { summary: (j) => `state ${j?.job?.state}; owner ${JSON.stringify(j?.job?.principal)}; ${j?.job?.steps?.length} steps; last step: ${String(j?.job?.steps?.at(-1)?.intent ?? "").slice(0, 120)}; note: ${String(j?.job?.note ?? "").slice(0, 80)}` });
  }
  await req("POST", "/__gateway/tasks", { text: "open notepad on my pc" }, { summary: (j) => `ok ${j?.ok}; said: ${j?.said}` });
  await req("GET", "/__gateway/jobs?limit=5", undefined, { summary: (j) => `${j?.jobs?.length} of Dot's jobs, owners: ${[...new Set((j?.jobs ?? []).map((x: { principal: { personId: string } }) => x.principal.personId))].join(",")}` });

  say("7. Shared bot computers (this synthetic hub has none)");
  await req("GET", "/__gateway/bots", undefined, { summary: (j) => `${j?.bots?.length} bots; ${j?.note ?? ""}${j?.unsupported ? " (unsupported here)" : ""}` });
  await req("POST", "/__gateway/bots/research/takeover", {}, { summary: (j) => `${j?.error}` });

  say(`8. Memory (${arg("memory", "off") === "on" ? "ON on this synthetic hub (--memory on; Hindsight off)" : "off on this hub: the owner's switch"})`);
  await req("POST", "/__gateway/memory/remember", { text: "Synthetic staging fact: the staging gateway proof ran.", title: "Staging proof" }, { summary: (j) => `${j?.ok ? `saved ${j?.id}` : `${j?.code ?? ""}: ${j?.message ?? j?.error}`}` });
  await req("POST", "/__gateway/memory/recall", { query: "staging gateway proof" }, { summary: (j) => `${j?.facts?.length ?? 0} facts (withheld ${j?.withheld ?? 0}); ${j?.off ?? j?.error ?? ""}` });

  say("9. Coding (needs the owner to list dot on a repository)");
  await req("POST", "/__gateway/coding/draft", { utterance: "In AgenticOS, add a comment to README.md.", requestId: crypto.randomUUID() }, { summary: (j) => `${j?.kind ?? ""} ${j?.reason ?? j?.question ?? j?.error ?? ""}` });

  say("10. Diagnostics and operations");
  await req("GET", "/__health", undefined, { summary: (j) => `status ${j?.status}; role ${j?.hubRole}; failed: ${(j?.failed ?? []).map((f: { component: string }) => f.component).join(",") || "none"}` });
  await req("GET", "/__version", undefined, { summary: (j) => `version ${j?.version}, ${j?.gitSha}${j?.dirty ? " (dirty)" : ""}` });
  await req("GET", "/__gateway/diagnostics", undefined, { summary: (j) => `health ${j?.health?.status}; ${j?.version?.gitSha}; kill switch ${j?.gateway?.killSwitch}; components: ${Object.entries(j?.health?.components ?? {}).map(([k, v]) => `${k}=${(v as { status: string }).status}`).join(" ")}` });
  await req("GET", "/__gateway/diagnostics/releases", undefined, { summary: (j) => `configured ${j?.configured}; ${(j?.receipts ?? []).map((r: { file: string; newHead: string; rollbackTag: string }) => `${r.file} -> ${r.newHead} (rollback ${r.rollbackTag})`).join("; ")}` });
  await req("GET", "/__gateway/diagnostics/jobs?limit=3", undefined, { summary: (j) => `${j?.jobs?.length} jobs from the job log (founders' as shape only)` });
  await req("GET", "/__gateway/diagnostics/actions?tail=200", undefined, { summary: (j) => `${j?.actions?.length} actions recorded, all by ${[...new Set((j?.actions ?? []).map((a: { person: string }) => a.person))].join(",")}` });

  say("11. Final actions and private surfaces stay closed with everything granted");
  for (const [m, p] of [["POST", "/__approvals/abc/decide"], ["POST", "/__operator/screen/command"], ["POST", "/__crm/ops"], ["GET", "/__devices/me"], ["GET", "/__gateway/admin/access"], ["GET", "/__operator/coding/accounts"], ["POST", "/__memory/remember"], ["GET", "/@fs/C:/Windows/win.ini"]] as const) await req(m, p, m === "POST" ? {} : undefined);

  say("12. Reconnect in a new task, then revoke");
  const renewed = await req("POST", "/gw/renew", { reconnectKey, mode: "bearer" }, { auth: null, headers: { "X-MU-Gateway-Enrol": "1" }, summary: (j) => `new access for identity ${j?.identity?.id}: ${j?.access?.accessToken ? "a new bearer token (not recorded)" : "none"}` });
  const second = String(renewed.json?.access?.accessToken ?? "");
  secrets.push(second);
  await req("GET", "/gw/me", undefined, { auth: second, summary: (j) => `person ${j?.person}; a different session ${j?.session?.id !== enrolled.json?.access?.session}` });
  const renewedAccess = cli("renew", "--by", "usman", "--days", "30");
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts renew --by usman --days 30\` | exit ${renewedAccess.code} | ${cell(renewedAccess.text.split("\n")[0])} |`);
  await req("GET", "/gw/me", undefined, { auth: second, summary: (j) => `after renewal: identity ends ${j?.expiry?.identity?.expiresAt ? new Date(j.expiry.identity.expiresAt).toISOString() : "?"}; renewSoon ${j?.expiry?.renewSoon}` });
  const revoked = cli("revoke-identity", identityId);
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts revoke-identity ${identityId}\` | exit ${revoked.code} | ${cell(revoked.text)} |`);
  await req("GET", "/__version", undefined, { summary: (j) => `${j?.error} (reason ${j?.reason})` });
  await req("GET", "/__version", undefined, { auth: second, summary: (j) => `${j?.error} (reason ${j?.reason})` });
  await req("POST", "/gw/renew", { reconnectKey, mode: "bearer" }, { auth: null, headers: { "X-MU-Gateway-Enrol": "1" } });
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts revoke-grant --all\` | exit ${cli("revoke-grant", "--all").code} | grants cleared after the proof |`);

  say("13. The kill switch");
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts kill on\` | exit ${cli("kill", "on").code} | |`);
  await req("GET", "/gw/health", undefined, { auth: null, summary: (j) => JSON.stringify(j) });
  rows.push(`| ${++step} | console: \`bun scripts/gateway/cli.ts kill off\` | exit ${cli("kill", "off").code} | |`);
  await req("GET", "/gw/health", undefined, { auth: null, summary: (j) => JSON.stringify(j) });

  const report = rows.join("\n");
  const leaked = secrets.filter((s) => s && s.length >= 16 && report.includes(s));
  if (leaked.length) throw new Error("A secret would have been written to the evidence file; nothing was written.");
  const out = resolve(repo, arg("out", "docs/programme-20261001/evidence-notes/R11-GATEWAY-STAGING-PROOF.md"));
  mkdirSync(resolve(out, ".."), { recursive: true });
  const head = [
    "# Dot gateway: staging proof on a synthetic hub (r11)",
    "",
    `Run: ${new Date().toISOString()} by \`bun scripts/gateway/staging-local.ts proof\` against a SYNTHETIC hub (127.0.0.1:${hubPort}, server role, MU_GATEWAY_TRUST=1, MU_SYNTHETIC_HUB=1, memory off, no Jev key) and the gateway (127.0.0.1:${gatewayPort}, API only, no UI bundle). Branch r11/gateway-20261004. Nothing was exposed: both listen on loopback; no Tailscale command was run.`,
    "",
    "Every request below went through the gateway as Dot's program would send it (bearer mode). The enrolment code was synthetic, minted in-process against the synthetic data folder. Summaries only: no code, reconnect key, access token, cookie or request body is recorded (the script refuses to write the file if one would be).",
  ].join("\n");
  writeFileSync(out, `${head}\n${report}\n`);
  console.log(`Wrote ${out} (${step} steps).`);
}

if (import.meta.main) {
  const run = { seed, start, stop, proof, status: async () => console.log(JSON.stringify({ hub: await answers(`http://127.0.0.1:${hubPort}/__health`), gateway: await answers(`http://127.0.0.1:${gatewayPort}/gw/health`) })) }[action];
  if (!run) {
    console.log("usage: bun scripts/gateway/staging-local.ts seed|start|proof|stop|status   (see the top of the file)");
    process.exit(2);
  }
  await run();
}
