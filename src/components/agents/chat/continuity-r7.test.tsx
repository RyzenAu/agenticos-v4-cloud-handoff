// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ThreadReadError, type AgentChatApi, type BotSendInput, type BotSendResult } from "@/lib/agent-chat";
import { BotChat } from "./bot-chat";
import { useBotChat, type Notification, type UseBotChat } from "./use-bot-chat";
import { createFakeBotHub, seedDemoThread, JOB_A, JOB_B, JOB_C, JOB_D, type FakeHub } from "./__fixtures__/fake-bot-hub";

// Round 7, worker B: the conversation is dependable. Every test here names a boundary that used to show "unavailable" (or worse, a wrong or doubled
// line) and fails without the fix beside it.

let root: Root | undefined;
const restore: Array<() => void> = [];
function setGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restore.push(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  while (restore.length) restore.pop()!();
});
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const flush = () => wait(0);
/** Wait (in small steps, so a busy machine does not make a timing test flaky) until the condition holds. */
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(10);
};

function dom() {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = new Map<string, string>();
  setGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  return { window, container: window.document.querySelector("main")! };
}

/** The hook alone, its state in a ref the test reads. */
async function probe(api: AgentChatApi, hub: FakeHub, o: { conversationId?: string; botId?: string; onNotify?: (n: Notification) => void; retryDelaysMs?: number[]; streamHealthy?: () => boolean; watchStream?: (l: () => void) => () => void; streamDownAfterMs?: number; subscribe?: FakeHub["subscribe"] } = {}) {
  const { container } = dom();
  const out: { current: UseBotChat | null } = { current: null };
  function Probe(props: { botId: string; conversationId: string }) {
    out.current = useBotChat({ botId: props.botId, conversationId: props.conversationId, api, subscribe: o.subscribe ?? hub.subscribe, retryDelaysMs: o.retryDelaysMs ?? [15, 15], pollMs: 100000, ...(o.onNotify ? { onNotify: o.onNotify } : {}), streamHealthy: o.streamHealthy ?? (() => true), ...(o.watchStream ? { watchStream: o.watchStream } : {}), ...(o.streamDownAfterMs !== undefined ? { streamDownAfterMs: o.streamDownAfterMs } : {}) });
    return null;
  }
  root = createRoot(container);
  const render = (botId = o.botId ?? hub.botId, conversationId = o.conversationId ?? hub.conversationId) => act(async () => root!.render(<Probe botId={botId} conversationId={conversationId} />));
  await render();
  return { out, render };
}

const withFetch = (hub: FakeHub, impl: (after: number, n: number) => Promise<ReturnType<AgentChatApi["fetchThread"]> extends Promise<infer T> ? T : never>): { api: AgentChatApi; calls: () => number } => {
  let n = 0;
  return { api: { ...hub.api, fetchThread: (_id, after) => impl(after, ++n) }, calls: () => n };
};

describe("the thread read fails: the page says why, retries are bounded, and a recovery is clean", () => {
  test("a store/hub fault is retried on its own even while the live stream is healthy, then clears (it used to latch until a reload)", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    let failing = true;
    const { api, calls } = withFetch(hub, async (after) => {
      if (failing) throw new ThreadReadError("store", "Saved conversations could not be read. Your history was left untouched.", 503);
      return { conversationId: hub.conversationId, entries: hub.entries.filter((e) => e.seq > after) };
    });
    const { out } = await probe(api, hub, { retryDelaysMs: [15, 15, 15] });
    await flush();
    expect(out.current!.issue).toMatchObject({ kind: "store", retryable: true, gaveUp: false });
    expect(out.current!.issue!.message).toContain("Saved conversations could not be read");
    failing = false;
    await until(() => out.current!.issue === null);
    expect(out.current!.issue).toBeNull();
    expect(out.current!.blocks.filter((b) => b.type === "run")).toHaveLength(4);
    expect(calls()).toBeLessThanOrEqual(4);
  });

  test("retries are bounded: after the automatic ones it stops and says so; Try again gets a fresh budget", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    let failing = true;
    const { api, calls } = withFetch(hub, async (after) => {
      if (failing) throw new ThreadReadError("server", "The hub hit an error reading the conversation (status 500).", 500);
      return { conversationId: hub.conversationId, entries: hub.entries.filter((e) => e.seq > after) };
    });
    const { out } = await probe(api, hub, { retryDelaysMs: [10, 10] });
    await until(() => out.current?.issue?.gaveUp === true);
    expect(calls()).toBe(3); // the first read and two retries, then nothing
    expect(out.current!.issue).toMatchObject({ kind: "server", gaveUp: true });
    await wait(80);
    expect(calls()).toBe(3);
    failing = false;
    await act(async () => { await out.current!.refresh(); });
    expect(out.current!.issue).toBeNull();
    expect(out.current!.blocks.filter((b) => b.type === "run")).toHaveLength(4);
  });

  test("an unpaired browser is never retried automatically (retrying cannot help) and says what to do", async () => {
    const hub = createFakeBotHub();
    const { api, calls } = withFetch(hub, async () => {
      throw new ThreadReadError("not-paired", "Not allowed: Conversations need a confirmed sign-in: open Agentic OS in your paired browser, or use it at the hub PC.", 403);
    });
    const { out } = await probe(api, hub, { retryDelaysMs: [10, 10, 10] });
    await wait(100);
    expect(calls()).toBe(1);
    expect(out.current!.issue).toMatchObject({ kind: "not-paired", retryable: false, gaveUp: false });
    expect(out.current!.issue!.action).toContain("Pair this browser");
  });

  test("a first read that failed does not turn history into 'new' completions when a retry succeeds (never announce history)", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    hub.finish(JOB_D); // one more done job in the history
    let failing = true;
    const { api } = withFetch(hub, async (after) => {
      if (failing) throw new ThreadReadError("timeout", "The hub did not answer in 15 seconds.");
      return { conversationId: hub.conversationId, entries: hub.entries.filter((e) => e.seq > after) };
    });
    const told: Notification[] = [];
    const { out } = await probe(api, hub, { onNotify: (n) => told.push(n), retryDelaysMs: [10] });
    await flush();
    failing = false;
    await until(() => out.current!.issue === null);
    expect(out.current!.issue).toBeNull();
    expect(out.current!.announcement).toBe("");
    expect(told).toEqual([]);
    // A genuinely new completion after that is announced, once.
    const E = "0e1b2c3d-5555-4222-8333-444455556666";
    await act(async () => {
      hub.append({ key: `${E}:started`, jobId: E, state: "started", text: `Started: New thing (job ${E.slice(0, 8)}).` });
      hub.finish(E);
    });
    await flush();
    expect(told.filter((n) => n.jobId === E)).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  test("an answer that arrives after the person switched bots is dropped, never folded into the other conversation", async () => {
    const research = createFakeBotHub({ botId: "research", conversationId: "agent:p1:research" });
    seedDemoThread(research);
    const builder = createFakeBotHub({ botId: "builder", conversationId: "agent:p1:builder", jobIds: [JOB_B] });
    builder.append({ key: `${JOB_B}:started`, jobId: JOB_B, state: "started", text: `Started: Build the page (job ${JOB_B.slice(0, 8)}).` }, { live: false });
    let release: (() => void) | null = null;
    const slow = new Promise<void>((r) => (release = r));
    const api: AgentChatApi = {
      ...research.api,
      fetchThread: async (id, after) => {
        if (id === "research") {
          await slow;
          return { conversationId: research.conversationId, entries: research.entries.filter((e) => e.seq > after) };
        }
        return { conversationId: builder.conversationId, entries: builder.entries.filter((e) => e.seq > after) };
      },
    };
    const { out, render } = await probe(api, research);
    await render("builder", "agent:p1:builder"); // switched while research's read is still in flight
    await flush();
    expect(out.current!.blocks.filter((b) => b.type === "run").map((b) => (b as any).jobId)).toEqual([JOB_B]);
    await act(async () => release!());
    await wait(20);
    expect(out.current!.blocks.filter((b) => b.type === "run").map((b) => (b as any).jobId)).toEqual([JOB_B]);
  });

  test("a flapping stream (many snapshots) is one re-read plus one trailing read, not a read per snapshot", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const { api, calls } = withFetch(hub, async (after) => ({ conversationId: hub.conversationId, entries: hub.entries.filter((e) => e.seq > after) }));
    await probe(api, hub);
    await flush();
    const afterLoad = calls();
    for (let i = 0; i < 12; i++) await act(async () => hub.restart());
    await flush();
    expect(calls() - afterLoad).toBe(1); // the first snapshot reads at once; the rest wait for the trailing read
  });

  test("the hub naming some other conversation than the one adopted is an error, not folded in", async () => {
    const hub = createFakeBotHub();
    const mine = "11111111-1111-4111-8111-111111111111";
    let id = mine;
    const { api } = withFetch(hub, async () => ({ conversationId: id, entries: [{ seq: 1, key: `${JOB_A}:started`, at: new Date().toISOString(), jobId: JOB_A, state: "started", text: "Started: x (job 0a1b2c3d)." }] }));
    const { out } = await probe(api, hub);
    await flush();
    expect(out.current!.issue).toBeNull();
    id = "22222222-2222-4222-8222-222222222222";
    await act(async () => { await out.current!.refresh(); });
    expect(out.current!.issue).toMatchObject({ kind: "shape" });
    expect(out.current!.blocks.filter((b) => b.type === "run")).toHaveLength(1);
  });

  test("the stream being down for a while is said (not at the first blip), and clears when it is back", async () => {
    const hub = createFakeBotHub();
    let up = true;
    const listeners = new Set<() => void>();
    const { api } = withFetch(hub, async (after) => ({ conversationId: hub.conversationId, entries: hub.entries.filter((e) => e.seq > after) }));
    const { out } = await probe(api, hub, { streamHealthy: () => up, watchStream: (l) => (listeners.add(l), () => void listeners.delete(l)), streamDownAfterMs: 30 });
    await flush();
    expect(out.current!.streamDown).toBe(false);
    up = false;
    await act(async () => listeners.forEach((l) => l()));
    expect(out.current!.streamDown).toBe(false);
    await wait(60);
    expect(out.current!.streamDown).toBe(true);
    up = true;
    await act(async () => listeners.forEach((l) => l()));
    expect(out.current!.streamDown).toBe(false);
  });
});

describe("a read that needs older entries is not lost behind one already in flight", () => {
  test("a read from 0 (a snapshot, or Reconnect) arriving while an incremental read is in flight runs once more from 0 when it settles", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const afters: number[] = [];
    let gate: (() => void) | null = null;
    let hold = false;
    const api: AgentChatApi = {
      ...hub.api,
      fetchThread: async (_id, after) => {
        afters.push(after);
        if (hold) await new Promise<void>((r) => (gate = r));
        return { conversationId: hub.conversationId, entries: hub.entries.filter((e) => e.seq > after) };
      },
    };
    const { out } = await probe(api, hub);
    await flush();
    expect(afters).toEqual([0]);
    hold = true;
    await act(async () => { void out.current!.send("hello"); });
    await flush();
    expect(afters.length).toBe(2);
    expect(afters[1]).toBeGreaterThan(0);
    await act(async () => { void out.current!.refresh(); });
    expect(afters.length).toBe(2);
    hold = false;
    await act(async () => gate!());
    await until(() => afters.length >= 3);
    expect(afters[2]).toBe(0);
  });
});

// ---- the send path --------------------------------------------------------------------------------------------------------------------------

/** An api whose send behaves like the hub: the same event id is the same command (run once), and a send can time out after the hub accepted it. */
function hubLikeSend(hub: FakeHub) {
  const ran = new Map<string, BotSendResult>();
  const calls: BotSendInput[] = [];
  let timeoutNext = false;
  const api: AgentChatApi = {
    ...hub.api,
    async send(input) {
      calls.push(input);
      const prior = ran.get(input.eventId);
      if (prior) {
        if (timeoutNext) { timeoutNext = false; throw new Error("timed out"); }
        return prior; // the hub's dedupe: the first outcome, nothing run twice
      }
      const result = await hub.api.send(input); // the hub accepts and runs it (and writes the request and acknowledgement)
      ran.set(input.eventId, result);
      if (timeoutNext) {
        timeoutNext = false;
        return { ok: false, said: "Not done: I couldn't reach the command service (timed out). It may have arrived; check before sending it again.", jobId: null, unconfirmed: true };
      }
      return result;
    },
  };
  return { api, calls, ran, timeoutNext: () => void (timeoutNext = true) };
}

async function mountChat(hub: FakeHub, api: AgentChatApi, props: Partial<React.ComponentProps<typeof BotChat>> = {}) {
  const { window, container } = dom();
  root = createRoot(container);
  await act(async () => root!.render(<BotChat bot={{ id: hub.botId, name: "Research", computer: "research" }} conversationId={hub.conversationId} api={api} subscribe={hub.subscribe} {...props} />));
  await flush();
  const submit = async () => {
    await act(async () => container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await flush();
  };
  const click = async (label: RegExp) => {
    const b = [...container.querySelectorAll("button")].find((x) => label.test(x.textContent ?? ""));
    expect(b).toBeTruthy();
    await act(async () => b!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })));
    await flush();
  };
  return { window, container, submit, click, text: () => container.textContent ?? "", has: (label: RegExp) => [...container.querySelectorAll("button")].some((x) => label.test(x.textContent ?? "")), count: (sel: string) => container.querySelectorAll(sel).length };
}

describe("a send whose answer never came back is never replayed as a new command", () => {
  test("the post times out but the hub accepted it: one job, one request line, one acknowledgement; no failure line, no Send again", async () => {
    const hub = createFakeBotHub({ serverLines: true });
    const h = hubLikeSend(hub);
    h.timeoutNext();
    const ui = await mountChat(hub, h.api, { initialDraft: "Find dentists" });
    await ui.submit();
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(hub.entries.filter((e) => e.state === "started")).toHaveLength(1);
    expect(ui.count('[data-entry="request"]')).toBe(1);
    expect(ui.count('[data-entry="ack"]')).toBe(1);
    expect(ui.text()).toContain("On it. I will keep working");
    expect(ui.text()).not.toContain("couldn't reach the command service");
    expect(ui.has(/Send again/)).toBe(false);
  });

  test("the hub never got it: Send again reuses the SAME event id (the hub dedupes) and the line settles", async () => {
    const hub = createFakeBotHub({ serverLines: false });
    const h = hubLikeSend(hub);
    let reached = false;
    const api: AgentChatApi = { ...h.api, send: async (i) => { if (!reached) { h.calls.push(i); reached = true; return { ok: false, said: "Not done: I couldn't reach the command service (offline). It may have arrived; check before sending it again.", jobId: null, unconfirmed: true }; } return h.api.send(i); } };
    const ui = await mountChat(hub, api, { initialDraft: "Find dentists" });
    await ui.submit();
    expect(ui.has(/Check now/)).toBe(true);
    expect(ui.text()).toContain("Sending again sends the same request");
    expect(ui.text()).not.toContain("will not run twice"); // a device request typed in a bot chat only has the in-memory window: the copy must not promise more
    await ui.click(/Send again/);
    const ids = h.calls.map((c) => c.eventId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(hub.entries.filter((e) => e.state === "started")).toHaveLength(1);
    expect(ui.has(/Send again/)).toBe(false);
    expect(ui.count('[data-entry="request"]')).toBe(1);
    expect(ui.count('[data-entry="ack"]')).toBe(1);
  });

  test("the send itself throws: 'could not confirm', never 'did not send'", async () => {
    const hub = createFakeBotHub({ serverLines: false });
    const api: AgentChatApi = { ...hub.api, send: async () => { throw new Error("offline"); } };
    const ui = await mountChat(hub, api, { initialDraft: "Do the thing" });
    await ui.submit();
    expect(ui.text()).toContain("couldn't confirm that it sent");
    expect(ui.text()).not.toContain("did not send");
    expect(ui.has(/Check now/)).toBe(true);
  });

  test("a refusal the hub made is definite: Send again is a NEW command (a different event id) and there is no 'Check now'", async () => {
    const hub = createFakeBotHub({ serverLines: false, refuse: "Research has no computer yet. Nothing ran anywhere else." });
    const h = hubLikeSend(hub);
    const ui = await mountChat(hub, h.api, { initialDraft: "Find dentists" });
    await ui.submit();
    expect(ui.has(/Check now/)).toBe(false);
    await ui.click(/Send again/);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].eventId).not.toBe(h.calls[0].eventId);
  });

  test("pressing Send again twice while the first is still in flight sends once", async () => {
    const hub = createFakeBotHub({ serverLines: false });
    const calls: BotSendInput[] = [];
    let first = true;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const api: AgentChatApi = {
      ...hub.api,
      send: async (i) => {
        calls.push(i);
        if (first) { first = false; return { ok: false, said: "Not done: unreachable.", jobId: null, unconfirmed: true }; }
        await gate;
        return { ok: true, said: "On it.", jobId: JOB_A };
      },
    };
    const ui = await mountChat(hub, api, { initialDraft: "Find dentists" });
    await ui.submit();
    const btn = [...ui.container.querySelectorAll("button")].find((x) => /Send again/.test(x.textContent ?? ""))!;
    await act(async () => { btn.dispatchEvent(new ui.window.Event("click", { bubbles: true, cancelable: true })); btn.dispatchEvent(new ui.window.Event("click", { bubbles: true, cancelable: true })); });
    await act(async () => release!());
    await flush();
    expect(calls).toHaveLength(2);
  });
});

describe("the conversation notice names the cause and offers only what can help", () => {
  const failing = (hub: FakeHub, error: ThreadReadError): AgentChatApi => ({ ...hub.api, fetchThread: async () => { throw error; } });

  test("an unpaired browser: the hub's sentence, how to pair, no Try again, no 'Ask for something' empty state", async () => {
    const hub = createFakeBotHub();
    const ui = await mountChat(hub, failing(hub, new ThreadReadError("not-paired", "Not allowed: Conversations need a confirmed sign-in: open Agentic OS in your paired browser, or use it at the hub PC.", 403)));
    const notice = ui.container.querySelector('[data-testid="read-issue"]')!;
    expect(notice.getAttribute("data-kind")).toBe("not-paired");
    expect(notice.textContent).toContain("Conversations need a confirmed sign-in");
    expect(notice.textContent).toContain("Pair this browser");
    expect(notice.textContent).not.toContain("Not allowed:");
    expect(ui.has(/Try again/)).toBe(false);
    expect(ui.text()).not.toContain("Ask Research for something");
  });

  test("an offline bot does not hide an unreadable conversation: both causes are on the page (the read notice used to be suppressed while offline)", async () => {
    const hub = createFakeBotHub();
    const ui = await mountChat(hub, failing(hub, new ThreadReadError("store", "Saved conversations could not be read. Your history was left untouched.", 503)), { status: { state: "offline" } });
    expect(ui.text()).toContain("Research is offline");
    const notice = ui.container.querySelector('[data-testid="read-issue"]');
    expect(notice).toBeTruthy();
    expect(notice!.textContent).toContain("Saved conversations could not be read");
  });

  test("the hub's own verdict settles an unconfirmed line: a reply with ok:false stays a failure with Send again (it used to turn into a success)", async () => {
    const hub = createFakeBotHub();
    const api: AgentChatApi = {
      ...hub.api,
      async send(input) {
        hub.append({ key: `${input.eventId}:request`, jobId: "", state: "request", text: input.utterance });
        hub.append({ key: `${input.eventId}:ack`, jobId: "", state: "ack", text: "Research has no computer yet. Nothing ran.", ok: false });
        return { ok: false, said: "Not done: unreachable.", jobId: null, unconfirmed: true };
      },
    };
    const ui = await mountChat(hub, api, { initialDraft: "Find dentists" });
    await ui.submit();
    await flush();
    expect(ui.text()).toContain("Research has no computer yet. Nothing ran.");
    expect(ui.container.querySelector('[data-entry="ack"]')!.getAttribute("data-ok")).toBe("false");
    expect(ui.has(/Send again/)).toBe(true);
    expect(ui.has(/Check now/)).toBe(false); // the hub answered: it is no longer unconfirmed
  });

  test("a hub reply marked unverified is an unconfirmed line: Send again reuses the SAME event id (it used to read as a plain failure and mint a new one)", async () => {
    const hub = createFakeBotHub();
    const ids: string[] = [];
    const api: AgentChatApi = {
      ...hub.api,
      async send(input) {
        ids.push(input.eventId);
        if (ids.length === 1) {
          hub.append({ key: `${input.eventId}:request`, jobId: "", state: "request", text: input.utterance });
          hub.append({ key: `${input.eventId}:ack`, jobId: "", state: "ack", text: "That hit a fault after a job for this bot started, and it may or may not be this one. It will not be run again.", ok: false, unverified: true });
        }
        return { ok: false, said: "Not done: unreachable.", jobId: null, unconfirmed: true };
      },
    };
    const ui = await mountChat(hub, api, { initialDraft: "Find dentists" });
    await ui.submit();
    await flush();
    expect(ui.container.querySelector('[data-entry="ack"]')!.textContent).toContain("may or may not be this one");
    expect(ui.has(/Check now/)).toBe(true);
    await ui.click(/Send again/);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  test("an older reply without a verdict still settles to what this device knew", async () => {
    const hub = createFakeBotHub({ serverLines: true });
    const h = hubLikeSend(hub);
    h.timeoutNext();
    const ui = await mountChat(hub, h.api, { initialDraft: "Find dentists" });
    await ui.submit();
    expect(ui.container.querySelector('[data-entry="ack"]')!.getAttribute("data-ok")).toBe("true");
  });

  test("the hub's store is unreadable: its own sentence, what to do, and Try again recovers the page", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    let broken = true;
    const api: AgentChatApi = { ...hub.api, fetchThread: async (id, after) => { if (broken) throw new ThreadReadError("store", "Saved conversations could not be read. Your history was left untouched.", 503); return hub.api.fetchThread(id, after); } };
    const ui = await mountChat(hub, api);
    const notice = ui.container.querySelector('[data-testid="read-issue"]')!;
    expect(notice.getAttribute("data-kind")).toBe("store");
    expect(notice.textContent).toContain("Saved conversations could not be read");
    expect(notice.textContent).toContain("restart the hub");
    expect(ui.has(/Try again/)).toBe(true);
    broken = false;
    await ui.click(/Try again/);
    expect(ui.container.querySelector('[data-testid="read-issue"]')).toBeNull();
    expect(ui.text()).toContain("Find dentists near Parramatta");
  });
});
