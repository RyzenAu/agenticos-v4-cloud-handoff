// W-C UI: Make Hermes yours (profile + skills cards), calmer Automations and Jarvis. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { OwnerProfileCard, SkillSyncCard, skillsHeadline, splitProfileEntry } from "../../src/components/hermes-customise";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", "..", p), "utf8");
const withClient = (client: QueryClient, node: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
const withRouter = (node: ReactNode) => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(<RouterContextProvider router={router}>{node}</RouterContextProvider>);
};

const MARK = "Owner profile (Agentic OS, from the M&U wiki)";
const profileState = (over: Record<string, unknown> = {}) => ({
  path: "C:/synthetic/.hermes/memories/USER.md",
  exists: true,
  limit: 1375,
  current: [`${MARK}, who he is: Sam Example, called Sam.`, `${MARK}, business: Co-founder of Example Co.`, `${MARK}, mission: grow Example Co.`],
  others: ["Prefers short replies."],
  proposed: [`${MARK}, who he is: Sam Example, called Sam.`, `${MARK}, business: Co-founder of Example Co.`, `${MARK}, mission: grow Example Co.`],
  inSync: true,
  usageAfter: 180,
  fits: true,
  sources: ["C:/synthetic/wiki/topics/personal/usman/usman.md"],
  warnings: [],
  ...over,
});
const report = {
  dryRun: false,
  hermesSkillsDir: "C:/synthetic/.hermes/skills",
  category: "claude-skills",
  backup: null,
  results: [
    { name: "offer-check", origin: "claude", outcome: "added", files: 2, withheld: [{ file: ".env", reason: "a credential or environment file" }] },
    { name: "site-polish", origin: "claude", outcome: "unchanged", files: 1, withheld: [] },
  ],
  skipped: [{ name: "ask-first", origin: "claude", reason: "asks its questions through Claude Code's AskUserQuestion tool" }],
  orphaned: [],
  counts: { added: 1, updated: 0, unchanged: 1, kept: 0, skipped: 1 },
  finishedAt: "2026-09-29T04:00:00.000Z",
};

describe("Make Hermes yours", () => {
  test("profile entries read as labelled sentences", () => {
    expect(splitProfileEntry(`${MARK}, who he is: Sam Example.`)).toEqual({ label: "Who he is", text: "Sam Example." });
    expect(splitProfileEntry("Something Hermes learned.")).toEqual({ label: "Profile", text: "Something Hermes learned." });
  });

  test("the profile card shows the first entry, folds the rest, and says it's up to date", () => {
    const client = new QueryClient();
    client.setQueryData(["hermes-owner-profile"], { state: profileState() });
    const html = withClient(client, <OwnerProfileCard />);
    expect(html).toContain("Who Hermes thinks you are");
    expect(html).toContain("Up to date");
    expect(html).toContain("Sam Example, called Sam.");
    expect(html).toContain("Business and mission"); // the folded entries' disclosure
    expect(html).toContain("180 of 1,375 characters");
    expect(html).toContain("Refresh from wiki");
    expect(html).toContain("1 entry Hermes learned itself stay as they are.");
    expect(html).not.toContain("Owner profile (Agentic OS"); // the marker is plumbing, not copy
  });

  test("a profile not yet written offers to add it; one that doesn't fit can't be written", () => {
    const client = new QueryClient();
    client.setQueryData(["hermes-owner-profile"], { state: profileState({ current: [], inSync: false, exists: false, others: [] }) });
    const html = withClient(client, <OwnerProfileCard />);
    expect(html).toContain("Not added yet");
    expect(html).toContain("Add to Hermes");
    const tight = new QueryClient();
    tight.setQueryData(["hermes-owner-profile"], { state: profileState({ fits: false, inSync: false, warnings: ["The profile would use 1400 of 1375 characters in USER.md."] }) });
    const html2 = withClient(tight, <OwnerProfileCard />);
    expect(html2).toContain("1400 of 1375");
    expect(html2).toMatch(/<button[^>]*disabled[^>]*>[^]*?Refresh from wiki/);
  });

  test("the skills card says how many are in Hermes, what was left out and what was withheld", () => {
    expect(skillsHeadline(null).title).toBe("Not synced yet");
    expect(skillsHeadline(report as never)).toEqual({ title: "2 of your skills are in Hermes", detail: "1 added or updated on the last sync · 1 left out" });
    const client = new QueryClient();
    client.setQueryData(["hermes-skill-sync"], { report, running: false });
    const html = withClient(client, <SkillSyncCard />);
    expect(html).toContain("Your skills in Hermes");
    expect(html).toContain("of your skills are in Hermes. 1 added or updated on the last sync · 1 left out.");
    expect(html).toContain("Sync skills now");
    expect(html).toContain("Preview changes");
    expect(html).toContain("Left out, and why");
    expect(html).toContain("AskUserQuestion");
    expect(html).toContain("Files withheld");
    expect(html).toContain("offer-check/.env");
  });

  test("never synced: a dash, not a made-up zero", () => {
    const client = new QueryClient();
    client.setQueryData(["hermes-skill-sync"], { report: null, running: false });
    const html = withClient(client, <SkillSyncCard />);
    expect(html).toContain(">—<");
    expect(html).toContain("Hermes doesn&#x27;t have your Claude Code skills yet.");
    expect(html).not.toContain("0 of your skills");
  });

  test("the Hermes Overview mounts the section (profile and skills) and no longer invents a version", () => {
    const src = read("src/routes/-pages/hermes.tsx");
    // L4: the Overview tab carries the status widgets, the live stats, then the owner's profile and skills.
    const overview = src.slice(src.indexOf("function HermesOverview"));
    expect(overview.indexOf("<HermesLiveStats />")).toBeGreaterThan(-1);
    expect(overview.indexOf("<HermesLiveStats />")).toBeLessThan(overview.indexOf("<HermesCustomiseSection />"));
    expect(src).not.toContain('"v0.13.0"');
    expect(src).toContain('useHermesIntegrations(mode === "global")');
  });
});

describe("Automations, calmer (W-C)", () => {
  const job = (name: string, over: Record<string, unknown> = {}) => ({
    id: name,
    name,
    schedule: "0 8 * * *",
    scheduleText: "Daily 08:00",
    active: true,
    lastRunAt: "2026-09-28T22:00:00.000Z",
    lastStatus: "ok",
    nextRunAt: "2026-09-29T22:00:00.000Z",
    deliver: "telegram:1",
    mode: "agent",
    dot: "green" as const,
    ...over,
  });
  const render = (automations: unknown[]) => {
    const client = new QueryClient();
    client.setQueryData(["automations"], { automations });
    client.setQueryData(["leads-summary"], {});
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AutomationsWorkspace } = require("../../src/components/operator/automations-workspace");
    return withRouter(<QueryClientProvider client={client}><AutomationsWorkspace /></QueryClientProvider>);
  };

  test("one plain headline first, then equal stat cards, then the jobs", () => {
    const html = render([job("morning-brief"), job("site-monitor", { nextRunAt: "2026-09-29T20:00:00.000Z" }), job("business-dream-test", { active: false, dot: "amber" })]);
    expect(html).toContain("All 2 running jobs are healthy. Next up: Website monitor");
    expect(html).toContain("healthy, running on schedule");
    expect(html).toContain("paused, won&#x27;t run until resumed");
    expect(html).toContain("next: Website monitor");
    expect(html).not.toContain("ds-ring");
    expect(html.indexOf("All 2 running jobs are healthy")).toBeLessThan(html.indexOf(">Morning brief<"));
    // Details are folded, not removed: delivery and last run are still in the page.
    expect(html).toContain("Details");
    expect(html).toContain("messages Telegram");
    expect(html).toContain("Last run");
    expect(html).toContain("Paused and test copies · 1");
  });

  test("a failing job turns the verdict red and leads the list with what to do", () => {
    const html = render([job("morning-brief"), job("lead-calls", { dot: "red", lastStatus: "failed" })]);
    expect(html).toContain("1 job is failing. Fix it first");
    expect(html.indexOf(">Today&#x27;s call list<")).toBeLessThan(html.indexOf(">Morning brief<"));
  });

  test("every job paused is said plainly", () => {
    const html = render([job("morning-brief", { active: false, dot: "amber" })]);
    expect(html).toContain("Every job is paused. Nothing runs until one is resumed.");
  });
});

describe("Jarvis page keeps its features; R11: the conversation is the page", () => {
  test("the thread leads, hand-offs sit beside it; HUD and workflow previews stay reachable as secondary views; no duplicate nav row", () => {
    const file = read("src/components/shell/pages/jarvis-page.tsx");
    const src = file.slice(file.indexOf("export function JarvisPage"));
    const order = ["<JarvisPanelSlot", "<JarvisThread", 'title="Handed-off work"', "<HudDetails", "<ProgressPanel", "<PageFoot"];
    expect(file).toContain('label: "Daily status"');
    expect(file).toContain('label: "Previews"');
    expect(src).not.toContain("<DrilldownList");
    const at = order.map((s) => src.indexOf(s));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(src).toContain("<WidgetGrid");
    expect(file).toContain("<JarvisHudBody");
    expect(src).toContain("<ProgressPanel");
    expect(src).toContain("tasks.slice(0, HANDOFFS_SHOWN)");
    expect(src).toContain("Show all {tasks.length}");
    expect(file).toContain('import "./jarvis-page.css"');
    const css = read("src/components/shell/pages/jarvis-page.css");
    expect(css).toContain(".jv-page .jv-hud .jh-body");
    expect(css).not.toMatch(/font-size:\s*\d/); // design-system steps only
  });
});
