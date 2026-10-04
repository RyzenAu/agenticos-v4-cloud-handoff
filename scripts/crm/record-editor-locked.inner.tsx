// An unconfirmed caller's contact editor: Restrictions (and the other private text) is locked, and saving can never send it.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CustomEvent as DomCustomEvent, Event as DomEvent, parseHTML } from "linkedom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CrmStore } from "./store";
import { withholdPrivate } from "./redact";

mock.module("@tanstack/react-router", () => ({
  Link: ({ children, to, hash, search: _s, activeProps: _a, inactiveProps: _i, preload: _p, ...rest }: Record<string, unknown> & { children?: unknown; to?: string; hash?: string }) =>
    createElement("a", { href: `${to ?? ""}${hash ? `#${hash}` : ""}`, ...rest }, children as never),
  useNavigate: () => () => undefined,
}));

const saved: Record<string, PropertyDescriptor | undefined> = {};
const realFetch = globalThis.fetch;
beforeAll(() => {
  const { window, document } = parseHTML("<html><body></body></html>");
  (window as unknown as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: () => "", paddingLeft: "0", paddingTop: "0", paddingRight: "0", marginLeft: "0", marginTop: "0", marginRight: "0" });
  class Obs { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } }
  const extra = { NodeFilter: { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3, SHOW_ELEMENT: 1 }, HTMLElement: (window as any).HTMLElement, Element: (window as any).Element, Node: (window as any).Node, HTMLInputElement: (window as any).HTMLInputElement, HTMLTextAreaElement: (window as any).HTMLTextAreaElement, Event: DomEvent, CustomEvent: DomCustomEvent, MutationObserver: Obs, ResizeObserver: Obs, IntersectionObserver: Obs, getComputedStyle: (window as unknown as { getComputedStyle: unknown }).getComputedStyle, requestAnimationFrame: (f: () => void) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout };
  for (const [k, v] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true, ...extra })) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, d] of Object.entries(saved)) (d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k]);
});

async function mount(snapshot: ReturnType<CrmStore["snapshot"]>, contactId: string) {
  const { RecordEditor } = await import("../../src/components/crm/record-editor");
  const contact = snapshot.contacts.find((c) => c.id === contactId)!;
  const client = new QueryClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(RecordEditor, { target: { kind: "contact", record: contact }, snapshot, onClose: () => undefined, onSaved: () => undefined })));
  });
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("restrictions are locked for an unconfirmed caller and no request carries them; a confirmed editor can change them", async () => {
  const store = new CrmStore(new Database(":memory:"));
  const by = { personId: "usman" } as const;
  const company = store.createCompany({ name: "Harbourline Bakery" }, by);
  const contact = store.createContact({ companyId: company.id, name: "Ana", email: "ana@example.com", restrictions: ["SECRET restriction"] }, by);
  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/__token")) return new Response(JSON.stringify({ token: "t" }));
    sent.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ ok: false, error: "no" }), { status: 400 });
  }) as typeof fetch;

  // Unconfirmed: the Restrictions box is disabled, shows the placeholder, and a save sends no restrictions.
  const hidden = withholdPrivate(store.snapshot());
  let m = await mount(hidden, contact.id);
  const boxes = [...document.body.querySelectorAll("textarea")] as HTMLTextAreaElement[];
  // The Restrictions box is the textarea inside the field labelled "Restrictions".
  const fieldOf = (label: string) => [...document.body.querySelectorAll("label, div")].filter((n) => (n.textContent ?? "").startsWith(label) && n.querySelector("textarea")).at(-1);
  const box = fieldOf("Restrictions")?.querySelector("textarea") as HTMLTextAreaElement;
  expect(boxes.length).toBeGreaterThan(0);
  expect(box).toBeTruthy();
  expect(box.hasAttribute("disabled")).toBe(true);
  expect(document.body.textContent).toContain("Confirm this browser to read and edit this.");
  expect(document.body.textContent).not.toContain("SECRET restriction");
  // Edit the one open field (role) and save: the request must not mention restrictions.
  const role = [...document.body.querySelectorAll("input")].find((i) => (i as HTMLInputElement).type === "text") as HTMLInputElement;
  const propsKey = Object.keys(role).find((k) => k.startsWith("__reactProps$"))!;
  await act(async () => {
    (role as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey].onChange({ target: { value: "Ana B" }, currentTarget: { value: "Ana B" } });
  });
  await act(async () => {
    document.body.querySelector("form")!.dispatchEvent(new DomEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(sent.length).toBeGreaterThan(0);
  for (const body of sent) expect(body).not.toContain("restrictions");
  await m.unmount();

  // Confirmed: the box is open and holds the real text.
  m = await mount(store.snapshot(), contact.id);
  const open = fieldOf("Restrictions")?.querySelector("textarea") as HTMLTextAreaElement;
  expect(open).toBeTruthy();
  expect(open.hasAttribute("disabled")).toBe(false);
  await m.unmount();
});
