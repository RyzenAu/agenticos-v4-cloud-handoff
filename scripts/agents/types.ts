/**
 * Agents workspace, server side (2 Oct 2026). The contract is docs/programme-20261001/AGENTS-WORKSPACE-PLAN.md; any difference from it is
 * listed in the builder's report as an amendment, never silent.
 *
 * Nothing in scripts/agents is a job engine, scheduler, memory or assistant framework. A bot is a durable record that POINTS at the
 * systems that already exist (a shared computer, the coding accounts, router routes, skills, routines, the shared memory pool); the work
 * itself runs as ordinary computer jobs and coding jobs, and everything it does is reported into one conversation per person and bot.
 */

export type BotId = string;

export type Bot = {
  id: BotId;
  name: string;
  purpose: string;
  /** Appended to this bot's job briefs (a context note on every job; the brief of a builder/proposal workflow). */
  instructions: string;
  /** Shared computer name (scripts/computers store); null = no computer. */
  computer: string | null;
  /** Builder: Claude/Codex coding jobs, on this account slot (`claude:max-2`) and model, or null = the automatic pick. */
  coding: { enabled: boolean; accountSlot: string | null; model: string | null };
  /** "auto", "free-only", or a router task class from the model catalogue (e.g. "research.web"). */
  modelPreference: { route: string };
  skills: string[];
  routines: string[];
  memory: { recall: boolean; saveResults: boolean };
  createdAt: number;
  updatedAt: number;
  /** Bumped by every accepted edit; a PATCH carrying an older rev is refused with 409. */
  rev: number;
  /** Who made the bot (a person id). Absent on the seeded Research and Builder. */
  createdBy?: string;
  /** The bot this one was duplicated from (configuration only was copied). */
  duplicatedFrom?: string | null;
  /**
   * Set while the bot is archived: it is hidden from the selector and refuses new requests. Nothing it did is deleted. `afterCurrentWork` records
   * that the person chose "archive after current work": jobs that were already open were left to finish.
   */
  archived?: BotArchive | null;
  /**
   * The routines this bot was running as when it was archived. Archiving RELEASES them (the bot's `routines` becomes empty, so they run as nobody and can be
   * linked to another bot); this is kept for information only, and unarchiving does not link them again.
   */
  releasedRoutines?: string[];
  /** Who did what and when (created, duplicated, archived, unarchived, edited: with the names of the fields changed, never their values), newest last, capped. */
  history?: BotEvent[];
};

export type BotArchive = { at: number; by: string; afterCurrentWork: boolean };
export type BotEvent = { at: number; by: string; action: "created" | "duplicated" | "archived" | "unarchived" | "edited"; note?: string };
export const HISTORY_MAX = 30;
/** active; archiving = archived but jobs that were open when it was archived are still finishing; archived. Derived live from open work. */
export type BotLifecycle = "active" | "archiving" | "archived";

export const READINESS_STATES = ["ready", "working", "needs-you", "offline", "unconfigured"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/** What the UI can offer to fix a reason: open the bot's computer, a section of its Setup, sign an account in, take over, or try again. */
export type ReasonFix = { kind: "open-computer" | "open-setup-section" | "take-over" | "sign-in" | "retry"; target?: string };
/** One thing worth saying about a bot's readiness: a stable code, plain words with what to do about it, and (when the UI can act on it) the fix. */
export type ReadinessReason = {
  code: string;
  text: string;
  fix?: ReasonFix;
  /** The OTHER bot a reason is about (`computer-busy-other-bot`: the bot whose task holds the shared computer). */
  bot?: { id: string; name: string };
};

/** One capability of a bot (its computer, its coding account, its model route) and how it stands right now. */
export type ReadinessPart = { state: ReadinessState; /** Plain words, with what to do about it. Null when there is nothing to say. */ reason: ReadinessReason | null };

/** Derived from the real services on every read; never stored. */
export type BotReadiness = {
  state: ReadinessState;
  /** Each in plain words with a recovery hint ("... Start it on the Computers page."), and a structured fix when the UI can offer one. Empty when all is well. */
  reasons: ReadinessReason[];
  /** Additive to the plan: what the bot is doing now ("Working on ..."), and each capability's own state (the status line and Setup read these). */
  working: { jobId: string; title: string; kind: "computer" | "coding" } | null;
  parts: { computer?: ReadinessPart; coding?: ReadinessPart; router?: ReadinessPart };
};

/** `skills` in a view is READ-ONLY and derived: the ids of what the bot can actually do (see abilities.ts); `abilities` carries their names and descriptions. */
export type BotView = Bot & {
  readiness: BotReadiness;
  abilities: Array<{ id: string; name: string; description: string }>;
  lifecycle: BotLifecycle;
  /** The other bots (any lifecycle) that use the same shared computer. They share its one control lease: only one task runs on it at a time. */
  sharesComputerWith: Array<{ id: string; name: string; archived: boolean }>;
};

export const BOT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The bots the hub starts with (written once, the first time bots.json is absent). */
export function seedBots(now: number): Bot[] {
  return [
    {
      id: "research",
      name: "Research",
      purpose: "Finds, reads and compares public sources, and returns a cited report.",
      instructions: "Cite every source you used. Say plainly what you could not find. Keep reports short enough to read in a minute.",
      computer: "research",
      coding: { enabled: false, accountSlot: null, model: null },
      modelPreference: { route: "auto" },
      skills: [],
      routines: [],
      memory: { recall: true, saveResults: true },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
    {
      id: "builder",
      name: "Builder",
      purpose: "Builds components and previews on its own computer, and runs Claude and Codex coding jobs on the shared accounts.",
      instructions: "Work in an isolated branch or worktree. Show what changed, the tests that ran and what is still open. Never merge or deploy.",
      computer: "builder",
      coding: { enabled: true, accountSlot: null, model: null },
      modelPreference: { route: "auto" },
      skills: [],
      routines: [],
      memory: { recall: true, saveResults: true },
      createdAt: now,
      updatedAt: now,
      rev: 1,
    },
  ];
}

/** What a task row looks like in /__agents/bots/:id/tasks (computer jobs and coding jobs, one list). */
export type BotTask = {
  id: string;
  kind: "computer" | "coding";
  title: string;
  /** The job's own state word (a job-service state for a computer job, a coding-store state for a coding job). */
  state: string;
  /** Additive to the plan: one normalised reading of `state` so a list can group and colour without knowing both vocabularies. */
  phase: "running" | "waiting" | "done" | "failed" | "stopped" | "unknown";
  startedAt: number;
  endedAt: number | null;
  account?: string;
  model?: string;
  blocker?: string;
  /** `artifact:<jobId>`: a saved result this task produced (resolvable at /__computers/artifacts/<jobId>). */
  resultArtifact?: string;
  review?: { verdict: string; blockers: number; majors: number; minors: number };
  tests?: { passed: number; failed: number };
  branch?: string;
  commit?: string;
  /** What actually ran, from the job's receipts: the account and model that ANSWERED (not the ones selected). */
  receipts?: { account: string; model: string; role?: string }[];
  subjects?: string[];
  /**
   * Round 10: who sent this task to the bot, as the decision recorded it (the shape src/lib/commands/decided-by.ts DecidedByInput reads, so the row can
   * say "Decided by Jev / Rule / Fallback"). Absent when nothing was recorded; never invented.
   */
  decision?: TaskDecision;
};

export type TaskDecision = { decidedBy?: string; op?: string; confidence?: number; ms?: number; requestId?: string; model?: string; options?: string[]; cached?: boolean };
/** The task-row decision from a step's or link's decision record (only the fields the "Decided by" label reads). Pure. */
export function taskDecision(j: { decidedBy?: string; op?: string; confidence?: number; ms?: number; requestId?: string; model?: string; options?: string[]; cached?: boolean } | null | undefined): TaskDecision | undefined {
  if (!j) return undefined;
  const out: TaskDecision = {};
  for (const k of ["decidedBy", "op", "requestId", "model"] as const) if (typeof j[k] === "string") out[k] = j[k];
  for (const k of ["confidence", "ms"] as const) if (typeof j[k] === "number") out[k] = j[k];
  if (Array.isArray(j.options)) out.options = j.options.filter((o) => typeof o === "string").slice(0, 12);
  if (typeof j.cached === "boolean") out.cached = j.cached;
  return Object.keys(out).length ? out : undefined;
}

export type BotFile = {
  /** `artifact:<jobId>` for a computer result, `coding:<jobId>` for a coding job's output. */
  artifact: string;
  title: string;
  jobId: string;
  createdAt: number;
  source: "computer" | "coding";
  summary?: string;
  /** The saved result's page; absent for a coding job (its page is the Coding workspace). */
  href?: string;
  files: { name: string; bytes: number | null; mime?: string; status?: string }[];
  branch?: string;
  commit?: string;
  review?: BotTask["review"];
  tests?: BotTask["tests"];
  receipts?: BotTask["receipts"];
  subjects?: string[];
};
