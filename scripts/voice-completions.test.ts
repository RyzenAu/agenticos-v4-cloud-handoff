// One completion per task, spoken only by a live session, otherwise unread (src/lib/voice-completions.ts, src/lib/thread-events.ts, voice-unread.tsx).
// Pure and event-stream checks: they prove the rules, not the sound of a voice. A physical microphone and speaker test is still owed (see the r10 report).
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ActivityClient, type ActivityEvent, type ActivityMessage, type SourceLike } from "../src/lib/activity-stream";
import { completionIdentity, foldEntry, foldMissing, parseThreadEvent, viaFor } from "../src/lib/thread-events";
import { createThreadFeed, createUnreadStore, deliveryFor, entryInScope, entryKeyOfInterjection, noticeKey, settleClaim } from "../src/lib/voice-completions";
import { UnreadResults } from "../src/components/operator/voice-unread";
import { announceFor } from "./jarvis-command/threads";

const JOB = "3f2b1c1e-0a4d-4f6e-9b1a-1c2d3e4f5a6b";
const entry = (seq: number, state: string, text = `${state} text`, key = `${JOB}:${state}`) => ({ seq, key, state, text });
type Turn = { who: "you" | "oracle"; text: string; via?: string };

describe("one completion per task", () => {
  test("a job that succeeded is one completion whichever way the state is spelled; failures and stops stay their own outcomes", () => {
    expect(completionIdentity(viaFor(`${JOB}:succeeded`))).toBe(completionIdentity(viaFor(`${JOB}:completed`)));
    expect(completionIdentity(viaFor(`${JOB}:failed`))).not.toBe(completionIdentity(viaFor(`${JOB}:succeeded`)));
    expect(completionIdentity(viaFor(`${JOB}:step:2`))).toBeNull();
    expect(completionIdentity("deepseek")).toBeNull();
  });

  test("the typed transcript shows it once even when succeeded and completed both arrive, live or from a catch-up", () => {
    const at = "2026-10-03T00:00:00.000Z";
    const data = (state: string) => ({ seq: 1, key: `${JOB}:${state}`, at, jobId: JOB, state, text: "Finished: x." });
    const once = foldEntry<Turn>([], data("succeeded"));
    expect(once.applied).toBe(true);
    expect(foldEntry(once.turns, data("completed")).applied).toBe(false);
    const server = [{ role: "oracle", text: "Finished: x.", via: viaFor(`${JOB}:succeeded`) }, { role: "oracle", text: "Finished: x.", via: viaFor(`${JOB}:completed`) }];
    expect(foldMissing<Turn>([], server)).toHaveLength(1);
    // a failure that is later resumed and succeeds really is two outcomes
    expect(foldMissing<Turn>([], [{ text: "Failed", via: viaFor(`${JOB}:failed`) }, { text: "Finished", via: viaFor(`${JOB}:succeeded`) }])).toHaveLength(2);
  });

  test("the spoken line key maps back to the very entry it announces, so a spoken result settles its own unread record", () => {
    const e = { seq: 1, key: `${JOB}:succeeded`, jobId: JOB, state: "succeeded", text: "t", speak: "x is finished.", at: "", afterMessages: 0 } as never;
    const announce = announceFor(e)!;
    expect(entryKeyOfInterjection(announce.key)).toBe(`${JOB}:succeeded`);
    expect(entryKeyOfInterjection("something-else")).toBeNull();
    expect(noticeKey({ key: `${JOB}:completed` })).toBe(noticeKey({ key: `${JOB}:succeeded` }));
  });
});

describe("speak only when a session can say it; otherwise unread", () => {
  test("delivery matrix", () => {
    const live = { active: true, canAnnounce: true };
    expect(deliveryFor({ state: "started" }, live)).toBe("show");
    expect(deliveryFor({ state: "progress" }, live)).toBe("show");
    expect(deliveryFor({ state: "report" }, live)).toBe("show");
    expect(deliveryFor({ state: "succeeded" }, live)).toBe("speak");
    expect(deliveryFor({ state: "failed" }, live)).toBe("speak");
    expect(deliveryFor({ state: "awaiting-approval" }, live)).toBe("speak");
    expect(deliveryFor({ state: "succeeded" }, { active: false, canAnnounce: true })).toBe("unread"); // an ended session received nothing
    expect(deliveryFor({ state: "succeeded" }, { active: true, canAnnounce: false })).toBe("unread"); // an engine that cannot announce
  });

  test("unread results are kept once, survive a reload, shrink when read, and a failing store never breaks them", () => {
    const backing = new Map<string, string>();
    const storage = { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => void backing.set(k, v) };
    const a = createUnreadStore(storage);
    expect(a.add({ key: `${JOB}:succeeded`, text: "Finished: x." }, 1)).toBe(true);
    expect(a.add({ key: `${JOB}:completed`, text: "Finished: x." }, 2)).toBe(false);
    expect(createUnreadStore(storage).count()).toBe(1); // a reload
    a.markRead({ key: `${JOB}:completed` });
    expect(a.count()).toBe(0);
    expect(createUnreadStore(storage).count()).toBe(0);
    const broken = createUnreadStore({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(broken.add({ key: "k", text: "t" })).toBe(true);
    expect(broken.count()).toBe(1);
    const many = createUnreadStore(null);
    for (let i = 0; i < 80; i++) many.add({ key: `j${i}:failed`, text: "t" });
    expect(many.count()).toBe(50);
  });

  test("a claim the client could not announce is kept unread, not lost; one it announced is read", () => {
    const store = createUnreadStore(null);
    expect(settleClaim(store, { key: `${JOB}:succeeded`, text: "done" }, false)).toBe("unread");
    expect(store.count()).toBe(1);
    expect(settleClaim(store, { key: `${JOB}:succeeded`, text: "done" }, true)).toBe("spoken");
    expect(store.count()).toBe(0);
  });
});

describe("the voice session thread feed", () => {
  const make = (over: { active?: boolean; announce?: boolean; panel?: boolean } = {}) => {
    const lines: string[] = [];
    const unread = createUnreadStore(null);
    const state = { active: over.active ?? false, canAnnounce: over.announce ?? false, panel: over.panel ?? false };
    const feed = createThreadFeed({ readiness: () => state, panelSeen: () => state.panel, unread, show: (t) => lines.push(t) });
    return { feed, lines, unread, state };
  };

  test("history is quiet; progress and acknowledgements stay out of the voice log; a result and a job end appear once", () => {
    const { feed, lines, unread } = make();
    expect(feed.deliver(entry(1, "succeeded", "old finish", "old:succeeded"), true)).toBe("quiet");
    expect(feed.deliver(entry(1, "succeeded", "old finish", "old:succeeded"))).toBe("duplicate"); // never resurfaces later
    expect(feed.deliver(entry(2, "started"))).toBe("skipped");
    expect(feed.deliver(entry(3, "progress", "step 1", `${JOB}:step:1`))).toBe("skipped");
    expect(feed.deliver(entry(4, "report", "Result: x", `${JOB}:report:1`))).toBe("shown");
    expect(feed.deliver(entry(5, "succeeded", "Finished: x."))).toBe("shown");
    expect(lines).toEqual(["Result: x", "Finished: x."]);
    expect(unread.count()).toBe(1); // the end, not the report
    expect(feed.seq()).toBe(5);
  });

  test("a replay, a reconnect catch-up and a second spelling add nothing", () => {
    const { feed, lines } = make({ active: true, announce: true });
    feed.deliver(entry(5, "succeeded", "Finished: x."));
    for (let i = 0; i < 3; i++) feed.deliver(entry(5, "succeeded", "Finished: x."));
    feed.deliver(entry(6, "completed", "Finished: x.", `${JOB}:completed`));
    expect(lines).toEqual(["Finished: x."]);
  });

  test("with no session the result is unread; seen in the open panel it is not owed; a live announcing session leaves it unread until the claim is spoken", () => {
    const off = make();
    off.feed.deliver(entry(1, "failed", "Failed: x."));
    expect(off.unread.count()).toBe(1);
    const open = make({ panel: true });
    open.feed.deliver(entry(1, "failed", "Failed: x."));
    expect(open.unread.count()).toBe(0);
    const live = make({ active: true, announce: true, panel: true });
    live.feed.deliver(entry(1, "succeeded", "Finished: x."));
    expect(live.unread.count()).toBe(1);
    settleClaim(live.unread, { key: `${JOB}:succeeded`, text: "Finished: x." }, true);
    expect(live.unread.count()).toBe(0);
  });

  test("only the session own thread is taken", () => {
    expect(entryInScope("c-1", "c-1")).toBe(true);
    expect(entryInScope("c-2", "c-1")).toBe(false);
    expect(entryInScope("c-1", null)).toBe(false);
  });
});

describe("through the real activity stream", () => {
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
  const frame = (n: number, state: string, text: string) => {
    const event: ActivityEvent = { id: n, at: 1, topic: "thread", type: "entry", final: false, data: { conversationId: "c-1", eventId: `c-1:${JOB}:${state}`, entry: { seq: n, key: `${JOB}:${state}`, at: "2026-10-03T00:00:00.000Z", jobId: JOB, state, text } } };
    return { data: JSON.stringify(event), lastEventId: `abc:${n}` };
  };

  test("the same completion delivered live, replayed and under the other spelling reaches the voice log once and sends nothing", () => {
    const requests: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => (requests.push(String(input)), Promise.reject(new Error("a thread event must not send anything")))) as never;
    try {
      const sources: FakeSource[] = [];
      const client = new ActivityClient({ createSource: (url) => { const s = new FakeSource(url); sources.push(s); return s; }, setTimer: () => 0, clearTimer: () => undefined });
      const lines: string[] = [];
      const unread = createUnreadStore(null);
      const feed = createThreadFeed({ readiness: () => ({ active: false, canAnnounce: false }), panelSeen: () => false, unread, show: (t) => lines.push(t) });
      client.onMessage((m: ActivityMessage) => {
        if (m.kind !== "event") return;
        const ev = parseThreadEvent(m.event);
        if (ev && entryInScope(ev.conversationId, "c-1")) feed.deliver(ev.entry);
      });
      client.start();
      sources[0].fire("open");
      sources[0].fire("hello", { data: JSON.stringify({ mode: "snapshot" }) });
      sources[0].fire("message", frame(1, "succeeded", "Finished: x."));
      sources[0].fire("message", frame(1, "succeeded", "Finished: x.")); // replay on the same connection
      sources[0].fire("message", frame(2, "completed", "Finished: x.")); // the other spelling
      expect(lines).toEqual(["Finished: x."]);
      expect(unread.count()).toBe(1);
      expect(requests).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("rendered unread results", () => {
  test("shows the count and the latest lines, says nothing when there are none, and clearing is the person's own action", async () => {
    const { window } = parseHTML("<html><body><main></main></body></html>");
    (globalThis as any).window = window;
    (globalThis as any).document = window.document;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(window.document.querySelector("main")!);
    let cleared = 0;
    const results = [{ key: "a:failed", text: "Failed: build site.", at: 1 }, { key: "b:succeeded", text: "Finished: research.", at: 2 }];
    await act(async () => root.render(React.createElement(UnreadResults, { results, onClear: () => void cleared++ })));
    const main = window.document.querySelector("main")!;
    expect(main.textContent).toContain("2 unread results");
    expect(main.textContent).toContain("Finished: research.");
    expect(main.querySelector("[aria-label='Unread results']")).not.toBeNull();
    await act(async () => (main.querySelector("button") as HTMLButtonElement).click());
    expect(cleared).toBe(1);
    await act(async () => root.render(React.createElement(UnreadResults, { results: [], onClear: () => undefined })));
    expect(main.textContent).toBe("");
  });
});
