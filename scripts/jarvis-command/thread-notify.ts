/**
 * Where an appended conversation entry goes next (the glue scripts/operator-plugin.ts mounts, and the tests drive as it is):
 *
 *   entry appended  --> the person's own /__events stream (so an open tab shows it with no refresh)
 *                   --> for the entry that reports where a job ENDED: the one spoken line, through the interjection gate
 *
 * Both are notifications. Neither can start, resume, retry or cancel a job: the stream carries text, and the gate only ever returns a line to say.
 * The spoken line's dedupe key is the stable event id (`job:<jobId>:<state>`); the gate persists it for 24 hours, so telling it twice, after a restart,
 * on a replay or from a second tab, is one event and at most one spoken line. Only for the person whose own session is at this PC.
 */
import type { ThreadEntry } from "../conversations";
import type { ThreadNotice } from "./threads";

export type ThreadNoticeSources = {
  threads: { onEntry(listener: (n: ThreadNotice) => void): () => void; isLocal(personId: string): boolean };
  activity: { threadEntry(input: { personId: string; conversationId: string; entry: ThreadEntry }): void };
  events: { submit(body: { source: string; text: string; priority: "normal"; dedupeKey: string; person: string }): unknown };
};

export function wireThreadNotices(s: ThreadNoticeSources): () => void {
  return s.threads.onEntry(({ personId, conversationId, entry, announce }) => {
    try {
      s.activity.threadEntry({ personId, conversationId, entry });
    } catch {
      /* a stream that can't publish never loses the durable entry */
    }
    if (!announce || !s.threads.isLocal(personId)) return;
    try {
      s.events.submit({ source: "jarvis-job", text: announce.text, priority: "normal", dedupeKey: announce.key, person: personId });
    } catch {
      /* the gate refusing a line never loses the conversation entry */
    }
  });
}
