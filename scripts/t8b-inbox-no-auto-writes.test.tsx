// T8b lead decision: /inbox makes no automatic writes. The real InboxWorkspace is rendered (linkedom +
// react-dom) with every fetch recorded, in the state that used to trigger writes on its own: Gmail
// connected directly, a Codex mailbox selected and last synced 10 minutes ago, Skool connected. Fake
// timers then run the page for 70 s. Only GETs may go out; a click on refresh is what POSTs.
import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EMPTY_STATE } from "../src/lib/operator";

// A real in-memory TanStack router (no module mocks: bun's mock.module leaks into later test files).
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";

const requests: Array<{ method: string; path: string }> = [];
const restore: Array<() => void> = [];
let root: Root | undefined;
function setGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restore.push(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}

const stale = new Date(Date.now() - 10 * 60_000).toISOString();
function reply(path: string): unknown {
  if (path === "/__token") return { token: "page-token" };
  if (path === "/__operator/state") return { ...EMPTY_STATE, inbox: [{ id: "m1", source: "gmail", account: "owner@example.test", from: "Client <client@example.test>", subject: "Quote for the new site", body: "Hi", receivedAt: stale, status: "open" }] };
  if (path === "/__operator/connections") return { accounts: [{ id: "google", configured: true, connected: true, email: "owner@example.test", lastSync: stale, capabilities: { modify: true, send: true, drafts: true, labels: true } }], eventTypes: [] };
  if (path === "/__operator/native-connections")
    return { providers: [{ id: "gmail", name: "Gmail", available: true, enabled: true, account: "owner@example.test", lastSync: stale }, { id: "outlook", name: "Outlook", available: false }, { id: "slack", name: "Slack", available: false }], readOnly: true, discovery: { checkedAt: stale, refreshing: false, error: null } };
  if (path === "/__operator/mail-archive/status") return { total: 0, accounts: [], cache: { count: 0, bytes: 0 } };
  if (path === "/__operator/mail-archive") return { items: [], total: 0 };
  if (path === "/__operator/connections/skool") return { configured: true, connected: true, channels: [], lastSync: stale };
  return {};
}

beforeAll(async () => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("navigator", window.navigator ?? { userAgent: "test" });
  setGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  Object.defineProperty(window, "localStorage", { configurable: true, value: globalThis.localStorage });
  const location = new URL("http://127.0.0.1:5461/inbox");
  Object.defineProperty(window, "location", { configurable: true, value: location });
  setGlobal("location", location);
  setGlobal("history", { replaceState() {}, pushState() {}, state: null });
  Object.defineProperty(window, "history", { configurable: true, value: globalThis.history });
  Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => "visible" });
  setGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  setGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: globalThis.matchMedia });
  // Browser APIs linkedom lacks, as inert stand-ins (nothing here issues requests).
  const inert = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  for (const name of ["MutationObserver", "ResizeObserver", "IntersectionObserver"]) { setGlobal(name, inert); Object.defineProperty(window, name, { configurable: true, value: inert }); }
  setGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16));
  setGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  setGlobal("EventSource", class { onmessage = null; onerror = null; addEventListener() {} removeEventListener() {} close() {} });
  setGlobal("scrollTo", () => {});
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("fetch", async (input: string, init?: { method?: string }) => {
    const url = new URL(String(input), "http://127.0.0.1:5461");
    requests.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname });
    if (process.env.T8B_TRACE) console.log("[fetch]", (init?.method ?? "GET").toUpperCase(), url.pathname);
    return new Response(JSON.stringify(reply(url.pathname)), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  // The page's own timers run on the fake clock; the window's timer functions are the global ones.
  jest.useFakeTimers();
  for (const name of ["setInterval", "clearInterval", "setTimeout", "clearTimeout"]) Object.defineProperty(window, name, { configurable: true, value: (globalThis as never)[name] });
});

afterAll(() => {
  act(() => root?.unmount());
  jest.useRealTimers();
  for (const r of restore.reverse()) r();
});

const settle = async (ms: number) => {
  for (let t = 0; t < ms; t += 1000) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });
  }
};

test("opening /inbox and leaving it open for 70 s sends no POST (fake timers)", async () => {
  const { InboxWorkspace } = await import("../src/components/operator/inbox-workspace");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.querySelector("main")!;
  root = createRoot(container);
  const router = createRouter({ routeTree: createRootRoute({ component: InboxWorkspace }), history: createMemoryHistory({ initialEntries: ["/inbox"] }) });
  await act(async () => root!.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  await settle(70_000);
  const reads = requests.filter((r) => r.method === "GET");
  const writes = requests.filter((r) => r.method !== "GET");
  expect(writes).toEqual([]); // no POST, PUT or DELETE in the first 70 s
  // The page did load its data, including the mailbox list that used to trigger the sync on open...
  expect(reads.some((r) => r.path === "/__operator/native-connections")).toBe(true);
  expect(reads.some((r) => r.path === "/__operator/state")).toBe(true);
  // ...and the minute timer re-read it (GET) rather than syncing.
  expect(reads.filter((r) => r.path === "/__operator/native-connections").length).toBeGreaterThanOrEqual(2);
  expect(reads.filter((r) => r.path === "/__operator/connections").length).toBeGreaterThanOrEqual(2);
  // A click on refresh (in the Gmail view) is what fetches new mail.
  const gmailTab = [...container.querySelectorAll("button")].find((b) => (b.textContent || "").startsWith("Gmail")) as HTMLButtonElement | undefined;
  expect(gmailTab).toBeDefined();
  await act(async () => {
    gmailTab!.dispatchEvent(new window.Event("click", { bubbles: true }) as never);
  });
  await settle(1000);
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]); // choosing a source doesn't write either
  const button = container.querySelector('button[aria-label="Sync inbox"]') as HTMLButtonElement | null;
  if (process.env.T8B_TRACE) console.log("[dom]", container.innerHTML.length, [...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || b.textContent).slice(0, 40).join(" | "), container.textContent?.slice(0, 400));
  expect(button).not.toBeNull();
  await act(async () => {
    button!.dispatchEvent(new window.Event("click", { bubbles: true }) as never);
  });
  await settle(3000);
  const posted = requests.filter((r) => r.method === "POST").map((r) => r.path);
  expect(posted).toContain("/__operator/connections/sync");
}, 60_000);
