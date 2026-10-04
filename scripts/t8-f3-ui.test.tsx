// Track 8, audit F3 (System and the rest): UI truth fixes. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { categoryUsage, lastUsedText, loadPercent } from "../src/lib/skills-facts";
import { ActivityView, activityRows, formatDuration } from "../src/components/activity/activity-view";
import type { JobSummary } from "./jobs/types";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const withRouter = (node: ReactNode) => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(<RouterContextProvider router={router}>{node}</RouterContextProvider>);
};

describe("Skills (F3-03, F3-08, F3-23)", () => {
  const skills = [
    { name: "/review", category: "Review", uses: 12 },
    { name: "/audit", category: "Review", uses: 3 },
    { name: "/build", category: "Coding", uses: 199 },
    { name: "/mu-video-reference", category: "Video", uses: 0 },
  ];

  test("the chart's per-category usage comes from the list it is given", () => {
    const rows = categoryUsage(skills, ["Coding", "Review", "Video", "Memory"]);
    expect(rows).toEqual([
      { name: "Coding", uses: 199, count: 1 },
      { name: "Review", uses: 15, count: 2 },
      { name: "Video", uses: 0, count: 1 },
      { name: "Memory", uses: 0, count: 0 },
    ]);
    expect(categoryUsage([], ["Coding"])).toEqual([{ name: "Coding", uses: 0, count: 0 }]);
  });

  test("the chart data is not frozen in a memo taken before the data arrives", () => {
    const src = read("src/routes/skills.tsx");
    expect(src).toContain("const byCategory = categoryUsage(skills, skillCategories);");
    expect(src).not.toMatch(/useMemo\(\s*\(\)\s*=>\s*skillCategories/);
    expect(src).not.toMatch(/\],\s*\[\s*\]\s*,?\s*\)/); // no useMemo(..., [])
  });

  test("load is never NaN: a group whose skills all have 0 uses reads 0%", () => {
    expect(loadPercent(0, 0)).toBe(0);
    expect(loadPercent(3, 12)).toBe(25);
    expect(loadPercent(12, 12)).toBe(100);
    expect(Number.isNaN(loadPercent(Number.NaN, 5))).toBe(false);
    expect(read("src/routes/skills.tsx")).not.toContain("s.uses / maxUses");
  });

  test("never-used skills don't read 'Last used installed'", () => {
    expect(lastUsedText("installed")).toBe("Installed · no recorded use");
    expect(lastUsedText("never")).toBe("No recorded use");
    expect(lastUsedText("2h ago")).toBe("Last used 2h ago");
    expect(read("src/routes/skills.tsx")).not.toContain("Last used {s.lastUsed}");
  });

  test("time saved shows no dollar figure while the hourly rate is only assumed", () => {
    const src = read("src/routes/skills.tsx");
    expect(src).toContain("const showMoney = !rate.assumed;");
    expect(src).toMatch(/\{showMoney && <span className="ds-num text-2xl/);
    expect(src).toContain("your hourly rate isn't set");
    expect(src).toContain('placeholder="Not set"');
  });
});

describe("Activity (F3-04)", () => {
  const job = (over: Partial<JobSummary>): JobSummary => ({
    id: "j1",
    kind: "voice",
    principal: { personId: "usman", via: "loopback-owner", actor: "human" } as JobSummary["principal"],
    targetDeviceId: "hub",
    state: "succeeded",
    title: "Open the invoices folder",
    cancelRequested: false,
    quarantined: false,
    createdAt: "2026-09-28T01:00:00.000Z",
    updatedAt: "2026-09-28T01:00:42.000Z",
    stepCount: 3,
    lastStep: null,
    ...over,
  });

  test("rows come from the job history, newest first, with honest durations", () => {
    const rows = activityRows([
      job({ id: "old", createdAt: "2026-09-27T01:00:00.000Z", updatedAt: "2026-09-27T01:02:05.000Z" }),
      job({ id: "new", state: "running", title: "Email jane@example.test the quote", createdAt: "2026-09-28T02:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[0].duration).toBe("Still going");
    expect(rows[0].title).not.toContain("jane@example.test");
    expect(rows[1].duration).toBe("2 min 5 s");
    expect(rows[1].stateLabel).toBe("Done");
    expect(formatDuration(42_000)).toBe("42 s");
  });

  test("loading, failed, signed-out, empty and filled states each say what was read", () => {
    expect(withRouter(<ActivityView read={{ status: "loading" }} />)).toContain("Reading the job history");
    const failed = withRouter(<ActivityView read={{ status: "error", message: "The server answered HTTP 502" }} />);
    expect(failed).toContain("Couldn&#x27;t read the job history");
    expect(failed).toContain("HTTP 502");
    expect(failed).not.toContain("No runs yet");
    expect(withRouter(<ActivityView read={{ status: "error", message: "Signed out", signedOut: true }} />)).toContain("Sign in to see the job history");
    const empty = withRouter(<ActivityView read={{ status: "ok", jobs: [] }} />);
    expect(empty).toContain("Read just now: no jobs have been recorded on this OS yet.");
    expect(empty).toContain("Claude Code sessions you run yourself aren&#x27;t recorded here");
    const filled = withRouter(<ActivityView read={{ status: "ok", jobs: [job({})] }} />);
    expect(filled).toContain("Open the invoices folder");
    expect(filled).toContain("1 of 1 recent jobs, newest first"); // R11: the count sits in the toolbar
    const stale = withRouter(<ActivityView read={{ status: "ok", jobs: [job({})], stale: true }} />);
    expect(stale).toContain('data-stale="true"');
    expect(stale).toContain("Couldn&#x27;t refresh: showing the previous read");
  });

  test("the route reads GET /__jobs and no longer fakes rows or a model per run", () => {
    const src = read("src/routes/activity.tsx");
    expect(src).toContain('fetch("/__jobs?limit=50")');
    expect(src.includes(`title="No runs yet"`)).toBe(false);
    expect(src).not.toContain("modelForRun");
    expect(src).not.toMatch(/let runs\b/);
  });
});

describe("Devices card layout (F3-20)", () => {
  test("the profile panel's inner grids follow the panel's width, not the window's", () => {
    const src = read("src/components/profile/profile-panel.tsx");
    expect(src).toContain('<div className="@container grid gap-4">');
    expect(src).toContain('const pairGrid = "grid gap-4 @3xl:grid-cols-2";');
    expect(/className="[^"]*lg:grid-cols-2/.test(src)).toBe(false);
    expect(src).toContain("whitespace-nowrap font-mono");
  });
});

describe("Automations actions and grouping (F3-14, F3-37)", () => {
  const job = (name: string, over: Record<string, unknown> = {}) => ({
    id: name,
    name,
    schedule: "0 8 * * *",
    scheduleText: "Daily 08:00",
    active: true,
    lastRunAt: null,
    lastStatus: "ok",
    nextRunAt: "2026-09-29T08:00:00+10:00",
    deliver: "telegram:1",
    mode: "agent",
    dot: "green" as const,
    ...over,
  });

  test("paused jobs and test copies are grouped apart unless they're failing", async () => {
    const { groupAutomations, isTestCopy } = await import("../src/components/operator/automations-workspace");
    expect(isTestCopy("business-dream-test")).toBe(true);
    expect(isTestCopy("meeting-sync-test")).toBe(true);
    expect(isTestCopy("latest")).toBe(false);
    const entries = [
      job("morning-brief"),
      job("business-dream-test", { active: false, dot: "amber" }),
      job("jarvis-watchdog", { active: false, dot: "amber" }),
      job("lead-calls", { active: false, dot: "red", lastStatus: "failed" }),
      job("meeting-sync-test", { dot: "green" }),
    ].map((automation) => ({ automation }));
    const { main, aside } = groupAutomations(entries);
    expect(main.map((e) => e.automation.name)).toEqual(["lead-calls", "morning-brief"]);
    expect(aside.map((e) => e.automation.name)).toEqual(["business-dream-test", "jarvis-watchdog", "meeting-sync-test"]);
  });

  test("pause and resume are confirmed with what they do", async () => {
    const { confirmCopy } = await import("../src/components/operator/automations-workspace");
    const pause = confirmCopy({ action: "pause", automation: job("jarvis-watchdog") });
    expect(pause.title).toBe('Pause "Jarvis watchdog"?');
    expect(pause.body).toContain("It won't run again until someone resumes it");
    expect(pause.action).toBe("Pause");
    const resume = confirmCopy({ action: "resume", automation: job("morning-brief", { active: false }) });
    expect(resume.body).toBe("It runs on its schedule again (Daily 08:00) and messages Telegram.");
    expect(confirmCopy({ action: "run", automation: job("morning-brief") }).title).toBe('Run "Morning brief" now?');
    const src = read("src/components/operator/automations-workspace.tsx");
    expect(src).not.toContain('onClick={() => void act("pause", automation)}');
    expect(src).not.toContain('onClick={() => void act("resume", automation)}');
    expect(src).toContain('onClick={() => setConfirm({ action: "pause", automation })}');
    expect(src).toContain("Undo");
  });

  test("the page renders the aside group folded under its own summary", async () => {
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { AutomationsWorkspace } = await import("../src/components/operator/automations-workspace");
    const client = new QueryClient();
    client.setQueryData(["automations"], { automations: [job("morning-brief"), job("business-dream-test", { active: false, dot: "amber" })] });
    client.setQueryData(["leads-summary"], {});
    const html = withRouter(
      <QueryClientProvider client={client}>
        <AutomationsWorkspace />
      </QueryClientProvider>,
    );
    expect(html).toContain("Paused and test copies · 1");
    expect(html.indexOf("Morning brief")).toBeLessThan(html.indexOf("Paused and test copies"));
    expect(html.indexOf("Business Dream (test copy)")).toBeGreaterThan(html.indexOf("Paused and test copies"));
  });
});

describe("Copy buttons say when a copy failed (F3-18)", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), document: g.document, window: g.window };
  const restore = () => {
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
    g.document = saved.document;
    g.window = saved.window;
  };
  const fakeDom = (execOk: boolean) => {
    const removed: unknown[] = [];
    g.window = { isSecureContext: true };
    g.document = {
      body: { appendChild: () => {} },
      createElement: () => ({ value: "", style: {}, setAttribute() {}, focus() {}, select() {}, remove() { removed.push(this); } }),
      execCommand: () => execOk,
    };
    return removed;
  };
  const setClipboard = (writeText: ((t: string) => Promise<void>) | undefined) =>
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: writeText ? { writeText } : undefined } });

  test("the clipboard API succeeding is a copy", async () => {
    const { copyToClipboard } = await import("../src/lib/clipboard");
    try {
      fakeDom(false);
      let got = "";
      setClipboard(async (t) => void (got = t));
      expect(await copyToClipboard("hello")).toBe(true);
      expect(got).toBe("hello");
    } finally {
      restore();
    }
  });

  test("a rejected clipboard falls back to the textarea; both failing is reported as not copied", async () => {
    const { copyToClipboard } = await import("../src/lib/clipboard");
    try {
      const removed = fakeDom(true);
      setClipboard(() => Promise.reject(new Error("NotAllowedError")));
      expect(await copyToClipboard("x")).toBe(true);
      expect(removed.length).toBe(1);
      fakeDom(false);
      expect(await copyToClipboard("x")).toBe(false);
      setClipboard(undefined);
      expect(await copyToClipboard("x")).toBe(false);
    } finally {
      restore();
    }
  });

  test("a clipboard write that never settles doesn't hang the button", async () => {
    const { copyToClipboard } = await import("../src/lib/clipboard");
    try {
      fakeDom(true);
      setClipboard(() => new Promise<void>(() => {}));
      const started = Date.now();
      expect(await copyToClipboard("x")).toBe(true); // textarea fallback after the deadline
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      restore();
    }
  });

  test("Mission Control and the Hermes page use the shared helper and show 'Couldn't copy'", async () => {
    const { copyLabel } = await import("../src/lib/clipboard");
    expect(copyLabel("failed")).toBe("Couldn't copy");
    expect(copyLabel("copied")).toBe("Copied");
    expect(copyLabel("idle", "Copy prompt")).toBe("Copy prompt");
    const mc = read("src/components/hermes-mission-control.tsx");
    expect(mc.includes("navigator.clipboard")).toBe(false);
    expect(mc.includes("/* silent */")).toBe(false);
    expect(mc.split("/> Couldn't copy").length - 1).toBe(3); // the three buttons' failure labels
    const hermes = read("src/routes/-pages/hermes.tsx");
    expect(hermes.includes("navigator.clipboard")).toBe(false);
    expect(/copyToClipboard\([^)]*\)\.then\(\(\) => \{\s*set/.test(hermes)).toBe(false);
    expect(/async function copyToClipboard/.test(hermes)).toBe(false);
  });
});

describe("Hermes demo mode stays offline (F3-19)", () => {
  test("the OpenRouter price read is disabled in demo mode", () => {
    const src = read("src/routes/-pages/hermes.tsx");
    expect(src.includes("function useOpenRouterPrices(enabled = true)")).toBe(true);
    expect(src.includes("useOpenRouterPrices(!demo)")).toBe(true);
    expect((src.match(/fetch\("https:\/\/openrouter\.ai/g) ?? []).length).toBe(1);
  });
});

describe("Honest copy on Jarvis and OpenClaw (F3-21, F3-22)", () => {
  test("Jarvis has a real request box wired to the existing assistant (R11: the composer under the thread)", () => {
    const src = read("src/components/shell/pages/jarvis-thread.tsx");
    expect(src.includes("or type below")).toBe(false);
    expect(src.includes('id="assistant-request"')).toBe(true);
    expect(src.includes("sendJarvisRequest(request,")).toBe(true);
    expect(src.includes("Send request")).toBe(true);
  });
  test("OpenClaw's header describes the device bridge, and no coding swarm is presented (W-B: the concept cards are gone)", () => {
    const src = read("src/routes/agents.openclaw.tsx");
    expect(src.includes("Run coding tasks with parallel agents")).toBe(false);
    expect(src.includes("your autonomous coding swarm")).toBe(false);
    // The header is the one-sentence purpose (W-B moved it into src/lib/openclaw-status.ts).
    expect(src.includes("description={OPENCLAW_PURPOSE}")).toBe(true);
    expect(read("src/lib/openclaw-status.ts")).toContain("private bridge that lets Jarvis, through Hermes, do things on a paired device");
    // Nothing that no code runs is shown as a feature: no swarm modes, no swarm skills.
    expect(/Refactor Swarm|PR Reviewer|Bug Hunter|Swarm modes/.test(src)).toBe(false);
    expect(src.includes("it isn't a coding swarm")).toBe(true);
  });
});

describe("Setup and the page token (F3-24)", () => {
  const realFetch = globalThis.fetch;
  test("writes reuse one page token, and a stale token is refreshed once", async () => {
    const { operatorRequest, resetOperatorToken } = await import("../src/lib/operator");
    const calls: string[] = [];
    let token = "t1";
    let accept = "t1";
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      calls.push(String(input));
      if (input === "/__token") return new Response(JSON.stringify({ token }), { status: 200 });
      const sent = (init?.headers as Record<string, string> | undefined)?.["X-Claude-OS-Token"];
      if (init?.method === "POST" && sent !== accept)
        return new Response(JSON.stringify({ error: "Refresh this page and try again." }), { status: 403 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      resetOperatorToken();
      await operatorRequest("/profile", { name: "A" });
      await operatorRequest("/profile", { name: "B" });
      expect(calls.filter((c) => c === "/__token").length).toBe(1);
      token = "t2";
      accept = "t2"; // the server restarted: the cached token is now refused
      await operatorRequest("/profile", { name: "C" });
      expect(calls.filter((c) => c === "/__token").length).toBe(2);
      expect(calls.filter((c) => c === "/__operator/profile").length).toBe(4);
      await operatorRequest("/state");
      expect(calls.filter((c) => c === "/__token").length).toBe(2); // reads send no token
    } finally {
      globalThis.fetch = realFetch;
      resetOperatorToken();
    }
  });
  test("a refused write that isn't a stale token is not retried", async () => {
    const { operatorRequest, resetOperatorToken, OperatorRequestError } = await import("../src/lib/operator");
    let posts = 0;
    globalThis.fetch = (async (input: string) => {
      if (input === "/__token") return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      posts++;
      return new Response(JSON.stringify({ error: "This is a quiet read-only copy." }), { status: 409 });
    }) as typeof fetch;
    try {
      resetOperatorToken();
      await expect(operatorRequest("/profile", { name: "A" })).rejects.toBeInstanceOf(OperatorRequestError);
      expect(posts).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      resetOperatorToken();
    }
  });
  test("the name placeholder fits a phone-width field", () => {
    const src = read("src/components/operator/workspace-onboarding.tsx");
    expect(src.includes('placeholder="What should we call you?"')).toBe(false);
    expect(src.includes('placeholder="First name"')).toBe(true);
  });
});

describe("API keys on /usage (F3-27)", () => {
  test("a key-shaped label shows at most its last 4 characters; an owner-given name is kept", async () => {
    const { safeKeyLabel } = await import("./ai-usage/snapshot");
    expect(safeKeyLabel("sk-or-v1-abc...123")).toBe("key ending 123");
    expect(safeKeyLabel("sk-or-v1-0e6f1a2b3c4d5e6f")).toBe("key ending 5e6f");
    expect(safeKeyLabel("sk-or-v1-abc…9f2e1")).toBe("key ending f2e1");
    expect(safeKeyLabel("Hermes key")).toBe("Hermes key");
    expect(safeKeyLabel("")).toBeNull();
    expect(safeKeyLabel(null)).toBeNull();
  });
});

describe("/chat while the chat loads (F3-31)", () => {
  test("the page has a heading and a loading skeleton until the chat mounts into the host", () => {
    const src = read("src/routes/chat.tsx");
    expect(src.includes('<h1 className="sr-only">Chat</h1>')).toBe(true);
    expect(src.includes('<PageSkeleton variant="page" rows={3} label="Loading chat" />')).toBe(true);
    expect(src.includes("el.childElementCount > 0")).toBe(true);
  });
});

describe("Share-screen consent (F3-34)", () => {
  test("the consent popover is opaque", () => {
    const src = read("src/components/operator/screen-share-control.tsx");
    const tag = src.slice(src.indexOf("<div", src.indexOf("{asking && !unsupported")), src.indexOf('data-testid="share-consent"'));
    expect(tag.includes("bg-popover")).toBe(true);
    expect(tag.includes("bg-background/95")).toBe(false);
    expect(tag.includes("backdrop-blur")).toBe(false);
  });
});
