// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { BotChat, activityOf, type ChatActivity } from "@/components/agents/chat/bot-chat";
import { applyEntries, emptyChat, toBlocks } from "@/components/agents/chat/chat-state";
import { createFakeBotHub, seedDemoThread, JOB_B, type FakeHub } from "@/components/agents/chat/__fixtures__/fake-bot-hub";
import { ComputerTab } from "@/components/agents/computer/computer-tab";
import type { ComputerView } from "@/lib/computers-client";
import { PanelContext } from "./conversation";
import { ChatComputerLayout } from "./chat-computer-layout";
import { CHAT_MIN, HANDLE, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, PANEL_STEP, PANEL_STORAGE_KEY, clampWidth, panelMax } from "./panel-state";

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

const computer = (o: Partial<ComputerView> = {}): ComputerView => ({
  name: "research", id: "dev-1", label: "Research computer", kind: "cloud-computer", owner: "shared", adapter: "synthetic", state: "online", desired: "running" as never,
  desktop: true, browser: true, capabilities: null, assigned: null, controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: 1 }, takeoverPending: null, paused: null, lastJob: null,
  resource: null, lastSeen: 1, failure: null, recoveries: 0, createdBy: "usman", createdAt: 1, viewer: { snapshot: true, vnc: false }, ...o,
});

type Calls = Array<{ url: string; body: unknown }>;
type Setup = { width?: number; reduced?: boolean; storage?: Record<string, string>; hub?: FakeHub };
function boot({ width = 1440, reduced = false, storage = {} }: Setup = {}) {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  const store = new Map(Object.entries(storage));
  (window as any).innerWidth = width;
  (window as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  (window as any).matchMedia = (q: string) => ({ matches: reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {} });
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const calls: Calls = [];
  setGlobal("fetch", async (url: string, init?: { body?: string }) => {
    if (String(url).startsWith("/__computers/") && init?.body) calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (url === "/__token") return new Response(JSON.stringify({ token: "t" }), { headers: { "content-type": "application/json" } });
    if (String(url).includes("/snapshot")) return new Response("", { status: 404 });
    return new Response(JSON.stringify({ state: "taken", resumed: true }), { headers: { "content-type": "application/json" } });
  });
  return { window, store, calls, container: window.document.querySelector("main")! };
}

async function mount(env: ReturnType<typeof boot>, o: { computer?: ComputerView | null; hasComputer?: boolean; me?: string; hub?: FakeHub; draft?: string; openRequest?: boolean; onHandled?: () => void; width?: number; onActivity?: (a: ChatActivity) => void } = {}) {
  const hub = o.hub ?? createFakeBotHub();
  const c = o.computer === undefined ? computer() : o.computer;
  const qc = new QueryClient();
  root = createRoot(env.container);
  const tree = (extra: Partial<React.ComponentProps<typeof ChatComputerLayout>> = {}) => (
    <QueryClientProvider client={qc}>
      <ChatComputerLayout
        botName="Research"
        hasComputer={o.hasComputer ?? true}
        computerLabel="Research computer"
        viewportWidth={o.width ?? Number((env.window as any).innerWidth)}
        openRequest={o.openRequest}
        onOpenRequestHandled={o.onHandled}
        chat={<BotChat bot={{ id: hub.botId, name: "Research", computer: "research" }} conversationId={hub.conversationId} api={hub.api} subscribe={hub.subscribe} initialDraft={o.draft} voice={false} onActivity={o.onActivity} />}
        renderComputer={() => <ComputerTab compact botName="Research" computerName="research" computer={c} me={o.me ?? "usman"} nameOf={(id) => id.charAt(0).toUpperCase() + id.slice(1)} />}
        {...extra}
      />
    </QueryClientProvider>
  );
  await act(async () => root!.render(tree()));
  await flush();
  return { hub, rerender: (extra?: Partial<React.ComponentProps<typeof ChatComputerLayout>>) => act(async () => root!.render(tree(extra))) };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const q = (env: ReturnType<typeof boot>, sel: string) => env.container.querySelector(sel) as HTMLElement | null;
const buttonByText = (env: ReturnType<typeof boot>, text: string) => [...env.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text || b.getAttribute("aria-label") === text) as HTMLElement | undefined;
const click = (env: ReturnType<typeof boot>, el: Element) => act(async () => void el.dispatchEvent(new (env.window as any).Event("click", { bubbles: true, cancelable: true })));
const key = (env: ReturnType<typeof boot>, el: Element, k: string, shiftKey = false) => act(async () => void el.dispatchEvent(Object.assign(new (env.window as any).Event("keydown", { bubbles: true, cancelable: true }), { key: k, shiftKey })));
const prefs = (env: ReturnType<typeof boot>) => JSON.parse(env.store.get(PANEL_STORAGE_KEY) ?? "null");

describe("wide: the computer panel beside the conversation", () => {
  test("a bot with a computer gets a Show computer toggle; it opens and closes the panel and the choice is remembered", async () => {
    const env = boot();
    await mount(env);
    expect(q(env, "aside")).toBeNull();
    expect(q(env, "[data-chat-computer]")!.getAttribute("data-layout")).toBe("wide");
    await click(env, buttonByText(env, "Show computer")!);
    expect(q(env, "aside")).not.toBeNull();
    expect(q(env, "aside")!.getAttribute("aria-label")).toBe("Research's computer");
    expect(buttonByText(env, "Hide computer")).toBeTruthy();
    expect(prefs(env).open).toBe(true);
    await click(env, buttonByText(env, "Hide computer")!);
    expect(q(env, "aside")).toBeNull();
    expect(prefs(env).open).toBe(false);
  });

  test("the panel's own Hide button closes it too", async () => {
    const env = boot({ storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: 500 }) } });
    await mount(env);
    expect(q(env, "aside")).not.toBeNull();
    expect(q(env, "aside")!.style.width).toBe("500px");
    await click(env, buttonByText(env, "Hide the computer")!);
    expect(q(env, "aside")).toBeNull();
  });

  test("resize by keyboard: the separator is accessible, arrows move it by a step, Shift by a big step, Home and End are the limits, and it is remembered", async () => {
    const env = boot({ storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } });
    await mount(env);
    const sep = q(env, '[role="separator"]')!;
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("tabindex")).toBe("0");
    expect(sep.getAttribute("aria-label")).toMatch(/Resize/);
    expect(sep.getAttribute("aria-valuenow")).toBe(String(PANEL_DEFAULT));
    expect(sep.getAttribute("aria-valuemin")).toBe(String(PANEL_MIN));
    await key(env, sep, "ArrowLeft");
    expect(sep.getAttribute("aria-valuenow")).toBe(String(PANEL_DEFAULT + PANEL_STEP));
    expect(q(env, "aside")!.style.width).toBe(`${PANEL_DEFAULT + PANEL_STEP}px`);
    await key(env, sep, "ArrowRight");
    await key(env, sep, "ArrowRight");
    expect(sep.getAttribute("aria-valuenow")).toBe(String(PANEL_DEFAULT - PANEL_STEP));
    await key(env, sep, "Home");
    expect(sep.getAttribute("aria-valuenow")).toBe(String(PANEL_MIN));
    await key(env, sep, "ArrowRight");
    expect(sep.getAttribute("aria-valuenow")).toBe(String(PANEL_MIN)); // never below the minimum
    await key(env, sep, "End");
    expect(sep.getAttribute("aria-valuenow")).toBe(String(panelMax(1440)));
    expect(sep.getAttribute("aria-valuemax")).toBe(String(panelMax(1440)));
    await key(env, sep, "Home");
    await key(env, sep, "ArrowLeft", true);
    expect(sep.getAttribute("aria-valuenow")).toBe(String(PANEL_MIN + 96));
    expect(prefs(env).width).toBe(PANEL_MIN + 96);
  });

  test("expanding keeps the conversation mounted: same box, same draft, same scroll; collapsing gives it back", async () => {
    const env = boot({ storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } });
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    await mount(env, { hub, draft: "Compare the three clinics" });
    const box = q(env, "textarea") as HTMLTextAreaElement;
    const log = q(env, '[role="log"]')!;
    (log as any).scrollTop = 321;
    expect(box.value).toBe("Compare the three clinics");
    await click(env, buttonByText(env, "Expand the computer")!);
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBe("true");
    expect(q(env, '[role="separator"]')).toBeNull();
    expect(q(env, "textarea")).toBe(box); // not remounted
    expect(q(env, '[role="log"]')).toBe(log);
    expect(box.value).toBe("Compare the three clinics");
    expect((log as any).scrollTop).toBe(321);
    expect(q(env, '[data-pane="conversation"]')!.hasAttribute("inert")).toBe(true); // nothing behind the overlay takes focus
    await click(env, buttonByText(env, "Collapse the computer")!);
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBeNull();
    expect(q(env, "textarea")).toBe(box);
    expect(q(env, '[data-pane="conversation"]')!.hasAttribute("inert")).toBe(false);
    expect(q(env, '[role="separator"]')).not.toBeNull();
  });

  test("Escape collapses the expanded view", async () => {
    const env = boot({ storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } });
    await mount(env);
    await click(env, buttonByText(env, "Expand the computer")!);
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBe("true");
    await key(env, env.window.document as unknown as Element, "Escape");
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBeNull();
  });

  test("a bot without a computer has no toggle, no switch and no panel: one line says why", async () => {
    for (const width of [1440, 900, 390]) {
      const env = boot({ width });
      await mount(env, { hasComputer: false, computer: null });
      expect(buttonByText(env, "Show computer")).toBeUndefined();
      expect(q(env, '[role="radiogroup"]')).toBeNull();
      expect(q(env, "aside")).toBeNull();
      expect(q(env, '[data-testid="no-computer-note"]')!.textContent).toContain("has no computer");
      expect(q(env, "textarea")).not.toBeNull();
      await act(async () => root!.unmount());
      root = undefined;
    }
  });
});

describe("tablet and phone: a switch, not squeezed columns", () => {
  for (const width of [900, 390]) {
    test(`${width}px: Conversation and Computer are one switch; switching keeps the draft and the scroll`, async () => {
      const env = boot({ width });
      const hub = createFakeBotHub();
      seedDemoThread(hub);
      await mount(env, { hub, draft: "Unfinished message" });
      expect(q(env, "[data-chat-computer]")!.getAttribute("data-layout")).toBe(width >= 768 ? "tablet" : "phone");
      expect(q(env, '[role="separator"]')).toBeNull();
      expect(buttonByText(env, "Show computer")).toBeUndefined();
      const radios = [...env.container.querySelectorAll('[role="radio"]')];
      expect(radios.map((r) => r.textContent)).toEqual(["Conversation", "Computer"]);
      const box = q(env, "textarea") as HTMLTextAreaElement;
      const log = q(env, '[role="log"]')!;
      (log as any).scrollTop = 250;
      await click(env, radios[1]);
      expect(q(env, "[data-chat-computer]")!.getAttribute("data-view")).toBe("computer");
      expect(q(env, "aside")).not.toBeNull();
      const conv = q(env, '[data-pane="conversation"]')!;
      expect(conv.hasAttribute("inert")).toBe(true);
      expect(conv.getAttribute("aria-hidden")).toBe("true");
      await click(env, [...env.container.querySelectorAll('[role="radio"]')][0]);
      expect(q(env, "[data-chat-computer]")!.getAttribute("data-view")).toBe("conversation");
      expect(q(env, "aside")).toBeNull();
      expect(q(env, "textarea")).toBe(box);
      expect(q(env, '[role="log"]')).toBe(log);
      expect(box.value).toBe("Unfinished message");
      expect((log as any).scrollTop).toBe(250);
      expect(q(env, '[data-pane="conversation"]')!.hasAttribute("inert")).toBe(false);
    });
  }

  test("resizing the window across 1200 px keeps the conversation mounted", async () => {
    const env = boot({ width: 1440, storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } });
    const m = await mount(env, { draft: "Keep me", width: 1440 });
    const box = q(env, "textarea");
    await m.rerender({ viewportWidth: 900 });
    expect(q(env, "[data-chat-computer]")!.getAttribute("data-layout")).toBe("tablet");
    expect(q(env, "textarea")).toBe(box);
  });
});

describe("deep links and requests for the computer", () => {
  test("wide: a request (the old ?tab=computer) opens the panel and says it was handled once", async () => {
    const env = boot();
    let handled = 0;
    await mount(env, { openRequest: true, onHandled: () => void handled++ });
    expect(q(env, "aside")).not.toBeNull();
    expect(handled).toBe(1);
  });

  test("phone: the same request switches to the computer", async () => {
    const env = boot({ width: 390 });
    let handled = 0;
    await mount(env, { openRequest: true, onHandled: () => void handled++ });
    expect(q(env, "[data-chat-computer]")!.getAttribute("data-view")).toBe("computer");
    expect(handled).toBe(1);
  });
});

describe("reduced motion", () => {
  test("with the preference on, the panel and the pane switch have no transitions or animation", async () => {
    const env = boot({ reduced: true, storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } });
    await mount(env);
    expect(q(env, "[data-chat-computer]")!.getAttribute("data-motion")).toBe("reduced");
    const aside = q(env, "aside")!;
    expect(aside.style.transition).toBe("none");
    expect(aside.style.animation).toBe("none");
    await act(async () => root!.unmount());
    root = undefined;
    const phone = boot({ reduced: true, width: 390 });
    await mount(phone);
    expect((q(phone, '[data-pane="conversation"]')!.style as any).transition).toBe("none");
  });

  test("without it, the panel eases in", async () => {
    const env = boot({ storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } });
    await mount(env);
    expect(q(env, "[data-chat-computer]")!.getAttribute("data-motion")).toBe("full");
    expect(q(env, "aside")!.style.animation).toContain("ws-panel-in");
  });
});

describe("controls: the existing computer actions and control lease, only when allowed", () => {
  const open = { storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } };

  test("an idle computer offers Watch, Take over and Stop; Take over posts the takeover request, Stop asks first and then stops", async () => {
    const env = boot(open);
    await mount(env, { computer: computer() });
    const labels = [...q(env, "aside")!.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(labels).toContain("Hide screen"); // watching by default, as in the Computer tab
    expect(labels).toContain("Take over");
    expect(labels).toContain("Stop");
    expect(labels).not.toContain("Return to agent");
    await click(env, buttonByText(env, "Take over")!);
    await flush();
    expect(env.calls.map((c) => c.url)).toEqual(["/__computers/research/takeover"]);
    await click(env, buttonByText(env, "Stop")!);
    expect(env.calls).toHaveLength(1); // asked once, nothing sent yet
    await click(env, buttonByText(env, "Yes, stop it")!);
    await flush();
    expect(env.calls.at(-1)).toEqual({ url: "/__computers/research/action", body: { action: "stop", force: true } });
  });

  test("Hide screen and Watch toggle the screen", async () => {
    const env = boot(open);
    await mount(env, { computer: computer() });
    await click(env, buttonByText(env, "Hide screen")!);
    expect(buttonByText(env, "Watch")).toBeTruthy();
    expect(buttonByText(env, "Hide screen")).toBeUndefined();
  });

  test("when you hold the controls, Return to agent is offered, Take over is not, and Return posts the return", async () => {
    const env = boot(open);
    await mount(env, { computer: computer({ controller: { kind: "person", who: "usman", jobId: null, expiresAt: 9, epoch: 2 } }), me: "usman" });
    expect(q(env, "aside")!.textContent).toContain("You have the controls");
    expect(buttonByText(env, "Take over")).toBeUndefined();
    await click(env, buttonByText(env, "Return to agent")!);
    await flush();
    expect(env.calls.map((c) => c.url)).toEqual(["/__computers/research/return"]);
  });

  test("another founder's control shows as theirs, by name, with no Take over and no Return", async () => {
    const env = boot(open);
    await mount(env, { computer: computer({ controller: { kind: "person", who: "mehroz", jobId: null, expiresAt: 9, epoch: 3 } }), me: "usman" });
    const text = q(env, "aside")!.textContent!;
    expect(text).toContain("Mehroz has the controls");
    expect(buttonByText(env, "Take over")).toBeUndefined();
    expect(buttonByText(env, "Return to agent")).toBeUndefined();
    expect(q(env, "[data-computer-tab]")!.getAttribute("data-input")).toBe("view-only");
    expect(env.calls).toHaveLength(0);
  });

  test("a stopped computer offers Start, not Take over or Stop", async () => {
    const env = boot(open);
    await mount(env, { computer: computer({ state: "offline" }) });
    expect(buttonByText(env, "Start")).toBeTruthy();
    expect(buttonByText(env, "Take over")).toBeUndefined();
    expect(buttonByText(env, "Stop")).toBeUndefined();
  });

  test("the panel mounts one set of controls and one viewer", async () => {
    const env = boot(open);
    await mount(env, { computer: computer() });
    expect(env.container.querySelectorAll("[data-computer-tab]")).toHaveLength(1);
    expect(env.container.querySelectorAll('[role="group"][aria-label^="Controls for"]')).toHaveLength(1);
  });
});

describe("the task and the next blocker come from the conversation", () => {
  test("activityOf: a blocked run wins over a running one, and carries chat-state's recovery", () => {
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const blocks = toBlocks(applyEntries(emptyChat(), hub.entries).state);
    const a = activityOf(blocks);
    expect(a.state).toBe("blocked");
    expect(a.recovery?.title).toBe("Needs you at the computer");
    expect(a.recovery?.actions).toContain("take-over");
    expect(a.task).toBeTruthy();
    expect(activityOf([])).toEqual({ task: null, state: null, recovery: null });
  });

  test("BotChat reports it once, and the panel shows the task and the blocker", async () => {
    const env = boot({ storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } });
    const hub = createFakeBotHub();
    seedDemoThread(hub);
    const seen: ChatActivity[] = [];
    function Shell() {
      const [a, setA] = React.useState<ChatActivity>({ task: null, state: null, recovery: null });
      return (
        <ChatComputerLayout
          botName="Research"
          hasComputer
          computerLabel="Research computer"
          viewportWidth={1440}
          chat={<BotChat bot={{ id: hub.botId, name: "Research", computer: "research" }} conversationId={hub.conversationId} api={hub.api} subscribe={hub.subscribe} voice={false} onActivity={(x) => { seen.push(x); setA(x); }} />}
          renderComputer={() => <PanelContext activity={a} />}
        />
      );
    }
    root = createRoot(env.container);
    await act(async () => root!.render(<Shell />));
    await flush();
    expect(seen.filter((s) => s.state === "blocked")).toHaveLength(1);
    expect(q(env, '[data-testid="panel-blocker"]')!.textContent).toContain("Take over, type the code");
    expect(q(env, '[data-testid="panel-task"]')).not.toBeNull();
    expect(JOB_B).toBeTruthy();
  });
});

describe("the controls live on the page's tab row when it gives a host", () => {
  test("the Show computer toggle is placed in the host, not above the panes, and still works", async () => {
    const env = boot();
    const host = env.window.document.createElement("div");
    env.window.document.body.appendChild(host);
    const m = await mount(env);
    expect(q(env, "[data-chat-computer] > div.min-h-9")).not.toBeNull(); // no host: a row of its own
    await m.rerender({ toolbarHost: host as unknown as HTMLElement });
    expect(q(env, "[data-chat-computer] > div.min-h-9")).toBeNull();
    const toggle = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Show computer")!;
    expect(toggle).toBeTruthy();
    await click(env, toggle);
    expect(q(env, "aside")).not.toBeNull();
    expect([...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim())).toContain("Hide computer");
  });

  test("on a phone the Conversation / Computer switch goes to the host and keeps the conversation mounted", async () => {
    const env = boot({ width: 390 });
    const host = env.window.document.createElement("div");
    env.window.document.body.appendChild(host);
    const m = await mount(env, { draft: "Keep me", width: 390 });
    await m.rerender({ toolbarHost: host as unknown as HTMLElement });
    const box = q(env, "textarea") as HTMLTextAreaElement;
    const computerChoice = [...host.querySelectorAll('[role="radio"]')].find((b) => (b.textContent ?? "").trim() === "Computer")!;
    await click(env, computerChoice);
    expect(q(env, "[data-chat-computer]")!.getAttribute("data-view")).toBe("computer");
    expect(q(env, "textarea")).toBe(box);
    expect(box.value).toBe("Keep me");
  });

  test("a host that is not on the page yet shows nothing rather than a second row", async () => {
    const env = boot();
    const m = await mount(env);
    await m.rerender({ toolbarHost: null });
    expect(q(env, "[data-chat-computer] > div.min-h-9")).toBeNull();
  });
});

describe("full screen ends with the panel, tells the page, and yields Escape to dialogs", () => {
  const open = { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) };

  test("Hide computer while expanded collapses the full screen: nothing is left inert behind a panel that is gone", async () => {
    const env = boot({ storage: open });
    await mount(env);
    await click(env, buttonByText(env, "Expand the computer")!);
    expect(q(env, '[data-pane="conversation"]')!.hasAttribute("inert")).toBe(true);
    await click(env, buttonByText(env, "Hide computer")!);
    expect(q(env, "aside")).toBeNull();
    expect(q(env, "[data-chat-computer]")!.getAttribute("data-expanded")).toBeNull();
    expect(q(env, '[data-pane="conversation"]')!.hasAttribute("inert")).toBe(false);
    expect(q(env, '[data-pane="conversation"]')!.getAttribute("aria-hidden")).toBeNull();
  });

  test("the page hears when the computer is full screen and when it is showing", async () => {
    const env = boot({ storage: open });
    const seen: string[] = [];
    const m = await mount(env);
    await m.rerender({ onExpandedChange: (b: boolean) => seen.push(`full:${b}`), onComputerShownChange: (b: boolean) => seen.push(`shown:${b}`) });
    expect(seen).toContain("shown:true");
    await click(env, buttonByText(env, "Expand the computer")!);
    expect(seen.at(-1)).toBe("full:true");
    await click(env, buttonByText(env, "Collapse the computer")!);
    expect(seen.at(-1)).toBe("full:false");
    await click(env, buttonByText(env, "Hide computer")!);
    expect(seen.at(-1)).toBe("shown:false");
  });

  test("Escape that something else already handled, or that is meant for a dialog, does not collapse the full screen", async () => {
    const env = boot({ storage: open });
    env.window.document.addEventListener("keydown", (e: Event) => {
      if ((e.target as HTMLElement)?.id === "handled") e.preventDefault();
    });
    await mount(env);
    await click(env, buttonByText(env, "Expand the computer")!);
    const handled = env.window.document.createElement("button");
    handled.id = "handled";
    env.window.document.body.appendChild(handled);
    await key(env, handled, "Escape");
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBe("true");
    const dialog = env.window.document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = env.window.document.createElement("button");
    dialog.appendChild(inside);
    env.window.document.body.appendChild(dialog);
    await key(env, inside, "Escape");
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBe("true");
    await key(env, env.window.document as unknown as Element, "Escape");
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBeNull();
  });

  test("a requestFullscreen that returns nothing or throws cannot break Expand", async () => {
    const env = boot({ storage: open });
    await mount(env);
    (q(env, "aside") as any).requestFullscreen = () => undefined;
    await click(env, buttonByText(env, "Expand the computer")!);
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBe("true");
    await click(env, buttonByText(env, "Collapse the computer")!);
    (q(env, "aside") as any).requestFullscreen = () => {
      throw new Error("denied");
    };
    await click(env, buttonByText(env, "Expand the computer")!);
    expect(q(env, "aside")!.getAttribute("data-expanded")).toBe("true");
  });
});

describe("the conversation keeps a usable width beside the panel", () => {
  test("the panel may take at most what leaves the conversation 480 px, whatever width was saved", () => {
    expect(CHAT_MIN).toBeGreaterThanOrEqual(480);
    for (const row of [812, 848, 900, 1136]) {
      expect(row - clampWidth(PANEL_MAX, row) - HANDLE).toBeGreaterThanOrEqual(Math.min(CHAT_MIN, row - PANEL_MIN - HANDLE));
    }
    expect(848 - clampWidth(PANEL_DEFAULT, 848) - HANDLE).toBeGreaterThanOrEqual(480);
  });
});

describe("the panel tells the truth about an online computer whose screen is down", () => {
  test("the state chip says so instead of plain Online", async () => {
    const env = boot({ storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_DEFAULT }) } });
    const down = { applicable: true, ok: false, checking: false, layer: "vnc", reason: "The screen server (VNC) isn't running, so the live view can't connect.", next: "restart-display", nextLabel: "Restart the display", at: 1, lastFrameAt: null, lastShotAt: null, retry: { used: 0, max: 3, nextAt: null } };
    await mount(env, { computer: computer({ screen: down as never }) });
    expect(q(env, "aside")!.textContent).toContain("Online, screen unavailable");
  });
});

describe("the panel's headline stays readable at the panel's narrowest", () => {
  test("a long working headline has its own full-width line (not squeezed beside the badge) and a tooltip with the whole text", async () => {
    const env = boot({ storage: { [PANEL_STORAGE_KEY]: JSON.stringify({ open: true, width: PANEL_MIN }) } });
    const task = "Build an opening hours component for the Parramatta clinic page";
    await mount(env, { computer: computer({ state: "busy", controller: { kind: "agent", who: "research", jobId: "j1", expiresAt: null, epoch: 2 } as never, assigned: { agent: "research", jobId: "j1", title: task } as never }) });
    const head = q(env, '[data-testid="computer-headline"]')!;
    expect(head.className).toContain("basis-full");
    expect(head.className).not.toContain("sm:basis-0");
    expect(head.className).toContain("[overflow-wrap:anywhere]");
    expect(head.getAttribute("title")).toBe(head.textContent);
    expect(head.textContent).toContain("Build an opening hours component");
    expect(q(env, "aside h2")!.getAttribute("title")).toBe("Research computer");
  });
});
