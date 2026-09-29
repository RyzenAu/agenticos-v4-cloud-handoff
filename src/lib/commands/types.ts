// The ONE destination/action registry contract (Track 1, 28 Sep 2026; NEXUS-ADDENDUM items 1, 2 and 7).
//
// The Ctrl+K palette and the Jarvis voice path (Track 2) resolve what someone typed or said through the
// SAME function, `resolveCommand(text, index, options)` in ./registry.ts, over the SAME index
// (`buildCommandIndex`). Both then turn the chosen entry into the SAME plan (`planCommand`). A device
// action is never run from a plan alone: its target device is resolved first (resolveTarget, through
// GET /__commands/target) and shown, then it runs through the existing Jarvis entry
// (POST /__operator/screen/command), which resolves the target again server-side and records the job.
//
// Pure types only: no React, no fetch, no Vite-only APIs, so bun tests and server code can import it.
// Changing a type here is a contract change: tell the lead (Track 2 codes against it).

export const COMMAND_CONTRACT_VERSION = 1 as const;

/** What an entry opens. */
export type CommandKind =
  | "page" // an OS destination or drilldown (/today, /receptionist, /operations …)
  | "section" // a named part of a page ("the receptionist's flagged calls")
  | "answer" // a deterministic figure shown with its source, then its page ("the Professional margin")
  | "project" // a local project folder (/workspaces/$id)
  | "site" // one of our websites (opens its page on /websites, or the live URL)
  | "file" // an authorised document, opened on a device in its default app
  | "app" // an installed Windows app, opened on a device
  | "lead"; // a CRM lead (/leads?lead=…)

/** Honest state of a source (the same six words every metric uses; see src/lib/honest-state.ts). */
export type SourceState = "live" | "simulated" | "stale" | "failed" | "unknown" | "setup-required";

/** Where entries come from. `static` = built into the OS (pages, sections, answers). */
export type CommandSourceId = "static" | "projects" | "sites" | "files" | "apps" | "leads";

/** The state of one source of entries, shown in the palette when it isn't live. */
export type CommandSourceStatus = {
  id: CommandSourceId;
  label: string;
  state: SourceState;
  /** Why it isn't live ("App index is kept for Usman's PC only", "Couldn't read /__websites"). */
  reason?: string;
  /** ISO time of the last successful read, when known. */
  lastSuccess?: string | null;
  count: number;
};

/** What running an entry does. Every variant is data: the caller executes it. */
export type CommandAction =
  /** Open an OS page. `focus` = the id of an element on that page to scroll to and focus. */
  | { type: "navigate"; to: string; search?: Record<string, string>; focus?: string }
  /** Open an external URL in a new tab (our live sites). */
  | { type: "open-url"; url: string }
  /**
   * Do something on a device. `utterance` is exactly what the Jarvis entry (/screen/command) receives,
   * so typed and spoken commands run the same action. The target device is resolved and shown first.
   */
  | { type: "device"; op: "open_app" | "open_file"; subject: string; utterance: string };

/** A figure an answer entry shows before its page opens. Numbers come from deterministic code only. */
export type CommandAnswer = {
  /** One line, e.g. "Estimated contribution margin 71.2% (base usage, 5 clients)". */
  headline: string;
  /** Supporting figures, label → formatted value. */
  figures: Array<{ label: string; value: string }>;
  /** Where the numbers come from (file or feed), and how sure they are. */
  source: string;
  state: SourceState;
  /** "Estimate from planning assumptions as of 2026-09-27; not measured usage." */
  caveat?: string;
};

export type CommandEntry = {
  /** Stable id: "page:/receptionist", "section:receptionist/flagged-calls", "app:PowerPoint". */
  id: string;
  kind: CommandKind;
  title: string;
  /** One line under the title. */
  detail?: string;
  /** What people type or say for it (lower-case phrases; the title is always included). */
  phrases: readonly string[];
  action: CommandAction;
  /** The OS destination it belongs to (for grouping and the current-page tie-break). */
  destination?: string;
  source: CommandSourceId;
  /** For answer entries: the figure to show (computed when the index is built). */
  answer?: CommandAnswer;
};

export type CommandIndex = {
  entries: readonly CommandEntry[];
  sources: readonly CommandSourceStatus[];
  /** When the index was built (ms epoch). */
  builtAt: number;
};

/** How the text arrived. Voice asks instead of acting on a weaker match. */
export type CommandChannel = "typed" | "voice";

export type ScoredEntry = { entry: CommandEntry; score: number };

/** "open PowerPoint here" → { verb: "open", object: "powerpoint", spokenTarget: "here" }. */
export type ParsedCommand = {
  verb: "open" | "show" | "launch" | "find" | null;
  /** The thing named, normalised (lower case, fillers removed). */
  object: string;
  /** A device named at the end ("here", "on my laptop"), verbatim; resolveTarget decides what it means. */
  spokenTarget?: string;
  /** "this" / "that call" / "it": the words refer to something on the page, not the registry. */
  deictic?: { noun: string | null };
};

/**
 * The resolver's answer. `resolved` never guesses between close matches: two different actions within
 * the ambiguity margin come back as `ambiguous` with the question to ask. `contextual` = the words
 * pointed at the page ("open that call") and the page context settled it (or asked, via `ask`).
 */
export type Resolution =
  | { status: "resolved"; entry: CommandEntry; score: number; parsed: ParsedCommand; alternatives: ScoredEntry[] }
  | { status: "ambiguous"; parsed: ParsedCommand; candidates: ScoredEntry[]; ask: string }
  | { status: "unresolved"; parsed: ParsedCommand; reason: string; unavailable: CommandSourceStatus[] };

/** What to do, before anything runs. Device plans carry the request the Jarvis entry receives. */
export type CommandPlan =
  | { kind: "navigate"; entryId: string; to: string; search?: Record<string, string>; focus?: string; answer?: CommandAnswer }
  | { kind: "open-url"; entryId: string; url: string }
  | {
      kind: "device";
      entryId: string;
      /** The body for POST /__operator/screen/command (the one Jarvis entry). */
      request: { utterance: string; spokenTarget?: string; personId?: string };
      /** Must be resolved and shown (GET /__commands/target) before `request` is sent. */
      needsTargetPreview: true;
    };

/** GET /__commands/target?spoken=… : resolveTarget for the signed-in person, for display before a run. */
export type TargetPreview =
  | { ok: true; deviceId: string; label: string; owner: string; online: true; routing: "devices" }
  | { ok: false; reason: string; deviceId?: string; label?: string; routing: "devices" | "unavailable" };
