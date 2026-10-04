// Round 6, items 1 and 3: an editable plan, and an edit voids every earlier confirmation and every older draft.
// Route-level and SYNTHETIC: a temp repo, a temp store, no agent ever runs.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { DEFAULT_ACCOUNTS } from "./accounts";
import { createOrchestrator } from "./orchestrator";
import { codingRoute } from "./routes";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { routerRunner } from "./runners/router";
import { createShaper, heuristicPlan } from "./shaper";
import { createCodingVoice } from "./voice";
import { claudeBinding, draftSpec } from "./spec";
import { CodingStore } from "./store";
import { fixtureRepo } from "./test-fixtures";
import { roots } from "./r6-world";

function routeWorld() {
  const fx = fixtureRepo();
  roots.push(fx.root);
  const entry = { ...fx.entry, id: "fixture-app" as never };
  const registry = { version: 1, repos: [entry] } as never;
  const store = CodingStore.open(join(fx.root, "coding-data"));
  const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: new SpokenConfirmationLedger() });
  const orch = createOrchestrator({ store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, runners: { claude: claudeRunner(), codex: codexRunner(), router: routerRunner() }, approvals: () => approvals, liveRoot: null });
  const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
  const rt = { store, orch, shaper, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, approvals: () => approvals, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), focus: null } as never;
  const OWNER = { personId: "usman", via: "loopback-owner", actor: "human", deviceId: "usman-pc", sessionId: "sk1.owner" };
  const PROGRAM = { personId: "usman", via: "loopback-owner", actor: "process" };
  const call = (method: string, path: string, body: unknown = {}, principal: unknown = OWNER) =>
    codingRoute({ method, path, url: new URL(`http://x${path}`), body, principal: principal as never }, rt) as Promise<{ status: number; body: any }>;
  const drafted = () => {
    const spec = draftSpec({
      requestedBy: { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "hash" }, channel: "ui", utterance: "x", entry,
      objective: "Set a to 42 in the fixture", doneWhen: [{ id: "c1", text: "alpha passes", evidence: "test", ref: "alpha" }, { id: "c2", text: "a is 42", evidence: "reviewer-confirms" }], roleTemplate: "build+review",
      builders: [{ binding: claudeBinding("claude-opus-5-5", "2.1.280"), owns: { globs: ["src/a.ts"], newFiles: [] } }], reviewer: { binding: claudeBinding("claude-sonnet-5-5", "2.1.280") }, checks: ["fx.test" as never],
    });
    return orch.draft(spec).job;
  };
  return { call, store, orch, shaper, approvals, drafted, PROGRAM, close: () => { orch.close(); store.close(); approvals.close(); } };
}

describe("an editable plan", () => {
  test("a typed request becomes a plan the person can edit: objective, done-when words and non-goals", async () => {
    const w = routeWorld();
    try {
      const shaped = await w.call("POST", "/coding/shape", { requestId: crypto.randomUUID(), utterance: "In fixture-app, make src/a.ts export 42. Sonnet builds and Opus reviews.", channel: "typed" });
      expect(shaped.body.kind).toBe("draft");
      expect(shaped.body.spec.objective).toMatch(/src\/a\.ts export 42/);
      expect(shaped.body.spec.doneWhen.length).toBeGreaterThan(0);
      const id = shaped.body.jobId as string;
      const first = shaped.body.spec.doneWhen[0];
      const edited = await w.call("POST", `/coding/jobs/${id}/plan`, { objective: "Make src/a.ts export 42 and keep its type", doneWhen: [{ id: first.id, text: "src/a.ts exports 42 as a number" }, { text: "Nothing else in src changes" }], nonGoals: ["Do not touch lib/c.ts"] });
      expect(edited.status).toBe(200);
      expect(edited.body.spec.revision).toBe(shaped.body.spec.revision + 1);
      expect(edited.body.spec.objective).toBe("Make src/a.ts export 42 and keep its type");
      expect(edited.body.spec.doneWhen.find((d: any) => d.id === first.id)).toMatchObject({ text: "src/a.ts exports 42 as a number", evidence: first.evidence });
      expect(edited.body.spec.doneWhen.at(-1)).toMatchObject({ text: "Nothing else in src changes", evidence: "reviewer-confirms" });
      expect(edited.body.spec.nonGoals).toEqual(["Do not touch lib/c.ts"]);
      expect(edited.body.specDigest).not.toBe(shaped.body.specDigest);
    } finally { w.close(); }
  }, 120_000);
});

describe("an edit voids earlier confirmations and older drafts", () => {
  test("after an edit the OLD digest can't start the job; the plan can never lose a check; a stopped job's plan is fixed; a program can't edit", async () => {
    const w = routeWorld();
    try {
      const job = w.drafted();
      const oldDigest = (await w.call("GET", `/coding/jobs/${job.id}`)).body.specDigest as string;
      const edited = await w.call("POST", `/coding/jobs/${job.id}/plan`, { objective: "Set a to 43 in the fixture instead" });
      expect(edited.status).toBe(200);
      const stale = await w.call("POST", "/coding/jobs", { specId: job.id, specDigest: oldDigest, confirmation: "ui" });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/changed since it was shown/);
      expect(w.store.getJob(job.id)!.state).toBe("awaiting_confirmation");
      expect((await w.call("POST", `/coding/jobs/${job.id}/plan`, { doneWhen: [{ id: "c9", text: "x" }] })).status).toBe(400);
      expect((await w.call("POST", `/coding/jobs/${job.id}/plan`, { doneWhen: [{ id: "c1", text: "   " }] })).status).toBe(400);
      expect((await w.call("POST", `/coding/jobs/${job.id}/plan`, { objective: "short" })).status).toBe(400);
      expect((await w.call("POST", `/coding/jobs/${job.id}/plan`, {})).status).toBe(400);
      expect(w.store.getJob(job.id)!.spec.doneWhen).toHaveLength(2);
      expect((await w.call("POST", `/coding/jobs/${job.id}/plan`, { objective: "Set a to 44 in the fixture" }, w.PROGRAM)).status).toBe(403);
      w.orch.cancel(job.id);
      const after = await w.call("POST", `/coding/jobs/${job.id}/plan`, { objective: "Set a to 45 in the fixture" });
      expect(after.status).toBe(409);
      expect(after.body.error).toMatch(/plan is fixed/);
    } finally { w.close(); }
  }, 120_000);

  test("a plan edited after the question was read out can't be started by that yes, and a started job's spec never changes", async () => {
    const w = routeWorld();
    try {
      const job = w.drafted();
      const readOut = (await w.call("GET", `/coding/jobs/${job.id}`)).body.specDigest as string;
      await w.call("POST", `/coding/jobs/${job.id}/plan`, { nonGoals: ["Leave docs alone"] });
      expect(() => w.orch.confirmAndStart(job.id, { personId: "usman" as never, via: "voice", deviceId: "usman-pc" as never, sessionId: "voice" }, "spoken-yes", readOut as never)).toThrow(/changed since it was shown/);
      expect(w.store.getJob(job.id)!.runs).toHaveLength(0);
    } finally { w.close(); }
  }, 120_000);

  test("drafting again from edited words closes the older unstarted draft of the same person; another draft is never touched; a program never closes anything", async () => {
    const w = routeWorld();
    try {
      const older = w.drafted();
      const other = w.drafted();
      const shaped = await w.call("POST", "/coding/shape", { requestId: crypto.randomUUID(), utterance: "In fixture-app, make src/a.ts export 43. Sonnet builds and Opus reviews.", channel: "ui", replaces: older.id });
      expect(shaped.body.kind).toBe("draft");
      expect(w.store.getJob(older.id)!.state).toBe("cancelled");
      expect(w.store.events(older.id, 0, 500).some((e) => e.type === "step" && /Replaced by a newer draft/.test((e.payload as any).label))).toBe(true);
      expect(w.store.getJob(other.id)!.state).toBe("awaiting_confirmation");
      expect(w.store.getJob(shaped.body.jobId)!.state).toBe("awaiting_confirmation");
      const start = await w.call("POST", "/coding/jobs", { specId: older.id, specDigest: "0".repeat(64), confirmation: "ui" });
      expect(start.status).toBeGreaterThanOrEqual(400);
      const keep = w.drafted();
      await w.call("POST", "/coding/shape", { requestId: crypto.randomUUID(), utterance: "In fixture-app, make src/a.ts export 44. Sonnet builds and Opus reviews.", channel: "typed", replaces: keep.id }, w.PROGRAM);
      expect(w.store.getJob(keep.id)!.state).toBe("awaiting_confirmation");
    } finally { w.close(); }
  }, 120_000);
});

describe("item 2: a Jarvis request enters the same job system and obeys the same plan edits", () => {
  test("a spoken request is a job in the same store, in the same state, listed by the same route; a page edit makes the spoken yes stale", async () => {
    const w = routeWorld();
    try {
      const { SpokenConfirmationLedger } = await import("../jarvis-execution/voice-confirmation");
      const voice = createCodingVoice({ store: w.store, orch: w.orch, shaper: w.shaper, approvals: () => w.approvals, spoken: new SpokenConfirmationLedger(), cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), setFocus: () => {}, repoIds: () => ["fixture-app"] });
      const caller = { id: "usman", via: "local", actor: "human" };
      const asked = await voice.handle("Jarvis, in fixture-app make src/a.ts export 42. Sonnet builds and Opus reviews.", { caller, spokenYes: null, previousAssistant: null });
      expect(asked?.jobId).toBeTruthy();
      const job = w.store.getJob(asked!.jobId!)!;
      expect(job.state).toBe("awaiting_confirmation");
      expect(job.spec.source.channel).toBe("voice");
      const list = await w.call("GET", "/coding/jobs");
      expect(list.body.jobs.map((j: any) => j.id)).toContain(job.id);
      // The page edits the plan the question just read out; the later "start it" must not start the edited plan unread.
      await w.call("POST", `/coding/jobs/${job.id}/plan`, { objective: "Make src/a.ts export 43 instead" });
      const yes = await voice.handle("start it", { caller, spokenYes: null, previousAssistant: asked!.say });
      expect(yes?.say).toMatch(/plan changed since I asked, so nothing started/);
      expect(w.store.getJob(job.id)!.runs).toHaveLength(0);
      expect(w.store.getJob(job.id)!.state).toBe("awaiting_confirmation");
    } finally { w.close(); }
  }, 120_000);
});

describe("item 1: the plan keeps what the person said to leave alone out of the files the builder may change", () => {
  const entry = { ...fixtureRepo().entry } as never;
  test("'Leave src/a.test.ts alone' is a non-goal, not an owned file; a file named to be changed stays owned", () => {
    const plan = heuristicPlan(entry, "Change src/a.ts", "In app, change src/a.ts so a is 42. Leave src/a.test.ts alone. Don't touch lib/c.ts.")!;
    expect(plan.builders[0].owns.globs.concat(plan.builders[0].owns.newFiles)).toEqual(["src/a.ts"]);
    expect(plan.nonGoals).toEqual(expect.arrayContaining(["Do not change src/a.test.ts", "Do not change lib/c.ts"]));
  });
  test("a file named both to change and to leave is still owned (the plan never silently drops work that was asked for)", () => {
    const plan = heuristicPlan(entry, "x", "Update src/a.ts and src/b.ts. Leave src/b.ts formatting alone.")!;
    expect(plan.builders[0].owns.globs).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
  });
  test("only off-limits files named: nothing to own, so the shaper asks which files instead of guessing", () => {
    expect(heuristicPlan(entry, "x", "Leave src/a.test.ts alone.")).toBeNull();
  });
});

describe("review finding 3: what a clause says to leave alone, for files, folders and absolute paths", () => {
  const entry = { ...fixtureRepo().entry } as never;
  const owned = (p: { builders: { owns: { globs: string[]; newFiles: string[] } }[] }) => p.builders[0].owns.globs.concat(p.builders[0].owns.newFiles);
  test("a folder to leave alone is a non-goal, not 'src/legacy/**'", () => {
    const plan = heuristicPlan(entry, "x", "Fix src/a.ts. Leave src/legacy/ alone.")!;
    expect(owned(plan)).toEqual(["src/a.ts"]);
    expect(plan.nonGoals).toContain("Do not change src/legacy/");
  });
  test("one sentence: 'Fix src/a.ts but leave src/a.test.ts alone' owns a.ts and excludes the test", () => {
    const plan = heuristicPlan(entry, "x", "Fix src/a.ts but leave src/a.test.ts alone.")!;
    expect(owned(plan)).toEqual(["src/a.ts"]);
    expect(plan.nonGoals).toContain("Do not change src/a.test.ts");
    const comma = heuristicPlan(entry, "x", "Change src/a.ts, and don't touch lib/c.ts")!;
    expect(owned(comma)).toEqual(["src/a.ts"]);
    expect(comma.nonGoals).toContain("Do not change lib/c.ts");
  });
  test("an absolute path inside the repo named to leave alone is excluded too", () => {
    const root = (entry as { canonicalPath: string }).canonicalPath.replace(/\\/g, "/");
    const plan = heuristicPlan(entry, "x", `Fix src/a.ts and do not touch ${root}/lib/c.ts please.`)!;
    expect(owned(plan)).toEqual(["src/a.ts"]);
    expect(plan.nonGoals).toContain("Do not change lib/c.ts");
  });
  test("a folder named to change still becomes a glob", () => {
    expect(heuristicPlan(entry, "x", "Tidy everything in src/ and leave lib/c.ts alone.")!.builders[0].owns.globs).toEqual(["src/**"]);
  });
});

describe("review finding 4: Codex models are models; ordinary words that look like model names are not requests", () => {
  const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "s" } as never;
  async function shaped(utterance: string) {
    const fx = fixtureRepo();
    roots.push(fx.root);
    const registry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app", description: "fixture" }] } as never;
    const sh = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null, choice: () => ({ route: ((_t: string, c: { selected: string }) => ({ model: c.selected, fallbackFrom: null })) as never, hasKey: () => true, readings: [], codexReady: true }) });
    return sh.shape({ utterance, channel: "typed", principal, usePlanner: false });
  }
  test.each([
    ["In fixture-app, make src/a.ts export 42. Use gpt-5.6-sol for the review.", "gpt-5.6-sol"],
    ["In fixture-app, make src/a.ts export 42. Opus builds and Codex gpt-5.5 reviews.", "gpt-5.5"],
  ])("%s", async (utterance, model) => {
    const r = await shaped(utterance);
    expect(r.kind).toBe("draft");
    if (r.kind === "draft") expect(r.spec.roles.find((x) => x.role === "reviewer")?.agent?.model).toBe(model);
  });
  test.each([
    "In fixture-app, move the cursor fix into src/a.ts.",
    "In fixture-app, make the Gemini review summary shorter in src/a.ts.",
    "In fixture-app, fix the Grok test helper in src/a.ts.",
  ])("%s", async (utterance) => {
    expect((await shaped(utterance)).kind).not.toBe("refused"); // drafted, or asked what to change: never taken for a model request
  });
  test("a model that is the subject of a role verb is still refused", async () => {
    expect((await shaped("In fixture-app, make src/a.ts export 42. Gemini reviews it.")).kind).toBe("refused");
    expect((await shaped("In fixture-app, make src/a.ts export 42. Have Grok review it.")).kind).toBe("refused");
  });
});
