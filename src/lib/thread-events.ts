// The browser side of the conversation entries /__events carries (topic "thread"): what a job's progress, a returned research report or a job's end
// looks like when it arrives live, and how it is folded into the open conversation WITHOUT a refresh.
//
// Everything here is a pure function or a tiny store, so it is tested without a browser. The rules, all of them about notifications:
//   - an event is applied by folding it into the transcript, keyed by its entry key, so a replay, a reconnect snapshot or a second tab applying the
//     same event is a no-op (idempotent), never a duplicate line;
//   - nothing in this file sends a request. A thread event can show a line; it cannot start, resume, retry or cancel a job;
//   - speech is never started from here. The one spoken update comes from the server's interjection gate, which claims it exactly once and persists
//     the claim; the browser keeps no list of its own (one would silence a recurring alert for good).
import type { ActivityEvent } from "./activity-stream";

export const JOB_VIA = "job:";

export type ThreadEntryData = { seq: number; key: string; at: string; jobId: string; state: string; text: string };
export type ThreadEntryEvent = { conversationId: string; eventId: string; entry: ThreadEntryData };

/** The event's entry, or null when it is not a well-formed thread entry (anything else on the stream is not ours). */
export function parseThreadEvent(event: ActivityEvent): ThreadEntryEvent | null {
  if (event.topic !== "thread" || event.type !== "entry" || event.truncated) return null;
  const d = event.data as Partial<ThreadEntryEvent> | null;
  const e = d?.entry;
  if (!d || typeof d.conversationId !== "string" || typeof d.eventId !== "string" || !e) return null;
  if (typeof e.key !== "string" || typeof e.text !== "string" || typeof e.jobId !== "string" || typeof e.state !== "string" || typeof e.seq !== "number") return null;
  return { conversationId: d.conversationId, eventId: d.eventId, entry: { seq: e.seq, key: e.key, at: String(e.at ?? ""), jobId: e.jobId, state: e.state, text: e.text } };
}

export const viaFor = (key: string) => `${JOB_VIA}${key}`;
export type EntryKind = "started" | "progress" | "result" | "finished" | "failed" | "stopped" | "waiting" | "unknown" | "update";
/** What an entry's `via` says it is (a server entry's via is `job:<key>`; the key ends with the state or `report:1`, `step:3`). Null: not a server entry. */
export function entryKind(via: string | undefined): EntryKind | null {
  if (!via || !via.startsWith(JOB_VIA)) return null;
  if (/:started$/.test(via)) return "started";
  if (/:step:\d+$/.test(via)) return "progress";
  if (/:report:\d+$/.test(via)) return "result";
  if (/:(succeeded|completed)$/.test(via)) return "finished";
  if (/:failed$/.test(via)) return "failed";
  if (/:cancelled$/.test(via)) return "stopped";
  if (/:(interrupted|unknown)$/.test(via)) return "unknown";
  if (/:(awaiting-approval|awaiting_approval|needs_owner|blocked_allowance|awaiting_confirmation)$/.test(via)) return "waiting";
  return "update";
}
/** The saved result a workflow entry offers (a "Saved result:" line is written only when the hub really kept it): the job id is the artifact id. */
export const hasSavedResult = (text: string | undefined) => /\nSaved result: [^\n]+\n\(job [0-9a-f]{8}\)\s*$/.test(text ?? "");
export const ENTRY_LABEL: Record<EntryKind, string> = { started: "Jarvis", progress: "Progress", result: "Result", finished: "Finished", failed: "Failed", stopped: "Stopped", waiting: "Waiting for you", unknown: "Outcome unclear", update: "Job update" };

/**
 * The messages that decide whether a conversation needs saving: the person's own and the models' replies. A server entry (via `job:`) shown in the
 * transcript is not an edit, so a progress line arriving must not make any open tab post its own copy (which would rewrite the model and persona and
 * bump the revision, or conflict with another tab). The entries stay in the body that is saved, so each keeps its place.
 */
export function withoutServerEntries<T extends { via?: string }>(messages: T[]): T[] {
  return messages.filter((m) => !(typeof m.via === "string" && m.via.startsWith(JOB_VIA)));
}

/** The job a server entry is about (the id in `via`), for a link to it; null for anything else. */
export function jobIdOf(via: string | undefined): string | null {
  const m = /^job:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i.exec(via ?? "");
  return m ? m[1] : null;
}

/**
 * Where "Open job" goes for a server entry: a coding entry carries its own page ("Changes: /coding/<id>?tab=changes"), and that is the link.
 * Anything else (a computer job) goes to its row in Activity. Only an in-app /coding/<this job's id> path is ever followed from text.
 */
export function openJobHref(via: string | undefined, text: string): string | null {
  const id = jobIdOf(via);
  if (!id) return null;
  const m = new RegExp(String.raw`(?:^|\s)(/coding/${id}(?:\?tab=[a-z]+)?)(?=[\s.,;)]|$)`, "i").exec(text);
  return m ? m[1] : `/activity#job-${id}`;
}

type TurnLike = { who: "you" | "oracle"; text: string; via?: string };

/**
 * The identity of a job's COMPLETION, or null for any other entry. A job that succeeded is one completion however the state is spelled
 * (`succeeded` and `completed` are the same event: a job service and a coding store word it differently), so a second line for the same job is
 * the same news. A failure, a stop and an interruption are their own outcomes (a failed job that is resumed and then succeeds really has two).
 */
export function completionIdentity(via: string | undefined): string | null {
  const id = jobIdOf(via);
  if (!id || !via) return null;
  if (/:(succeeded|completed)$/.test(via)) return `${id}:done`;
  if (/:(failed|cancelled|interrupted|unknown)$/.test(via)) return `${id}:${via.slice(via.lastIndexOf(":") + 1)}`;
  return null;
}

/** Whether the transcript already shows this entry, by its own key or as the same job completion under another spelling. */
function shows(turns: { via?: string }[], via: string): boolean {
  const identity = completionIdentity(via);
  return turns.some((t) => t.via === via || (identity !== null && completionIdentity(t.via) === identity));
}

/** Fold one live entry into the transcript. Idempotent: an entry already shown (same via, or the same job completion) leaves the transcript as it was. */
export function foldEntry<T extends TurnLike>(turns: T[], entry: ThreadEntryData): { turns: T[]; applied: boolean } {
  const via = viaFor(entry.key);
  if (shows(turns, via)) return { turns, applied: false };
  return { turns: [...turns, { who: "oracle", text: entry.text, via } as T], applied: true };
}

/** Entries the server holds that the transcript is missing (a gap while disconnected, a reconnect without replay). Existing lines are untouched. */
export function foldMissing<T extends TurnLike>(turns: T[], server: { role?: string; text: string; via?: string }[]): T[] {
  const shown: { via?: string }[] = [...turns];
  const added: T[] = [];
  for (const m of server) {
    if (!m.via || !m.via.startsWith(JOB_VIA) || shows(shown, m.via)) continue;
    const turn = { who: "oracle", text: m.text, via: m.via } as T;
    shown.push(turn);
    added.push(turn);
  }
  return added.length ? [...turns, ...added] : turns;
}
