// What a Jarvis hand-off really came to, read from the conversation (frontend only; the hub's thread entries are the facts).
//
// A hand-off row used to say "Done" as soon as the request was handed over ("Research started … (job 1a2b3c4d)"), even when that
// job was later stopped or failed (production, 4 Oct). The row now follows the job named in its result through the thread.
import { entryKind, jobIdOf, type EntryKind } from "./thread-events";

export type ThreadLine = { role: string; text: string; via?: string };
export type HandoffPhase = "running" | "waiting" | "done" | "failed";
export type HandoffStatus = { phase: HandoffPhase; word: string };

const ENDED: readonly EntryKind[] = ["finished", "failed", "stopped", "unknown"];

/** The latest thing the thread says about a job (by its full id, or the 8-character prefix a result line shows). */
export function latestKindFor(messages: readonly ThreadLine[], jobId: string): EntryKind | null {
  const prefix = jobId.toLowerCase();
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = jobIdOf(messages[i].via);
    const kind = entryKind(messages[i].via);
    if (id && kind && id.toLowerCase().startsWith(prefix)) return kind;
  }
  return null;
}

/** The jobs the thread shows as started and not ended (stopped, finished, failed or outcome unclear): the ones a Stop button is for. */
export function openJobs(messages: readonly ThreadLine[]): Set<string> {
  const open = new Set<string>();
  for (const m of messages) {
    const id = jobIdOf(m.via);
    const kind = entryKind(m.via);
    if (!id || !kind) continue;
    if (ENDED.includes(kind)) open.delete(id);
    else open.add(id);
  }
  return open;
}

/** The job a hand-off's result names ("… (job 1a2b3c4d)"), or null. */
export function handoffJob(result: string | undefined): string | null {
  return /\(job ([0-9a-f]{8})\b/i.exec(result ?? "")?.[1] ?? null;
}

/**
 * The row's word and motion phase. `base` is the feed's own status (running / needs-you / done / failed). When the hand-off started a
 * job, the job's latest thread entry decides; a hand-off that only started something is "Handed off", never "Done".
 */
export function handoffStatus(base: "running" | "needs-you" | "done" | "failed", baseWord: string, result: string | undefined, messages: readonly ThreadLine[]): HandoffStatus {
  const basePhase = ({ running: "running", "needs-you": "waiting", done: "done", failed: "failed" } as const)[base];
  const job = handoffJob(result);
  if (!job || base !== "done") return { phase: basePhase, word: baseWord };
  const kind = latestKindFor(messages, job);
  if (kind === "finished") return { phase: "done", word: "Finished" };
  if (kind === "stopped") return { phase: "waiting", word: "Stopped" };
  if (kind === "failed") return { phase: "failed", word: "Failed" };
  if (kind === "unknown") return { phase: "waiting", word: "Outcome unclear" };
  if (kind === "waiting") return { phase: "waiting", word: "Waiting for you" };
  if (kind) return { phase: "running", word: "Running" };
  return { phase: "waiting", word: "Handed off" };
}
