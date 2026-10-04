// Browser client for the Agents workspace's bots (`/__agents/bots*`, docs/programme-20261001/AGENTS-WORKSPACE-PLAN.md).
// Every call to those routes lives in this one module. The types mirror the plan's contract; the server (B1) owns the
// store and the validation, this file only speaks to it and says honestly what came back.
//
// Writes carry `rev`: the revision the person was looking at. A stale rev is refused with 409 and the server's current
// bot, so an edit made elsewhere is never silently overwritten. `createFakeAgentBots` is an in-memory stand-in with the
// same rules, used to build and test the Setup tab before the real routes are wired.

export type BotId = string;

export type BotReadinessState = "ready" | "working" | "needs-you" | "offline" | "unconfigured";
/** What the page can offer to fix a reason (the hub's own vocabulary, scripts/agents/types.ts). */
export type ReasonFix = { kind: "open-computer" | "open-setup-section" | "take-over" | "sign-in" | "retry"; target?: string };
/** A stable code, plain words with what to do about it, and the fix when the page can act on it. */
export type ReadinessReason = { code: string; text: string; fix?: ReasonFix; /** The other bot a reason is about (the holder of a shared computer). */ bot?: { id: string; name: string } };
export type BotReadiness = { state: BotReadinessState; reasons: ReadinessReason[]; working?: { jobId: string; title: string; kind: "computer" | "coding" } | null };

export type BotCoding = { enabled: boolean; accountSlot: string | null; model: string | null };
export type BotMemory = { recall: boolean; saveResults: boolean };
export type BotModelPreference = { route: "auto" | "free-only" | string };

/** active; archiving = archived, but jobs that were open when it was archived are still finishing; archived. Derived by the hub from the bot's open work. */
export type BotLifecycle = "active" | "archiving" | "archived";
export type BotArchive = { at: number; by: string; afterCurrentWork: boolean };
/** The other bots that use the same shared computer: they share its one control lease (one task at a time, no queue). */
export type SharedWith = { id: BotId; name: string; archived: boolean };
/** What the bot can actually do right now (derived by the hub from its computer and coding set-up; never edited). */
export type BotAbility = { id: string; name: string; description: string };

export type Bot = {
  id: BotId;
  name: string;
  purpose: string;
  /** Appended to the bot's job briefs. */
  instructions: string;
  /** Shared computer name; null = no computer. */
  computer: string | null;
  coding: BotCoding;
  modelPreference: BotModelPreference;
  skills: string[];
  routines: string[];
  memory: BotMemory;
  createdAt: number;
  updatedAt: number;
  rev: number;
  /** Who made it (a person id); absent on the bots the hub started with. */
  createdBy?: string;
  duplicatedFrom?: string | null;
  archived?: BotArchive | null;
  /** The routines it ran as when it was archived (released then; unarchiving does not link them again). */
  releasedRoutines?: string[];
  /** Absent means active (an older hub, or a bot that was never archived). */
  lifecycle?: BotLifecycle;
  sharesComputerWith?: SharedWith[];
  abilities?: BotAbility[];
};

/** A bot as the read routes return it: derived readiness is never stored. */
/** One line of a bot's history as the hub recorded it: who, when, what. An edit names the fields changed (`note`), never their values. Newest last. */
export type BotHistoryEntry = { at: number; by: string; action: "created" | "duplicated" | "archived" | "unarchived" | "edited"; note?: string };
const HISTORY_ACTIONS = ["created", "duplicated", "archived", "unarchived", "edited"];

export type BotView = Bot & { readiness: BotReadiness; conversationId?: string; history?: BotHistoryEntry[] };

/** The fields a person may change. Nested objects are sent whole, never partially. */
/** Skills are not editable (the hub answers 400), and neither is coding.enabled. */
export type BotPatch = Partial<Pick<Bot, "name" | "purpose" | "instructions" | "computer" | "coding" | "modelPreference" | "routines" | "memory">>;
export type BotField = keyof BotPatch | "skills";

/** Limits the Setup tab enforces before it asks; the server's validation is authoritative. */
export const PURPOSE_MAX = 300;
export const INSTRUCTIONS_MAX = 8000;

export const READINESS_WORD: Record<BotReadinessState, string> = {
  ready: "Ready",
  working: "Working",
  "needs-you": "Needs you",
  offline: "Offline",
  unconfigured: "Not set up",
};

export function validatePurpose(text: string): string | null {
  const t = text.trim();
  if (!t) return "Say what this bot is for, in a sentence.";
  if (t.length > PURPOSE_MAX) return `Keep the purpose to ${PURPOSE_MAX} characters (it is ${t.length}).`;
  return null;
}

export function validateInstructions(text: string): string | null {
  if (text.length > INSTRUCTIONS_MAX) return `Instructions can be up to ${INSTRUCTIONS_MAX.toLocaleString("en-AU")} characters (they are ${text.length.toLocaleString("en-AU")}).`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Results. A discriminated union so the page handles each honest outcome and cannot forget one.

export type ReadResult = { kind: "ok"; bot: BotView } | { kind: "missing" } | { kind: "refused"; message: string } | { kind: "unavailable"; message: string };
export type ListResult = { kind: "ok"; bots: BotView[] } | { kind: "refused"; message: string } | { kind: "unavailable"; message: string };
export type PatchResult =
  /** `readinessReported` is false when the answer carried no readiness: the page then reads the bot again for it. */
  | { kind: "ok"; bot: BotView; readinessReported: boolean }
  /** 409: someone or something changed the bot since it was read. `current` is the server's copy when it sent one. */
  | { kind: "stale"; current: BotView | null; message: string }
  /** 400/422: the server would not accept a value; `field` names it when it said which. */
  | { kind: "invalid"; message: string; field?: string }
  /** 401/403: not a confirmed human session. */
  | { kind: "refused"; message: string }
  | { kind: "missing"; message: string }
  | { kind: "unavailable"; message: string };

/** What a person fills in to make a bot. The hub derives the id from the name and checks everything against the services it points at. */
export type NewBotInput = {
  name: string;
  purpose: string;
  instructions?: string;
  computer?: string | null;
  coding?: BotCoding;
  modelPreference?: BotModelPreference;
  memory?: BotMemory;
};
export type FieldProblem = { field: string; message: string };
export type CreateResult =
  | { kind: "ok"; bot: BotView }
  /** 400: a value wasn't accepted; `errors` name each field. */
  | { kind: "invalid"; message: string; errors: FieldProblem[] }
  /** 409: the name or id is already used by a bot (archived ones included). */
  | { kind: "taken"; message: string; errors: FieldProblem[]; code: string }
  | { kind: "refused"; message: string }
  | { kind: "missing"; message: string }
  | { kind: "unavailable"; message: string };

/** Open work in the way of archiving, as the hub lists it. */
export type WorkItem = { jobId: string; title: string; kind: "computer" | "coding"; phase: "running" | "waiting" };
export type ArchiveResult =
  | { kind: "ok"; bot: BotView }
  | { kind: "stale"; current: BotView | null; message: string }
  /** 422: archiving was refused by a rule, and nothing changed. `has-running-work` lists the work; the person may choose "after current work". */
  | { kind: "blocked"; code: "has-running-work" | "last-active" | "already-archived" | "not-archived" | string; message: string; work: WorkItem[] }
  | { kind: "invalid"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "missing"; message: string }
  | { kind: "unavailable"; message: string };

export type AgentBotsClient = {
  list(): Promise<ListResult>;
  get(id: BotId): Promise<ReadResult>;
  patch(id: BotId, rev: number, patch: BotPatch): Promise<PatchResult>;
  create(input: NewBotInput): Promise<CreateResult>;
  duplicate(id: BotId): Promise<CreateResult>;
  /** Archive (`archived: true`, optionally after current work) or unarchive, against the rev the person was looking at. */
  archive(id: BotId, rev: number, change: { archived: boolean; afterCurrentWork?: boolean }): Promise<ArchiveResult>;
};

export const STALE_MESSAGE = "Changed elsewhere — reload to see the latest";
const NOT_THERE = "The Agents service isn't available on this hub.";
const UNREACHABLE = "The Agents service couldn't be reached.";
const botsPath = (id?: string) => (id === undefined ? "/__agents/bots" : `/__agents/bots/${encodeURIComponent(id)}`);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Accepts only a body that has the shape of a bot; a hub that answers something else is "unavailable", not "empty". */
export function asBotView(v: unknown): BotView | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.rev !== "number" || typeof v.name !== "string") return null;
  const coding = isRecord(v.coding) ? v.coding : {};
  const memory = isRecord(v.memory) ? v.memory : {};
  const pref = isRecord(v.modelPreference) ? v.modelPreference : {};
  const readiness = isRecord(v.readiness) && typeof v.readiness.state === "string" ? v.readiness : null;
  const reasons = (x: unknown): ReadinessReason[] =>
    (Array.isArray(x) ? x : []).flatMap((r): ReadinessReason[] => {
      if (typeof r === "string") return [{ code: "", text: r }];
      if (!isRecord(r) || typeof r.text !== "string") return [];
      const fix = isRecord(r.fix) && typeof r.fix.kind === "string" ? ({ kind: r.fix.kind, ...(typeof r.fix.target === "string" ? { target: r.fix.target } : {}) } as ReasonFix) : undefined;
      const other = isRecord(r.bot) && typeof r.bot.id === "string" && typeof r.bot.name === "string" ? { bot: { id: r.bot.id, name: r.bot.name } } : {};
      return [{ code: typeof r.code === "string" ? r.code : "", text: r.text, ...(fix ? { fix } : {}), ...other }];
    });
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const archived = isRecord(v.archived) && typeof v.archived.at === "number" ? { at: v.archived.at, by: typeof v.archived.by === "string" ? v.archived.by : "", afterCurrentWork: v.archived.afterCurrentWork === true } : null;
  const lifecycle: BotLifecycle = v.lifecycle === "archiving" || v.lifecycle === "archived" ? v.lifecycle : archived ? "archived" : "active";
  const shared = (Array.isArray(v.sharesComputerWith) ? v.sharesComputerWith : []).flatMap((x): SharedWith[] => (isRecord(x) && typeof x.id === "string" && typeof x.name === "string" ? [{ id: x.id, name: x.name, archived: x.archived === true }] : []));
  const abilities = (Array.isArray(v.abilities) ? v.abilities : []).flatMap((x): BotAbility[] => (isRecord(x) && typeof x.id === "string" ? [{ id: x.id, name: typeof x.name === "string" ? x.name : x.id, description: typeof x.description === "string" ? x.description : "" }] : []));
  const history = (Array.isArray(v.history) ? v.history : []).flatMap((x): BotHistoryEntry[] =>
    isRecord(x) && typeof x.at === "number" && typeof x.action === "string" && HISTORY_ACTIONS.includes(x.action)
      ? [{ at: x.at, by: typeof x.by === "string" ? x.by : "", action: x.action as BotHistoryEntry["action"], ...(typeof x.note === "string" && x.note ? { note: x.note } : {}) }]
      : [],
  );
  return {
    id: v.id,
    name: v.name,
    purpose: typeof v.purpose === "string" ? v.purpose : "",
    instructions: typeof v.instructions === "string" ? v.instructions : "",
    computer: typeof v.computer === "string" ? v.computer : null,
    coding: { enabled: coding.enabled === true, accountSlot: typeof coding.accountSlot === "string" ? coding.accountSlot : null, model: typeof coding.model === "string" ? coding.model : null },
    modelPreference: { route: typeof pref.route === "string" && pref.route ? pref.route : "auto" },
    skills: strings(v.skills),
    routines: strings(v.routines),
    memory: { recall: memory.recall === true, saveResults: memory.saveResults === true },
    createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
    rev: v.rev,
    ...(typeof v.createdBy === "string" ? { createdBy: v.createdBy } : {}),
    ...(typeof v.duplicatedFrom === "string" ? { duplicatedFrom: v.duplicatedFrom } : {}),
    archived,
    ...(strings(v.releasedRoutines).length ? { releasedRoutines: strings(v.releasedRoutines) } : {}),
    lifecycle,
    ...(history.length ? { history } : {}),
    sharesComputerWith: shared,
    abilities,
    readiness: readiness
      ? { state: readiness.state as BotReadinessState, reasons: reasons(readiness.reasons) }
      : { state: "unconfigured", reasons: [{ code: "readiness-missing", text: "The hub did not report this bot's readiness." }] },
    ...(typeof v.conversationId === "string" ? { conversationId: v.conversationId } : {}),
  };
}

type Deps = { fetch?: typeof fetch; token?: () => Promise<string> };

async function pageToken(f: typeof fetch): Promise<string> {
  // A remote (tailnet) session has no page token; the hub checks its identity instead.
  const t = await f("/__token").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return typeof t?.token === "string" ? t.token : "";
}

async function readJson(r: Response): Promise<{ json: boolean; body: unknown }> {
  const type = r.headers.get("content-type") ?? "";
  if (!type.includes("json")) return { json: false, body: null };
  return { json: true, body: await r.json().catch(() => null) };
}
const errorText = (body: unknown, fallback: string) => (isRecord(body) && typeof body.error === "string" && body.error ? body.error : fallback);

export function createAgentBotsClient(deps: Deps = {}): AgentBotsClient {
  const f: typeof fetch = deps.fetch ?? ((...a) => fetch(...a));
  const token = deps.token ?? (() => pageToken(f));
  return {
    async list() {
      let r: Response;
      try {
        r = await f(botsPath(), { cache: "no-store" });
      } catch {
        return { kind: "unavailable", message: UNREACHABLE };
      }
      if (r.status === 401 || r.status === 403) return { kind: "refused", message: "Sign in as a founder to see the bots." };
      const { json, body } = await readJson(r);
      // A dev server that doesn't know the route answers with its HTML shell: that is "not there", not "no bots".
      if (r.status === 404 || r.status === 501 || !json) return { kind: "unavailable", message: NOT_THERE };
      if (!r.ok || !isRecord(body) || !Array.isArray(body.bots)) return { kind: "unavailable", message: errorText(body, `The Agents service answered ${r.status}.`) };
      return { kind: "ok", bots: body.bots.map(asBotView).filter((b): b is BotView => !!b) };
    },
    async get(id) {
      let r: Response;
      try {
        r = await f(botsPath(id), { cache: "no-store" });
      } catch {
        return { kind: "unavailable", message: UNREACHABLE };
      }
      if (r.status === 401 || r.status === 403) return { kind: "refused", message: "Sign in as a founder to see this bot." };
      const { json, body } = await readJson(r);
      if (r.status === 404 && json) return { kind: "missing" };
      if (r.status === 404 || r.status === 501 || !json) return { kind: "unavailable", message: NOT_THERE };
      const bot = asBotView(isRecord(body) && isRecord(body.bot) ? body.bot : body);
      if (!r.ok || !bot) return { kind: "unavailable", message: errorText(body, `The Agents service answered ${r.status}.`) };
      return { kind: "ok", bot };
    },
    async patch(id, rev, patch) {
      let r: Response;
      try {
        r = await f(botsPath(id), { method: "PATCH", headers: { "Content-Type": "application/json", "x-claude-os-token": await token() }, body: JSON.stringify({ rev, ...patch }) });
      } catch {
        return { kind: "unavailable", message: UNREACHABLE };
      }
      const { json, body } = await readJson(r);
      if (r.status === 409) {
        const current = isRecord(body) ? asBotView(body.current ?? body.bot) : null;
        return { kind: "stale", current, message: STALE_MESSAGE };
      }
      if (r.status === 401 || r.status === 403) return { kind: "refused", message: errorText(body, "Only a person using a confirmed browser or paired device can change a bot.") };
      if (r.status === 404 && json) return { kind: "missing", message: errorText(body, "That bot no longer exists.") };
      if (r.status === 404 || r.status === 501 || !json) return { kind: "unavailable", message: NOT_THERE };
      if (r.status === 400 || r.status === 422) return { kind: "invalid", message: errorText(body, "The hub didn't accept that value."), ...(isRecord(body) && typeof body.field === "string" ? { field: body.field } : {}) };
      const raw = isRecord(body) && isRecord(body.bot) ? body.bot : body;
      const bot = asBotView(raw);
      if (!r.ok || !bot) return { kind: "unavailable", message: errorText(body, `The Agents service answered ${r.status}.`) };
      return { kind: "ok", bot, readinessReported: isRecord(raw) && isRecord(raw.readiness) && typeof raw.readiness.state === "string" };
    },
    create: (input) => post(botsPath(), input),
    duplicate: (id) => post(`${botsPath(id)}/duplicate`, {}),
    async archive(id, rev, change) {
      let r: Response;
      try {
        r = await f(`${botsPath(id)}/archive`, { method: "POST", headers: { "Content-Type": "application/json", "x-claude-os-token": await token() }, body: JSON.stringify({ rev, archived: change.archived, ...(change.afterCurrentWork ? { afterCurrentWork: true } : {}) }) });
      } catch {
        return { kind: "unavailable", message: UNREACHABLE };
      }
      const { json, body } = await readJson(r);
      if (r.status === 409) return { kind: "stale", current: isRecord(body) ? asBotView(body.current) : null, message: STALE_MESSAGE };
      if (r.status === 401 || r.status === 403) return { kind: "refused", message: errorText(body, "Only a person using a confirmed browser or paired device can archive a bot.") };
      if (r.status === 404 && json) return { kind: "missing", message: errorText(body, "That bot no longer exists.") };
      if (r.status === 404 || r.status === 501 || !json) return { kind: "unavailable", message: NOT_THERE };
      if (r.status === 422) {
        const work = isRecord(body) && Array.isArray(body.work) ? body.work.flatMap((w): WorkItem[] => (isRecord(w) && typeof w.jobId === "string" ? [{ jobId: w.jobId, title: typeof w.title === "string" ? w.title : w.jobId, kind: w.kind === "coding" ? "coding" : "computer", phase: w.phase === "waiting" ? "waiting" : "running" }] : [])) : [];
        return { kind: "blocked", code: isRecord(body) && typeof body.code === "string" ? body.code : "refused", message: errorText(body, "That can't be done right now."), work };
      }
      if (r.status === 400) return { kind: "invalid", message: errorText(body, "The hub didn't accept that.") };
      const bot = asBotView(body);
      if (!r.ok || !bot) return { kind: "unavailable", message: errorText(body, `The Agents service answered ${r.status}.`) };
      return { kind: "ok", bot };
    },
  };

  /** POST that makes a bot (create or duplicate): 201 + the bot, 400 per field, 409 for a name or id in use. */
  async function post(url: string, payload: unknown): Promise<CreateResult> {
    let r: Response;
    try {
      r = await f(url, { method: "POST", headers: { "Content-Type": "application/json", "x-claude-os-token": await token() }, body: JSON.stringify(payload) });
    } catch {
      return { kind: "unavailable", message: UNREACHABLE };
    }
    const { json, body } = await readJson(r);
    const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors.flatMap((e): FieldProblem[] => (isRecord(e) && typeof e.field === "string" && typeof e.message === "string" ? [{ field: e.field, message: e.message }] : [])) : [];
    if (r.status === 401 || r.status === 403) return { kind: "refused", message: errorText(body, "Only a person using a confirmed browser or paired device can make a bot.") };
    if (r.status === 404 && json) return { kind: "missing", message: errorText(body, "That bot no longer exists.") };
    if (r.status === 404 || r.status === 501 || !json) return { kind: "unavailable", message: NOT_THERE };
    if (r.status === 409) return { kind: "taken", message: errorText(body, "That name or id is already used by a bot."), errors, code: isRecord(body) && typeof body.code === "string" ? body.code : "taken" };
    if (r.status === 400 || r.status === 422) return { kind: "invalid", message: errorText(body, "The hub didn't accept that."), errors };
    const bot = asBotView(body);
    if (!r.ok || !bot) return { kind: "unavailable", message: errorText(body, `The Agents service answered ${r.status}.`) };
    return { kind: "ok", bot };
  }
}

/** The real client, used unless a page is handed another one. */
export const agentBots: AgentBotsClient = createAgentBotsClient();

// ---------------------------------------------------------------------------------------------------------------
// Query keys, so the shell's selector and this tab refresh each other.
export const botQueryKeys = { all: ["agent-bots"] as const, one: (id: BotId) => ["agent-bots", id] as const };

// ---------------------------------------------------------------------------------------------------------------
// Differences between two copies of a bot, in words, for the "Changed elsewhere" notice.

export type BotDifference = { field: BotField; label: string; mine: string; theirs: string };

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s || "(empty)");
const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");

const SHOW: Record<BotField, { label: string; text: (b: Bot) => string }> = {
  name: { label: "Name", text: (b) => b.name },
  purpose: { label: "Purpose", text: (b) => clip(b.purpose) },
  instructions: { label: "Instructions", text: (b) => clip(b.instructions) },
  computer: { label: "Computer", text: (b) => b.computer ?? "none" },
  coding: { label: "Coding account", text: (b) => (b.coding.accountSlot ? `${b.coding.accountSlot}${b.coding.model ? `, ${b.coding.model}` : ""}` : "none chosen") },
  modelPreference: { label: "Model route", text: (b) => b.modelPreference.route },
  skills: { label: "Skills", text: (b) => list(b.skills) },
  routines: { label: "Routines", text: (b) => list(b.routines) },
  memory: { label: "Memory", text: (b) => `recall ${b.memory.recall ? "on" : "off"}, save ${b.memory.saveResults ? "on" : "off"}` },
};

export function diffBots(mine: Bot, theirs: Bot): BotDifference[] {
  const out: BotDifference[] = [];
  (Object.keys(SHOW) as BotField[]).forEach((field) => {
    const a = SHOW[field].text(mine);
    const b = SHOW[field].text(theirs);
    // Compare the raw values, not the clipped text: two long texts can share a clipped prefix.
    const same = JSON.stringify(mine[field]) === JSON.stringify(theirs[field]);
    if (!same) out.push({ field, label: SHOW[field].label, mine: a, theirs: b });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The in-memory stand-in. Same rules as the server contract: rev checked, 409 with the current bot, validation.

export type FakeBotsOptions = {
  seed?: BotView[];
  now?: () => number;
  /** Computers/skills/routines/account slots the "server" accepts; unset = accept anything. */
  known?: { computers?: string[]; routines?: string[]; accountSlots?: string[] };
  /** Derives readiness from a bot after each change (the real one reads computers, accounts and the router). */
  readinessFor?: (bot: Bot) => BotReadiness;
  /** When false the PATCH answer omits readiness, like a server that leaves it to the next read. */
  patchReturnsReadiness?: boolean;
  latencyMs?: number;
  /** The open jobs of a bot (what stands in the way of archiving it). Unset: none. */
  workOf?: (id: BotId) => WorkItem[];
};

export type FakeBots = {
  client: AgentBotsClient;
  /** Another editor changes the bot: bumps rev, exactly what makes the next write stale. */
  editElsewhere(id: BotId, change: BotPatch): void;
  /** Make the next write fail the way a dropped connection does. */
  failNextWrite(): void;
  calls: { method: "GET" | "PATCH" | "POST"; id?: BotId; rev?: number; patch?: BotPatch; action?: "create" | "duplicate" | "archive" | "unarchive"; afterCurrentWork?: boolean }[];
  snapshot(id: BotId): BotView | undefined;
};

export function defaultFakeReadiness(bot: Bot): BotReadiness {
  const reasons: ReadinessReason[] = [];
  if (!bot.computer) reasons.push({ code: "no-capability", text: "No computer is assigned, so this bot has nowhere to work. Pick a computer in Setup.", fix: { kind: "open-setup-section", target: "computer" } });
  if (bot.coding.enabled && !bot.coding.accountSlot) reasons.push({ code: "coding-account-unchecked", text: "Coding jobs have no account chosen yet. Choose one in Setup.", fix: { kind: "open-setup-section", target: "model" } });
  if (bot.coding.enabled && bot.coding.accountSlot === "claude:max") reasons.push({ code: "coding-account-not-ready", text: "Claude Max can't take coding work: at its weekly limit. Sign it in or change the account in Setup.", fix: { kind: "sign-in", target: "claude:max" } });
  if (reasons.length === 0) return { state: "ready", reasons: [] };
  return { state: bot.computer ? "needs-you" : "unconfigured", reasons };
}

/** The lowercase slug a name makes (the hub does the same, and makes it unique). */
export function slugOf(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return slug || "bot";
}
export const NAME_MAX = 40;
export function validateName(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "Give the bot a name.";
  if (t.length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters (it is ${t.length}).`;
  return null;
}

/** The abilities the real hub would derive for a fake bot: its computer's research, and coding when it is on. */
export function fakeAbilities(b: Pick<Bot, "computer" | "coding">): BotAbility[] {
  return [
    ...(b.computer ? [{ id: "research", name: "Research", description: "Finds, reads and compares public sources on its own computer and returns a cited report." }] : []),
    ...(b.coding.enabled ? [{ id: "coding", name: "Coding jobs", description: "Runs Claude and Codex coding jobs on the shared accounts: plan, build, test, review." }] : []),
  ];
}

export function seedBots(now = 1_759_000_000_000): BotView[] {
  const base = { createdAt: now, updatedAt: now, rev: 1, routines: [], memory: { recall: true, saveResults: false }, modelPreference: { route: "auto" } };
  const research: Bot = { ...base, id: "research", name: "Research", purpose: "Finds and reads public sources, then saves a short, cited note of what it found.", instructions: "Cite every claim with its source. Say plainly when a source could not be opened.", computer: "research", coding: { enabled: false, accountSlot: null, model: null }, skills: [] };
  const builder: Bot = { ...base, id: "builder", name: "Builder", purpose: "Makes code changes in a branch, runs the tests and hands back a review.", instructions: "", computer: "builder", coding: { enabled: true, accountSlot: null, model: null }, skills: [], memory: { recall: true, saveResults: true } };
  return [research, builder].map((b) => ({ ...b, readiness: defaultFakeReadiness(b), conversationId: `agent:me:${b.id}`, lifecycle: "active" as const, sharesComputerWith: [], abilities: fakeAbilities(b) }));
}

export function createFakeAgentBots(opts: FakeBotsOptions = {}): FakeBots {
  const now = opts.now ?? (() => Date.now());
  const readinessFor = opts.readinessFor ?? defaultFakeReadiness;
  const store = new Map<BotId, BotView>((opts.seed ?? seedBots()).map((b) => [b.id, structuredClone(b)]));
  const calls: FakeBots["calls"] = [];
  let failWrite = false;
  const wait = () => (opts.latencyMs ? new Promise<void>((r) => setTimeout(r, opts.latencyMs)) : Promise.resolve());
  const copy = (b: BotView): BotView => structuredClone(b);
  const madeBot = (name: string, input: NewBotInput, from?: BotId): BotView => {
    let id = slugOf(name);
    for (let n = 2; store.has(id); n++) id = `${slugOf(name).slice(0, 29)}-${n}`;
    const t = now();
    const bot: Bot = { id, name, purpose: input.purpose.trim(), instructions: input.instructions?.trim() ?? "", computer: input.computer ?? null, coding: input.coding ?? { enabled: false, accountSlot: null, model: null }, modelPreference: input.modelPreference ?? { route: "auto" }, skills: [], routines: [], memory: input.memory ?? { recall: true, saveResults: false }, createdAt: t, updatedAt: t, rev: 1, createdBy: "me", duplicatedFrom: from ?? null };
    return { ...bot, readiness: readinessFor(bot), lifecycle: "active", sharesComputerWith: [], abilities: fakeAbilities(bot) };
  };
  const apply = (b: BotView, patch: BotPatch): BotView => {
    const next: BotView = { ...b, ...structuredClone(patch), rev: b.rev + 1, updatedAt: now() };
    next.readiness = readinessFor(next);
    return next;
  };
  const known = opts.known ?? {};
  const unknownOf = (ids: string[] | undefined, allowed: string[] | undefined) => (allowed && ids ? ids.find((i) => !allowed.includes(i)) : undefined);

  return {
    calls,
    snapshot: (id) => (store.has(id) ? copy(store.get(id)!) : undefined),
    editElsewhere(id, change) {
      const b = store.get(id);
      if (b) store.set(id, apply(b, change));
    },
    failNextWrite() {
      failWrite = true;
    },
    client: {
      async list() {
        calls.push({ method: "GET" });
        await wait();
        return { kind: "ok", bots: [...store.values()].map(copy) };
      },
      async get(id) {
        calls.push({ method: "GET", id });
        await wait();
        const b = store.get(id);
        return b ? { kind: "ok", bot: copy(b) } : { kind: "missing" };
      },
      async create(input) {
        calls.push({ method: "POST", action: "create" });
        await wait();
        if (failWrite) {
          failWrite = false;
          return { kind: "unavailable", message: UNREACHABLE };
        }
        const errors: FieldProblem[] = [];
        const nameError = validateName(input.name ?? "");
        if (nameError) errors.push({ field: "name", message: nameError });
        const purposeError = validatePurpose(input.purpose ?? "");
        if (purposeError) errors.push({ field: "purpose", message: purposeError });
        if (input.instructions !== undefined) {
          const e = validateInstructions(input.instructions);
          if (e) errors.push({ field: "instructions", message: e });
        }
        if (input.computer && known.computers && !known.computers.includes(input.computer)) errors.push({ field: "computer", message: `There is no shared computer called "${input.computer}".` });
        if (errors.length) return { kind: "invalid", message: errors[0]!.message, errors };
        const name = input.name.replace(/\s+/g, " ").trim();
        const clash = [...store.values()].find((b) => b.name.toLowerCase() === name.toLowerCase());
        if (clash) return { kind: "taken", code: "name-taken", message: `Another bot already answers to "${name}".`, errors: [{ field: "name", message: `Another bot already answers to "${name}".` }] };
        const bot = madeBot(name, input);
        store.set(bot.id, bot);
        return { kind: "ok", bot: copy(bot) };
      },
      async duplicate(id) {
        calls.push({ method: "POST", id, action: "duplicate" });
        await wait();
        if (failWrite) {
          failWrite = false;
          return { kind: "unavailable", message: UNREACHABLE };
        }
        const b = store.get(id);
        if (!b) return { kind: "missing", message: "That bot no longer exists." };
        let name = `${b.name} copy`;
        for (let n = 2; [...store.values()].some((x) => x.name.toLowerCase() === name.toLowerCase()); n++) name = `${b.name} copy ${n}`;
        const bot = madeBot(name, { name, purpose: b.purpose, instructions: b.instructions, computer: b.computer, coding: b.coding, modelPreference: b.modelPreference, memory: b.memory }, b.id);
        store.set(bot.id, bot);
        return { kind: "ok", bot: copy(bot) };
      },
      async archive(id, rev, change) {
        calls.push({ method: "POST", id, rev, action: change.archived ? "archive" : "unarchive", ...(change.afterCurrentWork ? { afterCurrentWork: true } : {}) });
        await wait();
        if (failWrite) {
          failWrite = false;
          return { kind: "unavailable", message: UNREACHABLE };
        }
        const b = store.get(id);
        if (!b) return { kind: "missing", message: "That bot no longer exists." };
        if (rev !== b.rev) return { kind: "stale", current: copy(b), message: STALE_MESSAGE };
        if (!change.archived) {
          if (!b.archived) return { kind: "blocked", code: "not-archived", message: `${b.name} isn't archived.`, work: [] };
          const next: BotView = { ...b, archived: null, lifecycle: "active", rev: b.rev + 1, updatedAt: now() };
          store.set(id, next);
          return { kind: "ok", bot: copy(next) };
        }
        if (b.archived) return { kind: "blocked", code: "already-archived", message: `${b.name} is already archived.`, work: [] };
        if (![...store.values()].some((x) => x.id !== id && !x.archived)) return { kind: "blocked", code: "last-active", message: `${b.name} is the only active bot, so it can't be archived.`, work: [] };
        const work = opts.workOf?.(id) ?? [];
        if (work.length && !change.afterCurrentWork) return { kind: "blocked", code: "has-running-work", message: `${b.name} has ${work.length} job${work.length === 1 ? "" : "s"} open. Nothing was archived.`, work };
        const next: BotView = { ...b, archived: { at: now(), by: "me", afterCurrentWork: !!change.afterCurrentWork && work.length > 0 }, lifecycle: work.length ? "archiving" : "archived", rev: b.rev + 1, updatedAt: now() };
        store.set(id, next);
        return { kind: "ok", bot: copy(next) };
      },
      async patch(id, rev, patch) {
        calls.push({ method: "PATCH", id, rev, patch: structuredClone(patch) });
        await wait();
        if (failWrite) {
          failWrite = false;
          return { kind: "unavailable", message: UNREACHABLE };
        }
        const b = store.get(id);
        if (!b) return { kind: "missing", message: "That bot no longer exists." };
        if (rev !== b.rev) return { kind: "stale", current: copy(b), message: STALE_MESSAGE };
        if (patch.purpose !== undefined) {
          const e = validatePurpose(patch.purpose);
          if (e) return { kind: "invalid", message: e, field: "purpose" };
        }
        if (patch.instructions !== undefined) {
          const e = validateInstructions(patch.instructions);
          if (e) return { kind: "invalid", message: e, field: "instructions" };
        }
        if (patch.computer && known.computers && !known.computers.includes(patch.computer)) return { kind: "invalid", message: `There is no shared computer called "${patch.computer}".`, field: "computer" };
        if (patch.coding?.accountSlot && known.accountSlots && !known.accountSlots.includes(patch.coding.accountSlot)) return { kind: "invalid", message: `There is no coding account "${patch.coding.accountSlot}".`, field: "coding" };
        if ("skills" in patch) return { kind: "invalid", message: "Skills can't be changed from Setup.", field: "skills" };
        if (patch.coding && patch.coding.enabled !== b.coding.enabled) return { kind: "invalid", message: "coding.enabled can't be changed here.", field: "coding.enabled" };
        const badRoutine = unknownOf(patch.routines, known.routines);
        if (badRoutine) return { kind: "invalid", message: `There is no routine "${badRoutine}".`, field: "routines" };
        const next = apply(b, patch);
        store.set(id, next);
        const out = copy(next);
        const reported = opts.patchReturnsReadiness !== false;
        if (!reported) out.readiness = { state: "unconfigured", reasons: [{ code: "readiness-missing", text: "The hub did not report this bot's readiness." }] };
        return { kind: "ok", bot: out, readinessReported: reported };
      },
    },
  };
}
