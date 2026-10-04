// A small DOM harness for behavioural tests (linkedom + React act): mount, type, click, press keys, mock fetch.
// IMPORT THIS FILE FIRST in a test: React decides at import time whether a DOM exists, so the window is installed here
// (once, for the file) before react-dom is loaded.
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";

const dom = parseHTML("<html><body><main></main></body></html>");
for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, getComputedStyle: () => ({ getPropertyValue: () => "" }), IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
// React checks 'oninput' in a div to decide whether input events work; linkedom lacks the property.
for (const ev of ["oninput", "onchange", "onclick", "onkeydown"]) if (!(ev in dom.window.document)) Object.defineProperty(dom.window.document, ev, { value: null, writable: true, configurable: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const restore: Array<() => void> = [];
function setGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restore.push(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}
export type Harness = ReturnType<typeof makeHarness>;
export function makeHarness() {
  const window = dom.window as any;
  setGlobal("fetch", undefined);
  restore.pop();
  const container = window.document.querySelector("main")! as HTMLElement; container.innerHTML = "";
  let root: Root | undefined;
  const fetchCalls: { url: string; body: any }[] = [];
  let fetchImpl: (url: string, body: any) => { status?: number; json: any } = () => ({ json: {} });
  setGlobal("fetch", async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ url: String(url), body });
    const r = String(url).includes("__token") ? { json: { token: "t" } } : fetchImpl(String(url), body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json };
  });
  const h = {
    window, container, fetchCalls,
    onFetch(fn: typeof fetchImpl) { fetchImpl = fn; },
    async render(el: ReactElement) { root ??= createRoot(container); await act(async () => root!.render(el)); },
    async unmount() { await act(async () => root?.unmount()); root = undefined; },
    q<T extends Element = HTMLElement>(sel: string) { return container.querySelector(sel) as T | null; },
    qa(sel: string) { return [...container.querySelectorAll(sel)] as HTMLElement[]; },
    byText(tag: string, text: string | RegExp) { return h.qa(tag).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) ?? null; },
    async type(el: Element, value: string) {
      if (el.tagName === "SELECT") { // linkedom has no value setter on selects: select the option, then fire change
        await act(async () => { for (const o of [...(el as HTMLSelectElement).options]) (o as any).selected = o.value === value; el.dispatchEvent(new (window as any).Event("change", { bubbles: true })); });
        return;
      }
      const proto = el.tagName === "TEXTAREA" ? (window as any).HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? (window as any).HTMLSelectElement.prototype : (window as any).HTMLInputElement.prototype;
      await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new (window as any).Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
    },
    async click(el: Element | null) { if (!el) throw new Error("click: no element"); await act(async () => { el.dispatchEvent(new (window as any).Event("click", { bubbles: true, cancelable: true })); }); },
    async submit(form: Element) { await act(async () => { form.dispatchEvent(new (window as any).Event("submit", { bubbles: true, cancelable: true })); }); },
    async wait(ms: number) { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); },
    text() { return container.textContent ?? ""; },
    cleanup() { while (restore.length) restore.pop()!(); },
  };
  return h;
}
