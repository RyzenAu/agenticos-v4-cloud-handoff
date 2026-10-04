// Round 10 (jobs owner): Stop from the conversation reaches the RIGHT coding job. The conversation's "stop that task" knows which job it means, but the
// coding entry only understood "stop the coding job", which stopped this person's newest job (or anyone's newest), possibly another task.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { MemoryReceiptSink } from "../model-router/receipts";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry } from "./contracts";
import { createOrchestrator } from "./orchestrator";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { FakeClaude, FakeCodex } from "./runners/fakes";
import { routerRunner } from "./runners/router";
import { createShaper } from "./shaper";
import { CodingStore } from "./store";
import { cleanup, fixtureRepo } from "./test-fixtures";
import { createCodingVoice } from "./voice";

const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });

function world() {
  const fx = fixtureRepo();
  roots.push(fx.root);
  const store = CodingStore.open(join(fx.root, "coding-data"));
  const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app: src and lib" }] };
  const ledger = new SpokenConfirmationLedger();
  const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: ledger });
  const orch = createOrchestrator({
    store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS,
    runners: {
      claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: (() => new FakeClaude({})) as never, platform: "linux", env: { PATH: "/bin" } }),
      codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: (() => new FakeCodex()) as never, platform: "linux", env: {} }),
      router: routerRunner({ chat: async () => { throw new Error("unused"); } }),
    },
    approvals: () => approvals, liveRoot: null, fleetSink: new MemoryReceiptSink(), claudeAllowance: () => null,
    memory: { writes: () => false, save: async () => ({ ok: false }) }, codexIsolation: () => ({ ok: true, message: "" }),
  });
  const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
  const voice = createCodingVoice({ store, orch, shaper, approvals: () => approvals, spoken: ledger, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), setFocus: () => undefined, repoIds: () => ["fixture-app"] });
  const turn = (actor: "human" | "process") => ({ caller: { id: "usman", name: "Usman", via: "local", actor }, spokenYes: null, previousAssistant: null });
  return { store, orch, voice, turn, close: () => { orch.close(); store.close(); approvals.close(); } };
}

describe("stop the coding job <id>", () => {
  test("stops exactly that job, even when another (newer) one is the one in hand; the reply says what really happened", async () => {
    const w = world();
    await w.voice.handle("Set a to 42 in src/a.ts of the fixture app.", w.turn("human"));
    const a = w.store.listJobs({ limit: 1 })[0];
    await w.voice.handle("Set a to 7 in src/a.ts of the fixture app.", w.turn("human"));
    const b = w.store.listJobs({ limit: 1 })[0];
    expect(b.id).not.toBe(a.id);
    const r = await w.voice.handle(`stop the coding job ${a.id}`, w.turn("human"));
    expect(r).toMatchObject({ say: "Stopped the coding job. Its working copies are kept.", jobId: a.id });
    expect(w.store.getJob(a.id)!.state).toBe("cancelled");
    expect(w.store.getJob(b.id)!.state).toBe("awaiting_confirmation");
    // Asked again: it is already stopped, and nothing else is touched.
    expect((await w.voice.handle(`stop the coding job ${a.id}`, w.turn("human")))!.say).toBe("That coding job had already been stopped, so there was nothing to stop.");
    expect(w.store.getJob(b.id)!.state).toBe("awaiting_confirmation");
    w.close();
  });

  test("a program may not stop it, and an unknown id stops nothing", async () => {
    const w = world();
    await w.voice.handle("Set a to 42 in src/a.ts of the fixture app.", w.turn("human"));
    const a = w.store.listJobs({ limit: 1 })[0];
    expect((await w.voice.handle(`stop the coding job ${a.id}`, w.turn("process")))!.say).toMatch(/only a person can start, stop/);
    expect(w.store.getJob(a.id)!.state).toBe("awaiting_confirmation");
    expect((await w.voice.handle("stop the coding job 00000000-0000-4000-8000-000000000000", w.turn("human")))!.say).toBe("I can't find that coding job, so nothing was stopped.");
    expect(w.store.getJob(a.id)!.state).toBe("awaiting_confirmation");
    w.close();
  });
});

describe("Jev chose the coding lane (production, 4 Oct)", () => {
  test("words the narrow coding list misses are drafted when Jev decided coding; never started, and status words still read as status", async () => {
    const w = world();
    const words = "In the fixture app, add a one-line Fonts note to the README";
    const before = w.store.listJobs({ limit: 50 }).length;
    expect(await w.voice.handle(words, w.turn("human"))).toBeNull(); // the old behaviour, without Jev's decision: not claimed
    expect(w.store.listJobs({ limit: 50 }).length).toBe(before);
    const r = await w.voice.handle(words, { ...w.turn("human"), jevDecided: true });
    expect(r?.say).toMatch(/Start it\?|which|repo|\?/i);
    const jobs = w.store.listJobs({ limit: 50 });
    if (jobs.length > before) expect(jobs[0].state).toBe("awaiting_confirmation"); // a draft at most: nothing started
    const status = await w.voice.handle("how's the coding job going", { ...w.turn("human"), jevDecided: true });
    expect(w.store.listJobs({ limit: 50 }).length).toBe(jobs.length);
    expect(status?.say ?? "").not.toMatch(/Start it\?/);
    w.close();
  });
  test("with no question pending, words about a job never become a new draft when Jev decided coding (review of c66cc05f)", async () => {
    const w = world();
    const jobs = w.store.listJobs({ limit: 50 });
    for (const about of ["please stop the coding job", "so what's the builder doing", "and what's the builder doing", "can you stop the builder", "hey, how's the coding job", "go ahead and merge it", "what is the builder doing"]) {
      const r2 = await w.voice.handle(about, { ...w.turn("human"), jevDecided: true });
      expect(w.store.listJobs({ limit: 50 }).length).toBe(jobs.length);
      expect(r2?.say ?? "").not.toMatch(/Start it\?/);
      // Never the shaper's answer: either nothing (not claimed) or a reply about the job in hand.
      expect(r2 === null || (!!r2.jobId && r2.jobId === jobs[0]?.id) || r2.say === "There's no coding job yet.").toBe(true);
    }
    w.close();
  });
});


describe("'start it' starts only the draft bound to the conversation it was said in (owner, 4 Oct)", () => {
  const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222", C3 = "33333333-3333-4333-8333-333333333333";
  async function twoDrafts() {
    const w = world();
    await w.voice.handle("Set a to 42 in src/a.ts of the fixture app.", w.turn("human"));
    const a = w.store.listJobs({ limit: 1 })[0];
    await w.voice.handle("Set a to 7 in src/a.ts of the fixture app.", w.turn("human"));
    const b = w.store.listJobs({ limit: 1 })[0];
    expect(b.id).not.toBe(a.id);
    const bound = new Map<string, string[]>([[C1, [a.id]], [C2, [b.id]]]);
    w.voice.setPendingDrafts((_person, conversationId) => bound.get(conversationId ?? "") ?? []);
    return { w, a, b, bound };
  }
  test("two pending drafts in different conversations: the yes in conversation 1 starts draft A only, never the latest (B)", async () => {
    const { w, a, b } = await twoDrafts();
    const r = await w.voice.handle("start it", { ...w.turn("human"), conversationId: C1 });
    expect(r).toMatchObject({ jobId: a.id, started: true });
    expect(w.store.getJob(a.id)!.state).not.toBe("awaiting_confirmation");
    expect(w.store.getJob(b.id)!.state).toBe("awaiting_confirmation");
    // Asked again there: nothing is waiting in that conversation any more, and B (waiting elsewhere) is not started.
    const again = await w.voice.handle("start it", { ...w.turn("human"), conversationId: C1 });
    expect(again?.started).toBeUndefined();
    expect(w.store.getJob(b.id)!.state).toBe("awaiting_confirmation");
    w.close();
  });
  test("a yes in a conversation with no draft bound to it starts nothing and says so", async () => {
    const { w, a, b } = await twoDrafts();
    const r = await w.voice.handle("start it", { ...w.turn("human"), conversationId: C3 });
    expect(r?.say).toContain("No draft is waiting to start in this conversation");
    expect([w.store.getJob(a.id)!.state, w.store.getJob(b.id)!.state]).toEqual(["awaiting_confirmation", "awaiting_confirmation"]);
    w.close();
  });
  test("two drafts bound to the same conversation: asks once which one, starts neither", async () => {
    const { w, a, b, bound } = await twoDrafts();
    bound.set(C3, [a.id, b.id]);
    const r = await w.voice.handle("start it", { ...w.turn("human"), conversationId: C3 });
    expect(r?.say).toMatch(/Two drafts are waiting to start in this conversation/);
    expect(r?.started).toBeUndefined();
    expect([w.store.getJob(a.id)!.state, w.store.getJob(b.id)!.state]).toEqual(["awaiting_confirmation", "awaiting_confirmation"]);
    w.close();
  });
  test("a bare 'yes' that doesn't follow Jarvis's own 'Start it?' starts nothing, even with one draft bound here", async () => {
    const { w, a } = await twoDrafts();
    const r = await w.voice.handle("yes", { ...w.turn("human"), conversationId: C1, previousAssistant: "It's 3 pm." });
    expect(r?.say).toContain("not sure what that yes is for");
    expect(w.store.getJob(a.id)!.state).toBe("awaiting_confirmation");
    w.close();
  });
  test("an unconfirmed stop says 'Stop requested; not yet confirmed', never 'Stopped'", async () => {
    const src = await Bun.file(new URL("./voice.ts", import.meta.url)).text();
    expect(src).not.toMatch(/I asked the [^`]* to stop/);
    expect(src.match(/Stop requested; not yet confirmed/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
