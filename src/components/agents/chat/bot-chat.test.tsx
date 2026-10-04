// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { applyEntries, emptyChat, toBlocks, type Run } from "./chat-state";
import { AckLine, RequestBubble, RunCard, defaultLinks, resultText } from "./entries";
import { BotChat, prefersReducedMotion } from "./bot-chat";
import { VoiceButton } from "./voice-button";
import { createFakeBotHub, seedDemoThread, JOB_A, JOB_B, JOB_C, JOB_D, type FakeHub } from "./__fixtures__/fake-bot-hub";
import { useBotChat, type Notification } from "./use-bot-chat";
import { agentChatApi } from "@/lib/agent-chat";
import { codingClient } from "@/lib/coding-client";
import { getVoiceScope, setVoiceScope } from "@/lib/voice-scope";

const flat = (html: string) => html.replace(/<!-- -->/g, "");

/** The runs of a seeded demo thread, as the cards render them. */
function demoRuns() {
  const hub = createFakeBotHub();
  seedDemoThread(hub);
  const state = applyEntries(emptyChat(), hub.entries).state;
  const runs = toBlocks(state).filter((b): b is Run => b.type === "run");
  return Object.fromEntries(runs.map((r) => [r.jobId, r]));
}
const card = (run: Run, o: Partial<React.ComponentProps<typeof RunCard>> = {}) => flat(renderToStaticMarkup(<RunCard run={run} links={defaultLinks("/computers")} {...o} />));

describe("entry rendering (server markup)", () => {
  const runs = demoRuns();

  test("request (typed and spoken) and the acknowledgement", () => {
    const req = { who: "you", text: "Find dentists", via: "local:k:request", type: "request", key: "k", at: 1, seq: 0, jobId: "", state: "", kind: null, jobKind: "job", source: "voice" } as const;
    const spoken = flat(renderToStaticMarkup(<RequestBubble item={req} />));
    expect(spoken).toContain("Find dentists");
    expect(spoken).toContain("Spoken");
    expect(flat(renderToStaticMarkup(<RequestBubble item={{ ...req, source: "typed", pending: true }} />))).toContain("Sending");
    const ack = { ...req, who: "oracle", type: "ack", via: "local:k:ack", ok: false } as const;
    expect(flat(renderToStaticMarkup(<AckLine item={{ ...ack, text: "On it." }} onRetry={() => {}} />))).toContain("Send again");
    expect(flat(renderToStaticMarkup(<AckLine item={{ ...ack, ok: true, text: "On it." }} onRetry={() => {}} />))).not.toContain("Send again");
  });

  test("progress: the current step is one line, the steps are folded in a collapsed disclosure, and Stop is offered", () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    hub.step(JOB_D, 2, "Reading the second pricing page.");
    const run = toBlocks(applyEntries(emptyChat(), hub.entries).state).find((b): b is Run => b.type === "run" && b.jobId === JOB_D)!;
    const html = card(run, { onStop: () => {} });
    expect(html).toContain("Compare three competitor pricing pages");
    expect(html).toContain("Reading the second pricing page.");
    expect(html).toContain("Working");
    expect(html).toContain("1 earlier step");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("inert");
    expect(html).toContain("Stop");
    expect(html).not.toContain("Open result");
  });

  test("a refused start's blocker on the acknowledgement line offers the same recovery (Take over, Check again)", () => {
    const ack = { who: "oracle", text: "Research's computer is busy.", via: "local:k:ack", type: "ack", key: "k", at: 1, seq: 2, jobId: "", state: "ack", kind: null, jobKind: "job", ok: false } as const;
    const busy = flat(renderToStaticMarkup(<AckLine item={{ ...ack, blocker: { kind: "needs-takeover", recovery: "Return control from its Computer tab." } }} links={defaultLinks("/computers")} />));
    expect(busy).toContain("Needs you at the computer");
    expect(busy).toContain("Return control from its Computer tab.");
    expect(busy).toContain("Take over");
    expect(busy).toContain('href="/computers"');
    const offline = flat(renderToStaticMarkup(<AckLine item={{ ...ack, blocker: { kind: "offline", recovery: "Start it from Computers." } }} links={defaultLinks("/computers")} onAction={() => {}} />));
    expect(offline).toContain("The computer is offline");
    expect(offline).toContain("Check again");
    expect(flat(renderToStaticMarkup(<AckLine item={ack} links={defaultLinks("/computers")} />))).not.toContain("Take over");
  });

  test("blocker: says what it needs, offers take over and the job, and links to the computer", () => {
    const html = card(runs[JOB_B]);
    expect(html).toContain("Needs you at the computer");
    expect(html).toContain("Take over, type the code, then hand back");
    expect(html).toMatch(/<a href="\/computers"[^>]*>Take over<\/a>/);
    expect(html).toContain(`href="/activity#job-${JOB_B}"`);
    expect(html).toContain("Needs you");
  });

  test("result: the summary without the machine line, Open result is the real saved artifact in a new tab, plus Open job and Show computer", () => {
    const html = card(runs[JOB_A]);
    expect(html).toContain("Five practices stand out");
    expect(html).not.toContain("Saved result:");
    expect(html).toMatch(new RegExp(`<a href="/__computers/artifacts/${JOB_A}" target="_blank" rel="noopener noreferrer"[^>]*>Open result`));
    expect(html).toContain(`href="/activity#job-${JOB_A}"`);
    expect(html).toMatch(/href="\/computers"[^>]*>[^<]*<svg[^>]*><\/svg> Show computer|Show computer/);
    expect(html).toContain("2 steps");
    expect(html.split("Five practices stand out").length - 1).toBe(1); // the result is shown once, not again as a step
    expect(html).not.toContain(">Stop<");
  });

  test("a coding job's result and job both open the coding job; it has no computer button", () => {
    const hub = createFakeBotHub();
    hub.append({ key: `${JOB_C}:started`, jobId: JOB_C, state: "started", text: `Started: Fix the footer (job ${JOB_C.slice(0, 8)}).`, jobKind: "coding" }, { live: false });
    hub.append({ key: `${JOB_C}:succeeded`, jobId: JOB_C, state: "succeeded", text: "Footer fixed and tested.", jobKind: "coding" }, { live: false });
    const run = toBlocks(applyEntries(emptyChat(), hub.entries).state).find((b): b is Run => b.type === "run")!;
    const html = card(run);
    expect(html).toContain(`href="/coding/${JOB_C}"`);
    expect(html).toContain("Open result");
    expect(html).not.toContain("Show computer");
  });

  test("failed: honest reason, a recovery with Try again and the job; stopped: no alarm", () => {
    const failed = card(runs[JOB_C]);
    expect(failed).toContain("That did not finish");
    expect(failed).toContain("ran out of allowance");
    expect(failed).toContain("Try again");
    expect(failed).toContain(`Open job`);
    const hub = createFakeBotHub();
    hub.append({ key: `${JOB_A}:started`, jobId: JOB_A, state: "started", text: `Started: X (job ${JOB_A.slice(0, 8)}).` }, { live: false });
    hub.stopped(JOB_A);
    const stopped = toBlocks(applyEntries(emptyChat(), hub.entries).state).find((b): b is Run => b.type === "run")!;
    const html = card(stopped);
    expect(html).toContain("Stopped");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("text-danger");
  });

  test("a long result keeps a short summary and folds the rest", () => {
    const html = card({ ...runs[JOB_A], result: { ...runs[JOB_A].result!, text: `${"Word ".repeat(120)}\nSaved result: A\n(job 0a1b2c3d)` } });
    expect(html).toContain("Full result");
    expect(html).toContain("…");
  });

  test("resultText drops only the trailing machine line", () => {
    expect(resultText("Hello\nSaved result: A\n(job 0a1b2c3d)")).toBe("Hello");
    expect(resultText("Saved result: is also a phrase in the middle\nof text")).toContain("Saved result");
  });

  test("a card that arrived live eases in with transform only and the reduced-motion opt-out; history never animates", () => {
    expect(card(runs[JOB_A], { fresh: true })).toMatch(/mo-enter motion-reduce:animate-none/);
    expect(card(runs[JOB_A])).not.toContain("mo-enter");
  });

  test("the shell can point the buttons at its own routes", () => {
    const html = flat(renderToStaticMarkup(<RunCard run={runs[JOB_A]} links={{ ...defaultLinks(), result: (id) => `/agents/research?tab=files&job=${id}`, job: (id) => `/agents/research?tab=tasks&job=${id}`, computer: () => "/agents/research?tab=computer" }} />));
    expect(html).toContain(`href="/agents/research?tab=files&amp;job=${JOB_A}"`);
    expect(html).toContain('href="/agents/research?tab=computer"');
  });
});

describe("reduced motion", () => {
  const original = (globalThis as any).window;
  afterEach(() => void ((globalThis as any).window = original));
  test("prefersReducedMotion follows the media query, and is false without a window or matchMedia", () => {
    (globalThis as any).window = { matchMedia: (q: string) => ({ matches: q.includes("reduce") }) };
    expect(prefersReducedMotion()).toBe(true);
    (globalThis as any).window = { matchMedia: () => ({ matches: false }) };
    expect(prefersReducedMotion()).toBe(false);
    (globalThis as any).window = {};
    expect(prefersReducedMotion()).toBe(false);
  });
});

// ---- the live component against the fake hub --------------------------------------------------------------------------------------------

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
  setVoiceScope(null);
  while (restore.length) restore.pop()!();
});

async function mount(hub: FakeHub, props: Partial<React.ComponentProps<typeof BotChat>> = {}) {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = window.document.querySelector("main")!;
  const render = async () => {
    root = createRoot(container);
    await act(async () => root!.render(<BotChat bot={{ id: hub.botId, name: "Research", computer: "research" }} conversationId={hub.conversationId} api={hub.api} subscribe={hub.subscribe} {...props} />));
  };
  await render();
  return {
    window,
    container,
    text: () => container.textContent ?? "",
    html: () => container.innerHTML,
    runCount: (jobId: string) => container.querySelectorAll(`[data-entry="run"][data-job="${jobId}"]`).length,
    unmount: async () => {
      await act(async () => root!.unmount());
      root = undefined;
    },
    remount: render,
    act,
  };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("BotChat against the fake hub", () => {
  test("loads the thread: one card per job, history does not animate", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const ui = await mount(hub);
    await flush();
    for (const id of [JOB_A, JOB_B, JOB_C, JOB_D]) expect(ui.runCount(id)).toBe(1);
    expect(ui.text()).toContain("Find dentists near Parramatta");
    expect(ui.html()).not.toContain("mo-enter");
    expect(hub.fetches[0]).toEqual({ botId: "research", after: 0 });
  });

  test("a live entry appears once; the same event again (replay, second tab) and an overlapping catch-up add nothing", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const ui = await mount(hub);
    await flush();
    const e = hub.step(JOB_D, 2, "Reading the second pricing page.");
    await flush();
    expect(ui.text().split("Reading the second pricing page.").length - 1).toBe(1);
    await act(async () => hub.emit(hub.entryEvent(e)));
    await act(async () => hub.emit(hub.entryEvent(e)));
    await flush();
    expect(ui.runCount(JOB_D)).toBe(1);
    expect(ui.container.querySelectorAll('[data-job="' + JOB_D + '"] ol li')).toHaveLength(1); // the earlier step; the newest is the line above
    // another conversation's entry is ignored
    const other = hub.entryEvent({ ...e, key: `${JOB_D}:step:9`, seq: 99, text: "Someone else's line" });
    (other as any).event.data.conversationId = "agent:p2:research";
    await act(async () => hub.emit(other));
    expect(ui.text()).not.toContain("Someone else");
  });

  test("a hub restart (a fresh snapshot) re-reads the thread from the start: entries missed while away appear, nothing doubles", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const ui = await mount(hub);
    await flush();
    hub.step(JOB_D, 2, "Appended while the hub was restarting.", { live: false });
    hub.result(JOB_D, "Competitor summary ready.", false);
    expect(ui.text()).not.toContain("Appended while");
    await act(async () => hub.restart());
    await flush();
    expect(hub.fetches.at(-1)).toEqual({ botId: "research", after: 0 });
    expect(ui.text()).toContain("Competitor summary ready.");
    expect(ui.runCount(JOB_D)).toBe(1);
    for (const id of [JOB_A, JOB_B, JOB_C]) expect(ui.runCount(id)).toBe(1);
    // and again: still no duplicates
    await act(async () => hub.restart());
    await flush();
    expect(ui.runCount(JOB_D)).toBe(1);
    expect(ui.container.querySelectorAll('[data-job="' + JOB_D + '"] ol li')).toHaveLength(2); // both steps; the result is not a step
  });

  test("leaving and returning shows the same thread, including the person's own lines, with nothing doubled or replayed", async () => {
    const hub = createFakeBotHub();
    const notes: Notification[] = [];
    const store = new Map<string, string>();
    setGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const ui = await mount(hub, { onNotify: (n) => notes.push(n), initialDraft: "Find dentists near Parramatta" });
    await flush();
    await act(async () => ui.container.querySelector("form")!.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    hub.result(JOB_A, "Five practices stand out.");
    await flush();
    expect(notes.map((n) => n.kind)).toEqual(["done"]);
    const before = ui.container.querySelector('[role="log"]')!.textContent;
    await ui.unmount();
    expect(hub.subscribers()).toBe(0);
    await ui.remount();
    await flush();
    expect(ui.container.querySelector('[role="log"]')!.textContent).toBe(before);
    expect(ui.runCount(JOB_A)).toBe(1);
    // the request line and the card title, once each (the draft box keeps its own text)
    expect(ui.container.querySelector('[role="log"]')!.textContent!.split("Find dentists near Parramatta").length - 1).toBe(2);
    expect(ui.html()).not.toContain("mo-enter");
    // a replay of the completion after the return is not announced again
    await act(async () => hub.emit(hub.entryEvent(hub.entries.find((e) => e.key.endsWith("report:1"))!)));
    await act(async () => hub.restart());
    await flush();
    expect(notes).toHaveLength(1);
  });

  test("a completion and a following 'finished' line notify once for the job; a blocker notifies as waiting", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const notes: Notification[] = [];
    const ui = await mount(hub, { onNotify: (n) => notes.push(n) });
    await flush();
    expect(notes).toHaveLength(0); // history is quiet
    hub.result(JOB_D, "Done.", false);
    hub.finish(JOB_D);
    await flush();
    expect(notes.map((n) => [n.jobId, n.kind])).toEqual([[JOB_D, "done"]]);
    expect(ui.container.querySelector('[role="status"][aria-live="polite"]')!.textContent).toContain("A task is done.");
  });

  test("sending carries the bot's conversation id and target; sending while a job runs is allowed and each send is its own command", async () => {
    const hub = createFakeBotHub();
    let send!: (text: string, source?: "typed" | "voice") => Promise<void>;
    let blocks = 0;
    function Probe() {
      const chat = useBotChat({ botId: hub.botId, conversationId: hub.conversationId, api: hub.api, subscribe: hub.subscribe });
      send = chat.send;
      blocks = chat.blocks.length;
      return <p>{chat.blocks.map((b) => b.type).join(",")}</p>;
    }
    const { window } = parseHTML("<html><body><main></main></body></html>");
    setGlobal("window", window);
    setGlobal("document", window.document);
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(window.document.querySelector("main")!);
    await act(async () => root!.render(<Probe />));
    await flush();
    await act(async () => void (await send("Find dentists")));
    await flush();
    await act(async () => void (await send("Also check their opening hours"))); // the first job is still running
    await flush();
    await act(async () => void (await send("Say it", "voice")));
    await flush();
    expect(hub.sent.map((s) => [s.utterance, s.conversationId, s.botId, s.source])).toEqual([
      ["Find dentists", "agent:p1:research", "research", "typed"],
      ["Also check their opening hours", "agent:p1:research", "research", "typed"],
      ["Say it", "agent:p1:research", "research", "voice"],
    ]);
    expect(new Set(hub.sent.map((s) => s.eventId)).size).toBe(3);
    // request, ack, run for each send
    expect(blocks).toBe(9);
    expect(window.document.querySelector("p")!.textContent).toBe("request,ack,run,request,ack,run,request,ack,run");
  });

  test("Stop on a running job cancels that job through the job service", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const ui = await mount(hub);
    await flush();
    const stop = Array.from(ui.container.querySelectorAll(`[data-job="${JOB_D}"] button`)).find((b) => (b as Element).textContent?.includes("Stop"))!;
    await act(async () => stop.dispatchEvent(new ui.window.Event("click", { bubbles: true })));
    expect(hub.cancelled).toEqual([JOB_D]);
  });

  test("Stop on a coding job cancels it through the coding store (jobKind coding), and a refused stop shows its reason", async () => {
    const CODING = "0e1b2c3d-5555-4222-8333-444455556666";
    const hub = createFakeBotHub({ botId: "builder", conversationId: "agent:p1:builder" });
    hub.append({ key: `${CODING}:started`, jobId: CODING, jobKind: "coding", state: "started", text: "Started: Fix the footer (job 0e1b2c3d)." });
    hub.append({ key: `${CODING}:step:1`, jobId: CODING, jobKind: "coding", state: "progress", text: "Building." });
    hub.refuseCancel("That job already finished.");
    const ui = await mount(hub, { bot: { id: "builder", name: "Builder", computer: "builder" } });
    await flush();
    const press = async () => {
      const stop = Array.from(ui.container.querySelectorAll(`[data-job="${CODING}"] button`)).find((b) => (b as Element).textContent?.includes("Stop"))!;
      await act(async () => stop.dispatchEvent(new ui.window.Event("click", { bubbles: true })));
      await flush();
    };
    await press();
    expect(hub.cancelled).toEqual([CODING]);
    expect(hub.cancelKinds).toEqual(["coding"]);
    expect(ui.text()).toContain("Could not stop it: That job already finished.");
    hub.refuseCancel(null);
    await press();
    expect(ui.text()).not.toContain("Could not stop it");
  });

  test("the real chat api stops a coding job with codingClient.cancel and reports a refusal instead of swallowing it", async () => {
    const original = codingClient.cancel;
    const calls: string[] = [];
    try {
      (codingClient as any).cancel = async (id: string) => { calls.push(id); return {}; };
      expect(await agentChatApi.cancel("job-1", "coding")).toEqual({ ok: true });
      (codingClient as any).cancel = async () => { throw new Error("The job is not running."); };
      expect(await agentChatApi.cancel("job-2", "coding")).toEqual({ ok: false, reason: "The job is not running." });
      expect(calls).toEqual(["job-1"]);
    } finally {
      (codingClient as any).cancel = original;
    }
  });

  test("a failed read says so and keeps the transcript; Check again after a recovered read fills it in", async () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    hub.setFetchFailing(true);
    const ui = await mount(hub);
    await flush();
    expect(ui.text()).toContain("The conversation may be out of date");
    hub.setFetchFailing(false);
    await act(async () => hub.restart());
    await flush();
    expect(ui.text()).not.toContain("may be out of date");
    expect(ui.runCount(JOB_A)).toBe(1);
  });

  test("an offline bot shows why and a Reconnect action, and the box still works", async () => {
    const hub = createFakeBotHub();
    let reconnects = 0;
    const ui = await mount(hub, { status: { state: "offline", reasons: ["Ryzen-PC did not answer."] }, onReconnect: () => void reconnects++ });
    await flush();
    expect(ui.text()).toContain("Research is offline");
    expect(ui.text()).toContain("Ryzen-PC did not answer.");
    const button = Array.from(ui.container.querySelectorAll("button")).find((b) => (b as Element).textContent === "Reconnect")!;
    await act(async () => button.dispatchEvent(new ui.window.Event("click", { bubbles: true })));
    expect(reconnects).toBe(1);
    expect(ui.container.querySelector("textarea")!.hasAttribute("disabled")).toBe(false);
  });

  test("Reconnect always ends in a visible answer where it was clicked: busy while it works, then the sentence it returned", async () => {
    const hub = createFakeBotHub();
    let finish: (m: string) => void = () => {};
    const ui = await mount(hub, { status: { state: "offline" }, onReconnect: () => new Promise<string>((r) => (finish = r)) });
    await flush();
    const find = () => Array.from(ui.container.querySelectorAll("button")).find((b) => /^Reconnect/.test((b as Element).textContent ?? ""))!;
    await act(async () => find().dispatchEvent(new ui.window.Event("click", { bubbles: true })));
    expect(find().textContent).toBe("Reconnecting…");
    expect(find().hasAttribute("disabled")).toBe(true);
    await act(async () => finish("Research is already starting. It shows here when it is online."));
    expect(ui.container.querySelector('[data-testid="reconnect-result"]')!.textContent).toBe("Research is already starting. It shows here when it is online.");
    expect(find().textContent).toBe("Reconnect");
  });

  test("an empty conversation invites the first request", async () => {
    const ui = await mount(createFakeBotHub());
    await flush();
    expect(ui.text()).toContain("Ask Research for something");
  });
});

describe("the server's request and acknowledgement lines are the same lines the device showed", () => {
  const sendOne = async (ui: Awaited<ReturnType<typeof mount>>) => {
    await act(async () => ui.container.querySelector("form")!.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true })));
    await flush();
  };
  const lines = (ui: Awaited<ReturnType<typeof mount>>) => ({
    requests: ui.container.querySelectorAll('[data-entry="request"]').length,
    acks: ui.container.querySelectorAll('[data-entry="ack"]').length,
    text: ui.container.querySelector('[role="log"]')!.textContent!,
  });

  test("send gives exactly one request and one acknowledgement: after the live events, after a catch-up, and after a reload", async () => {
    const hub = createFakeBotHub({ serverLines: true });
    const store = new Map<string, string>();
    setGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const ui = await mount(hub, { initialDraft: "Summarise the results" });
    await flush();
    await sendOne(ui);
    let l = lines(ui);
    expect([l.requests, l.acks]).toEqual([1, 1]);
    expect(l.text.split("Summarise the results").length - 1).toBe(2); // the request line and the job card title
    expect(l.text.split("On it. I will keep working").length - 1).toBe(1);
    await act(async () => hub.restart()); // a full re-read
    await flush();
    l = lines(ui);
    expect([l.requests, l.acks]).toEqual([1, 1]);
    await ui.unmount();
    await ui.remount(); // a reload: the server's lines plus whatever this device kept
    await flush();
    l = lines(ui);
    expect([l.requests, l.acks]).toEqual([1, 1]);
    expect(l.text.split("Summarise the results").length - 1).toBe(2); // the request line and the job card title
  });

  test("a spoken request the server stored as 'Spoken request.' shows once, as spoken", async () => {
    const hub = createFakeBotHub({ serverLines: true });
    const ui = await mount(hub);
    await flush();
    hub.append({ key: "evt-voice-1:request", jobId: "", state: "request", text: "Spoken request." });
    hub.append({ key: "evt-voice-1:ack", jobId: "", state: "ack", text: "Starting that now." });
    await flush();
    const l = lines(ui);
    expect([l.requests, l.acks]).toEqual([1, 1]);
    expect(l.text).toContain("Spoken");
    expect(l.text.toLowerCase().split("spoken request").length - 1).toBe(0);
  });

  test("a send that never reached the server stays as a local line with its own failure, once", async () => {
    const hub = createFakeBotHub({ serverLines: false });
    hub.api.send = async () => { throw new Error("offline"); };
    const ui = await mount(hub, { initialDraft: "Do the thing" });
    await flush();
    await sendOne(ui);
    const l = lines(ui);
    expect([l.requests, l.acks]).toEqual([1, 1]);
    expect(l.text).toContain("I couldn't confirm that it sent (offline)");
  });

  test("a refusal from the backend shows once, and the offline banner does not promise queuing", async () => {
    const refuse = "Research has no computer yet. Nothing ran anywhere else.";
    const hub = createFakeBotHub({ serverLines: true, refuse });
    const ui = await mount(hub, { initialDraft: "Find dentists", status: { state: "offline" } });
    await flush();
    await sendOne(ui);
    const l = lines(ui);
    expect(l.text.split(refuse).length - 1).toBe(1);
    expect(ui.text()).toContain("Research can't start new work until its computer is back. Reconnect, or pick a computer in Setup.");
    expect(ui.text()).not.toContain("waits in the conversation");
  });
});

describe("voice button", () => {
  test("starts the voice client scoped to this bot, and clears the scope when the voice window closes or the page is left", async () => {
    const hub = createFakeBotHub();
    const started: unknown[] = [];
    const listeners = new Map<string, (e: any) => void>();
    const fakeWindow: any = { addEventListener: (t: string, l: any) => listeners.set(t, l), removeEventListener: (t: string) => listeners.delete(t) };
    const ui = await mount(hub, { startVoice: (scope) => { started.push(scope); setVoiceScope(scope); } });
    await flush();
    const button = ui.container.querySelector('button[aria-label="Talk to Research"]')!;
    expect(button).not.toBeNull();
    await act(async () => button.dispatchEvent(new ui.window.Event("click", { bubbles: true })));
    expect(started).toEqual([{ conversationId: "agent:p1:research", bot: "research", label: "Research" }]);
    expect(getVoiceScope()?.bot).toBe("research");
    // the voice surface closing returns voice to the default thread
    await act(async () => ui.window.dispatchEvent(Object.assign(new ui.window.Event("voice:surface"), { detail: { open: true } })));
    expect(ui.container.querySelector('button[aria-pressed="true"]')).not.toBeNull();
    await act(async () => ui.window.dispatchEvent(Object.assign(new ui.window.Event("voice:surface"), { detail: { open: false } })));
    expect(getVoiceScope()).toBeNull();
    // leaving the page releases a scope that is still set
    setVoiceScope({ conversationId: "agent:p1:research", bot: "research", label: "Research" });
    await ui.unmount();
    expect(getVoiceScope()).toBeNull();
    expect(fakeWindow).toBeDefined();
  });

  test("renders a labelled Talk button (server markup)", () => {
    const html = flat(renderToStaticMarkup(<VoiceButton botId="builder" botName="Builder" conversationId="agent:p1:builder" />));
    expect(html).toContain('aria-label="Talk to Builder"');
    expect(html).toContain('aria-pressed="false"');
  });
});

describe("the hub's own conversation id (integration, 2 Oct 2026)", () => {
  test("an agent:<person>:<bot> key adopts the UUID the thread route answers with, for catch-up AND live events; another conversation is ignored", async () => {
    const UUID = "5a1d2c3b-0000-4000-8000-00000000abcd";
    const OTHER = "9f9f9f9f-0000-4000-8000-00000000ffff";
    const J = "11111111-2222-4333-8444-555555555555";
    const handlers: ((m: any) => void)[] = [];
    const api = {
      fetchThread: async () => ({ conversationId: UUID, entries: [{ seq: 1, key: `${J}:started`, at: new Date().toISOString(), jobId: J, state: "started", text: "Started: Check the site (job 11111111)." }] }),
      send: async () => ({ ok: true, said: "ok" }),
      cancel: async () => true,
    } as any;
    const subscribe = (h: (m: any) => void) => { handlers.push(h); return () => void handlers.splice(handlers.indexOf(h), 1); };
    const live = (conversationId: string, seq: number, key: string, state: string, text: string) =>
      handlers.forEach((h) => h({ kind: "event", event: { id: seq, at: Date.now(), topic: "thread", type: "entry", final: false, data: { conversationId, eventId: `${conversationId}:${key}`, entry: { seq, key, at: new Date().toISOString(), jobId: J, state, text } } } }));
    let types = "";
    let dump = "";
    function Probe() {
      const chat = useBotChat({ botId: "research", conversationId: "agent:usman:research", api, subscribe });
      types = chat.blocks.map((b) => b.type).join(",");
      dump = JSON.stringify(chat.blocks);
      return null;
    }
    const { window } = parseHTML("<html><body><main></main></body></html>");
    setGlobal("window", window);
    setGlobal("document", window.document);
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(window.document.querySelector("main")!);
    await act(async () => root!.render(<Probe />));
    await flush();
    expect(types).toBe("run"); // the catch-up was folded although the ids differ in form
    await act(async () => live(OTHER, 2, `${J}:step:1`, "progress", "Someone else's step"));
    await act(async () => live(UUID, 3, `${J}:report:1`, "report", "Done: the site is slow on a phone."));
    await flush();
    expect(types).toBe("run");
    expect(dump).toContain("slow on a phone"); // the live event under the hub's UUID was folded
    expect(dump).not.toContain("Someone else"); // another conversation's event was not
  });
});

test("a refused thread read (403) shows the hub's own sentence, not a guess about whose conversation it is", async () => {
  const { agentChatApi, NOT_ALLOWED_PREFIX } = await import("@/lib/agent-chat");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Conversations need a confirmed sign-in: open Agentic OS in your paired browser, or use it at the hub PC." }), { status: 403, headers: { "content-type": "application/json" } })) as never;
  try {
    let message = "";
    try { await agentChatApi.fetchThread("research", 0); } catch (e) { message = (e as Error).message; }
    expect(message.startsWith(NOT_ALLOWED_PREFIX)).toBe(true);
    expect(message).toContain("confirmed sign-in");
    expect(message).not.toContain("someone else");
  } finally { globalThis.fetch = realFetch; }
});
