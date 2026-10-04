/**
 * The Jev controller decision (round 10, brief §3 and §4): ONE bounded TypeSafe decision for a request no exact rule planned.
 *
 *   his words (data, never rewritten) + the capability catalogue that is ACTUALLY available to this person now
 *     → one Jev request with batched typed questions (lane choice, worker choice, multi/outbound nouls)
 *     → validated: every choice must be an option we offered; anything else is "unsure", never acted on
 *     → a typed decision the command service executes with deterministic code (permissions, devices, leases, pins stay code).
 *
 * Jev picks the lane and the worker; it never writes arguments. The original request, the page's record ids and the person's device stay
 * data the executors receive unchanged. A language model is NEVER asked to route here, and when Jev is out (no key, timeout, an error or an
 * unreadable reply) the result says so: `unavailable`, with the reason, so the caller can tell him plainly (brief §4.12) instead of
 * substituting another router.
 */
import { jevDecide, type JevAnswers, type JevOutcome } from "./jev-client";

/**
 * A lane the controller can choose: what kind of executor serves this request.
 *   device.open    open a website or search the web on HIS paired device (the exact query/site is taken from his words by code)
 *   device.screen  open-ended screen work on his device (the companion's screen loop)
 *   bot            one of his agents, on its own computer (research, building, business prep)
 *   coding         a coding job (drafted; started only by his "start it")
 *   crm            a business record (lead, client, deal, quote, invoice, task) through the CRM's typed operations
 *   memory         recall or save in shared memory
 *   page           open one of the OS's own pages (the UI navigates; no device acts)
 *   answer         a built-in exact answer or skill (prices, margins, time, maths, a timer or reminder, the receptionist's status)
 *   brain          answer, explain or write; nothing acts
 */
export type ControllerLane = "device.open" | "device.screen" | "page" | "answer" | "bot" | "computer" | "coding" | "crm" | "memory" | "brain" | "ask";

export type Catalogue = {
  /** His own paired device (never the hub, never someone else's), labelled for Jev; `screen` when it runs open-ended screen goals. */
  device: { label: string; screen: boolean } | null;
  /** The chat brain answers questions and writes (no hands). */
  brain: boolean;
  /** The coding harness drafts a coding job (started only by his "start it"). */
  coding: boolean;
  /** Agent bots that can take a task on their own computer: id → one line on what it is for. */
  bots: { id: string; name: string; purpose: string }[];
  /** The CRM's typed operations are connected here. */
  crm?: boolean;
  /** Shared memory is connected here (for this caller). */
  memory?: boolean;
  /** The OS's own pages can be opened (always true for a person at a browser). */
  page?: boolean;
  /** Built-in exact answers and skills are connected. */
  answer?: boolean;
  /** A shared computer he NAMED (the target is fixed to it): the "computer" lane means "do this task on that computer". */
  computer?: { name: string } | null;
};

/** The Jev call behind a decision: its router request id (the receipt) and the model that answered. Absent: no call was made. */
export type JevEvidence = { requestId: string; model: string; inputTokens: number | null };
/** What the receipt shows for every Jev decision: the options offered, the choice, and whether it came from the decision cache. */
type Shown = { options: string[]; cached: boolean; evidence?: JevEvidence; /** A cached decision: how old the original Jev call is. */ cacheAgeMs?: number };

export type ControllerDecision =
  | ({ kind: "decided"; lane: Exclude<ControllerLane, "ask">; bot?: string; /** For an agent: a coding job or a task on its own computer (Jev's choice). */ botLane?: "coding" | "computer"; confidence: number; ms: number; multi: number; outbound: number } & Shown)
  | ({ kind: "ask"; confidence: number; ms: number; why: string } & Shown)
  /** Jev chose a lane the request's constraints (named target, pins, permissions, availability) don't allow: never acted on, never reinterpreted. */
  | ({ kind: "rejected"; choice: string; confidence: number; ms: number } & Shown)
  | { kind: "unavailable"; reason: "no-key" | "timeout" | "unavailable" | "http" | "unreadable" | "cancelled" | "invalid"; ms: number; options?: string[]; cached?: boolean; evidence?: JevEvidence; cacheAgeMs?: number };

/** Below this Jev's lane is not acted on: he gets one clarifying question instead. */
export const CONTROLLER_ACT = 0.6;

const LANE_TEXT: Record<Exclude<ControllerLane, "bot" | "computer">, string> = {
  "device.open": "Open a website, or search the web (Google) for something he names, on his own computer",
  "device.screen": "Work an app, a website or a form on his own computer's screen: clicks, typing, several steps",
  coding: "Change software code in one of his repositories (fix a bug, build a feature): a coding job.",
  crm: "A business record in the CRM: search clients, contacts, deals, projects, quotes, invoices, tasks or files; open one by name; save a note or create a task on a named client or deal; draft a quote or invoice from the agreed price (nothing sent); show the next action or the unsent drafts.",
  memory: "Recall something he saved, or save a fact to his shared memory.",
  page: "Open one of the OS's own pages (Leads, Finance, Coding, Agents, Settings and so on) in this app.",
  answer: "A quick built-in answer or skill: package prices or margins, the time or date, arithmetic, a timer or reminder, the receptionist's status.",
  brain: "Answer, explain, advise, chat or write something; no computer needs to do anything.",
  ask: "It isn't clear what he wants done, or where; ask him one short question.",
};

/** The lanes this catalogue offers, in a stable order: only what can actually run now. Pure. */
export function offeredLanes(cat: Catalogue): ControllerLane[] {
  return [
    ...(cat.device ? (["device.open"] as const) : []),
    ...(cat.device?.screen ? (["device.screen"] as const) : []),
    ...(cat.page ? (["page"] as const) : []),
    ...(cat.answer ? (["answer"] as const) : []),
    ...(cat.bots.length ? (["bot"] as const) : []),
    ...(cat.computer ? (["computer"] as const) : []),
    ...(cat.coding ? (["coding"] as const) : []),
    ...(cat.crm ? (["crm"] as const) : []),
    ...(cat.memory ? (["memory"] as const) : []),
    ...(cat.brain ? (["brain"] as const) : []),
    "ask",
  ];
}

/** The questions for this catalogue: finite options only, each one something that can actually run now. Pure. */
export function controllerQuestions(cat: Catalogue): Record<string, unknown> {
  const lanes: Record<string, string> = {};
  for (const lane of offeredLanes(cat)) {
    if (lane === "bot") lanes.bot = cat.bots.length === 1 ? `Give it to ${cat.bots[0].name} (the agent he named) to do on its own computer or as its coding job.` : "Give it to one of his agents to do on its own computer (research, building a website, preparing business work).";
    else if (lane === "computer") lanes.computer = `Do it on the shared computer he named ("${cat.computer!.name}").`;
    else if (lane === "device.open" || lane === "device.screen") lanes[lane] = `${LANE_TEXT[lane]} (${cat.device!.label}).`;
    else lanes[lane] = LANE_TEXT[lane];
  }
  return {
    lane: { type: "choice", instructions: "Which kind of worker should handle what he just asked Jarvis to do?", criteria: lanes },
    ...(cat.bots.length
      ? {
          bot: { type: "choice", instructions: "If an agent should do it, which one?", criteria: { ...Object.fromEntries(cat.bots.map((b) => [b.id, `${b.name}: ${b.purpose}`])), none: "No agent" } },
          bot_lane: { type: "choice", instructions: "If an agent does it, what kind of task is it?", criteria: { computer: "A task on the agent's own computer: research, browsing, building or checking a website, preparing business work.", coding: "A coding job: change code in one of his repositories (fix a bug, build a feature)." } },
        }
      : {}),
    multi: { type: "noul", instructions: "He asked for two or more separate actions, or a task with several steps." },
    outbound: { type: "noul", instructions: "Doing this would send a message or email, call someone, spend or move money, publish, delete or deploy." },
  };
}

const conf = (a: JevAnswers[string] | undefined) => (typeof a?.confidence === "number" ? a.confidence : 0);
const noul = (a: JevAnswers[string] | undefined) => (typeof a?.noul === "number" ? a.noul : 0);

/** The agent task kind Jev chose, only when it is one of the two offered (otherwise the agent's own rules decide). Pure. */
const botLaneOf = (answers: JevAnswers): { botLane?: "coding" | "computer" } => {
  const c = answers.bot_lane?.choice;
  return c === "coding" || c === "computer" ? { botLane: c } : {};
};

/** Jev's answers → a validated decision. A choice we didn't offer, or a bot lane with no offered bot, is never acted on. Pure. */
export function validateDecision(answers: JevAnswers, cat: Catalogue, ms: number, cached = false): ControllerDecision {
  const options: string[] = offeredLanes(cat);
  const lane = answers.lane?.choice;
  if (!lane) return { kind: "unavailable", reason: "invalid", ms, options, cached };
  const confidence = conf(answers.lane);
  if (!options.includes(lane)) return { kind: "rejected", choice: lane, confidence, ms, options, cached };
  const shown = { options, cached };
  if (lane === "ask") return { kind: "ask", confidence, ms, why: "Jev judged the request unclear", ...shown };
  if (confidence < CONTROLLER_ACT) return { kind: "ask", confidence, ms, why: `Jev was ${Math.round(confidence * 100)}% sure (below ${CONTROLLER_ACT * 100}%)`, ...shown };
  let bot: string | undefined;
  if (lane === "bot") {
    const choice = answers.bot?.choice;
    if (choice && choice !== "none" && !cat.bots.some((b) => b.id === choice)) return { kind: "rejected", choice: `bot:${choice}`, confidence: conf(answers.bot), ...shown, ms };
    if (!choice || choice === "none") return cat.bots.length === 1 ? { kind: "decided", lane: "bot", bot: cat.bots[0].id, ...botLaneOf(answers), confidence, ms, multi: noul(answers.multi), outbound: noul(answers.outbound), ...shown } : { kind: "ask", confidence: conf(answers.bot), ms, why: "no agent was clearly the one", ...shown };
    bot = choice;
  }
  return { kind: "decided", lane: lane as Exclude<ControllerLane, "ask">, ...(bot ? { bot, ...botLaneOf(answers) } : {}), confidence, ms, multi: noul(answers.multi), outbound: noul(answers.outbound), ...shown };
}

export type ControllerDeps = {
  /** The TypeSafe key, read by name by the caller; "" = no key (Jev is unavailable, said plainly). */
  key: () => string;
  /** Injectable for tests; default the one Jev client. */
  decide?: (call: Parameters<typeof jevDecide>[0]) => Promise<JevOutcome>;
  request?: typeof fetch;
  /** The decision cache (normalised words + the options offered → Jev's answers). Default: one per process; null turns it off. */
  cache?: ControllerCache | null;
};

/** Repeat requests skip the network: the same words with the same options offered get Jev's same answers (marked cached on the receipt). */
export class ControllerCache {
  private map = new Map<string, { answers: JevAnswers; evidence?: JevEvidence; at: number }>();
  constructor(private max = 256, private ttlMs = 30 * 60_000, private now: () => number = Date.now) {}
  get(key: string) {
    const hit = this.map.get(key);
    if (!hit || this.now() - hit.at > this.ttlMs) return (this.map.delete(key), null);
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }
  set(key: string, answers: JevAnswers, evidence?: JevEvidence) {
    this.map.delete(key);
    this.map.set(key, { answers, ...(evidence ? { evidence } : {}), at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}
const sharedCache = new ControllerCache();
/**
 * The cache key: WHO asked, the context ids (target device, page, record), the options offered (which already encode the named target, the pins,
 * permissions and what is available now) and the words. Any of those different is a different decision.
 */
const cacheKey = (utterance: string, cat: Catalogue, principal: string, context: Record<string, string>) =>
  [principal, Object.entries(context).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&"), offeredLanes(cat).join(","), cat.bots.map((b) => b.id).join(","), cat.computer?.name ?? "", cat.device?.label ?? "", utterance.toLowerCase().replace(/[.!?,;:]+/g, " ").replace(/\s+/g, " ").trim()].join("|");

/**
 * One controller decision. `context` carries ids only (the page's selected record ids, the device id), never free text the person didn't say.
 * Never throws.
 */
export async function decideTask(input: { utterance: string; catalogue: Catalogue; context?: Record<string, string>; /** Who asked (the verified person): part of the cache key. */ principal?: string }, deps: ControllerDeps): Promise<ControllerDecision> {
  const key = deps.key();
  if (!key) return { kind: "unavailable", reason: "no-key", ms: 0, options: offeredLanes(input.catalogue) };
  const cache = deps.cache === undefined ? sharedCache : deps.cache;
  const ck = cacheKey(input.utterance, input.catalogue, input.principal ?? "", input.context ?? {});
  const hit = cache?.get(ck);
  if (hit) {
    // Only the DECISION is reused (revalidated against today's options); the action itself runs again, and permissions are checked again
    // where it executes. The receipt says "cached", with the original call's request id and its age.
    const decision = validateDecision(hit.answers, input.catalogue, 0, true);
    return { ...decision, ...(hit.evidence ? { evidence: hit.evidence } : {}), cacheAgeMs: Math.max(0, Date.now() - hit.at) };
  }
  const questions = controllerQuestions(input.catalogue);
  const state = { utterance: input.utterance.slice(0, 600), ...Object.fromEntries(Object.entries(input.context ?? {}).map(([k, v]) => [k, String(v).slice(0, 120)])) };
  const out = await (deps.decide ?? jevDecide)({ surface: "command.controller", caller: "scripts/jev-controller.ts", key, state, questions, request: deps.request }).catch(
    (): JevOutcome => ({ ok: false, reason: "unavailable", httpStatus: null, ms: 0, receipt: null }),
  );
  if (!out.ok) return { kind: "unavailable", reason: out.reason, ms: out.ms, options: offeredLanes(input.catalogue) };
  const evidence: JevEvidence | undefined = out.receipt ? { requestId: out.receipt.requestId, model: out.receipt.model, inputTokens: out.receipt.inputTokens } : undefined;
  const decision = validateDecision(out.answers, input.catalogue, out.ms);
  // Only a decision worth repeating is cached (a valid choice); an invalid answer is asked again next time.
  if (decision.kind === "decided" || decision.kind === "ask") cache?.set(ck, out.answers, evidence);
  return evidence ? { ...decision, evidence } : decision;
}

/**
 * The plain line for a Jev outage on an open-ended request (brief §4.12): what is out, that nothing ran, what still works (the exact,
 * deterministic commands), and the one fix. Never a guess, never another model choosing instead.
 */
export function jevOutageLine(reason: string): string {
  const why = reason === "no-key" ? "Jev, my decision layer, isn't set up on this hub (no TypeSafe key)" : reason === "timeout" ? "Jev, my decision layer, didn't answer in time" : "Jev, my decision layer, isn't answering right now";
  return `${why}, so I won't guess where that should go, and nothing ran. Exact commands still work: open a website or an app, search Google for something, or name an agent like "Research, ...".${reason === "no-key" ? " Adding the TypeSafe key to the hub's configuration turns Jev on." : " Try again in a moment."}`;
}
