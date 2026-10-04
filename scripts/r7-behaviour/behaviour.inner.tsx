// INNER FILE: run by scripts/r7-app-usability.test.ts in its own process (it installs a fake DOM that must not leak into other tests).
// Round 7 (worker F): rendered behaviour for the shared app controls, not source-text matches.
import { makeHarness, type Harness } from "../r6-behaviour/dom"; // first: it installs the DOM before React loads
import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DecisionRow } from "../../src/components/workspace/decision-row";
import { openLeadsDetail } from "../../src/components/shell/pages/work-page";
import type { Approval } from "../../src/components/workspace/api";

let h: Harness;
afterEach(async () => { await h?.unmount().catch(() => {}); h?.cleanup(); });

const item = { id: "d1", title: "Make the retest calls", detail: "Five calls.", href: "/receptionist", recordable: true, revision: "r1" } as unknown as Approval;
const mount = async (fetchImpl?: Parameters<Harness["onFetch"]>[0]) => {
  h = makeHarness();
  if (fetchImpl) h.onFetch(fetchImpl);
  const focus: any[] = [];
  (h.window as any).HTMLElement.prototype.focus = function () { focus.push(this); }; // linkedom does not track focus: record every call
  await h.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ul><DecisionRow item={item} /></ul></QueryClientProvider>);
  return focus;
};

describe("Home and Work: recording a decision", () => {
  test("opening the form moves focus to its first control; closing it puts focus back on the button that opened it", async () => {
    const focus = await mount();
    await h.click(h.byText("button", "Record decision"));
    expect(focus.at(-1)?.tagName).toBe("SELECT");
    await h.click(h.byText("button", "Cancel"));
    expect(focus.at(-1)?.textContent).toContain("Record decision");
  });

  test("Escape closes an untouched form but never throws away a typed note", async () => {
    await mount();
    const { act } = await import("react");
    const press = async (el: Element) => { await act(async () => { const e = new (h.window as any).Event("keydown", { bubbles: true, cancelable: true }); Object.assign(e, { key: "Escape" }); el.dispatchEvent(e); }); };
    await h.click(h.byText("button", "Record decision"));
    await press(h.q("form")!);
    expect(h.q("form")).toBeNull(); // untouched: closed
    await h.click(h.byText("button", "Record decision"));
    await h.type(h.q("textarea")!, "ring Brooke after lunch");
    await press(h.q("form")!);
    expect(h.q("form")).not.toBeNull(); // typed: kept
    expect((h.q("textarea") as HTMLTextAreaElement).value).toBe("ring Brooke after lunch");
  });

  test("a failed save says so and keeps the typed note", async () => {
    await mount((url) => (url.includes("/workspace/decision") ? { status: 500, json: { error: "The decisions file couldn't be written." } } : { json: {} }));
    await h.click(h.byText("button", "Record decision"));
    await h.type(h.q("textarea")!, "not this week");
    await h.submit(h.q("form")!);
    await h.wait(20);
    expect(h.text()).toContain("Decision wasn't saved");
    expect(h.text()).toContain("The decisions file couldn't be written.");
    expect((h.q("textarea") as HTMLTextAreaElement).value).toBe("not this week");
    expect(h.fetchCalls.find((c) => c.url.includes("/workspace/decision"))!.body).toMatchObject({ id: "d1", note: "not this week" });
    expect(h.q("form")).not.toBeNull(); // still open for another try
  });
});

describe("An unconfirmed browser cannot record a decision", () => {
  test("while pending, Record decision is disabled with the reason, matching the banner", async () => {
    await mount((url) => (url.includes("/__devices/me") ? { json: { authorised: true, hubSession: { pending: true } } } : { json: {} }));
    await h.wait(30);
    const button = h.byText("button", "Record decision")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("Confirm this browser first");
    // Round 11: the note is said once above the decision list (DecisionsPendingNote), never repeated inside each row.
    expect(h.text()).not.toContain("Confirm this browser first: it can't record decisions until you do.");
  });
  test("a confirmed browser can; a 403 from the server is explained and keeps what was typed", async () => {
    await mount((url) => (url.includes("/workspace/decision") ? { status: 403, json: { error: "Confirm this browser first (System › Devices and people), then record the decision.", reason: "needs-human-session" } } : { json: {} }));
    await h.wait(30);
    expect(h.byText("button", "Record decision")!.hasAttribute("disabled")).toBe(false);
    await h.click(h.byText("button", "Record decision"));
    await h.type(h.q("textarea")!, "keep this");
    await h.submit(h.q("form")!);
    await h.wait(20);
    expect(h.text()).toContain("This browser isn't confirmed yet, so it can't record decisions.");
    expect((h.q("textarea") as HTMLTextAreaElement).value).toBe("keep this");
  });
});

describe("Work: the open-leads tile adds only what the count does not say", () => {
  test("the count in words is dropped, proposals and the not-read note are kept", () => {
    expect(openLeadsDetail("6 open leads", 6)).toBeUndefined();
    expect(openLeadsDetail("1 open lead", 1)).toBeUndefined();
    expect(openLeadsDetail("6 open leads · 2 proposals out (A$4,000)", 6)).toBe("2 proposals out (A$4,000)");
    expect(openLeadsDetail("Pipeline not read", null)).toBe("Pipeline not read");
  });
});

import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { useSettingsTab } from "../../src/lib/settings-tab";
import { WorkAnswer } from "../../src/components/shell/pages/work-page";

describe("Settings tabs are steps in history", () => {
  let api: ReturnType<typeof useSettingsTab>;
  function Probe() { api = useSettingsTab(); return <p data-tab={api.section} />; }
  async function mountAt(path: string) {
    h = makeHarness();
    const root = createRootRoute();
    const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: Probe });
    const history = createMemoryHistory({ initialEntries: [path] });
    const router = createRouter({ routeTree: root.addChildren([settings]), history });
    await h.render(<RouterProvider router={router} />);
    await h.wait(20);
    return { history, router };
  }
  const tab = () => h.q("p")!.getAttribute("data-tab");
  test("a click goes to the tab and Back returns to the one before; Forward goes again", async () => {
    const { history, router } = await mountAt("/settings");
    expect(tab()).toBe("personal-profile");
    api.select("connections"); await h.wait(30);
    expect(tab()).toBe("connections");
    expect(history.location.hash).toBe("#connections");
    expect(router.history.canGoBack()).toBe(true); // the router's own index moved: Back is available
    history.back(); await h.wait(30);
    expect(tab()).toBe("personal-profile");
    expect(history.location.pathname).toBe("/settings"); // still on the page
    history.forward(); await h.wait(30);
    expect(tab()).toBe("connections");
  });
  test("choosing the tab already showing adds no entry, and the arrow keys replace instead of stacking", async () => {
    const { history } = await mountAt("/settings");
    const before = history.length;
    api.select("personal-profile"); await h.wait(20);
    expect(history.length).toBe(before);
    api.select("connections"); await h.wait(20);
    api.select("ai-tools", true); await h.wait(20);
    api.select("jarvis", true); await h.wait(20);
    expect(history.length).toBe(before + 1); // one entry for the click, the arrows replaced it
    history.back(); await h.wait(30);
    expect(tab()).toBe("personal-profile");
  });
  test("an unknown hash is the first tab", async () => {
    await mountAt("/settings#nonsense");
    expect(tab()).toBe("personal-profile");
  });
});

describe("Work: each count is a link to its items", () => {
  test("Decisions anchors to the list; Calls, Open leads and Sites go to their pages", async () => {
    h = makeHarness();
    const root = createRootRoute();
    const view = { tone: "warn", title: "7 decisions wait on you", why: "", facts: ["No calls due", "6 open leads", "All 7 sites answering"], next: "approvals", approvals: 7, calls: 0, open: 6, sites: { down: 0, total: 7 }, errors: 0 } as any;
    const work = createRoute({ getParentRoute: () => root, path: "/work", component: () => <WorkAnswer v={view} /> });
    const leads = createRoute({ getParentRoute: () => root, path: "/leads", component: () => null });
    const websites = createRoute({ getParentRoute: () => root, path: "/websites", component: () => null });
    const router = createRouter({ routeTree: root.addChildren([work, leads, websites]), history: createMemoryHistory({ initialEntries: ["/work"] }) });
    await h.render(<RouterProvider router={router} />);
    await h.wait(30);
    const href = (label: string) => h.qa("dt a").find((a) => a.textContent === label)?.getAttribute("href");
    expect(href("Decisions")).toBe("#ws-today");
    expect(href("Calls to make")).toContain("/leads");
    expect(href("Calls to make")).toContain("view=today");
    expect(href("Open leads")).toBe("/leads");
    expect(href("Sites down")).toBe("/websites");
    expect(h.text()).not.toContain("6 open leads"); // the count is not said twice
  });
});

import { LogCall } from "../../src/components/operator/lead-drawer";
describe("Leads: a double-click on a call outcome logs one call", () => {
  const lead = { id: 7, vertical: "dental", area: "Testville NSW", name: "Harbour Dental", phone: "0491 570 006", address: "", website: "", mapsUrl: "", emails: [], emailOk: true, score: 80, pitch: "website", reasons: [], status: "to_call", owner: "", nextAt: null, lastContactAt: null, createdAt: "2026-09-01T00:00:00Z", editVersion: "v1" } as any;
  const logs = () => h.fetchCalls.filter((c) => c.url.includes("/leads/log"));
  test("two clicks before the first answer send one request, with an event key", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { ok: true } }));
    await h.render(<LogCall lead={lead} by="usman" onLogged={() => {}} />);
    const noAnswer = h.byText("button", "No answer")!;
    const { act } = await import("react");
    await act(async () => { for (let i = 0; i < 2; i++) noAnswer.dispatchEvent(new (h.window as any).Event("click", { bubbles: true, cancelable: true })); });
    await h.wait(20);
    expect(logs().length).toBe(1);
    expect(typeof logs()[0].body.event).toBe("string");
    expect(logs()[0].body.event.startsWith("7:")).toBe(true);
  });
  test("a FAST hub (answers at once) and two clicks 30 ms apart log exactly one call", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { ok: true } })); // resolves immediately: the first save is done before the second click
    await h.render(<LogCall lead={lead} by="usman" onLogged={() => {}} />);
    await h.click(h.byText("button", "No answer"));
    await h.wait(30);
    await h.click(h.byText("button", "No answer"));
    await h.wait(30);
    expect(logs().length).toBe(1);
  });
  test("a different outcome straight after is a different call with its own key", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { ok: true } }));
    await h.render(<LogCall lead={lead} by="usman" onLogged={() => {}} />);
    await h.click(h.byText("button", "No answer"));
    await h.wait(30);
    const other = h.qa("button").find((b) => /Voicemail|Left message|Not interested/i.test(b.textContent ?? ""));
    expect(other).toBeTruthy();
    await h.click(other!);
    await h.wait(30);
    expect(logs().length).toBe(2);
    expect(logs()[1].body.event).not.toBe(logs()[0].body.event);
  });
  test("a retry after a failed answer reuses the key, so the server can drop the duplicate", async () => {
    h = makeHarness();
    let n = 0;
    h.onFetch(() => (++n === 1 ? { status: 500, json: { error: "dropped" } } : { json: { ok: true } }));
    await h.render(<LogCall lead={lead} by="usman" onLogged={() => {}} />);
    await h.click(h.byText("button", "No answer"));
    await h.wait(20);
    await h.click(h.byText("button", "No answer"));
    await h.wait(20);
    expect(logs().length).toBe(2);
    expect(logs()[1].body.event).toBe(logs()[0].body.event);
  });
});

import { useOpenOnHash } from "../../src/components/shell/use-open-on-hash";
describe("System: Pair or confirm a browser works from System itself", () => {
  test("a router navigation to #system-devices opens the closed section (the router fires no hashchange)", async () => {
    h = makeHarness();
    (globalThis as any).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
    let fired = 0;
    function Probe() { const [open] = useOpenOnHash("system-devices", () => { fired++; }); return <details open={open} data-open={String(open)}><summary>Plan usage, devices &amp; runtime</summary></details>; }
    const root = createRootRoute();
    const system = createRoute({ getParentRoute: () => root, path: "/system", component: Probe });
    const router = createRouter({ routeTree: root.addChildren([system]), history: createMemoryHistory({ initialEntries: ["/system"] }) });
    await h.render(<RouterProvider router={router} />);
    await h.wait(30);
    expect(h.q("details")!.getAttribute("data-open")).toBe("false");
    const { act } = await import("react");
    await act(async () => { await router.navigate({ to: "/system", hash: "system-devices" } as never); });
    await h.wait(50);
    expect(h.q("details")!.getAttribute("data-open")).toBe("true");
    expect(fired).toBe(1);
  });
  test("another hash leaves it closed", async () => {
    h = makeHarness();
    function Probe() { const [open] = useOpenOnHash("system-devices"); return <p data-open={String(open)} />; }
    const root = createRootRoute();
    const system = createRoute({ getParentRoute: () => root, path: "/system", component: Probe });
    const router = createRouter({ routeTree: root.addChildren([system]), history: createMemoryHistory({ initialEntries: ["/system#other"] }) });
    await h.render(<RouterProvider router={router} />);
    await h.wait(30);
    expect(h.q("p")!.getAttribute("data-open")).toBe("false");
  });
});

import { PaletteLoadBoundary } from "../../src/components/shell/palette-boundary";
describe("Ctrl+K when the palette's code cannot load", () => {
  test("a failed load shows one line and leaves the page in place", async () => {
    h = makeHarness();
    function Broken(): never { throw new Error("Failed to fetch dynamically imported module"); }
    const origError = console.error; console.error = () => {};
    try {
      await h.render(<div><p id="page">the page stays</p><PaletteLoadBoundary><Broken /></PaletteLoadBoundary></div>);
      await h.wait(20);
    } finally { console.error = origError; }
    expect(h.q("[role=status]")!.textContent).toMatch(/Go to… (can't open while you're offline|couldn't load)/);
    expect(h.q("#page")!.textContent).toBe("the page stays");
  });
});
