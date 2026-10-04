// The browser side of the conversation entries on /__events (src/lib/thread-events.ts): folding live entries into the open transcript with no
// refresh, applying a replay or a second tab's copy once, remembering handled event ids, and proving a replayed completion starts nothing.
import { describe, expect, test } from "bun:test";
import { ActivityClient, type ActivityEvent, type ActivityMessage, type SourceLike } from "../../src/lib/activity-stream";
import { ENTRY_LABEL, entryKind, foldEntry, foldMissing, jobIdOf, parseThreadEvent, viaFor, withoutServerEntries } from "../../src/lib/thread-events";

type Turn = { who: "you" | "oracle"; text: string; via?: string };
const entryEvent = (id: number, key: string, state: string, text: string, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id, at: 1, topic: "thread", type: "entry", final: state === "report" || state === "succeeded",
  data: { conversationId: "c-1", eventId: `c-1:${key}`, entry: { seq: id, key, at: "2026-10-02T03:00:00.000Z", jobId: "job-1", state, text } }, ...over,
});

describe("parsing and folding a live entry", () => {
  test("only a well-formed thread entry is ours; truncated, other topics and malformed data are ignored", () => {
    expect(parseThreadEvent(entryEvent(1, "job-1:started", "started", "Started: x (job abc)."))).toMatchObject({ conversationId: "c-1", eventId: "c-1:job-1:started", entry: { key: "job-1:started" } });
    expect(parseThreadEvent({ ...entryEvent(2, "k", "started", "x"), topic: "job" })).toBeNull();
    expect(parseThreadEvent({ ...entryEvent(3, "k", "started", "x"), truncated: true })).toBeNull();
    expect(parseThreadEvent({ ...entryEvent(4, "k", "started", "x"), data: { conversationId: "c-1", entry: { key: "k" } } })).toBeNull();
    expect(parseThreadEvent({ ...entryEvent(5, "k", "started", "x"), data: null })).toBeNull();
  });

  test("an entry is added to the transcript once: the same event again (a replay, a second tab) leaves it exactly as it was", () => {
    const e = parseThreadEvent(entryEvent(7, "job-1:step:2", "progress", "Research, step 1 of 5 (find sources): done."))!;
    const turns: Turn[] = [{ who: "you", text: "use the research computer to research x" }];
    const once = foldEntry(turns, e.entry);
    expect(once.applied).toBe(true);
    expect(once.turns).toEqual([...turns, { who: "oracle", text: e.entry.text, via: viaFor("job-1:step:2") }]);
    const twice = foldEntry(once.turns, e.entry);
    expect(twice.applied).toBe(false);
    expect(twice.turns).toBe(once.turns);
  });

  test("a gap (a snapshot instead of a replay) is filled from the saved conversation: only the missing server entries are added", () => {
    const have: Turn[] = [{ who: "you", text: "hi" }, { who: "oracle", text: "Started", via: viaFor("job-1:started") }];
    const server = [{ role: "user", text: "hi" }, { role: "oracle", text: "Started", via: viaFor("job-1:started") }, { role: "oracle", text: "Result", via: viaFor("job-1:report:1") }, { role: "oracle", text: "Finished", via: viaFor("job-1:succeeded") }, { role: "oracle", text: "a model reply", via: "deepseek" }];
    const filled = foldMissing(have, server);
    expect(filled.map((t) => t.via)).toEqual([undefined, viaFor("job-1:started"), viaFor("job-1:report:1"), viaFor("job-1:succeeded")]);
    expect(foldMissing(filled, server)).toBe(filled);
  });

  test("how a server entry is labelled: progress, the research result, a job's end", () => {
    expect(entryKind(viaFor("j:started"))).toBe("started");
    expect(entryKind(viaFor("j:step:3"))).toBe("progress");
    expect(entryKind(viaFor("j:report:1"))).toBe("result");
    expect(entryKind(viaFor("j:cancelled"))).toBe("stopped");
    expect(entryKind(viaFor("j:awaiting-approval"))).toBe("waiting");
    expect(entryKind("deepseek")).toBeNull();
    expect(ENTRY_LABEL.result).toBe("Result");
  });
});

describe("regressions from the review", () => {
  test("a server entry arriving is not an edit: it never changes what decides an autosave, but stays in the body that is saved", () => {
    const own = [{ role: "user", text: "hi" }, { role: "oracle", text: "yo", via: "deepseek" }];
    const withEntries = [...own, { role: "oracle", text: "Research, step 1 of 5 (find sources): done.", via: viaFor("job-1:step:2") }];
    expect(withoutServerEntries(withEntries)).toEqual(own);
    expect(JSON.stringify(withoutServerEntries(withEntries))).toBe(JSON.stringify(withoutServerEntries(own)));
    expect(withEntries).toHaveLength(3); // the saved body still has it
  });

  test("each way a job can end has its own kind and label (not one 'Job update')", () => {
    const kinds = ["succeeded", "completed", "failed", "cancelled", "interrupted", "unknown", "awaiting-approval", "needs_owner"].map((s) => entryKind(viaFor(`j:${s}`)));
    expect(kinds).toEqual(["finished", "finished", "failed", "stopped", "unknown", "unknown", "waiting", "waiting"]);
    expect([ENTRY_LABEL.finished, ENTRY_LABEL.failed, ENTRY_LABEL.stopped, ENTRY_LABEL.waiting, ENTRY_LABEL.unknown].every((l) => l && l !== "Job update")).toBe(true);
  });

  test("the job an entry is about is read from its via, for the link", () => {
    expect(jobIdOf("job:3f2b1c1e-0a4d-4f6e-9b1a-1c2d3e4f5a6b:report:1")).toBe("3f2b1c1e-0a4d-4f6e-9b1a-1c2d3e4f5a6b");
    expect(jobIdOf("deepseek")).toBeNull();
  });
});

describe("a replayed completion event can never start, resume or re-run a job (the browser side)", () => {
  class FakeSource implements SourceLike {
    handlers = new Map<string, ((e: { data?: string; lastEventId?: string }) => void)[]>();
    constructor(readonly url: string) {}
    close() {}
    addEventListener(type: string, fn: (e: { data?: string; lastEventId?: string }) => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
    }
    fire(type: string, e: { data?: string; lastEventId?: string } = {}) {
      for (const h of this.handlers.get(type) ?? []) h(e);
    }
  }

  test("the same completion delivered by a replay and by a second connection changes the transcript once and sends NOTHING (no fetch, no EventSource write path)", () => {
    const requests: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => (requests.push(String(input)), Promise.reject(new Error("a thread event must not send anything")))) as never;
    try {
      const sources: FakeSource[] = [];
      const client = new ActivityClient({ createSource: (url) => { const s = new FakeSource(url); sources.push(s); return s; }, setTimer: () => 0, clearTimer: () => undefined });
      let turns: Turn[] = [{ who: "you", text: "use the research computer to research x" }];
      const seen: string[] = [];
      client.onMessage((m: ActivityMessage) => {
        if (m.kind !== "event") return;
        const ev = parseThreadEvent(m.event);
        if (!ev) return;
        const r = foldEntry(turns, ev.entry);
        turns = r.turns;
        seen.push(`${ev.eventId}:${r.applied ? "applied" : "skipped"}`);
      });
      client.start();
      const frame = (n: number, key: string, state: string, text: string) => ({ data: JSON.stringify(entryEvent(n, key, state, text)), lastEventId: `abc123:${n}` });
      sources[0].fire("open");
      sources[0].fire("hello", { data: JSON.stringify({ mode: "snapshot" }) });
      sources[0].fire("message", frame(1, "job-1:report:1", "report", "Web-sourced research...\nSources:\n[1] x - https://a.example/"));
      sources[0].fire("message", frame(2, "job-1:succeeded", "succeeded", "Finished: research x. (job job-1)"));
      expect(turns).toHaveLength(3);
      // The connection drops; the client resumes from its last id and the server replays the same two completion entries (a replay), then again via a second tab's relay.
      sources[0].fire("error");
      const lastUrl = sources.length > 1 ? sources[1].url : "";
      expect(lastUrl === "" || lastUrl.includes("last=abc123%3A2")).toBe(true);
      client.stop();
      client.start();
      const replay = sources.at(-1)!;
      replay.fire("open");
      replay.fire("hello", { data: JSON.stringify({ mode: "replay" }) });
      replay.fire("message", frame(1, "job-1:report:1", "report", "Web-sourced research...\nSources:\n[1] x - https://a.example/"));
      replay.fire("message", frame(2, "job-1:succeeded", "succeeded", "Finished: research x. (job job-1)"));
      expect(turns).toHaveLength(3);
      expect(seen.filter((s) => s.endsWith(":skipped"))).toHaveLength(2);
      expect(requests).toEqual([]); // nothing was requested: no job was started, resumed, re-run, cancelled or even fetched
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
