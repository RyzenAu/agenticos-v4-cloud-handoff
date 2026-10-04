// A thin, optional wrapper around the real Crawl4AI CLI (`crwl.exe`, a Playwright/Chromium-backed
// renderer — see D:\crawl4ai\venv) — used as a fallback for site-audit.ts's plain fetch when that
// fetch gives a weak or unreliable read: unreachable entirely, a JS-rendered/near-empty shell, or
// a bot-protection challenge page (see challenge-page.ts). Spawns the real .exe directly, never a
// .cmd shim or cmd.exe (the same lesson AgenticOS-v4 already learned the hard way with npm's own
// shims — see scripts/site-draft/qa.ts's defaultAgentBrowserBin), with the two env vars Crawl4AI
// needs on this machine, a hard timeout, and a small concurrency cap so a slow/stuck site can't
// back up the whole audit queue.
//
// Entirely optional: if the exe isn't present at its known path, every call here degrades to
// `null` rather than throwing — callers (enrich.ts) already treat a `null` render result as "stick
// with what the plain fetch got", exactly the behaviour this repo had before Crawl4AI existed.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { analyseHtml, EMPTY_SITE_AUDIT, extractEmails, publicUrl, type SiteAudit } from "./site-audit";
import { isChallengePage } from "./challenge-page";

/** Set up once, 25 Sep 2026 — see the owner's brief. Overridable via CRAWL4AI_BIN for a
 *  differently-provisioned machine or a test double; never read from a checked-in path other than
 *  this one, and never required (see `crawl4aiFetch`'s availability check). */
export const CRAWL4AI_BIN = process.env.CRAWL4AI_BIN || "D:\\crawl4ai\\venv\\Scripts\\crwl.exe";
const PLAYWRIGHT_BROWSERS_PATH = process.env.CRAWL4AI_BROWSERS_PATH || "D:\\crawl4ai\\browsers";

/** A real Chromium cold-launch plus a slow/heavy page can take a while — bounded so one stuck
 *  site can never hang a whole rescan/reaudit pass. Comparable to browser-audit.ts's own
 *  BROWSER_AUDIT_TIMEOUT_MS for the same reason. */
export const CRAWL4AI_TIMEOUT_MS = 45_000;

/** "About 2" per the owner's brief — Crawl4AI launches a real browser per crawl, and this repo's
 *  callers (rescan/reaudit) already run several leads concurrently; without a cap here, every one
 *  of them could try to launch Crawl4AI at once regardless of the caller's own concurrency. */
const CONCURRENCY = 2;

export type Crawl4aiRawResult = {
  html: string;
  markdown: string;
  statusCode: number | null;
  finalUrl: string;
  success: boolean;
};

export type RunResult = { code: number; stdout: string; stderr: string };
/** Every crwl.exe invocation goes through this — swap for a mock in tests, same convention as
 *  reminder-tasks.ts's CommandRunner and site-draft/qa.ts's Runner. */
export type Crawl4aiRunner = (bin: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<RunResult>;

export type Crawl4aiDeps = {
  bin?: string;
  timeoutMs?: number;
  run?: Crawl4aiRunner;
  /** Injectable so tests never touch the real filesystem/exe. Defaults to a real existsSync check
   *  against `bin`. */
  exists?: (path: string) => boolean;
};

export const defaultCrawl4aiRunner: Crawl4aiRunner = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: opts.env },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? (error as any).code : 1) : 0;
        resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      },
    );
  });

// --- concurrency: a plain counting semaphore, no external dependency ------------------------------
let active = 0;
const waiting: (() => void)[] = [];
function acquireSlot(): Promise<() => void> {
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };
  if (active < CONCURRENCY) {
    active++;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      active++;
      resolve(release);
    });
  });
}

let availabilityWarned = false;

/** True if the real crwl.exe is present at its known (or overridden) path. Cheap, synchronous —
 *  callers use it to skip straight to "not available" without paying for a subprocess spawn. */
export function crawl4aiAvailable(deps: Pick<Crawl4aiDeps, "bin" | "exists"> = {}): boolean {
  const exists = deps.exists ?? existsSync;
  return exists(deps.bin ?? CRAWL4AI_BIN);
}

/**
 * Runs `crwl <url> -o all` (JSON: html + markdown + status_code + the URL actually landed on) and
 * returns the parsed result, or `null` if the exe isn't installed, the process errored/timed out,
 * or its output wasn't the JSON shape expected — never throws. Concurrency-limited to
 * `CONCURRENCY` across the whole process, regardless of how many callers ask at once.
 */
export async function crawl4aiFetch(url: string, deps: Crawl4aiDeps = {}): Promise<Crawl4aiRawResult | null> {
  const bin = deps.bin ?? CRAWL4AI_BIN;
  const exists = deps.exists ?? existsSync;
  if (!exists(bin)) {
    if (!availabilityWarned) {
      availabilityWarned = true;
      console.error(`Crawl4AI not found at ${bin} — site audits fall back to the plain fetch/agent-browser only. It's optional.`);
    }
    return null;
  }
  const run = deps.run ?? defaultCrawl4aiRunner;
  const timeoutMs = deps.timeoutMs ?? CRAWL4AI_TIMEOUT_MS;
  const release = await acquireSlot();
  try {
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH, PYTHONIOENCODING: "utf-8" };
    const result = await run(bin, [url, "-o", "all"], { timeoutMs, env });
    if (result.code !== 0) return null;
    const parsed = JSON.parse(result.stdout);
    if (typeof parsed?.html !== "string") return null;
    return {
      html: parsed.html,
      markdown: typeof parsed.markdown?.raw_markdown === "string" ? parsed.markdown.raw_markdown : "",
      statusCode: typeof parsed.status_code === "number" ? parsed.status_code : null,
      finalUrl: typeof parsed.redirected_url === "string" && parsed.redirected_url ? parsed.redirected_url : url,
      success: parsed?.success !== false,
    };
  } catch {
    return null; // timeout (execFile kills + errors), a crash, or unparsable output — same "give up gracefully" outcome
  } finally {
    release();
  }
}

/**
 * The higher-level call enrich.ts actually uses: fetches `website` with Crawl4AI and, if it got
 * real HTML back, builds a full `SiteAudit` from it — same `analyseHtml`/`extractEmails` logic the
 * plain fetch (site-audit.ts) and the agent-browser retry (browser-audit.ts) both use, so scoring
 * treats a Crawl4AI-rendered page identically to any other source. A rendered page that's itself a
 * bot-protection challenge page (Crawl4AI got a real browser through, but the site still didn't
 * hand over real content) is never graded — it comes back `challengePage: true`, `reachable:
 * false`, for score.ts to turn into `audit_pending`/"bot-protected", never a fabricated "bad
 * website" finding. Returns `null` (not a SiteAudit) only when Crawl4AI itself couldn't be run at
 * all — the caller keeps whatever audit it already had.
 */
export async function crawl4aiAudit(website: string, deps: Crawl4aiDeps = {}): Promise<SiteAudit | null> {
  const url = publicUrl(website);
  if (!url) return null;
  const result = await crawl4aiFetch(url.href, deps);
  if (!result || !result.html.trim()) return null;

  if (isChallengePage(result.html)) {
    return { ...EMPTY_SITE_AUDIT, challengePage: true, error: "bot-protected", statusCode: result.statusCode };
  }

  const final = publicUrl(result.finalUrl) ?? url;
  const facts = analyseHtml(result.html);
  const emails = extractEmails(result.html, final.hostname);
  return {
    ...facts,
    reachable: true,
    finalUrl: final.href,
    auditedUrl: final.href,
    https: final.protocol === "https:",
    // Crawl4AI's own timing isn't the plain-fetch TTFB-ish figure score.ts's SLOW_MODERATE_MS/
    // SLOW_SEVERE_MS thresholds are calibrated against — null rather than a number that would be
    // compared against the wrong yardstick (browser-audit.ts makes the same call for responseMs).
    responseMs: null,
    emails,
    statusCode: result.statusCode,
    broken: false,
    sslError: false,
    overflowAt390: null,
    challengePage: false,
    homepageError: null,
    homepageBroken: false,
    homepageCheckedAt: null,
    homepageRetryCheckedAt: null,
  };
}
