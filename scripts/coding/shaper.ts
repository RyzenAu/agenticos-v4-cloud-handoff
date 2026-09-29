import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JevAnswers, JevOutcome } from "../jev-client";
import { pickCodexSlot, slotReadings, type AccountsConfig } from "./accounts";
import type {
  AgentBinding,
  CommandId,
  DoneCriterion,
  IsoTime,
  JevDecision,
  JevShapingRecord,
  OwnershipSpec,
  RepoRegistry,
  RepoRegistryEntry,
  RoleTemplate,
  TaskSpec,
  TaskSpecValidation,
  Uuid,
  VerifiedPrincipal,
} from "./contracts";
import { redactText } from "./redact";
import { codingMoneyRefusal } from "../jarvis-execution/spoken-money";
import { reposFor } from "./registry";
import { claudeBinding, codexBinding, draftSpec, routerBinding, slugOf } from "./spec";
import { isSiteRequest, siteObjective } from "../../src/lib/site-maker";
import { siteDraftPlan } from "./site-plan";

/**
 * The shaper (CODING-HARNESS §3.2, task C4): a spoken or typed request → a bounded, UNCONFIRMED TaskSpec,
 * or ONE clarifying question.
 *
 *  - Jev (TypeSafe, through the one Jev client) makes the typed choices it is good at: which repo, which
 *    team shape, whether the request is complete, whether it asks for anything consequential. Policy:
 *    act ≥ 0.6 with a 0.2 margin, look again 0.4–0.6, ask < 0.4 (REVIEW-JEV).
 *  - Words the owner actually said win over Jev ("Opus builds, Codex reviews" is explicit). With no Jev
 *    key, a slow answer or an error, deterministic rules decide and ambiguity is ASKED, never guessed.
 *  - The planner (a read-only Claude session in plan mode, planner.ts) drafts the objective, done-when,
 *    owned files and checks; without it, a deterministic plan is used only when the request names files.
 *  - Consequential words (merge, deploy, push) never become role instructions: they are offered as
 *    approval points after the job completes.
 */

export type JevFn = (call: { state: unknown; questions: Record<string, unknown> }) => Promise<JevOutcome | null>;

export type PlannerDraft = {
  objective: string;
  nonGoals: string[];
  doneWhen: DoneCriterion[];
  builders: { owns: OwnershipSpec; instructions?: string }[];
  testAuthorOwns?: OwnershipSpec | null;
  checks: CommandId[];
  plannerSession?: { binding: AgentBinding; sessionId: string } | null;
};
export type PlannerFn = (input: { entry: RepoRegistryEntry; objective: string; utterance: string; specId: Uuid }) => Promise<PlannerDraft | { question: string }>;

export type ShaperDeps = {
  registry: () => RepoRegistry;
  accounts: () => AccountsConfig;
  jev?: JevFn | null;
  planner?: PlannerFn | null;
  cliVersions: () => { claude: string; codex: string };
  now?: () => Date;
};

export type ShapeResult =
  | { kind: "ask"; draftId: Uuid; question: string; options?: string[] }
  | { kind: "draft"; spec: TaskSpec; spokenSummary: string }
  | { kind: "refused"; reason: string };

type Pending = {
  draftId: Uuid;
  principal: VerifiedPrincipal;
  /** R3: the Claude planner runs only for a person (it spends the Max allowance); programs get the heuristic plan. */
  usePlanner: boolean;
  channel: "voice" | "typed" | "ui";
  utterance: string;
  repoId: string | null;
  objective: string | null;
  asked: "repo" | "objective" | "planner" | null;
  options: string[];
  clarifications: { question: string; answer: string; at: IsoTime }[];
  decisions: JevDecision[];
  jevModel: string;
  jevMs: number;
  at: number;
};

const TTL = 10 * 60_000;

// ─────────────────────────── words ───────────────────────────

const MODEL_WORDS: Array<{ re: RegExp; binding: (d: ShaperDeps, preferredSlot?: string) => AgentBinding }> = [
  { re: /\bopus\b/i, binding: (d) => claudeBinding("claude-opus-5-5", d.cliVersions().claude) },
  { re: /\bsonnet\b/i, binding: (d) => claudeBinding("claude-sonnet-5", d.cliVersions().claude) },
  { re: /\bfable\b/i, binding: (d) => claudeBinding("claude-fable-5-1", d.cliVersions().claude) },
  { re: /\bhaiku\b/i, binding: (d) => claudeBinding("claude-haiku-4-5", d.cliVersions().claude) },
  { re: /\bclaude\b/i, binding: (d) => claudeBinding("claude-opus-5-5", d.cliVersions().claude) },
  { re: /\bhermes\b|\bgpt[- ]?6[- ]?sol\b/i, binding: () => routerBinding("codex/gpt-6-sol") },
  { re: /\bdeep ?seek\b/i, binding: () => routerBinding("cline/deepseek-v4.1-flash") },
  { re: /\bmimo\b/i, binding: () => routerBinding("cline/mimo-v2.6-flash") },
  { re: /\bmuse\b/i, binding: () => routerBinding("cline/muse-spark-1.3") },
  { re: /\bcline\b/i, binding: () => routerBinding("cline/deepseek-v4.1-flash") },
  { re: /\bcodex\b|\bgpt[- ]?6[- ]?astra\b|\bastra\b/i, binding: (d) => codexFor(d) },
];

function codexFor(d: ShaperDeps): AgentBinding {
  // Owner decision 1: a NEW job goes to the least-used connected account below the limit.
  const choice = pickCodexSlot(d.accounts(), slotReadings());
  const slot = choice.ok ? choice.slot.slot : d.accounts().codex[0]?.slot ?? "codex:openai-2";
  return codexBinding("gpt-6-astra", slot, d.cliVersions().codex);
}

/** "<model> builds", "have <model> build", "<model> for the build". */
function roleModel(text: string, role: "build" | "review" | "test", d: ShaperDeps): AgentBinding | null {
  const verb = role === "build" ? "(?:build|builds|building|builder|implement|implements|write|writes|fix|fixes)" : role === "review" ? "(?:review|reviews|reviewing|reviewer|check|checks)" : "(?:test|tests|tester|test-author|writes? the tests)";
  for (const m of MODEL_WORDS) {
    const name = m.re.source;
    const near = new RegExp(`(?:${name})[^.,;]{0,24}?\\b${verb}\\b|\\b${verb}\\b[^.,;]{0,24}?(?:with|using|by|on|to)\\s+(?:an?\\s+|another\\s+|the\\s+)?(?:${name})|use\\s+(?:an?\\s+|another\\s+)?(?:${name})\\s+(?:for|as)\\s+(?:the\\s+)?${verb}`, "i");
    if (near.test(text)) return m.binding(d);
  }
  return null;
}

export function templateFrom(text: string): RoleTemplate {
  if (/\b(?:just|only)\s+review\b|\breview[- ]only\b|\breview (?:the|my) (?:branch|code|changes)\b/i.test(text)) return "review-only";
  if (/\b(?:add|with) a tester\b|\btest[- ]author\b|\bwrite (?:the )?tests\b/i.test(text)) return "build+review+test-author";
  if (/\bno review\b|\bbuild[- ]only\b/i.test(text)) return "build-only";
  if (/\binvestigate\b|\blook into\b|\bfind out why\b/i.test(text)) return "investigate";
  return "build+review";
}

const AGENT_WORD = "(?:opus|sonnet|fable|haiku|codex|claude|hermes|deep ?seek|mimo|muse|cline|astra)";
/** A sentence that starts with the task itself ("Fix the Claude reviewer badge…"), not with who does it. */
const TASK_SENTENCE = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:fix|make|change|update|add|remove|delete|rename|set|move|refactor|rewrite|create|implement|improve|investigate|look into|find out|debug|repair|replace|hide|show|style|colou?r|clean up|tidy|speed up|stop|ensure|align|centre|center|correct|swap|convert|build (?:a|an|the)\b)/i;
/** One clause that only says who does which role ("Opus builds", "another Opus reviews it", "use Sonnet for the build"). */
const TEAM_CLAUSE = new RegExp(
  `^(?:(?:and|then|with|while|but|have|get|plus)\\s+)*(?:(?:(?:another|a second|an?|the)\\s+)?${AGENT_WORD}(?:\\s+(?:agent|model|session))?\\s+(?:(?:should|will|can|must|to)\\s+)?(?:builds?|building|reviews?|reviewing|tests?|as (?:the )?(?:builder|reviewer|tester))|use\\s+(?:(?:another|an?)\\s+)?${AGENT_WORD}\\s+(?:for|as)\\s+(?:the\\s+)?(?:build|builder|review|reviewer|tests?|tester))(?:\\s+(?:it|this|that|them|the (?:build|code|changes?|work|diff)|after(?:wards)?|too|as well))*[.!]?$`,
  "i",
);

/** A task verb with a real object next ("fix the login bug", not "build it" or "review the code"). */
const TASK_AHEAD =
  "(?:fix|make|change|update|add|remove|delete|rename|set|move|refactor|rewrite|create|implement|improve|investigate|look into|find out|debug|repair|replace|hide|show|style|colou?r|clean up|tidy|speed up|stop|ensure|align|centre|center|correct|swap|convert|build|write)\\s+(?!(?:it|this|that|them|the (?:build|code|changes?|work|diff))\\b)[a-z0-9'\"]";
/**
 * An agent-first lead-in at the start of a sentence (REVIEW-T1 P1 follow-up): "Codex, fix X", "ask Codex to
 * fix X", "assign Codex to build X", "have Opus build X", "use Codex as the builder to add X". Stripped, so the
 * task clause that follows is the objective.
 */
const LEAD_IN = new RegExp(
  `(^|[.!?]\\s+)(?:please\\s+)?(?:${AGENT_WORD}\\s*[,:]\\s*|(?:ask|tell|assign|get|have|let|use|using)\\s+(?:(?:another|an?|the)\\s+)?${AGENT_WORD}(?:\\s+(?:agent|model|session))?\\s+(?:(?:as|for)\\s+(?:the\\s+)?(?:builder|build)\\s+)?(?:to\\s+)?)(?=${TASK_AHEAD})`,
  "gi",
);
/** "Claude builds and reviews the fix for X" / "Codex fixes the login bug": the agent is the subject; keep the verb and the task. */
const AGENT_DOES = new RegExp(
  `(^|[.!?]\\s+)(?:please\\s+)?${AGENT_WORD}\\s+(build|fix|implement|add|write)(?:es|s)?(?:\\s+and\\s+reviews?)?\\s+(?!(?:it|this|that|them)\\b)(?=[a-z])`,
  "gi",
);

/**
 * The request with the team/model/show-me phrasing stripped: what's left is the objective.
 * Agent-first lead-ins ("Codex, fix X…", "ask Codex to fix X and Claude to review") are stripped first.
 * A sentence about who builds/reviews is dropped whole; but a sentence that starts with the task keeps it,
 * even when the task names an agent or a role ("Fix the Claude reviewer badge colour", REVIEW-T3 R5), and
 * only its team clauses ("…, Opus builds, Codex reviews") are dropped.
 */
/**
 * "start a coding job to fix X", "kick off a coding task for X", "open a new coding job: X" (F1): the words that
 * only say a job is wanted. Stripped, so what follows is the objective.
 */
const JOB_LEAD = /^\s*(?:please\s+)?(?:start|begin|kick off|create|open|set up|run|spin up|queue|make)\s+(?:me\s+)?(?:a|an|the|another)?\s*(?:new\s+)?coding\s+(?:job|task|run)\s*(?:to|for|that|which|so (?:that )?it|:|,|-)?\s*/i;
export const startsCodingJob = (text: string) => JOB_LEAD.test(text.replace(/^\s*(?:hey\s+)?jarvis[,\s]+/i, ""));

export function objectiveFrom(text: string): string {
  return text
    .replace(/^\s*(?:hey\s+)?jarvis[,\s]+/i, "")
    .replace(JOB_LEAD, "")
    .replace(LEAD_IN, "$1")
    .replace(AGENT_DOES, (_m, lead: string, verb: string) => `${lead}${verb.toLowerCase()} `)
    // A sentence ends at a full stop followed by a space (or the end), so "src/a.ts" doesn't split one.
    .replace(/(?:[^.]|\.(?=\S))*\b(?:builds?|reviews?|reviewer|builder|tester)\b(?:[^.]|\.(?=\S))*\.?/gi, (s) => {
      if (!/\b(?:opus|sonnet|codex|claude|hermes|deepseek|mimo|muse|cline|another|agent)\b/i.test(s)) return s;
      if (!TASK_SENTENCE.test(s)) return "";
      const parts = s.split(/(\s*[,;]\s*|\s+and\s+)/i);
      const kept: string[] = [parts[0]];
      for (let i = 1; i < parts.length; i += 2) if (!TEAM_CLAUSE.test(parts[i + 1].trim())) kept.push(parts[i], parts[i + 1]);
      const end = /\.\s*$/.test(s) && !/\.\s*$/.test(kept[kept.length - 1]) ? "." : "";
      return kept.join("") + end;
    })
    .replace(/\bshow me (?:the )?(?:tests?|what changed|changes|diff)(?: and (?:the )?(?:tests?|what changed|changes|diff))?\.?/gi, "")
    .replace(/\b(?:and )?(?:then )?(?:merge|deploy|push) it\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim()
    .replace(/[.,;]+$/, "");
}

/** An objective with a verb and a concrete target/symptom; "fix the dashboard" alone is not enough. */
export function objectiveComplete(objective: string): boolean {
  const words = objective.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (words.length >= 9) return true;
  // F1: a task verb, a specific thing and where it is ("fix the calls table in the receptionist app") is enough
  // to draft: the planner reads the repo and asks its own question if the change is still unclear.
  if (words.length >= 6 && /^(?:fix|change|update|add|remove|rename|refactor|rewrite|improve|debug|repair|replace|hide|show|style|clean up|speed up|correct|implement|build|create|make)\b/i.test(objective) && /\b(?:in|on|of|for)\s+(?:the\s+|our\s+|my\s+|a\s+)?[\w'-]+/i.test(objective)) return true;
  return /\b(?:so that|because|when|shows?|should|to\s+\w+|instead of|wrong|broken|missing|error|fails?|set|add|rename|remove|change|make)\b/i.test(objective) && words.length >= 5;
}

export const CONSEQUENTIAL_WORDS = /\b(?:merge|deploy|push|publish|release|ship it)\b/i;

function repoByWords(text: string, repos: readonly RepoRegistryEntry[]): { id: string; score: number }[] {
  const t = text.toLowerCase();
  return repos
    .map((r) => {
      // "muv" is every M&U repo's prefix, not a word that says which one (F1).
      const idWords = r.id.split("-").filter((w) => w.length > 2 && w !== "muv");
      let score = t.includes(r.id) ? 3 : 0;
      for (const w of idWords) if (new RegExp(`\\b${w}`, "i").test(t)) score += 1;
      for (const w of r.description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4)) if (t.includes(w)) score += 0.25;
      return { id: r.id, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ─────────────────────────── Jev ───────────────────────────

function jevPolicy(confidence: number, margin: number): JevDecision["policy"] {
  if (confidence >= 0.6 && margin >= 0.2) return "act";
  if (confidence >= 0.4) return "look-again";
  return "ask";
}

async function askJev(deps: ShaperDeps, text: string, repos: readonly RepoRegistryEntry[]): Promise<{ answers: JevAnswers | null; model: string; ms: number }> {
  if (!deps.jev) return { answers: null, model: "none", ms: 0 };
  const questions: Record<string, unknown> = {
    repo: { type: "choice", instructions: "Which code repository is this coding request about?", criteria: Object.fromEntries(repos.map((r) => [r.id, r.description])) },
    complete: { type: "score", instructions: "Does the request say concretely what should change or what is wrong (not just which area)?" },
    consequential: { type: "score", instructions: "Does the request ask to merge, push, deploy, publish or release anything?" },
  };
  try {
    const out = await deps.jev({ state: { request: redactText(text, 1000) }, questions });
    if (!out || !out.ok) return { answers: null, model: "jev-unavailable", ms: out?.ms ?? 0 };
    return { answers: out.answers, model: String((out.raw as { model?: string } | null)?.model ?? "jev-latest"), ms: out.ms };
  } catch { return { answers: null, model: "jev-error", ms: 0 }; }
}

// ─────────────────────────── the shaper ───────────────────────────

export function createShaper(deps: ShaperDeps) {
  const pending = new Map<string, Pending>();
  const now = () => (deps.now?.() ?? new Date());
  const sweep = () => { const t = Date.now(); for (const [k, p] of pending) if (t - p.at > TTL) pending.delete(k); };

  async function finish(p: Pending): Promise<ShapeResult> {
    const registry = deps.registry();
    const entry = registry.repos.find((r) => r.id === p.repoId);
    if (!entry) return { kind: "refused", reason: "That repo isn't in the coding registry." };
    const text = [p.utterance, ...p.clarifications.map((c) => c.answer)].join(". ");
    const template = templateFrom(p.utterance);
    const builder = roleModel(text, "build", deps) ?? claudeBinding("claude-opus-5-5", deps.cliVersions().claude);
    const reviewer = template === "build-only" ? null : roleModel(text, "review", deps) ?? claudeBinding("claude-opus-5-5", deps.cliVersions().claude);
    const tester = template === "build+review+test-author" ? roleModel(text, "test", deps) ?? codexFor(deps) : null;
    const site = isSiteRequest(p.utterance);
    const objective = p.objective ?? (site ? siteObjective(p.utterance) : objectiveFrom(p.utterance));
    const specId = randomUUID() as Uuid;
    let plan: PlannerDraft | { question: string } | null = null;
    // F1: a "make a site" request is drafted from its own known shape (the site's source folders, the repo's
    // build, the skills' brief): no planner call, no allowance spent. A repo with no site-shaped top level
    // falls through to the planner or a question, as any other request does.
    if (site) plan = siteDraftPlan(entry, p.utterance);
    if (plan) { /* the site plan */ }
    else if (deps.planner && p.usePlanner) {
      try { plan = await deps.planner({ entry, objective, utterance: text, specId }); }
      catch (e) { return { kind: "refused", reason: `The planner couldn't draft this: ${redactText((e as Error).message, 200)}` }; }
    } else plan = heuristicPlan(entry, objective, text);
    if (!plan) {
      p.asked = "planner";
      pending.set(p.draftId, { ...p, at: Date.now() });
      return { kind: "ask", draftId: p.draftId, question: "Which files should the builder change? Name the folder or files." };
    }
    if ("question" in plan) {
      p.asked = "planner";
      pending.set(p.draftId, { ...p, at: Date.now() });
      return { kind: "ask", draftId: p.draftId, question: plan.question };
    }
    const jev: JevShapingRecord | null = p.decisions.length ? { model: p.jevModel, latencyMs: p.jevMs, decisions: p.decisions, clarifications: p.clarifications } : p.clarifications.length ? { model: "rules", latencyMs: 0, decisions: [], clarifications: p.clarifications } : null;
    const spec = draftSpec({
      id: specId,
      requestedBy: p.principal,
      channel: p.channel,
      utterance: p.utterance,
      entry,
      objective: plan.objective || objective,
      nonGoals: plan.nonGoals,
      doneWhen: plan.doneWhen,
      roleTemplate: template === "investigate" || template === "review-only" ? "build+review" : template,
      builders: plan.builders.map((b) => ({ binding: builder, owns: b.owns, instructions: b.instructions })),
      testAuthor: tester && plan.testAuthorOwns ? { binding: tester, owns: plan.testAuthorOwns } : null,
      reviewer: reviewer ? { binding: reviewer } : null,
      checks: plan.checks,
      approvalPoints: CONSEQUENTIAL_WORDS.test(p.utterance) ? [{ action: "git.merge.protected", describe: `merge into ${entry.defaultBaseRef} of ${entry.id} (asked after completion)`, when: "after-completion" }] : [],
      jev,
      planner: plan.plannerSession ?? null,
      now: deps.now,
    });
    pending.delete(p.draftId);
    return { kind: "draft", spec, spokenSummary: spokenSummary(spec) };
  }

  /** A request, or the answer to the question just asked. */
  async function shape(input: { utterance: string; channel: "voice" | "typed" | "ui"; principal: VerifiedPrincipal; draftId?: string; answer?: string; usePlanner?: boolean }): Promise<ShapeResult> {
    sweep();
    const registry = deps.registry();
    const repos = reposFor(registry, input.principal.personId);
    if (!repos.length) return { kind: "refused", reason: "No code repositories are set up for coding jobs yet (.operator-data/coding/repos.json)." };
    if (input.draftId) {
      const p = pending.get(input.draftId);
      if (!p || p.principal.personId !== input.principal.personId) return { kind: "refused", reason: "That draft expired; say the request again." };
      const answer = redactText(String(input.answer ?? input.utterance ?? ""), 600).trim();
      // A money order is never turned into a coding job, whatever lane sent it (REVIEW S2d-2).
      const moneyAnswer = codingMoneyRefusal(`${p.utterance}. ${answer}`);
      if (moneyAnswer) return { kind: "refused", reason: moneyAnswer };
      if (!answer) return { kind: "ask", draftId: p.draftId, question: "I didn't catch that. " + (p.asked === "repo" ? `Which repo: ${p.options.join(" or ")}?` : "What should change?") };
      p.clarifications.push({ question: p.asked ?? "", answer, at: now().toISOString() as IsoTime });
      if (p.asked === "repo") {
        const pick = repoByWords(answer, repos.filter((r) => p.options.includes(r.id)))[0] ?? (/\b(?:first|former)\b/i.test(answer) ? { id: p.options[0] } : /\b(?:second|latter|other)\b/i.test(answer) ? { id: p.options[1] } : null)
          ?? (/client|app|dashboard/i.test(answer) ? repoByWords(answer + " client app", repos.filter((r) => p.options.includes(r.id)))[0] : null);
        if (!pick) return { kind: "ask", draftId: p.draftId, question: `Sorry, which one: ${p.options.join(" or ")}?`, options: p.options };
        p.repoId = pick.id;
      } else if (p.asked === "objective") {
        p.objective = `${objectiveFrom(p.utterance)}: ${answer}`.replace(/^:\s*/, "");
      } else if (p.asked === "planner") {
        p.utterance = `${p.utterance}${/[.!?]$/.test(p.utterance) ? "" : "."} Files: ${answer}`;
      }
      p.asked = null;
      return next(p, repos);
    }
    const utterance = redactText(String(input.utterance ?? ""), 2000).trim();
    if (!utterance) return { kind: "refused", reason: "Say what the coding job should do." };
    // A money order is never turned into a coding job: voice, typed, the brain's delegate_task / run_workflow
    // and the Coding page all come through here (REVIEW S2d-2).
    const money = codingMoneyRefusal(utterance);
    if (money) return { kind: "refused", reason: money };
    const p: Pending = { draftId: randomUUID() as Uuid, principal: input.principal, usePlanner: input.usePlanner !== false, channel: input.channel, utterance, repoId: null, objective: null, asked: null, options: [], clarifications: [], decisions: [], jevModel: "none", jevMs: 0, at: Date.now() };
    // F1: a site request already says what to build; its first sentence is the objective, so nothing is asked.
    if (isSiteRequest(utterance)) p.objective = siteObjective(utterance);
    // A repo that exists but isn't registered is said plainly, not guessed between two other repos.
    const unregistered = unregisteredRepoMention(utterance, repos);
    if (unregistered) return { kind: "refused", reason: unregistered };
    const jev = await askJev(deps, utterance, repos);
    p.jevModel = jev.model;
    p.jevMs = jev.ms;
    // Repo: the owner's explicit words, else Jev, else ask.
    const byWords = repoByWords(utterance, repos);
    const probs = jev.answers?.repo?.probabilities ?? null;
    const jevTop = probs ? Object.entries(probs).sort((a, b) => b[1] - a[1]) : [];
    const margin = jevTop.length > 1 ? jevTop[0][1] - jevTop[1][1] : jevTop.length ? jevTop[0][1] : 0;
    if (jev.answers?.repo) p.decisions.push({ question: "repo", choice: jev.answers.repo.choice ?? null, confidence: jevTop[0]?.[1] ?? jev.answers.repo.confidence ?? 0, probabilities: probs ?? undefined, policy: jevPolicy(jevTop[0]?.[1] ?? 0, margin) });
    const complete = jev.answers?.complete?.score;
    if (typeof complete === "number") p.decisions.push({ question: "complete", choice: null, confidence: complete, policy: complete >= 0.6 ? "act" : complete >= 0.4 ? "look-again" : "ask" });
    const consequential = jev.answers?.consequential?.score;
    if (typeof consequential === "number") p.decisions.push({ question: "consequential", choice: null, confidence: consequential, policy: consequential >= 0.6 ? "act" : "look-again" });
    if (repos.length === 1) p.repoId = repos[0].id;
    else if (byWords.length && (byWords.length === 1 || byWords[0].score - byWords[1].score >= 1)) p.repoId = byWords[0].id;
    else if (jevTop.length && jevPolicy(jevTop[0][1], margin) === "act" && repos.some((r) => r.id === jevTop[0][0])) p.repoId = jevTop[0][0];
    else {
      const options = (jevTop.length ? jevTop.map(([id]) => id) : byWords.length ? byWords.map((b) => b.id) : repos.map((r) => r.id)).filter((id) => repos.some((r) => r.id === id)).slice(0, 2);
      if (options.length < 2) options.push(...repos.map((r) => r.id).filter((id) => !options.includes(id)).slice(0, 2 - options.length));
      p.options = options;
      p.asked = "repo";
      pending.set(p.draftId, p);
      const describe = (id: string) => { const r = repos.find((x) => x.id === id)!; return `${id} (${r.description.split(/[:;]/)[0]})`; };
      return { kind: "ask", draftId: p.draftId, question: `Which one: ${describe(options[0])}, or ${describe(options[1])}?`, options };
    }
    return next(p, repos);
  }

  async function next(p: Pending, repos: readonly RepoRegistryEntry[]): Promise<ShapeResult> {
    if (!p.repoId) return { kind: "ask", draftId: p.draftId, question: `Which repo: ${repos.slice(0, 2).map((r) => r.id).join(" or ")}?`, options: repos.slice(0, 2).map((r) => r.id) };
    const objective = p.objective ?? objectiveFrom(p.utterance);
    const jevComplete = p.decisions.find((d) => d.question === "complete");
    const complete = objectiveComplete(objective) && !(jevComplete && jevComplete.confidence < 0.4 && objective.split(/\s+/).length < 9);
    if (!complete && !p.objective) {
      p.asked = "objective";
      pending.set(p.draftId, { ...p, at: Date.now() });
      return { kind: "ask", draftId: p.draftId, question: `What should change in ${p.repoId}? Tell me what's wrong or what it should do.` };
    }
    return finish(p);
  }

  return { shape, pending: () => pending.size };
}

/**
 * Repos the owner talks about that the registry may not hold yet. The receptionist app lives on D:, outside the
 * five site repos the defaults seed, and its base branch and test command are the owner's to set.
 */
export function unregisteredRepoMention(text: string, repos: readonly RepoRegistryEntry[]): string | null {
  if (repos.some((r) => /receptionist/i.test(r.id))) return null;
  if (/\bmu-receptionist\b/i.test(text) || /\b(?:mu[- ]?)?receptionist (?:app|repo|repository|project|codebase|dashboard)\b/i.test(text))
    return "The receptionist app isn't in the coding registry yet, so I can't draft that. Add mu-receptionist to .operator-data/coding/repos.json (its base branch and check commands) and ask again.";
  return null;
}

/** A plan from the request's own words: only when it names files (else the planner or a question decides). */
export function heuristicPlan(entry: RepoRegistryEntry, objective: string, text: string): PlannerDraft | null {
  const files = [...new Set([...text.matchAll(/\b((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|css|html|txt|sql|prisma|yml|yaml))\b/g)].map((m) => m[1]))];
  const dirs = [...new Set([...text.matchAll(/\b((?:[\w.-]+\/)+)(?:\*\*)?(?=[\s,.]|$)/g)].map((m) => `${m[1]}**`))];
  if (!files.length && !dirs.length) return null;
  const tests = entry.commands.filter((c) => c.kind === "test").map((c) => c.id);
  const typecheck = entry.commands.filter((c) => c.kind === "typecheck").map((c) => c.id);
  const checks = [...tests.slice(0, 1), ...typecheck.slice(0, 1)] as CommandId[];
  return {
    objective,
    nonGoals: ["No changes outside the owned files", "No dependency changes"],
    doneWhen: [
      ...checks.map((id, i) => ({ id: `c${i + 1}`, text: `${id} passes at the integrated commit`, evidence: (entry.commands.find((c) => c.id === id)?.kind === "typecheck" ? "typecheck" : "test") as DoneCriterion["evidence"], ref: id })),
      { id: `c${checks.length + 1}`, text: objective, evidence: "reviewer-confirms" as const },
    ],
    // Named files that exist are owned; named files that don't exist yet are declared new files.
    builders: [{ owns: { globs: [...dirs, ...files.filter((f) => existsSync(join(entry.canonicalPath, f)))], newFiles: files.filter((f) => !existsSync(join(entry.canonicalPath, f))) } }],
    checks,
  };
}

const MODEL_NAME: Record<string, string> = {
  "claude-opus-5-5": "Opus", "claude-sonnet-5": "Sonnet", "claude-fable-5-1": "Fable", "claude-haiku-4-5": "Haiku",
  "gpt-6-astra": "Codex", "codex/gpt-6-sol": "Hermes (GPT-6 Sol)", "openrouter/deepseek-v4-pro": "DeepSeek", "openrouter/mimo-v2.6-pro": "MiMo", "cline/deepseek-v4.1-flash": "Cline DeepSeek", "cline/mimo-v2.6-flash": "Cline MiMo", "cline/muse-spark-1.3": "Cline Muse",
};
export const modelName = (b: AgentBinding | null) => (b ? MODEL_NAME[b.model] ?? b.model : "nobody");

/** What Jarvis says after "Draft ready: <title>." A whole-utterance "start" answers it (voice.ts). */
export const START_PROMPT = "Say start when you want it built.";
/** The question the last spoken line ended on: the older "Start it?" or the current prompt. */
export const STARTS_WITH_PROMPT = /(?:\bStart it\?|Say start when you want it built\.)\s*$/i;

/**
 * A short title for a job from its objective: "Fix the calls table in the receptionist app". The site maker's
 * "(CRM lead #12, …)" aside and its ", in the X repo, starting from …" tail are dropped; the repo and team are
 * on the Coding page. At most about 90 characters, cut at a word.
 */
export function draftTitle(spec: Pick<TaskSpec, "objective" | "repo">): string {
  let t = spec.objective
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/,?\s+(?:in|on) the [a-z0-9-]+ repo\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\s]+$/, "");
  if (t.length > 90) t = t.slice(0, 90).replace(/\s+\S*$/, "").replace(/[.:;,\s]+$/, "") + "…";
  t = t || "coding job";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "Draft ready: Fix the calls table in the receptionist app. Say start when you want it built." */
export function spokenSummary(spec: TaskSpec): string {
  const roles = spec.roles ?? [];
  const routes = roles.filter((r) => r.agent).map((r) => `${r.roleId}: ${r.agent!.model}${r.agent!.model.startsWith("cline/") ? " (free only)" : r.agent!.route === "model-router" ? " (automatic fallback may use metered models)" : ""}`);
  const snapshot = spec.repo?.baseSha ? `Source snapshot: ${spec.repo.baseRef} at ${spec.repo.baseSha.slice(0, 12)}; uncommitted checkout changes are excluded. ` : "";
  return "Draft ready: " + draftTitle(spec) + ". " + snapshot + (routes.length ? `Selected routes: ${routes.join("; ")}. ` : "") + START_PROMPT;
}

export { slugOf };
