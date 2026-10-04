// Pure helpers for the overnight Dream (scripts/run-dream.ts): the Sydney date, the run lock,
// the per-night Claude budget, the weekly-usage gate, output validation and the morning report.
// No I/O beyond the lock and status files, so everything here is unit-tested.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { catalogueModel, catalogueTask, modelByProviderId } from "../model-router/catalogue";

export const DREAM_CATS = ["MEMORY", "COST", "SKILLS", "WORKFLOW"] as const;
export type DreamCat = (typeof DREAM_CATS)[number];
const TONE: Record<DreamCat, string> = { MEMORY: "pink", COST: "orange", SKILLS: "blue", WORKFLOW: "yellow" };

/** The operator's calendar date. The Dream runs at 1:30 am Sydney, which is still yesterday in
 *  UTC — `toISOString().slice(0, 10)` would stamp tonight's report with the wrong day. */
export function sydneyDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// ---- models (the model router's dream.nightly task) -----------------------------------------------

/** The router task every Dream model call runs under (scripts/model-router/catalogue.json). */
export const DREAM_TASK = "dream.nightly";
export type DreamEngine = "claude" | "hermes" | "codex" | "openrouter";
export const DREAM_ENGINES: readonly DreamEngine[] = ["claude", "hermes", "codex", "openrouter"];
/** The router provider each engine runs on. hermes and codex both run the Codex pool's model. */
export const ENGINE_PROVIDER: Record<DreamEngine, string> = { claude: "claude-sub", hermes: "codex", codex: "codex", openrouter: "openrouter" };

/** Catalogue ids the owner may choose for the Dream: dream.nightly's candidates, then its selectable models. */
export function dreamModels(): string[] {
  const task = catalogueTask(DREAM_TASK);
  if (!task) throw new Error(`The model catalogue has no ${DREAM_TASK} task.`);
  return [...task.candidates, ...(task.selectable ?? [])];
}

/**
 * A configured model name -> a dream.nightly catalogue id on `provider`, else null. Accepts the
 * catalogue id ("claude/opus-5-5", "openrouter/claude-fable-5") or the provider's own id
 * ("claude-opus-5-5", "anthropic/claude-fable-5", as the dashboard's picker saves it).
 */
export function dreamModelId(name: unknown, provider: string): string | null {
  if (typeof name !== "string" || !name.trim() || name.length > 80) return null;
  const n = name.trim();
  const ids = dreamModels();
  if (ids.includes(n)) return catalogueModel(n).provider === provider ? n : null;
  const m = modelByProviderId(provider, n);
  return m && ids.includes(m.id) ? m.id : null;
}

/** The first dream.nightly model on a provider (the default for that engine). */
export function dreamDefaultModel(provider: string): string {
  const id = dreamModels().find((m) => catalogueModel(m).provider === provider);
  if (!id) throw new Error(`${DREAM_TASK} has no ${provider} model in the catalogue.`);
  return id;
}

/** The OpenRouter model the Dream sends, as before E2: config.openRouterModel when it is a plausible
 *  id, else the catalogue's dream.nightly OpenRouter model. */
export const OPENROUTER_ID = /^[\w./:-]{1,80}$/;

export type DreamSelection = {
  selected: string;
  providers: string[];
  /** The provider id the engine actually sends or runs (null = the CLI's own default, unknown). */
  runs: string | null;
};

/**
 * The model each engine runs, exactly as before E2, as the router's `selected` catalogue id:
 * - claude: config.dream.model, else dream.nightly's first candidate (passed to claude -p --model).
 * - codex / hermes: nothing is passed to the CLI; the model is whatever its own config names
 *   (`cliModel`, read from ~/.codex/config.toml or Hermes' config.yaml). That model's catalogue id is
 *   selected (codex/gpt-6-astra, codex/gpt-6-sol); unknown -> the task's Codex model, runs null.
 * - openrouter: config.openRouterModel (any plausible id, as before) else the catalogue default. An id
 *   outside dream.nightly runs under the task's OpenRouter owner-choice entry when the catalogue has one.
 */
export function dreamSelection(engine: DreamEngine, cfg: any, cliModel: string | null = null): DreamSelection {
  const provider = ENGINE_PROVIDER[engine];
  if (engine === "claude") {
    const limits = dreamLimits(cfg);
    return { selected: limits.model, providers: [provider], runs: limits.cliModel ?? catalogueModel(limits.model).providerModel };
  }
  if (engine === "codex" || engine === "hermes") {
    const id = cliModel ? dreamModelId(cliModel, provider) : null;
    return { selected: id ?? dreamDefaultModel(provider), providers: [provider], runs: cliModel };
  }
  const saved = typeof cfg?.openRouterModel === "string" && OPENROUTER_ID.test(cfg.openRouterModel) ? cfg.openRouterModel : null;
  if (!saved) {
    const selected = dreamDefaultModel(provider);
    return { selected, providers: [provider], runs: catalogueModel(selected).providerModel };
  }
  const id = dreamModelId(saved, provider);
  if (id) return { selected: id, providers: [provider], runs: catalogueModel(id).providerModel };
  const family = dreamModels().find((m) => catalogueModel(m).provider === provider && catalogueModel(m).providerModel.includes("*"));
  if (family) return { selected: family, providers: [provider], runs: saved };
  throw new Error(`config openRouterModel "${saved}" has no ${DREAM_TASK} entry in the model catalogue (add an OpenRouter owner-choice model to the task, or choose one of ${dreamModels().filter((m) => catalogueModel(m).provider === provider).join(", ")})`);
}

// ---- limits ---------------------------------------------------------------------------------------

export type DreamLimits = {
  /** Claude calls per night (the main call plus at most one repair retry). */
  maxClaudeCalls: number;
  /** Input + output tokens per night across every call. */
  maxTokens: number;
  /** Skip the night when Claude's weekly (all models) usage is at or above this percentage. */
  weeklySkipPercent: number;
  /** Largest input bundle we will send, in characters (~4 chars a token). */
  maxInputChars: number;
  /** Catalogue id of the Claude model (a claude-sub dream.nightly model, or the owner-choice entry). */
  model: string;
  /** The saved config.dream.model passed to claude -p as-is when the catalogue has no entry for it
   *  (pre-E2: any /^[\w.-]{2,40}$/ value was passed straight through; REVIEW-E12 M4). */
  cliModel?: string | null;
  timeoutMs: number;
};

export const DEFAULT_LIMITS: DreamLimits = {
  maxClaudeCalls: 2,
  maxTokens: 250_000,
  weeklySkipPercent: 85,
  maxInputChars: 160_000,
  model: dreamDefaultModel("claude-sub"),
  timeoutMs: 15 * 60_000,
};

const CLAUDE_OWNER_CHOICE = "claude/dream-owner-choice";
/** config.dream.model -> its catalogue id, or (any other plausible value, as before E2) the owner-choice
 *  entry plus the raw name for `claude -p --model`; nothing plausible -> the default. */
function claudeDreamModel(saved: unknown): Pick<DreamLimits, "model" | "cliModel"> {
  const id = typeof saved === "string" ? dreamModelId(saved, "claude-sub") : null;
  if (id) return { model: id, cliModel: null };
  if (typeof saved === "string" && /^[\w.-]{2,40}$/.test(saved) && dreamModels().includes(CLAUDE_OWNER_CHOICE)) return { model: CLAUDE_OWNER_CHOICE, cliModel: saved };
  return { model: DEFAULT_LIMITS.model, cliModel: null };
}

/** Merges `config.dream` over the defaults, ignoring anything out of a sane range. */
export function dreamLimits(cfg: any): DreamLimits {
  const d = cfg?.dream ?? {};
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
  return {
    maxClaudeCalls: num(d.maxClaudeCalls, 1, 5, DEFAULT_LIMITS.maxClaudeCalls),
    maxTokens: num(d.maxTokens, 10_000, 2_000_000, DEFAULT_LIMITS.maxTokens),
    weeklySkipPercent: num(d.weeklySkipPercent, 10, 100, DEFAULT_LIMITS.weeklySkipPercent),
    maxInputChars: num(d.maxInputChars, 10_000, 600_000, DEFAULT_LIMITS.maxInputChars),
    ...claudeDreamModel(d.model),
    timeoutMs: num(d.timeoutMs, 60_000, 60 * 60_000, DEFAULT_LIMITS.timeoutMs),
  };
}

export class DreamBudget {
  calls = 0;
  tokens = 0;
  constructor(private limits: Pick<DreamLimits, "maxClaudeCalls" | "maxTokens">) {}
  /** Whether one more call of roughly `estimatedTokens` fits tonight's cap. */
  allows(estimatedTokens: number): { ok: boolean; reason?: string } {
    if (this.calls >= this.limits.maxClaudeCalls)
      return { ok: false, reason: `nightly cap reached (${this.calls}/${this.limits.maxClaudeCalls} Claude calls)` };
    if (this.tokens + estimatedTokens > this.limits.maxTokens)
      return { ok: false, reason: `nightly token cap: ${this.tokens} used + ~${estimatedTokens} needed > ${this.limits.maxTokens}` };
    return { ok: true };
  }
  record(tokens: number) {
    this.calls++;
    this.tokens += Math.max(0, Math.round(tokens));
  }
}

export const estimateTokens = (chars: number) => Math.ceil(chars / 3.5);

// ---- weekly usage gate ----------------------------------------------------------------------------

/** Claude's weekly (all models) usage from the AI usage snapshot (GET /__ai_usage), falling back
 *  to the aggregator's copy of the same OAuth reading in live-data.json. */
export function claudeWeeklyPercent(snapshot: any, liveData: any): { percent: number | null; source: string } {
  const subs: any[] = Array.isArray(snapshot?.subscriptions) ? snapshot.subscriptions : [];
  const claude = subs.find((s) => s?.provider === "anthropic" && s?.status?.ok);
  const win = claude?.status?.windows?.find((w: any) => /weekly/i.test(w?.label ?? "") && /all/i.test(w?.label ?? ""))
    ?? claude?.status?.windows?.find((w: any) => /weekly/i.test(w?.label ?? ""));
  if (typeof win?.usedPercent === "number") return { percent: win.usedPercent, source: "AI usage snapshot" };
  const util = liveData?.usage?.claudeWindow?.authoritative?.seven_day?.utilization;
  if (typeof util === "number") return { percent: util, source: "live-data.json (Claude OAuth usage)" };
  return { percent: null, source: "unavailable" };
}

export function usageGate(percent: number | null, threshold: number): { skip: boolean; reason: string } {
  if (percent === null) return { skip: false, reason: "weekly usage unknown — running with the nightly cap only" };
  if (percent >= threshold) return { skip: true, reason: `Claude weekly usage is ${percent}% (skip threshold ${threshold}%)` };
  return { skip: false, reason: `Claude weekly usage ${percent}% < ${threshold}%` };
}

// ---- lock -----------------------------------------------------------------------------------------

export type LockInfo = { pid: number; startedAt: string };
const LOCK_STALE_MS = 3 * 3_600_000;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** Exclusive-create lock. A lock whose process is gone, or which is older than 3 hours, is stale
 *  and taken over, so a crashed run can never block the next night. */
export function acquireLock(file: string, now = Date.now(), alive = pidAlive): { ok: true } | { ok: false; holder: LockInfo } {
  mkdirSync(dirname(file), { recursive: true });
  const mine: LockInfo = { pid: process.pid, startedAt: new Date(now).toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
      return { ok: true };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let holder: LockInfo | null = null;
      try {
        holder = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        /* torn/empty lock file: treat as stale */
      }
      const stale = !holder || !alive(holder.pid) || now - Date.parse(holder.startedAt) > LOCK_STALE_MS;
      if (!stale) return { ok: false, holder: holder! };
      rmSync(file, { force: true });
    }
  }
  return { ok: false, holder: { pid: -1, startedAt: "unknown" } };
}

export function releaseLock(file: string) {
  try {
    const holder = JSON.parse(readFileSync(file, "utf-8"));
    if (holder?.pid === process.pid) rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

// ---- status ---------------------------------------------------------------------------------------

export type RunStatus = "running" | "ok" | "failed" | "skipped";
export type LastRun = {
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  date: string;
  engine: string;
  model?: string;
  error?: string;
  reason?: string;
  claudeCalls?: number;
  tokens?: number;
  weeklyPercent?: number | null;
  chores?: Record<string, unknown>;
  checks?: Record<string, unknown>;
};

export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJson<T = any>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as T) : null;
  } catch {
    return null;
  }
}

// ---- output validation ----------------------------------------------------------------------------

export function parseModelJson(raw: string): any {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first > 0 || (last >= 0 && last < s.length - 1)) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  (Array.isArray(v) ? v : []).map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
const slug = (v: unknown, fallback: string) => {
  const s = str(v, 80).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || fallback;
};
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

export type Proposal = {
  id: string;
  kind: "code" | "process";
  title: string;
  why: string;
  brief: string;
  acceptance: string[];
  effort: "S" | "M" | "L";
  risk: "low" | "medium" | "high";
};

export type MorningReport = {
  summaryLine: string;
  improved: string[];
  broke: string[];
  topActions: { title: string; why: string; command?: string }[];
  salesCoaching: string;
  clientDeadlines: { client: string; item: string; due: string }[];
};

/** A candidate for a new Claude Code / CLI / Hermes / screen skill, mined from 30 days of activity
 *  by scripts/dream/skill-miner.ts. Proposals only — the Dream never creates or installs a skill;
 *  the owner says "build skill candidate N" to approve one (see skills/dream/SKILL.md). */
export type SkillCandidate = {
  id: string;
  name: string;
  evidence: string[];
  steps: string[];
  route: "skill" | "cli" | "hermes" | "screen";
  effort: "S" | "M" | "L";
  jevFit: { fits: boolean; decision: string };
};

export type DreamDoc = {
  date: string;
  model: string;
  generatedAt: string;
  engine: string;
  prescriptions: any[];
  report: MorningReport;
  proposals: Proposal[];
  skillCandidates: SkillCandidate[];
  metadata?: Record<string, unknown>;
};

/** Normalises the model's JSON into the shape the dashboard renders. Throws when there is
 *  nothing usable, so a malformed night is a failed run rather than an empty "success". */
export function normaliseDream(raw: any, meta: { date: string; model: string; engine: string; now?: Date }): DreamDoc {
  if (!raw || typeof raw !== "object") throw new Error("Dream output was not a JSON object");
  const prescriptions = (Array.isArray(raw.prescriptions) ? raw.prescriptions : []).slice(0, 4).map((p: any, i: number) => {
    const cat: DreamCat = DREAM_CATS.includes(String(p?.cat).toUpperCase() as DreamCat) ? (String(p.cat).toUpperCase() as DreamCat) : "WORKFLOW";
    return {
      id: slug(p?.id, `dream-item-${i + 1}`),
      cat,
      tone: TONE[cat],
      headline: str(p?.headline, 160),
      prescription: str(p?.prescription, 1200),
      evidence: strList(p?.evidence, 3, 240),
      command: str(p?.command, 400),
      dollarImpact: numOrNull(p?.dollarImpact),
      timeImpactMins: numOrNull(p?.timeImpactMins),
    };
  }).filter((p: any) => p.headline && p.prescription);

  const r = raw.report ?? {};
  const report: MorningReport = {
    summaryLine: str(r.summaryLine, 200),
    improved: strList(r.improved, 6, 300),
    broke: strList(r.broke, 6, 300),
    topActions: (Array.isArray(r.topActions) ? r.topActions : []).slice(0, 3).map((a: any) => ({
      title: str(typeof a === "string" ? a : a?.title, 200),
      why: str(a?.why, 400),
      ...(str(a?.command, 300) ? { command: str(a?.command, 300) } : {}),
    })).filter((a: any) => a.title),
    salesCoaching: str(r.salesCoaching, 800),
    clientDeadlines: (Array.isArray(r.clientDeadlines) ? r.clientDeadlines : []).slice(0, 8).map((c: any) => ({
      client: str(c?.client, 80),
      item: str(c?.item, 240),
      due: str(c?.due, 40),
    })).filter((c: any) => c.item),
  };

  const proposals: Proposal[] = (Array.isArray(raw.proposals) ? raw.proposals : []).slice(0, 6).map((p: any, i: number) => ({
    id: slug(p?.id, `proposal-${i + 1}`),
    kind: p?.kind === "code" ? "code" : "process",
    title: str(p?.title, 160),
    why: str(p?.why, 600),
    brief: str(p?.brief, 4000),
    acceptance: strList(p?.acceptance, 6, 300),
    effort: ["S", "M", "L"].includes(p?.effort) ? p.effort : "M",
    risk: ["low", "medium", "high"].includes(p?.risk) ? p.risk : "medium",
  })).filter((p: Proposal) => p.title && p.brief);

  const skillCandidates: SkillCandidate[] = (Array.isArray(raw.skillCandidates) ? raw.skillCandidates : []).slice(0, 5).map((c: any, i: number) => ({
    id: slug(c?.id, `skill-candidate-${i + 1}`),
    name: str(c?.name, 120),
    evidence: strList(c?.evidence, 5, 240),
    steps: strList(c?.steps, 10, 240),
    route: (["skill", "cli", "hermes", "screen"].includes(c?.route) ? c.route : "skill") as SkillCandidate["route"],
    effort: (["S", "M", "L"].includes(c?.effort) ? c.effort : "M") as SkillCandidate["effort"],
    jevFit: { fits: c?.jevFit?.fits === true, decision: str(c?.jevFit?.decision, 160) },
  })).filter((c: SkillCandidate) => c.name && c.evidence.length > 0);

  if (prescriptions.length === 0 && !report.summaryLine && report.topActions.length === 0)
    throw new Error("Dream output had no prescriptions and no morning report");
  if (!report.summaryLine)
    report.summaryLine = report.topActions[0]?.title ? `Top action: ${report.topActions[0].title}` : `${prescriptions.length} prescription(s)`;

  return {
    date: meta.date,
    model: meta.model,
    generatedAt: (meta.now ?? new Date()).toISOString(),
    engine: meta.engine,
    prescriptions,
    report,
    proposals,
    skillCandidates,
    ...(raw.metadata && typeof raw.metadata === "object" ? { metadata: raw.metadata } : {}),
  };
}

/** The ONE line the 7:30 am Telegram morning brief quotes. */
export function summaryLine(doc: Pick<DreamDoc, "report" | "proposals">): string {
  const top = doc.report.topActions[0]?.title;
  const base = doc.report.summaryLine || (top ? `Top action: ${top}` : "Dream ran");
  const extra = doc.proposals.length ? ` (${doc.proposals.length} proposal${doc.proposals.length === 1 ? "" : "s"} on the dashboard)` : "";
  return `${base}${extra}`.replace(/\s+/g, " ").slice(0, 240);
}

export function renderReportMarkdown(doc: DreamDoc, extras: { checks?: string; chores?: string } = {}): string {
  const out: string[] = [`# Dream morning report — ${doc.date}`, "", `> ${doc.report.summaryLine}`, ""];
  const list = (title: string, items: string[]) => {
    out.push(`## ${title}`, "", ...(items.length ? items.map((i) => `- ${i}`) : ["- Nothing to report."]), "");
  };
  list("What improved", doc.report.improved);
  list("What broke", doc.report.broke);
  out.push("## Three highest-leverage actions today", "");
  doc.report.topActions.forEach((a, i) => out.push(`${i + 1}. **${a.title}** — ${a.why}${a.command ? `  \n   \`${a.command}\`` : ""}`));
  if (!doc.report.topActions.length) out.push("- None.");
  out.push("", "## Sales coaching", "", doc.report.salesCoaching || "No scored calls in the window.", "");
  out.push("## Client deadlines", "");
  if (doc.report.clientDeadlines.length) for (const c of doc.report.clientDeadlines) out.push(`- **${c.client}** — ${c.item}${c.due ? ` (due ${c.due})` : ""}`);
  else out.push("- None found.");
  out.push("", "## Proposed improvements (not applied)", "");
  if (!doc.proposals.length) out.push("- None tonight.");
  for (const p of doc.proposals) {
    out.push(`### ${p.title}  \`${p.kind}\` · effort ${p.effort} · risk ${p.risk}`, "", p.why, "", "**Task brief**", "", p.brief, "");
    if (p.acceptance.length) out.push("**Done when**", "", ...p.acceptance.map((a) => `- ${a}`), "");
  }
  if (doc.prescriptions.length) {
    out.push("## Prescriptions", "");
    for (const p of doc.prescriptions) out.push(`- **[${p.cat}] ${p.headline}** — ${p.prescription}`);
    out.push("");
  }
  out.push("## Skill candidates (last 30 days)", "");
  if (!doc.skillCandidates.length) out.push("- Nothing repeated enough to be worth a skill yet.");
  for (const c of doc.skillCandidates) {
    out.push(`### ${c.name}  \`${c.route}\` · effort ${c.effort} · Jev fit: ${c.jevFit.fits ? `yes (${c.jevFit.decision})` : "no"}`, "");
    if (c.evidence.length) out.push("**Evidence**", "", ...c.evidence.map((e) => `- ${e}`), "");
    if (c.steps.length) out.push("**Proposed steps**", "", ...c.steps.map((s, i) => `${i + 1}. ${s}`), "");
  }
  if (doc.skillCandidates.length) out.push('_Proposals only — nothing is built automatically. Say "build skill candidate N" to approve one._', "");
  if (extras.checks) out.push("## Overnight checks", "", extras.checks, "");
  if (extras.chores) out.push("## Overnight chores", "", extras.chores, "");
  out.push(`_Generated ${doc.generatedAt} by ${doc.engine} (${doc.model}). Proposals are briefs only; nothing was changed, deployed or sent._`, "");
  return out.join("\n");
}

/** Carries the dream-state lifecycle forward (SKILL.md step 6); the model has no file tools. */
export function updateDreamState(state: any, ids: string[], nowIso: string) {
  const next = state && typeof state === "object" ? { ...state } : {};
  next.actions = { ...(next.actions ?? {}) };
  for (const id of ids) {
    const prev = next.actions[id];
    if (!prev) next.actions[id] = { status: "new", firstSeenAt: nowIso, lastSeenAt: nowIso };
    else next.actions[id] = { ...prev, status: prev.status === "new" ? "recurring" : prev.status, lastSeenAt: nowIso };
  }
  next.currentTop4 = ids.slice(0, 4);
  return next;
}

/** Which folder is the client's real build, for the overnight QA chore.
 *  1. a path CLIENT.md records ("client build: `…`", "build path: `…`", "preview build: `…`");
 *  2. the preview build Sol's generator writes (`brooke-draft/preview-build`, `preview-build`);
 *  3. `dist/`, but only when CLIENT.md doesn't call it an earlier/old concept.
 *  Bianca's `dist/` is the old concept with sample listings, so QA-ing it gives a false
 *  NOT READY (25 Sep 2026). Returns null when no build can be identified. */
export function clientBuildDir(hub: string, clientMd?: string): { dir: string; source: string } | null {
  const md = clientMd ?? (existsSync(join(hub, "CLIENT.md")) ? readFileSync(join(hub, "CLIENT.md"), "utf-8") : "");
  const recorded = /(?:client build|build path|build dir(?:ectory)?|preview build|live build|qa build)[^`\n]*`([^`\n]+)`/i.exec(md)?.[1];
  if (recorded) {
    const dir = /^[a-z]:[\\/]|^\//i.test(recorded) ? recorded : join(hub, recorded);
    if (existsSync(dir)) return { dir, source: "CLIENT.md" };
  }
  for (const rel of ["brooke-draft/preview-build", "preview-build"]) {
    const dir = join(hub, rel);
    if (existsSync(dir)) return { dir, source: rel };
  }
  const distIsOld = /`dist\/?`[^\n]*\b(earlier|old|previous|superseded|concept)\b/i.test(md);
  if (existsSync(join(hub, "dist")) && !distIsOld) return { dir: join(hub, "dist"), source: "dist" };
  return null;
}

export const dreamPaths = (stateDir: string) => {
  const dir = join(stateDir, "dreams");
  return {
    dir,
    lock: join(dir, "dream.lock"),
    lastRun: join(dir, "last-run.json"),
    runs: join(dir, "runs.jsonl"),
    summary: join(dir, "latest-summary.txt"),
    state: join(dir, "state.json"),
    dream: (date: string) => join(dir, `dream-${date}.json`),
    report: (date: string) => join(dir, `report-${date}.md`),
    inputs: (date: string) => join(dir, `inputs-${date}.json`),
    qa: join(dir, "qa"),
  };
};
