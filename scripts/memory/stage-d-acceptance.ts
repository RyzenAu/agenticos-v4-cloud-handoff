/**
 * Stage D acceptance, end to end on the SYNTHETIC setup (never the real vault, the pilot or 8081):
 *
 *   - Hindsight: the DEDICATED synthetic instance `stage-d` (API 8893, client proxy 8883, Postgres 5437;
 *     scripts/hindsight/stage-d-instance.ps1), never the shared `synth` or the pilot; a fresh bank
 *     `syn-stage-d-<run>` (the proxy allows syn-* for reads and writes);
 *   - vault: a TEMP copy of scripts/memory/fixtures/mini-wiki; app store: a TEMP folder;
 *   - AgenticOS: this worktree's dev server as a QUIET copy (AGENTIC_OS_NO_BACKGROUND=1: no schedulers,
 *     no Telegram, every other mutating route refused) on its own port, MU_MEMORY_WRITES=on, pointed at
 *     the synthetic proxy with no key, and the synthetic approval secret for deletes.
 *
 * The OS reaches Hindsight through a client proxy THIS SCRIPT starts (the deployed rev 3.1 proxy.py, unchanged)
 * from a temporary copy of the stage-d config: same API, bank rules and secrets, but the proxy's writer port is
 * this run's OS port with the writer capability ON, exactly as the live OS on 8081 is. The shared stage-d proxy
 * (8883) and its config file are never touched. The proxy sees the OS itself as the client (no relay in between),
 * which is what lets the OS register as the writer. Old comment follows, kept for the record: a small HTTP relay
 * owned by this script, which rewrote
 * Host to the proxy's own (the deployed rev 3.1 proxy refuses any other Host), so an OUTAGE is
 * simulated by closing the relay mid-sync (connections refused and reset), never by stopping the
 * shared synthetic instance other agents may be testing.
 *
 * It also checks the review fixes end to end: another localhost origin is refused, secrets are refused
 * by every route, a correction is read back before it supersedes, and agents save through
 * /__memory/mcp (then it runs scripts/hindsight/clients/client-shapes-check.ts against this copy).
 *
 * It drives the OS HTTP routes (/__memory/*) and the Jarvis intent path (/__operator/voice/free/turn,
 * and /voice/free/stt for a real spoken yes) and prints observed outputs as JSON. Keys are never read
 * or printed here; the OS process reads the approval secret itself at delete time.
 *
 *   bun scripts/memory/stage-d-acceptance.ts [--port 8095] [--out <file.json>] [--skip-outage]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVED_TOOLS } from "./mcp-tools";

const ROOT = resolve(import.meta.dir, "..", "..");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "8095"));
if (PORT === 8081 || PORT === 8888 || PORT === 8878) throw new Error("Refusing a live port.");
const OUT = arg("out", "");
const SKIP_OUTAGE = process.argv.includes("--skip-outage");
const PROXY_PORT = Number(arg("proxy-port", "8884"));
if ([8878, 8888].includes(PROXY_PORT)) throw new Error("Refusing the pilot.");
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
if (PROXY_PORT === 8883) throw new Error("Refusing the shared stage-d proxy: this script starts its own (default 8884).");
/** The OS talks to its own proxy directly. */
const RELAY = PROXY;
const STAGE_CONFIG = arg("stage-config", "D:\\hindsight\\stage-d\\hindsight.stage-d.json");
const PYTHON = arg("python", "D:\\hindsight\\venv\\Scripts\\python.exe");
const PROXY_PY = arg("proxy-py", "D:\\hindsight\\service\\proxy.py");
// Rev 3 keeps the synthetic document-delete secret in synth-docdelete.key, rev 2 in synth-approval.key.
// Only existence is checked here; the OS process reads it at delete time.
const SECRET_FILE = arg("delete-secret", "D:\\hindsight\\stage-d\\secrets\\stage-d-docdelete.key");
const SYN_API = `http://127.0.0.1:${arg("api-port", "8893")}`;
const RUN = randomBytes(3).toString("hex");
const BANK = `syn-stage-d-${RUN}`;
const WORK = mkdtempSync(join(tmpdir(), "mu-stage-d-"));
const VAULT = join(WORK, "vault");
const STATE = join(WORK, "state");
cpSync(join(ROOT, "scripts", "memory", "fixtures", "mini-wiki"), VAULT, { recursive: true });
mkdirSync(STATE, { recursive: true });

type Check = { step: string; check: string; ok: boolean; observed: unknown };
const results: Check[] = [];
const check = (step: string, name: string, ok: boolean, observed: unknown) => {
  results.push({ step, check: name, ok, observed });
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${name}`);
  if (!ok) console.log(`      observed: ${JSON.stringify(observed).slice(0, 900)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── HTTP with full header control (a spoofed Host must reach the server as sent) ─────────────
type Res = { status: number; body: any; headers: Record<string, string | string[] | undefined> };
/** One retry on a reset connection for reads (the dev server can drop a keep-alive socket). */
async function raw(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<Res> {
  try {
    return await rawOnce(url, init);
  } catch (e) {
    if ((init.method ?? "GET") !== "GET" || !/ECONNRESET|socket hang up/i.test(String((e as Error).message))) throw e;
    await sleep(2000);
    return rawOnce(url, init);
  }
}
function rawOnce(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<Res> {
  const u = new URL(url);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolveP, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? "GET", headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}), ...init.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* text */
          }
          resolveP({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.setTimeout(init.timeoutMs ?? 600_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const OS = `http://127.0.0.1:${PORT}`;
const host = { Host: `localhost:${PORT}` };
let token = "";
/** As the app's own page calls it: its own Origin and, on every POST, its page token (Stage B1). */
let session = "";
const page = () => ({ ...host, Origin: `http://localhost:${PORT}`, "Sec-Fetch-Site": "same-origin", ...(session ? { Cookie: session } : {}) });
const mem = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
  raw(`${OS}/__memory${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? host : { ...page(), "x-claude-os-token": token }), ...extra }, body });
/** As an agent process calls it (Claude Code, Hermes): no browser markers, no page token. */
const agentRpc = (id: number, method: string, params?: unknown) =>
  raw(`${OS}/__memory/mcp`, { method: "POST", headers: { ...host, "User-Agent": "stage-d-acceptance-agent" }, body: { jsonrpc: "2.0", id, method, params } });
const withToken = () => ({ "x-claude-os-token": token });
const history: { role: string; content: string | null }[] = [];
async function say(utterance: string, extra: { spokenYes?: string } = {}) {
  history.push({ role: "user", content: utterance });
  const r = await raw(`${OS}/__operator/voice/free/turn`, {
    method: "POST",
    headers: { ...page(), ...withToken() },
    body: { messages: history.slice(-12), context: [], sharing: false, ...extra },
  });
  history.push({ role: "assistant", content: typeof r.body?.content === "string" ? r.body.content : null });
  return r;
}
const proxy = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => raw(`${PROXY}/v1/default/banks/${BANK}${path}`, init);

// ── the acceptance proxy: its own copy of the stage-d proxy, writer port = this run's OS port ─────────────
let proxyProc: ChildProcess | null = null;
function proxyConfig(): string {
  const cfg = JSON.parse(readFileSync(STAGE_CONFIG, "utf8").replace(/^\uFEFF/, ""));
  const p = cfg.profiles["stage-d"];
  mkdirSync(join(WORK, "run"), { recursive: true });
  // Writes on (synthetic only), as stage-d-instance.ps1 does for the shared proxy: the flag lives in THIS run's run dir.
  writeFileSync(join(WORK, "run", "WRITES_ENABLED"), "on\n");
  p.run_dir = join(WORK, "run");
  p.proxy = { ...p.proxy, port: PROXY_PORT, writer_capability: "on", writer_port: PORT };
  delete p.proxy.write_images;
  const out = join(WORK, "hindsight.acceptance.json");
  writeFileSync(out, JSON.stringify(cfg, null, 2));
  return out;
}
function relayUp() {
  const cfg = proxyConfig();
  proxyProc = spawn(PYTHON, ["-X", "utf8", PROXY_PY, "--profile", "stage-d", "--config", cfg], { cwd: join(PROXY_PY, ".."), env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, stdio: "ignore", windowsHide: true });
  return Promise.resolve();
}
/** The outage switch: stop this script's own proxy (connections refused); relayUp() starts it again (the OS registers again). */
function relayDown() {
  if (proxyProc?.pid) spawnSync("taskkill", ["/PID", String(proxyProc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  proxyProc = null;
}

// ── the quiet preview server ─────────────────────────────────────────────────────────────
let server: ChildProcess | null = null;
const serverEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(HINDSIGHT_|MEMORY_|MU_MEMORY|MU_WIKI)/.test(k)) env[k] = v;
  return {
    ...env,
    AGENTIC_OS_NO_BACKGROUND: "1",
    ARGENTIC_PORT: String(PORT),
    // Its own optimiser cache: node_modules is a shared junction.
    AGENTIC_OS_VITE_CACHE_DIR: join(WORK, "vite-cache"),
    MU_MEMORY_WRITES: "on",
    HINDSIGHT_URL: RELAY,
    HINDSIGHT_BANK: BANK,
    HINDSIGHT_APPROVAL_SECRET_FILE: SECRET_FILE,
    MU_WIKI_ROOT: VAULT,
    MU_WIKI_VAULT_NAME: "stage-d-synthetic",
    MEMORY_STATE_DIR: STATE,
    // A FRESH device store for this run (since S1 every hub session after the first trusted one starts pending, and a
    // pending session is a program that can't approve a forget). The first page load here is trusted on first use,
    // so this run's one browser session is a confirmed human, as the owner's own browser is.
    MU_DATA_DIR: join(WORK, "data"),
  };
};
async function startServer() {
  server = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(PORT), "--strictPort"], { cwd: ROOT, env: serverEnv(), stdio: "ignore", windowsHide: true });
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const r = await mem("/status").catch(() => null);
    if (r?.status === 200) {
      // The owner's browser: a page navigation mints the hub's HUMAN session cookie (Stage B1). The page
      // and Jarvis calls below carry it, as the real browser does; the agent calls don't.
      // After a restart the SAME session cookie is reused (the device store persists): a second page load would mint
      // a second, pending session.
      if (!session) {
        const nav = await raw(`${OS}/memory/vault`, { headers: { ...host, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", Accept: "text/html" } });
        const set = ([] as string[]).concat((nav.headers["set-cookie"] as string[] | string | undefined) ?? []);
        session = set.map((c) => c.split(";")[0]).find((c) => c.startsWith("mu_session=")) ?? "";
      }
      token = (await raw(`${OS}/__token`, { headers: { ...host, ...(session ? { Cookie: session } : {}) } })).body?.token ?? "";
      return r.body;
    }
    await sleep(1500);
  }
  throw new Error("The preview server did not come up.");
}
function stopServer() {
  if (server?.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  server = null;
}
/** Sync, then wait until nothing is pending (the drain keeps going after /sync answers). */
async function settle(ms = 900_000) {
  await mem("/sync", {});
  const until = Date.now() + ms;
  for (;;) {
    const st = (await mem("/status")).body;
    if (st.pending === 0 || Date.now() > until) return st;
    await sleep(3000);
    if (st.errors?.length) await mem("/sync", {});
  }
}
async function waitIndexed(id: string, ms = 600_000) {
  if (!id) return null; // nothing was saved: the failed check above says why
  const until = Date.now() + ms;
  for (;;) {
    const r = (await mem(`/item/${id}`)).body;
    if (r?.row?.indexed === "confirmed" || Date.now() > until) return r;
    await sleep(3000);
  }
}
async function waitProxyHealthy(ms = 600_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await raw(`${PROXY}/health`).catch(() => null);
    if (r?.status === 200) return true;
    await sleep(3000);
  }
  return false;
}
const vaultRead = (rel: string) => readFileSync(join(VAULT, rel), "utf8");

async function main() {
  // Pre-flight: the synthetic proxy only.
  await relayUp();
  check("setup", "this script's own proxy (writer port = this OS port, capability on) healthy on the dedicated stage-d Hindsight", await waitProxyHealthy(300_000), { proxy: PROXY, bank: BANK, work: WORK, delete_secret: SECRET_FILE.split("\\").pop() });
  const st0 = await startServer();
  check("setup", "quiet preview up; ONE switch on; Hindsight via the proxy (relay); no key in the OS", st0.settings.mode === "on" && st0.settings.hindsight_url === RELAY && st0.settings.api_key === "missing", {
    port: PORT,
    settings: st0.settings,
    principal: st0.principal,
  });

  // 1 · save, then recall with the source cited ──────────────────────────────────────────
  const sync1 = await settle();
  check("1 save+recall", "initial sync of the synthetic vault: nothing pending", sync1.pending === 0 && sync1.counts.indexed === sync1.counts.docs, { pending: sync1.pending, counts: sync1.counts, errors: sync1.errors });
  const r1 = await say(`Remember that the synthetic Kittiwake${RUN} clinic opens at 7:15am on Mondays`);
  check("1 save+recall", "Jarvis 'remember that…' → Hindsight memory (rules, no model)", r1.status === 200 && /Hindsight memory/.test(r1.body.content) && r1.body.model === "rules", r1.body);
  // The spoken reply no longer carries the id (1 Oct 2026): read it from the app's own item list.
  const memId: string = (await mem(`/items?kind=memory&q=Kittiwake${RUN}`)).body?.items?.find((i: any) => /^mem-/.test(i.id))?.id ?? "";
  const r2 = await say(`Save this to the vault: the synthetic Kittiwake${RUN} clinic invoices on the 2nd of each month`);
  check("1 save+recall", "Jarvis 'save this to the vault…' → Obsidian note + Hindsight index", r2.status === 200 && /Saved to your "Business shared" note/.test(r2.body.content) && /indexed in Hindsight/i.test(r2.body.content), r2.body);
  const factId: string = (await mem(`/items?kind=fact&q=Kittiwake${RUN}%20invoices`)).body?.items?.find((i: any) => /^mf-/.test(i.id))?.id ?? "";
  await waitIndexed(memId);
  await waitIndexed(factId);
  const note = vaultRead("wiki/topics/business/memory-business-shared.md");
  check("1 save+recall", "the vault note holds the fact block", note.includes(`Kittiwake${RUN} clinic invoices on the 2nd`) && note.includes(factId), { factId, excerpt: note.slice(note.indexOf(factId) - 200, note.indexOf(factId) + 20) });
  const r3 = await say(`What do we know about the Kittiwake${RUN} clinic?`);
  check("1 save+recall", "Jarvis recall answers with the source cited", /\(from (your memory|your "[^"]+" note)\)/.test(r3.body.content ?? ""), r3.body);
  const rec1 = await mem("/recall", { query: `When does the Kittiwake${RUN} clinic open?` });
  const hit = rec1.body.facts?.find((f: any) => f.id === memId);
  check("1 save+recall", "HTTP recall: the memory comes back via Hindsight with its source", !!hit && hit.via.includes("hindsight") && rec1.body.hindsight === "ok", {
    hindsight: rec1.body.hindsight,
    facts: rec1.body.facts?.map((f: any) => ({ id: f.id, via: f.via, source: f.source, text: f.text, hindsight_text: f.hindsight_text })),
  });

  // 10 · the per-save model record ───────────────────────────────────────────────────────
  const item = await mem(`/item/${memId}`);
  const st1 = (await mem("/status")).body;
  check("10 model record", "the save records which model processed it (Hindsight receipts via the proxy)", !!item.body.row?.processed_by?.model, { item_processed_by: item.body.row?.processed_by, models: st1.models, recent: st1.recent.slice(0, 4) });

  // 2 · recall after a restart ──────────────────────────────────────────────────────────
  stopServer();
  await sleep(2000);
  await startServer();
  const rec2 = await mem("/recall", { query: `When does the Kittiwake${RUN} clinic open?` });
  const st2 = (await mem("/status")).body;
  check("2 restart", "after an OS restart, recall still finds it via Hindsight; nothing pending", !!rec2.body.facts?.find((f: any) => f.id === memId && f.via.includes("hindsight")) && st2.pending === 0, {
    facts: rec2.body.facts?.map((f: any) => ({ id: f.id, via: f.via })),
    pending: st2.pending,
    counts: st2.counts,
  });

  // 3 · an Obsidian edit appears in recall ───────────────────────────────────────────────
  const termsRel = "wiki/topics/business/proposal-terms.md";
  writeFileSync(join(VAULT, termsRel), vaultRead(termsRel).replace("valid for 21 days", "valid for 45 days"));
  await settle();
  const rec3 = await mem("/recall", { query: "How long are Osprey proposals valid?" });
  const doc3 = await proxy("/documents/n-proposal-terms");
  const t3 = rec3.body.facts?.find((f: any) => f.id === "n-proposal-terms");
  check("3 Obsidian edit", "the edit is in recall and in Hindsight; the old wording is gone", !!t3 && t3.text.includes("45 days") && !t3.text.includes("21 days") && String(doc3.body?.original_text ?? "").includes("45 days") && !String(doc3.body?.original_text ?? "").includes("21 days"), {
    recall: t3 && { id: t3.id, via: t3.via, text: t3.text },
    hindsight_doc: { status: doc3.status, has45: String(doc3.body?.original_text ?? "").includes("45 days") },
  });

  // 4 · a rename doesn't duplicate ───────────────────────────────────────────────────────
  const docsBefore = await proxy("/documents?limit=200");
  const playbook = (await mem("/items?kind=note&q=Receptionist%20Playbook")).body.items?.find((r: any) => r.title === "Receptionist Playbook");
  renameSync(join(VAULT, "wiki/topics/business/receptionist-playbook.md"), join(VAULT, "wiki/topics/business/receptionist-playbook-2026.md"));
  const sync4 = await mem("/sync", {});
  await settle();
  const docsAfter = await proxy("/documents?limit=200");
  const idsBefore = (docsBefore.body?.items ?? []).map((d: any) => d.id).sort();
  const idsAfter = (docsAfter.body?.items ?? []).map((d: any) => d.id).sort();
  const after4 = (await mem(`/item/${playbook?.id}`)).body;
  check("4 rename", "a rename keeps the note id: same document set in Hindsight, new path, no duplicate", !!playbook && JSON.stringify(idsBefore) === JSON.stringify(idsAfter) && after4.row?.source?.path === "wiki/topics/business/receptionist-playbook-2026.md", {
    note_id: playbook?.id,
    renames: sync4.body.renames,
    hindsight_docs_before: idsBefore.length,
    hindsight_docs_after: idsAfter.length,
    new_path: after4.row?.source?.path,
  });

  // 5 · a correction suppresses the old fact ─────────────────────────────────────────────
  const c5 = await mem("/correct", { id: memId, text: `The synthetic Kittiwake${RUN} clinic opens at 7:45am on Mondays.` });
  const newMem = c5.body.id;
  await settle();
  const rec5 = await mem("/recall", { query: `When does the Kittiwake${RUN} clinic open on Mondays?` });
  const old5 = await proxy(`/documents/${memId}`);
  const ids5 = rec5.body.facts?.map((f: any) => f.id) ?? [];
  const texts5 = (rec5.body.facts ?? []).map((f: any) => f.text).join(" | ");
  check("5 correction", "the corrected version is recalled; the old one is retracted from Hindsight and never shown", c5.status === 200 && ids5.includes(newMem) && !ids5.includes(memId) && old5.status === 404 && !texts5.includes("7:15am"), {
    correct: c5.body.message,
    recalled: rec5.body.facts?.map((f: any) => ({ id: f.id, via: f.via, text: f.text })),
    suppressed: rec5.body.suppressed,
    old_doc_in_hindsight: old5.status,
  });
  // The voice context is server-held per process (the restart above cleared it), so ask first.
  await say(`What do we know about the Kittiwake${RUN} clinic on Mondays?`);
  const v5ask = await say("Correct that: the synthetic Kittiwake" + RUN + " clinic opens at 8am on Mondays.");
  const beforeYes = (await mem(`/item/${newMem}`)).body?.row?.status;
  const v5 = await say("yes");
  check("5 correction", "Jarvis 'correct that…' reads the change back; only the yes supersedes", /Say yes to update it/.test(v5ask.body.content ?? "") && beforeYes === "current" && /Corrected/.test(v5.body.content ?? ""), { ask: v5ask.body, status_before_yes: beforeYes, after_yes: v5.body });
  const casual = await say("Actually, can you open my email inbox for me");
  check("5 correction", "'Actually, …' in ordinary speech is not a correction (it goes to the brain)", casual.body.route?.intent !== "memory" && !/Corrected|Update /.test(casual.body.content ?? ""), { model: casual.body.model, content: String(casual.body.content ?? "").slice(0, 120) });

  // 6 · single delete and forget a/b/c with approval ────────────────────────────────────
  const a6 = await mem("/forget", { kind: "unindex", target: "n-proposal-terms" });
  // The retract is queued behind the drain: wait (bounded) for Hindsight to drop it instead of reading it once.
  let a6doc = await proxy("/documents/n-proposal-terms");
  for (let i = 0; i < 30 && a6doc.status !== 404; i++) (await sleep(3000), (a6doc = await proxy("/documents/n-proposal-terms")));
  check("6 forget a (unindex)", "kind a: no approval; out of Hindsight; the note stays in the vault", a6.status === 200 && a6doc.status === 404 && existsSync(join(VAULT, termsRel)), { message: a6.body.message, hindsight_doc: a6doc.status });

  // kind b by voice, with a REAL spoken yes from the voice pipeline's own STT.
  const b1 = await say(`Remember that the synthetic Skua${RUN} account renews in July`);
  const skua: string = (await mem(`/items?kind=memory&q=Skua${RUN}`)).body?.items?.find((i: any) => /^mem-/.test(i.id))?.id ?? "";
  await waitIndexed(skua);
  const b2 = await say("Forget that");
  check("6 forget b (voice)", "'forget that' reads the plan back and asks for a yes", /Say yes to approve/.test(b2.body.content ?? ""), b2.body);
  const b3 = await say("yes");
  check("6 forget b (voice)", "a typed yes (no spoken-yes event) cannot approve; nothing removed", /spoken yes/.test(b3.body.content ?? "") && (await proxy(`/documents/${skua}`)).status === 200, b3.body);
  const wav = join(WORK, "yes.wav");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${wav}', $f); $s.Speak('Yes.'); $s.Dispose()`,
    ],
    { windowsHide: true, timeout: 60_000 },
  );
  const stt = existsSync(wav)
    ? await raw(`${OS}/__operator/voice/free/stt`, { method: "POST", headers: { ...page(), ...withToken() }, body: { audio: readFileSync(wav).toString("base64"), turn: true } })
    : { status: 0, body: null, headers: {} };
  const spokenYes = typeof stt.body?.spokenYes === "string" ? stt.body.spokenYes : "";
  check("6 forget b (voice)", "the voice pipeline's STT heard a clear yes and recorded a server-side event", !!spokenYes, { status: stt.status, text: stt.body?.text, spokenYes: spokenYes ? "recorded" : null });
  if (spokenYes) {
    const b4 = await say("Yes.", { spokenYes });
    const gone = await proxy(`/documents/${skua}`);
    check("6 forget b (voice)", "the spoken yes approves once: memory deleted from Hindsight and the app", /Deleted the memory/.test(b4.body.content ?? "") && gone.status === 404 && (await mem(`/item/${skua}`)).status === 404, { reply: b4.body.content, hindsight_doc: gone.status });
    const replay = await say("Yes.", { spokenYes });
    check("6 forget b (voice)", "the same spoken-yes event can't be replayed", replay.body.model !== "rules" || !/Deleted/.test(replay.body.content ?? ""), { model: replay.body.model, content: String(replay.body.content ?? "").slice(0, 120) });
  } else {
    // STT unavailable: the same approval completes on the Memory page instead (still server-held).
    const pend = (await mem("/approvals")).body.pending?.[0];
    const card = await mem("/approvals/card", { approval_id: pend?.id }, withToken());
    const g = await mem("/approvals/grant", { approval_id: pend?.id, card_nonce: card.body?.card_nonce }, withToken());
    check("6 forget b (page)", "approved on the Memory page's card instead: deleted", g.status === 200 && g.body?.result?.ok === true && (await proxy(`/documents/${skua}`)).status === 404, { grant: g.status, forget: g.body?.result?.message });
  }

  // kind c (full forget of the vault fact), through the Memory page's approval.
  const c1 = await mem("/forget", { kind: "full", target: factId });
  check("6 forget c (full)", "kind c: approval-required with the plan (source + derived copies)", c1.status === 202 && c1.body.code === "approval-required", { plan: c1.body.plan, approval: c1.body.approval && { id: c1.body.approval.id, expires_at: c1.body.approval.expires_at } });
  // From the app's own page but WITHOUT its page token.
  const noTok = await raw(`${OS}/__memory/approvals/grant`, { method: "POST", headers: page(), body: { approval_id: c1.body.approval?.id } });
  const noCard = await mem("/approvals/grant", { approval_id: c1.body.approval?.id }, withToken());
  check("6 forget c (full)", "granting without the page token, or with it but without the card's nonce, is refused", noTok.status === 403 && noCard.status === 403, { no_token: noTok.body, no_card: noCard.body });
  const forged = await mem("/forget", { kind: "full", target: factId, approval_id: "apr-0000000000000000" });
  check("6 forget c (full)", "a forged approval id removes nothing", forged.status === 403 && vaultRead("wiki/topics/business/memory-business-shared.md").includes(factId), forged.body);
  const card1 = await mem("/approvals/card", { approval_id: c1.body.approval?.id }, withToken());
  const g1 = await mem("/approvals/grant", { approval_id: c1.body.approval?.id, card_nonce: card1.body?.card_nonce }, withToken());
  const c2 = { status: g1.body?.result?.ok ? 200 : 422, body: g1.body?.result ?? {} };
  const c2doc = await proxy(`/documents/${factId}`);
  const c2rec = await mem("/recall", { query: `Kittiwake${RUN} invoices` });
  check("6 forget c (full)", "approved: the vault block is gone, Hindsight doc deleted, recall never shows it", g1.status === 200 && c2.status === 200 && !vaultRead("wiki/topics/business/memory-business-shared.md").includes(`Kittiwake${RUN} clinic invoices`) && c2doc.status === 404 && !(c2rec.body.facts ?? []).some((f: any) => f.id === factId), {
    message: c2.body.message,
    limits: c2.body.limits,
    hindsight_doc: c2doc.status,
  });
  const c3 = await mem("/forget", { kind: "full", target: factId, approval_id: c1.body.approval?.id });
  const c3b = await mem("/approvals/grant", { approval_id: c1.body.approval?.id, card_nonce: card1.body?.card_nonce }, withToken());
  check("6 forget c (full)", "the approval and its card are single use", c3.status !== 200 && c3b.status !== 200, { forget: { status: c3.status, code: c3.body.code }, card_again: c3b.status });

  // The proxy itself: no route to bulk delete; a delete without the approval path's token is refused.
  const bulk = await proxy("", { method: "DELETE" });
  const clear = await proxy("/memories", { method: "DELETE" });
  const unsigned = await proxy(`/documents/${newMem}`, { method: "DELETE" });
  check("6 bulk", "bank delete, clear and an unsigned document delete are refused by the proxy", bulk.status === 403 && clear.status === 403 && unsigned.status === 403, { bank_delete: bulk.body, clear: clear.body, unsigned: unsigned.body });

  // 7 · unauthenticated requests fail ────────────────────────────────────────────────────
  const u1 = await raw(`${OS}/__memory/status`, { headers: { Host: "evil.example" } });
  const u2 = await raw(`${OS}/__memory/recall`, { method: "POST", headers: { ...host, "X-Forwarded-For": "100.64.0.9" }, body: { query: "Kittiwake" } });
  const u3 = await raw(`${OS}/__operator/voice/free/turn`, { method: "POST", headers: { ...host, Origin: `http://localhost:${PORT}` }, body: { messages: [{ role: "user", content: "what do we know about Kittiwake" }] } });
  const u4 = await raw(`${SYN_API}/v1/default/banks/${BANK}/memories/recall`, { method: "POST", body: { query: "Kittiwake" } });
  const u5 = await raw(`${OS}/__memory/remember`, { method: "POST", headers: { ...host, "Sec-Fetch-Site": "cross-site" }, body: { text: "cross-site synthetic" } });
  const other = { ...host, Origin: "http://localhost:5173", "Sec-Fetch-Site": "same-site" };
  const x1 = await raw(`${OS}/__token`, { headers: other });
  const x2 = await raw(`${OS}/__memory/items`, { headers: other });
  const x3 = await raw(`${OS}/__memory/remember`, { method: "POST", headers: { ...other, "x-claude-os-token": token }, body: { text: "cross-origin synthetic" } });
  const x4 = await raw(`${OS}/__memory/forget`, { method: "POST", headers: { ...other, "x-claude-os-token": token }, body: { kind: "unindex", target: "n-proposal-terms" } });
  const x5 = await raw(`${OS}/__memory/remember`, { method: "POST", headers: page(), body: { text: "The synthetic page without a token." } });
  check("7 unauthenticated", "another localhost port can't read the token or memory, save or unindex (even with a valid token); the own page needs its token", [x1, x2, x3, x4, x5].every((r) => r.status === 403) && !x1.headers["access-control-allow-origin"], {
    token_from_other_origin: x1.status,
    items_from_other_origin: x2.status,
    save_from_other_origin: x3.status,
    unindex_from_other_origin: x4.status,
    own_page_without_token: x5.status,
  });
  check("7 unauthenticated", "foreign Host refused (the dev server's host check, 403, before memory); relayed without tailnet identity → 401; no page token → 403; direct Hindsight without key → 401; cross-site → 403", (u1.status === 401 || u1.status === 403) && !JSON.stringify(u1.body).includes("principal") && u2.status === 401 && u3.status === 403 && u4.status === 401 && u5.status === 403, {
    foreign_host: u1.status,
    relayed: u2.status,
    voice_turn_without_token: u3.status,
    direct_api_without_key: u4.status,
    cross_site: u5.status,
  });

  // Secrets: refused by every route, stored nowhere (owner's rule: credentials and financial secrets only).
  const pw = await say(`Remember that the synthetic Kittiwake${RUN} wifi password is correcthorsebatterystaple`);
  const bsb = await mem("/remember", { text: `Kittiwake${RUN}'s BSB is 062-000 and account 1234 5678` });
  const card = await mem("/vault/save", { text: `card 4111.1111.1111.1111 for Kittiwake${RUN}` });
  const phone = await mem("/remember", { text: `The synthetic Kittiwake${RUN} front desk mobile is 0412 345 678.` });
  check("secrets", "a password, a BSB/account and a card are refused by voice, save and vault; an ordinary phone number is stored", /password, key or token/.test(pw.body.content ?? "") && bsb.body.ok === false && card.body.ok === false && phone.body.ok === true, {
    voice_password: pw.body.content,
    bsb: bsb.body.message,
    card: card.body.message,
    phone: phone.body.message,
  });

  // Agents (Claude Code, Hermes) save through the OS, not straight into Hindsight.
  const tools = (await agentRpc(1, "tools/list")).body?.result?.tools?.map((t: { name: string }) => t.name);
  const aSave = JSON.parse((await agentRpc(2, "tools/call", { name: "remember", arguments: { text: `The synthetic Kittiwake${RUN} courier comes at 3pm.` } })).body?.result?.content?.[0]?.text ?? "{}");
  const aItem = aSave.id ? await waitIndexed(aSave.id) : null;
  const aForget = JSON.parse((await agentRpc(3, "tools/call", { name: "forget", arguments: { id: aSave.id } })).body?.result?.content?.[0]?.text ?? "{}");
  check("agents", "an agent saves through /__memory/mcp: screened, visible in the OS, model recorded; forget only asks", JSON.stringify(tools) === JSON.stringify(SERVED_TOOLS) && aSave.ok === true && aItem?.row?.id === aSave.id && !!aItem?.row?.processed_by && aForget.code === "approval-required" && (await proxy(`/documents/${aSave.id}`)).status === 200, {
    tools,
    save: aSave,
    processed_by: aItem?.row?.processed_by,
    forget: aForget,
  });

  // REVIEW-STAGE-D R2-1: the agent fetches the page token and tries to approve its own forget.
  const agentToken = (await raw(`${OS}/__token`, { headers: host })).body?.token ?? "";
  const pend = (await mem("/approvals")).body.pending?.find((x: { target: string }) => x.target === `memory:${aSave.id}`);
  const selfCard = await raw(`${OS}/__memory/approvals/card`, { method: "POST", headers: { ...host, "x-claude-os-token": agentToken }, body: { approval_id: pend?.id } });
  const selfGrant = await raw(`${OS}/__memory/approvals/grant`, { method: "POST", headers: { ...host, "x-claude-os-token": agentToken }, body: { approval_id: pend?.id, card_nonce: selfCard.body?.card_nonce } });
  const ownerCard = await mem("/approvals/card", { approval_id: pend?.id }); // even the owner's click: a program's request has no card
  const pageGrant = await mem("/approvals/grant", { approval_id: pend?.id, card_nonce: ownerCard.body?.card_nonce });
  const reForget = await raw(`${OS}/__memory/forget`, { method: "POST", headers: { ...host, "x-claude-os-token": agentToken }, body: { kind: "memory", target: aSave.id, approval_id: pend?.id } });
  check("agents", "R2-1: an agent can't approve its own forget (token or not), and a click can't answer a program's request; nothing removed", pend?.requested_actor === "process" && selfGrant.status === 403 && pageGrant.status === 403 && reForget.body?.ok !== true && (await proxy(`/documents/${aSave.id}`)).status === 200, {
    requested_actor: pend?.requested_actor,
    agent_grant: selfGrant.status,
    owner_click_grant: { status: pageGrant.status, reason: pageGrant.body?.reason },
    re_forget: reForget.body?.message ?? reForget.body?.error,
  });
  // REVIEW-STAGE-D R2-2: everyday phrasing through the agent route.
  const phr = JSON.parse((await agentRpc(9, "tools/call", { name: "remember", arguments: { text: `The Kittiwake${RUN} Xero password is now sunflowerfield` } })).body?.result?.content?.[0]?.text ?? "{}");
  check("secrets", "R2-2: 'the Xero password is now sunflowerfield' is refused through the agent route", phr.ok === false && phr.code === "prohibited-content", phr);

  // 8 · an outage mid-sync recovers with nothing lost or duplicated ───────────────────────
  if (!SKIP_OUTAGE) {
    const n8 = 6;
    const st0At = new Date().toISOString();
    for (let i = 0; i < n8; i++)
      writeFileSync(join(VAULT, `wiki/topics/business/stage-d-outage-${i}.md`), `---\ntitle: Synthetic Outage Note ${i}\n---\n\n# Synthetic Outage Note ${i}\n\nThe synthetic Petrel${RUN} depot number ${i} opens at ${6 + i}am.\n`);
    const syncing = mem("/sync", {}).catch((e) => ({ status: 0, body: { error: String(e) }, headers: {} }) as Res);
    // Let at least one of the new notes land, then cut the OS off from Hindsight mid-sync.
    const until = Date.now() + 600_000;
    let landed = 0;
    while (Date.now() < until && landed === 0) {
      await sleep(1000);
      landed = ((await mem("/status")).body.recent ?? []).filter((r: any) => r.op === "retain" && r.outcome === "ok" && r.at > st0At).length;
    }
    relayDown();
    const mid = await syncing;
    const st8 = (await mem("/status")).body;
    check("8 outage", "Hindsight cut off mid-sync: what didn't land stays queued with the reason; nothing lost", landed > 0 && st8.pending > 0 && st8.errors.length > 0, {
      landed_before_cut: landed,
      sync_during_outage: mid.status,
      pending: st8.pending,
      errors: st8.errors.slice(0, 3),
      hindsight: st8.hindsight,
    });
    await relayUp();
    const st9 = await settle();
    const docs9 = (await proxy("/documents?limit=500")).body?.items ?? [];
    const ids9: string[] = docs9.map((d: any) => d.id);
    const dupes = ids9.filter((id, i) => ids9.indexOf(id) !== i);
    const rec8 = await mem("/recall", { query: `When does the Petrel${RUN} depot number 3 open?` });
    check("8 outage", "after recovery: everything landed exactly once (no duplicate ids; the bank matches the desired set)", st9.pending === 0 && dupes.length === 0 && ids9.length === st9.counts.docs, {
      pending: st9.pending,
      hindsight_docs: ids9.length,
      desired_docs: st9.counts.docs,
      duplicates: dupes,
      retried: st9.recent.filter((r: any) => r.attempt > 1).slice(0, 6),
      recall: rec8.body.facts?.slice(0, 2).map((f: any) => ({ id: f.id, via: f.via, text: f.text })),
    });
  }

  // Client config shapes (Claude Code, Hermes, hindsight-ask) against this synthetic copy.
  const shapes = spawnSync(process.execPath, ["--no-env-file", "scripts/hindsight/clients/client-shapes-check.ts", "--os-port", String(PORT)], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 600_000 });
  let shapeOut: any = null;
  try {
    shapeOut = JSON.parse(shapes.stdout);
  } catch {
    shapeOut = { error: shapes.stderr.slice(-400) };
  }
  const mcpOk = (r: any) => r && r.tools_present && r.rewrite_or_delete_tools_exposed.length === 0 && r.save.ok && r.visible_in_os && r.recall_found_canary && r.password_refused;
  check("clients", "Claude Code and Hermes MCP shapes save and recall through the OS; the skill's curl recall works", mcpOk(shapeOut?.results?.[0]) && mcpOk(shapeOut?.results?.[1]) && shapeOut?.results?.[2]?.recall_found_canary === true, shapeOut);

  // The lead's switch-on verification script, pointed at this synthetic copy (its defaults are the live OS).
  // Spawned asynchronously: this process owns the relay the OS reaches Hindsight through, so a blocking
  // spawnSync would starve the relay and time out every save.
  const verify = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(
      process.execPath,
      ["--no-env-file", "scripts/memory/stage-d-verify-live.ts", "--os-port", String(PORT), "--proxy-port", String(PROXY_PORT), "--bank", BANK, "--expect-url", RELAY, "--skip-approval", "--skip-hindsight-mcp"],
      { cwd: ROOT, windowsHide: true, env: { ...process.env, STAGE_D_SESSION: session } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 900_000);
    child.on("close", (status) => (clearTimeout(timer), done({ status, stdout, stderr })));
  });
  const verifyLines = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.split(/\r?\n/).filter((l) => l.trim());
  check("switch-on verify", "the switch-on verification script (save, recall, correction, single delete, model per save) passes against this copy", verify.status === 0, { exit: verify.status, output: verifyLines });

  // 10 · (again) the model record after all of the above ─────────────────────────────────
  const stEnd = (await mem("/status")).body;
  check("10 model record", "per-save model record present across the run (saves per model)", Object.keys(stEnd.models ?? {}).length > 0, { models: stEnd.models, recent: stEnd.recent.slice(0, 6) });

  stopServer();
  relayDown();
  const out = { run: RUN, bank: BANK, port: PORT, work: WORK, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ passed: out.passed, failed: out.failed, bank: BANK, work: WORK }));
}

main()
  .catch((e) => {
    console.error("acceptance aborted:", (e as Error).message);
    process.exitCode = 1;
    // Keep what was observed up to the abort.
    if (OUT) writeFileSync(OUT, JSON.stringify({ run: RUN, bank: BANK, port: PORT, aborted: (e as Error).message, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }, null, 2) + "\n");
  })
  .finally(() => (stopServer(), relayDown()));
