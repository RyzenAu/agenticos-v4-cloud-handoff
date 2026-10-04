// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createFakeAgentBots } from "@/lib/agent-bots";
import { fixtureSources } from "@/components/agents/setup/setup-fixtures";
import { BotPanels, escapeInPanel, type BotPanel } from "./bot-selector";

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

async function mount(panel: BotPanel) {
  const { window } = parseHTML('<html><body><button aria-controls="new-bot" id="opener-new"></button><button aria-controls="archived-bots" id="opener-archived"></button><main></main></body></html>');
  // linkedom's input has no native checked/value accessors, which the form's Switch (Radix) and a typed value need.
  const proto = (window as any).HTMLInputElement.prototype;
  for (const key of ["checked", "value"]) {
    if (!Object.getOwnPropertyDescriptor(proto, key)) {
      const store = new WeakMap<object, unknown>();
      Object.defineProperty(proto, key, { configurable: true, get() { return store.has(this) ? store.get(this) : key === "value" ? this.getAttribute("value") ?? "" : false; }, set(v) { store.set(this, v); } });
    }
  }
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("requestAnimationFrame", (f: () => void) => { f(); return 0; });
  setGlobal("fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  const closed: Array<BotPanel> = [];
  const container = window.document.querySelector("main")!;
  root = createRoot(container);
  const fake = createFakeAgentBots();
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient()}>
      <BotPanels panel={panel} onPanel={(p) => closed.push(p)} bots={[]} onChange={() => {}} client={fake.client} sources={fixtureSources()} />
    </QueryClientProvider>,
  ));
  const esc = (el: Element) => act(async () => void el.dispatchEvent(Object.assign(new (window as any).Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })));
  return { window, container, closed, esc };
}

describe("Escape in the bot-list panels", () => {
  test("Escape closes an empty New bot form and focus goes back to New bot", async () => {
    const m = await mount("new");
    const name = m.container.querySelector("#new-bot-name")!;
    expect(name).not.toBeNull();
    let focused = "";
    (m.window.document.getElementById("opener-new") as any).focus = () => { focused = "new"; };
    await m.esc(m.container.querySelector('[data-testid="new-bot"]')!);
    expect(m.closed).toEqual([null]);
    expect(focused).toBe("new");
  });

  test("Escape on the archived list closes it and focus goes back to Show archived", async () => {
    const m = await mount("archived");
    let focused = "";
    (m.window.document.getElementById("opener-archived") as any).focus = () => { focused = "archived"; };
    await m.esc(m.container.querySelector('[data-testid="archived-bots"]')!);
    expect(m.closed).toEqual([null]);
    expect(focused).toBe("archived");
  });

  test("a form with typed text keeps its text: Escape does nothing, Cancel is the way out", async () => {
    const m = await mount("new");
    const name = m.container.querySelector("#new-bot-name") as HTMLInputElement;
    name.value = "Scout"; // what the person typed is in the field itself
    await m.esc(m.container.querySelector('[data-testid="new-bot"]')!);
    expect(m.closed).toEqual([]);
  });
});

describe("escapeInPanel (the rule on its own)", () => {
  const { document } = parseHTML("<html><body><div id='root'><input id='a' type='text'/><div role='dialog'><button id='in'></button></div></div></body></html>");
  const root = document.getElementById("root")!;
  const ev = (over: Partial<{ key: string; defaultPrevented: boolean; target: EventTarget | null }> = {}) => ({ key: "Escape", defaultPrevented: false, target: document.getElementById("a"), ...over });
  test("other keys, handled events and dialogs are not ours", () => {
    expect(escapeInPanel(ev({ key: "Enter" }), "new", root)).toBe("ignore");
    expect(escapeInPanel(ev({ defaultPrevented: true }), "new", root)).toBe("ignore");
    expect(escapeInPanel(ev({ target: document.getElementById("in") }), "new", root)).toBe("ignore");
  });
  test("close when nothing would be lost, keep when it would", () => {
    expect(escapeInPanel(ev(), "new", root)).toBe("close");
    (document.getElementById("a") as HTMLInputElement).value = "Scout";
    expect(escapeInPanel(ev(), "new", root)).toBe("keep");
    expect(escapeInPanel(ev(), "archived", root)).toBe("close");
  });
});
