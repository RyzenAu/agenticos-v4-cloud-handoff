/**
 * Track 2 (28 Sep 2026): the shared contracts for Jev-led Jarvis commands.
 *
 *   TARGET-ARCHITECTURE §3.4  the Jev decision: { op, target?, confidence, policy, delegateTo?, deviceId? }
 *   TARGET-ARCHITECTURE §3.6  every executor call carries targetDeviceId; the hub is never a fallback
 *   NEXUS-ADDENDUM §1-2, §7   one resolver for typed and spoken commands; page context; device-local routing
 *
 * Pure types and small pure helpers only: the server (scripts/jarvis-command/*), the companion
 * (companion/*) and the UI (src/lib/jarvis-command.ts) all import this file.
 */

/** Where a command came from. Typed and spoken commands take the SAME path after this. */
export type CommandSource = "voice" | "typed" | "away" | "acceptance";

/** Who a delegated step goes to (via the model router or an existing specialist route). */
export type SpecialistId = "brain" | "vision" | "voice-tools" | "memory" | "coding" | "receptionist" | "finance" | "leads" | "reminder";

export type DecisionPolicy = "act" | "look-again" | "ask" | "delegate" | "done";

/**
 * Jev's typed decision for one step (§3.4). Jev picks from typed options; free text, plans and numbers
 * come from specialists or deterministic tools. `source` says who actually decided: Jev (TypeSafe),
 * deterministic rules, the page context, or the destination registry. Thresholds are never permission.
 */
export type JevDecision = {
  op: string;
  /** Masked: an app name, a file basename, a page path, a host. Never typed text. */
  target?: string;
  confidence: number;
  policy: DecisionPolicy;
  delegateTo?: SpecialistId;
  deviceId?: string;
  source: "jev" | "rules" | "context" | "registry";
  /** One short plain line: why this choice. */
  why: string;
  /** The threshold set this decision was judged against. */
  calibrationRunId: string;
};

/** Per-surface thresholds, stored with the calibration run that produced them (§3.4). */
export type SurfaceThresholds = { surface: string; act: number; lookAgain: number; calibrationRunId: string; note: string };

/**
 * The executors a command can run. Every call carries its targetDeviceId; the hub runs its own, a
 * companion runs the subset it allow-lists (companion/executors.ts), and nothing is ever re-routed.
 */
export type ExecutorName =
  | "app.open" // launch an allow-listed Windows app and confirm a new window of it appeared
  | "open-url" // a plain http(s) page (hub: the app-owned Playwright browser; companion: default browser)
  | "file.open" // a document by name inside that device's authorised folders, confirmed by its window
  | "deck" // PowerPoint COM ops on a deck under an authorised root (create/open/edit/add/show/end)
  | "deck.blank" // a NEW, never-saved PowerPoint presentation with a title slide, read back from COM
  | "notepad.type" // a NEW empty Notepad document, a line typed and read back; never saved
  | "app.focus" // launch or focus an allow-listed app; confirmed by reading the foreground window's process and handle
  | "browser.navigate" // a new tab (or this one) in Jarvis Chrome at a URL; confirmed by the tab's own title and address
  | "target.focus" // bring back a website or app the person was using, confirmed as the foreground window
  | "screen.goal" // an open-ended or compound goal: the SAME Jarvis entry + screen loop the PC hub runs, on the companion's own PC
  | "observe.window" // read-only: the foreground window's process and title (no screenshot)
  | "browser.youtube" // hub only: YouTube steps in the app-owned browser
  | "screen.act" // hub only: the Jev-first screen loop on the window in front
  | "echo"
  | "wait";

/** Executors a companion may be asked to run (the hub-only ones are never dispatched). */
export const COMPANION_EXECUTORS: readonly ExecutorName[] = ["app.open", "app.focus", "open-url", "browser.navigate", "file.open", "deck.blank", "notepad.type", "observe.window", "target.focus", "screen.goal", "echo", "wait"];

/** A job's plan for a companion: up to this many typed steps, each dispatched, checked and recorded on its own. */
export const MAX_REMOTE_STEPS = 6;
export type RemoteStep = { executor: ExecutorName; args: Record<string, unknown> };

export type ExecutorCall = { targetDeviceId: string; executor: ExecutorName; args: Record<string, unknown> };

/**
 * What every executor returns. `verified` is the independent check AFTER the action: true only when
 * the check passed, false when it failed, null when no check was possible (then success is never
 * claimed: the spoken line says so).
 */
export type ExecutorResult = {
  ok: boolean;
  said: string;
  verified: boolean | null;
  evidence?: string;
  data?: Record<string, unknown>;
  /** When the check after the action PASSED (ms epoch, this machine's clock). A stop is only "too late" if it came after this. */
  checkedAt?: number;
};

/** Structural check for an ExecutorResult coming back over the wire (a companion's output). */
export function isExecutorResult(value: unknown): value is ExecutorResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.ok === "boolean" && typeof v.said === "string" && (v.verified === true || v.verified === false || v.verified === null);
}

// ------------------------------------------------------------------------------------------------
// Page context (NEXUS §2). Track 1 publishes the page-context API; this is the small interface the
// command path codes against. The client sends the envelope with a command; the server validates it.

export type PageContextItem = {
  /** "call", "package", "lead", "client", "job", "file", "invoice", "margin"... */
  kind: string;
  id: string;
  label: string;
  /** An OS-internal path that opens this item ("/receptionist?call=abc"). Never an external URL. */
  href?: string;
  /** Figures as shown on the page (for "explain this"): numbers or short strings only. */
  data?: Record<string, string | number | boolean | null>;
};
export type DataState = "live" | "simulated" | "stale" | "failed" | "unknown" | "setup-required";
export type PageContext = {
  /** The OS route, e.g. "/operations". */
  page: string;
  title?: string;
  /** What he has selected (a package tab, a client). */
  selected?: PageContextItem[];
  /** The item with focus (keyboard focus or the open drawer). */
  focused?: PageContextItem | null;
  /** Items visible on the page, most prominent first (bounded). */
  visible?: PageContextItem[];
  source?: { name: string; state?: DataState; updatedAt?: string };
  jobId?: string;
  capturedAt?: number;
};

// ------------------------------------------------------------------------------------------------
// The ONE destination registry (Track 1, f/t1-experience-20260928). Until it is published this is the
// interface; scripts/jarvis-command/registry.ts holds a small built-in adapter.

export type DestinationKind = "os-page" | "project" | "file" | "website" | "app";
export type Destination = {
  id: string;
  kind: DestinationKind;
  label: string;
  /** os-page / project: an OS path. website: an https URL. app: an allow-listed app name. file: a name. */
  ref: string;
  /** Acting on a device (app, file, website opened on a machine) vs navigating the OS UI. */
  deviceAction: boolean;
  score: number;
};
export interface DestinationRegistry {
  resolve(text: string): Destination[];
}

// ------------------------------------------------------------------------------------------------
// The wire (HTTP, NDJSON). ONE entry for typed and spoken commands, for every signed-in founder:
//
//   POST /__operator/screen/command   CommandBody → NDJSON: CommandStreamEvent lines, the last one "done"
//   GET  /__operator/screen/command/attach?job=<jobId>&since=<seq>
//        → NDJSON: the same job's events after `since` (a reconnect), ending with "done"
//   POST /__operator/screen/command/cancel   { jobId } → { ok, state }   (also: POST /__jobs/<id>/cancel)
//
// A dropped connection does NOT stop the job at once: it keeps running for RECONNECT_GRACE_MS so the
// client can re-attach; with nobody attached after that, the job is cancelled. An explicit stop
// (the voice "stop", the pill's Stop) cancels at once through the job service.

export const RECONNECT_GRACE_MS = 20_000;

export type CommandBody = {
  utterance: string;
  source?: CommandSource;
  /** "on my laptop": the machine he named, if the client already split it out. */
  spokenTarget?: string;
  pageContext?: PageContext;
  /** The voice pipeline's own spoken-yes event id (never minted by a client). */
  spokenYes?: string;
  /**
   * A typed plan for the requester's own companion (Jev's or a caller's): each step is dispatched in order, to the
   * device the job started on, and checked before the next. Only COMPANION_EXECUTORS; at most MAX_REMOTE_STEPS.
   */
  steps?: RemoteStep[];
  /**
   * The person's Jarvis thread (the voice transcript's conversation id). Jobs this command leaves going are linked to it and their results
   * are appended there by the server. Absent: the person's default thread. Someone else's id is ignored.
   */
  conversationId?: string;
  /**
   * A client-minted id for THIS utterance (one per spoken or typed event, stable across a reconnect's replay). The same id from the same
   * person is the same command: the first outcome is returned and nothing runs twice.
   */
  eventId?: string;
};

export type CommandKind = "screen" | "browser" | "app" | "file" | "answer" | "navigate" | "handoff" | "refused" | "ask" | "unavailable" | "remote";

export type CommandDoneEvent = {
  type: "done";
  ok: boolean;
  /** The ONE short line to speak or show. The full detail is in the job's steps (the inspector). */
  said: string;
  kind: CommandKind;
  jobId: string | null;
  runId: string;
  targetDeviceId: string | null;
  decision?: JevDecision;
  navigate?: { path: string };
  url?: string;
  handoff?: { to: SpecialistId; intent: string; reason: string; utterance?: string };
  outcome?: string;
  ask?: boolean;
  stopped?: boolean;
  confirm?: string;
  /** The unfinished screen goal after a verified setup. */
  resumeGoal?: string;
  /** When the lane's post-action check passed on the hub (ms epoch), if it reports one. */
  checkedAt?: number;
  /** A question was asked that waits for his answer (a final button's yes, a forget's yes): the job is awaiting-approval. */
  awaiting?: boolean;
  refused?: boolean;
  verified?: boolean | null;
  numbers?: Record<string, unknown>;
};

export type CommandStreamEvent =
  | { type: "job"; jobId: string; targetDeviceId: string; deviceLabel?: string; seq: number }
  | { type: "decision"; decision: JevDecision; seq: number }
  | { type: "narrate"; stage: string; text: string; speak?: boolean; seq?: number }
  | { type: "step"; did?: string; verified?: boolean; ok?: boolean; seq?: number }
  | { type: "slow"; said: string; seq?: number }
  | CommandDoneEvent;
