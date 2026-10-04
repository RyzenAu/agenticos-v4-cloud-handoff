import type { ArtifactMeta } from "../computers/artifacts";
import type { CodingEvent, CodingJob } from "../coding/contracts";
import { botConversationKey, botThreadId, type ThreadEntry } from "../conversations";
import type { JobService, JobSummary } from "../jobs/service";
import type { ThreadStore } from "../jarvis-command/threads";
import { abilitiesOf, ABILITIES, type Capabilities } from "./abilities";
import type { RoutineLinks } from "./automation";
import { CODING_PHASE, codingFileOf, codingTaskOf, JOB_PHASE } from "./coding-view";
import type { LinksStore } from "./links";
import { deriveReadiness, type OpenWork, type ReadinessDeps } from "./readiness";
import { isActive, type BotStore } from "./store";
import { HISTORY_MAX, taskDecision, type Bot, type BotFile, type BotLifecycle, type BotTask, type BotView } from "./types";
import { copyOf, parseArchive, parseCreate, parsePatch, type BotDraft, type FieldError, type ValidationDeps } from "./validate";

/**
 * The Agents workspace service: bots with live readiness, a bot's merged task list and files list, and its conversation. It READS the job
 * service, the coding store, the computers' saved results and the conversation store; the only thing it writes is bots.json (and the
 * conversation thread's existence). It starts, stops and schedules nothing.
 */

/** The coding store, as far as the workspace needs it. Null: this hub has no coding harness (quiet copy), so a bot shows no coding work. */
export type CodingSource = { jobs(limit: number, before?: number): Array<{ job: CodingJob; events: readonly Pick<CodingEvent, "type" | "payload">[] }> };

export type AgentsDeps = {
  store: BotStore;
  validation: ValidationDeps;
  readiness: Omit<ReadinessDeps, "openWork">;
  jobs: () => JobService | null;
  computers: {
    /** The device id a shared computer has once paired (what its jobs' targetDeviceId is); null before then or when unknown. */
    deviceIdOf(name: string): string | null;
    /** The saved results this person may open (the artifact store's own per-person list). */
    artifacts(personId: string): ArtifactMeta[];
    /** Every saved result, whoever made it (read-only metadata). Optional: without it a person sees only their own, as before. */
    allArtifacts?(): ArtifactMeta[];
  };
  coding: () => Promise<CodingSource | null>;
  /** What this hub's computers can run (research, the other workflows): a bot's abilities are derived from it. */
  capabilities: () => Capabilities;
  /** Which founder linked each routine (the conversation its work lands in). */
  routineLinks: RoutineLinks;
  links: LinksStore;
  conversations: ThreadStore;
  /** Called before readiness is derived: refresh what the readiness reads synchronously (the accounts service's cached sign-in state). Never throws. */
  prepare?: () => Promise<void>;
  now?: () => number;
};

/** The one bot a coding job nobody linked belongs to. */
const LEGACY_CODING_OWNER = "builder";
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "unknown"]);
const WAITING_NOTE = /^Waiting for your yes:\s*/i;

export type PatchOutcome =
  | { status: 200; body: BotView }
  | { status: 400; body: { error: string; errors: FieldError[] } }
  | { status: 404; body: { error: string } }
  | { status: 409; body: { error: string; current: BotView | null } }
  | { status: 422; body: { error: string; code: string } };

/** Open work as the archive refusal lists it: enough for a person to see what is in the way. */
export type WorkItem = { jobId: string; title: string; kind: "computer" | "coding"; phase: "running" | "waiting" };
export type CreateOutcome =
  | { status: 201; body: BotView }
  | { status: 400; body: { error: string; errors: FieldError[] } }
  /** An id or name already in use (409, with the field's code). No rev is involved on a create. */
  | { status: 409; body: { error: string; errors: FieldError[]; code: string } }
  | { status: 404; body: { error: string } };
export type ArchiveOutcome =
  | { status: 200; body: BotView }
  | { status: 400; body: { error: string; errors: FieldError[] } }
  | { status: 404; body: { error: string } }
  | { status: 409; body: { error: string; current: BotView | null } }
  | { status: 422; body: { error: string; code: "has-running-work" | "last-active" | "already-archived" | "not-archived"; work?: WorkItem[] } };

/** An ability in the catalogue (read-only): research, builder, audit, business preparation, coding. */
export type SkillInfo = { name: string; description?: string };

export function createAgentsService(deps: AgentsDeps) {
  const now = deps.now ?? Date.now;

  /**
   * Work on a shared computer that no bot was recorded for (a job started on the Computers page, or before bots existed) and saved results of it belong to
   * exactly ONE bot: the OLDEST (by createdAt) of the bots that use that computer now, active ones first. A bot made later, whatever it is called, never
   * takes them, and when the computer is reassigned they follow the bot that has had it longest. `all` is the bots as read once for this request.
   */
  function unattributedOwner(computer: string | null, all: readonly Bot[]): string | null {
    if (!computer) return null;
    const using = all.filter((b) => b.computer === computer);
    const pool = using.some((b) => !b.archived) ? using.filter((b) => !b.archived) : using;
    return [...pool].sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? null;
  }
  /** The one bot a legacy coding job nobody linked belongs to: Builder (id "builder") while it exists, else the oldest coding-enabled bot. */
  function legacyCodingOwner(all: readonly Bot[]): string | null {
    if (all.some((b) => b.id === LEGACY_CODING_OWNER)) return LEGACY_CODING_OWNER;
    return [...all.filter((b) => b.coding.enabled)].sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? null;
  }

  /**
   * The saved results of this bot that this person may see. A result belongs to the bot whose job made it (the job service records it), wherever it
   * ran, so a bot moved to another computer keeps its Files history; one that records no bot belongs to the oldest bot using that computer (as before)
   * and stays the person's own. A result a bot made is the bot's, and bots work on shared computers, so BOTH founders see it. Personal results stay the owner's.
   */
  function botArtifacts(bot: Bot, personId: string, all: readonly Bot[] = deps.store.list()): ArtifactMeta[] {
    const jobs = deps.jobs();
    const own = deps.computers.artifacts(personId);
    const pool = deps.computers.allArtifacts ? deps.computers.allArtifacts() : own;
    const mine = !!bot.computer && unattributedOwner(bot.computer, all) === bot.id;
    const out: ArtifactMeta[] = [];
    for (const a of pool) {
      const made = jobs?.get(a.id);
      if (made?.bot) {
        if (made.bot === bot.id) out.push(a);
      } else if (a.personId === personId && mine && a.computer === bot.computer) out.push(a);
    }
    return out;
  }

  /** Computer jobs for this bot: those that ran on its computer, and those made for it wherever they ran. Newest first. */
  function computerJobs(bot: Bot, limit: number, before?: number): JobSummary[] {
    const jobs = deps.jobs();
    if (!jobs) return [];
    const device = bot.computer ? deps.computers.deviceIdOf(bot.computer) : null;
    const seen = new Map<string, JobSummary>();
    const page = { limit, ...(before !== undefined ? { before } : {}) };
    // Several bots may share one computer (and its one control lease). A job made FOR a bot is that bot's alone; a job nobody made for a bot (started on
    // the Computers page, or before bots existed) belongs to ONE bot: see unattributedOwner.
    const mine = unattributedOwner(bot.computer, deps.store.list()) === bot.id;
    if (device) for (const j of jobs.list({ targetDeviceId: device, ...page })) if (j.bot ? j.bot === bot.id : mine) seen.set(j.id, j);
    for (const j of jobs.list({ bot: bot.id, ...page })) seen.set(j.id, j);
    return [...seen.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
  }

  /**
   * A coding job belongs to the bot that drafted it (its link). A legacy job nobody linked belongs to ONE bot (legacyCodingOwner). Never every
   * coding-enabled bot: a new or duplicated Builder starts with no jobs, none "working", and none in the way of archiving it.
   */
  function codingJobsFrom(source: CodingSource | null, bot: Bot, limit: number, before?: number) {
    if (!bot.coding.enabled || !source) return [];
    const legacy = legacyCodingOwner(deps.store.list());
    return source
      .jobs(limit, before)
      .map((x) => ({ ...x, link: deps.links.get(x.job.id) }))
      .filter((x) => (x.link ? x.link.bot === bot.id : bot.id === legacy));
  }
  async function codingJobs(bot: Bot, limit: number, before?: number) {
    if (!bot.coding.enabled) return [];
    return codingJobsFrom(await deps.coding().catch(() => null), bot, limit, before);
  }

  /** The bot's open work, with no await in it: the coding source is fetched first by the caller, so a check and a write can sit side by side. */
  function openWorkFrom(bot: Bot, source: CodingSource | null): OpenWork[] {
    const out: OpenWork[] = [];
    for (const j of computerJobs(bot, 20)) {
      if (TERMINAL.has(j.state)) continue;
      out.push({ jobId: j.id, title: j.title, kind: "computer", phase: j.state === "awaiting-approval" ? "waiting" : "running", ...(j.note ? { note: j.note.replace(WAITING_NOTE, "").slice(0, 160) } : {}) });
    }
    for (const { job } of codingJobsFrom(source, bot, 20)) {
      const phase = CODING_PHASE[job.state];
      // A drafted plan waiting for "Start it" is the person's to answer, not work in flight.
      if (phase === "running" || (phase === "waiting" && job.state !== "draft")) out.push({ jobId: job.id, title: job.spec.objective.slice(0, 80), kind: "coding", phase: phase === "running" ? "running" : "waiting", ...(phase === "waiting" ? { note: job.state === "awaiting_confirmation" ? "start it, or say no" : job.state.replace(/_/g, " ") } : {}) });
    }
    return out;
  }
  async function openWork(bot: Bot): Promise<OpenWork[]> {
    return openWorkFrom(bot, bot.coding.enabled ? await deps.coding().catch(() => null) : null);
  }

  async function view(bot: Bot): Promise<BotView> {
    const work = await openWork(bot);
    const abilities = abilitiesOf(bot, deps.capabilities()).map(({ id, name, description }) => ({ id, name, description }));
    const lifecycle: BotLifecycle = !bot.archived ? "active" : work.length ? "archiving" : "archived";
    const sharesComputerWith = bot.computer ? deps.store.list().filter((b) => b.id !== bot.id && b.computer === bot.computer).map((b) => ({ id: b.id, name: b.name, archived: !!b.archived })) : [];
    // `skills` is read-only and derived (the abilities' ids); whatever an older bots.json holds is not what the bot can do.
    return { ...bot, skills: abilities.map((a) => a.id), readiness: deriveReadiness(bot, { ...deps.readiness, openWork: () => work, botOfJob: (jobId) => deps.jobs()?.get(jobId)?.bot ?? null, botName: (id) => deps.store.get(id)?.name }), abilities, lifecycle, sharesComputerWith };
  }

  /** Make a bot from a validated draft. Configuration only: no routines, no conversations, no computer made. */
  function make(draft: BotDraft, by: string, from: Bot | null) {
    const t = now();
    const bot: Bot = {
      ...draft,
      skills: [],
      routines: [],
      createdAt: t,
      updatedAt: t,
      rev: 1,
      createdBy: by,
      duplicatedFrom: from?.id ?? null,
      history: [{ at: t, by, action: from ? "duplicated" : "created", ...(from ? { note: `from ${from.id}` } : {}) } as const].slice(-HISTORY_MAX),
    };
    return deps.store.create(bot);
  }

  const refused = (errors: FieldError[]): CreateOutcome =>
    errors.some((e) => e.code === "id-taken" || e.code === "name-taken")
      ? { status: 409, body: { code: errors.find((e) => e.code)!.code!, error: errors[0].message, errors } }
      : { status: 400, body: { error: errors[0].message, errors } };

  const identity = (personId: string, bot: Bot) => ({ conversationId: botThreadId(personId, bot.id), conversationKey: botConversationKey(personId, bot.id) });

  return {
    /** Every bot with its live readiness. */
    async list(): Promise<BotView[]> {
      await deps.prepare?.().catch(() => undefined);
      return Promise.all(deps.store.list().map(view));
    },
    /** One bot with its readiness and this person's conversation id. The conversation is created (empty) the first time it is asked for. */
    async get(id: string, personId: string, options: { thread?: boolean } = {}): Promise<(BotView & { conversationId?: string; conversationKey?: string }) | null> {
      const bot = deps.store.get(id);
      if (!bot) return null;
      // Creating the conversation is a write, and its id is how it is read: only for a confirmed person (the route decides), never for a bare login.
      if (options.thread === false) {
        await deps.prepare?.().catch(() => undefined);
        return view(bot);
      }
      // An archived bot keeps its conversations readable but gets no new one.
      if (isActive(bot)) deps.conversations.ensureThread({ personId, bot: bot.id, title: bot.name });
      await deps.prepare?.().catch(() => undefined);
      return { ...(await view(bot)), ...identity(personId, bot) };
    },

    async patch(id: string, body: unknown, personId?: string): Promise<PatchOutcome> {
      const current = deps.store.get(id);
      if (!current) return { status: 404, body: { error: `There is no bot called "${id}".` } };
      if (current.archived) return { status: 422, body: { code: "archived", error: `${current.name} is archived. Unarchive it to change its settings; nothing it did is lost.` } };
      const parsed = parsePatch(body, deps.validation, current);
      if (!parsed.ok) return { status: 400, body: { error: parsed.errors[0].message, errors: parsed.errors } };
      await deps.prepare?.().catch(() => undefined);
      const result = deps.store.patch(id, parsed.rev, (bot) => parsed.apply(bot), personId);
      if (result.ok) {
        // A routine newly linked is remembered as THIS founder's (their conversation gets its work); one unlinked stops being the bot's at once.
        const before = new Set(current.routines);
        const after = new Set(result.bot.routines);
        deps.routineLinks.link(result.bot.routines.filter((r) => !before.has(r)), personId ?? "usman");
        // Only a routine NO bot still lists is forgotten: another bot holding it keeps its owner (the conversation its work lands in).
        const held = new Set(deps.store.list().flatMap((b) => b.routines));
        deps.routineLinks.unlink(current.routines.filter((r) => !after.has(r) && !held.has(r)));
        return { status: 200, body: await view(result.bot) };
      }
      if (result.status === 404) return { status: 404, body: { error: `There is no bot called "${id}".` } };
      return { status: 409, body: { error: `${current.name} was changed by someone else since you opened it (now rev ${result.bot?.rev}). Nothing was saved; reload it and make the change again.`, current: result.bot ? await view(result.bot) : null } };
    },

    /** A new bot. Never makes a computer, never copies anything: it points at what exists and starts with no tasks, results or conversations. */
    async create(body: unknown, personId: string): Promise<CreateOutcome> {
      const parsed = parseCreate(body, deps.validation);
      if (!parsed.ok) return refused(parsed.errors);
      const r = make(parsed.draft, personId, null);
      if (!r.ok) return { status: 409, body: { code: "id-taken", error: `"${parsed.draft.id}" is already used by a bot, so it can't be used again.`, errors: [{ field: "id", message: `"${parsed.draft.id}" is already used by a bot.`, code: "id-taken" }] } };
      return { status: 201, body: await view(r.bot) };
    },

    /** A copy of a bot's configuration, named "<name> copy" with a fresh id. See validate.ts copyOf for what is (and is never) carried over. */
    async duplicate(id: string, personId: string): Promise<CreateOutcome> {
      const source = deps.store.get(id);
      if (!source) return { status: 404, body: { error: `There is no bot called "${id}".` } };
      const r = make(copyOf(source, deps.validation), personId, source);
      if (!r.ok) return { status: 409, body: { code: "id-taken", error: "Couldn't find a free id for the copy; try again.", errors: [{ field: "id", message: "Couldn't find a free id for the copy.", code: "id-taken" }] } };
      return { status: 201, body: await view(r.bot) };
    },

    /**
     * Archive or unarchive, rev-checked. Archiving hides the bot and refuses new requests; it never deletes a result, conversation or task and never
     * stops a running job. With work open it is refused and the work listed, unless the person chose "after current work": new work is refused at once
     * and what is running finishes. The last active bot can't be archived.
     */
    async archive(id: string, body: unknown, personId: string): Promise<ArchiveOutcome> {
      const current = deps.store.get(id);
      if (!current) return { status: 404, body: { error: `There is no bot called "${id}".` } };
      const parsed = parseArchive(body);
      if (!parsed.ok) return { status: 400, body: { error: parsed.errors[0].message, errors: parsed.errors } };
      const stale = async (bot: Bot | null): Promise<ArchiveOutcome> => ({ status: 409, body: { error: `${current.name} was changed by someone else since you opened it (now rev ${bot?.rev}). Nothing was saved; reload it and try again.`, current: bot ? await view(bot) : null } });
      if (parsed.rev !== current.rev) return stale(current);
      if (!parsed.archived) {
        const r = deps.store.setArchived(id, parsed.rev, { archive: null, by: personId });
        if (r.ok) return { status: 200, body: await view(r.bot) };
        return r.status === 404 ? { status: 404, body: { error: `There is no bot called "${id}".` } } : r.status === 409 ? stale(r.bot) : { status: 422, body: { code: "not-archived", error: `${current.name} isn't archived.` } };
      }
      if (current.archived) return { status: 422, body: { code: "already-archived", error: `${current.name} is already archived.` } };
      if (!deps.store.list().some((b) => b.id !== id && isActive(b))) return { status: 422, body: { code: "last-active", error: `${current.name} is the only active bot, so it can't be archived. Make or unarchive another bot first.` } };
      await deps.prepare?.().catch(() => undefined);
      // Everything that needs an await is done first; the open-work check and the write below have none between them, so a job that starts while
      // this runs is either seen by the check or starts after the archive and is refused as new work.
      const source = current.coding.enabled ? await deps.coding().catch(() => null) : null;
      const fresh = deps.store.get(id);
      if (!fresh || fresh.rev !== parsed.rev) return stale(fresh);
      const work = openWorkFrom(current, source);
      if (work.length && !parsed.afterCurrentWork) {
        const list: WorkItem[] = work.map((w) => ({ jobId: w.jobId, title: w.title, kind: w.kind, phase: w.phase }));
        return { status: 422, body: { code: "has-running-work", error: `${current.name} has ${work.length} job${work.length === 1 ? "" : "s"} open: ${list.slice(0, 3).map((w) => `"${w.title}" (${w.phase})`).join(", ")}${list.length > 3 ? " ..." : ""}. Archive after its current work, or stop the work first. Nothing was archived.`, work: list } };
      }
      const r = deps.store.setArchived(id, parsed.rev, { archive: { by: personId, afterCurrentWork: parsed.afterCurrentWork && work.length > 0 }, by: personId });
      if (r.ok) {
        // The routines it ran as are released (the write did that); a routine no other bot lists is forgotten, so it can be linked to another bot.
        const held = new Set(deps.store.list().flatMap((b) => b.routines));
        deps.routineLinks.unlink(current.routines.filter((x) => !held.has(x)));
        return { status: 200, body: await view(r.bot) };
      }
      if (r.status === 404) return { status: 404, body: { error: `There is no bot called "${id}".` } };
      if (r.status === 409) return stale(r.bot);
      return { status: 422, body: { code: ("reason" in r && r.reason === "last-active") ? "last-active" : "already-archived", error: ("reason" in r && r.reason === "last-active") ? `${current.name} is the only active bot, so it can't be archived.` : `${current.name} is already archived.` } };
    },

    /**
     * Computer jobs and coding jobs for this bot, newest first (start time, then id), one list. `before` (epoch ms) pages back. With `beforeId` too (the
     * previous page's last row) the cursor is exact: rows sharing the boundary millisecond are neither repeated nor lost. Without it, `before` is strict
     * (older than that millisecond), as it always was.
     */
    async tasks(id: string, personId: string, options: { limit?: number; before?: number; beforeId?: string } = {}): Promise<{ tasks: BotTask[]; before: number | null; beforeId: string | null } | null> {
      const bot = deps.store.get(id);
      if (!bot) return null;
      const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 30)), 100);
      const results = new Set(botArtifacts(bot, personId).map((a) => a.id));
      // The sources page strictly older than a millisecond, so ask for the boundary millisecond too and apply the exact cursor here.
      // Without beforeId the boundary is strict, so the sources' own strict cursor is enough; with it, ask a little further back to cover the rows that share the boundary millisecond.
      const exact = options.before !== undefined && options.beforeId !== undefined;
      const reach = exact ? options.before! + 1 : options.before;
      const fetch = exact ? limit + 1 + 25 : limit + 1;
      const inPage = (t: { id: string; startedAt: number }) => options.before === undefined || t.startedAt < options.before || (options.beforeId !== undefined && t.startedAt === options.before && t.id < options.beforeId);
      const rows: BotTask[] = computerJobs(bot, fetch, reach).map((j) => ({
        id: j.id,
        kind: "computer" as const,
        title: j.title,
        state: j.state,
        phase: JOB_PHASE[j.state] ?? "unknown",
        startedAt: Date.parse(j.createdAt),
        endedAt: TERMINAL.has(j.state) ? Date.parse(j.updatedAt) : null,
        ...(j.note && j.state !== "succeeded" && j.state !== "running" && j.state !== "queued" ? { blocker: j.note.replace(WAITING_NOTE, "") } : {}),
        ...(results.has(j.id) ? { resultArtifact: `artifact:${j.id}` } : {}),
        ...(j.subjects?.length ? { subjects: j.subjects } : {}),
        ...((d) => (d ? { decision: d } : {}))(taskDecision(deps.jobs()?.get(j.id)?.steps.find((s) => s.executor === "context" && s.jev)?.jev)),
      }));
      // The coding store pages on creation time itself, so page 2 reads the next OLDER jobs (not a filter over the newest few).
      for (const { job, events, link } of await codingJobs(bot, fetch, reach ?? Number.MAX_SAFE_INTEGER)) {
        const decision = taskDecision(link?.decision);
        rows.push({ ...codingTaskOf(job, events, link?.subjects), ...(decision ? { decision } : {}) });
      }
      const ordered = rows.filter(inPage).sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const page = ordered.slice(0, limit);
      const more = ordered.length > limit;
      return { tasks: page, before: more ? page[page.length - 1].startedAt : null, beforeId: more ? page[page.length - 1].id : null };
    },

    /** Saved results of this bot's computer (this person's own) and the outputs of its coding jobs. */
    async files(id: string, personId: string): Promise<{ files: BotFile[] } | null> {
      const bot = deps.store.get(id);
      if (!bot) return null;
      const out: BotFile[] = [];
      {
        const jobs = deps.jobs();
        for (const a of botArtifacts(bot, personId)) {
          const made = jobs?.get(a.id);
          const subjects = made?.subjects;
          out.push({ artifact: `artifact:${a.id}`, title: a.title, jobId: a.id, createdAt: Date.parse(a.createdAt), source: "computer", summary: a.summary, href: `/__computers/artifacts/${a.id}`, files: a.files.map((f) => ({ name: f.name, bytes: f.bytes, mime: f.mime })), ...(subjects?.length ? { subjects } : {}) });
        }
      }
      for (const { job, events, link } of await codingJobs(bot, 60)) {
        const f = codingFileOf(job, events, link?.subjects);
        if (f) out.push(f);
      }
      out.sort((a, b) => b.createdAt - a.createdAt);
      return { files: out };
    },

    /** This person's conversation with the bot: the server entries after `after`, in the shape the UI already folds. Reads only. */
    thread(id: string, personId: string, after: number): { conversationId: string; conversationKey: string; entries: ThreadEntry[]; last: number } | { forbidden: true } | null {
      const bot = deps.store.get(id);
      if (!bot) return null;
      const ids = identity(personId, bot);
      const c = deps.conversations.get(ids.conversationId);
      if (c && c.personId !== personId) return { forbidden: true };
      const entries = c ? deps.conversations.entriesAfter(ids.conversationId, after) : [];
      return { ...ids, entries, last: entries.at(-1)?.seq ?? after };
    },

    /** The existing skills a bot may be given. */
    skills: (): { skills: SkillInfo[] } => ({ skills: ABILITIES.map((a) => ({ name: a.id, description: `${a.name}: ${a.description}` })) }),

    /** The bot records alone, for the command path (no readiness work). */
    bots: () => deps.store.list(),
    bot: (id: string) => deps.store.get(id),
    now,
  };
}

export type AgentsService = ReturnType<typeof createAgentsService>;
