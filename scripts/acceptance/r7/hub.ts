#!/usr/bin/env bun
/**
 * Round 7 acceptance (worker H): start, stop or check the SYNTHETIC acceptance hub. Never the live hub.
 *
 *   bun scripts/acceptance/r7/hub.ts seed   [--data D:\AgenticOS-r7-data\h]            (an empty folder; runs seed-gate-hub.ts --host none)
 *   bun scripts/acceptance/r7/hub.ts start  [--port 8128] [--data ...] [--role pc|server|cloud] [--memory off|on] [--triggers off|on]
 *   bun scripts/acceptance/r7/hub.ts stop   [--data ...]
 *   any action also takes [--repo <worktree to serve>]; seed/reset take [--host none|local-wsl]; start takes, for a local-wsl seed,
 *   [--computers-home /home/<user>/mu-computers-<run>] [--display-base 41] [--monitor-ms 5000]
 *   bun scripts/acceptance/r7/hub.ts status [--port 8128]
 *
 * Isolation (why a profile/folder change here is enough for a TEST, and is not a security boundary):
 *   - MU_DATA_DIR is the synthetic folder; HOME and USERPROFILE point at a sibling synthetic home, so ~/.config/agentic-os.env, ~/.hermes,
 *     ~/.claude-os and the Desktop "designs" folder all resolve inside it (the hub reads keys from those paths; an empty home has none);
 *   - every inherited environment variable whose NAME looks like a credential (KEY, TOKEN, SECRET, PASSWORD, AUTH, CREDENTIAL, COOKIE,
 *     SESSION, PAT) is removed from the child's environment by name. Values are never read or printed;
 *   - OneDrive* variables are removed (shellFolder() would otherwise prefer the real OneDrive Desktop);
 *   - MU_LEAD_SITE_BUILDS and MU_DESIGN_PROJECTS_DIR point inside the synthetic folder (their defaults are real folders);
 *   - background work ON (AGENTIC_OS_NO_BACKGROUND unset: a quiet copy opens the job stores read-only, so /__jobs answers 503); --quiet on for a read-only copy;
 *   - HINDSIGHT_URL=off; memory writes off unless --memory on (then only the synthetic bank the run names, still with no Hindsight);
 *   - the Vite cache is private (node_modules is a shared junction: never delete through it);
 *   - binds 127.0.0.1 only; refuses 8081 and any port outside 8120-8199.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostEnvFor } from "./hub-env";

const argv = process.argv.slice(2);
const action = argv[0] ?? "status";
const arg = (n: string, d = "") => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] ?? d) : d);
const port = Number(arg("port", "8128"));
const data = resolve(arg("data", "D:\\AgenticOS-r7-data\\h"));
const role = arg("role", "pc");
/**
 * --repo <worktree>: the tree the hub SERVES (default: this one). Lets a later round's scripts drive a FROZEN candidate without editing it
 * (round 8: `--repo D:\AgenticOS-r7-candidate`). The seed and the CRM migration come from that tree too, so the data always matches the code that reads it.
 */
const repo = resolve(arg("repo") || resolve(import.meta.dir, "..", "..", ".."));
const side = `${data}-side`; // home, logs, caches, pid: kept OUT of the data folder so the seed's "empty folder" rule and backups stay clean
/** --host none|local-wsl on `seed` and `reset` (default none). */
const seedHost = arg("host", "none");

if (port === 8081 || port < 8120 || port > 8199) throw new Error(`Refusing port ${port}: the acceptance hub runs on 8120-8199, never the live 8081.`);
// Any round's synthetic data root (D:\AgenticOS-r7-data, D:\AgenticOS-r8-data, ...); never the real data.
if (!/AgenticOS-r\d+-data/i.test(data) || /\.operator-data|mu-hub|production/i.test(data)) throw new Error(`Refusing ${data}: the data folder must be under a D:\\AgenticOS-r<N>-data folder.`);
if (!["pc", "server", "cloud"].includes(role)) throw new Error("--role is pc, server or cloud");
if (/mu-hub|production|\.operator-data/i.test(repo) || !existsSync(join(repo, "vite.config.ts"))) throw new Error(`Refusing --repo ${repo}: not an AgenticOS worktree.`);
if (!["none", "local-wsl"].includes(seedHost)) throw new Error("--host is none or local-wsl (the Ryzen host is the lead's)");

/** Names only: a variable is dropped when its NAME looks like a credential. Its value is never looked at. */
export const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSW|AUTH|CREDENTIAL|COOKIE|SESSION|(^|_)PAT($|_)|BEARER|PRIVATE)/i;
export function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SENSITIVE_NAME.test(k)) continue;
    if (/^OneDrive/i.test(k)) continue;
    if (/^(MU_|AGENTIC_OS_|HINDSIGHT_|HERMES_|CODEX_|CLAUDE_|OPENCLAW|CLINE|OLLAMA|LMSTUDIO|OPENROUTER|ANTHROPIC|OPENAI|GROQ|GEMINI|ELEVEN|TWILIO|RETELL|STRIPE|TELEGRAM)/i.test(k)) continue;
    env[k] = v;
  }
  // Windows names are case-insensitive (Path vs PATH): drop any inherited spelling of a name we set.
  for (const k of Object.keys(extra)) for (const e of Object.keys(env)) if (e.toLowerCase() === k.toLowerCase()) delete env[e];
  return { ...env, ...extra };
}

const pidFile = join(side, "hub.pid");

async function up(ms = 1500): Promise<{ ok: boolean; status?: number; body?: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__health`, { signal: AbortSignal.timeout(ms) });
    return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 300) };
  } catch {
    return { ok: false };
  }
}

function stop() {
  if (!existsSync(pidFile)) return console.log("No pid file: nothing to stop.");
  const pid = readFileSync(pidFile, "utf8").trim();
  if (/^\d+$/.test(pid)) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
  rmSync(pidFile, { force: true });
  console.log(`Stopped the acceptance hub (pid ${pid}).`);
}

async function start() {
  if ((await up()).status) throw new Error(`Something already answers on ${port}; stop it first.`);
  if (!existsSync(join(data, ".gate-seed.json"))) throw new Error(`${data} was not made by the gate seed; run "seed" first.`);
  const home = join(side, "home");
  for (const d of [home, join(home, ".config"), join(home, "Desktop"), join(home, "AppData", "Roaming"), join(home, "AppData", "Local"), join(side, "logs"), join(side, "vite-cache"), join(data, "designs"), join(data, "lead-site-builds")]) mkdirSync(d, { recursive: true });
  mkdirSync(join(side, "bin"), { recursive: true });
  // The stub answers exactly as a signed-out CLI does (v59 wording), so the candidate's "Vercel isn't signed in" state can be checked.
  writeFileSync(join(side, "bin", "vercel.cmd"), "@echo Error: No existing credentials found. Please run `vercel login` (acceptance hub stub) 1>&2\r\n@exit /b 1\r\n");
  writeFileSync(join(side, "bin", "vercel.ps1"), "[Console]::Error.WriteLine('Error: No existing credentials found. Please run vercel login (acceptance hub stub)'); exit 1\r\n");
  const env = childEnv({
    MU_DATA_DIR: data,
    HOME: home,
    USERPROFILE: home,
    // The CLIs keep their logins under APPDATA / LOCALAPPDATA too (Hermes lives in %LOCALAPPDATA%\hermes): point both at the synthetic home, or the
    // hub finds the owner's real Codex, Claude and Hermes sign-ins (seen on the first run: "Codex Ready · signed in", a ChatGPT Plus plan limit).
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    MU_HUB_ROLE: role,
    MU_SYNTHETIC_HUB: "1", // the CLI-home guard gives this hub its own empty CLI homes even if HOME were the owner's
    ...hostEnvFor(data, { computersHome: arg("computers-home"), displayBase: arg("display-base"), monitorMs: arg("monitor-ms") }),
    HINDSIGHT_URL: "off",
    // Round 10: the memory reader's vault and index are the synthetic data folder's own, set explicitly (never the home default, even a synthetic one).
    MU_WIKI_ROOT: join(data, "synthetic-vault"),
    MEMORY_STATE_DIR: join(data, "memory"),
    MU_MEMORY_WRITES: arg("memory", "off") === "on" ? "on" : "off",
    MU_TRIGGERS: arg("triggers", "off") === "on" ? "on" : "off",
    MU_TRIGGERS_NOTIFY: "0",
    AGENTIC_OS_NO_BACKGROUND: arg("quiet", "off") === "on" ? "1" : "", // a quiet copy (=1) opens the job stores read-only: not a real hub, so off by default
    AGENTIC_OS_NO_CODEX: "1",
    AGENTIC_OS_VITE_CACHE_DIR: join(side, "vite-cache"),
    MU_DESIGN_PROJECTS_DIR: join(data, "designs"),
    MU_LEAD_SITE_BUILDS: join(data, "lead-site-builds"),
    MU_SEARXNG_URL: "http://127.0.0.1:9", // nothing listens: no web search leaves the PC
    BROWSER: "none",
    // A stub `vercel` first on PATH: the Websites page refreshes `vercel project ls` in the background (scripts/websites/catalogue.ts), and with no
    // login the real CLI starts a device sign-in and OPENS A BROWSER WINDOW on the desktop (seen on this run, finding H-07). The stub just fails.
    PATH: `${join(side, "bin")};${process.env.PATH ?? ""}`,
    CI: "1",
  });
  if (env.AGENTIC_OS_NO_BACKGROUND === "") delete env.AGENTIC_OS_NO_BACKGROUND;
  const out = openSync(join(side, "logs", "hub.out.log"), "a");
  const err = openSync(join(side, "logs", "hub.err.log"), "a");
  const child = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--configLoader", "native", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: repo, env, detached: true, stdio: ["ignore", out, err], windowsHide: true });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const h = await up(3000);
    if (h.status) {
      if (argv.includes("--no-owner")) {
        // A journey that restarts the hub keeps its own browser open (the owner profile is locked by it).
        console.log(JSON.stringify({ started: true, port, pid: child.pid, role, data, health: h.status }));
        return;
      }
      // The owner's persistent browser opens the hub first: on a fresh seed that is the trusted-on-first-use session; afterwards it reuses its cookie.
      const lib = await import("./lib");
      const s = await lib.session(undefined, { origin: `http://127.0.0.1:${port}` }); // this hub, not the library default (8128)
      await s.page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
      const who = await lib.me(s.page);
      await lib.closeAll();
      console.log(JSON.stringify({ started: true, port, pid: child.pid, role, data, health: h.status, ownerBrowser: who }));
      if (who.actor !== "human") console.log("WARNING: the owner profile is not a confirmed session (another browser opened this hub first). Re-seed with `reset`.");
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`The hub did not answer within 3 minutes; see ${join(side, "logs")}.`);
}

function seed() {
  if (existsSync(data) && readdirSync(data).length) throw new Error(`${data} is not empty; the seed needs a new folder (delete it yourself if it is a previous synthetic run).`);
  const r = spawnSync(process.execPath, [join(repo, "scripts", "acceptance", "seed-gate-hub.ts"), "--data", data, "--host", seedHost], { cwd: repo, encoding: "utf8", env: childEnv({}) });
  process.stdout.write(r.stdout);
  if (r.status !== 0) throw new Error(`seed failed: ${(r.stderr || "").slice(0, 400)}`);
  // The candidate's CRM refuses to open an un-migrated crm.sqlite (migration guard): apply it once, with the backup the tool insists on.
  if (existsSync(join(repo, "scripts", "crm", "migrate.ts"))) {
    mkdirSync(side, { recursive: true });
    const m = spawnSync(process.execPath, [join(repo, "scripts", "crm", "migrate.ts"), "--db", join(data, "crm.sqlite"), "--apply", "--backup", join(side, `crm-premigration-${Date.now()}.sqlite`)], { cwd: repo, encoding: "utf8", env: childEnv({}) });
    console.log(`crm migration: exit ${m.status} ${(m.stdout || m.stderr || "").replace(/\s+/g, " ").slice(0, 200)}`);
    if (m.status !== 0) throw new Error("the CRM migration failed on the synthetic data");
  }
}

/** Every link or junction (reparse point) at or under `dir`, without following any of them. */
function linksUnder(dir: string, found: string[] = []): string[] {
  if (lstatSync(dir).isSymbolicLink()) return [...found, dir];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) found.push(p);
    else if (st.isDirectory()) linksUnder(p, found);
  }
  return found;
}

/**
 * Stop, delete the synthetic DATA folder (marker present) and the owner's browser profile, seed again, start. Never deletes through a link: any
 * junction or symlink at or under a folder makes it refuse (Windows plants junctions such as INetCache\Content.IE5 inside a home's AppData, which is
 * why the synthetic home is kept, not deleted).
 */
async function reset() {
  stop();
  await new Promise((r) => setTimeout(r, 1500));
  for (const d of [data, join(side, "owner-profile"), join(side, "logs")]) {
    if (!existsSync(d)) continue;
    if (realpathSync.native(d).toLowerCase() !== d.toLowerCase()) throw new Error(`${d} resolves elsewhere: refusing to delete through it.`);
    const links = linksUnder(d);
    if (links.length) throw new Error(`${d} contains links or junctions (${links.slice(0, 3).join(", ")}): refusing to delete it. Remove it yourself.`);
    if (d === data && !existsSync(join(d, ".gate-seed.json"))) throw new Error(`${d} has no seed marker: refusing to delete it.`);
    rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
  seed();
  await start();
}

if (action === "seed") seed();
else if (action === "reset") await reset();
else if (action === "start") await start();
else if (action === "stop") stop();
else console.log(JSON.stringify(await up()));
