// INNER FILE: run by scripts/r6-ui-behaviour.test.ts in its own process (it installs a fake DOM that must not leak into other tests).
// Round 6 behavioural tests: components are rendered and driven, not matched as source text.
import { makeHarness, type Harness } from "./dom"; // first: it installs the DOM before React loads
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clearLeadEditDraft, LeadEditor } from "../../src/components/operator/lead-editor";
import { LogCall } from "../../src/components/operator/lead-drawer";
import type { Lead } from "../../src/lib/leads";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { useLeadsRoute } from "../../src/components/operator/use-leads-route";
import { Route as LeadsRoute } from "../../src/routes/leads";
import { leadsListQuery } from "../../src/lib/leads-queries";
import { routerRequest } from "../../src/components/shell/pages/models-page";

let h: Harness;
afterEach(async () => { await h?.unmount().catch(() => {}); h?.cleanup(); clearLeadEditDraft(7); });

const lead = (patch: Partial<Lead> = {}): Lead => ({
  id: 7, vertical: "dental", area: "Testville NSW", name: "Harbour Dental", phone: "0491 570 006", address: "", website: "", mapsUrl: "", emails: ["a@example.test"], emailOk: true,
  score: 80, pitch: "website", reasons: [], status: "to_call", owner: "", nextAt: null, lastContactAt: null, createdAt: "2026-09-01T00:00:00Z", editVersion: "v1", ...patch,
} as Lead);

describe("lead editor draft", () => {
  test("close, change the record elsewhere, reopen, save: the other change survives and only the edited field is sent", async () => {
    h = makeHarness();
    h.onFetch((url, body) => (url.includes("/leads/edit") ? { json: { lead: { ...lead(), status: "call_back", editVersion: "v3" } } } : { json: {} }));
    const noop = () => {};
    await h.render(<LeadEditor lead={lead()} by="usman" onSaved={noop} onCancel={noop} />);
    await h.type(h.q("input[type=tel]")!, "0299 887 766");
    await h.unmount(); // the drawer was closed with the edit unsaved
    // Meanwhile a call-back for 6 Oct is logged elsewhere: status, follow-up and version all moved on.
    const fresh = lead({ status: "call_back", nextAt: "2026-10-06T01:00:00.000Z", editVersion: "v2" });
    await h.render(<LeadEditor lead={fresh} by="usman" onSaved={noop} onCancel={noop} />);
    expect((h.q("input[type=tel]") as HTMLInputElement).value).toBe("0299 887 766");
    expect((h.q("select#" + (h.qa("select")[2] as HTMLElement).id) as HTMLSelectElement).value).toBe("call_back"); // status select kept the new status
    expect(h.text()).toContain("This lead changed after you started");
    await h.submit(h.q("form")!);
    const post = h.fetchCalls.find((c) => c.url.includes("/leads/edit"))!;
    expect(post.body).toEqual({ lead: 7, phone: "0299 887 766", version: "v2", by: "usman" });
    expect(post.body.status).toBeUndefined();
    expect(post.body.nextAt).toBeUndefined();
  });
  test("the changed-since notice stays after the editor has run its effects, and an unchanged lead says so plainly", async () => {
    h = makeHarness();
    const noop = () => {};
    await h.render(<LeadEditor lead={lead()} by="usman" onSaved={noop} onCancel={noop} />);
    await h.type(h.q("input[type=tel]")!, "0299 000 000");
    await h.unmount();
    await h.render(<LeadEditor lead={lead({ editVersion: "v9" })} by="usman" onSaved={noop} onCancel={noop} />);
    await h.wait(20);
    expect(h.text()).toContain("This lead changed after you started");
    await h.unmount();
    await h.render(<LeadEditor lead={lead({ editVersion: "v9" })} by="usman" onSaved={noop} onCancel={noop} />);
    expect(h.text()).toContain("This lead changed after you started"); // the draft's base was not rewritten to v9
  });
  test("Cancel editing discards the draft", async () => {
    h = makeHarness();
    await h.render(<LeadEditor lead={lead()} by="usman" onSaved={() => {}} onCancel={() => {}} />);
    await h.type(h.q("input[type=tel]")!, "0299 111 111");
    await h.click(h.byText("button", "Cancel editing"));
    await h.unmount();
    await h.render(<LeadEditor lead={lead()} by="usman" onSaved={() => {}} onCancel={() => {}} />);
    expect(h.text()).not.toContain("restored");
    expect((h.q("input[type=tel]") as HTMLInputElement).value).toBe("0491 570 006");
  });
});

describe("Do not contact", () => {
  const posts = () => h.fetchCalls.filter((c) => c.url.includes("/leads/log"));
  test("a double-click cannot arm and confirm; the confirm is a different button; Cancel backs out and has focus", async () => {
    h = makeHarness();
    let focused: any = null;
    (h.window as any).HTMLElement.prototype.focus = function () { focused = this; }; // linkedom does not track focus: record it
    await h.render(<LogCall lead={lead()} by="usman" onLogged={() => {}} />);
    const first = h.byText("button", "Do not contact")!;
    await h.click(first);
    await h.click(first); // the second click of a double-click lands on the same spot: it must do nothing
    expect(posts().length).toBe(0);
    const confirm = h.byText("button", "Confirm: do not contact")!;
    expect(confirm).not.toBe(first);
    expect(first.hasAttribute("disabled")).toBe(true); // the arming button is out of the way
    await h.click(confirm); // inside the first half second
    expect(posts().length).toBe(0);
    expect(focused?.textContent).toBe("Cancel");
    await h.click(h.byText("button", "Cancel"));
    expect(h.byText("button", "Confirm: do not contact")).toBeNull();
    expect(posts().length).toBe(0);
  });
  test("a deliberate confirm after half a second logs the opt-out once", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { ok: true } }));
    await h.render(<LogCall lead={lead()} by="usman" onLogged={() => {}} />);
    await h.click(h.byText("button", "Do not contact"));
    await h.wait(550);
    await h.click(h.byText("button", "Confirm: do not contact"));
    expect(posts().length).toBe(1);
    expect(posts()[0].body.outcome).toBe("do_not_contact");
  });
});

describe("Leads address: Back closes the drawer, ?view=today picks the workspace", () => {
  let api: ReturnType<typeof useLeadsRoute>;
  function Probe() { api = useLeadsRoute(); return <p data-open={String(api.openId)} data-ws={api.workspace} />; }
  async function mountAt(path: string) {
    h = makeHarness();
    const root = createRootRoute();
    const leads = createRoute({ getParentRoute: () => root, path: "/leads", validateSearch: (LeadsRoute as any).options.validateSearch, component: Probe });
    const history = createMemoryHistory({ initialEntries: [path] });
    const router = createRouter({ routeTree: root.addChildren([leads]), history });
    await h.render(<RouterProvider router={router} />);
    await h.wait(20);
    return { router, history };
  }
  const state = () => ({ open: h.q("p")!.getAttribute("data-open"), ws: h.q("p")!.getAttribute("data-ws") });
  test("opening a lead puts it in the address; Back closes it and keeps the list; Forward reopens", async () => {
    const { history } = await mountAt("/leads");
    expect(state()).toEqual({ open: "null", ws: "leads" });
    await h.wait(0); await (async () => { api.openLead(42); })(); await h.wait(30);
    expect(state().open).toBe("42");
    expect(history.location.search).toContain("lead=42");
    history.back(); await h.wait(30);
    expect(state().open).toBe("null");
    history.forward(); await h.wait(30);
    expect(state().open).toBe("42");
  });
  test("closing through the app returns through history (one Back, not a second entry)", async () => {
    const { history } = await mountAt("/leads");
    api.openLead(5); await h.wait(30);
    api.closeLead(); await h.wait(30);
    expect(state().open).toBe("null");
    expect(history.location.search).not.toContain("lead");
  });
  test("a deep link opens that lead, and closing it replaces instead of leaving the page", async () => {
    const { history } = await mountAt("/leads?lead=9");
    expect(state().open).toBe("9");
    api.closeLead(); await h.wait(30);
    expect(state().open).toBe("null");
    expect(history.location.pathname).toBe("/leads");
  });
  test("?lead=abc is dropped", async () => { await mountAt("/leads?lead=abc"); expect(state().open).toBe("null"); });
  test("?view=today opens the Today workspace and survives opening a lead", async () => {
    await mountAt("/leads?view=today");
    expect(state().ws).toBe("today");
    api.openLead(3); await h.wait(30);
    expect(state()).toEqual({ open: "3", ws: "today" });
    api.setWorkspace("leads"); await h.wait(30);
    expect(state().ws).toBe("leads");
  });
});

describe("the Leads list refreshes itself, and only while the tab is in front", () => {
  test("polls while visible, stops while hidden, resumes when visible again", () => {
    const out = Bun.spawnSync([process.execPath, join(import.meta.dir, "polling-probe.ts")], { cwd: join(import.meta.dir, "../..") });
    const r = JSON.parse(out.stdout.toString().trim().split("\n").pop()!);
    expect(r.visible).toBeGreaterThan(2);
    expect(r.hidden).toBe(0);
    expect(r.resumed).toBeGreaterThan(2);
  });
  test("the shipped interval is a short poll", () => { expect(leadsListQuery(false).refetchInterval).toBeLessThanOrEqual(60_000); });
});

describe("Models: Check now posts JSON", () => {
  test("the probe POST carries Content-Type: application/json and a body (the API answered 415 without them)", async () => {
    h = makeHarness();
    let seen: any = null;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (String(url).includes("__token")) return { ok: true, status: 200, json: async () => ({ token: "t" }) };
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ catalogue: {}, probes: [] }) };
    };
    await routerRequest("/model-router/probe", "POST");
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers["Content-Type"]).toBe("application/json");
    expect(seen.init.body).toBe("{}");
  });
});

describe("lead edit form: choosing Do not contact asks first", () => {
  const posts = () => h.fetchCalls.filter((c) => c.url.includes("/leads/edit"));
  test("Save shows a permanent-opt-out confirm; Cancel keeps the other edits; Confirm sends once", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { lead: { ...lead(), status: "do_not_contact", editVersion: "v2" } } }));
    await h.render(<LeadEditor lead={lead()} by="usman" onSaved={() => {}} onCancel={() => {}} />);
    await h.type(h.q("input[type=tel]")!, "0299 000 111");
    await h.type(h.qa("select")[2], "do_not_contact");
    await h.submit(h.q("form")!);
    expect(posts().length).toBe(0);
    expect(h.text()).toContain("permanent");
    await h.click(h.byText("button", "Cancel"));
    expect(h.text()).not.toContain("Confirm: do not contact");
    expect((h.q("input[type=tel]") as HTMLInputElement).value).toBe("0299 000 111");
    await h.submit(h.q("form")!);
    await h.submit(h.q("form")!);
    expect(posts().length).toBe(1);
    expect(posts()[0].body).toMatchObject({ phone: "0299 000 111", status: "do_not_contact" });
  });
  test("other status changes save without a confirm", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { lead: { ...lead(), editVersion: "v2" } } }));
    await h.render(<LeadEditor lead={lead()} by="usman" onSaved={() => {}} onCancel={() => {}} />);
    await h.type(h.qa("select")[2], "voicemail");
    await h.submit(h.q("form")!);
    expect(posts().length).toBe(1);
  });
});
