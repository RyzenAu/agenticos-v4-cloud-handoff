import { TypedPersistenceError, validCrmRecordReference, type CrmRecordReference } from "../conversations";
import type { CrmRef } from "../../src/lib/crm-ref";
import { randomUUID } from "node:crypto";
/**
 * The command service (Track 2): the ONE path typed and spoken Jarvis commands take on the server.
 *
 *   verified principal (B1) + his words (+ page context)
 *     → hard refusals in code (money, banks, secrets)               before anything, whatever the device
 *     → page context ("this margin", "that call")                    resolved, or Jev asks; never invented
 *     → deterministic delegates (memory, coding, receptionist)       the existing services, recorded
 *     → which device (resolveTarget from the VERIFIED person)        the hub is never a fallback for anyone else
 *     → a Job (B2) with targetDeviceId, then the executor:
 *          hub       the Jarvis entry (Jev decision → lane → executor → fresh check), steps mirrored live
 *          companion a typed ExecutorCall through the dispatcher; the companion re-checks and verifies
 *     → one concise line to speak; the full decision/step/verification log is the job's steps.
 *
 * Stop, cancel and interrupt go through the job service (jobs.cancel aborts the executor's signal, which
 * also cancels a companion command). A dropped stream keeps the job for RECONNECT_GRACE_MS so the client
 * can re-attach (`attach`); with nobody attached after that it is cancelled. A restart marks a running
 * job unknown and never re-runs it (JobService.recover).
 */
import { isStopCommand } from "../coding/stop-words";
import { isBrowserPrincipal, mayUseBots, type Principal } from "../identity/principal";
import { hubRole, type HubRole } from "../cloud/hub-role";
import { stopOutcome, type JobService, type ExecutorContext, type StopOutcome } from "../jobs/service";
import type { JevDecisionRef, JobKind, Step } from "../jobs/types";
import type { RunLog, RunRecord } from "../screen-hands/run-log";
import { stepFromRun } from "../jobs/mirror-run-log";
import { screenGoalRefusal } from "../screen-hands/refusals";
import { goalSlots } from "../screen-hands/jev-control";
import type { ResolveContext, ResolveResult } from "../devices/types";
import type { CommandInput, DispatchResult, ProgressStep } from "../devices/dispatch";
import type { CommandDone, CommandEvent, JarvisEntry } from "../jev-command";
import { marginAnswer, parseMarginQuery, shownContributionPct, shownFigures, sourceWords, speakFigure } from "../jev-margin";
import { parsePriceQuery, priceAnswer } from "./answers";
import { RECEPTIONIST_PACKAGES } from "../../src/lib/receptionist-packages";
import {
  COMPANION_EXECUTORS,
  isExecutorResult,
  RECONNECT_GRACE_MS,
  type CommandBody,
  type CommandDoneEvent,
  type CommandSource,
  type CommandStreamEvent,
  type ExecutorCall,
  type ExecutorName,
  type RemoteStep,
  MAX_REMOTE_STEPS,
  type JevDecision,
  type PageContext,
  type PageContextItem,
  type SpecialistId,
  type SurfaceThresholds,
} from "./contracts";
import { createContextMemory, resolveCommandContext } from "./context";
import { planContinuation } from "./continuation";
import { googleSearchUrl, leadActionIn, linkedSteps, orderedClauses, osPageIn, planRules, rememberToReminder, safeHost, searchQueryIn, siteIn, splitSpokenTarget, type LeadAction, type RulePlan } from "./plan";
import { thresholdsFor } from "./thresholds";
import { createRecentTargets, resolveSwitch, switchBackIn, targetFrom, type SwitchRef } from "./recent-targets";
import { codingDraftFor } from "./coding";
import { crmIntentIn, type CrmAnswer, type CrmIntent } from "./crm";
import { businessQuestionsIn } from "./compound-questions";
import { agentStatusSaid, aiSpendAsked, aiSpendSaid, calendarSaid, isQuestion, osReadIn, type AiTotalsLike, type CalendarEventLike } from "./os-reads";
import { BOT_NEEDS_SESSION, createLinkedRunner, type RunMeta } from "./linked-run";
import { commandRequestId, type CommandAdmissionKey } from "../jobs/command-admission";
import type { JobThreads } from "./threads";
import { codeChangeNotPayment, codingMoneyRefusal, readOnlyMoneyQuestion } from "../jarvis-execution/spoken-money";
import { parseComputerCommand } from "../computers/jarvis";
import { decideTask, jevOutageLine, type Catalogue, type ControllerDeps } from "../jev-controller";
import { resolvePin, type PinCatalogue } from "../jev-pins";
import { isCodingRequest } from "../../src/lib/commands/coding";

export type Delegates = {
  /**
   * Shared memory by voice/typed words (scripts/memory/voice-turn.ts): its line and its OUTCOME (remembered,
   * saved-to-vault, refused…). Null = not a memory request. Only a stored or found outcome is ever "done".
   */
  memory?: (utterance: string, caller: unknown, spokenYes: string | null) => Promise<{ said: string; outcome: string } | null>;
  /** The receptionist's state from its own feed (never invented). */
  receptionist?: (utterance: string) => Promise<{ ok: boolean; said: string; verified?: boolean | null }>;
  /**
   * Read lanes for the OS's own data (os-reads.ts): the saved calendar events the Calendar page shows, and the "what needs me" answer from
   * the same panels Home reads. Read only; absent, those questions say the service isn't connected here.
   */
  reads?: { calendar?: () => readonly CalendarEventLike[] | Promise<readonly CalendarEventLike[]>; needsYou?: (principal: Principal) => Promise<string>; /** The AI usage snapshot the Finance page's "AI spend" tile reads (/__ai_usage). */ aiTotals?: () => Promise<AiTotalsLike> };
  /**
   * Coding by words, typed or spoken (scripts/coding/command-entry.ts): the SAME shaper and per-person voice state, so
   * "assign a builder to fix X and a reviewer to check it" drafts one job (models chosen, reasons said) and only a
   * person's whole "start it" starts it. Null = not a coding turn. The verified caller comes from the principal, never the words.
   */
  coding?: (utterance: string, turn: { personId: string; actor: "human" | "process"; via: string; spokenYes: string | null; /** The builder this turn must use (an Agents bot's coding setting): exactly this account and model, or a refusal. */ pin?: { accountSlot: string | null; model: string | null } | null; /** Jev chose the coding lane: draft it rather than re-judging the words. */ jevDecided?: boolean; conversationId?: string; /** Typed or spoken: recorded on a draft as it was. */ channel?: "voice" | "typed" }) => Promise<{ say: string; navigate?: string; jobId?: string; jobState?: string; draft?: unknown; drafted?: boolean; started?: boolean } | null>;
  /** A whole-request Stop: drop this person's pending coding-planner question (true when one was pending). Round 11. */
  codingCancelPending?: (turn: { personId: string; actor: "human" | "process"; via: string }) => Promise<boolean>;
  /** Is this person's coding planner waiting for an answer? (A Stop then goes to the harness, skipping Jev.) */
  codingPendingQuestion?: (turn: { personId: string; actor: "human" | "process"; via: string }) => Promise<boolean>;
  /** The coding harness's own detector (the same one it answers by, with the repo ids): are these coding words? Absent: the shared pure detector (src/lib/commands/coding.ts). */
  codingMatches?: (utterance: string) => boolean;
  /**
   * Shared cloud computers ("use the research computer to ...", "show me the research bot", "continue that job"): starts or attaches a
   * computer job for the VERIFIED person. Null = not a computer request. The agent gets exactly that person's permitted targets; a named
   * computer that isn't there is refused, never replaced by another machine (scripts/computers/jarvis.ts).
   */
  computers?: (utterance: string, principal: Principal) => Promise<{ ok: boolean; said: string; jobId?: string; deviceId?: string; navigate?: string; started?: boolean } | null>;
  /** A lead's website from the CRM itself (never from the page's words): "open this lead's website". Null = no such lead. */
  leadSite?: (leadId: string) => Promise<{ name: string; website: string | null } | null>;
  /** A CRM action on a named lead (log a call, set a status, who's next), read back after any write. */
  leads?: (action: LeadAction, principal: Principal, eventId?: string, jobId?: string) => Promise<{ ok: boolean; said: string; verified: boolean | null }>;
  /** A CRM request through the CRM's own typed operations (scripts/jarvis-command/crm.ts), with the verified principal and the open page's CRM record. */
  crm?: (intent: CrmIntent, principal: Principal, pageContext: PageContext | null, eventId?: string) => Promise<CrmAnswer>;
  /** A real reminder through the reminder skill ("remind me to …" words). */
  reminder?: (words: string, principal: Principal) => Promise<{ ok: boolean; said: string }>;
  /**
   * The read-only Jarvis skills the voice rules already answer (finance, time, maths, units, currency, system,
   * weather, AI usage, inbox, deploys, capabilities, timers): typed words get the same answer (AUDIT-F2/F4
   * typed = spoken). `match` is pure; nothing that types or moves windows is matched.
   */
  skill?: { match(utterance: string): string | null; run(utterance: string, principal: Principal): Promise<{ ok: boolean; said: string }> };
};

export type CommandServiceDeps = {
  jobs: () => JobService;
  /** The hub's Jarvis entry (local executors), or null where this server can't act on its own screen. */
  entry: () => JarvisEntry | null;
  /** The entry's run log, so hub steps land in the job as they happen. */
  runs?: Pick<RunLog, "subscribe">;
  hubDeviceId: string;
  /** The hub's role (scripts/cloud/hub-role.ts), for the words of a refusal only. Default: the environment's. */
  role?: () => HubRole;
  resolveTarget: (ctx: ResolveContext) => ResolveResult;
  dispatcher?: { submit(input: CommandInput, opts?: { timeoutMs?: number; signal?: AbortSignal; onQueued?: (id: string, deviceId: string) => void; onProgress?: (step: ProgressStep) => void }): Promise<DispatchResult> };
  /** The companion that holds this person's microphone, if exactly one (DeviceRegistry.micOwner). */
  micOwner?: (personId: string) => string | null;
  /** Does this device report that it runs this executor (its heartbeat's capabilities)? Unset: unknown, so nothing goes to screen.goal. */
  supports?: (deviceId: string, executor: string) => boolean;
  /**
   * The hub's spoken-yes ledger (the voice pipeline's): a question a companion's screen loop asks is put on it, and
   * a spoken yes is redeemed here BEFORE it is sent to that companion. A typed yes has no event and never approves a final action.
   */
  spoken?: { ask(surface: "screen"): { id: string; at: number }; redeem(id: unknown, options: { after?: number; question?: string }): unknown };
  deviceLabel?: (deviceId: string) => string;
  delegates?: Delegates;
  thresholds?: (surface: "voice" | "typed") => SurfaceThresholds;
  now?: () => number;
  graceMs?: number;
  /** How long an identical command from the same person is the same command (default 5 s; 0 turns it off). */
  dedupeMs?: number;
  remoteTimeoutMs?: number;
  /**
   * Jarvis threads (Open Dot V): links the jobs a command leaves going to the person's durable conversation, appends their real results there,
   * and answers follow-ups ("how's that going?", "stop that task", "also include ...") about them. Absent: commands behave as before.
   */
  threads?: JobThreads;
  /**
   * Agent bots (scripts/agents/jarvis.ts, the Agents workspace): which bot a request is for (scope) and what the bot does with it (run). Absent: no
   * request is a bot's, exactly as before.
   */
  bots?: {
    scope: NonNullable<Parameters<typeof createLinkedRunner>[0]["bots"]>["scope"];
    nameOf: (botId: string) => string;
    threadIds: (personId: string) => string[];
    /** The bots Jev may hand a task to (id, name, what it is for). Absent: the controller offers no agent lane. */
    list?: () => { id: string; name: string; purpose?: string }[];
    run(input: { principal: Principal; bot: string; utterance: string; source: CommandSource; spokenYes?: string | null; subjects?: string[]; pageContext?: PageContext | null; /** Jev's choice of task kind for the agent. */ lane?: "coding" | "computer"; /** The decision record (decidedBy, op, confidence, ms, requestId, model, options, cached) kept on the agent's task. */ decision?: JevDecisionRef | null }): Promise<{ ok: boolean; said: string; jobId?: string; deviceId?: string; navigate?: string; ask?: boolean; numbers?: Record<string, unknown>; started?: boolean } | null>;
  };
  /**
   * The Jev controller (scripts/jev-controller.ts): ONE typed decision for words no exact rule planned (which lane, which agent). Absent:
   * open-ended words go to the person's own companion screen loop exactly as before. Present with no key or Jev down: he is told plainly
   * (brief §4.12) and nothing runs; exact commands (rules) still run, marked as the deterministic recovery.
   */
  controller?: ControllerDeps;
  /**
   * The coding accounts this server has (the accounts file), so a pinned account that isn't here is refused by name with the ones that
   * are. Absent: a named account is still pinned and the coding harness refuses an unconnected one itself.
   */
  pinCatalogue?: () => PinCatalogue | null;
};

type Live = { events: CommandStreamEvent[]; listeners: Set<(e: CommandStreamEvent) => void>; done: CommandDoneEvent | null; grace?: ReturnType<typeof setTimeout>; personId: string; seq: number };

/** `memoryCaller`: the memory plugin's own verified caller for this request (its principalFor(req)). */
export type RunInput = { principal: Principal; body: CommandBody; memoryCaller?: unknown; /** Internal only: never accepted from an HTTP body. */ admission?: CommandAdmissionKey };

const HANDOFF_SPECIALISTS: SpecialistId[] = ["brain", "vision", "voice-tools"];
/** A whole-request stop. Anything longer ("stop the music and open Notepad") is a new request. */
export const STOP_WORDS = /^(?:jarvis,?\s+)?(?:(?:stop|cancel|abort)(?: it| that| this| the| my| now)?(?: (?:task|job|command|goal|request|one))?|never ?mind|hold on|forget it)[.!]?$/i;

/** How long "your PC has no companion" stays said: within this, the next refusal is the short version (never the same line twice running). */
const NO_COMPANION_REPEAT_MS = 15 * 60_000;
/** A whole-utterance answer to a question Jarvis asked ("yes", "start it", "no"): with Stop, the only words handled before Jev's decision. */
const ANSWER_WORDS = /^(?:jarvis,?\s+)?(?:yes|yeah|yep|yup|yes please|sure|go ahead|do it|start it|start|confirm(?:ed)?|approve(?: it)?|okay|ok|no|nope|no thanks|leave it|don't|cancel it)[.!]?$/i;
const CONTINUE_JOB =/^(?:please\s+)?(?:continue|resume|carry on(?: with)?|pick up)\s+(?:that|this|the)\s+(?:job|task)\s*[.!?]?$/i;
const SITE_KINDS = new Set(["lead", "client", "site"]);
const OPEN_SITE = /\b(?:open|show|go to|pull up|bring up|visit|load)\b[^.?!]*\b(?:web ?site|site|web ?page|homepage|url)\b/i;
/** The job the page shows: a focused or selected job item, else its jobId. */
function jobIdOf(ctx: PageContext | null): string | null {
  if (!ctx) return null;
  const item = [ctx.focused, ...(ctx.selected ?? [])].find((i) => i?.kind === "job");
  return item?.id ?? ctx.jobId ?? null;
}
/** A public http(s) page only: a bare domain gets https; no private hosts, no other schemes. */
function publicUrl(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const h = u.hostname.toLowerCase();
    if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^[\d.]+$/.test(h) || h.includes(":")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * A coding draft's line for the VOICE: who builds, who reviews, on which login, and the question. The full receipt (source snapshot, routes,
 * why each model) is what the page shows and what `numbers.fullSummary` carries; a spoken reply says only what he needs to answer.
 */
export function spokenDraft(full: string, draft: unknown): string {
  const roles = (draft as { roles?: Array<{ role: string; model: string; accountSlot: string }> } | null)?.roles;
  if (!Array.isArray(roles) || !roles.length) return full;
  const model = (m: string) => (/opus/i.test(m) ? "Opus" : /sonnet/i.test(m) ? "Sonnet" : /fable/i.test(m) ? "Fable" : /haiku/i.test(m) ? "Haiku" : /gpt|codex|astra/i.test(m) ? "Codex" : m.split("/").pop()!.slice(0, 24));
  const account = (slot: string) => {
    const n = /-(\d+)$/.exec(slot)?.[1];
    return slot.startsWith("claude:max") ? `Claude Max${n ? ` ${n}` : ""}` : slot.startsWith("codex:") ? "Codex" : slot;
  };
  const accounts = [...new Set(roles.map((r) => account(r.accountSlot)))];
  const verb = (role: string) => (role === "builder" ? "builds" : role === "reviewer" ? "reviews" : role === "tester" ? "tests" : role);
  const repo = /^Draft ready: ([\w.-]+) — /.exec(full)?.[1];
  const who = roles.map((r) => `${model(r.model)} ${verb(r.role)}`).join(", ");
  return `Draft ready${repo ? ` in ${repo}` : ""}${accounts.length === 1 ? ` on ${accounts[0]}` : ""}: ${who}. Start it?`;
}

export function createCommandService(deps: CommandServiceDeps) {
  const live = new Map<string, Live>();
  /** The last page each verified person sent (a spoken command with none uses it briefly; never across people). */
  const pageMemory = createContextMemory();
  /** An identical command from the same person, still running or just finished OK, is the same command (typed + voice echo). */
  const recent = new Map<string, { jobId: string; at: number }>();
  /** Durable Stop applies across restart; a request with an ambiguous outcome is never replayed. */
  const eventStopped = (personId: string, eventId: unknown) => typeof eventId === "string" && /^[\w:.-]{6,80}$/.test(eventId) && deps.jobs().commandAdmission(personId, eventId)?.stoppedAt != null;
  /** person|eventId -> how many runs of it are in progress (final review B1). */
  const inProgress = new Map<string, number>();
  const stoppedBeforeStart = (): CommandDoneEvent => ({ type: "done", ok: true, stopped: true, said: "Stopped before it started. Nothing ran.", kind: "answer", jobId: null, runId: "", targetDeviceId: null, numbers: { stoppedBeforeStart: true }, verified: true });
  const DEDUPE_MS = deps.dedupeMs ?? 5_000;
  const graceMs = deps.graceMs ?? RECONNECT_GRACE_MS;
  const label = (id: string) => deps.deviceLabel?.(id) ?? id;
  /** The job each person has waiting for a yes (one open question per person, as the screen loop has). */
  const awaiting = new Map<string, { jobId: string; timer: ReturnType<typeof setTimeout> }>();
  const ANSWER_WINDOW_MS = 2 * 60_000;
  /** A question a companion's screen loop asked, per person: which device, what about, and the hub ledger's question it is stamped with. */
  /** What each person recently used on each of their own devices (from verified steps only): "switch back to ..." resolves against it. */
  const recentTargets = createRecentTargets(deps.now ?? Date.now);
  const pendingRemote = new Map<string, { deviceId: string; goal: string; confirm: string; at: number; questionId: string | null; askedAt: number }>();
  /** When each person was last told their PC has no companion: the second time in a while is shorter, never the same words again. */
  const toldNoCompanion = new Map<string, number>();
  /** When each person was last told an exact step ran as the deterministic recovery because Jev is off (said once in a while, always recorded). */
  const toldRecovery = new Map<string, number>();
  /**
   * The person has no companion at all (resolveTarget's "no device registered for <person>"): one plain line that says what is missing, how to set
   * it up, and the other way to get it done (a bot's own computer). The id-style reason stays in the job's decision log, never in the spoken line.
   */
  function noCompanionLine(personId: string, reason: string, at: number): string | null {
    if (!/^no device registered for /.test(reason)) return null;
    const last = toldNoCompanion.get(personId);
    toldNoCompanion.set(personId, at);
    const bots = deps.bots ? " Or give it to one of your agents by name, like \"Builder, open a Chrome tab\": they run on their own computers." : "";
    if (last !== undefined && at - last < NO_COMPANION_REPEAT_MS)
      return `Still no companion on your PC, so nothing ran there. Pair it from Profile, "Code for a companion".${deps.bots ? " Or say an agent's name first and it runs on that agent's computer." : ""}`;
    const where = (deps.role ?? hubRole)() === "server" ? "The hub runs on a server with no screen of its own, and your PC has no companion paired, so there's no device of yours I can control yet." : "Your PC has no companion paired, so there's no device of yours I can control yet.";
    return `Nothing ran. ${where} To set it up, make a code in Profile, "Code for a companion", then pair the M&U companion on that PC.${bots}`;
  }
  function settleAwaiting(personId: string, note: string) {
    const a = awaiting.get(personId);
    if (!a) return;
    awaiting.delete(personId);
    clearTimeout(a.timer);
    try {
      deps.jobs().finish(a.jobId, "interrupted", note);
    } catch {
      /* the store is read-only or closing */
    }
  }
  /** A late-settling step's promise carried on a done (the hub entry's `lateWork`), if any. */
  function lateOf(done: object): Promise<{ ok: boolean; said: string }> | undefined {
    const w = (done as { lateWork?: unknown }).lateWork;
    return w && typeof (w as Promise<unknown>).then === "function" ? (w as Promise<{ ok: boolean; said: string }>) : undefined;
  }
  /**
   * When the step a stop couldn't cancel finally settles, the job says what really happened: a step with the
   * late result and a new note. A saved .pptx change is never left looking like it didn't happen (REVIEW-T2 R4 F1).
   */
  function recordLate(jobId: string, work: Promise<{ ok: boolean; said: string }>) {
    void work
      .then((r) => {
        const jobs = deps.jobs();
        jobs.step(jobId, { intent: `after the stop, the step it had started ${r.ok ? "finished" : "didn't finish"}: ${r.said.slice(0, 160)}`, executor: "late-result", ms: 0, outcome: r.ok ? "ok" : "failed", verification: { method: "late-result", ok: r.ok } });
        jobs.amendNote(jobId, r.ok ? `Stopped, but the step it had started finished afterwards: ${r.said}` : `Stopped; the step it had started didn't finish: ${r.said}`);
      })
      .catch(() => undefined);
  }
  function holdAwaiting(personId: string, jobId: string) {
    settleAwaiting(personId, "Superseded by a newer question before an answer.");
    const timer = setTimeout(() => settleAwaiting(personId, "No answer to this question here within two minutes. A spoken yes presses through the screen gate and is recorded in that screen job."), ANSWER_WINDOW_MS);
    timer.unref?.();
    awaiting.set(personId, { jobId, timer });
  }

  /** Per job: when the request arrived, when its routing decision was published, when it was first dispatched, and Jev's own call time. */
  const timings = new Map<string, { received: number; decided?: number; dispatched?: number; jevMs?: number }>();
  /** The first dispatch of this job to an executor or worker (a companion step, the hub entry, a delegate). */
  const markDispatch = (jobId: string) => {
    const t = timings.get(jobId);
    if (t && t.dispatched === undefined) t.dispatched = Date.now();
  };
  const timingOf = (jobId: string, at = Date.now()): NonNullable<CommandDoneEvent["timing"]> | null => {
    const t = timings.get(jobId);
    if (!t) return null;
    return { decisionMs: t.decided !== undefined ? t.decided - t.received : null, dispatchMs: t.dispatched !== undefined ? t.dispatched - t.received : null, completeMs: at - t.received, ...(t.jevMs !== undefined ? { jevMs: t.jevMs } : {}) };
  };

  function publish(jobId: string, event: CommandStreamEvent) {
    if (event.type === "decision") {
      const t = timings.get(jobId);
      if (t && t.decided === undefined) t.decided = Date.now();
      // A decision Jev really made leaves its call on the job as a receipt (request id, model, latency); a rule's decision leaves none.
      const d = event.decision;
      if (d.source === "jev" && d.requestId) {
        try {
          // The receipt says what was asked and answered: the choice, its confidence, the options offered, and whether it was cached.
          // "jev (fresh call)" with its jevMs, or "jev (cached)" with the ORIGINAL call's request id and its age; a rejected choice is refused_policy.
          const how = d.cached ? `jev (cached; original ${d.requestId}, ${Math.round((d.cacheAgeMs ?? 0) / 1000)} s old)` : `jev (fresh call; jevMs ${d.ms ?? "?"})`;
          const reason = `${how}: ${d.op}${d.op === "jev.rejected" && d.target ? ` "${d.target}"` : ""} at ${Math.round(d.confidence * 100)}%${d.options?.length ? ` from ${d.options.join("/")}` : ""}`;
          deps.jobs().receipt(jobId, { requestId: d.requestId, provider: "typesafe", model: d.model ?? "typesafe/jev-latest", route: "metered", selectedBy: "rule", reason, inputTokens: null, outputTokens: null, costUsd: null, latencyMs: d.cached ? 0 : (d.ms ?? null), outcome: d.op === "jev.rejected" ? "refused_policy" : "succeeded", fallbackFrom: null });
        } catch {
          /* the store is read-only or closing: the step still carries the evidence */
        }
      }
    }
    const l = live.get(jobId);
    if (!l) return;
    const withSeq = event.type === "done" ? event : ({ ...event, seq: ++l.seq } as CommandStreamEvent);
    l.events.push(withSeq);
    if (l.events.length > 400) l.events.splice(0, l.events.length - 400);
    if (event.type === "done") l.done = event;
    for (const fn of l.listeners) {
      try {
        fn(withSeq);
      } catch {
        /* a listener never breaks a run */
      }
    }
    if (event.type === "done") {
      if (l.grace) clearTimeout(l.grace);
      // Kept briefly so a late re-attach still hears the outcome.
      setTimeout(() => (live.delete(jobId), timings.delete(jobId)), graceMs).unref?.();
    }
  }

  /** Run one command for a verified principal, with its latency measured (a reply that started no job still says how long it took). */
  async function runCore(input: RunInput, emit: (e: CommandStreamEvent) => void = () => undefined, meta: RunMeta = {}): Promise<CommandDoneEvent> {
    const receivedAt = Date.now();
    // Final review B1: while this event's run is in progress a Stop by event id can't be called "prevented" (a lane may already be starting work).
    const runKey = typeof input.body?.eventId === "string" ? `${input.principal.personId}|${input.body.eventId}` : null;
    if (runKey) inProgress.set(runKey, (inProgress.get(runKey) ?? 0) + 1);
    let done: CommandDoneEvent;
    try {
      done = await runCoreInner(input, emit, meta, receivedAt);
    } catch (error) {
      if (!(error instanceof StoppedBeforeStart)) throw error;
      done = stoppedBeforeStart();
    } finally {
      if (runKey) {
        const n = (inProgress.get(runKey) ?? 1) - 1;
        if (n > 0) inProgress.set(runKey, n);
        else inProgress.delete(runKey);
      }
    }
    return done.timing ? done : { ...done, timing: { decisionMs: null, dispatchMs: null, completeMs: Date.now() - receivedAt } };
  }

  // Production uses the owned conversation store; the bounded map only supports services without thread persistence.
  const lastRecords = new Map<string, CrmRecordReference | { pending: string }>();
  const nowOf = () => (deps.now ?? Date.now)();
  const recordsKey = (personId: string, conversationId: unknown) => `${personId}|${typeof conversationId === "string" ? conversationId : ""}`;
  const rememberRecord = (principal: Principal, conversationId: unknown, record: { kind: string; id: string; title: string }, generation: string) => {
    const reference = { ...record, at: nowOf() };
    if (!isBrowserPrincipal(principal) || !validCrmRecordReference(reference, reference.at)) return false;
    if (deps.threads) {
      try { return deps.threads.rememberCrmRecord(principal.personId, conversationId, reference, generation); } catch { return false; }
    }
    const key = recordsKey(principal.personId, conversationId);
    const pending = lastRecords.get(key);
    if (!pending || !("pending" in pending) || pending.pending !== generation) return false;
    lastRecords.delete(key);
    lastRecords.set(key, reference);
    while (lastRecords.size > 200) lastRecords.delete(lastRecords.keys().next().value!);
    return true;
  };
  const FOLLOW_NOUN = /\b(?:that|this|the same)\s+(deal|opportunity|client|company|customer|project|contact|record|one)\b/i;
  /** Only a parsed CRM target may refer back; pronouns inside a note/task payload are literal text. */
  function followUpWords(words: string, principal: Principal, conversationId: unknown, now: number): { words: string; record: CrmRef | null } | null {
    if (!isBrowserPrincipal(principal)) return null;
    let targetName = "recent CRM record";
    while (words.replace(/\s+/g, " ").toLowerCase().includes(targetName.toLowerCase())) targetName += " reference";
    const noun = FOLLOW_NOUN.exec(words);
    const rewritten = noun ? words.replace(FOLLOW_NOUN, () => `the ${targetName} ${noun[1].toLowerCase() === "opportunity" ? "deal" : noun[1].toLowerCase() === "customer" ? "client" : noun[1].toLowerCase() === "record" || noun[1].toLowerCase() === "one" ? "company" : noun[1]}`)
      : /\b(?:stage|next\s+actions?)\b/i.test(words) && /\bit\b/i.test(words) ? words.replace(/\bit\b/i, () => `the ${targetName} company`) : null;
    if (!rewritten) return null;
    const intent = crmIntentIn(rewritten);
    if (!intent || !("name" in intent) || intent.name !== targetName) return null;
    let last: CrmRecordReference | { pending: string } | null | undefined;
    try { last = deps.threads ? deps.threads.crmRecord(principal.personId, conversationId, now) : lastRecords.get(recordsKey(principal.personId, conversationId)); } catch { /* Ask instead of guessing after an unreadable store. */ }
    return { words: rewritten, record: validCrmRecordReference(last, now) ? { kind: last.kind, id: last.id } : null };
  }

  /** Run one command for a verified principal. `emit` receives the stream (job, decision, narrate, step, done). */
  async function runCoreInner(input: RunInput, emit: (e: CommandStreamEvent) => void, meta: RunMeta, receivedAt: number): Promise<CommandDoneEvent> {
    const { principal } = input;
    /** Set before a job exists when the work was already handed on (the coding delegate answers first), and Jev's own call time. */
    let earlyDispatch: number | undefined;
    let jevMs: number | undefined;
    /** Jev's failed call, when there was one (its request id and latency go on the fallback's receipt). */
    let jevMiss: { requestId?: string; ms: number; detail?: string; httpStatus?: number | null; attempts?: number } | null = null;
    /** The miss as the job record keeps it: reason, the cause in plain words, HTTP status, requests sent and time (never the key). */
    const jevMissFacts = () => ({ ...(jevMiss?.detail ? { detail: jevMiss.detail } : {}), ...(jevMiss?.httpStatus !== undefined ? { httpStatus: jevMiss.httpStatus } : {}), ...(jevMiss?.attempts !== undefined ? { attempts: jevMiss.attempts } : {}), ...(jevMiss ? { ms: Math.round(jevMiss.ms) } : {}) });
    /** Jev was unavailable: a job receipt says so, with the reason (timeout, error, no key), whatever ran instead. */
    const recordJevMiss = (jobId: string, reason: string) => {
      try {
        deps.jobs().receipt(jobId, { requestId: jevMiss?.requestId ?? `jev-unavailable-${reason}`, provider: "typesafe", model: "typesafe/jev-latest", route: "metered", selectedBy: "rule", reason: `Jev unavailable (${reason}${jevMiss?.detail ? `: ${jevMiss.detail}` : ""}${jevMiss?.attempts ? `, ${jevMiss.attempts} request${jevMiss.attempts === 1 ? "" : "s"}` : ""})${reason === "no-key" ? ": no call made" : ""}; deterministic fallback, a question answered by the brain, or the outage line; nothing guessed`, inputTokens: null, outputTokens: null, costUsd: null, latencyMs: jevMiss?.ms ?? null, outcome: reason === "timeout" ? "timed_out" : "failed", fallbackFrom: null });
      } catch {
        /* read-only store: the step still says it */
      }
    };
    const body = input.body ?? ({} as CommandBody);
    const source: CommandSource = body.source === "voice" || body.source === "away" || body.source === "acceptance" ? body.source : "typed";
    const surface = source === "voice" ? "voice" : "typed";
    const thresholds = (deps.thresholds ?? thresholdsFor)(surface);
    const raw = String(body.utterance ?? "").trim().slice(0, 600);
    const split = splitSpokenTarget(raw);
    // "that deal", "that client", "it" right after a find/open/stage answer in the same conversation mean that record (5 Oct). The words are
    // parsed with a neutral target, then bound to the exact saved ID; without a valid reference the delegate asks which record.
    const followed = followUpWords(split.utterance || raw, principal, body.conversationId, nowOf());
    const utterance = followed?.words ?? (split.utterance || raw);
    const spokenTarget = typeof body.spokenTarget === "string" && body.spokenTarget.trim() ? body.spokenTarget.trim().slice(0, 60) : split.spokenTarget;
    const slots = goalSlots(utterance);
    const nowMs = (deps.now ?? Date.now)();
    // Typed and spoken take the same resolver; only a spoken command may fall back to this person's last page.
    const commandContext = resolveCommandContext({ utterance, pageContext: body.pageContext, remembered: pageMemory.recall(principal.personId, nowMs), allowMemory: source === "voice", now: nowMs });
    const pageContext = commandContext.context;
    meta.pageContext = pageContext;
    if (commandContext.from === "sent") pageMemory.remember(principal.personId, pageContext, nowMs);
    const jobs = deps.jobs();
    const kind: JobKind = source === "voice" ? "voice" : "command";
    // Final review B1: lanes that start work before a job exists here (the coding harness, an agent, a shared computer) check his Stop just before
    // they call out, and stop what the call started if his Stop arrived during it, then report what really happened.
    /** A lane already stopped what it started for this event and says so: the job record that follows is not "stopped before it started". */
    let stopHandled = false;
    let dispatchedTask: { id: string; kind: "job" | "coding" } | null = null;
    const rememberTask = (id: string, kind: "job" | "coding") => {
      dispatchedTask = { id, kind };
      if (input.admission && !deps.jobs().bindCommandTask(input.admission, { taskId: id, taskKind: kind })) throw new Error("The started task could not be recorded; its outcome needs checking.");
    };
    const stopDispatched = async (): Promise<CommandDoneEvent> => {
      const task = dispatchedTask!;
      const result = input.admission ? await cancelEvent(input.admission.eventId, principal) : { ok: false, state: null, outcome: "unconfirmed" as const };
      const confirmed = result.outcome === "stopped";
      return { type: "done", ok: confirmed, stopped: confirmed, said: confirmed ? "Your stop arrived after the job started, and it is now stopped. Nothing further will run." : result.outcome === "already-ended" ? "Your stop arrived after the job had already ended." : "The job had already started. Stop requested; not yet confirmed. Check its job before trusting that it stopped.", kind: "answer", jobId: task.kind === "job" ? task.id : null, runId: "", targetDeviceId: null, ...(confirmed ? {} : { outcome: "unverified" }), numbers: { ...(task.kind === "coding" ? { codingJobId: task.id, ...(result.state ? { codingJobState: result.state } : {}) } : { jobId: task.id }) }, verified: confirmed ? true : null };
    };
    const stopGuard = () => {
      if (eventStopped(principal.personId, body.eventId)) throw new StoppedBeforeStart();
    };
    const stopTurnOf = { personId: principal.personId, actor: principal.actor === "human" ? ("human" as const) : ("process" as const), via: principal.via === "loopback-owner" ? "local" : principal.via === "telegram-owner" ? "telegram" : "tailnet", spokenYes: null };
    const afterCoding = async <R extends { say: string; jobId?: string; jobState?: string; started?: boolean } | null>(r: R): Promise<R> => {
      if (r?.started && r.jobId) rememberTask(r.jobId, "coding");
      if (!r || !r.jobId || !eventStopped(principal.personId, body.eventId)) return r;
      if (!r.started) return r; // A status/reference reply never grants this event authority to cancel existing work.
      stopHandled = true;
      const stopped = await deps.delegates?.coding?.(`stop the coding job ${r.jobId}`, stopTurnOf).catch(() => null);
      return { ...r, say: `Your stop arrived as it was starting. ${stopped?.say ?? "I couldn't reach the coding harness to stop it, so it may still be running: check the job."}`, started: false } as R;
    };
    const afterJob = async <B extends { ok: boolean; said: string } | null>(b: B): Promise<B> => {
      if (!b) return b;
      const reply = b as B & { jobId?: string; started?: boolean; numbers?: Record<string, unknown> };
      const codingId = reply.numbers?.codingStarted === true && typeof reply.numbers.codingJobId === "string" ? reply.numbers.codingJobId : null;
      if (codingId) rememberTask(codingId, "coding");
      else if (reply.started === true && typeof reply.jobId === "string") rememberTask(reply.jobId, "job");
      else return b; // A status/show/attach result does not grant this request cancellation of existing work.
      if (!eventStopped(principal.personId, body.eventId)) return b;
      stopHandled = true;
      const stopped = await stopDispatched();
      return { ...b, ok: stopped.ok, said: stopped.said } as B;
    };
    const decisionOf = (d: Omit<JevDecision, "calibrationRunId">): JevDecision => ({ ...d, calibrationRunId: thresholds.calibrationRunId });

    // (A bot named with no task, "use the builder agent", reaches the bot with no words: it answers where it stands.)
    if (!raw && !(deps.bots && body.target?.bot && source !== "acceptance")) return { type: "done", ok: false, said: "Do what?", kind: "ask", ask: true, jobId: null, runId: "", targetDeviceId: null };
    // A new request drops any question this person left open (the confirmed press goes through the
    // screen gate's own path; this job's record says it was superseded, never "failed").
    settleAwaiting(principal.personId, /^(?:yes|yeah|yep|yes please|go ahead|do it|confirm(?:ed)?|no|nope|leave it)[.!]?$/i.test(raw) ? "Answered in the next command." : "Superseded by a newer request before an answer.");
    // "stop", "cancel that", "never mind" typed or said as a command (AUDIT-F4 F14): stop this person's
    // running commands through the job service. Never typed into a window, never a new job.
    const stopTurn = { personId: principal.personId, actor: principal.actor === "human" ? ("human" as const) : ("process" as const), via: principal.via === "loopback-owner" ? "local" : principal.via === "telegram-owner" ? "telegram" : "tailnet" };
    // Review (round 11): "forget it", "hold on" are STOP_WORDS but also natural answers to the coding planner's either/or question. While a question
    // is pending, only an explicit stop (isStopCommand) stops; the other words go to the harness as the answer.
    if (STOP_WORDS.test(raw) && !isStopCommand(raw) && deps.delegates?.coding && (await deps.delegates.codingPendingQuestion?.(stopTurn).catch(() => false))) {
      const r = await deps.delegates.coding(raw, { ...stopTurn, spokenYes: null, channel: source === "voice" ? "voice" : "typed" }).catch(() => null);
      if (r) return { type: "done", ok: true, said: r.say, kind: r.navigate ? "navigate" : "answer", ...(r.navigate ? { navigate: { path: r.navigate } } : {}), numbers: { ...(r.jobId ? { codingJobId: r.jobId } : {}), ...(r.jobState ? { codingJobState: r.jobState } : {}), ...(r.drafted ? { codingDrafted: true } : {}) }, jobId: null, runId: "", targetDeviceId: "none", verified: null };
    }
    if (STOP_WORDS.test(raw)) {
      const all = await cancelAllForDetailed(principal);
      const stopped = all.stopped;
      // Round 11: the same Stop drops a coding-planner question left open, so the next words are a new request, never taken as its answer.
      const dropped = await (deps.delegates?.codingCancelPending?.(stopTurn) ?? Promise.resolve(false)).catch(() => false);
      const draftLine = dropped ? " I've dropped the coding request that was waiting for your answer; nothing was started." : "";
      // Only a CONFIRMED stop says "Stopped" (release re-check M1); a stop that wasn't acknowledged says so.
      const n = all.unconfirmed.length;
      const unconfirmedLine = n ? ` ${n === 1 ? "One command" : `${n} commands`} didn't confirm the stop, so ${n === 1 ? "it" : "they"} may still be running: check Activity.` : "";
      const said = stopped.length ? `Stopped ${stopped.length === 1 ? "it" : `${stopped.length} commands`}.${unconfirmedLine}${draftLine}` : n ? `${unconfirmedLine.trim()}${draftLine}` : dropped ? draftLine.trim() : "Nothing of yours was running.";
      return { type: "done", ok: !n, stopped: true, said, kind: "answer", jobId: stopped[0] ?? all.unconfirmed[0] ?? null, runId: "", targetDeviceId: null, ...(n ? { outcome: "unverified" as const } : {}), ...(dropped || n ? { numbers: { ...(dropped ? { codingDraftDropped: true } : {}), ...(n ? { unconfirmed: all.unconfirmed } : {}) } } : {}) };
    }

    // The same event id from the same person again (a resend after a hub restart, or after the in-memory window): the job store already holds
    // the command (its request id), so it is answered from that record and never run a second time, exactly as a bot conversation does.
    // Full event ids keep the legacy key where it fits, otherwise use a stable digest; never truncate to collide.
    const commandKey = typeof body.eventId === "string" && /^[\w:.-]{6,80}$/.test(body.eventId) && source !== "acceptance" ? commandRequestId(principal.personId, body.eventId) : null;
    const priorJob = commandKey ? (jobs.byRequest?.(commandKey) ?? null) : null;
    // Stopped before any job existed (his Stop arrived first): it never starts, and a resend of the same event says so (release re-check B1).
    if (!priorJob && eventStopped(principal.personId, body.eventId)) return stoppedBeforeStart();
    if (priorJob && priorJob.principal.personId === principal.personId) {
      const open = priorJob.state === "running" || priorJob.state === "queued" || priorJob.state === "awaiting-approval";
      const said = open
        ? `That request is already ${priorJob.state === "awaiting-approval" ? "waiting for your yes" : "running"}, so I didn't start it again.`
        : `That request already ran (${priorJob.state}${priorJob.note ? `: ${priorJob.note.slice(0, 140)}` : ""}). It was not run again.`;
      return { type: "done", ok: open || priorJob.state === "succeeded", said, kind: "answer", jobId: priorJob.id, runId: "", targetDeviceId: priorJob.targetDeviceId, numbers: { replayed: true, jobId: priorJob.id, state: priorJob.state }, verified: null };
    }

    // A repeat of the same words from the same person while that job runs (or just finished OK) is the same command:
    // attach to it, never start a second (typed + voice echo, a double tap). Answers to a question are always new.
    const answering = /^(?:yes|yeah|yep|yes please|go ahead|do it|confirm(?:ed)?|no|nope|leave it)[.!]?$/i.test(raw);
    // The whole page context (minus its capture time) is part of the key: the same words about different figures are not the same command.
    const pageSig = pageContext ? JSON.stringify({ ...pageContext, capturedAt: undefined }) : "";
    const dedupeKey = answering || source === "acceptance" ? null : `${principal.personId}|${utterance.toLowerCase().replace(/\s+/g, " ")}|${spokenTarget ?? ""}|${pageSig}`;
    /** Start a job and stream it; `work` runs inside the job service (its signal is the stop). */
    const start = async (targetDeviceId: string, work: (ctx: ExecutorContext, out: (e: CommandStreamEvent) => void) => Promise<CommandDoneEvent>, opts: { dedupe?: boolean } = {}): Promise<CommandDoneEvent> => {
      // The Stop may have arrived while this was still being decided (Jev, a lookup): checked again at the last moment before a job exists.
      if (eventStopped(principal.personId, body.eventId) && !stopHandled) return dispatchedTask ? stopDispatched() : stoppedBeforeStart();
      // The job records WHO (person, via, actor, device), never the server-only session key (B1: it stays out of every JSON).
      const recorded = { personId: principal.personId, via: principal.via, actor: principal.actor, ...(principal.deviceId ? { deviceId: principal.deviceId } : {}) };
      // CRM subjects are recorded only on bot/agent jobs (scripts/agents/jarvis.ts, computers/service.ts), never on a plain command job: a question
      // asked on a CRM page must not become a CRM activity (scripts/crm/hub-integration.ts writes results for bot jobs only).
      const jobInput = { kind, principal: recorded, targetDeviceId, title: slots.goal || "Jarvis command", ...(commandKey ? { requestId: commandKey } : {}) };
      const job = input.admission && !stopHandled ? jobs.createCommandJob(jobInput, input.admission) : jobs.create(jobInput);
      if (!job) return dispatchedTask ? stopDispatched() : stoppedBeforeStart();
      timings.set(job.id, { received: receivedAt, ...(earlyDispatch !== undefined ? { dispatched: earlyDispatch } : {}), ...(jevMs !== undefined ? { jevMs } : {}) });
      const l: Live = { events: [], listeners: new Set([emit]), done: null, personId: principal.personId, seq: 0 };
      live.set(job.id, l);
      if (dedupeKey && opts.dedupe !== false) recent.set(dedupeKey, { jobId: job.id, at: nowMs });
      if (recent.size > 64) for (const [k, v] of recent) if (nowMs - v.at > DEDUPE_MS) recent.delete(k);
      publish(job.id, { type: "job", jobId: job.id, targetDeviceId, ...(targetDeviceId !== "none" ? { deviceLabel: label(targetDeviceId) } : {}), seq: 0 });
      const box: { done: CommandDoneEvent | null } = { done: null };
      const result = await jobs.run(job.id, async (ctx) => {
        // When the stop arrived: "had already finished" is only claimed if the lane's check passed BEFORE this.
        let abortedAt: number | null = null;
        ctx.signal.addEventListener("abort", () => void (abortedAt ??= Date.now()), { once: true });
        let done = await work(ctx, (e) => publish(job.id, e)).catch((error: Error): CommandDoneEvent => ({ type: "done", ok: false, said: `That failed: ${String(error?.message ?? error).slice(0, 160)}`, kind: "unavailable", jobId: job.id, runId: "", targetDeviceId }));
        // Decision, dispatch and observed completion, measured separately, on the done event (streamed, and kept in the thread).
        const timing = timingOf(job.id);
        if (timing) done = { ...done, timing };
        if (ctx.signal.aborted && !done.stopped) {
          // The stop arrived. Not done → reported as stopped. Already done and checked (a race of milliseconds)
          // → said plainly and recorded as succeeded with that note (REVIEW-T2 #5), not as an ignored stop.
          if (!done.ok) done = { ...done, ok: false, stopped: true, said: "Stopped." };
          else if (typeof done.checkedAt === "number" && abortedAt !== null && done.checkedAt <= abortedAt) {
            ctx.step({ intent: "the stop arrived after the action had already completed and been checked", executor: "none", ms: 0, outcome: "note" });
            box.done = { ...done, stopped: true, said: `That had already finished when you said stop: ${done.said}` };
            return { ok: true, completedBeforeStop: true, note: "Finished and checked just before the stop arrived." };
          } else {
            // It finished AFTER the stop (the lane didn't honour it), or its check time is unknown: say so, and let
            // the job service record the ignored stop (and quarantine it), as B2 intends (REVIEW-T2 R2 #2).
            ctx.step({ intent: "the stop wasn't honoured in time: the action completed after it", executor: "none", ms: 0, outcome: "note" });
            box.done = { ...done, stopped: false, said: `I couldn't stop that in time, so it went ahead: ${done.said}` };
            return { ok: true, note: done.said.slice(0, 200) };
          }
        }
        box.done = done;
        // A question back (a final button's "Shall I press Send?", a forget's "Say yes") waits for his answer;
        // a handoff passed the request on. Neither is a failure (REVIEW-T2 #5).
        if (!done.ok && !done.stopped && (done.confirm || done.awaiting))
          return { ok: false, settle: "awaiting-approval", note: done.confirm ? `Waiting for your yes: ${done.confirm}` : "Waiting for your answer." };
        if (!done.ok && !done.stopped && done.outcome === "uncertain") return { ok: false, settle: "unknown", note: done.said.slice(0, 200) };
        if (!done.ok && done.kind === "handoff" && done.handoff)
          return { ok: false, settle: "handed-off", note: `Handed off to ${done.handoff.to}; nothing ran here.` };
        // A clarifying question ("Which record do you mean?", "Should it be on your PC or an answer from me?") is not a failure (5 Oct):
        // nothing ran and nothing went wrong. It settles as asked, so Home and Activity never list it as Failed.
        if (!done.ok && !done.stopped && done.ask && !done.refused) return { ok: false, settle: "asked", note: `Asked: ${done.said.slice(0, 180)}` };
        // Stopped while a step that can't be cancelled was running: the note hedges until it lands (REVIEW-T2 R4 F1).
        const lateNote = done.stopped && lateOf(done) ? "Stopped; a step it had already started may still finish (updated here when it does)." : undefined;
        return { ok: done.ok, note: done.said.slice(0, 200), ...(lateNote ? { stopNote: lateNote } : {}) };
      });
      if (box.done && (box.done.confirm || box.done.awaiting) && !box.done.stopped) holdAwaiting(principal.personId, job.id);
      const lateWork = box.done ? lateOf(box.done) : undefined;
      if (lateWork) recordLate(job.id, lateWork);
      const { lateWork: _dropped, ...doneOnly } = (box.done ?? {}) as CommandDoneEvent & { lateWork?: unknown };
      void _dropped;
      const final: CommandDoneEvent = box.done
        ? { ...(doneOnly as CommandDoneEvent), jobId: job.id, targetDeviceId }
        : { type: "done", ok: false, said: result.reason === "quarantined" ? "Jarvis commands are on hold after a stop that wasn't confirmed; release it in the job log first." : "That didn't start.", kind: "unavailable", jobId: job.id, runId: "", targetDeviceId };
      publish(job.id, final);
      return final;
    };

    const note = (ctx: ExecutorContext, s: Omit<Step, "seq" | "at" | "ms"> & { ms?: number }) => ctx.step({ ms: 0, ...s });

    // A yes to a question a companion's screen loop asked resumes on the SAME device. The hub checks the spoken yes
    // against its own voice pipeline first; the PC's screen gate then applies its own binding and no-replay rules.
    const pend = pendingRemote.get(principal.personId);
    if (pend && !/^(?:yes|yeah|yep|yes please|go ahead|do it|confirm(?:ed)?)[.!]?$/i.test(raw)) pendingRemote.delete(principal.personId);
    else if (pend) {
      const refuseAnswer = (said: string, keep: boolean) => {
        if (!keep) pendingRemote.delete(principal.personId);
        return start(pend.deviceId, async (ctx, out) => {
          const d = decisionOf({ op: "device.resume", confidence: 1, policy: "done", source: "rules", deviceId: pend.deviceId, why: said });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `resume: ${said}`, executor: "none", target: pend.deviceId, jev: d, outcome: "refused" });
          return { type: "done", ok: false, refused: true, said, kind: "refused", jobId: null, runId: "", targetDeviceId: pend.deviceId, decision: d };
        });
      };
      if (nowMs - pend.at > ANSWER_WINDOW_MS) return refuseAnswer("That question has timed out, so nothing was pressed. Ask again if you still want it.", false);
      const redeemed = deps.spoken ? deps.spoken.redeem(body.spokenYes, { after: pend.askedAt, ...(pend.questionId ? { question: pend.questionId } : {}) }) : null;
      if (!redeemed) return refuseAnswer("I need your spoken yes to that, and a typed one can't approve it. Say yes out loud and nothing is pressed until then.", true);
      pendingRemote.delete(principal.personId);
      return start(pend.deviceId, async (ctx, out) =>
        remoteRun(ctx, out, { principal, utterance: pend.goal, originDeviceId: pend.deviceId, deviceId: pend.deviceId, rule: null, steps: [{ executor: "screen.goal", args: { resume: { goal: pend.goal, confirm: pend.confirm }, yes: true } }], decisionOf, note }),
      );
    }

    /** Steps 4 and 5: which device (from the VERIFIED person), then the hub entry or a typed plan on that person's own companion. */
    const toDevice = async (rule: RulePlan | null, steps?: RemoteStep[], how: { fromWords?: boolean; decided?: JevDecision; /** Jev was unavailable (this reason) and this exact step runs as the labelled deterministic fallback. */ recovery?: string } = {}): Promise<CommandDoneEvent> => {
      // 4. Which device, from the VERIFIED person (never a body field). The hub is never a fallback.
      const originDeviceId = principal.via === "loopback-owner" ? deps.hubDeviceId : principal.via === "companion" ? principal.deviceId : (deps.micOwner?.(principal.personId) ?? undefined);
      let target: ResolveResult;
      try {
        target = deps.resolveTarget({ personId: principal.personId, ...(spokenTarget ? { spokenTarget } : {}), ...(originDeviceId ? { originDeviceId } : {}) });
      } catch (error) {
        target = { ok: false, reason: `couldn't resolve the device (${(error as Error).message.slice(0, 60)})` };
      }
      // A shared agent cloud computer (owner "shared") runs as a computer job under a control lease (scripts/computers), never as a typed Jarvis step.
      if (target.ok && target.owner === "shared") target = { ok: false, reason: "that is a shared cloud computer: it runs as a computer job with a control lease (Computers), not as a Jarvis step", deviceId: target.deviceId };
      if (!target.ok) {
        const failed = target;
        const deviceId = failed.deviceId ?? "none";
        return start(deviceId, async (ctx, out) => {
          // Jev chose his device but which one (or whether one is paired) is the device question: Jev's decision and its receipt stay on the job.
          if (how.decided) out({ type: "decision", decision: how.decided, seq: 0 });
          if (how.recovery) recordJevMiss(ctx.jobId, how.recovery);
          const asks = /say which|more than one/i.test(failed.reason);
          const d = decisionOf({ op: "device.choose", confidence: 0, policy: asks ? "ask" : "done", source: "rules", why: failed.reason, ...(failed.deviceId ? { deviceId: failed.deviceId } : {}) });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `device: ${failed.reason}`, executor: "none", ...(failed.deviceId ? { target: failed.deviceId } : {}), jev: d, outcome: asks ? "asked" : "refused" });
          // More than one device could be meant: ONE useful question naming them, and nothing runs anywhere until he says (acceptance #5).
          const which = asks ? /\(([^)]+)\)/.exec(failed.reason)?.[1]?.split(/,\s*/).filter(Boolean) ?? [] : [];
          const said = failed.reason === "device offline" && failed.deviceId
            ? `${label(failed.deviceId)} is offline, so nothing ran. I never send your commands to another machine.`
            : which.length > 1
              ? `Which one: ${which.slice(0, -1).join(", ")} or ${which.at(-1)}? Nothing has run yet.`
              : (noCompanionLine(principal.personId, failed.reason, nowMs) ?? `Not done: ${failed.reason}. Nothing ran on any other machine.`);
          return { type: "done", ok: false, said, kind: asks ? "ask" : "refused", ...(asks ? { ask: true } : { refused: true }), jobId: null, runId: "", targetDeviceId: deviceId, decision: d };
        });
      }
      const deviceId = target.deviceId;
      const owner = target.owner as Exclude<typeof target.owner, "shared">; // a shared computer was refused above

      // 5a. The hub (this PC): the Jarvis entry. Only for the person AT this PC (it acts on this screen).
      if (deviceId === deps.hubDeviceId) {
        return start(deviceId, async (ctx, out) => {
          if (principal.via !== "loopback-owner") {
            const d = decisionOf({ op: "device.choose", confidence: 1, policy: "done", source: "rules", deviceId, why: "the hub's screen acts only for someone at the PC" });
            out({ type: "decision", decision: d, seq: 0 });
            note(ctx, { intent: "device: the hub acts only for someone at this PC", executor: "none", target: deviceId, jev: d, outcome: "refused" });
            return { type: "done", ok: false, refused: true, said: "That acts on this PC's screen, so it runs only for someone sitting at it. Nothing ran.", kind: "refused", jobId: null, runId: "", targetDeviceId: deviceId, decision: d };
          }
          // (Linked steps read from his words, at the PC: the entry answers them exactly as it always has.)
          if (steps?.length && !how.fromWords) return { type: "done", ok: false, refused: true, said: "A step-by-step plan runs on a paired companion PC, not on the hub's own screen, so nothing ran.", kind: "refused", jobId: null, runId: "", targetDeviceId: deviceId };
          const entry = deps.entry();
          if (!entry) return { type: "done", ok: false, said: "Jarvis's hands aren't available on this server, so nothing ran.", kind: "unavailable", jobId: null, runId: "", targetDeviceId: deviceId };
          // Jev already chose the lane (the service's one decision): it is the job's decision, and the entry fills the exact arguments without
          // asking Jev again. Jev out: the entry's exact lanes run, labelled fallback.
          if (how.decided) out({ type: "decision", decision: { ...how.decided, deviceId }, seq: 0 });
          if (how.recovery) recordJevMiss(ctx.jobId, how.recovery);
          return hubRun(entry, ctx, out, { utterance, deviceId, owner, surface, source, pageContext, ...(how.decided ? { decided: { lane: how.decided.op === "screen.goal" ? "device.screen" as const : "device.open" as const, confidence: how.decided.confidence } } : {}), ...(how.recovery ? { jevUnavailable: how.recovery } : {}) });
        });
      }

      // 5b. A companion (the requester's own PC): a typed plan of ExecutorCalls, each dispatched, checked and recorded.
      // Jev unavailable and this is an exact, supported step: the labelled deterministic fallback, with the reason on the job's decision, a job
      // receipt and the reply (said the first time in a while; always in numbers.jev). Open-ended words never get here without Jev.
      const recovery = how.recovery && !how.decided ? how.recovery : null;
      return start(deviceId, async (ctx, out) => {
        if (recovery) recordJevMiss(ctx.jobId, recovery);
        const done = await remoteRun(ctx, out, { principal, utterance, spokenTarget, originDeviceId, deviceId, rule, steps, decisionOf, note, ...(how.decided ? { decided: { ...how.decided, deviceId } } : {}), ...(recovery ? { recovery: `deterministic fallback (Jev unavailable: ${recovery}), exact rule` } : {}) });
        if (!recovery) return done;
        const last = toldRecovery.get(principal.personId);
        const say = last === undefined || nowMs - last >= NO_COMPANION_REPEAT_MS;
        if (say) toldRecovery.set(principal.personId, nowMs);
        return { ...done, said: say && !done.stopped ? `${done.said} (Jev is off, so that ran by an exact rule.)` : done.said, numbers: { ...(done.numbers ?? {}), jev: { state: "unavailable", reason: recovery, recovery: "exact-rule" } } };
      });
    };


    /**
     * "switch back to the website we were using" / "go back to that page" / "back to PowerPoint": resolved against what THIS person
     * recently used on THIS device (verified steps only), excluding what is in front now; ambiguous asks; focus is verified on the PC.
     * Null when it is not such a phrase, or the device is not a companion that can do it (the normal path then runs unchanged).
     */
    const switchBack = (ref: SwitchRef): Promise<CommandDoneEvent> | null => {
      if (!deps.supports || !deps.dispatcher) return null;
      const origin = principal.via === "loopback-owner" ? deps.hubDeviceId : principal.via === "companion" ? principal.deviceId : (deps.micOwner?.(principal.personId) ?? undefined);
      let t: ResolveResult;
      try {
        t = deps.resolveTarget({ personId: principal.personId, ...(spokenTarget ? { spokenTarget } : {}), ...(origin ? { originDeviceId: origin } : {}) });
      } catch {
        return null;
      }
      if (!t.ok || t.deviceId === deps.hubDeviceId || !deps.supports(t.deviceId, "target.focus")) return null;
      const deviceId = t.deviceId;
      return start(deviceId, async (ctx, out) => {
        const base = { jobId: null, runId: "", targetDeviceId: deviceId } as const;
        const d = decisionOf({ op: "target.switch-back", target: ref.said.slice(0, 60), confidence: 1, policy: "act", source: "context", deviceId, why: `"${ref.said.slice(0, 60)}" resolved against what you recently used on ${label(deviceId)}` });
        out({ type: "decision", decision: d, seq: 0 });
        const submit = (executor: string, args: Record<string, unknown>, stepId: string) =>
          deps.dispatcher!.submit({ personId: principal.personId, executor, args, jobId: ctx.jobId, stepId, pinDeviceId: deviceId, ...(origin ? { originDeviceId: origin } : {}), ...(spokenTarget ? { spokenTarget } : {}) }, { timeoutMs: deps.remoteTimeoutMs ?? 60_000, signal: ctx.signal });
        // What is in front now (read-only), so the current page is never "the one to go back to".
        let front: { process: string; title: string } | null = null;
        const looked = await submit("observe.window", {}, "s1");
        if (looked.ok && !looked.local && isExecutorResult(looked.result)) {
          const f = (looked.result.data as { foreground?: { process?: string; title?: string } } | undefined)?.foreground;
          if (f?.process) front = { process: String(f.process), title: String(f.title ?? "") };
          note(ctx, { intent: `switch back: ${front ? `${front.process} is in front` : "nothing readable in front"}`, executor: "companion", target: deviceId, action: "observe.window", jev: d, outcome: "ok", verification: { method: "companion-check", ok: true } });
        } else if (ctx.signal.aborted) return { type: "done", ok: false, stopped: true, said: "Stopped.", kind: "remote", decision: d, ...base };
        const res = resolveSwitch(ref, recentTargets.list(principal.personId, deviceId), front);
        if (res.kind === "ambiguous") {
          const names = res.options.map((o) => `"${o.title.slice(0, 50)}"`);
          const said = `Which one: ${names.slice(0, -1).join(", ")}${names.length > 1 ? " or " : ""}${names.at(-1)}?`;
          note(ctx, { intent: `switch back: ambiguous (${res.options.length}): ${names.join(", ")}`, executor: "none", target: deviceId, jev: d, outcome: "asked" });
          return { type: "done", ok: false, ask: true, said, kind: "ask", verified: null, decision: d, ...base };
        }
        if (res.kind === "none") {
          const said = res.why === "only-current" ? "That's already what's in front." : res.why === "no-match" ? "I don't have a recent page or app like that on this PC to go back to." : `I don't have anything recent on ${label(deviceId)} to go back to.`;
          note(ctx, { intent: `switch back: ${res.why}`, executor: "none", target: deviceId, jev: d, outcome: "refused" });
          return { type: "done", ok: false, refused: true, said, kind: "refused", verified: null, decision: d, ...base };
        }
        const tg = res.target;
        out({ type: "narrate", stage: "act", text: `On ${label(deviceId)}: switching back to ${tg.title.slice(0, 60)}.`, speak: true });
        const started = Date.now();
        const r2 = await submit("target.focus", { kind: tg.kind, title: tg.title, ...(tg.url ? { url: tg.url } : {}), ...(tg.app ? { app: tg.app } : {}), ...(tg.targetId ? { targetId: tg.targetId } : {}) }, "s2");
        const x = r2.ok && !r2.local && isExecutorResult(r2.result) ? r2.result : !r2.ok && isExecutorResult(r2.result) ? r2.result : null;
        if (x?.data && (x.data as { recovery?: unknown }).recovery === "tab-closed" && tg.targetId) recentTargets.forget(principal.personId, deviceId, tg.targetId);
        const ok = !!x && x.ok && x.verified === true && r2.ok;
        note(ctx, { intent: `companion target.focus: ${x ? x.said : r2.ok ? "no readable result" : r2.reason}`, executor: "companion", target: deviceId, action: "target.focus", jev: d, ms: Date.now() - started, outcome: ok ? "ok" : ctx.signal.aborted ? "cancelled" : r2.ok || !("uncertain" in r2 && r2.uncertain) ? "failed" : "unknown", verification: { method: "companion-check", ok: x ? x.verified : null, ...(x?.evidence ? { evidence: x.evidence.slice(0, 200) } : {}) } });
        if (ctx.signal.aborted) return { type: "done", ok: false, stopped: true, said: "Stopped.", kind: "remote", decision: d, ...base };
        if (!r2.ok) return { type: "done", ok: false, said: "uncertain" in r2 && r2.uncertain ? `${label(deviceId)} went offline while switching, so I can't say whether it happened. I haven't tried again.` : `Not done on ${label(deviceId)}: ${r2.reason.slice(0, 160)}`, kind: "remote", decision: d, verified: "uncertain" in r2 && r2.uncertain ? null : false, ...("uncertain" in r2 && r2.uncertain ? { outcome: "uncertain" } : { outcome: "unverified" }), ...base };
        return { type: "done", ok, said: ok ? x!.said : x ? (x.ok ? `${x.said} I couldn't confirm it.` : x.said) : "No readable result.", kind: "remote", decision: d, verified: x ? x.verified : null, ...(ok ? {} : { outcome: "unverified" }), ...base };
      });
    };

    // Attach a repeated voice/typed command to the first job while it runs or just after it succeeds.
    const earlier = dedupeKey ? recent.get(dedupeKey) : undefined;
    const twin = DEDUPE_MS > 0 && earlier && nowMs - earlier.at <= DEDUPE_MS ? live.get(earlier.jobId) : undefined;
    if (twin && twin.personId === principal.personId && (!twin.done || (twin.done.ok && !twin.done.stopped)))
      return new Promise<CommandDoneEvent>((resolve) => {
        for (const e of twin.events) emit(e);
        if (twin.done) return resolve(twin.done);
        const follow = (e: CommandStreamEvent) => {
          emit(e);
          if (e.type === "done") {
            twin.listeners.delete(follow);
            resolve(e);
          }
        };
        twin.listeners.add(follow);
      });

    // 1. Hard refusals: before any device, context or model. Only secrets and private data are refused here.
    //    A money REQUEST is not (owner decision 29 Sep: "money requests are fine"): it goes to the routing
    //    below like any other, and EXECUTING it stays gated where it would run (screen_act refuses money
    //    goals and screens, the browser never presses a final or money button, the app browser never opens a
    //    money site, control_pc refuses money and trading). A read-only money QUESTION ("what's my bank
    //    balance") stays off the coding lane (F16, REVIEW-T2 #4); a code change that only NAMES a money
    //    feature goes to Track 3's coding draft as before (REVIEW-T3 F7b).
    const goalRefusal = screenGoalRefusal(raw);
    const moneyRead = readOnlyMoneyQuestion(raw) && !!goalRefusal;
    const refusal = goalRefusal?.kind === "secret-or-private-data" ? goalRefusal : null;
    if (refusal)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "refuse", confidence: 1, policy: "done", source: "rules", why: `refused in code: ${refusal.kind}` });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `refused: ${refusal.kind}`, executor: "none", jev: d, outcome: "refused" });
        return { type: "done", ok: false, said: refusal.said, kind: "refused", refused: true, jobId: null, runId: "", targetDeviceId: "none", decision: d };
      });

    // 1b. A typed plan (body.steps) for the requester's own companion: it skips the word rules and runs the plan, step by step.
    if (body.steps?.length) return toDevice(null, body.steps);

    // 2b. What the exact rules make of the words. Jev configured: these only FILL Jev's chosen lane (URL, verbatim query, ordered steps) and
    //     validate it, or run as the labelled fallback when Jev is unavailable. No Jev configured (tests, legacy callers): they route, as before.
    const exactRule = planRules(utterance);
    const routine = exactRule?.lane === "executor";
    const linked = linkedSteps(utterance);
    // A money move named in the words never reaches the harness, unless it is plainly a code change. A delegated order ("have Codex
    // buy 10 Tesla shares and Opus review it") is the same order: the wrapper is stripped and the words judged again.
    const undelegated = raw.replace(/\b(?:have|get|tell|ask|let|make)\s+[\w-]+\s+(?:to\s+)?(?=(?:buy|sell|pay|transfer|trade|bet|purchase|invest|wire|refund)\b)/gi, "");
    const moneyBlocked = moneyRead || !!codingMoneyRefusal(raw) || !!codingMoneyRefusal(undelegated) || ((!!goalRefusal || !!screenGoalRefusal(undelegated)) && !codeChangeNotPayment(raw));
    const codingTurn = { personId: principal.personId, actor: principal.actor === "human" ? ("human" as const) : ("process" as const), via: principal.via === "loopback-owner" ? "local" : principal.via === "telegram-owner" ? "telegram" : "tailnet", spokenYes: typeof body.spokenYes === "string" ? body.spokenYes : null, channel: source === "voice" ? ("voice" as const) : ("typed" as const), ...(typeof body.conversationId === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(body.conversationId) ? { conversationId: body.conversationId } : {}) };

    /** Jev leads task routing (a controller is configured and this is a person's typed or spoken request). */
    const jevLed = !!deps.controller && (source === "typed" || source === "voice");
    /** A whole-utterance answer to a question Jarvis asked: the only words besides Stop that are handled before Jev. */
    const isAnswer = ANSWER_WORDS.test(raw);
    // Round 11: a whole-utterance Stop ("cancel the draft", "please stop the coding job") while the coding planner is waiting for an answer goes
    // straight to the coding harness, like the bare Stop above: a Stop skips Jev. The harness drops the pending question (never taking the words as
    // its answer) and, when the words name a running coding job, stops that job too.
    if (deps.delegates?.coding && !body.target?.bot && source !== "acceptance" && source !== "away" && isStopCommand(raw) && !moneyBlocked && (await deps.delegates.codingPendingQuestion?.(codingTurn).catch(() => false))) {
      const r = await deps.delegates.coding(raw, codingTurn).catch(() => null);
      if (r) return codingDone(r, decisionOf({ op: "coding.stop", ...(r.jobId ? { target: r.jobId.slice(0, 8) } : {}), confidence: 1, policy: "done", source: "rules", why: "an explicit Stop for the coding draft or job: a Stop skips Jev" }));
    }


    // A compound read request with an unsupported/action clause must never execute a prefix or
    // reach a different mutating delegate. With Jev, keep its decision/evidence, then ask below.
    const businessQuestions = businessQuestionsIn(utterance);
    if (businessQuestions?.kind === "unsupported") {
      if (jevLed) return jevFirst(body.target?.bot ? { bot: body.target.bot } : {});
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "crm.questions", confidence: 1, policy: "ask", source: "rules", why: "not every clause is a supported read-only business question" });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: d.why, executor: "none", jev: d, outcome: "asked" });
        return { type: "done", ok: false, ask: true, said: "I can combine up to four supported read-only business questions. This request includes something else, so I haven't run any of it. Ask those parts separately.", kind: "ask", decision: d, verified: null, jobId: null, runId: "", targetDeviceId: "none" };
      });
    }

    // 1b'. Read lanes for the OS's own data (5 Oct): a plain question about the calendar, what needs him, AI spend, a deal's stage or next
    // action, or what an agent is doing is answered from the real service by rule. No Jev decision is needed to READ, so a Jev outage or an
    // unsure Jev never turns these into "nothing ran" or "where should that run?". Never for a bot's turn, a named device or an answer word.
    if (!body.target?.bot && !spokenTarget && !isAnswer && businessQuestions?.kind !== "questions" && source !== "acceptance" && source !== "away" && isBrowserPrincipal(principal)) {
      const mk = (op: string, to: "voice-tools", why: string) => decisionOf({ op, confidence: 1, policy: "delegate", delegateTo: to, source: "rules", why });
      const answer = (op: string, to: "voice-tools", why: string, read: () => Promise<{ ok: boolean; said: string }>) =>
        start("none", async (ctx, out) => {
          const d = mk(op, to, why);
          out({ type: "decision", decision: d, seq: 0 });
          const r = await read().catch(() => ({ ok: false, said: "That service didn't answer, so I won't guess." }));
          note(ctx, { intent: `${op}: ${r.said.slice(0, 160)}`, executor: to, jev: d, outcome: r.ok ? "ok" : "failed", verification: { method: `${to}-service`, ok: r.ok } });
          return { type: "done", ok: r.ok, said: r.said, kind: r.ok ? "answer" : "unavailable", jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: r.ok };
        });
      const bots = mayUseBots(principal) ? (deps.bots?.list?.() ?? []) : [];
      const read = osReadIn(utterance, bots);
      if (read?.kind === "calendar")
        return answer("os.read.calendar", "voice-tools", "today's or tomorrow's saved calendar events, read by rule", async () => {
          const events = deps.delegates?.reads?.calendar ? await deps.delegates.reads.calendar() : null;
          return events ? { ok: true, said: calendarSaid(events, read.day, nowOf()) } : { ok: false, said: "The calendar isn't connected on this server, so I can't read it from here." };
        });
      if (read?.kind === "needs")
        return answer("os.read.needs-you", "voice-tools", "what needs him: the same panels Home reads, by rule", async () => (deps.delegates?.reads?.needsYou ? { ok: true, said: await deps.delegates.reads.needsYou(principal) } : { ok: false, said: "The needs-you list isn't connected on this server, so I can't read it from here." }));
      if (read?.kind === "agent")
        return answer("os.read.agent-status", "voice-tools", `the ${read.name} agent's jobs, read from the job store by rule`, async () => ({ ok: true, said: agentStatusSaid(read.name, deps.jobs().list({ bot: read.botId, limit: 20 }), nowOf()) }));
      // AI spend ("how much have we spent on AI this month"): the same snapshot the Finance page's "AI spend" tile shows, for a confirmed
      // founder wherever he is (the ai_usage skill is for the PC itself and refused a remote session, 5 Oct).
      const spend = aiSpendAsked(utterance);
      if (spend && deps.delegates?.reads?.aiTotals)
        return answer("os.read.ai-spend", "voice-tools", "AI spend: the usage snapshot the Finance page reads, by rule", async () => ({ ok: true, said: aiSpendSaid(await deps.delegates!.reads!.aiTotals!(), spend.month) }));
      if (!deps.delegates?.reads?.aiTotals && deps.delegates?.skill?.match(utterance) === "ai_usage")
        return answer("skill.ai_usage", "voice-tools", "the AI usage figures, read by rule", () => deps.delegates!.skill!.run(utterance, principal));
      // A deal's stage or next action: the CRM's own typed reads (never a write, never a search the brain paraphrases).
      const crmRead = crmIntentIn(utterance);
      if (deps.delegates?.crm && crmRead && "kind" in crmRead && (crmRead.kind === "stage" || crmRead.kind === "next"))
        return delegate({ lane: "delegate", to: "crm", op: "crm.operation", why: `a CRM read (${crmRead.kind}): the CRM's own typed operations, by rule` }, principal, input.memoryCaller, utterance, body, start, decisionOf, note, undefined, undefined, followed?.record);
    }

    // 1c. An agent bot's request (Agents workspace; linked-run.ts resolved the bot and put it in `body.target`): it runs on THAT bot's computer, or as
    // that bot's coding job, and nothing here ever falls through to the person's own device or the hub. A money action is refused by name; a code
    // change that only NAMES a money feature is still code. The bot's own words about what it did come back as the one line.
    if (deps.bots && body.target?.bot && source !== "acceptance") {
      // The words a bot gets are the request WITHOUT "have a builder": a code change that only names a money feature ("fix this on Claude Max 2") is judged with its frame.
      const framed = `Have a builder ${raw}`;
      const blocked = moneyRead || !!codingMoneyRefusal(raw) || !!codingMoneyRefusal(framed) || (!!goalRefusal && !codeChangeNotPayment(raw) && !codeChangeNotPayment(framed));
      if (blocked) return { type: "done", ok: false, said: goalRefusal?.said ?? codingMoneyRefusal(raw) ?? "That is a money action, and no bot does those from here. Nothing ran.", kind: "refused", refused: true, jobId: null, runId: "", targetDeviceId: "none" };
      if (!mayUseBots(principal)) return { type: "done", ok: false, said: BOT_NEEDS_SESSION, kind: "refused", refused: true, jobId: null, runId: "", targetDeviceId: "none" };
      // Naming the agent fixes the TARGET; a new task for it is still Jev's decision (with that agent as the only target). Only a bare name
      // (where the agent stands) and an answer to its own question go straight to it.
      if (jevLed && raw.trim() && !isAnswer) return jevFirst({ bot: body.target.bot });
      stopGuard(); // final review B1: never start an agent or computer job for a stopped event
      const b = await afterJob(await deps.bots.run({ principal, bot: body.target.bot, utterance: raw, source, spokenYes: typeof body.spokenYes === "string" ? body.spokenYes : null, ...(body.subjects?.length ? { subjects: body.subjects } : {}), pageContext }).catch((e: Error) => ({ ok: false, said: `The bot didn't answer (${String(e?.message ?? e).slice(0, 100)}), so its outcome is not confirmed. Check its jobs before starting new work.`, unverified: true as const })));
      if (b) {
        const navigate = "navigate" in b ? b.navigate : undefined;
        const numbers = "numbers" in b ? b.numbers : undefined;
        return { type: "done", ok: b.ok, said: b.said, ...("unverified" in b && b.unverified === true ? { outcome: "unverified" } : {}), kind: navigate ? "navigate" : numbers && ("codingJobId" in numbers || "draft" in numbers) ? "answer" : "remote", ...(navigate ? { navigate: { path: navigate } } : {}), ...("ask" in b && b.ask ? { ask: true } : {}), ...(numbers ? { numbers } : {}), jobId: ("jobId" in b && b.jobId) || null, runId: "", targetDeviceId: ("deviceId" in b && b.deviceId) || "none", verified: null };
      }
      // The bot had nothing to say to this and the words are not the person's own device: nothing ran, and it is never sent anywhere else.
      return { type: "done", ok: false, said: "That isn't something this bot can do from here, so nothing ran. Nothing went to any other machine.", kind: "refused", refused: true, jobId: null, runId: "", targetDeviceId: "none" };
    }

    // "continue that job" on a page that shows a job: THAT job, never "the latest computer job". A job still going is left alone,
    // a question waiting is not answered for him, and one that ended is reported as it ended and never run again.
    {
      const pageJob = CONTINUE_JOB.test(utterance.trim()) ? jobIdOf(commandContext.context) : null;
      if (pageJob && !goalRefusal)
        return start("none", async (ctx, out) => {
          const job = deps.jobs().get(pageJob);
          const d = decisionOf({ op: "job.continue", target: pageJob.slice(0, 8), confidence: 1, policy: "act", source: "context", why: `the job the page shows (${commandContext.from} page context)` });
          out({ type: "decision", decision: d, seq: 0 });
          const base = { jobId: null, runId: "", targetDeviceId: "none" } as const;
          if (!job) {
            note(ctx, { intent: "continue: that job isn't in the job log", executor: "none", jev: d, outcome: "asked" });
            return { type: "done", ok: false, ask: true, said: "I can't find that job in the job log, so I won't guess. Which job do you mean?", kind: "ask", decision: d, ...base };
          }
          const title = job.title || "That job";
          const where = job.targetDeviceId && job.targetDeviceId !== "none" ? ` on ${label(job.targetDeviceId)}` : "";
          const n = job.steps.length;
          const going = job.state === "running" || job.state === "queued";
          const said = going
            ? `${title} is still running${where}, ${n} step${n === 1 ? "" : "s"} in. I've left it alone.`
            : job.state === "awaiting-approval"
              ? `${title} is waiting for your yes${job.note ? `: ${job.note.replace(/^Waiting for your yes:\s*/i, "").slice(0, 100)}` : ""}. Say yes out loud to go ahead.`
              : job.state === "succeeded"
                ? `${title} already finished.`
                : `${title} ${job.state === "unknown" ? "ended with an unknown outcome, so one step may or may not have happened" : job.state === "cancelled" ? "was stopped" : "stopped early"}${job.note ? `: ${job.note.slice(0, 100)}` : ""}. I won't run it again blindly; tell me the next goal.`;
          note(ctx, { intent: `continue: ${title} is ${job.state}; nothing was re-run`, executor: "deterministic", jev: d, outcome: "ok", verification: { method: "job-log", ok: true, evidence: job.state } });
          return { type: "done", ok: going || job.state === "succeeded" || job.state === "awaiting-approval", said, kind: "answer", decision: d, numbers: { jobId: job.id, state: job.state }, verified: true, ...base };
        });
    }

    // Shared cloud computers ("use the research computer to ...", "show me the research bot", "continue that job"): before page context,
    // which would otherwise read "that job" as a page item. Money or secret words never reach a computer from here.
    if (businessQuestions?.kind !== "questions" && deps.delegates?.computers && !moneyRead && !goalRefusal && !codingMoneyRefusal(raw) && source !== "acceptance") {
      // A NEW task on a shared computer he named: the name fixes the target, Jev decides the task. ("Show" and "continue" are about the job
      // and computer already there: no new routing decision, so its established route and pins stay as they are.)
      const named = jevLed ? parseComputerCommand(utterance, []) : null;
      if (named?.kind === "use") return jevFirst({ computer: named.name });
      stopGuard(); // final review B1: never start an agent or computer job for a stopped event
      const c = await afterJob(await deps.delegates.computers(utterance, principal).catch((e: Error) => ({ ok: false, said: `The computers service didn't answer (${String(e?.message ?? e).slice(0, 100)}), so its outcome is not confirmed. Check its jobs before starting new work.`, unverified: true as const })));
      if (c) {
        const navigate = "navigate" in c ? c.navigate : undefined;
        return { type: "done", ok: c.ok, said: c.said, ...("unverified" in c && c.unverified === true ? { outcome: "unverified" } : {}), kind: navigate ? "navigate" : "remote", ...(navigate ? { navigate: { path: navigate } } : {}), jobId: ("jobId" in c && c.jobId) || null, runId: "", targetDeviceId: ("deviceId" in c && c.deviceId) || "none", verified: null };
      }
    }
    // 1c. "switch back to the website we were using": what this person recently used on their own device (recent-targets.ts).
    {
      // (Jev leading: the task is Jev's decision; "switch back" then fills his device lane, below.)
      const back = jevLed ? null : switchBackIn(utterance);
      const handled = back ? switchBack(back) : null;
      if (handled) return handled;
    }

    // 2. Page context: "explain this margin", "open that call". Resolved, or asked; never guessed.
    // A whole-utterance answer ("start it", "yes") answers the pending question; its "it" is never a page reference (production 4 Oct: a typed
    // "start it" from /jarvis arrived with the page context and got "I can't tell which item you mean" instead of starting the draft).
    const ref = isAnswer || businessQuestions?.kind === "questions" ? null : commandContext.reference;
    // "open this lead's website": the lead the page shows, its website from the CRM, opened on the person's own device like any typed step.
    if (ref && commandContext.resolution?.kind === "resolved" && SITE_KINDS.has(commandContext.resolution.item.kind) && OPEN_SITE.test(utterance)) {
      const item = commandContext.resolution.item;
      const tier = commandContext.resolution.tier;
      const found = item.kind === "lead" && deps.delegates?.leadSite ? await deps.delegates.leadSite(item.id).catch(() => null) : null;
      const website = publicUrl(item.kind === "lead" && deps.delegates?.leadSite ? found?.website : (item.data?.website ?? item.data?.url));
      const name = found?.name || item.label;
      const lookedUpMissing = item.kind === "lead" && !!deps.delegates?.leadSite && found === null;
      if (!website)
        return start("none", async (ctx, out) => {
          const d = decisionOf({ op: "context.open", target: name, confidence: 1, policy: "done", source: "context", why: `"${name}" is the ${tier} ${item.kind}, and it has no website on file` });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `context: ${item.kind} "${name}" has no website on file; nothing opened`, executor: "none", jev: d, outcome: "refused" });
          return { type: "done", ok: false, refused: true, said: lookedUpMissing ? `I can't find ${name} in the CRM, so I didn't open anything.` : `${name} has no website on file, so I didn't open anything.`, kind: "refused", jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
        });
      // Context resolved the URL; with Jev leading, Jev decides the task (the URL is the only page it can open here).
      if (jevLed) return jevFirst({ context: { step: { executor: "open-url", args: { url: website } }, name } });
      return toDevice(null, [{ executor: "open-url", args: { url: website } }]); // the plain Windows open (default browser), never agent-browser
    }
    if (ref && jevLed && commandContext.resolution?.kind === "resolved") return jevFirst({ context: { item: commandContext.resolution.item, tier: commandContext.resolution.tier } });
    if (ref)
      return start("none", async (ctx, out) => {
        const res = commandContext.resolution!;
        if (res.kind !== "resolved") {
          const d = decisionOf({ op: "context.resolve", target: ref.noun ?? ref.word, confidence: 0, policy: "ask", source: "context", why: res.kind === "ambiguous" ? `${res.candidates.length} matching items on the page` : commandContext.from === "stale" ? "the page context is too old to trust" : pageContext ? "nothing on the page matches" : "no page context was sent" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `context: ${d.why}`, executor: "none", jev: d, outcome: "asked" });
          return { type: "done", ok: false, ask: true, said: res.said, kind: "ask", jobId: null, runId: "", targetDeviceId: "none", decision: d };
        }
        return contextual(ctx, out, utterance, res.item, res.tier, pageContext!, decisionOf);
      });

    // 2c. Jev-led routing (owner decision, round 10): with Jev configured, EVERY typed or spoken task request reaches Jev's one decision first.
    if (jevLed) return jevFirst();

    // (No Jev configured: the exact rules route, unchanged.)
    if (linked && linked.length > 1 && !goalRefusal) return toDevice(null, linked.map((s) => ({ executor: s.executor, args: s.args })), { fromWords: true });

    // 3. Coding work (Track 3's harness): drafted, then started only by a person's own "start it". The entry shares the
    //    voice's per-person state, so typed and spoken turns are one conversation. A draft page stays the fallback when the
    //    harness isn't running here. Nothing starts from this line.
    // An explicit business-record request ("draft a quote for the Orchard website deal", "create a task for the Orchard site deal: ...") is the CRM's even
    // when it says "site" or "website": the CRM forms each name a record kind and are tried before the coding words (business owner, r10).
    const crmWords = businessQuestions?.kind === "questions" || !!crmIntentIn(utterance);
    if (deps.delegates?.coding && !crmWords && !moneyBlocked && !routine && source !== "away" && source !== "acceptance") {
      // An account or model named as the worker ("using Opus on Claude Max 2") is a PIN for this job only: passed as structured fields,
      // saved on the job so retries and the automatic fallback never move it; an account this server doesn't have is refused by name with
      // the ones it does (never swapped, never a paid API). Words naming neither pin nothing: the worker is chosen for this task (Auto).
      const isCoding = deps.delegates.codingMatches ? deps.delegates.codingMatches(utterance) : isCodingRequest(utterance);
      const pinned = isCoding ? resolvePin(utterance, deps.pinCatalogue?.() ?? null) : ({ kind: "none" } as const);
      if (pinned.kind === "refused")
        return start("none", async (ctx, out) => {
          const d = decisionOf({ op: "coding.pin", confidence: 1, policy: "done", source: "rules", why: "the account or model he named isn't available here; nothing was swapped in" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `coding pin refused: ${pinned.said.slice(0, 160)}`, executor: "none", jev: d, outcome: "refused" });
          return { type: "done", ok: false, refused: true, said: pinned.said, kind: "refused", numbers: { pin: "refused", alternatives: pinned.alternatives }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
        });
      const pin = pinned.kind === "pin" ? pinned.pin : null;
      earlyDispatch = Date.now();
      stopGuard(); // final review B1: never start coding work for a stopped event
      const r = await afterCoding(await deps.delegates.coding(utterance, { personId: principal.personId, actor: principal.actor === "human" ? "human" : "process", via: principal.via === "loopback-owner" ? "local" : principal.via === "telegram-owner" ? "telegram" : "tailnet", spokenYes: typeof body.spokenYes === "string" ? body.spokenYes : null, channel: source === "voice" ? "voice" : "typed", ...(pin ? { pin } : {}) }).catch(() => null));
      if (!r) earlyDispatch = undefined;
      if (r)
        return start("none", async (ctx, out) => {
          const d = decisionOf({ op: "coding.turn", ...(r.jobId ? { target: r.jobId.slice(0, 8) } : {}), confidence: 1, policy: "delegate", delegateTo: "coding", source: "rules", why: pin ? `coding words, pinned to ${[pin.model, pin.accountSlot].filter(Boolean).join(" on ")} for the whole job` : "coding words: the coding harness's own draft, start and status rules; the worker is chosen for this task" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `coding: ${r.say.slice(0, 160)}`, executor: "coding", jev: d, outcome: "ok" });
          return { type: "done", ok: true, said: source === "voice" && r.draft ? spokenDraft(r.say, r.draft) : r.say, kind: r.navigate ? "navigate" : "answer", ...(!r.jobId && !r.navigate && !r.draft && /\?\s*$/.test(r.say) ? { ask: true } : {}), ...(r.navigate ? { navigate: { path: r.navigate } } : {}), numbers: { ...(r.jobId ? { codingJobId: r.jobId } : {}), ...(r.jobState ? { codingJobState: r.jobState } : {}), ...(r.draft ? { draft: r.draft, fullSummary: r.say } : {}), ...(r.drafted ? { codingDrafted: true } : {}), ...(r.started ? { codingStarted: true } : {}) }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
        });
    }
    const coding = moneyBlocked || routine || crmWords || deps.delegates?.coding ? null : codingDraftFor(utterance);
    if (coding)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "coding.draft", target: coding.path.split("?")[0], confidence: 1, policy: "delegate", delegateTo: "coding", source: "rules", why: "coding work: the coding workspace drafts it and waits for a confirm" });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: "coding: opened the Coding draft (nothing starts until he confirms the plan)", executor: "none", jev: d, outcome: "ok" });
        return { type: "done", ok: true, said: "Opening a coding draft with that request. It shows the plan, repo and agents, then asks \"Start it?\"; nothing starts until you confirm.", kind: "navigate", navigate: { path: coding.path }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
      });

    // 3'. Deterministic delegates: memory, leads, reminders, receptionist (their own services; recorded here).
    const rule = planRules(utterance);
    if (rule?.lane === "delegate") return delegate(rule, principal, input.memoryCaller, utterance, body, start, decisionOf, note, undefined, undefined, followed?.record);
    // A command with a step no executor runs in the same breath ("type 'hi' then email it"): nothing runs,
    // and he's told exactly which step (REVIEW-T2 #2). Never half-done and called done.
    const goalOnCompanion = () => {
      // A compound goal ("open chrome and go to example.com") goes to the requester's own companion when it runs screen.goal.
      if (rule?.lane !== "unsupported" || !deps.supports) return false;
      const origin = principal.via === "loopback-owner" ? deps.hubDeviceId : principal.via === "companion" ? principal.deviceId : (deps.micOwner?.(principal.personId) ?? undefined);
      try {
        const t = deps.resolveTarget({ personId: principal.personId, ...(spokenTarget ? { spokenTarget } : {}), ...(origin ? { originDeviceId: origin } : {}) });
        return t.ok && t.deviceId !== deps.hubDeviceId && deps.supports!(t.deviceId, "screen.goal") && !screenGoalRefusal(utterance);
      } catch {
        return false;
      }
    };
    if (rule?.lane === "unsupported" && !planContinuation(utterance) && !goalOnCompanion())
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: rule.op, confidence: 1, policy: "ask", source: "rules", why: rule.why });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `not run: ${rule.why}`, executor: "none", jev: d, outcome: "asked" });
        return { type: "done", ok: false, ask: true, said: rule.said, kind: "ask", jobId: null, runId: "", targetDeviceId: "none", decision: d };
      });

    // 3a. Deterministic answers (AUDIT-F4 F9): margins from the economics model, prices from the catalogue.
    //     No device and no model: the same for both founders, wherever they are.
    const margin = parseMarginQuery(utterance);
    const prices = margin ? null : parsePriceQuery(utterance);
    if (margin || prices)
      return start("none", async (ctx, out) => {
        const a = margin ? marginAnswer(margin) : priceAnswer(prices!);
        const d = decisionOf({ op: margin ? "answer.margin" : "answer.price", target: margin ? margin.pkg.shortName : prices!.map((p) => p.shortName).join(", "), confidence: 1, policy: "act", source: "rules", why: margin ? "numbers from the economics model only" : "prices from the package catalogue only" });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `answer: ${d.op} (${a.numbers.source})`, executor: "deterministic", jev: d, outcome: "ok", verification: { method: "deterministic", ok: true, evidence: String(a.numbers.source) } });
        return { type: "done", ok: true, said: a.said, kind: "answer", numbers: a.numbers as Record<string, unknown>, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: true };
      });

    // 3a'. The read-only skills the voice rules answer (finance, time, maths…): the same answer typed.
    const skillName = deps.delegates?.skill?.match(utterance) ?? null;
    if (skillName && deps.delegates?.skill)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: `skill.${skillName}`, confidence: 1, policy: "delegate", delegateTo: "voice-tools", source: "rules", why: `the ${skillName} skill answers this by rules, exactly as spoken` });
        out({ type: "decision", decision: d, seq: 0 });
        const r = await deps.delegates!.skill!.run(utterance, principal).catch(() => ({ ok: false, said: "That skill didn't answer, so I won't guess." }));
        note(ctx, { intent: `skill ${skillName}: ${r.said.slice(0, 160)}`, executor: "skills", jev: d, outcome: r.ok ? "ok" : "failed", verification: { method: `${skillName}-skill`, ok: r.ok } });
        return { type: "done", ok: r.ok, said: r.said, kind: "answer", jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: r.ok };
      });

    // 3a''. A read-only money question no finance skill answers: the brain answers it (as spoken), and
    //       nothing acts. It never reaches a device lane.
    if (moneyRead)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "delegate.brain", confidence: 1, policy: "delegate", delegateTo: "brain", source: "rules", why: "a read-only question about money: answered, never acted on" });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: "handoff → brain: a read-only money question (nothing acts)", executor: "handoff", jev: d, outcome: "note" });
        return { type: "done", ok: false, kind: "handoff", said: "That's a question for the chat brain; nothing will be paid, moved or opened.", handoff: { to: "brain", intent: "money.question", reason: d.why, utterance }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
      });

    // 3b. An OS page ("open the receptionist page"): the UI opens it; no device acts.
    const page = osPageIn(utterance);
    if (page)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "navigate", target: page.path, confidence: 1, policy: "act", source: "registry", why: `the OS page ${page.label}` });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `navigate: ${page.path}`, executor: "none", jev: d, outcome: "ok" });
        return { type: "done", ok: true, said: `Opening ${page.label}.`, kind: "navigate", navigate: { path: page.path }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
      });

    // 5. Which device, then run there.
    return toDevice(rule, undefined);

    /**
     * Jev-led routing for a task request (owner decisions, round 10). Only Stop and a whole-utterance answer to a question are handled before
     * this; "continue that job" reports the existing job and never re-routes it (its route and pins stay). A NAMED agent or shared computer, a
     * device he named, a pinned account/model and what "this" on the page means are CONSTRAINTS: they fix the target or arguments, and the
     * options Jev is offered are built from them. Then:
     *   - Jev makes ONE bounded decision over those options; a choice outside them is REJECTED (recorded on a receipt) and he is asked, never
     *     reinterpreted;
     *   - the exact rules FILL the chosen lane (the URL, the verbatim query, the ordered steps) and validate it; permissions are checked again where
     *     it executes, every time (a cached decision included; only the decision is reused, the action runs again);
     *   - Jev unavailable (no key, a timeout, an error): only supported, safe exact actions run, labelled "fallback" with the reason on the step and
     *     a job receipt; everything else gets the plain outage line. Nothing is guessed.
     */
    async function jevFirst(constraint: JevConstraint = {}): Promise<CommandDoneEvent> {
      const newCoding = deps.delegates?.codingMatches ? deps.delegates.codingMatches(utterance) : isCodingRequest(utterance);
      // An answer to the coding harness's own question ("start it", "yes"): the harness's (an answer, not a new routing decision).
      if (isAnswer && deps.delegates?.coding && !moneyBlocked && !constraint.bot && !constraint.computer) {
        stopGuard(); // final review B1: never start coding work for a stopped event
        const r = await afterCoding(await deps.delegates.coding(utterance, codingTurn).catch(() => null));
        if (r) return codingDone(r, decisionOf({ op: "coding.turn", ...(r.jobId ? { target: r.jobId.slice(0, 8) } : {}), confidence: 1, policy: "delegate", delegateTo: "coding", source: "rules", why: "an answer to the coding harness's own question" }));
      }
      const fixedAgent = !!constraint.bot || !!constraint.computer;
      // A bare answer with no question waiting is an answer, not a task: said plainly, and Jev is not asked to route it.
      if (isAnswer && !fixedAgent)
        return start("none", async (ctx, out) => {
          const d = decisionOf({ op: "answer.none-pending", confidence: 1, policy: "done", source: "rules", why: "an answer with no question waiting" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: "no question is waiting for that answer", executor: "none", jev: d, outcome: "refused" });
          return { type: "done", ok: false, refused: true, kind: "refused", said: "Nothing is waiting for a yes or a no from you right now, so nothing was done.", decision: d, jobId: null, runId: "", targetDeviceId: "none" };
        });
      // Which device is HIS: from the verified person and session, never a body field, never the hub of a server.
      const origin = principal.via === "loopback-owner" ? deps.hubDeviceId : principal.via === "companion" ? principal.deviceId : (deps.micOwner?.(principal.personId) ?? undefined);
      let target: ResolveResult | null = null;
      try {
        target = deps.resolveTarget({ personId: principal.personId, ...(spokenTarget ? { spokenTarget } : {}), ...(origin ? { originDeviceId: origin } : {}) });
      } catch {
        target = null;
      }
      // A device he named that is ambiguous, missing or someone else's: the ONE device question, before anything is decided or run.
      if (!fixedAgent && spokenTarget && target && !target.ok) return toDevice(exactRule, undefined);
      const atHub = !!target?.ok && !!deps.hubDeviceId && target.deviceId === deps.hubDeviceId;
      const ownDevice = target?.ok && target.owner !== "shared" ? target.deviceId : null;
      const screen = atHub || (!!ownDevice && !!deps.supports?.(ownDevice, "screen.goal"));
      const margin = parseMarginQuery(utterance);
      const prices = margin ? null : parsePriceQuery(utterance);
      const skillName = deps.delegates?.skill?.match(utterance) ?? null;
      const page = osPageIn(utterance);
      const base = { jobId: null, runId: "", targetDeviceId: "none" } as const;

      // An account or model named as the worker is a PIN (an explicit constraint): one that can't be met is refused by name, never handed to Jev
      // to work around and never swapped. A pin that can be met makes the job a coding job: that is the only lane offered.
      // Round 11 (journey 9): an account he named that isn't here is refused even when the words aren't on the coding word list ("fix any typo
      // in the README, using Opus on Claude Max 3"): before, the pin was only read for listed coding words, so Jev routed it and the pin was lost.
      const named = !fixedAgent ? resolvePin(utterance, deps.pinCatalogue?.() ?? null) : ({ kind: "none" } as const);
      // Only for work he's asking to be done ("fix…", "add…", "using Opus on…"): a mention of the account ("connect Claude Max 3", "how much usage
      // is left on Claude Max 3") is not a pin and is never refused as one (review, round 11).
      const workWords = /\b(?:fix|build|add|change|update|edit|make|write|create|refactor|implement|remove|delete|rename|review|test|debug|correct|tidy|clean up|improve|rewrite|redesign|code|ship)\b/i.test(utterance);
      const pinned = newCoding || (named.kind === "refused" && workWords) ? named : ({ kind: "none" } as const);
      if (pinned.kind === "refused")
        return start("none", async (ctx, out) => {
          const d = decisionOf({ op: "coding.pin", confidence: 1, policy: "done", source: "rules", why: "the account or model he named isn't available here; nothing was swapped in" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `coding pin refused: ${pinned.said.slice(0, 160)}`, executor: "none", jev: d, outcome: "refused" });
          return { type: "done", ok: false, refused: true, said: pinned.said, kind: "refused", numbers: { pin: "refused", alternatives: pinned.alternatives }, decision: d, verified: null, ...base };
        });
      const pin = pinned.kind === "pin" ? pinned.pin : null;

      // ── the options, built from the constraints ──
      const agentList = mayUseBots(principal) ? (deps.bots?.list?.() ?? []).map((b) => ({ id: b.id, name: b.name, purpose: b.purpose ?? b.name })) : [];
      const fixedBot = constraint.bot ? (agentList.find((b) => b.id === constraint.bot) ?? { id: constraint.bot, name: deps.bots?.nameOf(constraint.bot) ?? constraint.bot, purpose: "the agent he named" }) : null;
      const deviceOption = { label: ownDevice ? label(ownDevice) : "his own computer", screen: ownDevice ? screen : true };
      const ctxItem = constraint.context?.item;
      const catalogue: Catalogue = fixedBot
        ? { device: null, brain: false, coding: false, bots: [fixedBot] }
        : constraint.computer
          ? { device: null, brain: false, coding: false, bots: [], computer: { name: constraint.computer } }
          : constraint.context?.step
            ? { device: { ...deviceOption, screen: false }, brain: true, coding: false, bots: [] }
            : ctxItem
              ? { device: null, page: !!ctxItem.href, answer: true, brain: true, coding: false, bots: [] }
              : pin
                ? { device: null, brain: false, coding: !!deps.delegates?.coding && !moneyBlocked, bots: [] }
                : spokenTarget && ownDevice
                  ? { device: deviceOption, brain: false, coding: false, bots: [] }
                  : {
                      // His own device is offered even when WHICH one is unclear or none is paired: choosing it then asks the one device question or
                      // says how to pair. It is never someone else's device and never a server hub's own screen.
                      device: deviceOption,
                      page: true,
                      answer: true,
                      brain: true,
                      coding: !!deps.delegates?.coding && !moneyBlocked,
                      bots: agentList,
                      crm: !!(deps.delegates?.crm || deps.delegates?.leads),
                      memory: !!deps.delegates?.memory && !!input.memoryCaller,
                    };
      const constraintWhy = fixedBot ? `the agent ${fixedBot.name} you named` : constraint.computer ? `the ${constraint.computer} computer you named` : constraint.context ? "the item on the page" : pin ? "the account or model you named" : spokenTarget && ownDevice ? "the device you named" : "what can run for you right now";
      // Ids only, never extra words: the page and the record he is looking at, the device or agent his request is fixed to.
      const pageItem = ctxItem ?? pageContext?.focused ?? pageContext?.selected?.[0];
      const context: Record<string, string> = {
        ...(pageContext?.page ? { page: pageContext.page } : {}),
        ...(pageItem ? { record: `${pageItem.kind}:${pageItem.id}` } : {}),
        ...(ownDevice && !fixedAgent ? { device: ownDevice } : {}),
        ...(fixedBot ? { agent: fixedBot.id } : {}),
        ...(constraint.computer ? { computer: constraint.computer } : {}),
        ...(pin ? { pin: [pin.accountSlot, pin.model].filter(Boolean).join("/") } : {}),
      };
      const decision = await decideTask({ utterance, catalogue, context, principal: principal.personId }, deps.controller!);
      jevMs = decision.ms;
      const options = decision.options ?? [];
      const cached = decision.cached === true;
      // A decision Jev made carries that call's evidence (latency, request id, model, the options offered, cached and its age) on the job and a receipt.
      const jd = (d: Omit<JevDecision, "calibrationRunId">): JevDecision =>
        decisionOf({ ...d, ...(d.source === "jev" ? { ms: decision.ms, options, cached, ...(decision.cacheAgeMs !== undefined ? { cacheAgeMs: decision.cacheAgeMs } : {}), ...(decision.evidence ? { requestId: decision.evidence.requestId, model: decision.evidence.model } : {}) } : {}) });

      // One boundary BEFORE every Jev lane and every outage fallback: an unsupported business
      // compound can only ask/refuse, never execute an isolated page, skill, coding or device prefix.
      if (businessQuestions?.kind === "unsupported") {
        const missing = decision.kind === "unavailable";
        if (missing) jevMiss = { ...(decision.evidence ? { requestId: decision.evidence.requestId } : {}), ms: decision.ms };
        return start("none", async (ctx, out) => {
          if (decision.kind === "unavailable") recordJevMiss(ctx.jobId, decision.reason);
          const d = jd({ op: missing ? "jev.unavailable" : "crm.questions", confidence: decision.kind === "unavailable" ? 0 : decision.confidence, policy: missing ? "done" : "ask", source: missing ? "rules" : "jev", why: `unsupported read-only business compound; Jev ${decision.kind === "decided" ? `chose ${decision.lane}` : decision.kind}; no lane or fallback may execute a prefix` });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: d.why, executor: "none", jev: d, outcome: missing ? "refused" : "asked" });
          return { type: "done", ok: false, ...(missing ? {} : { ask: true }), said: decision.kind === "unavailable" ? jevOutageLine(decision.reason) : "I can combine up to four supported read-only business questions. This request includes something else, so I haven't run any of it. Ask those parts separately.", kind: missing ? "unavailable" : "ask", decision: d, numbers: { jev: { state: missing ? "unavailable" : "ask", ...(decision.kind === "unavailable" ? { reason: decision.reason } : {}), options } }, verified: null, ...base };
        });
      }

      // ── Jev unavailable: the labelled deterministic fallback for supported, safe exact actions; the outage line for everything else ──
      if (decision.kind === "unavailable") {
        const reason = decision.reason;
        jevMiss = { ...(decision.evidence ? { requestId: decision.evidence.requestId } : {}), ms: decision.ms, ...(decision.detail ? { detail: decision.detail } : {}), ...(decision.httpStatus !== undefined ? { httpStatus: decision.httpStatus } : {}), ...(decision.attempts !== undefined ? { attempts: decision.attempts } : {}) };
        const fb = (d: Omit<JevDecision, "calibrationRunId" | "source" | "why"> & { why: string }) => decisionOf({ ...d, source: "fallback", why: `deterministic fallback (Jev unavailable: ${reason}): ${d.why}` });
        const fbStart = (work: (ctx: ExecutorContext, out: (e: CommandStreamEvent) => void) => Promise<CommandDoneEvent>) =>
          start("none", async (ctx, out) => {
            recordJevMiss(ctx.jobId, reason);
            const done = await work(ctx, out);
            return { ...done, numbers: { ...(done.numbers ?? {}), jev: { state: "unavailable", reason, recovery: "exact-rule" } } };
          });
        if (!fixedAgent && !pin) {
          if (constraint.context?.step) return toDevice(null, [constraint.context.step], { fromWords: true, recovery: reason });
          if (!ctxItem && linked && linked.length > 1 && !goalRefusal) return toDevice(null, linked.map((s) => ({ executor: s.executor, args: s.args })), { fromWords: true, recovery: reason });
          if (!ctxItem && routine) return toDevice(exactRule, undefined, { recovery: reason });
          if (!ctxItem && (margin || prices)) return fbStart(async (ctx, out) => exactAnswer(ctx, out, fb));
          if (!ctxItem && skillName && deps.delegates?.skill) return fbStart(async (ctx, out) => skillAnswer(ctx, out, skillName, fb));
          if (!ctxItem && page) return fbStart(async (ctx, out) => pageOpen(ctx, out, page, fb));
          // A business record in an explicit CRM form (a note, a task, a quote or invoice DRAFT, a search): internal, read back, nothing sent.
          if (!ctxItem && exactRule?.lane === "delegate" && (exactRule.to === "receptionist" || exactRule.to === "crm" || exactRule.to === "leads")) return delegate({ ...exactRule, why: `deterministic fallback (Jev unavailable: ${reason}): ${exactRule.why}` }, principal, input.memoryCaller, utterance, body, start, decisionOf, note, { source: "fallback", confidence: 1 }, (jobId) => recordJevMiss(jobId, reason), followed?.record);
        }
        // A QUESTION is not refused for Jev's outage (5 Oct): the brain answers it, labelled as the fallback it is. Answering is not acting:
        // the handoff is answer-only (free-voice offers the brain no action tools for it), so nothing runs without a decision.
        if (!fixedAgent && !pin && !ctxItem && catalogue.brain && isQuestion(utterance))
          return start("none", async (ctx, out) => {
            recordJevMiss(ctx.jobId, reason);
            const d = decisionOf({ op: "delegate.brain", confidence: 0, policy: "delegate", delegateTo: "brain", source: "fallback", options, why: `Jev unavailable (${reason}): a question, so the brain answers it; nothing acts` });
            out({ type: "decision", decision: d, seq: 0 });
            note(ctx, { intent: `Jev unavailable (${reason}${decision.detail ? `: ${decision.detail}` : ""}); a question: handed to the brain to answer, nothing acts`, executor: "handoff", jev: d, outcome: "note" });
            return { type: "done", ok: false, kind: "handoff", said: "That's a question for the chat brain; nothing was opened or changed.", handoff: { to: "brain", intent: "question.jev-unavailable", reason: d.why, utterance }, numbers: { jev: { state: "unavailable", reason, recovery: "brain-answer", ...jevMissFacts() } }, decision: d, verified: null, ...base };
          });
        return start("none", async (ctx, out) => {
          recordJevMiss(ctx.jobId, reason);
          const d = decisionOf({ op: "jev.unavailable", confidence: 0, policy: "done", source: "rules", options, why: `Jev unavailable (${reason}): no router was substituted; only supported exact actions run` });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `Jev unavailable (${reason}${decision.detail ? `: ${decision.detail}` : ""}); not a supported exact action, nothing ran`, executor: "none", jev: d, outcome: "refused" });
          return { type: "done", ok: false, said: jevOutageLine(reason), kind: "unavailable", numbers: { jev: { state: "unavailable", reason, ...jevMissFacts() } }, decision: d, verified: null, ...base };
        });
      }

      // ── Jev chose outside what the request allows: rejected, recorded, and he is asked; never reinterpreted ──
      if (decision.kind === "rejected")
        return start("none", async (ctx, out) => {
          const d = jd({ op: "jev.rejected", target: decision.choice, confidence: decision.confidence, policy: "ask", source: "jev", why: `Jev chose "${decision.choice}", which ${constraintWhy} doesn't allow (offered: ${options.join("/")}); rejected, not reinterpreted` });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `Jev's choice "${decision.choice}" rejected: outside ${constraintWhy}; nothing ran`, executor: "none", jev: d, outcome: "asked" });
          return { type: "done", ok: false, ask: true, kind: "ask", said: `I couldn't work out how to do that within ${constraintWhy}, so nothing ran. Could you say what you want done another way?`, decision: d, numbers: { jev: { state: "rejected", choice: decision.choice, options } }, verified: null, ...base };
        });

      const ask = (why: string, said: string) =>
        start("none", async (ctx, out) => {
          const d = jd({ op: "jev.ask", confidence: decision.confidence, policy: "ask", source: "jev", why });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `Jev: ask (${why})`, executor: "none", jev: d, outcome: "asked" });
          return { type: "done", ok: false, ask: true, said, kind: "ask", decision: d, numbers: { jev: { state: "ask", confidence: decision.confidence, options } }, verified: null, ...base };
        });
      if (decision.kind === "ask" && !fixedAgent && !pin && !ctxItem && catalogue.brain && isQuestion(utterance))
        return start("none", async (ctx, out) => {
          const d = jd({ op: "delegate.brain", confidence: decision.confidence, policy: "delegate", delegateTo: "brain", source: "jev", why: `Jev was unsure (${decision.why}); a question, so the brain answers it; nothing acts` });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: "Jev unsure; a question: handed to the brain to answer, nothing acts", executor: "handoff", jev: d, outcome: "note" });
          return { type: "done", ok: false, kind: "handoff", said: "That's a question for the chat brain; nothing was opened or changed.", handoff: { to: "brain", intent: "question.jev-unsure", reason: d.why, utterance }, numbers: { jev: { state: "ask", confidence: decision.confidence, options, recovery: "brain-answer" } }, decision: d, verified: null, ...base };
        });
      if (decision.kind === "ask") {
        const choices = fixedAgent
          ? [`a task for ${fixedBot?.name ?? constraint.computer}`]
          : [catalogue.device ? `on ${catalogue.device.label}` : null, catalogue.bots.length ? `one of your agents (${catalogue.bots.map((b) => b.name).join(", ")})` : null, catalogue.coding ? "a coding job" : null, catalogue.brain ? "an answer from me" : null].filter(Boolean) as string[];
        return ask(decision.why, `I'm not sure how you want that done, so nothing ran. ${choices.length > 1 ? `Should it be ${choices.slice(0, -1).join(", ")} or ${choices.at(-1)}?` : `What exactly should ${choices[0]} be?`}`);
      }
      const jevWhy = `Jev chose ${decision.lane}${decision.bot ? ` (${deps.bots?.nameOf(decision.bot) ?? decision.bot})` : ""} at ${Math.round(decision.confidence * 100)}% from ${options.join("/")}${cached ? " (cached)" : ""}`;
      const jevMk = (d: Omit<JevDecision, "calibrationRunId" | "source" | "why"> & { why: string }) => jd({ ...d, source: "jev", why: `${jevWhy}; ${d.why}` });

      // ── his own device: Jev chose the lane; context or the exact rules fill the steps (URL, verbatim query, order) ──
      if (decision.lane === "device.open" || decision.lane === "device.screen") {
        const deviceId = ownDevice ?? undefined;
        if (constraint.context?.step) return toDevice(null, [constraint.context.step], { fromWords: true, decided: jd({ op: "open-url", target: constraint.context.name ?? safeHost(String(constraint.context.step.args.url)), confidence: decision.confidence, policy: "act", source: "jev", ...(deviceId ? { deviceId } : {}), why: `${jevWhy}; the site on file for ${constraint.context.name ?? "the item on the page"}` }) });
        const back = switchBackIn(utterance);
        const switched = back ? switchBack(back) : null;
        if (switched) return switched;
        const steps = linked && linked.length > 1 ? linked.map((s) => ({ executor: s.executor, args: s.args })) : null;
        if (steps) return toDevice(null, steps, { fromWords: true, decided: jd({ op: "remote.steps", target: steps.map((s) => s.executor).join(" → ").slice(0, 120), confidence: decision.confidence, policy: "act", source: "jev", ...(deviceId ? { deviceId } : {}), why: `${jevWhy}; ${steps.length} exact steps in his order` }) });
        if (routine) return toDevice(exactRule, undefined, { decided: jd({ op: exactRule.op, ...(exactRule.target ? { target: exactRule.target } : {}), confidence: decision.confidence, policy: "act", source: "jev", ...(deviceId ? { deviceId } : {}), why: `${jevWhy}; filled by rule: ${exactRule.why}` }) });
        if (decision.lane === "device.open") {
          // A single request only: a compound one that isn't all exact steps is never cut down to its first site.
          const single = orderedClauses(utterance).length === 1;
          const query = searchQueryIn(utterance);
          const site = !query && single ? siteIn(utterance) : null;
          if (!query && !site) return ask("Jev chose to open a page on his device, but the words don't name exactly what", exactRule?.lane === "unsupported" ? exactRule.said : "Which site should I open, or what should I search for? Nothing has run yet.");
          const step: RemoteStep = query ? { executor: "open-url", args: { url: googleSearchUrl(query), query } } : { executor: "open-url", args: { url: site! } };
          return toDevice(null, [step], { fromWords: true, decided: jd({ op: query ? "web.search" : "open-url", target: query ? "google.com" : safeHost(String(step.args.url)), confidence: decision.confidence, policy: "act", source: "jev", ...(deviceId ? { deviceId } : {}), why: jevWhy }) });
        }
        return toDevice(null, undefined, { decided: jd({ op: "screen.goal", confidence: decision.confidence, policy: "act", source: "jev", ...(deviceId ? { deviceId } : {}), why: jevWhy }) });
      }
      // ── the item on the page: Jev chose; context supplies the item's own figures and page (nothing invented) ──
      if (ctxItem && pageContext) {
        if (decision.lane === "page")
          return start("none", async (ctx, out) => {
            const d = jevMk({ op: "navigate", target: ctxItem.href!, confidence: decision.confidence, policy: "act", why: `"${ctxItem.label}" (${ctxItem.kind}) has its own page` });
            out({ type: "decision", decision: d, seq: 0 });
            note(ctx, { intent: `context: open ${ctxItem.kind} "${ctxItem.label}"`, executor: "none", jev: d, outcome: "ok" });
            return { type: "done", ok: true, said: `Opening ${ctxItem.label}.`, kind: "navigate", navigate: { path: ctxItem.href! }, decision: d, verified: null, ...base };
          });
        if (decision.lane === "answer")
          return start("none", async (ctx, out) => {
            out({ type: "decision", decision: jevMk({ op: "answer.context", target: ctxItem.label, confidence: decision.confidence, policy: "act", why: "answered from the item's own figures" }), seq: 0 });
            return contextual(ctx, out, utterance, ctxItem, constraint.context?.tier ?? "selected", pageContext, decisionOf);
          });
        if (decision.lane === "brain")
          return start("none", async (ctx, out) => {
            const facts = Object.entries(ctxItem.data ?? {}).map(([k, v]) => `${k}: ${v}`).join("; ");
            const d = jevMk({ op: "delegate.brain", target: ctxItem.label, confidence: decision.confidence, policy: "delegate", delegateTo: "brain", why: `a question about "${ctxItem.label}" (${ctxItem.kind}) on ${pageContext.page}` });
            out({ type: "decision", decision: d, seq: 0 });
            note(ctx, { intent: `context: delegate a question about ${ctxItem.kind} "${ctxItem.label}" to the brain`, executor: "handoff", jev: d, outcome: "note" });
            return { type: "done", ok: false, kind: "handoff", decision: d, verified: null, ...base, said: "That's a question for the chat brain; I've given it what the page shows.", handoff: { to: "brain", intent: "context", reason: d.why, utterance: `${utterance}\n[On ${pageContext.page}, "${ctxItem.label}" (${ctxItem.kind})${facts ? `: ${facts}` : ""}. Use only these figures; say if something isn't shown.]` } };
          });
      }
      if (decision.lane === "page") return page ? start("none", async (ctx, out) => pageOpen(ctx, out, page, jevMk)) : ask("Jev chose an OS page, but the words name none", "Which page of the OS should I open?");
      if (decision.lane === "answer") {
        if (margin || prices) return start("none", async (ctx, out) => exactAnswer(ctx, out, jevMk));
        if (skillName && deps.delegates?.skill) return start("none", async (ctx, out) => skillAnswer(ctx, out, skillName, jevMk));
        if (exactRule?.lane === "delegate" && (exactRule.to === "receptionist" || exactRule.to === "reminder")) return delegate({ ...exactRule, why: `${jevWhy}; filled by rule: ${exactRule.why}` }, principal, input.memoryCaller, utterance, body, start, jd, note, { source: "jev", confidence: decision.confidence }, undefined, followed?.record);
        if (moneyRead) return start("none", async (ctx, out) => brainHandoff(ctx, out, jevMk, "money.question"));
        return ask("Jev chose a built-in answer, but no built-in skill reads these words", "I don't have a built-in answer for that. Should I ask the chat brain instead?");
      }
      if (decision.lane === "brain") return start("none", async (ctx, out) => brainHandoff(ctx, out, jevMk, "jev.brain"));
      if (decision.lane === "crm") {
        const crmRule = exactRule?.lane === "delegate" && (exactRule.to === "crm" || exactRule.to === "leads") ? exactRule : crmIntentIn(utterance) ? ({ lane: "delegate", to: "crm", op: "crm.operation", why: "the CRM's typed operations" } as const) : null;
        if (!crmRule) return ask("Jev chose the CRM, but the words name no record or operation it can run", "Which record do you mean, and what should I do with it? Nothing has changed.");
        return delegate({ ...crmRule, why: `${jevWhy}; filled by rule: ${crmRule.why}` }, principal, input.memoryCaller, utterance, body, start, jd, note, { source: "jev", confidence: decision.confidence }, undefined, followed?.record);
      }
      if (decision.lane === "memory") return delegate({ lane: "delegate", to: "memory", op: "memory.voice", why: jevWhy }, principal, input.memoryCaller, utterance, body, start, jd, note, { source: "jev", confidence: decision.confidence }, undefined, followed?.record);
      if (decision.lane === "coding" && deps.delegates?.coding) {
        earlyDispatch = Date.now();
        // His own words first (a status question about the coding job reads as it was said); "have a builder" only to frame a plain task.
        stopGuard(); // final review B1: never start coding work for a stopped event
        let r = await afterCoding(await deps.delegates.coding(utterance, { ...codingTurn, jevDecided: true, ...(pin ? { pin } : {}) }).catch(() => null));
        if (!r && !newCoding) { stopGuard(); r = await afterCoding(await deps.delegates.coding(`Have a builder ${utterance}`, codingTurn).catch(() => null)); }
        if (r) return codingDone(r, jd({ op: "coding.turn", ...(r.jobId ? { target: r.jobId.slice(0, 8) } : {}), confidence: decision.confidence, policy: "delegate", delegateTo: "coding", source: "jev", why: pin ? `${jevWhy}; pinned to ${[pin.model, pin.accountSlot].filter(Boolean).join(" on ")} for the whole job` : `${jevWhy}; the worker is chosen for this task` }));
        earlyDispatch = undefined;
      }
      if (decision.lane === "computer" && constraint.computer && deps.delegates?.computers) {
        stopGuard(); // final review B1: never start an agent or computer job for a stopped event
        const c = await afterJob(await deps.delegates.computers(utterance, principal).catch((e: Error) => ({ ok: false, said: `The computers service didn't answer (${String(e?.message ?? e).slice(0, 100)}), so its outcome is not confirmed. Check its jobs before starting new work.`, unverified: true as const })));
        if (c) {
          const navigate = "navigate" in c ? c.navigate : undefined;
          const d = jd({ op: `computer.${constraint.computer}`, confidence: decision.confidence, policy: "delegate", source: "jev", why: `${jevWhy}; the computer he named` });
          return { type: "done", ok: c.ok, said: c.said, ...("unverified" in c && c.unverified === true ? { outcome: "unverified" } : {}), kind: navigate ? "navigate" : "remote", ...(navigate ? { navigate: { path: navigate } } : {}), decision: d, numbers: { jev: { state: "decided", lane: "computer", computer: constraint.computer, options, cached } }, jobId: ("jobId" in c && c.jobId) || null, runId: "", targetDeviceId: ("deviceId" in c && c.deviceId) || "none", verified: null, timing: { decisionMs: decision.ms, dispatchMs: decision.ms, completeMs: Date.now() - receivedAt, jevMs: decision.ms } };
        }
      }
      if (decision.lane === "bot" && decision.bot && deps.bots) {
        // Jev chose the agent AND the kind of task (a coding job or its computer): both go to the agent with the decision record, so its own
        // word rules don't decide it again and its task row can say who decided.
        const d = jd({ op: `bot.${decision.bot}${decision.botLane ? `.${decision.botLane}` : ""}`, confidence: decision.confidence, policy: "delegate", source: "jev", why: jevWhy });
        // The same money pre-check a NAMED agent gets: a money action never reaches any agent; a code change that only names a money feature is code.
        const framed = `Have a builder ${raw}`;
        if (moneyRead || !!codingMoneyRefusal(raw) || !!codingMoneyRefusal(framed) || (!!goalRefusal && !codeChangeNotPayment(raw) && !codeChangeNotPayment(framed)))
          return { type: "done", ok: false, said: goalRefusal?.said ?? codingMoneyRefusal(raw) ?? "That is a money action, and no agent does those from here. Nothing ran.", kind: "refused", refused: true, decision: d, jobId: null, runId: "", targetDeviceId: "none" };
        const record: JevDecisionRef = { op: d.op, confidence: d.confidence, policy: d.policy, decidedBy: "jev", ...(d.ms !== undefined ? { ms: d.ms } : {}), ...(d.requestId ? { requestId: d.requestId } : {}), ...(d.model ? { model: d.model } : {}), ...(d.options ? { options: d.options } : {}), ...(d.cached !== undefined ? { cached: d.cached } : {}) };
        stopGuard(); // final review B1: never start an agent or computer job for a stopped event
        const b = await afterJob(await deps.bots.run({ principal, bot: decision.bot, utterance: raw, source, spokenYes: typeof body.spokenYes === "string" ? body.spokenYes : null, ...(body.subjects?.length ? { subjects: body.subjects } : {}), pageContext, ...(decision.botLane ? { lane: decision.botLane } : {}), decision: record }).catch((e: Error) => ({ ok: false, said: `The agent didn't answer (${String(e?.message ?? e).slice(0, 100)}), so its outcome is not confirmed. Check its jobs before starting new work.`, unverified: true as const })));
        if (b) {
          const navigate = "navigate" in b ? b.navigate : undefined;
          return { type: "done", ok: b.ok, said: b.said, ...("unverified" in b && b.unverified === true ? { outcome: "unverified" } : {}), kind: navigate ? "navigate" : "remote", ...(navigate ? { navigate: { path: navigate } } : {}), ...("ask" in b && b.ask ? { ask: true } : {}), decision: d, numbers: { ...("numbers" in b && b.numbers ? b.numbers : {}), jev: { state: "decided", lane: "bot", bot: decision.bot, options, cached } }, jobId: ("jobId" in b && b.jobId) || null, runId: "", targetDeviceId: ("deviceId" in b && b.deviceId) || "none", verified: null, timing: { decisionMs: decision.ms, dispatchMs: decision.ms, completeMs: Date.now() - receivedAt, jevMs: decision.ms } };
        }
      }
      // The lane Jev chose can't take it after all (the coding harness, the agent or the computer didn't accept it): said, nothing sent elsewhere.
      return ask(`${jevWhy}, but it didn't accept the request`, `That looked like ${decision.lane === "coding" ? "a coding job" : decision.lane === "bot" || decision.lane === "computer" ? "one for an agent" : "something I can't run from here"}, but it didn't take it, so nothing ran. Say it another way, or name the agent or repo?`);
    }

    type JevConstraint = {
      /** An agent he named (Agents workspace): the only target offered. */
      bot?: string;
      /** A shared computer he named ("use the research computer to ..."): the only target offered. */
      computer?: string;
      /** What "this" on the page resolved to: the exact open it means (a lead's site on file), or the item itself. */
      context?: { step?: RemoteStep; name?: string; item?: PageContextItem; tier?: string };
    };

    type Mk = (d: Omit<JevDecision, "calibrationRunId" | "source" | "why"> & { why: string }) => JevDecision;
    /** Margins from the economics model, prices from the catalogue: exact numbers, never a model's. */
    async function exactAnswer(ctx: ExecutorContext, out: (e: CommandStreamEvent) => void, mk: Mk): Promise<CommandDoneEvent> {
      const margin = parseMarginQuery(utterance);
      const prices = margin ? null : parsePriceQuery(utterance);
      const a = margin ? marginAnswer(margin) : priceAnswer(prices!);
      const d = mk({ op: margin ? "answer.margin" : "answer.price", target: margin ? margin.pkg.shortName : prices!.map((p) => p.shortName).join(", "), confidence: 1, policy: "act", why: margin ? "numbers from the economics model only" : "prices from the package catalogue only" });
      out({ type: "decision", decision: d, seq: 0 });
      note(ctx, { intent: `answer: ${d.op} (${a.numbers.source})`, executor: "deterministic", jev: d, outcome: "ok", verification: { method: "deterministic", ok: true, evidence: String(a.numbers.source) } });
      return { type: "done", ok: true, said: a.said, kind: "answer", numbers: a.numbers as Record<string, unknown>, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: true };
    }
    async function skillAnswer(ctx: ExecutorContext, out: (e: CommandStreamEvent) => void, name: string, mk: Mk): Promise<CommandDoneEvent> {
      const d = mk({ op: `skill.${name}`, confidence: 1, policy: "delegate", delegateTo: "voice-tools", why: `the ${name} skill answers this by rules, exactly as spoken` });
      out({ type: "decision", decision: d, seq: 0 });
      markDispatch(ctx.jobId);
      const r = await deps.delegates!.skill!.run(utterance, principal).catch(() => ({ ok: false, said: "That skill didn't answer, so I won't guess." }));
      note(ctx, { intent: `skill ${name}: ${r.said.slice(0, 160)}`, executor: "skills", jev: d, outcome: r.ok ? "ok" : "failed", verification: { method: `${name}-skill`, ok: r.ok } });
      return { type: "done", ok: r.ok, said: r.said, kind: "answer", jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: r.ok };
    }
    async function pageOpen(ctx: ExecutorContext, out: (e: CommandStreamEvent) => void, page: { path: string; label: string }, mk: Mk): Promise<CommandDoneEvent> {
      const d = mk({ op: "navigate", target: page.path, confidence: 1, policy: "act", why: `the OS page ${page.label}` });
      out({ type: "decision", decision: d, seq: 0 });
      note(ctx, { intent: `navigate: ${page.path}`, executor: "none", jev: d, outcome: "ok" });
      return { type: "done", ok: true, said: `Opening ${page.label}.`, kind: "navigate", navigate: { path: page.path }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
    }
    async function brainHandoff(ctx: ExecutorContext, out: (e: CommandStreamEvent) => void, mk: Mk, intent: string): Promise<CommandDoneEvent> {
      const d = mk({ op: "delegate.brain", confidence: 1, policy: "delegate", delegateTo: "brain", why: "an answer or writing, no hands" });
      out({ type: "decision", decision: d, seq: 0 });
      note(ctx, { intent: "handoff → brain: an answer or writing, no hands", executor: "handoff", jev: d, outcome: "note" });
      return { type: "done", ok: false, kind: "handoff", said: "That's one for the chat brain; nothing was opened or changed.", handoff: { to: "brain", intent, reason: d.why, utterance }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
    }
    function codingDone(r: { say: string; navigate?: string; jobId?: string; jobState?: string; draft?: unknown; drafted?: boolean; started?: boolean }, d: JevDecision): Promise<CommandDoneEvent> {
      return start("none", async (ctx, out) => {
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `coding: ${r.say.slice(0, 160)}`, executor: "coding", jev: d, outcome: "ok" });
        return { type: "done", ok: true, said: source === "voice" && r.draft ? spokenDraft(r.say, r.draft) : r.say, kind: r.navigate ? "navigate" : "answer", ...(!r.jobId && !r.navigate && !r.draft && /\?\s*$/.test(r.say) ? { ask: true } : {}), ...(r.navigate ? { navigate: { path: r.navigate } } : {}), numbers: { ...(r.jobId ? { codingJobId: r.jobId } : {}), ...(r.jobState ? { codingJobState: r.jobState } : {}), ...(r.draft ? { draft: r.draft, fullSummary: r.say } : {}), ...(r.drafted ? { codingDrafted: true } : {}), ...(r.started ? { codingStarted: true } : {}) }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
      });
    }
  }

  // --------------------------------------------------------------------------------------------------

  async function hubRun(entry: JarvisEntry, ctx: ExecutorContext, out: (e: CommandStreamEvent) => void, r: { utterance: string; deviceId: string; owner: "usman" | "mehroz"; surface: "voice" | "typed"; source: CommandSource; pageContext: PageContext | null; decided?: { lane: "device.open" | "device.screen"; confidence: number }; jevUnavailable?: string }): Promise<CommandDoneEvent> {
    // Mirror the entry's run-log steps into THIS job as they happen (the inspector's full detail).
    let mirrored = 0;
    const unsubscribe = deps.runs?.subscribe((run: RunRecord) => {
      if (run.jobId !== ctx.jobId) return;
      for (const s of run.steps.slice(mirrored)) ctx.step({ ...stepFromRun(run, s), target: r.deviceId });
      mirrored = run.steps.length;
    });
    markDispatch(ctx.jobId);
    try {
      const done: CommandDone = await entry.handle(
        { utterance: r.utterance, source: r.source === "voice" ? "voice" : "command", jobId: ctx.jobId, target: { deviceId: r.deviceId, owner: r.owner }, surface: r.surface, pageContext: r.pageContext, ...(r.decided ? { decided: r.decided } : {}), ...(r.jevUnavailable ? { jevUnavailable: r.jevUnavailable } : {}) },
        ctx.signal,
        (e: CommandEvent) => {
          if (e.type === "done") return;
          if (e.type === "decision") return out({ type: "decision", decision: e.decision, seq: 0 });
          out(e as CommandStreamEvent);
        },
      );
      return { ...done, jobId: ctx.jobId, targetDeviceId: r.deviceId, kind: done.kind as CommandDoneEvent["kind"] };
    } finally {
      unsubscribe?.();
    }
  }

  async function remoteRun(
    ctx: ExecutorContext,
    out: (e: CommandStreamEvent) => void,
    r: { principal: Principal; utterance: string; spokenTarget?: string; originDeviceId?: string; deviceId: string; rule: RulePlan | null; steps?: RemoteStep[]; decisionOf: (d: Omit<JevDecision, "calibrationRunId">) => JevDecision; note: (ctx: ExecutorContext, s: Omit<Step, "seq" | "at" | "ms"> & { ms?: number }) => Step | null; /** Jev's controller decision that sent it here (recorded as the job's decision). */ decided?: JevDecision; /** Set when Jev is off and this exact step runs as the documented deterministic recovery (prefixed to the decision's why). */ recovery?: string },
  ): Promise<CommandDoneEvent> {
    const base = { jobId: null, runId: "", targetDeviceId: r.deviceId } as const;
    const plan = r.rule?.lane === "executor" && COMPANION_EXECUTORS.includes(r.rule.executor) ? r.rule : null;
    // The job's steps: a typed plan (validated again here), or the one executor the words named.
    const typed = r.steps?.length ? r.steps : null;
    if (typed && (typed.length > MAX_REMOTE_STEPS || typed.some((s) => !COMPANION_EXECUTORS.includes(s.executor)))) {
      const d = r.decisionOf({ op: "device.capability", confidence: 1, policy: "done", source: "rules", deviceId: r.deviceId, why: "a plan with a step the companion doesn't run" });
      out({ type: "decision", decision: d, seq: 0 });
      r.note(ctx, { intent: "companion: the plan has a step that isn't a companion executor", executor: "none", target: r.deviceId, jev: d, outcome: "refused" });
      return { type: "done", ok: false, refused: true, kind: "refused", said: `That plan has a step ${label(r.deviceId)} doesn't run, so none of it ran.`, decision: d, ...base };
    }
    // No typed executor names it, or it is compound/open-ended: the companion's own screen loop (the same Jarvis entry the
    // PC hub runs) decides and acts, when that device reports it. Money, bank and secret goals are refused here first.
    let goal: RemoteStep[] | null = null;
    if (!typed && !plan && deps.supports?.(r.deviceId, "screen.goal") && /^(?:yes|yeah|yep|yes please|go ahead|do it|confirm(?:ed)?|no|nope|leave it)[.!]?$/i.test(r.utterance.trim())) {
      // A bare answer with no question waiting is not a goal: nothing is sent.
      const d = r.decisionOf({ op: "device.resume", confidence: 1, policy: "done", source: "rules", deviceId: r.deviceId, why: "an answer with no question waiting" });
      out({ type: "decision", decision: d, seq: 0 });
      r.note(ctx, { intent: "no question is waiting for that answer", executor: "none", target: r.deviceId, jev: d, outcome: "refused" });
      return { type: "done", ok: false, refused: true, kind: "refused", said: "Nothing is waiting for a yes or a no from you right now, so nothing was done.", decision: d, ...base };
    }
    if (!typed && !plan && deps.supports?.(r.deviceId, "screen.goal")) {
      const money = screenGoalRefusal(r.utterance);
      if (money) {
        const d = r.decisionOf({ op: "refuse", confidence: 1, policy: "done", source: "rules", deviceId: r.deviceId, why: `refused in code: ${money.kind}` });
        out({ type: "decision", decision: d, seq: 0 });
        r.note(ctx, { intent: `refused: ${money.kind}`, executor: "none", target: r.deviceId, jev: d, outcome: "refused" });
        return { type: "done", ok: false, refused: true, kind: "refused", said: money.said, decision: d, ...base };
      }
      goal = [{ executor: "screen.goal", args: { goal: r.utterance } }];
    }
    const steps: RemoteStep[] | null = typed ?? (plan ? [{ executor: plan.executor, args: plan.args }] : goal);
    if (!steps) {
      const d = r.decisionOf({ op: "device.capability", confidence: 1, policy: "done", source: "rules", deviceId: r.deviceId, why: "not something the companion can run (no typed executor matches)" });
      out({ type: "decision", decision: d, seq: 0 });
      r.note(ctx, { intent: "companion: no typed executor for this request", executor: "none", target: r.deviceId, jev: d, outcome: "refused" });
      return { type: "done", ok: false, refused: true, kind: "refused", said: `On ${label(r.deviceId)} I can open or focus an app, open a web page, open a file, start a new PowerPoint with a title slide, type a line into a new Notepad document, or say what's in front. That one needs Usman's PC's screen loop, so nothing ran, and I didn't send it anywhere else.`, decision: d, ...base };
    }
    if (!deps.dispatcher) return { type: "done", ok: false, kind: "unavailable", said: "Device routing isn't running on this server, so nothing ran.", ...base };
    const single = steps.length === 1;
    const marked = (why: string) => (r.recovery ? `${r.recovery}: ${why}` : why);
    const d = r.decided
      ? r.decided
      : single && plan && !typed
      ? r.decisionOf({ op: plan.op, ...(plan.target ? { target: plan.target } : {}), confidence: 1, policy: "act", source: r.recovery ? "fallback" : "rules", deviceId: r.deviceId, why: marked(plan.why) })
      : r.decisionOf({ op: single ? steps[0].executor : "remote.steps", target: steps.map((s) => s.executor).join(" → ").slice(0, 120), confidence: 1, policy: "act", source: r.recovery ? "fallback" : "rules", deviceId: r.deviceId, why: marked(`${steps.length === 1 ? "one typed step" : `a ${steps.length}-step plan`} on ${label(r.deviceId)}, each step checked before the next`) });
    out({ type: "decision", decision: d, seq: 0 });

    const results: { executor: string; ok: boolean; verified: boolean | null; said: string }[] = [];
    /** Steps that never ran, recorded as such so the job log says exactly where it stopped (and that nothing later ran). */
    const skipRest = (from: number, why: string) => {
      for (let j = from; j < steps.length; j++) r.note(ctx, { intent: `step ${j + 1} ${steps[j].executor} not run: ${why}`, executor: "companion", target: r.deviceId, action: steps[j].executor, outcome: "skipped" });
    };
    const finish = (over: Partial<CommandDoneEvent> & { said: string; ok: boolean }): CommandDoneEvent => ({
      type: "done", kind: "remote", decision: d, ...base, ...(single ? {} : { numbers: { steps: results } }), ...over,
    });

    for (let i = 0; i < steps.length; i++) {
      const call: ExecutorCall = { targetDeviceId: r.deviceId, executor: steps[i].executor, args: steps[i].args };
      const at = single ? "" : `step ${i + 1} of ${steps.length}, `;
      if (ctx.signal.aborted || ctx.cancelRequested()) {
        skipRest(i, "it was stopped first");
        return finish({ ok: false, stopped: true, said: "Stopped.", verified: false });
      }
      out({ type: "narrate", stage: "act", text: `On ${label(r.deviceId)}: ${narration(call.executor, single ? plan?.target : undefined)}.`, speak: true });
      markDispatch(ctx.jobId);
      const started = Date.now();
      let commandId = "";
      const result = await deps.dispatcher.submit(
        {
          personId: r.principal.personId,
          ...(r.spokenTarget ? { spokenTarget: r.spokenTarget } : {}),
          ...(r.originDeviceId ? { originDeviceId: r.originDeviceId } : {}),
          executor: call.executor,
          args: call.args,
          // A single-step command dedupes a typed+voice echo; in a plan two equal steps are two steps.
          ...(single ? { commandKey: `${call.executor}:${JSON.stringify(call.args)}` } : {}),
          // The wire carries the job and step; the step never leaves the device the job started on.
          jobId: ctx.jobId,
          stepId: `s${i + 1}`,
          pinDeviceId: r.deviceId,
        },
        {
          timeoutMs: Math.max(deps.remoteTimeoutMs ?? 60_000, call.executor === "deck.blank" ? 130_000 : 0, call.executor === "screen.goal" ? 300_000 : 0),
          signal: ctx.signal,
          // A screen goal's sub-steps arrive as they happen and become job steps (intent, executor, outcome, verification).
          onProgress: (p) => void ctx.step({ intent: p.intent, executor: p.executor, target: r.deviceId, ...(p.action ? { action: p.action } : {}), ...(p.verification ? { verification: p.verification } : {}), outcome: p.outcome, ms: p.ms }),
          onQueued: (id, deviceId) => {
            commandId = id;
            if (deviceId !== r.deviceId) ctx.step({ intent: `device mismatch: dispatcher chose ${deviceId}`, executor: "companion", target: deviceId, ms: 0, outcome: "unknown" });
          },
        },
      );
      const ms = Date.now() - started;
      // A question the PC's screen loop put to the person ("Shall I press Send?"): not a failure. The job waits for their spoken
      // yes, and it resumes on this same device.
      const asked = !result.ok && isExecutorResult(result.result) && result.result.data && (result.result.data as { ask?: unknown }).ask === true ? result.result : null;
      if (asked) {
        const confirm = String((asked.data as { confirm?: unknown }).confirm ?? "");
        const q = confirm && deps.spoken ? deps.spoken.ask("screen") : null;
        r.note(ctx, { intent: `companion ${call.executor}: ${asked.said}`, executor: "companion", target: r.deviceId, action: call.executor, jev: d, ms, outcome: "asked", verification: { method: "companion-check", ok: null } });
        if (confirm) pendingRemote.set(r.principal.personId, { deviceId: r.deviceId, goal: String((asked.data as { resumeGoal?: unknown }).resumeGoal ?? r.utterance), confirm, at: Date.now(), questionId: q?.id ?? null, askedAt: q?.at ?? Date.now() });
        return finish({ ok: false, ask: true, verified: null, said: asked.said, ...(confirm ? { confirm, awaiting: true } : {}) });
      }
      if (!result.ok) {
        const stopped = ctx.signal.aborted || /cancel/i.test(result.reason);
        const uncertain = !stopped && result.uncertain === true;
        const offline = /offline/i.test(result.reason);
        r.note(ctx, {
          intent: `companion ${call.executor}${single ? "" : ` (${at.trim().replace(/,$/, "")})`}: ${result.reason}`,
          executor: "companion",
          target: result.deviceId ?? r.deviceId,
          action: call.executor,
          jev: d,
          ms,
          outcome: stopped ? "cancelled" : uncertain ? "unknown" : "failed",
          verification: { method: "companion-report", ok: uncertain ? null : false, ...(result.observed ? { evidence: `the device says: ${result.observed.state}` } : {}) },
        });
        results.push({ executor: call.executor, ok: false, verified: uncertain ? null : false, said: result.reason.slice(0, 120) });
        skipRest(i + 1, stopped ? "it was stopped first" : uncertain ? "the step before it is uncertain" : "the step before it didn't complete");
        if (stopped) return finish({ ok: false, stopped: true, verified: false, said: "Stopped." });
        if (uncertain)
          return finish({
            ok: false, verified: null, outcome: "uncertain",
            said: offline
              ? `${label(r.deviceId)} went offline while ${single ? "it was doing that" : `step ${i + 1} (${call.executor}) was running`}, so I can't say whether it happened. I haven't tried it again${single ? "" : " or run the later steps"}, and nothing ran anywhere else.`
              : `I couldn't confirm whether ${label(r.deviceId)} did ${single ? "that" : `step ${i + 1} (${call.executor})`}: ${result.reason.slice(0, 120)}. I haven't tried it again${single ? "" : " or run the later steps"}.`,
          });
        return finish({
          ok: false, verified: false, outcome: "unverified",
          said: result.notRun && offline
            ? `${label(r.deviceId)} is offline, so ${single ? "nothing ran" : `step ${i + 1} and the ones after it didn't run`}. Nothing ran anywhere else.`
            : offline
              ? `${label(r.deviceId)} went offline, so it didn't finish there. Nothing ran anywhere else.`
              : single
                ? `Not done on ${label(r.deviceId)}: ${result.reason.slice(0, 160)}`
                : `Stopped at step ${i + 1} of ${steps.length} (${call.executor}), nothing later ran. Not done on ${label(r.deviceId)}: ${result.reason.slice(0, 160)}`,
        });
      }
      if (result.local) return { type: "done", ok: false, kind: "unavailable", said: "That resolved to this PC after all, so nothing was sent.", ...base };
      const x = isExecutorResult(result.result) ? result.result : null;
      const verified = x ? x.verified : null;
      const ok = !!x && x.ok && verified === true;
      r.note(ctx, {
        intent: `companion ${call.executor}${commandId ? ` (${commandId.slice(0, 8)})` : ""}${single ? "" : ` [${at.trim().replace(/,$/, "")}]`}: ${x ? x.said : "no readable result"}`,
        executor: "companion",
        target: r.deviceId,
        action: call.executor,
        jev: d,
        ms,
        verification: { method: "companion-check", ok: verified, ...(x?.evidence ? { evidence: x.evidence.slice(0, 200) } : {}) },
        outcome: ok ? "ok" : verified === null ? "unknown" : "failed",
      });
      results.push({ executor: call.executor, ok, verified, said: (x?.said ?? "no readable result").slice(0, 120) });
      // A verified step's target is something the person can later "switch back" to, on this device only.
      if (ok && x) {
        const target = targetFrom(call.executor, x.data, Date.now());
        if (target) recentTargets.record(r.principal.personId, r.deviceId, target);
      }
      const said = !x ? `${label(r.deviceId)} didn't send back a result I can read, so I can't say it worked.` : ok ? x.said : x.ok ? `${x.said} I couldn't confirm it, so I'm not calling it done.` : x.said;
      if (!ok) {
        skipRest(i + 1, "the step before it wasn't confirmed");
        return finish({ ok: false, said: single ? said : `Stopped at step ${i + 1} of ${steps.length} (${call.executor}): ${said}`, verified, outcome: "unverified" });
      }
      if (single) return finish({ ok: true, said, verified });
    }
    return finish({ ok: true, verified: true, said: `Done on ${label(r.deviceId)}, every step checked: ${results.map((x) => x.said.replace(/[.!]+$/, "")).join("; ")}.`.slice(0, 400) });
  }

  async function contextual(ctx: ExecutorContext, out: (e: CommandStreamEvent) => void, utterance: string, item: PageContextItem, tier: string, page: PageContext, decisionOf: (d: Omit<JevDecision, "calibrationRunId">) => JevDecision): Promise<CommandDoneEvent> {
    const base = { jobId: null, runId: "", targetDeviceId: "none" } as const;
    const opening = /\b(?:open|show|go to|pull up|bring up|view)\b/i.test(utterance);
    const explaining = /\b(?:explain|what(?:'s| is| does)|why|how|break down|walk me through|tell me about)\b/i.test(utterance);
    const pkg = item.kind === "package" || item.kind === "margin" || item.kind === "metric" ? RECEPTIONIST_PACKAGES.find((p) => p.id === item.id || item.label.toLowerCase().includes(p.shortName.toLowerCase()) || String(item.data?.packageId ?? "") === p.id) : undefined;
    const marginLike = item.kind === "package" || item.kind === "margin" || item.kind === "metric";
    if (explaining && marginLike) {
      // The SELECTED item's own figures, quoted as shown, with the page's source and its data state. A package is
      // also cross-checked against the economics model; a mismatch is flagged, never smoothed over. No model
      // computes, rounds or writes a number here.
      const figures = shownFigures(item.data);
      const src = sourceWords(page.source);
      const model = pkg ? marginAnswer({ pkg, scenario: "base", clients: typeof item.data?.clients === "number" ? Math.max(1, Math.min(500, item.data.clients)) : 5 }) : null;
      const shownPct = shownContributionPct(item.data);
      const computed = model && model.numbers.contributionMarginBps !== null ? model.numbers.contributionMarginBps / 100 : null;
      const check: "match" | "mismatch" | "not-comparable" = shownPct === null || computed === null ? "not-comparable" : Math.abs(shownPct - computed) > 0.15 ? "mismatch" : "match";
      const d = decisionOf({ op: "answer.margin", target: pkg?.shortName ?? item.label, confidence: 1, policy: "act", source: "context", why: `"${item.label}" is the ${tier} item on ${page.page}; ${figures.length ? "the figures it shows" : model ? "it shows no figures, so the economics model" : "it shows no figures"}` });
      out({ type: "decision", decision: d, seq: 0 });
      ctx.step({ intent: `context: ${tier} ${item.kind} "${item.label}" on ${page.page}${figures.length ? ` (${figures.length} shown figures)` : ""}`, executor: "deterministic", jev: d, ms: 0, outcome: "ok", verification: { method: figures.length ? "shown-figures" : "economics-model", ok: check !== "mismatch", evidence: `${page.source?.name ?? "no source"} [${page.source?.state ?? "unknown"}]${check === "mismatch" ? `; page shows ${shownPct}% vs model ${computed}%` : ""}` } });
      const sourceNumbers = { name: page.source?.name ?? null, state: page.source?.state ?? "unknown", updatedAt: page.source?.updatedAt ?? null };
      if (figures.length) {
        const cross = !model
          ? ""
          : check === "mismatch"
            ? ` The economics model says ${computed?.toFixed(1)}% contribution margin for this package, which doesn't match the ${shownPct}% shown, so treat the shown figure as suspect until it refreshes.`
            : check === "match"
              ? ` That matches the economics model's estimate.`
              : ` No contribution margin was shown to cross-check; the economics model's estimate is ${(computed ?? 0).toFixed(1)}%.`;
        const said = `${item.label}: ${figures.map(speakFigure).join(", ")}. ${src.line}${src.live ? "" : " Those are the page's figures, not confirmed live."}${cross}`;
        return { type: "done", ok: true, said, kind: "answer", decision: d, numbers: { itemId: item.id, itemKind: item.kind, shown: item.data ?? {}, source: sourceNumbers, crossCheck: check, ...(model ? { model: model.numbers } : {}) }, verified: check === "match" ? true : check === "mismatch" ? false : null, ...base };
      }
      if (model) {
        const said = `${item.label} shows no figures, so this is the economics model's answer instead. ${model.said} ${src.line}`;
        return { type: "done", ok: true, said, kind: "answer", decision: d, numbers: { ...model.numbers, itemId: item.id, itemKind: item.kind, shown: {}, source: sourceNumbers, crossCheck: "not-comparable" }, verified: true, ...base };
      }
      // Shown data only, and none shown: said, not delegated and not invented.
      return { type: "done", ok: false, ask: true, said: `${item.label} doesn't show any figures I can read, and it isn't a package I can work out, so I won't guess. ${src.line}`, kind: "ask", decision: d, numbers: { itemId: item.id, itemKind: item.kind, shown: {}, source: sourceNumbers }, verified: null, ...base };
    }
    if (item.kind === "job") {
      const job = deps.jobs().get(item.id);
      const d = decisionOf({ op: "answer.job", target: item.id, confidence: 1, policy: "act", source: "context", why: `"${item.label}" is the ${tier} job on ${page.page}` });
      out({ type: "decision", decision: d, seq: 0 });
      ctx.step({ intent: `context: ${item.label}${job ? ` is ${job.state}` : " isn't in the job log"}`, executor: "deterministic", jev: d, ms: 0, outcome: job ? "ok" : "asked" });
      if (!job) return { type: "done", ok: false, ask: true, said: `I can't find ${item.label} in the job log, so I won't guess. Which job do you mean?`, kind: "ask", decision: d, ...base };
      return { type: "done", ok: true, said: `${job.title || item.label} is ${job.state}${job.targetDeviceId && job.targetDeviceId !== "none" ? ` on ${label(job.targetDeviceId)}` : ""}.`, kind: "answer", decision: d, numbers: { jobId: item.id, state: job.state }, verified: true, ...base };
    }
    if (opening && item.href) {
      const d = decisionOf({ op: "navigate", target: item.href, confidence: 1, policy: "act", source: "context", why: `"${item.label}" is the ${tier} ${item.kind} on ${page.page}` });
      out({ type: "decision", decision: d, seq: 0 });
      ctx.step({ intent: `context: open ${item.kind} "${item.label}"`, executor: "none", jev: d, ms: 0, outcome: "ok" });
      return { type: "done", ok: true, said: `Opening ${item.label}.`, kind: "navigate", navigate: { path: item.href }, decision: d, verified: null, ...base };
    }
    if (opening) {
      const d = decisionOf({ op: "context.open", target: item.label, confidence: 0, policy: "ask", source: "context", why: `"${item.label}" has no page of its own` });
      out({ type: "decision", decision: d, seq: 0 });
      ctx.step({ intent: `context: "${item.label}" has no view to open`, executor: "none", jev: d, ms: 0, outcome: "asked" });
      return { type: "done", ok: false, ask: true, said: `${item.label} doesn't have a page of its own that I can open. What would you like to see?`, kind: "ask", decision: d, ...base };
    }
    // Anything else about the item is a question for the brain, WITH the item's shown facts (never invented).
    const facts = Object.entries(item.data ?? {}).map(([k, v]) => `${k}: ${v}`).join("; ");
    const d = decisionOf({ op: "delegate.brain", target: item.label, confidence: 1, policy: "delegate", delegateTo: "brain", source: "context", why: `a question about "${item.label}" (${item.kind}) on ${page.page}` });
    out({ type: "decision", decision: d, seq: 0 });
    ctx.step({ intent: `context: delegate a question about ${item.kind} "${item.label}" to the brain`, executor: "handoff", jev: d, ms: 0, outcome: "note" });
    return {
      type: "done", ok: false, kind: "handoff", decision: d, verified: null, ...base,
      said: "That's a question for the chat brain; I've given it what the page shows.",
      handoff: { to: "brain", intent: "context", reason: d.why, utterance: `${utterance}\n[On ${page.page}, "${item.label}" (${item.kind})${facts ? `: ${facts}` : ""}. Use only these figures; say if something isn't shown.]` },
    };
  }

  async function delegate(
    rule: Extract<RulePlan, { lane: "delegate" }>,
    principal: Principal,
    memoryCaller: unknown,
    utterance: string,
    body: CommandBody,
    start: (targetDeviceId: string, work: (ctx: ExecutorContext, out: (e: CommandStreamEvent) => void) => Promise<CommandDoneEvent>) => Promise<CommandDoneEvent>,
    decisionOf: (d: Omit<JevDecision, "calibrationRunId">) => JevDecision,
    note: (ctx: ExecutorContext, s: Omit<Step, "seq" | "at" | "ms"> & { ms?: number }) => Step | null,
    /** Jev chose this delegate (the controller): the decision is Jev's, at its confidence. Absent: a rule's. */
    by?: { source: "jev" | "fallback"; confidence: number },
    /** Called with the job this delegate runs in (the fallback records Jev's miss on it as a receipt). */
    onJob?: (jobId: string) => void,
    followRecord?: CrmRef | null,
  ): Promise<CommandDoneEvent> {
    return start("none", async (ctx, out) => {
      onJob?.(ctx.jobId);
      const base = { jobId: null, runId: "", targetDeviceId: "none" } as const;
      const d = decisionOf({ op: rule.op, confidence: by?.confidence ?? 1, policy: "delegate", delegateTo: rule.to, source: by?.source ?? "rules", why: rule.why });
      out({ type: "decision", decision: d, seq: 0 });
      const began = Date.now();
      markDispatch(ctx.jobId);
      const finish = (ok: boolean, said: string, verified: boolean | null, extra: Partial<CommandDoneEvent> = {}): CommandDoneEvent => {
        note(ctx, { intent: `delegate → ${rule.to}: ${said.slice(0, 160)}`, executor: rule.to, jev: d, ms: Date.now() - began, outcome: ok ? "ok" : verified === null ? "note" : "failed", verification: { method: `${rule.to}-service`, ok: verified } });
        // A failed delegate is "unavailable" (nothing to hand on); only a real handoff carries kind handoff.
        return { type: "done", ok, said, kind: ok ? "answer" : extra.handoff ? "handoff" : extra.ask ? "ask" : "unavailable", decision: d, verified, ...base, ...extra };
      };
      if (rule.to === "memory") {
        if (!deps.delegates?.memory || !memoryCaller) return finish(false, "Shared memory isn't connected on this server, so nothing was saved or changed.", null);
        const r = await deps.delegates.memory(utterance, memoryCaller, typeof body.spokenYes === "string" ? body.spokenYes : null).catch(() => ({ said: "Memory isn't answering right now, so I haven't saved or changed anything.", outcome: "error" }));
        if (!r) return finish(false, "That didn't read as a memory request, so nothing was saved.", null);
        // Done only when the memory service confirms it stored, changed or found something (REVIEW-T2 #1).
        const m = memoryOutcome(r.outcome);
        note(ctx, { intent: `memory outcome: ${r.outcome} (${m.what})`, executor: "memory", jev: d, outcome: "note" });
        if (m.kind === "done") return finish(true, r.said, true);
        if (m.kind === "question") return finish(false, r.said, null, { ask: true, awaiting: true });
        return finish(false, r.said, m.kind === "not-done" ? false : null);
      }
      if (rule.op === "crm.questions") {
        const plan = businessQuestionsIn(utterance);
        if (plan?.kind !== "questions") return finish(false, "I couldn't separate those into supported read-only questions, so nothing ran.", null, { ask: true });
        if (body.spokenTarget || splitSpokenTarget(String(body.utterance ?? "")).spokenTarget) return finish(false, "Those questions name a device. I can't answer them on that device through the business services, so nothing ran.", null, { ask: true });
        if (!isBrowserPrincipal(principal)) return finish(false, "Only a signed-in founder can read the CRM from here.", null);
        // Check all required services first. Never run only a prefix then silently drop the rest.
        if (plan.questions.some(q => q.to === "crm" ? !deps.delegates?.crm : !deps.delegates?.leads)) return finish(false, "A service needed for those questions isn't connected here, so I haven't answered any of them.", null);
        const answers: string[] = [];
        for (const [i, q] of plan.questions.entries()) {
          if (ctx.signal.aborted) return finish(false, [...answers, "Stopped. The remaining questions were not answered."].join("\n"), null, { stopped: true });
          const r: CrmAnswer = await (q.to === "crm"
            ? deps.delegates!.crm!(q.intent, principal, (body.pageContext as PageContext | undefined) ?? null)
            : deps.delegates!.leads!(q.action, principal)).catch(() => ({ ok: false, said: "That service didn't answer, so I won't guess.", verified: null }));
          if (ctx.signal.aborted) return finish(false, [...answers, "Stopped. The remaining questions were not answered."].join("\n"), null, { stopped: true });
          answers.push(`${i + 1}. ${r.said}`);
          note(ctx, { intent: `business question ${i + 1}/${plan.questions.length}: ${q.words.slice(0, 120)}`, executor: q.to, jev: d, outcome: r.ok && r.verified === true ? "ok" : "failed", verification: { method: `${q.to}-service`, ok: r.verified } });
          if (!r.ok || r.verified !== true) {
            if (i + 1 < plan.questions.length) answers.push("The remaining questions were not answered.");
            return finish(false, answers.join("\n"), r.verified, r.ask ? { ask: true } : {});
          }
        }
        return finish(true, answers.join("\n"), true);
      }
      if (rule.to === "leads") {
        const action = leadActionIn(utterance);
        if (action?.action === "count" && !isBrowserPrincipal(principal)) return finish(false, "Only a signed-in founder can read the CRM from here.", null);
        if (!action || !deps.delegates?.leads) return finish(false, "The leads service isn't connected here, so nothing in the CRM changed.", null);
        const r = await deps.delegates.leads(action, principal, typeof body.eventId === "string" ? body.eventId : undefined, ctx.jobId).catch((e: Error) => ({ ok: false, said: `The CRM didn't take it: ${e.message.slice(0, 120)}`, verified: false as boolean | null }));
        return finish(r.ok && r.verified !== false, r.said, r.verified, r.ok ? {} : { ask: /which one/i.test(r.said) });
      }
      if (rule.to === "crm") {
        const intent = crmIntentIn(utterance);
        if (intent && intent.kind !== "typed" && "name" in intent && followRecord) intent.reference = followRecord;
        if (!intent || !deps.delegates?.crm) return finish(false, "The CRM isn't connected here, so nothing in it changed.", null);
        if (followRecord === null) return finish(false, "Which CRM record do you mean? Name or open it first.", null, { ask: true });
        const referenceGeneration = randomUUID();
        // Invalidate before a new result-producing lookup. If its final reference write fails, an older record must not survive it.
        if (["search", "open", "stage"].includes(intent.kind)) {
          if (deps.threads && isBrowserPrincipal(principal)) {
            try {
              if (!deps.threads.rememberCrmRecord(principal.personId, body.conversationId, null, referenceGeneration)) return finish(false, "I couldn't save context in this conversation, so that CRM lookup was not run.", null);
            } catch { return finish(false, "I couldn't save context in this conversation, so that CRM lookup was not run.", null); }
          } else {
            lastRecords.set(recordsKey(principal.personId, body.conversationId), { pending: referenceGeneration });
            while (lastRecords.size > 200) lastRecords.delete(lastRecords.keys().next().value!);
          }
        }
        const r = await deps.delegates.crm(intent, principal, (body.pageContext as PageContext | undefined) ?? null, typeof body.eventId === "string" ? body.eventId : undefined).catch((): CrmAnswer => ({ ok: false, said: "The CRM didn't answer, so nothing changed.", verified: null }));
        if (r.ok && r.verified === true && r.record && !rememberRecord(principal, body.conversationId, r.record, referenceGeneration))
          r.said += " I couldn't save its conversation reference. Name the record explicitly in your next request.";
        // A question never navigates (5 Oct: a stage question took the page from /jarvis to the CRM and the conversation left the screen).
        // The read's record is a link in the typed answer; only an explicit "open ..." (and the CRM's own writes) open a page.
        const reading = "kind" in intent && (intent.kind === "search" || intent.kind === "next" || intent.kind === "stage" || intent.kind === "drafts");
        const link = reading && r.ok && r.navigate && body.source !== "voice" && /^\/crm\?ref=[\w%:.-]+(?:&tab=[a-z]+)?$/.test(r.navigate.path) ? ` Open it: ${r.navigate.path}` : "";
        return finish(r.ok && r.verified !== false, `${r.said}${link}`, r.verified, { ...(r.navigate && !reading ? { navigate: r.navigate } : {}), ...(r.ask ? { ask: true } : {}) });
      }
      if (rule.to === "reminder") {
        const words = rememberToReminder(utterance);
        if (!words || !deps.delegates?.reminder) return finish(false, "Reminders aren't connected here, so nothing was set.", null);
        const r = await deps.delegates.reminder(words, principal).catch(() => ({ ok: false, said: "The reminder didn't set, so there's nothing scheduled." }));
        return finish(r.ok, r.said, r.ok);
      }
      if (rule.to === "receptionist") {
        if (!deps.delegates?.receptionist) return finish(false, "I can't read the receptionist's feed from here, so I won't guess.", null);
        const r: { ok: boolean; said: string; verified?: boolean | null } = await deps.delegates.receptionist(utterance).catch(() => ({ ok: false, said: "The receptionist's feed didn't answer, so I won't guess." }));
        return finish(r.ok, r.said, r.verified ?? r.ok);
      }
      return finish(false, "That's one for another of my tools.", null, { handoff: { to: rule.to, intent: rule.op, reason: rule.why, utterance } });
    });
  }

  /** Re-attach to a running (or just-finished) job's stream: events after `since`, then live until done. */
  function attach(jobId: string, principal: Principal, since: number, listener: (e: CommandStreamEvent) => void): { ok: true; detach: () => void } | { ok: false; reason: string } {
    const l = live.get(jobId);
    if (!l) return { ok: false, reason: "That command has finished or isn't known here; its outcome is in the job log." };
    if (l.personId !== principal.personId) return { ok: false, reason: "That's someone else's command." };
    if (l.grace) {
      clearTimeout(l.grace);
      l.grace = undefined;
    }
    for (const e of l.events) if (e.type === "done" || (e.seq ?? 0) > since) listener(e);
    if (l.done) return { ok: true, detach: () => undefined };
    l.listeners.add(listener);
    return { ok: true, detach: () => void l.listeners.delete(listener) };
  }

  /** The stream closed without its done: keep the job running for the grace period, then cancel it. */
  function dropped(jobId: string, listener?: (e: CommandStreamEvent) => void) {
    const l = live.get(jobId);
    if (!l || l.done) return;
    if (listener) l.listeners.delete(listener);
    if (l.listeners.size || l.grace) return;
    l.grace = setTimeout(() => {
      l.grace = undefined;
      if (!l.done && !l.listeners.size) void deps.jobs().cancel(jobId).catch(() => undefined);
    }, graceMs);
    l.grace.unref?.();
  }

  /** Stop one command (voice "stop", the pill's Stop): through the job service, at once. */
  /** Stop one job. `ok` only when the job service CONFIRMS it reached cancelled; `outcome` says what is really known (release re-check M1). */
  async function cancel(jobId: string, principal: Principal): Promise<{ ok: boolean; state: string | null; outcome: StopOutcome; by?: string; reason?: string }> {
    const job = deps.jobs().get(jobId);
    if (!job) return { ok: false, state: null, outcome: "no-job", reason: "No such job." };
    // Shared workspace (V7): either founder may stop a job; the job log records who asked.
    const result = await deps.jobs().cancel(jobId).catch(() => null);
    const outcome = stopOutcome(result);
    return { ok: outcome === "stopped", state: (result?.state as string | null) ?? job.state, outcome, by: principal.personId };
  }

  /**
   * His Stop before the job id reached him (release re-check B1): the command with this event id is stopped. If its job exists already it is
   * cancelled through the job service (confirmed or not, as above); otherwise the event is recorded so the job never starts ("prevented").
   */
  async function cancelEvent(eventId: string, principal: Principal): Promise<{ ok: boolean; state: string | null; outcome: StopOutcome | "prevented"; jobId?: string }> {
    const key = commandRequestId(principal.personId, eventId);
    const recorded = deps.jobs().requestCommandStop(principal.personId, eventId);
    // The effective delegated task is distinct from a command wrapper that may have already finished.
    const bound = recorded.record;
    const targetId = bound.taskId ?? bound.jobId;
    const targetKind = bound.taskKind ?? bound.jobKind;
    if (targetKind === "coding" && targetId) {
      const reply = await deps.delegates?.coding?.(`stop the coding job ${targetId}`, {
        personId: principal.personId, actor: principal.actor === "human" ? "human" : "process",
        via: principal.via === "loopback-owner" ? "local" : principal.via === "telegram-owner" ? "telegram" : "tailnet", spokenYes: null,
      }).catch(() => null);
      // The command-entry adapter supplies observed state. Text alone is never confirmation.
      const state = reply?.jobId === targetId ? reply.jobState : undefined;
      const outcome = state === "cancelled" ? "stopped" : state === "completed" || state === "failed" ? "already-ended" : "unconfirmed";
      return { ok: outcome === "stopped", state: state ?? null, outcome, jobId: targetId };
    }
    const job = targetKind === "job" && targetId ? deps.jobs().get(targetId) : deps.jobs().byRequest(key);
    if (job && job.principal.personId === principal.personId) return { ...(await cancel(job.id, principal)), jobId: job.id };
    // No process-local evidence can turn an admitted, possibly dispatched request into "prevented" after restart.
    if (recorded.outcome !== "prevented" || inProgress.has(`${principal.personId}|${eventId}`)) return { ok: false, state: null, outcome: "unconfirmed" };
    return { ok: true, state: null, outcome: "prevented" };
  }

  /** Every running command job of this person (voice "stop" with no job id): which stops were confirmed, and which weren't. */
  async function cancelAllForDetailed(principal: Principal): Promise<{ stopped: string[]; unconfirmed: string[] }> {
    const stopped: string[] = [];
    const unconfirmed: string[] = [];
    for (const [jobId, l] of live) {
      if (l.done || l.personId !== principal.personId) continue;
      const outcome = stopOutcome(await deps.jobs().cancel(jobId).catch(() => null));
      if (outcome === "stopped") stopped.push(jobId);
      else if (outcome === "unconfirmed") unconfirmed.push(jobId);
    }
    return { stopped, unconfirmed };
  }
  /** The confirmed stops only (callers that list what stopped). */
  async function cancelAllFor(principal: Principal) {
    return (await cancelAllForDetailed(principal)).stopped;
  }

  // The conversation-aware front (event dedupe, follow-ups, thread links): the same single path, wrapped, never a second one.
  const run = createLinkedRunner({
    core: runCore,
    threads: deps.threads,
    jobs: deps.jobs,
    now: deps.now,
    isStop: (utterance) => STOP_WORDS.test(utterance),
    deviceLabel: label,
    ...(deps.bots ? { bots: { scope: deps.bots.scope, nameOf: deps.bots.nameOf, threadIds: deps.bots.threadIds } } : {}),
    coding: deps.delegates?.coding ? (utterance, turn) => deps.delegates!.coding!(utterance, turn) : undefined,
  });

  /** Thread entries after `after` for this verified person (never someone else's); null when the thread isn't his. */
  function threadUpdates(principal: Principal, conversationId: string | undefined, after: number) {
    return deps.threads?.updates(principal.personId, conversationId, after) ?? { conversationId: conversationId ?? "", entries: [] };
  }

  /** Round 11: a typed request or its reply into this verified person's own default Jarvis thread (keyed: a repeat writes nothing). */
  function threadSay(principal: Principal, input: { requestId: string; part: "user" | "reply" | "note"; role: "user" | "assistant"; text: string; conversationId?: string }) {
    // Dot's own Jarvis (scripts/gateway/hub-ops.ts /tasks): the gate-verified gateway principal saves into Dot's OWN default thread only
    // (personId "dot", never a founder's, never a caller-chosen conversation). Everyone else needs a verified founder session.
    const gateway = principal.via === "gateway" && principal.actor === "process";
    if (gateway ? input.conversationId !== undefined : principal.actor !== "human" || !["paired-session", "loopback-owner"].includes(principal.via)) throw new TypedPersistenceError("A verified founder session is needed to save this typed request.", 403);
    return deps.threads?.say(principal.personId, { key: `${input.requestId}:${input.part}`, role: input.role, text: input.text, ...(input.conversationId ? { conversationId: input.conversationId } : {}) }) ?? null;
  }

  /** Is this one of the person's conversations with an agent bot? */
  const isBotThread = (personId: string, conversationId: string | undefined) => !!conversationId && !!deps.bots?.threadIds(personId).includes(conversationId);

  return { run, attach, dropped, cancel, cancelEvent, threadSay, cancelAllFor, cancelAllForDetailed, threadUpdates, isBotThread, liveJobs: () => [...live.keys()] };
}

function narration(executor: ExecutorName, target?: string) {
  switch (executor) {
    case "app.open":
      return `opening ${target ?? "the app"}`;
    case "open-url":
      return `opening ${target ?? "the page"}`;
    case "file.open":
      return `opening ${target ?? "the file"}`;
    case "deck.blank":
      return "starting a new PowerPoint with a title slide";
    case "notepad.type":
      return "typing the line into a new Notepad document";
    case "app.focus":
      return `bringing ${target ?? "the app"} to the front`;
    case "browser.navigate":
      return `opening ${target ?? "the page"} in the browser`;
    case "observe.window":
      return "checking which window is in front";
    default:
      return executor;
  }
}

export type CommandService = ReturnType<typeof createCommandService>;
/** Thrown by a lane that found its event already stopped just before it would start work; runCore answers "stopped before it started". */
class StoppedBeforeStart extends Error {}
export { HANDOFF_SPECIALISTS };

/**
 * The memory service's outcome → whether a command is done (REVIEW-T2 #1). Stored: remembered, saved to the
 * vault, corrected, forgotten, or already there (duplicate). Found: recalled. A question (needs-confirm) waits
 * for his yes. Everything else (writes off → refused, not found, not indexed, cancelled, an error) is NOT done.
 */
export function memoryOutcome(outcome: string): { kind: "done" | "question" | "not-done" | "unknown"; what: string } {
  switch (outcome) {
    case "remembered":
      return { kind: "done", what: "stored in Hindsight memory" };
    case "saved-to-vault":
      return { kind: "done", what: "saved to the vault note" };
    case "duplicate":
      return { kind: "done", what: "already stored" };
    case "corrected":
      return { kind: "done", what: "the stored fact was changed" };
    case "forgotten":
      return { kind: "done", what: "removed" };
    case "recalled":
      return { kind: "done", what: "found and cited" };
    case "needs-confirm":
      return { kind: "question", what: "waiting for his yes" };
    case "refused":
    case "not-found":
    case "unindexed":
    case "cancelled":
      return { kind: "not-done", what: outcome };
    default:
      return { kind: "unknown", what: outcome || "no outcome reported" };
  }
}
