// Programme C round 2: idle polling, the active-device slot, computers, phone navigation and motion holds.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUD_OFFLINE_AFTER_MS, HUD_POLL_MS } from "../src/lib/jarvis-hud";
import { JOB_IDLE_POLL_MS, nextPollDelay } from "../src/lib/job-events";
import { activeDevice, deviceSlotInput } from "../src/lib/use-devices";
import { NO_SCREEN, controllerText, personalFromDevice, viewActions } from "../src/lib/computers-client";
import { mock } from "bun:test";
// The row links with the router's Link; a plain anchor stands in so the row can be rendered without a router.
// Bun module mocks last for the whole test process, so this stand-in must render like the real Link for later files:
// keep className, aria/data attributes and params-filled hrefs (it broke the workspace switcher test in the full suite).
mock.module("@tanstack/react-router", () => ({
  Link: ({ children, to, params, search: _search, activeProps: _a, inactiveProps: _i, preload: _p, ...rest }: { children?: React.ReactNode; to?: string; params?: Record<string, string>; search?: unknown; activeProps?: unknown; inactiveProps?: unknown; preload?: unknown; [k: string]: unknown }) => {
    const href = typeof to === "string" && params ? to.replace(/\$([A-Za-z_]\w*)/g, (_m, k: string) => String(params[k] ?? "")) : to;
    return <a href={href} {...(rest as Record<string, unknown>)}>{children}</a>;
  },
}));
const { ComputerRow } = await import("../src/components/computers/computers-page");
import { Tabs, Segmented, deviceSlotView } from "../src/components/ds";
import { TALKING_PHASES } from "../src/lib/motion";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";


const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("idle polling", () => {
  test("the HUD reads 3 endpoints every 45 s (4 requests a minute), none while hidden", () => {
    expect(HUD_POLL_MS).toBe(45_000);
    expect(3 * (60_000 / HUD_POLL_MS)).toBeLessThanOrEqual(4);
    expect(HUD_OFFLINE_AFTER_MS).toBeGreaterThan(HUD_POLL_MS * 2);
    const src = read("src/components/operator/jarvis-hud.tsx");
    expect(src).not.toContain("refetchIntervalInBackground: true");
  });
  test("job events poll fast only while a job is active or just changed", () => {
    expect(nextPollDelay(2000, [], 10 * 60_000)).toBe(JOB_IDLE_POLL_MS);
    expect(nextPollDelay(2000, [{ state: "running" }], 10 * 60_000)).toBe(2000);
    expect(nextPollDelay(2000, [], 5_000)).toBe(2000);
    expect(nextPollDelay(2000, [{ state: "awaiting-approval" }], 10 * 60_000)).toBe(2000);
  });
});

describe("active device slot", () => {
  const devices = [
    { id: "hub", kind: "hub", online: true },
    { id: "m", kind: "worker", label: "Mehroz PC", owner: "mehroz", online: true },
    { id: "u", kind: "worker", label: "Desk", owner: "usman", online: false, mine: true },
  ];
  test("your own paired PC first; offline is said in words", () => {
    const d = activeDevice(devices);
    expect(d?.id).toBe("u");
    expect(deviceSlotView(deviceSlotInput(d))).toEqual({ name: "This PC", state: "offline", word: "Offline" });
  });
  test("no devices reported means no claim", () => {
    expect(activeDevice([])).toBeNull();
    expect(deviceSlotView(deviceSlotInput(null)).name).toBeNull();
  });
  test("the Jarvis page shows the slot from the registry", () => {
    const src = read("src/components/shell/pages/jarvis-page.tsx");
    expect(src).toContain("DeviceStatusSlot");
    expect(src).toContain("useDevices");
  });
});

describe("computers", () => {
  const view = (over: Record<string, unknown> = {}) => ({ name: "research", id: "d1", label: "Research", kind: "cloud-computer", owner: "shared", adapter: "wsl", state: "online", desired: "running", desktop: false, capabilities: ["browser"], assigned: null, controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null }, takeoverPending: null, paused: null, resource: null, lastSeen: 1, failure: null, recoveries: 0, createdBy: "usman", createdAt: 1, viewer: { snapshot: false, vnc: false }, ...over }) as never;
  test("buttons follow the state and who holds the lease", () => {
    expect(viewActions(view(), "usman")).toEqual(["preview", "take-control", "stop"]);
    expect(viewActions(view({ state: "busy", controller: { kind: "agent", who: "builder", jobId: "j", expiresAt: null, epoch: 1 } }), "usman")).toEqual(["preview", "request-control", "stop"]);
    expect(viewActions(view({ state: "busy", controller: { kind: "person", who: "usman", jobId: null, expiresAt: 1, epoch: 2 } }), "usman")).toEqual(["preview", "return", "stop"]);
    expect(viewActions(view({ state: "busy", controller: { kind: "person", who: "mehroz", jobId: null, expiresAt: 1, epoch: 2 } }), "usman")).toEqual(["preview", "stop"]);
    expect(viewActions(view({ takeoverPending: { by: "usman", requestedAt: 1 } }), "usman")).toEqual(["preview", "stop"]);
    expect(viewActions(view({ state: "offline" }), "usman")).toEqual(["start"]);
    expect(viewActions(view({ state: "starting" }), "usman")).toEqual(["stop"]);
  });
  test("the controller is named in words", () => {
    expect(controllerText(view({ controller: { kind: "person", who: "usman" } }), "usman")).toBe("You");
    expect(controllerText(view({ controller: { kind: "person", who: "mehroz" } }), "usman", (x) => x.toUpperCase())).toBe("MEHROZ");
    expect(controllerText(view({ controller: { kind: "agent", who: "builder" } }), "usman")).toBe("Agent builder");
    expect(controllerText(view({ takeoverPending: { by: "usman", requestedAt: 1 } }), "usman", (x) => x)).toContain("pauses at its next safe step");
    expect(controllerText(view(), "usman")).toBe("Nobody");
  });
  test("a PC comes from the registry with only what it reports", () => {
    expect(personalFromDevice({ id: "u", mine: true, online: true }).name).toBe("This PC");
    expect(personalFromDevice({ id: "u", label: "Desk" }).state).toBeNull();
  });
  test("a shared row shows its state, controller and 'not reported' cost; its job links to the coding page", () => {
    const out = html(
      <QueryClientProvider client={new QueryClient()}>
        <ComputerRow c={view({ state: "busy", controller: { kind: "agent", who: "builder" } })} me="usman" onAct={() => {}} />
      </QueryClientProvider>,
    );
    expect(out).toContain("Busy");
    expect(out).toContain("Request control");
    expect(out).toContain("Open computer");
    expect(out).toContain("cost not reported");
    expect(out).not.toContain("A$0");
  });
  test("the headless message is the one agreed", () => {
    expect(NO_SCREEN).toBe("No screen on this computer yet (desktop packages not installed).");
  });
  test("System lists Computers", () => {
    expect(read("src/components/shell/destinations.ts")).toContain('to: "/computers"');
  });
});

describe("phone navigation", () => {
  test("tabs and segmented controls with 4+ options also render a select for phones", () => {
    const tabs = [1, 2, 3, 4].map((n) => ({ id: `t${n}`, label: `Tab ${n}` }));
    const t = html(<Tabs tabs={tabs} value="t1" onChange={() => {}} idBase="x" label="Sections" />);
    expect(t).toContain("<select");
    expect(t).toContain("sm:hidden");
    expect(t).toContain('role="tablist"');
    const few = html(<Tabs tabs={tabs.slice(0, 3)} value="t1" onChange={() => {}} idBase="x" label="Sections" />);
    expect(few).not.toContain("<select");
    const seg = html(<Segmented value="a" ariaLabel="Jobs" onChange={() => {}} options={["a", "b", "c", "d"].map((v) => ({ value: v, label: v }))} />);
    expect(seg).toContain("<select");
  });
});

describe("motion holds", () => {
  test("speaking holds ambient motion and open approvals mark themselves", () => {
    expect(TALKING_PHASES.has("speaking")).toBe(true);
    expect(read("src/components/workspace/decision-row.tsx")).toContain("data-approval-open");
    expect(read("src/components/operator/agent-jobs-panel.tsx")).toContain("data-approval-open");
  });
});

describe("cloud role does not read the owner's home", () => {
  test("ai-usage uses a data-dir path instead of the home directory in the cloud role", () => {
    const src = read("scripts/ai-usage/plugin.ts");
    expect(src).toContain('hubRole() === "cloud"');
    expect(src).toContain("no-owner-home");
  });
});

describe("round 3: coding job summary", () => {
  const mkRun = (over: Record<string, unknown> = {}) => ({ roleId: "b1", role: "builder", state: "running", attempt: 1, who: { route: "claude", accountSlot: "claude:max", model: "sonnet" }, error: null, attempts: [{ turn: 1, account: "claude:max", requestedModel: "claude-opus-5-5", reportedModel: "claude-sonnet-5-5", modelMismatch: true, outcome: "ok", location: "this-pc" }], ...over });
  const readable = (runs: unknown[], extra: Record<string, unknown> = {}) => ({ plan: { objective: "Fix it", nonGoals: [], doneWhen: [{ id: "d1", text: "x", evidence: "test", met: true, note: null }], checks: [], roles: [] }, progress: { state: "running", stateText: "Running", needsYou: null, phases: [{ id: "building", label: "Build", status: "active", detail: null }], runs, fallbacks: [], recent: [] }, diff: { totals: { files: 2, additions: 10, deletions: 3 }, outsideOwnership: [] }, tests: { latest: { passed: 4, failed: 0, skipped: 0, timedOut: false, matchesHead: true }, baselineFailed: null, runs: 1 }, review: null, result: { state: "running", nextStep: "Running", gate: null, merged: false, applies: [], jobBranch: "coding/x" }, context: { sources: [] }, location: "cloud", ...extra });
  test("a model mismatch is stated plainly", async () => {
    const { modelMismatchText, currentRun } = await import("../src/components/coding/job-summary");
    const r = readable([mkRun()]) as never;
    expect(modelMismatchText(currentRun(r, ["b1"]))).toBe("Asked for claude-opus-5-5 but the provider reported claude-sonnet-5-5.");
    expect(modelMismatchText(mkRun({ attempts: [{ ...mkRun().attempts[0], modelMismatch: false }] }) as never)).toBeNull();
  });
  test("the location names a cloud computer only when a receipt did", async () => {
    const { locationSlot } = await import("../src/components/coding/job-summary");
    expect(locationSlot(readable([]) as never, [{ executionLocation: "cloud", executionDevice: "box-1" }] as never)).toMatchObject({ label: "Cloud computer box-1" });
    expect(locationSlot(readable([], { location: "this-pc" }) as never, [] as never)).toMatchObject({ isThisPc: true });
    expect(locationSlot(readable([], { location: null }) as never, [] as never)).toBeNull();
  });
  test("the summary renders the plain rows and leaves the events to Details", async () => {
    const { JobSummary } = await import("../src/components/coding/job-summary");
    const out = html(<JobSummary view={{ job: { state: "building" }, readable: readable([mkRun()]), liveRoles: ["b1"], receipts: [] } as never} onOpenTab={() => {}} />);
    for (const w of ["Objective", "Working now", "Account and model", "Runs on", "Changes", "Tests", "Review", "Integration", "Different model than requested"]) expect(out).toContain(w);
    expect(out).toContain("4 passed, 0 failed");
    expect(read("src/components/coding/job-detail.tsx")).toContain("Details: events, prompts and diagnostics");
  });
  test("the coding list puts active work above the composer and offers a repo choice", () => {
    const src = read("src/components/coding/coding-list.tsx");
    expect(src).toContain("activeFirst && jobsWidget");
    expect(src).toContain('htmlFor="coding-repo"');
  });
});

describe("round 5: live viewer", () => {
  test("the preview picks live, snapshot or 'no screen' from what the hub reports", async () => {
    const { PreviewPanel, viewerStatusText, parseViewerMessage } = await import("../src/components/computers/computers-page");
    const live = html(<PreviewPanel name="research" holding={false} viewer={{ snapshot: true, vnc: true }} />);
    expect(live).toContain('src="/__computers/research/viewer?bare=1"');
    expect(live).toContain("<iframe");
    expect(live).toContain("Connecting to the screen");
    expect(html(<PreviewPanel name="research" holding={false} viewer={{ snapshot: true, vnc: false }} />)).not.toContain("<iframe");
    const none = html(<PreviewPanel name="research" holding={false} viewer={{ snapshot: false, vnc: false }} />);
    expect(none).toContain("No screen on this computer yet (desktop packages not installed).");
    expect(none).not.toContain("<iframe");
    expect(viewerStatusText({ connected: true, canControl: false })).toContain("view-only");
    expect(viewerStatusText({ connected: true, canControl: true })).toContain("You hold the controls");
    expect(viewerStatusText({ connected: false, canControl: null })).toContain("disconnected");
  });
  test("only the matching viewer's messages are believed", async () => {
    const { parseViewerMessage } = await import("../src/components/computers/computers-page");
    expect(parseViewerMessage({ source: "mu-computer-viewer", name: "research", connected: true }, "research")).toMatchObject({ connected: true });
    expect(parseViewerMessage({ source: "mu-computer-viewer", name: "other", connected: true }, "research")).toBeNull();
    expect(parseViewerMessage({ source: "something-else", name: "research" }, "research")).toBeNull();
    expect(parseViewerMessage(null, "research")).toBeNull();
  });
  test("the notices name noVNC, its licence, version, source and that it is unmodified", () => {
    const n = read("THIRD-PARTY-NOTICES.md");
    for (const w of ["noVNC", "MPL-2.0", "1.7.0", "https://github.com/novnc/noVNC", "Unmodified"]) expect(n).toContain(w);
  });
});

describe("Computers: a confirmed Stop overrides a running job (lead fix, 1 Oct)", () => {
  test("stop posts force: true; start does not", async () => {
    const { computerAction } = await import("../src/lib/computers-client");
    const sent: Array<{ url: string; body: any }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url) === "/__token") return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      await computerAction("research", "stop");
      await computerAction("research", "start");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent).toEqual([
      { url: "/__computers/research/action", body: { action: "stop", force: true } },
      { url: "/__computers/research/action", body: { action: "start" } },
    ]);
  });
});
