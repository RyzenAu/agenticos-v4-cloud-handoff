#!/usr/bin/env bun
/**
 * Before and after screenshots for the audit 2 fixes (items 4, 5, 6, 7, 11, 12, 14), at 1440 and 390 wide, from a SYNTHETIC hub (port 8127, scratch data,
 * default PC role, saving to memory off, Hindsight off, minimal environment, scratch HOME). One browser at a time. `--root` is the checkout whose code
 * the hub runs: the "before" run points at a clean worktree of the commit before the fixes, the "after" run at this worktree.
 *
 *   bun --no-env-file scripts/cloud/r7-audit-shots.ts --label before --root D:\AgenticOS-r7-g-before
 *   bun --no-env-file scripts/cloud/r7-audit-shots.ts --label after
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApprovalService } from "../approvals/service";
import { seedCold } from "../acceptance/seed-gate-hub";
import { openBrowser } from "./ops-browser";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const LABEL = arg("label", "after");
const ROOT = resolve(arg("root", resolve(import.meta.dir, "..", "..")));
const PORT = Number(arg("port", "8127"));
const OUT = resolve(arg("out", join(resolve(import.meta.dir, "..", ".."), "docs", "programme-20261001", "evidence", "r7-ops", "audit-fixes")));
if ([8081, 8082, 8083, 8093, 8140, 8443, 8444, 8878, 8883, 8888, 8893].includes(PORT)) throw new Error(`Refusing port ${PORT}.`);
const STAMP = `${LABEL}-${Date.now().toString(36)}`;
const WORK = join("D:/AgenticOS-r7-data/g/audit-fixes", STAMP);
const DATA = join(WORK, "data");
const HOME = join(WORK, "home");
mkdirSync(HOME, { recursive: true });
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MINIMAL = ["PATH", "SystemRoot", "windir", "TEMP", "TMP", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "ProgramW6432", "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE"];
const env: Record<string, string> = {};
for (const k of MINIMAL) if (process.env[k] !== undefined) env[k] = process.env[k]!;

seedCold(DATA, "none");
new ApprovalService({ path: join(DATA, "approvals.sqlite") }).close();

let hub: ChildProcess | null = null;
const stop = () => {
  if (hub?.pid) spawnSync("taskkill", ["/PID", String(hub.pid), "/T", "/F"], { stdio: "ignore" });
  hub = null;
};
try {
  const fd = openSync(join(WORK, "hub.log"), "a");
  hub = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    env: { ...env, HOME, USERPROFILE: HOME, MU_DATA_DIR: DATA, AGENTIC_OS_NO_BACKGROUND: "1", AGENTIC_OS_VITE_CACHE_DIR: join(WORK, "vite-cache"), HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off", MU_TRIGGERS: "off", MU_PREVIEW_PORT: String(PORT + 10), BROWSER: "none" },
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 160; i++) {
    if (await fetch(`${base}/__health`).then(() => true, () => false)) break;
    await sleep(1500);
  }

  // The synthetic hub has no Claude, Hermes or Codex sign-in and builds no capability registry, so those two READS are fixtured in the browser (in both the
  // before and the after run, identically): Claude Code installed but signed out, Hermes installed, Codex signed in, and the tool rows the audit saw.
  const FIXTURE = `(() => {
    const caps = { generatedAt: new Date().toISOString(), capabilities: [
      { id: "browser.jarvis-chrome", name: "Jarvis Chrome", category: "browser", status: "setup-required", ownerAction: "launcher or browser.cdp_url missing" },
      { id: "voice.jev", name: "Jev reflex layer", category: "voice", status: "setup-required", ownerAction: "add TYPESAFE_API_KEY to ~/.config/agentic-os.env" },
      { id: "notes.pinecone", name: "Pinecone long-term memory", category: "notes", status: "setup-required", evidence: "PINECONE_API_KEY not set" },
      { id: "notes.obsidian", name: "Obsidian", category: "notes", status: "setup-required", evidence: "OBSIDIAN_VAULT_PATH not set" },
      { id: "proactive.brief", name: "Morning brief", category: "proactive", status: "setup-required", evidence: "no cron job named morning-brief", ownerAction: "Recreate the morning-brief job (see docs/FILM-JARVIS.md)" },
      { id: "voice.free", name: "Voice", category: "voice", status: "working" } ] };
    const models = { models: [], checking: false, checkedAt: new Date().toISOString(), statuses: [
      { id: "claude", ready: false, installed: true, detail: "Claude Code is signed out. Sign in with /login." },
      { id: "hermes", ready: false, installed: true, detail: "installed" },
      { id: "codex", ready: true, detail: "ok" } ] };
    const orig = window.fetch.bind(window);
    const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    window.fetch = (input, init) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/__operator/capabilities")) return Promise.resolve(json(caps));
      if (url.includes("/__operator/models") && !url.includes("refresh")) return Promise.resolve(json(models));
      return orig(input, init);
    };
  })();`;
  const pages: { name: string; path: string; settle?: number; act?: string }[] = [
    { name: "claude-code", path: "/agents/claude-code", settle: 4000 },
    { name: "claude-code-missions-open", path: "/agents/claude-code", settle: 3000, act: "(async () => { document.querySelector('[aria-label=\"Long-term missions\"] button')?.click(); await new Promise(r => setTimeout(r, 1200)); })()" },
    { name: "claude-code-prompt-shown", path: "/agents/claude-code", settle: 3000, act: "(async () => { document.querySelector('[aria-label=\"Long-term missions\"] button')?.click(); await new Promise(r => setTimeout(r, 1200)); [...document.querySelectorAll('button')].find(b => /Show the prompt/.test(b.textContent))?.click(); await new Promise(r => setTimeout(r, 600)); })()" },
    { name: "hermes", path: "/agents/hermes", settle: 4000 },
    { name: "settings-ai-tools", path: "/settings#ai-tools", settle: 4000 },
    { name: "system-tools", path: "/system", settle: 5000, act: "document.querySelectorAll('details').forEach(d => d.open = true)" },
    { name: "system-devices", path: "/system#system-devices", settle: 4000, act: "document.querySelectorAll('details').forEach(d => d.open = true)" },
    { name: "vault", path: "/memory/vault", settle: 4000 },
    { name: "usage", path: "/usage", settle: 4000, act: "document.querySelectorAll('details').forEach(d => d.open = true)" },
    { name: "finance", path: "/business?view=finance", settle: 3500 },
    { name: "settings-connections", path: "/settings#connections", settle: 3500 },
    { name: "settings-jarvis", path: "/settings#jarvis", settle: 3000 },
    {
      name: "settings-jarvis-save-empty",
      path: "/settings#jarvis",
      settle: 3500,
      act: "(async () => { const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; for (const b of [...document.querySelectorAll('button[aria-label^=\"Remove\"]')]) b.click(); await new Promise(r => setTimeout(r, 300)); const g = document.querySelector('.jarvis-settings-field input'); if (g) set(g, 'A brand new greeting'); await new Promise(r => setTimeout(r, 300)); [...document.querySelectorAll('button')].find(b => /Save Jarvis settings/.test(b.textContent))?.click(); })()",
    },
  ];
  const results: string[] = [];
  for (const width of [1440, 390]) {
    const b = await openBrowser({ profile: join(WORK, `browser-${width}`), port: 9267, width, height: width === 1440 ? 1000 : 844 });
    await b.addInitScript(FIXTURE);
    await b.goto(`${base}/__health`);
    for (const p of pages) {
      await b.goto(`${base}${p.path}`);
      await sleep(p.settle ?? 3000);
      if (p.act) {
        await b.evaluate(p.act);
        await sleep(1800);
      }
      const file = join(OUT, `${LABEL}-${p.name}-${width}.png`);
      await b.shot(file);
      const text = await b.text();
      results.push(`${LABEL} ${p.name} ${width}: ${text.length} characters`);
    }
    await b.quit();
  }
  console.log(results.join("\n"));
} finally {
  stop();
}
process.exit(0);
