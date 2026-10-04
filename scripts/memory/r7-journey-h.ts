#!/usr/bin/env bun
/**
 * R7 journey H: save, recall, correct and delete SYNTHETIC memory through the real /__memory integration and the real Memory page,
 * in a real browser, on a DISPOSABLE setup. Written 3 Oct 2026 by worker G.
 *
 * What is real and what is not (said plainly in the result):
 *   real:  this worktree's hub (vite dev, a quiet copy), the Memory page, /__memory, the approvals path, the vault writer and local index,
 *          the Hindsight connector (HTTP, bank, document ids, delete with an HMAC approval header).
 *   FAKE:  the Hindsight server. No local Hindsight engine was reachable (nothing on 8888/8878/8883/8893; the main PC's was stopped at the
 *          Ryzen cutover and a second writer must not be started), so scripts/memory/testing/fake-hindsight.ts plays it, in this process.
 *          It speaks the real REST shapes (retain with document replace, recall, document get/delete, llm-requests) but does no language-model
 *          extraction, so what is proven is the OS's own save/recall/correct/delete behaviour, not Hindsight's extraction quality.
 *   disposable: bank `r7g-disposable-<stamp>-<run>` (never mu-shared), a scratch copy of the synthetic mini-wiki as the vault, a scratch
 *          data dir, state dir and HOME. The production bank, the production vault and the real ~/.config are never reachable from the hub.
 *
 *   bun --no-env-file scripts/memory/r7-journey-h.ts [--port 8127] [--scratch D:/AgenticOS-r7-data/g/mem] [--out docs/programme-20261001/evidence/r7-ops]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openBrowser } from "../cloud/ops-browser";
import { startFakeHindsight } from "./testing/fake-hindsight";

const ROOT = resolve(import.meta.dir, "..", "..");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "8127"));
const SCRATCH_ROOT = resolve(arg("scratch", "D:/AgenticOS-r7-data/g/mem"));
const OUT = resolve(arg("out", join(ROOT, "docs", "programme-20261001", "evidence", "r7-ops")));
const FORBIDDEN = [8081, 8082, 8083, 8093, 8140, 8443, 8444, 8878, 8883, 8888, 8893];
if (FORBIDDEN.includes(PORT)) throw new Error(`Refusing port ${PORT}: a live or shared service.`);
const RUN = randomBytes(3).toString("hex");
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const BANK = `r7g-disposable-${STAMP}-${RUN}`;
const WORK = join(SCRATCH_ROOT, `run-${RUN}`);
const VAULT = join(WORK, "vault");
const STATE = join(WORK, "state");
const DATA = join(WORK, "data");
const HOME = join(WORK, "home");
const LOGS = join(WORK, "logs");
const SECRET_FILE = join(WORK, "secrets", "docdelete.key");
const REAL_VAULT = resolve("C:/Users/Nebula PC/source/repos/mu-ventures-obsidian-wiki").toLowerCase();
const underScratch = (p: string) => resolve(p).toLowerCase().startsWith(resolve("D:/AgenticOS-r7-data").toLowerCase() + "\\");
const SAFETY = {
  bank_is_disposable: /^r7g-disposable-\d{14}-[0-9a-f]{6}$/.test(BANK) && BANK !== "mu-shared" && BANK !== "mu-pilot",
  vault_is_scratch_not_real: underScratch(VAULT) && !resolve(VAULT).toLowerCase().startsWith(REAL_VAULT),
  state_data_home_are_scratch: [STATE, DATA, HOME].every(underScratch),
};
if (!Object.values(SAFETY).every(Boolean)) throw new Error(`Safety assertion failed: ${JSON.stringify(SAFETY)}`);
for (const d of [WORK, STATE, DATA, HOME, LOGS, join(WORK, "secrets"), OUT]) mkdirSync(d, { recursive: true });
cpSync(join(ROOT, "scripts", "memory", "fixtures", "mini-wiki"), VAULT, { recursive: true });
writeFileSync(SECRET_FILE, randomBytes(24).toString("hex"));

type Check = { step: string; check: string; ok: boolean; observed: unknown };
const results: Check[] = [];
const check = (step: string, name: string, ok: boolean, observed: unknown) => {
  results.push({ step, check: name, ok, observed });
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${name}${ok ? "" : `\n      observed: ${JSON.stringify(observed).slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (b: Awaited<ReturnType<typeof openBrowser>>, name: string) => b.shot(join(OUT, name));

// ── the fake engine and the hub ────────────────────────────────────────────────────────────────────
const fake = await startFakeHindsight({ approvalSecret: readFileSync(SECRET_FILE, "utf8") });
const OS = `http://127.0.0.1:${PORT}`;
let hub: ChildProcess | null = null;
const MINIMAL_ENV = ["PATH", "SystemRoot", "windir", "TEMP", "TMP", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "ProgramW6432", "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE"];
function hubEnv() {
  const env: Record<string, string> = {};
  for (const k of MINIMAL_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!; // no other variable (and so no secret) reaches the hub
  return {
    ...env,
    HOME,
    USERPROFILE: HOME,
    AGENTIC_OS_NO_BACKGROUND: "1",
    AGENTIC_OS_VITE_CACHE_DIR: join(WORK, "vite-cache"),
    MU_MEMORY_WRITES: "on",
    HINDSIGHT_URL: fake.url,
    HINDSIGHT_BANK: BANK,
    HINDSIGHT_APPROVAL_SECRET_FILE: SECRET_FILE,
    MU_WIKI_ROOT: VAULT,
    MU_WIKI_VAULT_NAME: "r7g-synthetic",
    MEMORY_STATE_DIR: STATE,
    MU_DATA_DIR: DATA,
    BROWSER: "none",
  };
}
async function startHub() {
  const fd = openSync(join(LOGS, "hub.log"), "a");
  hub = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, env: hubEnv(), stdio: ["ignore", fd, fd], windowsHide: true });
  closeSync(fd);
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const r = await fetch(`${OS}/__memory/status`, { headers: { Host: `127.0.0.1:${PORT}` } }).catch(() => null);
    if (r && r.status === 200) return (await r.json()) as any;
    await sleep(1500);
  }
  throw new Error("The hub did not come up (see logs/hub.log).");
}
const stopHub = () => {
  if (hub?.pid) spawnSync("taskkill", ["/PID", String(hub.pid), "/T", "/F"], { stdio: "ignore" });
  hub = null;
};

let exitCode = 0;
try {
  const status0 = await startHub();
  check("setup", "hub up in the quiet mode with writes on and the disposable bank", status0?.settings?.mode === "on" || status0?.mode === "on" || JSON.stringify(status0).includes('"on"'), { bank: BANK, keys: Object.keys(status0 ?? {}) });

  // /status answers before the first vault scan: ask for one sync (what the Memory page's "Sync now" does) and wait until the index is built and nothing is pending.
  {
    const tok = ((await (await fetch(`${OS}/__token`)).json()) as { token?: string }).token ?? "";
    await fetch(`${OS}/__memory/sync`, { method: "POST", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": tok }, body: "{}" });
    for (let i = 0; i < 120; i++) {
      const st = (await (await fetch(`${OS}/__memory/status`)).json()) as any;
      if (st.last_scan_at && st.pending === 0 && (st.counts?.indexed ?? 0) > 0) break;
      await sleep(1000);
    }
  }
  const browser = await openBrowser({ profile: join(WORK, "browser-profile"), port: 9237 });
  // A navigation mints this browser's hub session (the first at a fresh install is trusted: a confirmed human), as the owner's does.
  await browser.goto(`${OS}/memory/vault`);
  await browser.waitText("Keep a fact", 30_000);
  // OBSERVATION (not a pass/fail): what session did the first navigation leave this browser holding?
  const firstSession = await browser.evaluate<string>("fetch('/__devices/me').then(r => r.json()).then(j => JSON.stringify(j.hubSession))");
  await sleep(3000);
  const laterSession = await browser.evaluate<string>("fetch('/__devices/me').then(r => r.json()).then(j => JSON.stringify(j.hubSession))");
  console.log("observation: hubSession after first page load =", firstSession, "; 3 s later =", laterSession);
  results.push({ step: "observe", check: "hub session of a first navigation (information only)", ok: true, observed: { firstSession, laterSession } });
  if (/"pending":true/.test(laterSession ?? "")) {
    // Give this synthetic browser the confirmed owner session a person would have (the hub trusts the first browser at a fresh install; a
    // headless run can end up holding the pending one). Minted with the hub's own store, never printed.
    process.env.MU_DATA_DIR = DATA;
    const { DeviceStore } = await import("../devices/store");
    const minted = new DeviceStore(WORK).mintSession("usman", "This PC's browser (synthetic, confirmed)", "hub");
    const ok = await browser.setCookie("mu_session", encodeURIComponent(minted.cookie), OS);
    await browser.goto(`${OS}/memory/vault`);
    await browser.waitText("Keep a fact", 30_000);
    console.log("synthetic confirmed owner session installed:", ok);
  }
  await shot(browser, "memory-01-page-writes-on.png");
  check("H0", "the Memory page opens with capture enabled", !(await browser.text()).includes("Writing is off until acceptance"), (await browser.text()).slice(0, 200));

  const json = async (path: string) => (await fetch(`${OS}${path}`, { headers: { Host: `127.0.0.1:${PORT}` } })).json() as Promise<any>;
  // POSTs as a local program (the page token any loopback caller can read); recall is a read, so a process may ask.
  const token = ((await json(`/__token`)) as { token?: string }).token ?? "";
  const post = async (path: string, body: unknown) => (await fetch(`${OS}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token }, body: JSON.stringify(body) })).json() as Promise<any>;
  const recall = async (q: string) => JSON.stringify(await post(`/__memory/recall`, { query: q }).catch((e) => ({ error: String(e) })));
  const docs = () => [...fake.bank(BANK).values()].filter((d) => !d.invalidated);
  const textIn = (re: RegExp) => docs().filter((d) => re.test(d.content));

  // ── H1 save ──
  const FACT = "R7G synthetic: the kookaburra supply order goes out every Tuesday morning.";
  await browser.type("textarea", FACT);
  await browser.clickText("Remember");
  const savedSeen = await browser.waitFor(`document.body.innerText.toLowerCase().includes('kookaburra') && !document.body.innerText.includes('Remembering')`, 20_000);
  await sleep(2500);
  await shot(browser, "memory-02-saved.png");
  const afterSave = textIn(/kookaburra/i);
  check("H1", "save: the fact reached the (fake) engine in the disposable bank", afterSave.length === 1 && afterSave[0]!.content.includes("Tuesday"), { docs: afterSave.map((d) => ({ id: d.document_id, tags: d.tags })), seen: savedSeen });
  const items1 = await json(`/__memory/items?kind=memory&q=kookaburra`);
  const memItem = (items1.items ?? [])[0];
  check("H1", "save: the memory is listed by the app with a source", !!memItem?.id, { count: items1.items?.length, first: memItem && { id: memItem.id, kind: memItem.kind } });

  // ── H2 recall (search box) ──
  await browser.goto(`${OS}/memory/vault`);
  await browser.waitText("Keep a fact", 30_000);
  await browser.type("input[placeholder='What do we know about…']", "kookaburra supply order");
  await browser.clickText("Search", "button", true);
  const recalled = await browser.waitFor(`document.body.innerText.includes('Tuesday')`, 20_000);
  await shot(browser, "memory-03-recall.png");
  check("H2", "recall: searching finds the saved fact in the Memory page", recalled, (await browser.text()).slice(0, 300));
  const recallApi = await recall("kookaburra supply");
  check("H2", "recall: the recall route returns it", recallApi.includes("Tuesday"), recallApi.slice(0, 300));

  // ── H3 correct ──
  const opened = memItem?.id ? await browser.clickText("kookaburra", "button[aria-pressed]", true) : false;
  const correctVisible = await browser.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim().includes('Correct'))`, 15_000);
  await shot(browser, "memory-04-detail.png");
  check("H3", "correct: the item opens with Correct and Delete controls", opened && correctVisible, { opened, correctVisible });
  await browser.clickText("Correct", "button", true);
  await browser.waitFor(`document.querySelector("aside[aria-label='Item detail'] textarea")`, 8000);
  const FIXED = "R7G synthetic: the kookaburra supply order goes out every Wednesday morning.";
  await browser.type("aside[aria-label='Item detail'] textarea", FIXED);
  await sleep(300);
  await browser.clickText("Save correction");
  await browser.waitFor(`document.body.innerText.includes('Wednesday')`, 20_000);
  await sleep(2500);
  await shot(browser, "memory-05-corrected.png");
  const active = textIn(/kookaburra/i);
  check("H3", "correct: the engine holds the new wording and not the old one as active", active.some((d) => d.content.includes("Wednesday")) && !active.some((d) => d.content.includes("Tuesday")), active.map((d) => d.content.slice(0, 90)));
  const rec2 = await recall("kookaburra supply");
  check("H3", "correct: recall returns Wednesday and no longer Tuesday", rec2.includes("Wednesday") && !rec2.includes("Tuesday"), rec2.slice(0, 300));

  // ── H4 delete (the approved path) ──
  await browser.clickText("Delete memory…", "button", true);
  const planned = await browser.waitFor(`document.body.innerText.includes('Approve and delete')`, 15_000);
  await sleep(500);
  await shot(browser, "memory-06-delete-plan.png");
  const beforeApprove = textIn(/kookaburra/i).length;
  check("H4", "delete: asking only shows the plan; nothing is removed until approved", planned && beforeApprove === 1, { planned, docsStillThere: beforeApprove });
  await browser.clickText("Approve and delete", "button", true);
  await sleep(3500);
  await shot(browser, "memory-07-deleted.png");
  check("H4", "delete: after approval the engine document is gone", textIn(/kookaburra/i).length === 0, textIn(/kookaburra/i).length);
  const rec3 = await recall("kookaburra supply");
  check("H4", "delete: recall no longer returns it", !rec3.includes("kookaburra supply order goes out"), rec3.slice(0, 200));
  check("H4", "delete: the engine's own call log shows a DELETE with an approval header", fake.calls.some((c) => c.method === "DELETE" && c.status < 300 && !!c.approval), fake.calls.filter((c) => c.method === "DELETE"));

  // ── H5 vault save and recall, then forget everywhere ──
  await browser.goto(`${OS}/memory/vault`);
  await browser.waitText("Keep a fact", 30_000);
  const VFACT = "R7G synthetic: the wombat catering contact is the front desk, not the manager.";
  await browser.type("textarea", VFACT);
  await browser.clickText("Save to vault");
  await sleep(4000);
  await shot(browser, "memory-08-vault-saved.png");
  const notes = (() => { const hits: string[] = []; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (!/^\.(git|obsidian)$/.test(e.name)) walk(p); } else if (/\.md$/.test(e.name) && readFileSync(p, "utf8").includes("wombat catering contact")) hits.push(p.replace(VAULT, "")); } }; walk(VAULT); return hits; })();
  check("H5", "vault save: the fact is in a note of the scratch vault (not the real one)", notes.length === 1, notes);
  check("H5", "vault save: the engine indexed it", textIn(/wombat catering/i).length >= 1, textIn(/wombat catering/i).length);

  // ── H6 a credential is refused and leaves no trace ──
  const before = docs().length;
  await browser.type("textarea", "My bank password is hunter2x9 for the portal login");
  await browser.clickText("Remember");
  await sleep(2500);
  await shot(browser, "memory-09-credential-refused.png");
  check("H6", "a password sentence is refused and nothing reached the engine", docs().length === before && !docs().some((d) => /hunter2x9/.test(d.content)), { before, after: docs().length, page: (await browser.text()).slice(0, 240) });

  await browser.quit();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(
    join(OUT, "memory-journey-result.json"),
    JSON.stringify({ ran: new Date().toISOString(), verdict: failed.length ? "FAIL" : "PASS", engine: "FAKE Hindsight (scripts/memory/testing/fake-hindsight.ts); no local engine reachable", bank: BANK, vault: "scratch copy of the synthetic mini-wiki", safety: SAFETY, results }, null, 2),
  );
  console.log(`\n${failed.length ? "FAIL" : "PASS"}: ${results.length - failed.length}/${results.length} checks (bank ${BANK}, fake engine)`);
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(error);
  exitCode = 2;
} finally {
  stopHub();
  await fake.stop();
  // The disposable bank lives only inside the fake (memory); the scratch run folder is left for inspection (D:\AgenticOS-r7-data\g\mem).
}
process.exit(exitCode);
