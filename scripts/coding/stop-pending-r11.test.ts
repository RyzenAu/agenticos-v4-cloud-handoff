// Round 11 (defects 2 and 5): an explicit Stop while the coding planner is asking a question, and typed vs spoken recorded on the draft.
//   2. While the shaper's question was pending, the next words were taken as its answer, so "stop", "never mind", "cancel the draft" or
//      "please stop the coding job" became the answer (and "stop.ts" was refused as one). A whole-utterance stop now drops the pending request;
//      a file name or path is still an answer.
//   5. A coding job requested by TYPING showed "asked by you by voice": the coding voice always shaped with channel "voice".
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
import { isStopCommand } from "./stop-words";
import { CodingStore } from "./store";
import { cleanup, fixtureRepo } from "./test-fixtures";
import { createCodingVoice } from "./voice";
import { createCodingCommandEntry } from "./command-entry";

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
  const caller = { id: "usman", name: "Usman", via: "local", actor: "human" };
  const turn = (extra: Record<string, unknown> = {}) => ({ caller, spokenYes: null, previousAssistant: null, ...extra });
  /** A request the planner can't place without asking which files: the shaper's question is now pending. */
  const ask = async () => {
    const r = await voice.handle("Have a builder fix the greeting in the fixture app", turn());
    expect(r?.say).toMatch(/\?/);
    expect(voice.peek(caller).draftId).toBeTruthy();
    return r;
  };
  return { store, voice, shaper, caller, turn, ask, close: () => { orch.close(); store.close(); approvals.close(); } };
}

describe("isStopCommand (whole utterance only)", () => {
  test("stop and cancel commands", () => {
    for (const w of ["stop", "Stop.", "cancel", "stop that", "never mind", "nevermind", "cancel the draft", "please stop the coding job", "stop it now", "OK, cancel that", "Jarvis, stop", "scrap the job", "drop the draft", "forget the coding request"]) expect([w, isStopCommand(w)]).toEqual([w, true]);
  });
  test("a file name, a path or a sentence that only contains the word is not", () => {
    for (const w of ["src/stop.ts", "stop.ts", "the stop button in src/ui/stop-button.tsx", "stop-button.tsx", "the stop button", "make the stop button red", "cancel the second step of the checkout", "src\stop.ts", "drop it", "forget it", "scrap that", "forget that one"]) expect([w, isStopCommand(w)]).toEqual([w, false]);
  });
});

describe("Stop while the shaper's question is pending", () => {
  test("each explicit stop drops the pending request and its question; nothing is drafted or started", async () => {
    for (const words of ["stop", "cancel", "stop that", "never mind", "cancel the draft", "please stop the coding job"]) {
      const w = world();
      await w.ask();
      const before = w.store.listJobs({ limit: 50 }).length;
      const r = await w.voice.handle(words, w.turn());
      expect([words, r?.say]).toEqual([words, "Okay, I've dropped that coding request and its question. Nothing was started."]);
      expect([words, w.voice.peek(w.caller).draftId]).toEqual([words, null]);
      expect(w.store.listJobs({ limit: 50 }).length).toBe(before);
      w.close();
    }
  });

  test("a file name or path is still the answer", async () => {
    for (const words of ["src/stop.ts", "stop.ts", "the stop button in src/ui/stop-button.tsx"]) {
      const w = world();
      await w.ask();
      const r = await w.voice.handle(words, w.turn());
      expect([words, r === null]).toEqual([words, false]);
      expect(r!.say).not.toMatch(/dropped/);
      w.close();
    }
  });

  test("the entry's cancelPending (the command service's bare Stop) drops it too, and says whether one was pending", async () => {
    const w = world();
    const entry = createCodingCommandEntry({ voice: w.voice, store: w.store });
    expect(entry.hasPendingQuestion({ personId: "usman", actor: "human", via: "local" })).toBe(false);
    await w.ask();
    expect(entry.hasPendingQuestion({ personId: "usman", actor: "human", via: "local" })).toBe(true);
    expect(entry.cancelPending({ personId: "usman", actor: "human", via: "local" })).toBe(true);
    expect(w.voice.peek(w.caller).draftId).toBeNull();
    expect(entry.cancelPending({ personId: "usman", actor: "human", via: "local" })).toBe(false);
    w.close();
  });
});

describe("typed vs spoken on the draft (defect 5)", () => {
  test("typed words are recorded as typed; spoken as voice; no channel stays voice", async () => {
    for (const [channel, expected] of [["typed", "typed"], ["voice", "voice"], [undefined, "voice"]] as const) {
      const w = world();
      await w.voice.handle("Set a to 42 in src/a.ts of the fixture app.", w.turn(channel ? { channel } : {}));
      const job = w.store.listJobs({ limit: 1 })[0];
      expect([channel, job.spec.source.channel]).toEqual([channel, expected]);
      w.close();
    }
  });

  test("the entry passes the channel through", async () => {
    const w = world();
    const entry = createCodingCommandEntry({ voice: w.voice, store: w.store });
    const r = await entry.handle("Set a to 42 in src/a.ts of the fixture app.", { personId: "usman", actor: "human", via: "tailnet", channel: "typed" });
    expect(w.store.getJob(r!.jobId!)!.spec.source.channel).toBe("typed");
    w.close();
  });
});

describe("review follow-ups (round 11)", () => {
  test("only a reply that made a NEW draft for this person is marked drafted; a status reply about it is not", async () => {
    const w = world();
    const entry = createCodingCommandEntry({ voice: w.voice, store: w.store });
    const made = await entry.handle("Set a to 42 in src/a.ts of the fixture app.", { personId: "usman", actor: "human", via: "local" });
    expect(made?.drafted).toBe(true);
    const status = await entry.handle("how's the coding job going", { personId: "mehroz", actor: "human", via: "tailnet" });
    expect(status?.drafted).toBeUndefined();
    w.close();
  });

  test("a stop that names the coding work, said while a question is pending and this conversation's job is running, stops that job and says both things", async () => {
    const w = world();
    await w.voice.handle("Set a to 42 in src/a.ts of the fixture app.", w.turn());
    const job = w.store.listJobs({ limit: 1 })[0];
    w.store.transitionJob(job.id, "preparing");
    expect(w.store.getJob(job.id)!.state).toBe("preparing");
    await w.ask();
    const r = await w.voice.handle("stop the build", w.turn());
    expect(r?.say).toMatch(/dropped the coding request that was waiting for your answer(, and stopped the coding job| and asked the coding job to stop)/);
    expect(r?.jobId).toBe(job.id);
    w.close();
  });
});

describe("release re-check M2: 'stop the coding job' acts on this person's own job, and says what really happened", () => {
  test("another founder's 'stop the coding job' never stops Usman's job", async () => {
    const w = world();
    await w.voice.handle("Set a to 42 in src/a.ts of the fixture app.", w.turn());
    const job = w.store.listJobs({ limit: 1 })[0];
    w.store.transitionJob(job.id, "preparing");
    const r = await w.voice.handle("stop the coding job", { caller: { id: "mehroz", name: "Mehroz", via: "tailnet", actor: "human" }, spokenYes: null, previousAssistant: null });
    expect(r?.say).toBe("You have no coding job of your own to stop, so nothing was stopped.");
    expect(w.store.getJob(job.id)!.state).toBe("preparing");
    w.close();
  });

  test("a finished job is 'had already finished'; a running one is stopped only as far as the re-read state says", async () => {
    const w = world();
    await w.voice.handle("Set a to 42 in src/a.ts of the fixture app.", w.turn());
    const job = w.store.listJobs({ limit: 1 })[0];
    w.store.transitionJob(job.id, "preparing");
    const r = await w.voice.handle("stop the coding job", w.turn());
    const after = w.store.getJob(job.id)!.state;
    expect(r?.say).toBe(after === "cancelled" ? "Stopped the coding job. Its working copies are kept." : `Stop requested; not yet confirmed. The coding job is ${after.replace(/_/g, " ")} now, so check it before trusting that it stopped.`);
    const again = await w.voice.handle("stop the coding job", w.turn());
    if (after === "cancelled") expect(again?.say).toBe("That coding job had already been stopped, so there was nothing to stop.");
    w.close();
  });
});
