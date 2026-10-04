// A rig for the Agents workspace tests: the REAL job service (SQLite), conversation store, job-thread watcher, bot store, links store, saved-results store and
// agents wiring, over SYNTHETIC computers, a SYNTHETIC coding runtime (fake jobs, fake sign-in states) and a SYNTHETIC coding voice. Nothing here touches a
// real machine, account or model.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountsConfig } from "../coding/accounts";
import type { CodingJob } from "../coding/contracts";
import type { CodingRuntimeFull } from "../coding/plugin";
import { createArtifactStore } from "../computers/artifacts";
import { dataDirFor } from "../cloud/data-dir";
import { conversationStore } from "../conversations";
import type { Principal } from "../identity/principal";
import { JobService, type ExecutorContext } from "../jobs/service";
import { codingSnapshotOf } from "../jarvis-command/coding-snapshot";
import { createCommandService } from "../jarvis-command/service";
import { createJobThreads } from "../jarvis-command/threads";
import { createAgents } from "./mount";

export const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
export const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };

export const ACCOUNTS: AccountsConfig = {
  version: 1,
  codex: [{ slot: "codex:openai-2", codexHome: null, plan: "chatgpt-plus", creditsAllowed: false, order: 0 }],
  claude: [
    { slot: "claude:max", configDir: null, plan: "claude-max-20x", label: "Claude Max", order: 0 },
    { slot: "claude:max-2", configDir: "C:/profiles/max2", plan: "claude-max-20x", label: "Claude Max 2", order: 1 },
  ],
};

export type FakeComputer = { name: string; label: string; id: string; state: "starting" | "online" | "busy" | "asleep" | "offline" | "failed"; desired: "running" | "suspended" | "stopped"; controller: { kind: "agent" | "person" | null; who: string | null; jobId: string | null; expiresAt: null; epoch: null }; assigned: { agent: string; jobId: string; by: string; title: string } | null; paused: null; takeoverPending: null | { by: string; requestedAt: number }; failure: null | { at: number; reason: string } };
export const computerView = (name: string, patch: Partial<FakeComputer> = {}): FakeComputer => ({ name, label: name[0].toUpperCase() + name.slice(1), id: `dev-${name}`, state: "online", desired: "running", controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null }, assigned: null, paused: null, takeoverPending: null, failure: null, ...patch });

export type RigOptions = {
  /** Sign-in state of each Claude slot (default: both connected). */
  claude?: Record<string, boolean | null>;
  /** Has the owner applied Codex's sandbox isolation (default true)? Until then Codex is not ready. */
  isolation?: boolean;
  role?: string;
  computers?: string[];
  skills?: string[];
  routines?: string[];
  /** Model the computers' control lease (default true): a computer running a bot's job refuses another until it ends. */
  lease?: boolean;
  /** Called every time the coding runtime is asked for (a hook to make something happen at a precise moment in a read). */
  onCodingRuntime?: () => void;
};

export async function makeRig(options: RigOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "agents-rig-"));
  const jobs = new JobService({ path: join(root, "jobs.sqlite"), stopGraceMs: 400, snapshotMs: 0 });
  const conversations = conversationStore(root);
  // Synthetic coding jobs (the coding store's records) the job-thread watcher reads through the real coding snapshot.
  const codingJobs: CodingJob[] = [];
  const codingEvents = new Map<string, Array<{ type: string; payload: unknown }>>();
  const threads = createJobThreads({
    conversations,
    jobs: () => jobs,
    coding: async (id) => {
      const job = codingJobs.find((j) => j.id === id);
      return job ? codingSnapshotOf(job, (codingEvents.get(id) ?? []) as never) : null;
    },
    pollMs: 60_000,
    localFile: join(root, "thread-local.json"),
  });
  await threads.start();

  // Synthetic shared computers, and a startJob that makes a REAL job (the body is the test's).
  const views = new Map<string, FakeComputer>();
  for (const n of options.computers ?? ["research", "builder"]) views.set(n, computerView(n));
  const leaseOf = new Map<string, { jobId: string; agent: string }>();
  const started: Array<{ computer: string; by: string; title: string; agent?: string; principal?: unknown; bot?: string; subjects?: readonly string[]; route?: string; context?: string; steps: { executor: string; args: Record<string, unknown> }[] }> = [];
  let body: (jobId: string, ctx: ExecutorContext, goal: string) => Promise<{ ok: boolean; note?: string }> = async () => ({ ok: true, note: "done" });
  const computers = {
    canPlanGoals: false,
    canResearch: true,
    canWorkflows: true,
    list: () => [...views.values()] as never[],
    view: (name: string) => {
      const v = views.get(name);
      if (!v) throw Object.assign(new Error("No such computer"), { status: 404 });
      return v as never;
    },
    jobView: (jobId: string) => {
      const j = jobs.get(jobId);
      return j ? { id: j.id, state: j.state, note: j.note ?? null, title: j.title, computer: null, agent: null, paused: false, steps: j.steps.map((s) => ({ seq: s.seq, executor: s.executor, action: s.action ?? null, outcome: s.outcome, ms: s.ms, intent: s.intent, verification: s.verification ?? null })) } : null;
    },
    async startJob(input: { computer: string; by: string; principal: Principal; agent?: string; title?: string; steps: unknown; bot?: string; subjects?: readonly string[]; route?: string; context?: string }) {
      const v = views.get(input.computer);
      if (!v) return { ok: false as const, reason: `No computer called "${input.computer}".`, status: 404 };
      // The real service's lease: one controller at a time, no queue. While a job holds the computer, another request is REFUSED (never held in line),
      // and the computer reads busy with the holder's agent. Tests that need the old free-for-all start the rig with `lease: false`.
      const holder = leaseOf.get(input.computer);
      if (holder && options.lease !== false) return { ok: false as const, reason: `${holder.agent} is using ${v.label.toLowerCase()}; one controller at a time, so nothing ran.`, status: 409 };
      if (v.state !== "online") return { ok: false as const, reason: `${v.label} is ${v.state}, so nothing ran. I never run it on another machine.`, status: 409 };
      const steps = input.steps as { executor: string; args: Record<string, unknown> }[];
      started.push({ computer: input.computer, by: input.by, title: input.title ?? "", agent: input.agent, principal: input.principal, bot: input.bot, subjects: input.subjects, route: input.route, context: input.context, steps });
      const job = jobs.create({ kind: "control", principal: { personId: input.by, via: input.principal.via, actor: input.principal.actor } as never, targetDeviceId: v.id, title: input.title ?? "task", ...(input.bot ? { bot: input.bot } : {}), ...(input.subjects?.length ? { subjects: input.subjects } : {}) });
      const agent = input.agent ?? "agent";
      if (options.lease !== false) {
        leaseOf.set(input.computer, { jobId: job.id, agent });
        views.set(input.computer, computerView(input.computer, { state: "busy", controller: { kind: "agent", who: agent, jobId: job.id, expiresAt: null, epoch: null }, assigned: { agent, jobId: job.id, by: input.by, title: input.title ?? "task" } }));
      }
      const run = jobs.run(job.id, (ctx) => body(job.id, ctx, String(steps[0]?.args?.goal ?? steps[0]?.args?.brief ?? "")));
      void run.finally(() => {
        if (leaseOf.get(input.computer)?.jobId !== job.id) return;
        leaseOf.delete(input.computer);
        if (views.get(input.computer)?.controller.jobId === job.id) views.set(input.computer, computerView(input.computer));
      });
      return { ok: true as const, jobId: job.id };
    },
  };

  // A synthetic coding runtime: fake jobs, fake sign-in states, the real accounts config shape.
  const claude = { "claude:max": true, "claude:max-2": true, ...(options.claude ?? {}) } as Record<string, boolean | null>;
  const runtime = {
    store: {
      listJobs: (o: { limit?: number; before?: number } = {}) => {
        const rows = o.before === undefined ? codingJobs : codingJobs.filter((j) => Date.parse(j.createdAt) < o.before!).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return rows.slice(0, o.limit ?? 50);
      },
      getJob: (id: string) => codingJobs.find((j) => j.id === id) ?? null,
      events: (id: string) => (codingEvents.get(id) ?? []).map((e, i) => ({ seq: i + 1, jobId: id, ...e })),
    },
    accounts: () => ACCOUNTS,
    cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }),
    claudeStatus: { current: () => ACCOUNTS.claude.map((c) => ({ slot: c.slot, connected: claude[c.slot] ?? null, reason: claude[c.slot] === false ? "not signed in on this profile" : claude[c.slot] === null ? "not checked yet" : null, subscription: "max", checkedAt: null, sameAccountAs: null })), refresh: async () => undefined },
    registry: () => ({ repos: [{ id: "muv-marketing" }, { id: "agenticos" }] }),
    codexIsolationApproval: () => (options.isolation === false ? null : ({ version: 1, group: "x", paths: [], approvedAt: "2026-10-01T00:00:00Z" } as never)),
  } as unknown as CodingRuntimeFull;

  // A synthetic coding voice: the real detector's job is the registry's; here a draft is a plain job record.
  let voiceOpen = false;
  let voiceJob: string | null = null;
  const voice = {
    isCodingStart: (t: string) => /^(?:please\s+)?(?:have|get|ask)\s+an?\s+builder\b|\b(?:coding job)\b|\bassign\b/i.test(t),
    peek: () => ({ draftId: voiceOpen ? "draft" : null, jobId: voiceJob }),
  } as never;
  const codingCalls: Array<{ utterance: string; turn: unknown }> = [];
  let codingReply: (utterance: string) => { say: string; jobId?: string; jobState?: string; draft?: unknown; navigate?: string } | null = () => null;
  const sharedCoding = async (utterance: string, turn: unknown) => (codingCalls.push({ utterance, turn }), codingReply(utterance)) as never;

  // A synthetic shared memory: what was recalled and remembered, and what it says.
  const memoryCalls = { recall: [] as Array<{ person: string; query: string; limit: number }>, remember: [] as Array<{ person: string; text: string; title: string }> };
  let recallReply: () => { facts: Array<{ text: string; source: string }>; note: string | null } = () => ({ facts: [], note: null });
  let rememberReply: () => { ok: boolean; message: string } = () => ({ ok: true, message: "Remembered as mem-1" });
  let rememberDelayMs = 0;
  const memoryFake = {
    recall: async (person: string, query: string, limit: number) => (memoryCalls.recall.push({ person, query, limit }), recallReply()),
    remember: async (person: string, input: { text: string; title: string }) => {
      memoryCalls.remember.push({ person, ...input });
      if (rememberDelayMs) await sleep(rememberDelayMs);
      return rememberReply();
    },
  };
  const agents = createAgents({
    root,
    token: "test-internal-token",
    computers: computers as never,
    conversations: conversations as never,
    jobs: () => jobs,
    threads,
    routines: () => options.routines ?? ["trig-morning-brief"],
    codingRuntime: async () => (options.onCodingRuntime?.(), runtime),
    codingVoice: async () => voice,
    accounts: () => ACCOUNTS,
    memory: () => memoryFake,
    routerCheck: () => ({ ok: true, reason: null }),
    role: () => options.role ?? "pc",
  });
  const botCommands = agents.botCommands(sharedCoding as never);
  const artifacts = createArtifactStore(join(dataDirFor(root), "computers", "artifacts"));

  return {
    root, jobs, conversations, threads, agents, botCommands, artifacts, computers, views, started, codingJobs, codingEvents, codingCalls, claude, sharedCoding,
    setBody: (fn: typeof body) => void (body = fn),
    memoryCalls,
    setRecall: (fn: typeof recallReply) => void (recallReply = fn),
    setRemember: (fn: typeof rememberReply) => void (rememberReply = fn),
    /** Make the shared memory take this long to answer a save (so two jobs' saves overlap). */
    setRememberDelay: (ms: number) => void (rememberDelayMs = ms),
    setCodingReply: (fn: typeof codingReply) => void (codingReply = fn),
    setVoiceOpen: (v: boolean) => void (voiceOpen = v),
    /** The coding job this person's coding conversation is on (what the real voice remembers after a draft). */
    setVoiceJob: (id: string | null) => void (voiceJob = id),
    async close() {
      threads.stop();
      try { jobs.close(); } catch { /* a job still settling */ }
      try { rmSync(root, { recursive: true, force: true }); } catch { /* sqlite handles close at GC on Windows */ }
    },
  };
}
export type Rig = Awaited<ReturnType<typeof makeRig>>;

/** A minimal coding job record, as the coding store would hold it (only what the workspace reads). */
export function fakeCodingJob(patch: { id: string; state: string; objective?: string; createdAt?: string; updatedAt?: string; head?: string | null; files?: Array<{ path: string; status: string }>; review?: { verdict: string; severities: string[] } | null; tests?: Array<{ commandId: string; passed: number; failed: number; exitCode: number }> }): CodingJob {
  return {
    id: patch.id,
    spec: { objective: patch.objective ?? "Fix the footer year", repo: { jobBranch: `coding/fix-footer-${patch.id.slice(0, 6)}`, repoId: "muv-marketing" }, roles: [], doneWhen: [], checks: [] },
    state: patch.state,
    runs: [],
    headSha: patch.head ?? null,
    diff: patch.files ? { files: patch.files.map((f) => ({ ...f, additions: 1, deletions: 0 })) } : null,
    tests: (patch.tests ?? []).map((t) => ({ commandId: t.commandId, exitCode: t.exitCode, counts: { passed: t.passed, failed: t.failed, skipped: 0 } })),
    review: patch.review ? { verdict: patch.review.verdict, findings: patch.review.severities.map((severity) => ({ severity })) } : null,
    gate: null,
    applies: [],
    createdAt: patch.createdAt ?? "2026-10-02T01:00:00.000Z",
    updatedAt: patch.updatedAt ?? "2026-10-02T01:05:00.000Z",
    lastSeq: 0,
  } as unknown as CodingJob;
}
export const usageEvent = (account: string, model: string, task = "coding.build") => ({ type: "usage", payload: { account, model, providerModel: model, task } });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(10);
  }
}

/** The command service as the hub builds it: the bot hooks, the thread watcher, the shared coding delegate; no device resolves (so a device path would be loud). */
export function commandFor(r: Rig, extra: { computers?: (utterance: string, principal: Principal) => Promise<{ ok: boolean; said: string; jobId?: string; deviceId?: string; navigate?: string } | null> } = {}) {
  const bots = r.botCommands;
  const service = createCommandService({
    jobs: () => r.jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device in this test" }),
    delegates: { coding: r.sharedCoding as never, ...(extra.computers ? { computers: extra.computers } : {}) },
    bots: { scope: bots.scope, nameOf: bots.nameOf, threadIds: bots.threadIds, run: bots.run },
    graceMs: 50, dedupeMs: 0, threads: r.threads, deviceLabel: (id) => id,
  });
  const say = (principal: Principal, utterance: string, body: Record<string, unknown> = {}) => service.run({ principal, body: { utterance, source: "typed", ...body } as never });
  return { service, say };
}
