/**
 * Plain pass/fail check that search and lead discovery work. Run it after ANY environment change (a Python or WSL upgrade, a distro update,
 * rebuilding a venv, restarting SearXNG):
 *
 *   bun scripts/ops/check-search.ts            full check
 *   bun scripts/ops/check-search.ts --no-wsl   skip the read-only WSL interpreter look (CI, machines without Kali)
 *
 * It only reads: the environment registry, the SearXNG virtualenv's interpreter (`python --version`, nothing installed or changed), SearXNG's
 * health route, one real search through the same client research and lead discovery use, and lead discovery's own search step. It never
 * starts, stops, upgrades or reconfigures SearXNG, WSL or any package. Exit code 0 = PASS, 1 = FAIL. Every FAIL line says what to do.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describeRegistry, loadRegistry, registryExists, validateRegistry, findSystemPythonInstalls } from "./python-envs";
import { SEARXNG_RECOVERY } from "./dependencies";
import { SEARXNG_URL, searxngQuery } from "../search/searxng";
import { searchAnswerCount, searxngDownNow, searxngWebsiteSearch } from "../leads/discovery";

const run = promisify(execFile);
const root = join(import.meta.dir, "..", "..");
const skipWsl = process.argv.includes("--no-wsl");
const base = (process.env.MU_SEARXNG_URL ?? SEARXNG_URL).replace(/\/$/, "");

type Line = { ok: boolean; name: string; detail: string; fix?: string };
const lines: Line[] = [];
const pass = (name: string, detail: string) => lines.push({ ok: true, name, detail });
const fail = (name: string, detail: string, fix: string) => lines.push({ ok: false, name, detail, fix });

// 1. The registry keeps experimental environments apart from operational ones.
if (!registryExists(root)) fail("environments", "config/python-envs.json is missing", "Restore it from git; it is the list of operational and experimental Python environments.");
else {
  const registry = loadRegistry(root);
  const problems = validateRegistry(registry);
  const installs = findSystemPythonInstalls(root);
  if (problems.length || installs.length) fail("environments", [...problems, ...installs.map((i) => `system Python install in ${i}`)].join("; "), "Fix config/python-envs.json or the script named; experiments never share a path with, or install into, what the OS runs on.");
  else pass("environments", `${registry.environments.length} registered, experimental kept apart from operational`);
  void describeRegistry;
}

// 2. SearXNG's virtualenv still has a working interpreter (read-only: prints a version, installs nothing).
if (skipWsl || process.platform !== "win32") pass("searxng interpreter", "skipped (--no-wsl or not Windows)");
else {
  try {
    const { stdout } = await run("wsl.exe", ["-d", "kali-linux", "--", "bash", "-c", "~/searxng-venv/bin/python --version 2>&1"], { timeout: 20_000, windowsHide: true });
    const out = String(stdout).replace(/\0/g, "").trim();
    if (/^Python 3\.\d+/.test(out)) pass("searxng interpreter", `${out} (venv interpreter runs)`);
    else fail("searxng interpreter", out || "no output", "The SearXNG virtualenv's interpreter is orphaned or missing (a distro Python upgrade does this). Rebuild the venv from a pinned interpreter: docs/programme-20261001/DEPENDENCY-ISOLATION.md.");
  } catch (e) {
    fail("searxng interpreter", `could not run it (${(e as Error).message.split("\n")[0].slice(0, 120)})`, "Check that WSL's kali-linux is running (wsl -l -v), then rebuild the SearXNG venv if its interpreter is gone: docs/programme-20261001/DEPENDENCY-ISOLATION.md.");
  }
}

// 3. SearXNG answers its health route.
try {
  const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5_000) });
  if (res.ok) pass("searxng health", `${base}/healthz answered`);
  else fail("searxng health", `${base}/healthz answered HTTP ${res.status}`, SEARXNG_RECOVERY);
} catch {
  fail("searxng health", `${base} is not reachable`, SEARXNG_RECOVERY);
}

// 4. One real search, through the one client. Hits are required: an empty or refused answer is a FAIL here, because the check's query always has results.
const outcome = await searxngQuery("NSW Fair Trading home building licences", { base, language: "en-AU", timeoutMs: 25_000 });
if (outcome.status === "results") pass("search", `${outcome.results.length} results${outcome.unresponsive.length ? `; engines refusing: ${outcome.unresponsive.join(", ")}` : ""}`);
else if (outcome.status === "no_results") fail("search", "answered but returned nothing for a query that always has results", "The engines are failing quietly. Check ~/searxng.log inside kali-linux (wsl -d kali-linux -- tail -40 ~/searxng.log) and the engines list in settings.yml.");
else fail("search", `unavailable: ${outcome.reason}`, SEARXNG_RECOVERY);

// 5. Lead discovery's own search step reaches SearXNG and counts as an answer (not 'could not search').
const answersBefore = searchAnswerCount();
const site = await searxngWebsiteSearch({ name: "Haberfield Dental Practice", suburb: "Haberfield", vertical: "dental" } as never);
const down = searxngDownNow();
if (down) fail("lead discovery", `its search step could not search: ${down}`, SEARXNG_RECOVERY);
else if (searchAnswerCount() === answersBefore) fail("lead discovery", "its search step did not register an answer", "Run bun test scripts/search; the discovery client and search client have drifted apart.");
else pass("lead discovery", site ? `search step answered and found ${new URL(site.url).hostname}` : "search step answered (no matching site for the sample business, which is a real answer)");

for (const l of lines) console.log(`${l.ok ? "PASS" : "FAIL"}  ${l.name.padEnd(20)} ${l.detail}${l.ok ? "" : `\n      do this: ${l.fix}`}`);
const failed = lines.filter((l) => !l.ok).length;
console.log(failed ? `\nRESULT: FAIL (${failed} of ${lines.length} checks)` : `\nRESULT: PASS (${lines.length} of ${lines.length} checks)`);
process.exit(failed ? 1 : 0);
