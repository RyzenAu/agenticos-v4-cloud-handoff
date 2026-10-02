/**
 * Round 5 memory acceptance (2 Oct 2026): Hindsight + Obsidian shared memory proven end to end on the REAL Hindsight engine
 * (the pilot's API on 127.0.0.1:8888) and the REAL memory module, with a DISPOSABLE bank and a TEMP vault. Every claim is read
 * back through recall, the engine's own documents and the Memory page's approval path, never from a write call's own success.
 *
 *   - Engine: the pilot's API (8888). It is reached through THIS run's own client proxy (the deployed proxy.py, unchanged, port 8868),
 *     built from a temporary copy of the pilot profile whose bank rules allow ONLY the disposable bank r5-acceptance-<stamp>-<run>
 *     (never mu-shared), whose writer port is this run's hub port and whose document-delete secret is a fresh random file. The pilot's
 *     own proxy (8878), its config, its banks and the live hub (8081) are not touched. The engine key is read by the proxy process from
 *     the pilot's key file by reference; this script never reads or prints it.
 *   - Hub: this worktree's vite dev server as a QUIET copy (AGENTIC_OS_NO_BACKGROUND=1) on 8160 with a temp MU_DATA_DIR, temp state
 *     dir and a temp vault (a copy of the synthetic mini-wiki under D:/prog-scratch).
 *   - The bank is deleted at the end with the operator command (supervisor.py admin delete-bank) and its absence is proved from the
 *     engine's own database tables.
 *
 * Safety assertions run first: the bank name must start r5-acceptance- and must not be mu-shared or mu-pilot; the vault must sit under
 * the scratch folder and not under the owner's real vault; the ports must not be 8081, 8140, 8878, 8883 or 8893.
 *
 *   bun --no-env-file scripts/memory/r5-acceptance.ts [--port 8160] [--proxy-port 8868] [--out <file.json>]
 *
 * Parameters (defaults are the original pilot-engine values, so a plain run is unchanged). Added 2 Oct 2026 so the SAME script can run
 * against a SYNTHETIC engine on another machine (Ryzen-PC), never against production there:
 *   --profile <name>        the Hindsight profile used as the engine (and operator target); default "pilot". On any other profile the
 *                           script refuses an engine or database on 8888, 8878 or 5432.
 *   --config <file>         the profiles file; default D:\hindsight\service\hindsight.profiles.json
 *   --engine-logs <dir>     the engine's log folder scanned for credential strings; default D:\hindsight\logs\<profile>
 *   --scratch <dir>         scratch root (vault copy, state, data, run folder); default D:/prog-scratch/r5-rx
 *   --root <dir>            the AgenticOS checkout whose hub is run (read only here); default: the checkout holding this script
 *   --home <dir>            HOME/USERPROFILE for the hub process (so it never sees the real ~/.config); default: unchanged
 *   --python <exe>, --service-dir <dir>   the Hindsight venv python and the deployed service folder (defaults D:\hindsight\...)
 * Forbidden hub/proxy ports: 8081, 8082, 8083, 8093, 8140, 8444, 8878, 8883, 8888, 8893.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ROOT = resolve(arg("root", resolve(import.meta.dir, "..", "..")));
const { handoffFact, handoffFactNeutral, handoffFactTitle } = (await import(pathToFileURL(join(ROOT, "scripts", "coding", "orchestrator.ts")).href)) as typeof import("../coding/orchestrator");
const PORT = Number(arg("port", "8160"));
const PROXY_PORT = Number(arg("proxy-port", "8868"));
const FORBIDDEN_PORTS = [8081, 8082, 8083, 8093, 8140, 8444, 8878, 8883, 8893, 8888];
for (const [what, p] of [["hub", PORT], ["proxy", PROXY_PORT]] as const) if (FORBIDDEN_PORTS.includes(p)) throw new Error(`Refusing ${what} port ${p}: a live or shared service.`);
const OUT = arg("out", "");
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const PROFILE = arg("profile", "pilot");
if (!/^[A-Za-z0-9_-]{1,32}$/.test(PROFILE)) throw new Error(`Refusing profile name ${PROFILE}.`);
const PILOT_CONFIG = arg("config", "D:\\hindsight\\service\\hindsight.profiles.json");
const PYTHON = arg("python", "D:\\hindsight\\venv\\Scripts\\python.exe");
const SERVICE_DIR = arg("service-dir", "D:\\hindsight\\service");
const PILOT_LOGS = arg("engine-logs", `D:\\hindsight\\logs\\${PROFILE}`);
const HOME_OVERRIDE = arg("home", "");
/** On a non-pilot profile (a synthetic engine), refuse anything that points at the production ports. */
{
  const cfg0 = JSON.parse(readFileSync(PILOT_CONFIG, "utf8").replace(/^\uFEFF/, ""));
  const p0 = { ...(cfg0.defaults ?? {}), ...(cfg0.profiles?.[PROFILE] ?? {}) };
  if (!cfg0.profiles?.[PROFILE]) throw new Error(`Profile ${PROFILE} is not in ${PILOT_CONFIG}.`);
  if (PROFILE !== "pilot" && [Number(p0.port), Number(p0.proxy?.port), Number(cfg0.profiles[PROFILE].db?.port)].some((x) => [8888, 8878, 5432].includes(x)))
    throw new Error(`Refusing profile ${PROFILE}: it uses a production port (8888, 8878 or 5432).`);
  if (PROFILE !== "pilot" && /hindsight-mu/i.test(JSON.stringify(cfg0.profiles[PROFILE]))) throw new Error(`Refusing profile ${PROFILE}: it names the pilot database.`);
}

const RUN = randomBytes(3).toString("hex");
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const BANK = `r5-acceptance-${STAMP}-${RUN}`;
const SCRATCH = arg("scratch", "D:/prog-scratch/r5-rx");
mkdirSync(SCRATCH, { recursive: true });
const WORK = join(SCRATCH, `mem-${RUN}`);
const VAULT = join(WORK, "vault");
const STATE = join(WORK, "state");
const DATA = join(WORK, "data");
const RUNDIR = join(WORK, "run");
const LOGS = join(WORK, "logs");
const SECRET_FILE = join(WORK, "secrets", "docdelete.key");
const HUB_LOG = join(LOGS, "hub.log");
const STARTED_AT = Date.now();

// ── safety assertions (before anything is created) ───────────────────────────────────────────────
const REAL_VAULT = resolve(join(homedir(), "source", "repos", "mu-ventures-obsidian-wiki")).toLowerCase();
const under = (child: string, parent: string) => resolve(child).toLowerCase().startsWith(resolve(parent).toLowerCase() + "\\") || resolve(child).toLowerCase() === resolve(parent).toLowerCase();
const SAFETY = {
  bank_is_disposable: /^r5-acceptance-\d{14}-[0-9a-f]{6}$/.test(BANK) && BANK !== "mu-shared" && BANK !== "mu-pilot",
  vault_is_scratch_and_not_the_real_vault: under(VAULT, SCRATCH) && !under(VAULT, REAL_VAULT) && resolve(VAULT).toLowerCase() !== REAL_VAULT,
  state_and_data_are_scratch: under(STATE, SCRATCH) && under(DATA, SCRATCH),
};
if (!Object.values(SAFETY).every(Boolean)) throw new Error(`Safety assertion failed: ${JSON.stringify(SAFETY)}`);
for (const d of [WORK, STATE, DATA, RUNDIR, LOGS, join(WORK, "secrets")]) mkdirSync(d, { recursive: true });
cpSync(join(ROOT, "scripts", "memory", "fixtures", "mini-wiki"), VAULT, { recursive: true });

type Check = { step: string; check: string; ok: boolean; observed: unknown };
const results: Check[] = [];
const check = (step: string, name: string, ok: boolean, observed: unknown) => {
  results.push({ step, check: name, ok, observed });
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${name}`);
  if (!ok) console.log(`      observed: ${JSON.stringify(observed).slice(0, 900)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────
type Res = { status: number; body: any; headers: Record<string, string | string[] | undefined> };
function rawOnce(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<Res> {
  const u = new URL(url);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolveP, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? "GET", headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}), ...init.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* text */ }
        resolveP({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.setTimeout(init.timeoutMs ?? 600_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function raw(url: string, init: Parameters<typeof rawOnce>[1] = {}): Promise<Res> {
  try { return await rawOnce(url, init); } catch (e) {
    if ((init.method ?? "GET") !== "GET" || !/ECONNRESET|socket hang up/i.test(String((e as Error).message))) throw e;
    await sleep(2000);
    return rawOnce(url, init);
  }
}
const OS = `http://127.0.0.1:${PORT}`;
const host = { Host: `localhost:${PORT}` };
let token = "";
let session = "";
const page = () => ({ ...host, Origin: `http://localhost:${PORT}`, "Sec-Fetch-Site": "same-origin", ...(session ? { Cookie: session } : {}) });
const mem = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
  raw(`${OS}/__memory${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? host : { ...page(), "x-claude-os-token": token }), ...extra }, body });
/** As an agent process (Claude Code, Hermes, the coding orchestrator's caller) reaches the OS: no browser markers, no page token. */
const agent = (path: string, body: unknown) => raw(`${OS}/__memory${path}`, { method: "POST", headers: { ...host, "User-Agent": "r5-acceptance-agent" }, body });
const agentRpc = (id: number, method: string, params?: unknown) => raw(`${OS}/__memory/mcp`, { method: "POST", headers: { ...host, "User-Agent": "r5-acceptance-agent" }, body: { jsonrpc: "2.0", id, method, params } });
const bankCall = (path: string, init: Parameters<typeof rawOnce>[1] = {}) => raw(`${PROXY}/v1/default/banks/${BANK}${path}`, init);
const docIds = async (): Promise<string[]> => (((await bankCall("/documents?limit=500")).body?.items ?? []) as { id: string }[]).map((d) => d.id).sort();
const hsDoc = (id: string) => bankCall(`/documents/${encodeURIComponent(id)}`);
/** What the last raw read of the bank's units covered: the proxy refuses a query string on /memories/list, so the whole list is read and filtered here. */
let lastUnits = { listed: 0, total: 0, complete: false };
/**
 * The engine's own derived units (facts extracted from documents) that mention `entity`, read two ways: a raw recall and the bank's COMPLETE
 * unit list. `stale` counts those whose text also matches `old` (the superseded wording, tolerant of "6:10am" / "6:10 a.m." style variants).
 * Reads the bank itself, not the OS's own view.
 */
const unitsFor = async (entity: string, old?: RegExp): Promise<{ mentioning: number; stale: number }> => {
  const r = await bankCall("/memories/recall", { method: "POST", body: { query: entity, max_tokens: 4096 } });
  const l = await bankCall("/memories/list");
  const items = (l.body?.items ?? []) as { text?: string }[];
  lastUnits = { listed: items.length, total: Number(l.body?.total ?? items.length), complete: l.status === 200 && items.length >= Number(l.body?.total ?? items.length) };
  const texts = [...((r.body?.results ?? []) as { text?: string }[]), ...items].map((x) => String(x.text ?? "")).filter((t) => t.includes(entity));
  return { mentioning: texts.length, stale: old ? texts.filter((t) => old.test(t)).length : 0 };
};

// ── the proxy: a temporary copy of the pilot profile that can reach ONLY the disposable bank ──────────
let proxyProc: ChildProcess | null = null;
function startProxy() {
  const cfg = JSON.parse(readFileSync(PILOT_CONFIG, "utf8").replace(/^\uFEFF/, ""));
  const pilot = cfg.profiles[PROFILE];
  writeFileSync(SECRET_FILE, randomBytes(24).toString("hex"));
  writeFileSync(join(RUNDIR, "WRITES_ENABLED"), "on\n");
  const profile = {
    ...pilot,
    run_dir: RUNDIR,
    log_dir: LOGS,
    proxy: { port: PROXY_PORT, read_banks: [BANK], write_banks: [BANK], docdelete_secret_file: SECRET_FILE, doc_deletes_per_hour: 20, writer_capability: "on", writer_port: PORT },
  };
  const file = join(WORK, "hindsight.r5.json");
  writeFileSync(file, JSON.stringify({ ...cfg, profiles: { r5: profile } }, null, 2));
  proxyProc = spawn(PYTHON, ["-X", "utf8", join(SERVICE_DIR, "proxy.py"), "--profile", "r5", "--config", file], { cwd: SERVICE_DIR, env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, stdio: "ignore", windowsHide: true });
}
const killTree = (p: ChildProcess | null) => { if (p?.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); };
async function waitProxyHealthy(ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await raw(`${PROXY}/health`).catch(() => null))?.status === 200) return true;
    await sleep(2000);
  }
  return false;
}

// ── the hub ────────────────────────────────────────────────────────────────────────────────────────
let server: ChildProcess | null = null;
const serverEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(HINDSIGHT_|MEMORY_|MU_MEMORY|MU_WIKI|MU_DATA_DIR)/.test(k)) env[k] = v;
  return {
    ...env,
    AGENTIC_OS_NO_BACKGROUND: "1",
    ARGENTIC_PORT: String(PORT),
    AGENTIC_OS_VITE_CACHE_DIR: join(WORK, "vite-cache"),
    MU_MEMORY_WRITES: "on",
    HINDSIGHT_URL: PROXY,
    HINDSIGHT_BANK: BANK,
    HINDSIGHT_APPROVAL_SECRET_FILE: SECRET_FILE,
    ...(HOME_OVERRIDE ? { HOME: HOME_OVERRIDE, USERPROFILE: HOME_OVERRIDE } : {}),
    MU_WIKI_ROOT: VAULT,
    MU_WIKI_VAULT_NAME: "r5-synthetic",
    MEMORY_STATE_DIR: STATE,
    MU_DATA_DIR: DATA,
  };
};
async function startServer() {
  const fd = openSync(HUB_LOG, "a");
  server = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(PORT), "--strictPort"], { cwd: ROOT, env: serverEnv(), stdio: ["ignore", fd, fd], windowsHide: true });
  closeSync(fd);
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const r = await mem("/status").catch(() => null);
    if (r?.status === 200) {
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
  throw new Error("The hub did not come up.");
}
const stopServer = () => { killTree(server); server = null; };
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
  if (!id) return null;
  const until = Date.now() + ms;
  for (;;) {
    const r = (await mem(`/item/${id}`)).body;
    if (r?.row?.indexed === "confirmed" || Date.now() > until) return r;
    await sleep(3000);
  }
}
const vaultRead = (rel: string) => readFileSync(join(VAULT, rel), "utf8");
const itemIdBy = async (kind: string, q: string, re: RegExp) => ((await mem(`/items?kind=${kind}&q=${encodeURIComponent(q)}`)).body?.items ?? []).find((i: any) => re.test(i.id))?.id ?? "";
const approve = async (approvalId: string) => {
  const card = await mem("/approvals/card", { approval_id: approvalId }, { "x-claude-os-token": token });
  return mem("/approvals/grant", { approval_id: approvalId, card_nonce: card.body?.card_nonce }, { "x-claude-os-token": token });
};

/** Run the supervisor's own helpers (operator tooling) with the pilot profile. Prints only what the snippet prints. */
function operator(snippet: string): { status: number | null; out: string } {
  const r = spawnSync(PYTHON, ["-X", "utf8", "-c", `import sys; sys.path.insert(0, r"${SERVICE_DIR}"); import supervisor as sv; from pathlib import Path\np = sv.load_profile(Path(r"${PILOT_CONFIG}"), "${PROFILE}")\n${snippet}`], { encoding: "utf8", windowsHide: true, timeout: 120_000, cwd: SERVICE_DIR });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
/** Row counts for this bank in the engine's own tables (operator SQL, read only; counts only). */
function bankRows(): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const t of ["banks", "documents", "memory_units"]) {
    const r = operator(`rc, o = sv.psql(p, "select count(*) from ${t} where bank_id = '${BANK}';")\nprint("RC", rc, "N", o.strip())`);
    const m = /RC 0 N (\d+)/.exec(r.out);
    if (!m) return null;
    out[t] = Number(m[1]);
  }
  return out;
}

/** Recursively look for a string in every file under a folder that changed since the run started (latin1 read: byte-exact for ASCII). */
function grepTree(dir: string, needles: string[], onlyAfter = 0, skip: (p: string) => boolean = () => false): { file: string; needle: string }[] {
  const hits: { file: string; needle: string }[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (n === "node_modules" || n === "vite-cache" || n === ".git") continue; walk(p); continue; }
      if (skip(p) || st.mtimeMs < onlyAfter || st.size > 200_000_000) continue;
      let text = "";
      try { text = readFileSync(p, "latin1"); } catch { continue; }
      for (const needle of needles) if (text.includes(needle)) hits.push({ file: p, needle: needle.slice(0, 6) + "…" });
    }
  };
  walk(dir);
  return hits;
}

/** The operator command (supervisor.py admin delete-bank --confirm <bank>): straight to the engine's API with its key, never through a client proxy. */
let bankDeleted = false;
function deleteBank(): { status: number | null; out: string } {
  const del = spawnSync(PYTHON, ["-X", "utf8", join(SERVICE_DIR, "supervisor.py"), "admin", "--profile", PROFILE, "--config", PILOT_CONFIG, "--action", "delete-bank", "--bank", BANK, "--confirm", BANK], { encoding: "utf8", windowsHide: true, timeout: 300_000, cwd: SERVICE_DIR });
  const out = `${del.stdout ?? ""}${del.stderr ?? ""}`.trim();
  if (del.status === 0 && /HTTP 200/.test(out)) bankDeleted = true;
  return { status: del.status, out };
}

const TAG = "SYNTHETIC-R5-20261002";

async function main() {
  check("setup", "safety assertions: disposable bank name, scratch vault (not the owner's real vault), scratch state, no live ports", true, { ...SAFETY, bank: BANK, vault: VAULT, real_vault_excluded: true });
  startProxy();
  check("setup", "this run's own client proxy is healthy on the selected engine profile (bank rules: the disposable bank only; writer port = this hub)", await waitProxyHealthy(), { proxy: PROXY, engine: `127.0.0.1:${(JSON.parse(readFileSync(PILOT_CONFIG, "utf8").replace(/^\uFEFF/, "")).profiles[PROFILE].port)} (profile ${PROFILE})`, bank: BANK });
  const notMuShared = await raw(`${PROXY}/v1/default/banks/mu-shared/memories/recall`, { method: "POST", body: { query: "anything" } });
  check("setup", "the proxy refuses the shared business bank (read and write): this run cannot reach it", notMuShared.status === 403, { status: notMuShared.status, body: notMuShared.body });
  if (notMuShared.status !== 403) throw new Error(`The proxy did not refuse mu-shared (${notMuShared.status}): stopping before anything is written.`);
  const cfgBack = JSON.parse(readFileSync(join(WORK, "hindsight.r5.json"), "utf8")).profiles.r5.proxy;
  if (JSON.stringify(cfgBack.read_banks) !== JSON.stringify([BANK]) || JSON.stringify(cfgBack.write_banks) !== JSON.stringify([BANK])) throw new Error("The proxy bank rules are not limited to the disposable bank: stopping.");
  const st0 = await startServer();
  if (st0.settings.bank !== BANK) throw new Error(`The hub is configured for bank ${st0.settings.bank}, not ${BANK}: stopping.`);
  if (st0.settings.hindsight_url !== PROXY) throw new Error(`The hub reaches Hindsight at ${st0.settings.hindsight_url}, not this run's proxy: stopping.`);
  check("setup", "hub up on its own port; ONE switch on; Hindsight via this run's proxy; no key in the OS process", st0.settings.mode === "on" && st0.settings.hindsight_url === PROXY && st0.settings.api_key === "missing", { port: PORT, settings: st0.settings, principal: st0.principal });
  const sync0 = await settle();
  check("setup", "initial sync of the temp vault into the disposable bank: nothing pending, every note indexed", sync0.pending === 0 && sync0.counts.indexed === sync0.counts.docs, { pending: sync0.pending, counts: sync0.counts, errors: sync0.errors });
  const baseDocs = await docIds();

  // 1 · save a note and recall it with its source ────────────────────────────────────────────────
  const fact1Text = `The synthetic Kookaburra${RUN} workshop opens at 6:10am on Tuesdays.`;
  const sv1 = await mem("/vault/save", { text: `${TAG} ${fact1Text}`, title: `Kookaburra${RUN} workshop hours`, bucket: "business" });
  const factId = await itemIdBy("fact", `Kookaburra${RUN}`, /^mf-/);
  await waitIndexed(factId);
  const mem1 = await mem("/remember", { text: `${TAG} The synthetic Currawong${RUN} depot invoices on the 2nd of each month.` });
  const memId: string = mem1.body?.memory?.id ?? "";
  await waitIndexed(memId);
  const rec1 = await mem("/recall", { query: `When does the Kookaburra${RUN} workshop open?` });
  const hit1 = rec1.body.facts?.find((f: any) => f.id === factId);
  const memRec1 = (await mem("/recall", { query: `When does Currawong${RUN} invoice?` })).body.facts?.find((f: any) => f.id === memId);
  check("1 save + recall", "a vault note fact is saved, indexed, and recalled via Hindsight with its source (the note) named; a memory is recalled with its memory source", sv1.status === 200 && !!hit1 && hit1.via.includes("hindsight") && !!hit1.source && !!memRec1 && !!memRec1.source && (await hsDoc(factId)).status === 200, {
    vault_save: sv1.body?.message, hindsight: rec1.body.hindsight, fact: hit1 && { id: hit1.id, via: hit1.via, source: hit1.source, text: hit1.text }, memory: memRec1 && { id: memRec1.id, via: memRec1.via, source: memRec1.source },
  });

  const control = await unitsFor(`Kookaburra${RUN}`);
  check("6 derived facts", "control: before any edit the engine holds derived units that mention the fact's distinctive name, so the unit-level checks that follow can detect a leftover", control.mentioning > 0 && lastUnits.complete, { units_about_entity: control.mentioning, units_listed: lastUnits.listed, units_total: lastUnits.total });

  const factPageText = vaultRead("wiki/topics/business/memory-business-shared.md");
  const vaultUriName = new URL(String(hit1?.source?.uri ?? "obsidian://x?vault=none")).searchParams.get("vault");
  if (!factPageText.includes(`Kookaburra${RUN}`) || vaultUriName !== "r5-synthetic") throw new Error(`The hub did not write to this run's temp vault (vault name ${vaultUriName}): stopping.`);
  check("setup", "the hub wrote the fact into THIS run's temp vault (the block is in the file under the scratch folder; the source URI names the synthetic vault)", true, { vault_file_has_fact: true, vault_name_in_uri: vaultUriName });

  // 3 · rename (a dedicated note, created first) ─────────────────────────────────────────────────
  const dir = "wiki/topics/business";
  const rel = `${dir}/zz-r5-${RUN}.md`;
  const rel2 = `${dir}/zz-r5-${RUN}-renamed.md`;
  const noteTitle = `Synthetic Plover${RUN} Depot Note`;
  const noteBody = (when: string) => `---\ntitle: ${noteTitle}\n---\n\n# ${noteTitle}\n\n${TAG}. The synthetic Plover${RUN} depot opens at ${when} on Fridays.\n`;
  writeFileSync(join(VAULT, rel), noteBody("5:55am"));
  await settle();
  const n1 = (await mem(`/items?kind=note&q=Plover${RUN}`)).body.items?.find((r: any) => r.title === noteTitle);
  const noteId: string = n1?.id ?? "";
  check("setup", "a new vault note is picked up with a stable id and is a document in the disposable bank", !!noteId && (await hsDoc(noteId)).status === 200, { id: noteId });

  // 2 · edit → the corrected fact is retrieved, the old one is gone ────────────────────────────
  const factFile = "wiki/topics/business/memory-business-shared.md";
  writeFileSync(join(VAULT, factFile), vaultRead(factFile).replace("6:10am on Tuesdays", "7:40am on Tuesdays"));
  writeFileSync(join(VAULT, rel), noteBody("6:25am"));
  await settle();
  const rec2 = await mem("/recall", { query: `When does the Kookaburra${RUN} workshop open on Tuesdays?` });
  const t2 = rec2.body.facts?.find((f: any) => f.id === factId);
  const d2 = await hsDoc(factId);
  const rec2n = await mem("/recall", { query: `When does the Plover${RUN} depot open on Fridays?` });
  const tn2 = rec2n.body.facts?.find((f: any) => f.id === noteId);
  const unitsOld2 = await unitsFor(`Kookaburra${RUN}`, /6[:.]\s?10/);
  check("2 edit", "an Obsidian edit to a note: recall returns the corrected fact; the engine's document holds the new wording and not the old", !!t2 && t2.text.includes("7:40am") && !t2.text.includes("6:10am") && String(d2.body?.original_text ?? "").includes("7:40am") && !String(d2.body?.original_text ?? "").includes("6:10am") && !!tn2 && tn2.text.includes("6:25am") && !tn2.text.includes("5:55am"), {
    fact_recall: t2 && { id: t2.id, via: t2.via, text: t2.text }, note_recall: tn2 && { id: tn2.id, via: tn2.via, text: tn2.text }, doc_has_new: String(d2.body?.original_text ?? "").includes("7:40am"), doc_has_old: String(d2.body?.original_text ?? "").includes("6:10am"),
  });
  check("6 derived facts", "after the edit, no engine-derived unit about the Kookaburra fact still carries the old time (6:10) and units about it still exist (the detector sees the entity), read from a raw recall and the complete unit list", unitsOld2.stale === 0 && unitsOld2.mentioning > 0 && lastUnits.complete, { units_about_entity: unitsOld2.mentioning, units_with_old_wording: unitsOld2.stale, units_listed: lastUnits.listed, units_total: lastUnits.total });
  const c2 = await mem("/correct", { id: memId, text: `${TAG} The synthetic Currawong${RUN} depot invoices on the 9th of each month.` });
  const newMemId: string = c2.body?.id ?? "";
  await settle();
  const recC = await mem("/recall", { query: `When does the Currawong${RUN} depot invoice?` });
  const idsC = (recC.body.facts ?? []).map((f: any) => f.id);
  const oldC = await hsDoc(memId);
  const unitsOldC = await unitsFor(`Currawong${RUN}`, /2nd|second/i);
  check("2 edit", "a memory correction: the new version is recalled, the old is retracted from the engine and never shown", c2.status === 200 && idsC.includes(newMemId) && !idsC.includes(memId) && oldC.status === 404 && !(recC.body.facts ?? []).some((f: any) => String(f.text).includes("2nd of each month")), { correct: c2.body?.message, recalled: (recC.body.facts ?? []).filter((f: any) => JSON.stringify(f).includes(RUN)).map((f: any) => ({ id: f.id, via: f.via, text: f.text })), old_doc: oldC.status });
  check("6 derived facts", "after the correction, no engine-derived unit about the Currawong memory still carries the old date (2nd) and units about it still exist", unitsOldC.stale === 0 && unitsOldC.mentioning > 0 && lastUnits.complete, { units_about_entity: unitsOldC.mentioning, units_with_old_wording: unitsOldC.stale, units_listed: lastUnits.listed, units_total: lastUnits.total });

  // 3 · rename without duplication ──────────────────────────────────────────────────────────────
  const docsBeforeRename = await docIds();
  renameSync(join(VAULT, rel), join(VAULT, rel2));
  const sy = await mem("/sync", {});
  await settle();
  const docsAfterRename = await docIds();
  const n3 = ((await mem(`/items?kind=note&q=Plover${RUN}`)).body.items ?? []).filter((r: any) => r.title === noteTitle);
  check("3 rename", "a rename keeps the note id: one note with the title, the new path, the same set of engine documents (no duplicate)", n3.length === 1 && n3[0].id === noteId && (n3[0].source as any)?.path === rel2 && same(docsBeforeRename, docsAfterRename), { renames: sy.body.renames, notes: n3.length, id: n3[0]?.id, path: (n3[0]?.source as any)?.path, docs_before: docsBeforeRename.length, docs_after: docsAfterRename.length });

  // 7 · ordinary URLs with paths are saved and recalled intact ─────────────────────────────────────
  const urlText = `${TAG} Licensing rules for run ${RUN} are at https://www.fairtrading.nsw.gov.au/trades-and-businesses/licensing-and-registrations?ref=r5${RUN} and the portal is https://github.com/Nahda/MU-Receptionist/pull/42/files#r5${RUN}`;
  const sUrl = await mem("/remember", { text: urlText });
  const urlId: string = sUrl.body?.memory?.id ?? "";
  await waitIndexed(urlId);
  const recUrl = await mem("/recall", { query: `fairtrading licensing rules r5${RUN}` });
  const hitUrl = recUrl.body.facts?.find((f: any) => f.id === urlId);
  const docUrl = await hsDoc(urlId);
  check("7 URLs", "an ordinary business URL with a path, query and fragment is saved and recalled intact (also in the engine's document)", sUrl.status === 200 && !!hitUrl && String(hitUrl.text).includes("/trades-and-businesses/licensing-and-registrations?ref=r5") && String(docUrl.body?.original_text ?? "").includes("/pull/42/files"), { save: sUrl.body?.message, recall: hitUrl && { via: hitUrl.via, text: hitUrl.text } });

  // 7 · coding handoffs (synthetic equivalents of the creative job's and 4465ff87's) ───────────────
  const handoffOf = (objective: string, suffix: string) => ({
    id: "00000000-0000-4000-8000-000000000000", jobId: `4465ff87-1b2c-4d3e-8f90-${suffix}`.slice(0, 36), repoId: "synthetic-repo", baseSha: "a".repeat(40), jobBranch: `coding/synthetic-${suffix}`,
    headSha: "0123456789abcdef0123456789abcdef01234567", outcome: "done", objective, changedFiles: [{ path: "src/a.ts", status: "M" }],
    tests: [{ commandId: "bun-test", passed: 3, failed: 0, exitCode: 0 }], review: { verdict: "approve", blockers: 0, majors: 0, minors: 0 },
    usage: [{ roleId: "builder", model: "claude-sonnet-5-5", accountSlot: "claude:max-2", turns: 1, inputTokens: 1, outputTokens: 1 }], followUps: [], notDone: [],
    links: { job: `/coding/synthetic-${suffix}`, work: "", memory: null }, createdAt: new Date().toISOString(),
  }) as any;
  const saveHandoff = async (title: string, text: string, suffix: string) => (await agent("/vault/save", { title, text, bucket: "business", note: `coding job synthetic-${suffix}`, onConflict: "keep-both" })).body;
  const creativeObjective = `${TAG} Land creative project mu-creative-${RUN} in C:/Users/Nebula PC/source/repos/mu-creative and run bun test`;
  const envObjective = `${TAG} Rotate the OpenRouter key: set OPENROUTER_API_KEY in the Windows user env var and restart the servers`;
  const normalObjective = `${TAG} Make sure the password is stored hashed and the api key is never logged (run ${RUN}c)`;
  const hCreative = handoffOf(creativeObjective, `a${RUN}00000000`);
  const hEnv = handoffOf(envObjective, `b${RUN}00000000`);
  const hNormal = handoffOf(normalObjective, `c${RUN}00000000`);
  const sCreative = await saveHandoff(handoffFactTitle(creativeObjective), handoffFact(hCreative, `a${RUN}`), `a${RUN}`);
  const sEnv = await saveHandoff(handoffFactTitle(envObjective), handoffFact(hEnv, `b${RUN}`), `b${RUN}`);
  const sNormal = await saveHandoff(handoffFactTitle(normalObjective), handoffFact(hNormal, `c${RUN}`), `c${RUN}`);
  // A request carrying a real-looking secret: the full fact is refused, the neutral form saves, and the secret is nowhere.
  const handoffSecret = `Zq${RUN}-Fake-Pw-7781`;
  const secretObjective = `${TAG} Set the Xero password is now ${handoffSecret} in the config (run ${RUN}d)`;
  const hSecret = handoffOf(secretObjective, `d${RUN}00000000`);
  const sFull = await saveHandoff(handoffFactTitle(secretObjective), handoffFact(hSecret, `d${RUN}`), `d${RUN}`);
  const neutral = handoffFactNeutral(hSecret, `d${RUN}`);
  const sNeutral = await saveHandoff(neutral.title, neutral.text, `d${RUN}`);
  await settle();
  const recCreative = await mem("/recall", { query: `Land creative project mu-creative-${RUN} bun test` });
  const recEnv = await mem("/recall", { query: `Rotate the OpenRouter key OPENROUTER_API_KEY run ${RUN}b` });
  const hasText = (r: Res, s: string) => (r.body.facts ?? []).some((f: any) => String(f.text).includes(s));
  check("7 handoff", "synthetic equivalents of the creative job's handoff (Windows path in the request) and of an env-var/type-annotation request are saved with the request's words and recalled (not 'withheld')", sCreative.ok === true && sEnv.ok === true && sNormal.ok === true && hasText(recCreative, `C:/Users/Nebula PC/source/repos/mu-creative`) && hasText(recEnv, "OPENROUTER_API_KEY"), {
    creative: sCreative.ok ? "saved" : sCreative.code, env: sEnv.ok ? "saved" : sEnv.code, normal: sNormal.ok ? "saved" : sNormal.code, recalled_creative: hasText(recCreative, "mu-creative"), recalled_env: hasText(recEnv, "OPENROUTER_API_KEY"),
  });
  const rawSecret = await bankCall("/memories/recall", { method: "POST", body: { query: `${handoffSecret} Xero password` } });
  check("7 handoff", "a request carrying a fake secret: the full fact is refused (prohibited-content), its neutral form saves, and the secret is in no bank unit", sFull.ok === false && sFull.code === "prohibited-content" && sNeutral.ok === true && !JSON.stringify(rawSecret.body).includes(handoffSecret), { full: sFull.ok ? "SAVED (bad)" : sFull.code, neutral: sNeutral.ok ? "saved" : sNeutral.code });

  // 4 · restart the hub: persistence ─────────────────────────────────────────────────────────────
  const docsBeforeRestart = await docIds();
  const itemsBefore = ((await mem("/items?kind=memory")).body.items ?? []).length;
  stopServer();
  await sleep(2500);
  await startServer();
  const st4 = (await mem("/status")).body;
  const rec4 = await mem("/recall", { query: `When does the Currawong${RUN} depot invoice?` });
  const rec4f = await mem("/recall", { query: `When does the Kookaburra${RUN} workshop open on Tuesdays?` });
  const docsAfterRestart = await docIds();
  const afterSave = await mem("/remember", { text: `${TAG} The synthetic Lorikeet${RUN} kiosk restocks on Wednesdays after the restart.` });
  check("4 restart", "after a hub restart: the same memories, the same engine documents, nothing pending; recall still finds the corrected facts via Hindsight; a save after the restart still works (writer capability re-registered)", st4.pending === 0 && same(docsBeforeRestart, docsAfterRestart) && !!rec4.body.facts?.find((f: any) => f.id === newMemId && f.via.includes("hindsight")) && !!rec4f.body.facts?.find((f: any) => f.id === factId && f.text.includes("7:40am")) && afterSave.status === 200 && ((await mem("/items?kind=memory")).body.items ?? []).length >= itemsBefore, {
    pending: st4.pending, docs_before: docsBeforeRestart.length, docs_after: docsAfterRestart.length, memories_before: itemsBefore, save_after_restart: afterSave.body?.message,
  });

  // 5 · delete / forget through the intended approved path ───────────────────────────────────────
  const f5 = await mem("/forget", { kind: "memory", target: newMemId });
  const still5 = await hsDoc(newMemId);
  check("5 delete", "forgetting a memory asks for approval first (202 approval-required, with the plan); nothing is removed yet", f5.status === 202 && f5.body.code === "approval-required" && still5.status === 200, { status: f5.status, code: f5.body.code, hindsight_doc: still5.status });
  const asAgent = await agent("/forget", { kind: "memory", target: newMemId, approval_id: f5.body.approval?.id });
  const agentTok = (await raw(`${OS}/__token`, { headers: host })).body?.token ?? "";
  const agentCard = await raw(`${OS}/__memory/approvals/card`, { method: "POST", headers: { ...host, "x-claude-os-token": agentTok }, body: { approval_id: f5.body.approval?.id } });
  check("5 delete", "an agent (no browser session) cannot use or approve that approval; nothing is removed", asAgent.body?.ok !== true && agentCard.status === 403 && (await hsDoc(newMemId)).status === 200, { agent_forget: asAgent.body?.code ?? asAgent.status, agent_card: agentCard.status });
  const g5 = await approve(f5.body.approval?.id);
  const gone5 = await hsDoc(newMemId);
  const rec5 = await mem("/recall", { query: `When does the Currawong${RUN} depot invoice?` });
  check("5 delete", "approved on the Memory page's card: the engine's document is gone (404), recall and the app no longer have it", g5.status === 200 && g5.body?.result?.ok === true && gone5.status === 404 && !(rec5.body.facts ?? []).some((f: any) => f.id === newMemId) && (await mem(`/item/${newMemId}`)).status === 404, { grant: g5.status, result: g5.body?.result?.message, hindsight_doc: gone5.status });
  check("5 delete", "the approval is single use (replaying it is refused)", (await approve(f5.body.approval?.id)).status !== 200, {});
  const c5 = await mem("/forget", { kind: "full", target: factId });
  const g5c = c5.status === 202 ? await approve(c5.body.approval?.id) : c5;
  const goneF = await hsDoc(factId);
  check("5 delete", "forgetting a vault fact (full) also needs approval; once approved the block leaves the vault note and the engine's document is deleted", c5.status === 202 && g5c.status === 200 && !vaultRead(factFile).includes(`Kookaburra${RUN} workshop opens`) && goneF.status === 404, { plan_code: c5.body.code, grant: g5c.status, hindsight_doc: goneF.status });
  const bulk = await bankCall("", { method: "DELETE" });
  const clear = await bankCall("/memories", { method: "DELETE" });
  const unsigned = await bankCall(`/documents/${encodeURIComponent(urlId)}`, { method: "DELETE" });
  check("5 delete", "the proxy has no route to delete the bank, clear it, or delete a document without a signed approval", bulk.status === 403 && clear.status === 403 && unsigned.status === 403, { bank_delete: bulk.status, clear: clear.status, unsigned_doc_delete: unsigned.status });

  // 6 · derived facts after delete ───────────────────────────────────────────────────────────────
  const unitsAfterDelete = (await unitsFor(`Currawong${RUN}`)).mentioning + (await unitsFor(`Kookaburra${RUN}`)).mentioning;
  const recDeleted = await mem("/recall", { query: `Kookaburra${RUN} workshop Currawong${RUN} depot` });
  check("6 derived facts", "after the deletes, no engine memory unit mentions the deleted memory or fact (Currawong, Kookaburra), and recall has nothing for them", unitsAfterDelete === 0 && lastUnits.complete && !(recDeleted.body.facts ?? []).some((f: any) => /Currawong|Kookaburra/.test(String(f.text))), { raw_units: unitsAfterDelete, units_listed: lastUnits.listed, units_total: lastUnits.total, recalled: (recDeleted.body.facts ?? []).filter((f: any) => JSON.stringify(f).includes(RUN)).map((f: any) => f.id) });
  unlinkSync(join(VAULT, rel2));
  await settle();
  const goneN = await hsDoc(noteId);
  check("5 delete", "deleting the vault note file removes it from the engine and from the index", goneN.status === 404 && (await unitsFor(`Plover${RUN}`)).mentioning === 0, { hindsight_doc: goneN.status });

  // 8 · credential-like content is rejected and leaves no trace ────────────────────────────────
  const pw = `Zq${RUN}-Fake-Pw-9910`;
  const key = `sk-or-v1-r5fake${RUN}abcdef1234567890`;
  const phrase = `${TAG} The synthetic Xero${RUN} password is now ${pw}`;
  const docsBeforeSecret = await docIds();
  const s1 = await mem("/remember", { text: phrase });
  const s2 = await mem("/vault/save", { text: `${TAG} Use ${key} for the Retell${RUN} client`, title: `Retell${RUN} setup` });
  const s3 = await agent("/remember", { text: `${TAG} Xero${RUN} login admin / ${pw}` });
  const s4 = JSON.parse((await agentRpc(11, "tools/call", { name: "remember", arguments: { text: `${TAG} The Wise${RUN} api key is ${key}` } })).body?.result?.content?.[0]?.text ?? "{}");
  writeFileSync(join(VAULT, `${dir}/zz-r5-secret-${RUN}.md`), `---\ntitle: Synthetic Secret Note ${RUN}\n---\n\n${TAG} The staging password is ${pw}\n`);
  await settle(120_000);
  const secretNote = ((await mem(`/items?kind=note&q=Secret%20Note%20${RUN}`)).body.items ?? []).find((r: any) => String(r.title).includes(`Secret Note ${RUN}`));
  unlinkSync(join(VAULT, `${dir}/zz-r5-secret-${RUN}.md`));
  await settle(120_000);
  const rawBankList = await bankCall("/memories/list");
  const rawBankSecret = JSON.stringify((await bankCall("/memories/recall", { method: "POST", body: { query: `${pw} ${key} password api key` } })).body) + JSON.stringify(rawBankList.body);
  // The recall response echoes the caller's own query back to the caller; what must not appear is a stored fact or the spoken answer.
  const recSecretBody = (await mem("/recall", { query: `Xero${RUN} password ${pw} Retell${RUN} ${key}` })).body;
  const recSecret = JSON.stringify({ facts: recSecretBody.facts, spoken: recSecretBody.spoken, suppressed: recSecretBody.suppressed });
  const parts = {
    ui_remember_refused: s1.status === 422 && s1.body?.code === "prohibited-content",
    ui_vault_save_refused: s2.status === 422 && s2.body?.code === "prohibited-content",
    agent_remember_refused: s3.body?.ok === false && s3.body?.code === "prohibited-content",
    mcp_remember_refused: s4.ok === false && s4.code === "prohibited-content",
    secret_note_not_indexed: !secretNote || secretNote.indexed !== "confirmed",
    bank_documents_unchanged: same(docsBeforeSecret, await docIds()),
    secret_not_in_engine_recall_or_list: rawBankList.status === 200 && !rawBankSecret.includes(pw) && !rawBankSecret.includes(key),
    secret_not_in_app_recall: !recSecret.includes(pw) && !recSecret.includes(key),
  };
  check("8 credentials", "a password sentence, an API key, a login pair (UI, agent, MCP routes) are all refused (prohibited-content); a vault note holding one is not indexed; nothing new in the bank", Object.values(parts).every(Boolean), { ...parts, statuses: { ui_remember: s1.status, ui_vault_save: s2.status }, secret_note_indexed: secretNote?.indexed ?? "not listed" });

  // 8 · the secret strings appear in no log, state file or event trail ──────────────────────────────
  const needles = [pw, key, handoffSecret];
  // The planted note was deleted above; the script's own result file and this script's memory are the only other holders.
  const stEvents = JSON.stringify((await mem("/status")).body);
  const hubHits = grepTree(WORK, needles, 0, (p) => /result\.json$/i.test(p));
  const pilotHits = existsSync(PILOT_LOGS) ? grepTree(PILOT_LOGS, needles, STARTED_AT - 5000) : [];
  check("8 credentials", "the secret strings are in no file under the run's folder (hub log, memory state, device store, proxy audit log, vault), in no engine log written during the run, and not in the app's status/event trail", hubHits.length === 0 && pilotHits.length === 0 && !needles.some((n) => stEvents.includes(n)), {
    files_scanned_root: WORK, hub_log_bytes: existsSync(HUB_LOG) ? statSync(HUB_LOG).size : 0, run_folder_hits: hubHits, engine_log_hits: pilotHits, engine_logs_scanned: PILOT_LOGS, status_trail_hit: needles.some((n) => stEvents.includes(n)),
  });

  // model record ───────────────────────────────────────────────────────────────────────────────────
  const stEnd = (await mem("/status")).body;
  const itemF = (await mem(`/item/${memId}`)).body;
  const itemNew = (await mem(`/item/${urlId}`)).body;
  const llm = await bankCall("/llm-requests?limit=200");
  const rows = (llm.body?.items ?? llm.body?.requests ?? []) as any[];
  const tally: Record<string, { calls: number; ok: number; prompt_tokens: number; completion_tokens: number; fallback_from: string[] }> = {};
  for (const r of rows) {
    const k = `${r.provider ?? "?"}/${r.model ?? "?"}`;
    const t = (tally[k] ??= { calls: 0, ok: 0, prompt_tokens: 0, completion_tokens: 0, fallback_from: [] });
    t.calls++;
    if (r.status === "success") t.ok++;
    t.prompt_tokens += Number(r.input_tokens ?? r.prompt_tokens ?? 0);
    t.completion_tokens += Number(r.output_tokens ?? r.completion_tokens ?? 0);
    for (const f of (r.fallback_from ?? []) as string[]) if (!t.fallback_from.includes(f)) t.fallback_from.push(f);
  }
  check("model record", "the processing model that actually ran for retain/recall: provider and model from the app's per-save record and from the engine's own receipts; token counts are measured where the receipt carries them, money cost is not reported by the engine", Object.keys(stEnd.models ?? {}).length > 0 && rows.length > 0, {
    app_models: stEnd.models, save_processed_by: itemF?.row?.processed_by, url_save_processed_by: itemNew?.row?.processed_by, engine_receipts: { status: llm.status, rows: rows.length, by_route: tally, row_fields: rows[0] ? Object.keys(rows[0]) : [] },
  });

  // cleanup: stop the hub and the proxy, delete the disposable bank through the engine's API, prove it is gone ──────────
  stopServer();
  const before = bankRows();
  killTree(proxyProc);
  proxyProc = null;
  const del = deleteBank();
  const delOut = del.out;
  await sleep(1500);
  const after = bankRows();
  check("cleanup", "the disposable bank is deleted through the engine's API (operator command) and is gone: no rows for it in the engine's banks, documents or memory_units tables", del.status === 0 && /HTTP 200/.test(delOut) && !!before && before.documents > 0 && !!after && after.banks === 0 && after.documents === 0 && after.memory_units === 0, { delete: delOut, rows_before_delete: before, rows_after_delete: after });
  const baseRemoved = existsSync(WORK);
  check("cleanup", "the bank list shows no r5-acceptance bank and mu-shared was never written (the proxy refused it; the engine rows for this run are gone)", !!after && after.banks === 0, { mu_shared_access_refused: notMuShared.status, work_folder: baseRemoved ? WORK : null, base_docs_in_bank_at_start: baseDocs.length });

  const out = { run: RUN, bank: BANK, tag: TAG, port: PORT, proxy_port: PROXY_PORT, work: WORK, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ passed: out.passed, failed: out.failed, bank: BANK, work: WORK }));
}

/** The run folder holds a copy of the Hindsight profiles file, the temp vault, the device store and the hub log: remove it (it is scratch, with no junction in it). */
function cleanRunFolder() {
  stopServer();
  killTree(proxyProc);
  proxyProc = null;
  if (under(WORK, SCRATCH) && resolve(WORK).toLowerCase() !== resolve(SCRATCH).toLowerCase()) {
    try { rmSync(WORK, { recursive: true, force: true }); } catch { /* a locked file: the folder stays under scratch */ }
  }
}

main()
  .catch((e) => {
    console.error("r5 acceptance aborted:", (e as Error).message);
    stopServer();
    if (!bankDeleted) console.error("aborted run: deleting the disposable bank:", deleteBank().out);
    process.exitCode = 1;
    if (OUT) writeFileSync(OUT, JSON.stringify({ run: RUN, bank: BANK, aborted: (e as Error).message, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }, null, 2) + "\n");
  })
  .finally(() => {
    cleanRunFolder();
    process.exit();
  });
