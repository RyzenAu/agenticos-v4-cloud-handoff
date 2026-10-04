// Round 10: the terminal panel for a shared bot computer (the jobs owner's /__computers/:name/terminal contract), and the Jarvis chat's coding links.
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { canOfferTerminal, plainTerminalText, terminalApi, type TerminalApi } from "@/lib/terminal-client";
import { openJobHref } from "@/lib/thread-events";
import { TerminalPanel } from "./computer/terminal-panel";
import { ComputerControlsBar } from "./computer/computer-controls";

const bot = (over: Record<string, unknown> = {}) => ({ kind: "cloud-computer", owner: "shared", state: "online", controller: { kind: "person", who: "usman", epoch: 1 }, ...over }) as never;

describe("when a terminal is offered", () => {
  test("only a shared bot computer that is up, to the person who holds its controls in this window", () => {
    expect(canOfferTerminal(bot(), "usman")).toBe(true);
    expect(canOfferTerminal(bot({ state: "busy" }), "usman")).toBe(true);
    expect(canOfferTerminal(bot({ controller: { kind: "person", who: "mehroz", epoch: 1 } }), "usman")).toBe(false);
    expect(canOfferTerminal(bot({ controller: { kind: "agent", who: "research", epoch: 1 } }), "usman")).toBe(false);
    expect(canOfferTerminal(bot({ controller: { kind: null, who: null, epoch: 1 } }), "usman")).toBe(false);
    expect(canOfferTerminal(bot({ heldByYouElsewhere: true }), "usman")).toBe(false);
    expect(canOfferTerminal(bot({ state: "offline" }), "usman")).toBe(false);
    expect(canOfferTerminal(bot({ kind: "personal-pc" }), "usman")).toBe(false);
    expect(canOfferTerminal(bot({ owner: "usman" }), "usman")).toBe(false);
    expect(canOfferTerminal(null, "usman")).toBe(false);
    expect(canOfferTerminal(bot(), null)).toBe(false);
  });
  test("the button sits with Take over / Return, and is absent when not offered", () => {
    const state = { controls: { watch: false, takeOver: null, returnToAgent: true, stop: false, start: null }, busy: false, note: null, handBackFailed: false, mine: true, act: async () => {} } as never;
    const computer = { name: "research", label: "Research", state: "online", controller: { kind: "person", who: "usman" } } as never;
    const withIt = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><ComputerControlsBar computer={computer} state={state} watching onWatching={() => {}} terminal={{ open: false, onToggle: () => {} }} /></QueryClientProvider>);
    expect(withIt).toContain(">Terminal<");
    expect(withIt.indexOf("Terminal")).toBeLessThan(withIt.indexOf("Return to agent"));
    expect(renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><ComputerControlsBar computer={computer} state={state} watching onWatching={() => {}} /></QueryClientProvider>)).not.toContain("Terminal");
  });
});

describe("the client speaks the hub's contract", () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  function fake(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const f = async (url: string, init: RequestInit = {}) => {
      if (url === "/__token") return reply(200, { token: "t" });
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return handler(url, init);
    };
    return { api: terminalApi(f as never), calls };
  }
  test("open, read, type, resize and close hit the right routes with the right bodies", async () => {
    const h = fake((url) => (url.includes("/events") ? reply(200, { chunks: [{ seq: 1, data: "hi\r\n" }, { seq: 2, data: "$ " }], next: 2, gap: false, closed: null }) : url.endsWith("/terminal") ? reply(200, { id: "abc123", attached: true }) : reply(200, { ok: true })));
    expect(await h.api.open("research", { cols: 100, rows: 24 })).toEqual({ ok: true, id: "abc123", attached: true });
    const ev = await h.api.events("research", "abc123", 0, 20000);
    expect(ev.ok && ev.chunks.map((c) => c.seq)).toEqual([1, 2]);
    await h.api.input("research", "abc123", "ls\n");
    await h.api.resize("research", "abc123", { cols: 120, rows: 30 });
    await h.api.close("research", "abc123");
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /__computers/research/terminal",
      "GET /__computers/research/terminal/abc123/events?after=0&wait=20000",
      "POST /__computers/research/terminal/abc123/input",
      "POST /__computers/research/terminal/abc123/resize",
      "POST /__computers/research/terminal/abc123/close",
    ]);
    expect(h.calls[0]!.body).toEqual({ cols: 100, rows: 24 });
    expect(h.calls[2]!.body).toEqual({ data: "ls\n" });
  });
  test("a refusal is the hub's own sentence, unchanged", async () => {
    const why = "research runs as this PC's own user, so a shell there could read every other computer's files. No terminal was opened.";
    const h = fake(() => reply(409, { error: why }));
    expect(await h.api.open("research", { cols: 100, rows: 24 })).toEqual({ ok: false, status: 409, message: why });
  });
  test("current() reads this person's open terminal, or none", async () => {
    expect(await fake(() => reply(200, { terminal: { id: "x1y2z3" } })).api.current("research")).toEqual({ ok: true, id: "x1y2z3" });
    expect(await fake(() => reply(200, { terminal: null })).api.current("research")).toEqual({ ok: true, id: null });
  });
});

describe("terminal output as readable text", () => {
  test("colour and cursor codes go; CR rewinds a line; backspace deletes", () => {
    expect(plainTerminalText("\u001b[32mok\u001b[0m\r\nnext")).toBe("ok\nnext");
    expect(plainTerminalText("progress 10%\rprogress 90%")).toBe("progress 90%");
    expect(plainTerminalText("lss\b\n")).toBe("ls\n");
    expect(plainTerminalText("\u001b]0;title\u0007$ ")).toBe("$ ");
  });
});

// ---- the panel -------------------------------------------------------------------------------------------------------------------------
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
async function mount(api: TerminalApi, onClose = () => {}, initialLine = "") {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = window.document.querySelector("main")!;
  root = createRoot(container);
  await act(async () => root!.render(<TerminalPanel computerName="research" label="Research" api={api} onClose={onClose} initialLine={initialLine} />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { container, window, text: () => container.textContent ?? "" };
}
/** A hub that answers one batch of output and then waits (as the long poll does) until the page stops asking. */
function liveApi(opts: { refuse?: string; chunks?: Array<{ seq: number; data: string }>; closed?: { reason: string } | null; gap?: boolean } = {}) {
  const sent: string[] = [];
  const closes: string[] = [];
  let polls = 0;
  const api = {
    open: async () => (opts.refuse ? { ok: false as const, status: 409, message: opts.refuse } : { ok: true as const, id: "abc123", attached: false }),
    current: async () => ({ ok: true as const, id: null }),
    events: async (_n: string, _id: string, _after: number, _w: number, signal?: AbortSignal) => {
      polls += 1;
      if (polls === 1) return { ok: true as const, chunks: opts.chunks ?? [], next: (opts.chunks ?? []).at(-1)?.seq ?? 0, gap: opts.gap === true, closed: opts.closed ?? null };
      return new Promise((res) => signal?.addEventListener("abort", () => res({ ok: false as const, status: 0, message: "Stopped." })));
    },
    input: async (_n: string, _id: string, data: string) => { sent.push(data); return { ok: true as const, data: {} }; },
    resize: async () => ({ ok: true as const, data: {} }),
    close: async (_n: string, id: string) => { closes.push(id); return { ok: true as const, data: {} }; },
  } as unknown as TerminalApi;
  return { api, sent, closes };
}

describe("the terminal panel", () => {
  test("a refusal is shown plainly, with no input line", async () => {
    const why = "research has no Linux user of its own, so a terminal there is refused.";
    const ui = await mount(liveApi({ refuse: why }).api);
    expect(ui.container.querySelector('[data-testid="terminal-refusal"]')!.textContent).toBe(why);
    expect(ui.container.querySelector("input")).toBeNull();
    expect(ui.container.querySelector("section")!.getAttribute("data-terminal-phase")).toBe("refused");
  });
  test("output appears as readable text and a typed line goes to the terminal with a newline", async () => {
    const h = liveApi({ chunks: [{ seq: 1, data: "\u001b[1mhello\u001b[0m\r\n$ " }] });
    const ui = await mount(h.api, () => {}, "ls");
    expect(ui.container.querySelector('[data-testid="terminal-log"]')!.textContent).toBe("hello\n$ ");
    expect(ui.container.querySelector('[data-testid="terminal-log"]')!.getAttribute("role")).toBe("log");
    await act(async () => ui.container.querySelector("form")!.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true })));
    expect(h.sent).toEqual(["ls\n"]);
    expect(ui.text()).toContain("Every command line is logged");
    expect(ui.container.querySelector('[data-testid="terminal-limits"]')!.textContent).toContain("not a full terminal");
  });
  test("a terminal the hub closed says why and offers no input; a missed stretch is said", async () => {
    const ui = await mount(liveApi({ chunks: [{ seq: 1, data: "bye\n" }], closed: { reason: "The controls went back to the agent, so the terminal closed." }, gap: true }).api);
    expect(ui.container.querySelector('[data-testid="terminal-closed"]')!.textContent).toBe("The controls went back to the agent, so the terminal closed.");
    expect(ui.container.querySelector("input")).toBeNull();
    expect(ui.container.querySelector('[data-testid="terminal-gap"]')).not.toBeNull();
    expect(ui.container.querySelector('[data-testid="terminal-log"]')!.textContent).toBe("bye\n");
  });
  test("Close terminal closes it on the hub, then the panel goes", async () => {
    const h = liveApi();
    let closed = 0;
    const ui = await mount(h.api, () => { closed += 1; });
    const btn = [...ui.container.querySelectorAll("button")].find((b) => b.textContent === "Close terminal")!;
    await act(async () => btn.dispatchEvent(new ui.window.Event("click", { bubbles: true })));
    expect(h.closes).toEqual(["abc123"]);
    expect(closed).toBe(1);
  });
});

describe("Jarvis chat: a coding entry opens its own coding page", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const via = `job:${id}:result`;
  test("the entry's own /coding link is followed, and a computer job still goes to Activity", () => {
    expect(openJobHref(via, `Done. The work is on its branch.\nChanges: /coding/${id}?tab=changes`)).toBe(`/coding/${id}?tab=changes`);
    expect(openJobHref(via, `Changes: /coding/${id}`)).toBe(`/coding/${id}`);
    expect(openJobHref(via, "Saved the report.")).toBe(`/activity#job-${id}`);
    expect(openJobHref("job:not-a-job:result", `Changes: /coding/${id}`)).toBeNull();
  });
  test("a link to another job, or an outside address, in the text is never followed", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    expect(openJobHref(via, `Changes: /coding/${other}?tab=changes`)).toBe(`/activity#job-${id}`);
    expect(openJobHref(via, `see https://evil.example/coding/${id}?tab=changes`)).toBe(`/activity#job-${id}`);
  });
});
