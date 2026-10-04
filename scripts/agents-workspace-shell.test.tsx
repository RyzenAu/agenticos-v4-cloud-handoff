// Agents workspace shell (B3): routes and tab state, the bot status line, the live viewer's state machine, which controls the lease allows,
// the Tasks & Files mapping (what actually ran, no "finished" without an outcome), and the links in. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Job, JobSummary } from "./jobs/types";
import type { ArtifactMeta } from "./computers/artifacts";
import type { CodingJob, JobView, UsageReceipt } from "../src/lib/coding-client";
import type { ComputerView } from "../src/lib/computers-client";
import { DESTINATIONS, drilldownHref, locate } from "../src/components/shell/destinations";
import { SEEDED_BOTS, TAB_LABEL, WORKSPACE_TABS, botForComputer, botForJob, botFromService, computerForBot, parseTab, seededBots, workspaceHref, type Bot } from "../src/components/agents/workspace/bots";
import { codingWaitsForYou, deriveBotStatus } from "../src/components/agents/workspace/status";
import { CONNECT_DEADLINE_MS, INITIAL_VIEWER, MAX_RETRIES, retryDelayMs, screenPhase, viewerFlow, viewerReducer, viewerStatusText, type ViewerState } from "../src/components/agents/computer/viewer-state";
import { canSendInput, computerControls, computerPanel } from "../src/components/agents/computer/control-state";
import { ComputerTab } from "../src/components/agents/computer/computer-tab";
import { botFiles, codingTask, computerTask, jobIsOnComputer, mergeTasks, orderTasks, ranWith, serviceFiles, serviceTask, taskIsOpen } from "../src/components/agents/tasks/tasks";
import { timeLine } from "../src/components/agents/tasks/tasks-tab";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ---------------------------------------------------------------- fixtures
const IDLE = { kind: null, who: null, jobId: null, expiresAt: null, epoch: null } as const;
const computer = (o: Partial<ComputerView> = {}): ComputerView => ({
  name: "research", id: "dev-research", label: "Research", kind: "cloud-computer", owner: "shared", adapter: "test-host", state: "online", desired: "running",
  desktop: true, browser: true, capabilities: ["browser.navigate", "file.write"], assigned: null, controller: { ...IDLE }, takeoverPending: null, paused: null,
  lastJob: null, resource: null, lastSeen: 1, failure: null, recoveries: 0, createdBy: "usman", createdAt: 1, viewer: { snapshot: true, vnc: true }, ...o,
});
const agentHolds = (o: Partial<ComputerView> = {}) => computer({ state: "busy", controller: { kind: "agent", who: "research", jobId: "j1", expiresAt: 9, epoch: 2 }, assigned: { agent: "research", jobId: "j1", by: "usman", title: "Check three dental sites" }, ...o });
const personHolds = (who: string, o: Partial<ComputerView> = {}) => computer({ state: "busy", controller: { kind: "person", who, jobId: null, expiresAt: 9, epoch: 3 }, ...o });
const RESEARCH: Bot = { ...SEEDED_BOTS[0]!, computer: "research" };
const BUILDER: Bot = { ...SEEDED_BOTS[1]!, computer: "builder" };
const NAMES: Record<string, string> = { usman: "Usman", mehroz: "Mehroz" };
const nameOf = (id: string) => NAMES[id] ?? id;

const NOW = Date.parse("2026-10-02T04:00:00.000Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function codingJob(o: Partial<CodingJob> & { state: CodingJob["state"] }): CodingJob {
  const binding = { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max-2", model: "claude-opus-5-5", cliVersion: "2.1.280" };
  return {
    id: "11111111-1111-4111-8111-111111111111",
    spec: { objective: "Fix the booking form", roles: [{ roleId: "builder-1", role: "builder", agent: binding }], doneWhen: [], nonGoals: [], checks: [] },
    runs: [{ id: "r1", jobId: "x", roleId: "builder-1", role: "builder", binding, state: "running", nativeSessionId: null, worktree: { branch: "b", headAtStart: "a", detached: false }, attempt: 1, startedAt: iso(10), endedAt: null, lastSeq: 1, pendingInput: null, resultSha: null, history: [], error: null }],
    headSha: "abc", diff: null, tests: [], review: null, gate: null, applies: [], executorDevice: "usman-pc", createdAt: iso(30), updatedAt: iso(2), lastSeq: 3, ...o,
  } as unknown as CodingJob;
}
const receipt = (o: Partial<UsageReceipt>): UsageReceipt => ({ account: "claude:max-2", model: "claude-sonnet-5-5", providerModel: "claude-sonnet-5-5", requestedModel: "claude-opus-5-5", provider: "anthropic", ...o }) as UsageReceipt;
const view = (receipts: UsageReceipt[]): JobView => ({ job: codingJob({ state: "building" }), receipts, approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "d" });

function summary(o: Partial<JobSummary> = {}): JobSummary {
  return { id: "22222222-2222-4222-8222-222222222222", kind: "control", principal: { personId: "usman" } as never, targetDeviceId: "dev-research", state: "succeeded", title: "Check three dental sites", cancelRequested: false, quarantined: false, createdAt: iso(20), updatedAt: iso(15), stepCount: 3, lastStep: { seq: 3, at: 1, intent: "wrote note", executor: "file.write", ms: 5, outcome: "ok" }, ...o };
}
const detail = (o: Partial<Job> = {}): Job => ({ ...summary(), steps: [{ seq: 1, at: 1, intent: "step 1 browser.navigate: open the page", executor: "browser.navigate", ms: 9, outcome: "ok" }], receipts: [], ...o }) as unknown as Job;
const artifact = (jobId: string): ArtifactMeta => ({ id: jobId, personId: "usman", kind: "research", title: "Dental sites report", summary: "Three sites checked.", host: "real LAN host", computer: "research", createdAt: iso(14), main: "report.md", files: [{ name: "report.md", bytes: 2048, mime: "text/markdown" }], outcome: "complete" });

// ---------------------------------------------------------------- routes and tab state
describe("routes, tabs and the drilldown", () => {
  test("the four tabs, in order, with the owner's labels; anything else is Chat", () => {
    expect([...WORKSPACE_TABS]).toEqual(["chat", "computer", "tasks", "setup"]);
    expect(WORKSPACE_TABS.map((t) => TAB_LABEL[t])).toEqual(["Chat", "Computer", "Tasks & Files", "Setup"]);
    expect(parseTab("computer")).toBe("computer");
    expect(parseTab("tasks")).toBe("tasks");
    expect(parseTab("nonsense")).toBe("chat");
    expect(parseTab(undefined)).toBe("chat");
    expect(parseTab(["computer"])).toBe("chat");
  });

  test("deep links: a bot path and a ?tab=, built in one place", () => {
    expect(workspaceHref("research", "tasks")).toEqual({ to: "/agents/workspace/$botId", params: { botId: "research" }, search: { tab: "tasks" } });
    expect(workspaceHref(null)).toEqual({ to: "/agents/workspace", search: { tab: "chat" } });
  });

  test("both route files exist, are file routes at the right paths, and the tree knows them", () => {
    expect(existsSync(join(ROOT, "src/routes/agents.workspace.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "src/routes/agents.workspace.$botId.tsx"))).toBe(true);
    expect(read("src/routes/agents.workspace.tsx")).toContain('createFileRoute("/agents/workspace")');
    expect(read("src/routes/agents.workspace.tsx")).toContain("validateSearch");
    expect(read("src/routes/agents.workspace.$botId.tsx")).toContain('createFileRoute("/agents/workspace/$botId")');
    const tree = read("src/routeTree.gen.ts");
    expect(tree).toContain("'/agents/workspace'");
    expect(tree).toContain("'/agents/workspace/$botId'");
  });

  test("still eight destinations; ONE new drilldown, Agents, under Jarvis; every workspace URL belongs to it", () => {
    expect(DESTINATIONS.map((d) => d.label)).toEqual(["Home", "Jarvis", "Receptionist", "Work", "Memory", "Finance", "Studio", "System"]);
    const jarvis = DESTINATIONS.find((d) => d.id === "jarvis")!;
    const agents = jarvis.drilldowns.filter((d) => d.label === "Agents");
    expect(agents).toHaveLength(1);
    expect(drilldownHref(agents[0]!)).toBe("/agents/workspace");
    for (const path of ["/agents/workspace", "/agents/workspace/research", "/agents/workspace/builder"]) {
      const here = locate(path);
      expect(`${here?.destination.id}>${here?.drilldown?.label}`).toBe("jarvis>Agents");
    }
    expect(locate("/agents/hermes")?.drilldown?.label).toBe("Hermes");
    expect(DESTINATIONS.flatMap((d) => d.drilldowns.filter((x) => x.label === "Agents"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- bots
describe("bots", () => {
  test("a service row becomes a bot; a bad id is dropped; readiness is kept only when it is a known state", () => {
    expect(botFromService({ id: "research", name: "Research", purpose: "p", computer: "research", coding: { enabled: false }, readiness: { state: "ready", reasons: [] } })).toMatchObject({ id: "research", computer: "research", readiness: { state: "ready" } });
    expect(botFromService({ id: "Bad Id!" })).toBeNull();
    expect(botFromService(null)).toBeNull();
    expect(botFromService({ id: "x", readiness: { state: "dancing" } })?.readiness).toBeUndefined();
    expect(botFromService({ id: "builder", coding: { enabled: true, accountSlot: "claude:max-2", model: "claude-opus-5-5" } })?.coding).toEqual({ enabled: true, accountSlot: "claude:max-2", model: "claude-opus-5-5" });
  });

  test("seeded bots take a computer only when a SHARED computer carries the name; a personal PC never does", () => {
    const personal = { name: "research", kind: "pc", owner: "usman" } as never;
    expect(seededBots([personal]).map((b) => b.computer)).toEqual([null, null]);
    expect(seededBots([{ name: "research", kind: "cloud-computer", owner: "shared" }, { name: "builder", kind: "cloud-computer", owner: "shared" }] as never).map((b) => b.computer)).toEqual(["research", "builder"]);
    expect(SEEDED_BOTS.map((b) => b.id)).toEqual(["research", "builder"]);
    expect(SEEDED_BOTS.find((b) => b.id === "builder")!.coding.enabled).toBe(true);
  });

  test("a bot's computer must be shared: an owned (personal) record is refused", () => {
    expect(computerForBot(RESEARCH, [computer()])?.name).toBe("research");
    expect(computerForBot(RESEARCH, [computer({ owner: "usman" as never })])).toBeNull();
    expect(computerForBot({ computer: null }, [computer()])).toBeNull();
  });

  test("which bot a computer or a job belongs to (for the links in)", () => {
    expect(botForComputer([RESEARCH, BUILDER], "builder")?.id).toBe("builder");
    expect(botForComputer([RESEARCH, BUILDER], "other")).toBeNull();
    expect(botForJob([RESEARCH, BUILDER], [{ name: "research", id: "dev-research" }], { kind: "control", targetDeviceId: "dev-research" })?.id).toBe("research");
    expect(botForJob([RESEARCH, BUILDER], [{ name: "research", id: "dev-research" }], { kind: "control", targetDeviceId: "usman-pc" })).toBeNull();
    expect(botForJob([RESEARCH, BUILDER], [], { kind: "coding" })?.id).toBe("builder");
  });
});

// ---------------------------------------------------------------- status line
describe("the bot's status line", () => {
  const status = (bot: Bot, c: ComputerView | null, extra: Partial<Parameters<typeof deriveBotStatus>[0]> = {}) => deriveBotStatus({ bot, computer: c, me: "usman", nameOf, now: NOW, ...extra });

  test("Ready when its computer is idle", () => {
    expect(status(RESEARCH, computer())).toMatchObject({ kind: "ready", text: "Ready" });
  });
  test("Working on the job it holds the computer for", () => {
    expect(status(RESEARCH, agentHolds())).toMatchObject({ kind: "working", text: "Working on check three dental sites" });
  });
  test("Offline says why: stopped, asleep, or no computer at all", () => {
    expect(status(RESEARCH, computer({ state: "offline" }))).toMatchObject({ kind: "offline" });
    expect(status(RESEARCH, computer({ state: "offline" })).text).toContain("Offline: its computer is stopped");
    expect(status(RESEARCH, computer({ state: "asleep" })).text).toContain("asleep");
    const none = status({ ...RESEARCH, computer: null }, null);
    expect(none.kind).toBe("unconfigured");
    expect(none.text).toBe("No computer yet. Choose one in Setup");
    const gone = status({ ...RESEARCH, computer: "gone" }, null);
    expect(gone.kind).toBe("unconfigured"); // one state word for "no usable computer", whether none was chosen or the chosen one isn't here
    expect(gone.text).toContain('"gone" isn\'t on this hub');
  });
  test("Needs you: a failed computer, a paused job while you hold the controls, an approval question", () => {
    expect(status(RESEARCH, computer({ state: "failed", failure: { at: 1, reason: "Xvfb died" } }))).toMatchObject({ kind: "needs-you", tone: "danger" });
    expect(status(RESEARCH, personHolds("usman", { paused: { jobId: "j1", agent: "research" } }))).toMatchObject({ kind: "needs-you" });
    expect(status(RESEARCH, personHolds("usman", { paused: { jobId: "j1", agent: "research" } })).text).toContain("Return them");
    const asking = status(RESEARCH, agentHolds(), { job: { id: "j1", state: "awaiting-approval" } as never });
    expect(asking.kind).toBe("needs-you");
  });
  test("someone holding the controls is named; a takeover in progress says the agent pauses first", () => {
    expect(status(RESEARCH, personHolds("mehroz"))).toMatchObject({ kind: "held", text: "Mehroz has the controls of its computer" });
    expect(status(RESEARCH, personHolds("usman"))).toMatchObject({ kind: "held", text: "You have the controls of its computer" });
    expect(status(RESEARCH, agentHolds({ takeoverPending: { by: "mehroz", requestedAt: 1 } })).text).toBe("Mehroz is taking over; it pauses at its next safe step");
  });
  test("Builder: an active coding job is Working; a job waiting for the owner is Needs you; a stale draft is not", () => {
    expect(status(BUILDER, null, { coding: [codingJob({ state: "building" })] })).toMatchObject({ kind: "working", text: "Working on fix the booking form" });
    const waiting = status(BUILDER, null, { coding: [codingJob({ state: "needs_owner", stoppedBecause: { code: "unexpected", message: "x", at: iso(1) } as never })] });
    expect(waiting.kind).toBe("needs-you");
    expect(status(BUILDER, null, { coding: [codingJob({ state: "draft", updatedAt: iso(1) })] }).kind).toBe("ready");
    expect(codingWaitsForYou(codingJob({ state: "interrupted", updatedAt: new Date(NOW - 30 * 86_400_000).toISOString() }), NOW)).toBe(false);
    expect(codingWaitsForYou(codingJob({ state: "interrupted", updatedAt: iso(5) }), NOW)).toBe(true);
  });
  test("a bot that cannot code and has no computer says it once, in one sentence, whatever reason the service gave", () => {
    expect(status({ ...RESEARCH, computer: null, readiness: { state: "unconfigured", reasons: ["no computer is chosen"] } }, null).text).toBe("No computer yet. Choose one in Setup");
  });
});

// ---------------------------------------------------------------- the viewer's state machine
describe("the live viewer's state machine", () => {
  const step = (s: ViewerState, ...events: Parameters<typeof viewerReducer>[1][]) => events.reduce(viewerReducer, s);

  test("the connect deadline is 15 seconds", () => {
    expect(CONNECT_DEADLINE_MS).toBe(15_000);
  });
  test("a frame that says nothing times out into 'didn't connect', which retries; it never claims to be live", () => {
    const waiting = step(INITIAL_VIEWER);
    expect(viewerStatusText(waiting)).toBe("Connecting to the screen…");
    const late = step(waiting, { type: "deadline" });
    expect(late).toMatchObject({ connected: false, timedOut: true });
    expect(viewerStatusText(late)).toBe("The screen didn't connect within 15 seconds.");
    expect(viewerFlow(late, true)).toEqual({ dropped: true, retrying: true, gaveUp: false });
    expect(screenPhase(late, true).phase).toBe("reconnecting");
    const again = step(late, { type: "auto-retry" });
    expect(again).toMatchObject({ connected: null, timedOut: false, tries: 1, reload: 1 });
  });
  test("a frame that already answered is not timed out", () => {
    const live = step(INITIAL_VIEWER, { type: "message", connected: true, canControl: false });
    expect(step(live, { type: "deadline" })).toEqual(live);
    const dropped = step(INITIAL_VIEWER, { type: "message", connected: false, canControl: null });
    expect(step(dropped, { type: "deadline" }).timedOut).toBe(false);
  });
  test("a good connection resets the retries; retries give up after the limit and offer Retry", () => {
    let s = INITIAL_VIEWER;
    for (let i = 0; i < MAX_RETRIES; i++) s = step(s, { type: "message", connected: false, canControl: null }, { type: "auto-retry" });
    expect(s.tries).toBe(MAX_RETRIES);
    s = step(s, { type: "message", connected: false, canControl: null });
    expect(viewerFlow(s, true)).toEqual({ dropped: true, retrying: false, gaveUp: true });
    expect(viewerFlow(s, false).gaveUp).toBe(true);
    expect(step(s, { type: "manual-retry" })).toMatchObject({ tries: 0, connected: null, reload: s.reload + 1 });
    expect(step(s, { type: "message", connected: true, canControl: true }).tries).toBe(0);
    expect(retryDelayMs(0)).toBe(2000);
    expect(retryDelayMs(2)).toBe(6000);
  });
  test("view-only until the lease is yours: the words and the chip", () => {
    expect(viewerStatusText({ connected: true, canControl: false })).toContain("view-only");
    expect(viewerStatusText({ connected: true, canControl: true })).toContain("You hold the controls");
    expect(screenPhase({ connected: true, canControl: false }, false).label).toBe("Screen live, view-only");
  });
});

// ---------------------------------------------------------------- panel state and controls by lease
describe("the Computer tab: honest state, and the controls the lease allows", () => {
  const modeOf = (c: ComputerView | null, extra: Parameters<typeof computerPanel>[2] = {}) => computerPanel(c, "usman", { nameOf, ...extra });

  test("each state is its own sentence: none, offline, asleep, starting, failed, idle, busy, pausing, held by you, held by the other founder (named)", () => {
    expect(modeOf(null).mode).toBe("none");
    expect(modeOf(computer({ state: "offline" })).mode).toBe("offline");
    expect(modeOf(computer({ state: "asleep" })).mode).toBe("asleep");
    expect(modeOf(computer({ state: "starting" })).mode).toBe("starting");
    expect(modeOf(computer({ state: "failed", failure: { at: 1, reason: "boom" } })).mode).toBe("failed");
    expect(modeOf(computer()).mode).toBe("idle");
    expect(modeOf(agentHolds())).toMatchObject({ mode: "busy", headline: "Working: Check three dental sites" });
    expect(modeOf(agentHolds({ takeoverPending: { by: "usman", requestedAt: 1 } })).headline).toBe("You are taking over");
    expect(modeOf(agentHolds({ takeoverPending: { by: "mehroz", requestedAt: 1 } })).headline).toBe("Mehroz is taking over");
    expect(modeOf(personHolds("usman")).mode).toBe("held-by-you");
    const other = modeOf(personHolds("mehroz"));
    expect(other).toMatchObject({ mode: "held-by-other", headline: "Mehroz has the controls" });
  });
  test("reconnecting only when a live viewer reported a screen that is not live", () => {
    expect(modeOf(computer()).reconnecting).toBe(false);
    expect(modeOf(computer(), { screen: { connected: null, canControl: null } }).reconnecting).toBe(true);
    expect(modeOf(computer(), { screen: { connected: false, canControl: null } }).reconnecting).toBe(true);
    expect(modeOf(computer(), { screen: { connected: true, canControl: false } }).reconnecting).toBe(false);
    expect(modeOf(computer({ state: "offline" }), { screen: { connected: false, canControl: null } }).reconnecting).toBe(false);
  });
  test("a failed hand-back stays 'held': the controls are still yours, said once, never shown as returned", () => {
    const held = modeOf(personHolds("usman"), { handBackFailed: true });
    expect(held.mode).toBe("held-by-you");
    expect(held.handBackFailed).toBe(true);
    expect(held.detail).toContain("You hold the controls until the hub confirms");
    // Once the hub says the controls moved, the old failure means nothing.
    const gone = modeOf(computer(), { handBackFailed: true });
    expect(gone.handBackFailed).toBe(false);
    expect(gone.mode).toBe("idle");
  });

  test("controls follow the lease: idle -> Take over; agent working -> Take over (asks); you hold -> Return; the other founder holds -> nothing to press but Stop", () => {
    expect(computerControls(computer(), "usman")).toEqual({ watch: true, takeOver: { label: "Take over", ask: false }, returnToAgent: false, stop: true, start: null });
    expect(computerControls(agentHolds(), "usman").takeOver).toEqual({ label: "Take over", ask: true });
    const mine = computerControls(personHolds("usman"), "usman");
    expect(mine.returnToAgent).toBe(true);
    expect(mine.takeOver).toBeNull();
    const theirs = computerControls(personHolds("mehroz"), "usman");
    expect(theirs).toMatchObject({ takeOver: null, returnToAgent: false, stop: true, watch: true });
    // While a takeover is pending nobody can ask again.
    expect(computerControls(agentHolds({ takeoverPending: { by: "mehroz", requestedAt: 1 } }), "usman").takeOver).toBeNull();
  });
  test("a stopped computer offers Start; a failed one offers Reconnect; neither offers Watch, Take over or Stop beyond what the state allows", () => {
    expect(computerControls(computer({ state: "offline" }), "usman")).toEqual({ watch: false, takeOver: null, returnToAgent: false, stop: false, start: { label: "Start" } });
    expect(computerControls(computer({ state: "asleep" }), "usman").start).toEqual({ label: "Start" });
    expect(computerControls(computer({ state: "failed", failure: { at: 1, reason: "x" } }), "usman")).toMatchObject({ start: { label: "Reconnect" }, stop: false, watch: false, takeOver: null });
    expect(computerControls(computer({ state: "starting" }), "usman")).toMatchObject({ start: null, takeOver: null, stop: true });
    expect(computerControls(null, "usman")).toEqual({ watch: false, takeOver: null, returnToAgent: false, stop: false, start: null });
  });
  test("no screen on the computer: nothing to Watch", () => {
    expect(computerControls(computer({ viewer: { snapshot: false, vnc: false } }), "usman").watch).toBe(false);
  });
  test("only the lease holder sends input", () => {
    expect(canSendInput(personHolds("usman"), "usman")).toBe(true);
    expect(canSendInput(personHolds("mehroz"), "usman")).toBe(false);
    expect(canSendInput(agentHolds(), "usman")).toBe(false);
    expect(canSendInput(computer(), "usman")).toBe(false);
    expect(canSendInput(computer({ state: "offline", controller: { kind: "person", who: "usman", jobId: null, expiresAt: 1, epoch: 1 } }), "usman")).toBe(false);
    expect(canSendInput(personHolds("usman"), null)).toBe(false);
  });

  const html = (c: ComputerView | null, name: string | null = "research") =>
    renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><ComputerTab botName="Research" computerName={name} computer={c} me="usman" nameOf={nameOf} /></QueryClientProvider>).replace(/<!-- -->/g, "");
  test("rendered: the buttons the lease allows, the view-only line, a frame only for a live computer", () => {
    const idle = html(computer());
    expect(idle).toContain("Take over");
    expect(idle).toContain("Hide screen");
    expect(idle).toContain('data-input="view-only"');
    expect(idle).toContain("<iframe");
    expect(idle).not.toContain("Return to agent");
    const mine = html(personHolds("usman"));
    expect(mine).toContain("Return to agent");
    expect(mine).toContain('data-input="yours"');
    expect(mine).toContain("Your keyboard and mouse reach the computer.");
    expect(mine).not.toContain(">Take over<");
    const theirs = html(personHolds("mehroz"));
    expect(theirs).toContain("Mehroz has the controls");
    expect(theirs).not.toContain("Return to agent");
    const off = html(computer({ state: "offline" }));
    expect(off).toContain(">Start<");
    expect(off).not.toContain("<iframe");
    expect(html(computer({ state: "failed", failure: { at: 1, reason: "Xvfb died" } }))).toContain(">Reconnect<");
    expect(computerPanel(null, "usman").headline).toBe("No computer yet");
  });
});

// ---------------------------------------------------------------- Tasks & Files
describe("Tasks & Files mapping", () => {
  const J = "22222222-2222-4222-8222-222222222222";

  test("account and model come from receipts: what ran, with a difference from what was asked said, never swapped in", () => {
    expect(ranWith([receipt({})], "none")).toEqual({ text: "Claude Max 2 · Claude Sonnet 5.5 (asked for Claude Opus 5.5)", used: true });
    expect(ranWith([receipt({ requestedModel: "claude-sonnet-5-5" })], "none").text).toBe("Claude Max 2 · Claude Sonnet 5.5");
    // the provider's reported model wins over the nominal one
    expect(ranWith([receipt({ model: "claude-opus-5-5", providerModel: "claude-sonnet-5-5", requestedModel: undefined })], "x").text).toBe("Claude Max 2 · Claude Sonnet 5.5");
    // two turns on the same account and model are one line; two accounts are two
    expect(ranWith([receipt({}), receipt({})], "x").text.split(";")).toHaveLength(1);
    expect(ranWith([receipt({}), receipt({ account: "codex:openai-1", model: "gpt-6-astra", providerModel: null, requestedModel: undefined })], "x").text.split(";")).toHaveLength(2);
    expect(ranWith([], "No model or account was recorded.")).toEqual({ text: "No model or account was recorded.", used: false });
    expect(ranWith(null, "x").used).toBe(false);
  });

  test("a coding job that has not run says so and never presents the requested model as used", () => {
    const t = codingTask(codingJob({ state: "awaiting_confirmation" }), view([]));
    expect(t.ran.used).toBe(false);
    expect(t.ran.text).toContain("Nothing has run yet");
    expect(t.ran.text).toContain("set to use");
    // before the receipts are read, it says it is reading, not the requested model
    expect(codingTask(codingJob({ state: "building" }), null).ran.text).toBe("Reading what ran…");
    // with a receipt, the line is the receipt's
    const ran = codingTask(codingJob({ state: "building" }), view([receipt({})]));
    expect(ran.ran).toMatchObject({ used: true });
    expect(ran.ran.text).not.toContain("Claude Opus 5.5 ·");
    expect(ran.ran.text).toContain("Claude Sonnet 5.5");
  });

  test("a coding job is 'Finished' only when the done gate passed; progress, review and tests are the job's own", () => {
    const gated = codingTask(codingJob({ state: "completed", gate: { passed: true, sha: "abc", checks: [] } as never, tests: [{ sha: "abc", exitCode: 0, counts: { passed: 214, failed: 0, skipped: 0 } }] as never, review: { verdict: "approve", binding: { accountSlot: "claude:max" }, findings: [] } as never }), view([receipt({})]));
    expect(gated).toMatchObject({ state: "finished", tests: "214 passed · 0 failed", can: { cancel: false, resume: false } });
    expect(gated.review).toBe("Approved by Claude Max");
    expect(gated.result).toEqual({ href: "/coding/11111111-1111-4111-8111-111111111111?tab=changes", label: "Open result", external: false });
    const ungated = codingTask(codingJob({ state: "completed", gate: null }), view([receipt({})]));
    expect(ungated.state).toBe("unknown");
    expect(ungated.stateWord).toBe("Ended, not verified");
    expect(ungated.result).toBeNull();
  });

  test("coding blockers say what to do, with real Resume only where the job can resume", () => {
    const paused = codingTask(codingJob({ state: "interrupted" }), null);
    expect(paused.state).toBe("interrupted");
    expect(paused.blocker?.action).toEqual({ kind: "resume", label: "Resume" });
    expect(paused.can).toEqual({ cancel: true, resume: true });
    const approval = codingTask(codingJob({ state: "awaiting_approval" }), null);
    expect(approval.state).toBe("needs-you");
    expect(approval.blocker?.action?.kind).toBe("link");
    expect(approval.can.resume).toBe(false);
    const superseded = codingTask(codingJob({ state: "cancelled", supersededBy: { ref: "abc", reason: "landed another way", at: iso(1), by: "usman" } as never }), null);
    expect(superseded.can).toEqual({ cancel: false, resume: false });
    expect(codingTask(codingJob({ state: "building" }), null).can).toEqual({ cancel: true, resume: false });
  });

  test("a computer job is 'Finished' only with an observable outcome: a saved result, or a step that ran", () => {
    const withResult = computerTask(summary(), { artifact: artifact(J), detail: detail() });
    expect(withResult).toMatchObject({ state: "finished", stateWord: "Finished" });
    expect(withResult.result).toEqual({ href: `/__computers/artifacts/${J}`, label: "Dental sites report", external: true });
    const stepsOnly = computerTask(summary(), { detail: detail() });
    expect(stepsOnly.state).toBe("finished");
    expect(stepsOnly.result).toBeNull();
    expect(stepsOnly.outcomeNote).toContain("No saved result");
    const nothing = computerTask(summary({ lastStep: null, stepCount: 0 }), { detail: detail({ steps: [] }) });
    expect(nothing.state).toBe("unknown");
    expect(nothing.stateWord).toBe("Ended, nothing to show");
    expect(nothing.outcomeNote).toContain("no step ran");
  });

  test("a computer job: no model is claimed unless a receipt says so; failed ones say why and offer the Chat", () => {
    expect(computerTask(summary(), { detail: detail() }).ran).toEqual({ text: "No model or account was recorded for this task.", used: false });
    const withReceipt = computerTask(summary(), { detail: detail({ receipts: [{ provider: "openrouter", model: "claude-sonnet-5-5", route: "free", outcome: "succeeded" } as never] }) });
    expect(withReceipt.ran).toMatchObject({ used: true, text: "openrouter · Claude Sonnet 5.5" });
    const failed = computerTask(summary({ state: "failed", note: "The page did not load" }), { detail: detail() });
    expect(failed).toMatchObject({ state: "failed", tone: "danger" });
    expect(failed.blocker).toEqual({ text: "The page did not load", action: { kind: "tab", tab: "chat", label: "Ask the bot again" } });
  });

  test("a running computer job can be stopped; a paused one points at the Computer tab; one awaiting a yes says so", () => {
    const running = computerTask(summary({ state: "running", updatedAt: iso(1) }), { detail: detail({ state: "running" }) });
    expect(running).toMatchObject({ state: "working", can: { cancel: true, resume: false }, endedAt: null });
    const paused = computerTask(summary({ state: "running" }), { pausedJobId: J });
    expect(paused).toMatchObject({ state: "needs-you", stateWord: "Paused" });
    expect(paused.blocker?.action).toEqual({ kind: "tab", tab: "computer", label: "Go to the computer" });
    const ask = computerTask(summary({ state: "awaiting-approval" }), {});
    expect(ask.state).toBe("needs-you");
    expect(ask.blocker?.text).toContain("spoken yes");
    expect(computerTask(summary({ state: "cancelled" }), {}).can.cancel).toBe(false);
  });

  test("only the bot's own computer's jobs belong to it; a personal PC's never match", () => {
    expect(jobIsOnComputer({ kind: "control", targetDeviceId: "dev-research" }, "dev-research")).toBe(true);
    expect(jobIsOnComputer({ kind: "control", targetDeviceId: "usman-pc" }, "dev-research")).toBe(false);
    expect(jobIsOnComputer({ kind: "voice", targetDeviceId: "dev-research" }, "dev-research")).toBe(false);
    expect(jobIsOnComputer({ kind: "control", targetDeviceId: "dev-research" }, null)).toBe(false);
  });

  test("rows from the agents service: states map, a finished row with no result is not 'finished', the model shown is the one it reported", () => {
    const ok = serviceTask({ id: J, kind: "computer", title: "Check sites", state: "succeeded", startedAt: iso(9), endedAt: iso(5), account: "claude:max-2", model: "claude-sonnet-5-5", resultArtifact: J });
    expect(ok).toMatchObject({ state: "finished", source: "service", kind: "computer", ran: { used: true, text: "Claude Max 2 · Claude Sonnet 5.5" } });
    expect(ok!.result).toEqual({ href: `/__computers/artifacts/${J}`, label: "Open result", external: true });
    const empty = serviceTask({ id: J, kind: "computer", title: "x", state: "succeeded" });
    expect(empty).toMatchObject({ state: "unknown", stateWord: "Ended, nothing to show" });
    expect(empty!.ran).toEqual({ text: "No model or account was recorded for this task.", used: false });
    const coding = serviceTask({ id: J, kind: "coding", title: "Fix it", state: "needs_owner", blocker: { text: "Review wants changes" } });
    expect(coding).toMatchObject({ state: "needs-you", kind: "coding", can: { cancel: true, resume: true } });
    expect(coding!.blocker?.action).toMatchObject({ kind: "link", href: `/coding/${J}` });
    expect(serviceTask({ id: J })).toBeNull();
    expect(serviceTask("nope")).toBeNull();
    expect(serviceTask({ id: J, title: "t", state: "weird" })?.state).toBe("unknown");
  });

  test("one row per job, needs-you first, then running, then newest first", () => {
    const a = computerTask(summary({ id: "a", state: "succeeded", createdAt: iso(50) }), { detail: detail() });
    const b = computerTask(summary({ id: "b", state: "running", createdAt: iso(40) }), {});
    const c = computerTask(summary({ id: "c", state: "awaiting-approval", createdAt: iso(60) }), {});
    const dup = computerTask(summary({ id: "a", state: "failed", createdAt: iso(50) }), {});
    expect(mergeTasks([a, b], [dup, c]).map((t) => t.id)).toEqual(["b", "a", "c"]); // first listing wins, newest first
    expect(orderTasks(mergeTasks([a, b], [c])).map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(taskIsOpen(b)).toBe(true);
    expect(taskIsOpen(a)).toBe(false);
  });

  test("the time line says when it started and how long it took, or that it is still going", () => {
    expect(timeLine({ startedAt: null, endedAt: null })).toBe("Start time not reported");
    expect(timeLine({ startedAt: iso(30), endedAt: iso(25) })).toMatch(/^Started .+ · took 5m$/);
    expect(timeLine({ startedAt: iso(30), endedAt: null })).toMatch(/· still going$/);
  });

  test("saved results: the bot's own computer only, newest first; open and per-file download addresses", () => {
    const mine = artifact(J);
    const other = { ...artifact("33333333-3333-4333-8333-333333333333"), computer: "builder", createdAt: iso(1) };
    expect(botFiles([mine, other], "research").map((f) => f.id)).toEqual([J]);
    expect(botFiles([mine], null)).toEqual([]);
    expect(serviceFiles([{ artifact: J, title: "R", createdAt: iso(2), files: [{ name: "report.md", bytes: 10 }] }, { nope: 1 }])).toHaveLength(1);
    expect(serviceFiles("x")).toEqual([]);
  });
});

// ---------------------------------------------------------------- links in
describe("links into the workspace", () => {
  test("Computers row: Open in workspace, only for a computer that belongs to an agent", () => {
    const src = read("src/components/computers/computers-page.tsx");
    expect(src).toContain("Open in workspace");
    expect(src).toContain('to="/agents/workspace/$botId"');
    expect(src).toContain('search={{ tab: "computer" }}');
    expect(src).toContain("workspaceBotId && ");
  });
  test("Computers page imports the viewer from the shared folder and still exports the old names", () => {
    const src = read("src/components/computers/computers-page.tsx");
    expect(src).toContain('from "@/components/agents/computer/viewer"');
    for (const name of ["LiveViewer", "PreviewPanel", "SnapshotPanel", "parseViewerMessage", "screenPhase", "viewerStatusText"]) expect(src).toMatch(new RegExp(`export \\{[^}]*\\b${name}\\b`));
    expect(src).not.toContain("function LiveViewer");
    expect(read("src/components/agents/computer/viewer.tsx")).toContain("export function LiveViewer");
  });
  test("Coding job page: Open in Builder workspace -> Tasks", () => {
    const src = read("src/components/coding/job-workspace.tsx");
    expect(src).toContain("Open in Builder workspace");
    expect(src).toContain('botId: "builder"');
    expect(src).toContain('search={{ tab: "tasks" }}');
  });
  test("Activity job: Open in <agent> workspace, only when the job belongs to an agent", () => {
    const view = read("src/components/activity/activity-view.tsx");
    expect(view).toContain("Open in {workspace.name} workspace");
    expect(view).toContain("{workspace && (");
    const route = read("src/routes/activity.tsx");
    expect(route).toContain("botForJob(");
  });
  test("the workspace has no second source of truth: it reads the existing job, computer and coding APIs", () => {
    const hook = read("src/components/agents/tasks/use-bot-tasks.ts");
    for (const api of ["/__jobs?kind=control", "/__computers/artifacts", "codingClient.list", "fetchJob", "/__agents/bots/"]) expect(hook).toContain(api);
    const tab = read("src/components/agents/tasks/tasks-tab.tsx");
    expect(tab).toContain("cancelComputerJob");
    expect(tab).toContain("codingClient.cancel");
    expect(tab).toContain("codingClient.resume");
  });
  test("the Chat and Setup slots are placeholders that say what is coming, with no controls of their own", () => {
    const slots = read("src/components/agents/workspace/slots.tsx");
    expect(slots).toContain("BotChat");
    expect(slots).toContain("BotSetup");
    expect(slots).not.toMatch(/<(input|textarea|form)\b/);
  });
});
