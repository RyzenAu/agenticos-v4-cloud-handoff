#!/usr/bin/env bun
/**
 * Engine-agnostic Dream runner — the single entry point the nightly task calls
 * (Windows Task Scheduler "ClaudeOS Dream", 1:30 am Sydney; see install-dream-cron.ts).
 *
 * Reads the operator's chosen engine from ~/.claude-os/config.json (set from the dashboard's
 * engine picker via /__set_dream_engine):
 *   - claude     : the overnight pipeline (recommended). Runs the official `claude -p` on the
 *                  Claude subscription with the /dream skill as its system prompt, tools off,
 *                  over a pre-built digest (no raw transcripts). Adds the morning report and
 *                  proposed-improvement briefs, the safe overnight chores, and the guardrails.
 *   - hermes     : `hermes chat` with the dream skill (agentic), on Hermes' own configured model.
 *   - codex      : `codex exec` on the Codex CLI's default account and model.
 *   - openrouter : direct API call (config.openRouterModel, default the catalogue's
 *                  openrouter/claude-fable-5 = anthropic/claude-fable-5).
 *
 * Every model call goes through the model router (task dream.nightly, scripts/dream/engines.ts):
 * the engine choice is the owner's selected model, model ids come from the catalogue, and each call
 * writes a router receipt with the model that ran (null when a CLI doesn't report it).
 *
 * Guardrails (every engine): a lock so two dreams never overlap, and a status file
 * (~/.claude-os/dreams/last-run.json) the aggregator surfaces on the dashboard — a failed or
 * skipped night shows as failed/skipped, never as a quiet success. The claude pipeline also caps
 * Claude calls and tokens per night and skips the night when Claude's weekly usage is >= 85%. That is
 * a guard on the flat-fee Claude subscription's shared usage window (so one night can't use up the
 * owner's week), not a spending cap: it never applies to the OpenRouter engine (V7: no in-app caps
 * on OpenRouter or Jev spend).
 *
 * Nothing here changes code, deploys, sends, pushes or merges. Proposals are briefs only.
 *
 * Usage:
 *   bun scripts/run-dream.ts                 # the full nightly run
 *   bun scripts/run-dream.ts --no-chores     # skip lead re-audit + client QA
 *   bun scripts/run-dream.ts --no-checks     # skip `bun test scripts` + tsc
 *   bun scripts/run-dream.ts --dry-run       # build the input bundle, don't call a model
 *   bun scripts/run-dream.ts --no-aggregate  # don't refresh live-data.json before/after
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { IS_WIN, whichCommand, appData, localAppData } from "./platform";
import { commandLaunch } from "./assistant-runtime";
import { defaultClaudeBin } from "./claude-bridge";
import {
  acquireLock, claudeWeeklyPercent, DREAM_ENGINES, DreamBudget, dreamLimits, dreamPaths, dreamSelection, estimateTokens, normaliseDream, parseModelJson,
  readJson, releaseLock, renderReportMarkdown, summaryLine, sydneyDate, updateDreamState, usageGate, writeJsonAtomic,
  type DreamEngine, type DreamLimits, type LastRun,
} from "./dream/core";
import { codexConfigModel, dreamCall, hermesConfigModel, openRouterDreamCall, type DreamReply } from "./dream/engines";
import { providerKey } from "./provider-config";
import type { RouteChoice } from "./model-router/router";
import {
  aiUsageDigest, buildBundle, clientHubs, crmDigest, fetchAiUsage, jarvisDigest, liveDigest, meetingDigest, runChecks, sessionSummaries, sessionTitles,
} from "./dream/inputs";
import { clientSiteQa, reauditPendingLeads } from "./dream/chores";
import { skillMiningDigest } from "./dream/skill-miner";

const HOME = homedir();
const REPO = resolve(import.meta.dir, "..");
const REPOS_ROOT = resolve(REPO, "..");
const STATE_DIR = join(HOME, ".claude-os");
const P = dreamPaths(STATE_DIR);
const CONFIG = join(STATE_DIR, "config.json");
const today = sydneyDate();
const FLAGS = new Set(process.argv.slice(2));
const BUN = process.execPath;

function readConfig(): any {
  return readJson(CONFIG) ?? {};
}

// Resolve a CLI: known locations first, then PATH (nvm/npm/brew). Returns
// undefined when not found anywhere.
function resolveBin(name: string, fallbacks: string[]): string | undefined {
  for (const p of fallbacks) if (p && existsSync(p)) return p;
  try {
    const out = spawnSync(whichCommand(), [name], { encoding: "utf-8" }).stdout ?? "";
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  } catch {
    /* not on PATH */
  }
  return undefined;
}

const hermesBin = () =>
  resolveBin("hermes", IS_WIN
    ? [join(HOME, ".local", "bin", "hermes.exe"), join(appData(), "npm", "hermes.cmd")]
    : [join(HOME, ".local", "bin", "hermes"), "/opt/homebrew/bin/hermes", "/usr/local/bin/hermes"]);
const codexBin = () =>
  resolveBin("codex", IS_WIN
    ? [join(appData(), "npm", "codex.cmd"), join(localAppData(), "Programs", "codex", "codex.exe")]
    : ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);

function skillText(): string {
  const skillPath = [
    join(REPO, "skills", "dream", "SKILL.md"),
    join(HOME, ".claude", "skills", "dream", "SKILL.md"),
    join(HOME, ".hermes", "skills", "dream", "SKILL.md"),
  ].find((p) => existsSync(p));
  if (!skillPath) throw new Error("Dream SKILL.md not found in any standard location");
  return readFileSync(skillPath, "utf-8");
}

/** The Hermes business-dream cron (5:30 am) leaves the latest M&U strategy file here. At 1:30 am
 *  it is ~20 hours old, so trust anything written in the last 26 hours. */
function businessDream(): string {
  const businessPath = join(P.dir, "business-latest.json");
  return existsSync(businessPath) && Date.now() - statSync(businessPath).mtimeMs < 26 * 3_600_000
    ? readFileSync(businessPath, "utf-8")
    : "";
}

function liveData(): any {
  return readJson(join(REPO, "src", "data", "live-data.json"));
}

function refreshAggregate(label: string) {
  if (FLAGS.has("--no-aggregate")) return;
  const r = spawnSync(BUN, ["run", "scripts/aggregate.ts"], { cwd: REPO, encoding: "utf-8", timeout: 5 * 60_000, windowsHide: true });
  const lines = `${r.stdout ?? ""}${r.stderr ?? ""}`.split(/\r?\n/).filter((l) => /dream|wrote|error/i.test(l));
  console.log(`[run-dream] aggregate (${label}) exit ${r.status}${lines.length ? `: ${lines.slice(-3).join(" | ")}` : ""}`);
}

// ---- legacy engines (unchanged behaviour: prescriptions only) --------------------------------------

function assemblePrompt(): { system: string; user: string } {
  const system = [
    skillText(), "", "---",
    "IMPORTANT: You are being run non-interactively with no file tools. Your ENTIRE",
    "reply must be a single valid JSON object matching the skill's schema — no",
    "markdown fences, no prose.",
    `Set "date" to "${today}" and "generatedAt" to the current ISO timestamp.`,
  ].join("\n");
  const liveDataPath = join(REPO, "src", "data", "live-data.json");
  const live = existsSync(liveDataPath) ? readFileSync(liveDataPath, "utf-8") : "{}";
  const business = businessDream();
  const user = [
    "Operator's aggregated activity data:", "", live, "",
    ...(business ? ["Tonight's Business Dream (carry its top prescription over, per the skill):", "", business, ""] : []),
    "Produce the dream prescription JSON now.",
  ].join("\n");
  return { system, user };
}

/** The model a receipt says ran: the provider's own report, else the routed catalogue id. */
const ranModel = (choice: RouteChoice, reply: DreamReply) => reply.providerModel ?? choice.model;
const ROUTE = { root: REPO };

function writeLegacyDream(raw: any, engine: string, model: string) {
  const doc = normaliseDream(raw, { date: today, model, engine });
  writeJsonAtomic(P.dream(today), doc);
  return doc;
}

function runAgenticCli(bin: string, args: string[], label: string): number {
  console.log(`[run-dream] ${label}: launching ${bin}`);
  // `bin` may resolve to an npm `.cmd` shim on Windows — commandLaunch() wraps a shim in
  // `cmd.exe /c`; the argv here is short and fixed, so the ~8 KB cmd.exe cap does not apply.
  const launch = commandLaunch(bin, args);
  const r = spawnSync(launch.file, launch.args, { stdio: "inherit", timeout: 15 * 60_000, windowsVerbatimArguments: launch.windowsVerbatimArguments });
  return r.status ?? 1;
}

/** A config file's text, or null when it can't be read. */
function readText(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf-8") : null;
  } catch {
    return null;
  }
}

/** Hermes (agentic) writes tonight's dream file itself, run exactly as before E2 (no model passed).
 *  The receipt names the model Hermes' config selects; Hermes doesn't report which model answered
 *  (its own fallbacks may), so providerModel stays null. */
async function runHermes(bin: string, cfg: any, run: LastRun) {
  const hermesHome = process.env.HERMES_HOME || join(HOME, ".hermes");
  const selection = dreamSelection("hermes", cfg, hermesConfigModel(readText(join(hermesHome, "config.yaml"))));
  const { choice } = await dreamCall("hermes", selection, ROUTE, async () => {
    const code = runAgenticCli(bin, ["chat", "-Q", "--skills", "dream", "--yolo", "-q", "/dream"], "hermes");
    if (code !== 0) throw new Error(`hermes exited ${code}`);
    if (!existsSync(P.dream(today))) throw new Error(`hermes finished but wrote no dream-${today}.json`);
    return { text: "", providerModel: null, inputTokens: null, outputTokens: null };
  }, { sideEffects: true });
  run.model = selection.runs ?? choice.model;
}

/** codex exec on the CLI's signed-in account and its own configured model, exactly as before E2 (no
 *  -m). The receipt records that model, read from the CLI's config.toml (null when unreadable). */
async function runCodex(bin: string, cfg: any, run: LastRun) {
  const { system, user } = assemblePrompt();
  const codexHome = process.env.CODEX_HOME || join(HOME, ".codex");
  const selection = dreamSelection("codex", cfg, codexConfigModel(readText(join(codexHome, "config.toml"))));
  const { reply, choice } = await dreamCall("codex", selection, ROUTE, async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-os-codex-"));
    const outFile = join(tmpDir, "dream.json");
    try {
      const launch = commandLaunch(bin, ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--output-last-message", outFile]);
      const r = spawnSync(launch.file, launch.args, {
        input: `${system}\n\n${user}`, encoding: "utf-8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
      if (!existsSync(outFile)) throw new Error(`codex produced no output (exit ${r.status}). ${(r.stderr || "").slice(-300)}`.trim());
      return { text: readFileSync(outFile, "utf-8"), providerModel: selection.runs, inputTokens: null, outputTokens: null };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  run.model = ranModel(choice, reply);
  return writeLegacyDream(parseModelJson(reply.text), "codex", run.model);
}

/** The pre-E2 OpenRouter key lookup (env, ~/.hermes/.env, ~/.claude-os/.env.local, repo .env.local),
 *  then the OS config lookup (~/.config/agentic-os.env) as well. */
function openRouterKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  for (const f of [join(HOME, ".hermes", ".env"), join(STATE_DIR, ".env.local"), join(REPO, ".env.local")]) {
    const m = readText(f)?.match(/^\s*OPENROUTER_API_KEY\s*=\s*"?([^"\n\r]+)"?\s*$/m);
    if (m?.[1]) return m[1].trim();
  }
  return providerKey(REPO, "OPENROUTER_API_KEY");
}

async function runOpenRouter(cfg: any, run: LastRun) {
  const key = openRouterKey();
  if (!key) throw new Error("OPENROUTER_API_KEY not found (env, ~/.hermes/.env, or .env.local)");
  const { system, user } = assemblePrompt();
  const messages = [{ role: "system" as const, content: system }, { role: "user" as const, content: user }];
  const selection = dreamSelection("openrouter", cfg);
  const { reply, choice } = await dreamCall("openrouter", selection, { ...ROUTE, hasKey: () => true }, openRouterDreamCall(key, selection.runs!, messages));
  run.model = ranModel(choice, reply);
  return writeLegacyDream(parseModelJson(reply.text), "openrouter", run.model);
}

// ---- the claude overnight pipeline ----------------------------------------------------------------

/** Anything that would switch Claude Code from the subscription to paid API billing. */
const BILLING_OVERRIDES = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;

type ClaudeResult = { text: string; tokens: number; model: string; inputTokens: number; outputTokens: number };

/** One headless `claude -p` call on the Claude subscription: official CLI, tools off, no MCP, no
 *  CLAUDE.md/memory, prompt over stdin, system prompt from a file. Never `--bare`. */
function callClaude(system: string, user: string, limits: DreamLimits, model: string): Promise<ClaudeResult> {
  const bin = defaultClaudeBin();
  const cwd = mkdtempSync(join(tmpdir(), "claude-os-dream-"));
  const systemFile = join(cwd, "dream-system.md");
  writeFileSync(systemFile, system);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!BILLING_OVERRIDES.test(k)) env[k] = v;
  Object.assign(env, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_ORG_MEMORY: "1" });
  const args = [
    "-p", "--model", model, "--tools", "", "--strict-mcp-config", "--setting-sources", "project,local",
    "--no-session-persistence", "--output-format", "json", "--system-prompt-file", systemFile,
  ];
  console.log(`[run-dream] claude: ${bin} (model ${model}, ~${estimateTokens(system.length + user.length)} input tokens)`);
  return new Promise<ClaudeResult>((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude -p took longer than ${Math.round(limits.timeoutMs / 60_000)} min`));
    }, limits.timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let result: any;
      try {
        result = JSON.parse(out.slice(out.indexOf("{")));
      } catch {
        return reject(new Error(`claude -p exited ${code} without JSON output${err ? `: ${err.slice(0, 300)}` : ""}`));
      }
      const u = result?.usage ?? {};
      const inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const outputTokens = u.output_tokens ?? 0;
      const tokens = inputTokens + outputTokens;
      if (result?.is_error || typeof result?.result !== "string")
        return reject(Object.assign(new Error(`claude -p failed: ${String(result?.result ?? result?.subtype ?? "no result").slice(0, 300)}`), { tokens }));
      // The model claude -p reports it ran ("" when it doesn't say; the receipt then keeps null).
      const model = Object.keys(result.modelUsage ?? {})[0] ?? "";
      resolvePromise({ text: result.result, tokens, model, inputTokens, outputTokens });
    });
    child.stdin.end(user);
  }).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

const NO_TOOLS_ADDENDUM = (date: string) => `
---
## How you are being run tonight (overrides Step 1, Step 5 and Step 6 file handling)

You are the overnight Dream, running headless at about 1:30 am Sydney time with NO tools and NO
file access. The user message is a pre-built digest of everything you may use; it deliberately
contains no raw transcripts or prompts. Do not ask for more data. The runner writes the files and
updates state.json for you from your reply.

Reply with ONE JSON object only (no fences, no prose) in the "Overnight output" shape from this
skill: "prescriptions" (up to 4), "report" and "proposals". Use "date": "${date}".
Australian English. Be specific and cite numbers from the digest. Never invent data: if a section
says it is unavailable or empty, say so instead of guessing. Proposals are briefs for a human or
agent to run later; never claim anything was changed.
`;

async function runClaudePipeline(cfg: any, run: LastRun) {
  const limits = dreamLimits(cfg);
  const budget = new DreamBudget(limits);
  const selection = dreamSelection("claude", cfg);
  run.model = selection.selected;

  const ld = liveData();
  const usageSnapshot = await fetchAiUsage();
  const weekly = claudeWeeklyPercent(usageSnapshot, ld);
  run.weeklyPercent = weekly.percent;
  const gate = usageGate(weekly.percent, limits.weeklySkipPercent);
  console.log(`[run-dream] usage gate: ${gate.reason} (${weekly.source})`);
  if (gate.skip) {
    run.status = "skipped";
    run.reason = gate.reason;
    return;
  }

  // Safe overnight chores (cheap, non-destructive; see scripts/dream/chores.ts).
  const chores: Record<string, unknown> = {};
  if (!FLAGS.has("--no-chores") && cfg?.dream?.chores !== false) {
    try {
      chores.leadReaudit = await reauditPendingLeads(REPO, 20);
      console.log(`[run-dream] chores: re-audited ${(chores.leadReaudit as any).checked} audit-pending lead(s)`);
    } catch (err) {
      chores.leadReaudit = { error: err instanceof Error ? err.message : String(err) };
    }
    try {
      chores.clientQa = clientSiteQa({ repo: REPO, bun: BUN, reposRoot: REPOS_ROOT, qaDir: P.qa, date: today });
      console.log(`[run-dream] chores: client QA on ${(chores.clientQa as any[]).length} site(s)`);
    } catch (err) {
      chores.clientQa = { error: err instanceof Error ? err.message : String(err) };
    }
  } else chores.skipped = "chores off for this run";
  run.chores = chores;

  let checks: Record<string, unknown> = { skipped: "checks off for this run" };
  if (!FLAGS.has("--no-checks") && cfg?.dream?.checks !== false) {
    console.log("[run-dream] checks: bun test scripts + tsc (quiet)");
    checks = runChecks(REPO, BUN);
  }
  const brief = (c: any) => (c && typeof c === "object" && "summary" in c ? { ok: c.ok, summary: c.summary } : c);
  run.checks = { tests: brief((checks as any).tests), tsc: brief((checks as any).tsc), ...("skipped" in checks ? { skipped: checks.skipped } : {}) };

  const prevState = readJson(P.state);
  const lastRuns = existsSync(P.runs)
    ? readFileSync(P.runs, "utf-8").trim().split("\n").slice(-7).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const previousReport = (() => {
    const prev = readdirSync(P.dir).filter((f) => /^dream-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `dream-${today}.json`).sort().pop();
    const d = prev ? readJson(join(P.dir, prev)) : null;
    return d ? { date: d.date, summaryLine: d.report?.summaryLine, topActions: d.report?.topActions, proposals: (d.proposals ?? []).map((p: any) => p.title), prescriptions: (d.prescriptions ?? []).map((p: any) => `${p.id}: ${p.headline}`) } : "no previous dream";
  })();

  // Priority order: when the bundle would exceed the input cap, the tail is dropped first.
  const sections: [string, unknown][] = [
    ["Tonight", { date: today, timezone: "Australia/Sydney", weeklyClaudeUsage: weekly, nightlyLimits: limits }],
    ["Health checks (bun test scripts + tsc)", checks],
    ["Overnight chores", chores],
    ["Client hubs (open items, deadlines)", clientHubs(REPOS_ROOT)],
    ["CRM: leads hunted, calls, outcomes, coaching", (() => { try { return crmDigest(join(REPO, ".operator-data", "crm.sqlite")); } catch (e) { return `CRM unreadable: ${(e as Error).message}`; } })()],
    ["Meeting-mode coaching notes", meetingDigest(join(REPO, ".operator-data", "meeting-mode"))],
    ["Skill-candidate mining (last 30 days: Jarvis conversations, jarvis-events, Hermes session metadata, Claude Code first prompts, CRM activity, away-mode queue)", (() => {
      try {
        return skillMiningDigest({ operatorData: join(REPO, ".operator-data"), claudeProjects: join(HOME, ".claude", "projects"), hermesHome: process.env.HERMES_HOME || join(HOME, ".hermes") });
      } catch (e) {
        return `skill mining unreadable: ${(e as Error).message}`;
      }
    })()],
    ["Claude Code + Codex sessions (last 24 h: titles and counts, plus written wrap-ups)", {
      sessions: sessionTitles({ claudeProjects: join(HOME, ".claude", "projects"), codexIndex: join(HOME, ".codex", "session_index.jsonl") }),
      wrapUps: sessionSummaries({ reposRoot: REPOS_ROOT, desktop: join(HOME, "Desktop"), wikiRoot: join(REPOS_ROOT, "mu-ventures-obsidian-wiki") }),
    }],
    ["AI usage and spend (AUD)", aiUsageDigest(usageSnapshot)],
    ["Jarvis routing and capabilities", jarvisDigest(join(REPO, ".operator-data"))],
    ["Previous dream", previousReport],
    ["Dream run history", lastRuns],
    ["Dream state (accepted/dismissed prescriptions)", prevState?.actions ?? {}],
    ["Business Dream (5:30 am Hermes cron)", businessDream() || "none in the last 26 hours"],
    ["Activity aggregate (live-data.json digest)", liveDigest(ld)],
  ];
  const system = skillText() + NO_TOOLS_ADDENDUM(today);
  const bundle = buildBundle(sections, limits.maxInputChars - system.length);
  writeJsonAtomic(P.inputs(today), { date: today, chars: bundle.text.length, dropped: bundle.dropped, bundle: bundle.text });
  if (bundle.dropped.length) console.log(`[run-dream] input cap: dropped ${bundle.dropped.join(", ")}`);
  if (FLAGS.has("--dry-run")) {
    console.log(`[run-dream] dry run: bundle ${bundle.text.length} chars written to ${P.inputs(today)}`);
    run.status = "skipped";
    run.reason = "dry run (no model call)";
    return;
  }

  const user = `${bundle.text}\n\nProduce tonight's Dream JSON now.`;
  let doc = null as ReturnType<typeof normaliseDream> | null;
  let lastErr = "";
  let prompt = user;
  let parent: string | null = null;
  while (!doc) {
    const est = estimateTokens(system.length + prompt.length) + 12_000;
    const ok = budget.allows(est);
    if (!ok.ok) throw new Error(`${lastErr ? `${lastErr}; ` : ""}stopped by guardrail: ${ok.reason}`);
    const thisPrompt = prompt;
    // One routed call, one receipt. The repair retry is a new request linked to the first, never a replay.
    const { reply, receipt, choice } = await dreamCall("claude", selection, ROUTE, async (routed) => {
      let res: ClaudeResult;
      try {
        // The saved Claude model exactly as before E2 (an owner-choice value goes to claude -p as saved).
        res = await callClaude(system, thisPrompt, limits, selection.runs ?? routed.providerModel);
      } catch (err: any) {
        budget.record(err?.tokens ?? 0);
        throw err;
      }
      budget.record(res.tokens);
      return { text: res.text, providerModel: res.model || null, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
    }, { parentRequestId: parent });
    parent = receipt.requestId;
    const model = ranModel(choice, reply);
    run.model = model;
    try {
      doc = normaliseDream(parseModelJson(reply.text), { date: today, model, engine: "claude" });
    } catch (err) {
      lastErr = `unusable reply: ${(err as Error).message}`;
      console.warn(`[run-dream] ${lastErr} — retrying once if the budget allows`);
      prompt = `${user}\n\nYour previous reply could not be parsed (${(err as Error).message}). Reply with ONLY the JSON object.`;
    }
  }
  run.claudeCalls = budget.calls;
  run.tokens = budget.tokens;
  doc.metadata = { ...(doc.metadata ?? {}), claudeCalls: budget.calls, tokensUsed: budget.tokens, inputChars: bundle.text.length, droppedSections: bundle.dropped, weeklyPercent: weekly.percent };

  writeJsonAtomic(P.dream(today), doc);
  const checksMd = "skipped" in checks ? String(checks.skipped) : `Tests: ${(checks as any).tests?.summary}. Typecheck: ${(checks as any).tsc?.summary}.`;
  const choresMd = JSON.stringify(chores, null, 2).slice(0, 4000);
  writeFileSync(P.report(today), renderReportMarkdown(doc, { checks: checksMd, chores: "```json\n" + choresMd + "\n```" }));
  writeJsonAtomic(P.state, updateDreamState(prevState, doc.prescriptions.map((p: any) => p.id), new Date().toISOString()));
  writeFileSync(P.summary, `${today} ${summaryLine(doc)}\n`);
  run.status = "ok";
  console.log(`[run-dream] claude wrote dream-${today}.json + report-${today}.md: ${summaryLine(doc)}`);
  console.log(`[run-dream] ${budget.calls} Claude call(s), ${budget.tokens} tokens`);
}

// ---- main -----------------------------------------------------------------------------------------

function pruneOldInputs() {
  try {
    for (const f of readdirSync(P.dir)) {
      if (!/^inputs-\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
      if (Date.now() - statSync(join(P.dir, f)).mtimeMs > 14 * 86_400_000) rmSync(join(P.dir, f), { force: true });
    }
  } catch {
    /* best-effort */
  }
}

async function main(): Promise<number> {
  mkdirSync(P.dir, { recursive: true });
  const cfg = readConfig();
  let engine = String(cfg.dreamEngine || "").toLowerCase() as DreamEngine;
  if (!DREAM_ENGINES.includes(engine)) {
    engine = "claude";
    console.log(`[run-dream] no engine in config — using 'claude' (the Claude subscription)`);
  }
  const startedAt = new Date().toISOString();
  const lock = acquireLock(P.lock);
  if (!lock.ok) {
    const msg = `another Dream is already running (pid ${lock.holder.pid}, since ${lock.holder.startedAt}) — not starting a second one`;
    console.warn(`[run-dream] ${msg}`);
    appendFileSync(P.runs, JSON.stringify({ status: "skipped", startedAt, date: today, engine, reason: msg }) + "\n");
    return 3;
  }
  const run: LastRun = { status: "running", startedAt, date: today, engine };
  // A dry run only builds the input bundle; it must not replace the real night's status.
  const record = !FLAGS.has("--dry-run");
  if (record) writeJsonAtomic(P.lastRun, run);
  console.log(`[run-dream] ${startedAt} start (engine=${engine}, date=${today})`);
  try {
    refreshAggregate("before");
    if (engine === "claude") {
      await runClaudePipeline(cfg, run);
    } else {
      let doc;
      if (engine === "hermes") {
        const bin = hermesBin();
        if (!bin) throw new Error("hermes not installed");
        await runHermes(bin, cfg, run);
      } else if (engine === "codex") {
        const bin = codexBin();
        if (!bin) throw new Error("codex not installed");
        doc = await runCodex(bin, cfg, run);
      } else {
        doc = await runOpenRouter(cfg, run);
      }
      if (doc) writeFileSync(P.summary, `${today} ${summaryLine(doc)}\n`);
      run.status = "ok";
    }
  } catch (err) {
    run.status = "failed";
    run.error = (err instanceof Error ? err.message : String(err)).slice(0, 600);
    console.error(`[run-dream] FAILED (engine=${engine}): ${run.error}`);
    try {
      writeFileSync(P.summary, `${today} Dream FAILED: ${run.error.slice(0, 180)}\n`);
    } catch {
      /* ignore */
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    if (run.status === "skipped") {
      console.log(`[run-dream] skipped: ${run.reason}`);
      if (run.reason && !/dry run/.test(run.reason)) writeFileSync(P.summary, `${today} Dream skipped: ${run.reason}\n`);
    }
    if (record) {
      writeJsonAtomic(P.lastRun, run);
      appendFileSync(P.runs, JSON.stringify(run) + "\n");
    }
    releaseLock(P.lock);
    pruneOldInputs();
  }
  refreshAggregate("after");
  console.log(`[run-dream] ${run.finishedAt} ${run.status}`);
  return run.status === "failed" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[run-dream] crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  },
);
