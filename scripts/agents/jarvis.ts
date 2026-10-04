import type { Principal as JobPrincipal } from "../approvals/principal";
import { claudeSlotFromWords } from "../coding/shaper";
import type { AccountsConfig } from "../coding/accounts";
import { planSteps } from "../computers/jarvis";
import type { ComputersService } from "../computers/service";
import { botThreadId, jarvisThreadId, parseBotConversationKey } from "../conversations";
import type { Principal } from "../identity/principal";
import type { CommandBody, PageContext } from "../jarvis-command/contracts";
import type { JobThreads } from "../jarvis-command/threads";
import type { JobService } from "../jobs/service";
import { SUBJECT_REF, type JevDecisionRef } from "../jobs/types";
import { crmSubjectsFrom } from "../jarvis-command/crm";
import { modelsForSlot } from "./accounts";
import { buildBrief, compactInstructions, type MemoryPort } from "./brief";
import type { LinksStore } from "./links";
import { misheardApp, namedBot } from "./named";
import type { Bot } from "./types";

/**
 * Bot-scoped Jarvis (Agents workspace): which bot a typed or spoken request is for, and what that bot does with it. The command service
 * (scripts/jarvis-command/service.ts) and its conversation front (linked-run.ts) call this through two small hooks; nothing here is a second
 * command path, a job engine or a planner:
 *
 *   scope(...)  WHO the turn is for, and the conversation it lands in. Pure over the stores; it starts nothing.
 *               The bot is, in this order: named in the words ("Ask Research to ...", "Have Builder ...", "Stop the Research task"), the
 *               request's own `target.bot` / the bot conversation it was typed in, and, only for words that point back ("show me its
 *               computer", "continue that task"), the bot whose page is open. A plain request in the default Jarvis thread is never a
 *               bot's: it stays there, exactly as before. A pointing word with two possible bots is ONE question, and nothing runs.
 *   run(...)    what the bot does: show its computer, report where its newest task is, a Builder coding job on the account named or set
 *               (refused honestly when that account isn't ready: never another account), or a computer job on THE BOT'S computer through
 *               the existing computers service. A bot with nowhere to run says so; nothing is ever re-routed to another machine, and a
 *               request that names the person's OWN device ("on my laptop") is not the bot's at all and goes the normal way.
 */

export type BotLite = { id: string; name: string };

export type BotScope =
  | { kind: "bot"; bot: BotLite; conversationId: string; utterance: string; via: "words" | "target" | "thread" | "page"; subjects: string[] }
  /** A request for the person's OWN device typed inside a bot conversation: not the bot's, and it stays in the default thread. */
  | { kind: "default"; conversationId: string }
  | { kind: "ask"; said: string }
  /** The request names a bot that doesn't exist: refused by name, nothing ran, nothing was sent anywhere else. */
  | { kind: "refuse"; said: string };

export type BotRunInput = {
  principal: Principal;
  bot: string;
  utterance: string;
  source: "voice" | "typed" | "away" | "acceptance";
  spokenYes?: string | null;
  subjects?: string[];
  pageContext?: PageContext | null;
  /**
   * Round 10: the kind of task the DECISION chose for this bot (the Jev controller), so the bot's own word rules don't decide it again: "coding" is a
   * coding job (refused, never turned into a computer task, when the bot doesn't do coding), "computer" a task on its computer. Absent: the words decide.
   */
  lane?: "coding" | "computer";
  /** Round 10: who decided to send this to the bot (the controller's step record), kept on the task so its row can say "Decided by". */
  decision?: JevDecisionRef | null;
};
export type BotRunResult = { ok: boolean; said: string; jobId?: string; deviceId?: string; navigate?: string; ask?: boolean; numbers?: Record<string, unknown> };

export type CodingBridge = {
  /** The coding command entry (the same shaper and per-person voice state typed and spoken coding words already use). */
  handle(utterance: string, turn: { personId: string; actor: "human" | "process"; via: string; spokenYes: string | null; /** The builder this job must use: exactly this account slot and model (null = automatic), or the request is refused. */ pin?: { accountSlot: string | null; model: string | null } | null }): Promise<{ say: string; navigate?: string; jobId?: string; jobState?: string; draft?: unknown } | null>;
  /** The coding detector the command registry and the voice rules use. */
  matches(utterance: string): boolean;
  /** Does this person have a coding draft or question open (a free-text answer then belongs to it)? */
  pending(personId: string, actor: "human" | "process"): boolean;
  /** The configured accounts (the accounts service's own list). */
  accounts(): AccountsConfig;
  /** An account's real readiness, re-checked before a job is drafted. ready null = not known yet. */
  accountReady(slot: string): Promise<{ ready: boolean | null; label: string; reason: string | null }>;
};

export type BotCommandsDeps = {
  bots: () => Bot[];
  computers: Pick<ComputersService, "list" | "view" | "jobView" | "startJob" | "canPlanGoals" | "canResearch" | "canWorkflows">;
  jobs: () => JobService;
  threads?: JobThreads;
  links: LinksStore;
  coding?: () => Promise<CodingBridge | null>;
  /** The shared memory pool (recall for a bot whose Setup turns recall on). Absent: recall is skipped with a note. */
  memory?: () => MemoryPort | null;
  now?: () => number;
};

const BARE_ANSWER = /^(?:yes|yeah|yep|yes please|go ahead|do it|confirm(?:ed)?|start it|start|run it|no|nope|cancel it|not now)[\s.!]*$/i;
const SMALLTALK = /^(?:thanks?(?: you)?|thank you|ok(?:ay)?|cheers|hi|hello|hey|great|nice|cool|good|got it|right|sure|brilliant|perfect)\b[\s.!,]*$/i;
const OWN_DEVICE = /\b(?:on|in|at)\s+my\s+(?:pc|laptop|computer|desktop|mac|phone|machine|windows|screen)\b|\bmy\s+(?:pc|laptop|phone)\b/i;
/** Why a computer refused a job, as the machine-readable blocker the conversation entry carries (the words stay in the reply). */
function blockerOfRefusal(reason: string, bot: Bot): { kind: "offline" | "needs-takeover"; recovery: string } {
  if (/\bis using\b|one controller/i.test(reason)) return { kind: "needs-takeover", recovery: `Someone or something is using ${bot.name}'s computer, so nothing ran. It runs one task at a time: wait for it to finish, or return control with Show computer beside the chat, then ask again.` };
  return { kind: "offline", recovery: `${bot.name}'s computer can't take a task right now. Start or recover it from the Computers page (or with Show computer beside the chat), then ask again. Nothing was queued.` };
}
const SHOW = /^(?:show|open|bring up|pull up)\s+(?:me\s+)?(?:its|the|his|her|your)?\s*(?:cloud\s+)?(?:computer|desktop|screen)\s*[.!?]*$/i;
const CONTINUE = /^(?:continue|resume|carry on(?: with)?|pick up)\s+(?:(?:that|this|the|it)(?:\s+(?:job|task|work|run))?|(?:job|task|work|run))\s*[.!?]*$/i;
const CODE_START = /^(?:fix|implement|refactor|rename|debug|investigate|change|update|remove)\b/i;

/** Every CRM reference the request is about: its own `subjects`, a page context's `crm` field, and focused or selected items of a CRM kind. Well-formed only. */
export function subjectsFrom(ctx: PageContext | null | undefined, explicit?: readonly string[]): string[] {
  const out: string[] = [];
  const REF = SUBJECT_REF;
  const add = (v: unknown) => {
    if (typeof v === "string" && REF.test(v) && !out.includes(v)) out.push(v);
  };
  for (const s of explicit ?? []) add(s);
  // The open CRM record (the CRM page publishes it as /crm?ref=...): the page the request was made on is the subject.
  for (const s of crmSubjectsFrom(ctx as never)) add(s);
  const c = (ctx as { crm?: unknown } | null | undefined)?.crm;
  for (const r of Array.isArray(c) ? c : c ? [c] : []) {
    if (typeof r === "string") add(r);
    else if (r && typeof r === "object") add(`crm:${String((r as { kind?: unknown }).kind)}:${String((r as { id?: unknown }).id)}`);
  }
  const KINDS = ["company", "contact", "deal", "project", "document", "lead"];
  for (const i of [ctx?.focused, ...(ctx?.selected ?? [])]) if (i && KINDS.includes(i.kind) && typeof i.id === "string") add(`crm:${i.kind}:${i.id}`);
  return out.slice(0, 8);
}

/** The bot whose workspace page is open: a focused or selected item of kind "bot", else the page path (/agents/workspace/<bot>). */
export function botFromPage(ctx: PageContext | null | undefined, bots: readonly Bot[]): string | null {
  if (!ctx) return null;
  for (const i of [ctx.focused, ...(ctx.selected ?? [])]) if (i?.kind === "bot" && bots.some((b) => b.id === i.id)) return i.id;
  const p = ctx as unknown as { page?: string | { path?: string } };
  const path = typeof p.page === "string" ? p.page : (p.page?.path ?? "");
  const m = /^\/agents(?:\/workspace)?\/([a-z0-9][a-z0-9-]{0,31})(?:[/?#]|$)/.exec(path);
  return m && bots.some((b) => b.id === m[1]) ? m[1] : null;
}

const STATE_WORDS: Record<string, string> = { online: "idle and ready", busy: "in use", asleep: "asleep", offline: "offline", starting: "starting up", failed: "failed" };

export function createBotCommands(deps: BotCommandsDeps) {
  const lite = (b: Bot): BotLite => ({ id: b.id, name: b.name });
  /** How many times each person was told a bot is ready (wording only: the reply alternates). */
  const readyTold = new Map<string, number>();
  const find = (id: string) => deps.bots().find((b) => b.id === id) ?? null;

  /**
   * A bot named in the words, and what is left of them (scripts/agents/named.ts: the same grammar the voice rules use). A bot named with no
   * task ("use the builder agent", "why can't you launch the Builder?") is an empty utterance: run() answers with where the bot stands.
   */
  function named(utterance: string, bots: readonly Bot[]): { bot: Bot; utterance: string } | null {
    const n = namedBot(utterance, bots);
    if (!n) return null;
    return { bot: n.bot, utterance: n.kind === "task" ? n.task : n.kind === "show" ? "show me its computer" : n.kind === "continue" ? "continue that task" : n.kind === "stop" ? "stop that task" : "" };
  }

  /** An archived bot refuses every new request; this is what Jarvis says (nothing ran, nothing was sent to another bot). */
  const archivedSaid = (bot: Bot) => `${bot.name} is archived, so it takes no new requests and nothing ran. Unarchive it from its Setup tab to use it again; its tasks, results and conversations stay readable.`;

  /** The bot a request is for, then the one rule that holds however it was found (by its name in the words, its target, its thread or the open page): an archived bot refuses. */
  function scope(input: { principal: Principal; utterance: string; body: Pick<CommandBody, "conversationId" | "target" | "subjects" | "pageContext"> }): BotScope | null {
    const r = scopeOf(input);
    if (r?.kind === "bot") {
      const bot = find(r.bot.id);
      if (bot?.archived) return { kind: "refuse", said: archivedSaid(bot) };
    }
    return r;
  }

  function scopeOf(input: { principal: Principal; utterance: string; body: Pick<CommandBody, "conversationId" | "target" | "subjects" | "pageContext"> }): BotScope | null {
    const bots = deps.bots();
    const active = bots.filter((b) => !b.archived);
    if (!bots.length) return null;
    const person = input.principal.personId;
    const text = input.utterance.trim();
    const subjects = subjectsFrom(input.body.pageContext, input.body.subjects);
    const place = (bot: Bot, utterance: string, via: "words" | "target" | "thread" | "page"): BotScope => ({ kind: "bot", bot: lite(bot), conversationId: botThreadId(person, bot.id), utterance, via, subjects });

    // 1. The words win: a bot named here is the bot, wherever the request was typed.
    const words = named(text, bots);
    if (words) return place(words.bot, words.utterance, "words");

    // A request made for a bot that doesn't exist is refused by name; nothing runs anywhere else.
    if (input.body.target?.bot && !find(input.body.target.bot)) return { kind: "refuse", said: `There's no bot called "${input.body.target.bot}" (the bots are ${active.map((b) => b.name).join(", ")}), so nothing ran.` };

    // 2. The bot the request was made for: its own target, or the bot conversation it was typed in (UUID or `agent:<person>:<bot>`).
    const key = parseBotConversationKey(input.body.conversationId);
    const fromKey = key && key.personId === person ? key.botId : null;
    const fromThread = input.body.conversationId ? (bots.find((b) => botThreadId(person, b.id) === input.body.conversationId)?.id ?? null) : null;
    const target = input.body.target?.bot && find(input.body.target.bot) ? input.body.target.bot : null;
    const own = [target, fromKey && find(fromKey) ? fromKey : null, fromThread].find((x): x is string => !!x) ?? null;
    if (own) {
      const bot = find(own)!;
      // Words about the person's OWN device are not a bot's request: they go the normal way, and stay in the default thread.
      if (OWN_DEVICE.test(text)) return { kind: "default", conversationId: jarvisThreadId(person) };
      return place(bot, text, target ? "target" : "thread");
    }

    // Words that point back at "the bot" rather than name one need an antecedent.
    const SHOW_ITS = /^(?:please\s+)?show\s+(?:me\s+)?(?:its|his|her|the bot'?s)\s+(?:cloud\s+)?(?:computer|desktop|screen)\s*[.!?]*$/i;
    const CONTINUE_IT = /^(?:please\s+)?(?:continue|resume|carry on(?: with)?|pick up)\s+(?:that|this|the|it)(?:\s+(?:job|task|work|run))?\s*[.!?]*$/i;
    // 3. Words that point back ("show me its computer", "continue that task"): the open page's bot. "show me its computer" with no page bot is ONE question
    // when there is more than one bot (and the only bot's when there is one); "continue that task" with no open bot stays the computers' own. A plain request is never a bot's.
    const showIts = SHOW_ITS.test(text);
    if (showIts || CONTINUE_IT.test(text)) {
      const open = botFromPage(input.body.pageContext, bots);
      if (open) return place(find(open)!, showIts ? "show me its computer" : "continue that task", "page");
      if (showIts) {
        const withComputer = active.filter((b) => b.computer);
        if (withComputer.length === 1) return place(withComputer[0], "show me its computer", "page");
        if (withComputer.length > 1) return { kind: "ask", said: `Whose computer: ${withComputer.slice(0, 3).map((b) => `${b.name}'s`).join(" or ")}? Say "show me ${withComputer[0].name}'s computer". Nothing ran.` };
      }
    }
    return null;
  }

  async function run(input: BotRunInput): Promise<BotRunResult | null> {
    const bot = find(input.bot);
    if (!bot) return { ok: false, said: `There's no bot called "${input.bot}", so nothing ran.` };
    // The one gate behind every way of asking (words, target, thread, page): an archived bot starts nothing.
    if (bot.archived) return { ok: false, said: archivedSaid(bot) };
    const person = input.principal.personId;
    const text = input.utterance.trim().replace(/^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?/i, "");
    const coding = bot.coding.enabled ? ((await deps.coding?.()) ?? null) : null;

    // A free-text answer to a coding question this person has open (the repo, "start it") belongs to that coding turn.
    const codingOpen = !!coding?.pending(person, input.principal.actor === "human" ? "human" : "process");

    // Named with no task ("use the builder agent", "why can't you launch the Builder?"): where the bot stands and what to say next. Nothing runs.
    if (!text.trim() && !codingOpen) return readiness(bot, person);
    if (SHOW.test(text)) return showComputer(bot);
    if (CONTINUE.test(text)) return continueTask(bot, person);
    if (!codingOpen && SMALLTALK.test(text)) return { ok: true, said: `Tell ${bot.name} what to do, or ask how its task is going. Nothing ran.`, ask: true };
    // A bare yes or no with nothing open to answer is not a task: it never becomes a job on the bot's computer.
    if (!codingOpen && BARE_ANSWER.test(text)) return { ok: true, said: `Nothing is waiting for a yes or no here. Tell ${bot.name} what to do. Nothing ran.`, ask: true };
    // The person's own device was named: not this bot's request (the normal path resolves it to THEIR companion, never the hub).
    if (OWN_DEVICE.test(input.utterance)) return null;

    // The decision chose coding: a coding job or a plain refusal, never quietly a computer task (and the reverse for "computer").
    if (input.lane === "coding" && !coding) return { ok: false, said: `${bot.name} doesn't take coding jobs (coding is off in its Setup), so nothing ran. Turn it on there, or ask Builder.` };
    if (coding && input.lane !== "computer") {
      const r = await codingTurn(bot, coding, input, text, codingOpen, input.lane === "coding");
      if (r) return r;
      if (input.lane === "coding") return { ok: false, said: `The coding harness didn't take that as a coding job, so nothing ran. Say which repo and what should change.`, ask: true };
    }
    // "Start a crowd" (speech-to-text's "start Chrome"): a one-word app nobody has, close to one everybody has. Asked in plain words, never run as a goal.
    const misheard = misheardApp(text);
    if (misheard) return { ok: false, ask: true, said: `I heard "${misheard.heard}" — did you mean "${misheard.meant}"? Nothing ran. What should ${bot.name} do?` };
    return computerTask(bot, input, text);
  }

  /** "Use the builder agent" with no task: whether the bot can take one now (its computer, from the computers service), and how to give it one. */
  function readiness(bot: Bot, person: string): BotRunResult {
    if (!bot.computer) return { ok: false, ask: true, said: `${bot.name} has no computer assigned yet, so it can't run tasks. Pick one in Agents › ${bot.name} › Setup. Nothing ran.`, navigate: `/agents/workspace/${bot.id}?tab=setup` };
    let state: string;
    try {
      state = deps.computers.view(bot.computer).state;
    } catch {
      return { ok: false, ask: true, said: `${bot.name}'s computer "${bot.computer}" doesn't exist yet. Create it on the Computers page, or pick another in Agents › ${bot.name} › Setup. Nothing ran.` };
    }
    if (state === "offline" || state === "failed") return { ok: false, ask: true, said: `${bot.name}'s computer is ${STATE_WORDS[state] ?? state}. Start it in Agents › ${bot.name} › Computer, then tell me what ${bot.name} should do. Nothing ran.` };
    // Asked again ("so I want you to use the Builder"): the same facts in other words, never the identical line twice running.
    const n = readyTold.get(`${person}|${bot.id}`) ?? 0;
    readyTold.set(`${person}|${bot.id}`, n + 1);
    return n % 2 === 0
      ? { ok: true, ask: true, said: `${bot.name} is ready on its own computer (${STATE_WORDS[state] ?? state}). What should ${bot.name} do? For example: "${bot.name}, open a Chrome tab". Nothing ran yet.` }
      : { ok: true, ask: true, said: `Nothing is stopping ${bot.name}: its computer is ${STATE_WORDS[state] ?? state}, it just needs a task. What should ${bot.name} do? Say the task after its name, like "${bot.name}, open Chrome".` };
  }

  // ── show / continue ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  function showComputer(bot: Bot): BotRunResult {
    const open = `/agents/workspace/${bot.id}?tab=computer`;
    if (!bot.computer) return { ok: false, said: `${bot.name} has no computer assigned. Pick one in its Setup tab. Nothing ran.`, navigate: `/agents/workspace/${bot.id}?tab=setup` };
    let v: ReturnType<BotCommandsDeps["computers"]["view"]>;
    try {
      v = deps.computers.view(bot.computer);
    } catch {
      return { ok: false, said: `${bot.name}'s computer "${bot.computer}" doesn't exist yet. Create it on the Computers page, or pick another in Setup.`, navigate: `/agents/workspace/${bot.id}?tab=setup` };
    }
    const job = v.assigned?.jobId ?? v.paused?.jobId;
    const jv = job ? deps.computers.jobView(job) : null;
    const who = v.controller.kind === "person" ? `${v.controller.who} is controlling it` : v.controller.kind === "agent" ? `${bot.name} is using it` : "nobody is using it";
    const said = `${bot.name}'s computer${v.label && v.label.toLowerCase() !== bot.name.toLowerCase() ? ` (${v.label})` : ""} is ${STATE_WORDS[v.state] ?? v.state}; ${who}${jv ? `; its job "${jv.title}" is ${jv.paused ? "paused for a person" : jv.state} after ${jv.steps.length} step${jv.steps.length === 1 ? "" : "s"}` : ""}${v.takeoverPending ? `; ${v.takeoverPending.by} is waiting to take control` : ""}. Opening it.`;
    return { ok: true, said, navigate: open, ...(v.id ? { deviceId: v.id } : {}), ...(job ? { jobId: job } : {}) };
  }

  /** "Continue the research": the bot's newest task, from the bot's own conversation. An open task is attached to; an ended one is reported, never re-run. */
  async function continueTask(bot: Bot, person: string): Promise<BotRunResult> {
    const conv = botThreadId(person, bot.id);
    const jobs = deps.threads ? await deps.threads.active(person, conv, { only: true }).catch(() => []) : [];
    const newest = [...jobs].sort((a, b) => b.lastReferencedAt - a.lastReferencedAt)[0];
    if (!newest) return { ok: false, said: `${bot.name} hasn't been given a task by you yet, so there's nothing to continue. Tell it what to do and I'll start a new one.` };
    const s = await deps.threads!.status(conv, newest.jobId, newest.kind).catch(() => null);
    if (!s) return { ok: false, said: `I can't read ${bot.name}'s last task any more, so I won't guess where it got to.`, jobId: newest.jobId };
    const open = !/^(?:succeeded|completed|failed|cancelled|interrupted|unknown)$/.test(s.state);
    return open
      ? { ok: true, said: `${s.said} I've attached to it.`, jobId: newest.jobId, navigate: `/agents/workspace/${bot.id}?tab=tasks` }
      : { ok: false, said: `${s.said} I won't run it again blindly; tell ${bot.name} the next goal and I'll start a new task.`, jobId: newest.jobId };
  }

  // ── a Builder coding job ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The Claude account the words name (even one that isn't configured: that is refused by name, never swapped). */
  function namedClaude(text: string): string | null {
    const everyAccount = { version: 1, codex: [], claude: ["claude:max", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `claude:max-${n}`)].map((slot, order) => ({ slot, configDir: null, plan: "claude-max-20x", label: slot, order })) } as unknown as AccountsConfig;
    return claudeSlotFromWords(text, everyAccount);
  }
  const slotLabel = (slot: string) => (slot === "claude:max" ? "Claude Max" : slot.startsWith("claude:max-") ? `Claude Max ${slot.split("-").pop()}` : slot);

  async function codingTurn(bot: Bot, coding: CodingBridge, input: BotRunInput, text: string, open: boolean, decided = false): Promise<BotRunResult | null> {
    const person = input.principal.personId;
    const wantsAccount = namedClaude(text);
    // Coding when the words say so (a named account, the coding detector, a code verb for a builder), or when a coding turn is already open.
    // A component or proposal brief ("build a pricing card component") is the builder WORKFLOW on the bot's computer unless an account or the detector says coding.
    const isCoding = decided || open || !!wantsAccount || coding.matches(text) || (CODE_START.test(text) && coding.matches(`Have a builder ${text}`) && !(deps.computers.canWorkflows && workflowPlanned(text)));
    if (!isCoding) return null;

    // The account: the one named, else the one set for this bot, else the automatic pick. A named or set account that isn't ready is refused by name.
    const slot = wantsAccount ?? (open ? null : bot.coding.accountSlot);
    if (slot && slot.startsWith("claude:")) {
      if (!coding.accounts().claude.some((c) => c.slot === slot)) {
        const have = coding.accounts().claude.map((c) => c.label).join(", ");
        return { ok: false, said: `${slotLabel(slot)} isn't connected on this server (connected: ${have}). Nothing started, and I won't use a different account instead.` };
      }
      const a = await coding.accountReady(slot).catch(() => ({ ready: null as boolean | null, label: slotLabel(slot), reason: "the sign-in check didn't answer" }));
      if (a.ready !== true) return { ok: false, said: `${a.label} isn't ready: ${a.reason ?? "its sign-in hasn't been checked yet"}. Nothing started, and I won't use a different account instead. Sign it in, or name another account.` };
    } else if (slot && slot.startsWith("codex:")) {
      // A Codex account set for this bot is held to the same rule, and is passed to the coding entry as the exact slot to run on (see `pin` below).
      const a = await coding.accountReady(slot).catch(() => ({ ready: null as boolean | null, label: slot, reason: "the check didn't answer" }));
      if (a.ready !== true) return { ok: false, said: `${a.label} isn't ready: ${a.reason ?? "it hasn't been checked yet"}. Nothing started, and I won't use a different account instead. Fix it, or change ${bot.name}'s account in Setup.` };
    }

    // The words handed to the coding entry are the request as said. This bot's account and model go as STRUCTURED fields (`pin`), never as extra words:
    // the entry drafts the builder on exactly that slot and model, or refuses, so no account or model is swapped or dropped on the way.
    const words = coding.matches(text) || open ? text : `Have a builder ${text}`;
    const namesModel = /\b(?:opus|sonnet|fable|haiku|codex|claude|gpt|deepseek|mimo|cline)\b/i.test(text.replace(/\bclaude\s+max\s*\d?\b/gi, ""));
    // A model the person named wins over the bot's; so does a Claude account they named (then the bot's model only stands if that account runs it).
    const botModel = !open && !namesModel ? bot.coding.model : null;
    const pinModel = botModel && wantsAccount && !modelsForSlot(wantsAccount).includes(botModel) ? null : botModel;
    const pin = open || (!slot && !pinModel) ? null : { accountSlot: slot, model: pinModel };
    const r = await coding.handle(words, { personId: person, actor: input.principal.actor === "human" ? "human" : "process", via: input.principal.via === "loopback-owner" ? "local" : input.principal.via === "telegram-owner" ? "telegram" : "tailnet", spokenYes: input.spokenYes ?? null, ...(pin ? { pin } : {}) });
    if (!r) return null;
    if (r.jobId) deps.links.note({ jobId: r.jobId, bot: bot.id, personId: person, subjects: input.subjects ?? [], ...(input.decision ? { decision: input.decision } : {}) });
    return {
      ok: true,
      said: r.say,
      ...(r.navigate ? { navigate: r.navigate } : {}),
      ...(!r.jobId && !r.navigate && !r.draft && /\?\s*$/.test(r.say) ? { ask: true } : {}),
      // A new draft or a start in this bot turn is marked, so the bot's conversation records itself as the origin (release re-check minor).
      numbers: { ...(r.jobId ? { codingJobId: r.jobId } : {}), ...(r.jobState ? { codingJobState: r.jobState } : {}), ...(r.draft ? { draft: r.draft, fullSummary: r.say } : {}), ...((r as { drafted?: boolean }).drafted ? { codingDrafted: true } : {}), ...((r as { started?: boolean }).started ? { codingStarted: true } : {}) },
    };
  }

  const workflowPlanned = (goal: string) => planSteps(goal, false, false, true)[0]?.executor !== "screen.goal" && ["builder", "audit", "bizprep"].includes(planSteps(goal, false, false, true)[0]?.executor ?? "");

  // ── a computer job on the bot's own computer ─────────────────────────────────────────────────────────────────────────────────

  async function computerTask(bot: Bot, input: BotRunInput, goal: string, extra: { routine?: string } = {}): Promise<BotRunResult> {
    if (!bot.computer) return { ok: false, said: `${bot.name} has no computer assigned, so there is nowhere for it to run this. Pick one in its Setup tab. Nothing ran on any other machine.` };
    const names = deps.computers.list().map((c) => c.name);
    if (!names.includes(bot.computer)) return { ok: false, said: `${bot.name}'s computer "${bot.computer}" doesn't exist yet. Create it on the Computers page, or pick another in Setup. Nothing ran anywhere else.` };
    // The bot's brief: its standing instructions, and (only when its Setup says so) a few facts the shared memory already holds about this request.
    const person = input.principal.personId;
    const brief = await buildBrief(bot, goal, person, deps.memory?.() ?? null);
    const summary = compactInstructions(bot.instructions, 160);
    let goalOnly = false;
    const steps = planSteps(goal, deps.computers.canPlanGoals, deps.computers.canResearch, deps.computers.canWorkflows).map((s) => {
      // An executor that takes only a goal (the interactive loops) can't carry a brief: a compact summary of the instructions goes on the end of the goal.
      if ((s.executor === "goal" || s.executor === "screen.goal") && summary) {
        goalOnly = true;
        const g = String((s.args as { goal?: unknown }).goal ?? goal);
        return { ...s, args: { ...s.args, goal: `${g.slice(0, 420)}. Standing instructions: ${summary}`.slice(0, 600) } };
      }
      return s;
    });
    const r = await deps.computers.startJob({
      computer: bot.computer,
      by: person,
      principal: input.principal as unknown as JobPrincipal,
      agent: bot.id,
      title: goal.slice(0, 80),
      steps,
      wake: true,
      bot: bot.id,
      route: bot.modelPreference.route,
      ...(brief.context ? { context: brief.context } : {}),
      ...(input.subjects?.length ? { subjects: input.subjects } : {}),
    });
    if (!r.ok) {
      const blocker = blockerOfRefusal(r.reason, bot);
      // A computer that can't take it (off, asleep, failed) says what fixes it, in one more sentence; a busy one already says so.
      const fix = blocker.kind === "offline" && !/\bstart\b/i.test(r.reason) ? ` Start ${bot.name}'s computer in Agents › ${bot.name} › Computer, then ask again.` : "";
      return { ok: false, said: `${r.reason}${fix}`, numbers: { blocker } };
    }
    // What this bot's Setup did to the job, on the job itself (masked lines; the job log and the conversation are where they are read).
    const log = (intent: string) => deps.jobs().step(r.jobId, { intent: intent.slice(0, 280), executor: "context", ms: 0, outcome: "note" });
    const modelStep = steps.some((s) => s.executor === "research" || s.executor === "builder" || s.executor === "bizprep");
    log(
      `bot ${bot.name}${extra.routine ? ` (routine ${extra.routine})` : ""}: ${
        goalOnly ? "instructions summarised onto the end of the goal (this step takes only a goal)" : modelStep && brief.context ? `instructions${brief.facts.length ? ` and ${brief.facts.length} recalled fact${brief.facts.length === 1 ? "" : "s"}` : ""} added to the model prompts (${brief.context.length} chars)` : modelStep ? "no standing instructions to add" : "no model step, so the instructions were not used"
      }; model route ${bot.modelPreference.route}; memory recall ${bot.memory.recall ? "on" : "off"}, save results ${bot.memory.saveResults ? "on" : "off"}`,
    );
    for (const n of brief.notes) log(n);
    // Who sent this task to the bot (round 10): the decision's own record on the job, read back as the task row's "Decided by". Nothing is invented when absent.
    if (input.decision) deps.jobs().step(r.jobId, { intent: `decided: ${input.decision.op}`.slice(0, 200), executor: "context", ms: 0, outcome: "note", jev: input.decision });
    const v = deps.computers.view(bot.computer);
    return { ok: true, said: `${bot.name} started: ${goal.slice(0, 120)}. It runs on its own computer whether or not your PC is on; ask me how it's going, or say stop.`, jobId: r.jobId, ...(v.id ? { deviceId: v.id } : {}) };
  }

  /** A routine linked to this bot starts a task as the bot, on its computer. Coding jobs aren't started this way (they wait for a person's "start it"). */
  async function routineTask(input: { bot: string; personId: string; goal: string; routine: string }): Promise<BotRunResult> {
    const bot = find(input.bot);
    if (!bot) return { ok: false, said: `There's no bot called "${input.bot}".` };
    if (bot.archived) return { ok: false, said: archivedSaid(bot) };
    return computerTask(bot, { principal: { personId: input.personId, via: "routine", actor: "process", displayName: input.personId } as Principal, bot: bot.id, utterance: input.goal, source: "typed" }, input.goal.slice(0, 600), { routine: input.routine });
  }

  return {
    scope,
    run,
    routineTask,
    /** The bot's display name for a question ("Research's ..."). */
    nameOf: (id: string) => find(id)?.name ?? id,
    /**
     * The agents a decision may pick from (round 10, for the Jev controller's finite options): every bot that takes requests (archived ones never),
     * with a one-line purpose from its own instructions. Read-only.
     */
    list: () => deps.bots().filter((b) => !b.archived).map((b) => ({ id: b.id, name: b.name, purpose: compactInstructions(b.instructions, 80) || b.name })),
    /** Every bot conversation id of this person (the default thread's pool of "his jobs" reads them). */
    threadIds: (person: string) => deps.bots().map((b) => botThreadId(person, b.id)),
  };
}

export type BotCommands = ReturnType<typeof createBotCommands>;
