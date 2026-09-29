// Stage D: Jarvis's voice turn → the ONE memory API. TEMP synthetic vault + FAKE Hindsight (proxy
// mode). Forget of kinds b/c needs the voice pipeline's own spoken-yes event, said after the question.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice } from "../free-voice";
import { cleanup, setup, usman } from "./testing/harness";
import { createMemoryVoiceTurn } from "./voice-turn";

afterEach(cleanup);
const T = { timeout: 30_000 };

async function rig() {
  const h = await setup({ proxy: true });
  let clock = 1_000_000;
  const now = () => clock;
  // The ONE spoken-yes ledger the approval service redeems from (the voice pipeline records into it).
  const spoken = h.spoken;
  const turn = createMemoryVoiceTurn({ api: () => h.api, spoken, now });
  return { h, spoken, turn, tick: (ms: number) => void ((clock += ms), h.advance(ms)) };
}

describe("Stage D · Jarvis voice → memory API", () => {
  test(
    "remember, save to the vault, recall with the source named, correct that",
    async () => {
      const { h, turn } = await rig();
      await h.api.sync({ force: true });
      const r = await turn(usman, "Remember that the synthetic Heron clinic parks behind gate C");
      expect(r?.outcome).toBe("remembered");
      expect(r?.content).toContain("Hindsight memory");
      const v = await turn(usman, "Save this to the vault: the synthetic Heron clinic invoices on the 1st");
      expect(v?.outcome).toBe("saved-to-vault");
      expect(v?.content).toContain("wiki/topics/business/memory-business-shared.md");
      const q = await turn(usman, "What do we know about the Heron clinic?");
      expect(q?.outcome).toBe("recalled");
      expect(q?.content).toMatch(/from the (vault note wiki\/|Jarvis memory mem-)/);
      const ask = await turn(usman, "Correct that: the synthetic Heron clinic parks behind gate D.");
      expect(ask?.outcome).toBe("needs-confirm");
      expect(ask?.content).toContain("Say yes to update it");
      const c = await turn(usman, "yes", { previousAssistant: ask!.content });
      expect(c?.outcome).toBe("corrected");
      expect(await turn(usman, "open notepad")).toBeNull(); // not a memory phrase: the turn carries on
    },
    T,
  );

  test(
    "forget needs a spoken yes said after the question: a typed yes, an earlier yes and a replay can't approve",
    async () => {
      const { h, spoken, turn, tick } = await rig();
      const m = await turn(usman, "Remember that the synthetic Egret account renews in April");
      const memId = m!.facts_used[0];
      const early = spoken.record("yes")!; // said BEFORE the question
      tick(1000);
      const ask = await turn(usman, "Forget that");
      expect(ask?.outcome).toBe("needs-confirm");
      expect(ask?.content).toContain("Say yes to approve");
      tick(1000);
      const typed = await turn(usman, "yes", { spokenYes: null, previousAssistant: ask!.content });
      expect(typed?.content).toContain("spoken yes");
      expect(h.api.item(memId)).not.toBeNull();
      const stale = await turn(usman, "yes", { spokenYes: early.id, previousAssistant: typed!.content });
      expect(stale?.content).toContain("spoken yes");
      expect(h.api.item(memId)).not.toBeNull();
      tick(1000);
      const yes = spoken.record("yes")!;
      const done = await turn(usman, "yes", { spokenYes: yes.id, previousAssistant: stale!.content });
      expect(done?.outcome).toBe("forgotten");
      expect(h.api.item(memId)).toBeNull();
      expect(h.bankDocs().has(memId)).toBe(false);
      const del = h.fake.calls.find((c) => c.method === "DELETE" && c.path.endsWith(memId));
      expect(del?.approval).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/); // the proxy token carries the (durable) approval id
      // The event is used up: saying "yes" again approves nothing.
      expect(await turn(usman, "yes", { spokenYes: yes.id })).toBeNull();
    },
    T,
  );

  test(
    "a yes after a different line (not our question) is not a memory answer; kind a needs no approval",
    async () => {
      const { h, spoken, turn, tick } = await rig();
      await h.api.sync({ force: true });
      const q = await turn(usman, "What do we know about Osprey proposals?");
      expect(q?.facts_used[0]).toBe("n-proposal-terms");
      const ask = await turn(usman, "forget that");
      if (ask?.outcome !== "needs-confirm") throw new Error(JSON.stringify(ask));
      tick(1000);
      const yes = spoken.record("yes")!;
      expect(await turn(usman, "yes", { spokenYes: yes.id, previousAssistant: "It's 9am in Sydney." })).toBeNull();
      const q2 = await turn(usman, "What do we know about Osprey proposals?");
      const un = await turn(usman, "remove that from the index");
      expect(un?.outcome).toBe("unindexed");
      expect(h.bankDocs().has("n-proposal-terms")).toBe(false);
      expect(q2).not.toBeNull();
    },
    T,
  );

  test("the free-voice turn asks memory first, by rules, only with a verified caller", async () => {
    const root = mkdtempSync(join(tmpdir(), "mu-voice-memory-"));
    try {
      const seen: unknown[] = [];
      const engine = freeVoice(root, {
        key: () => "",
        fetch: (async () => {
          throw new Error("no network in this test");
        }) as unknown as typeof fetch,
        memory: async (utterance, t) => (seen.push({ utterance, ...t }), /^remember/i.test(utterance) ? "Remembered in Hindsight memory as mem-0000000001." : null),
      });
      const caller = { id: "usman", name: "Usman", via: "local" };
      const r = (await engine.handle("/voice/free/turn", { messages: [{ role: "user", content: "remember that the synthetic Wren desk opens at 8" }], spokenYes: "not-a-uuid" }, caller)) as { content: string; model: string };
      // (J4: an ID is never spoken; it is on the Memory page.)
      expect(r).toMatchObject({ content: "Remembered in Hindsight memory.", model: "rules" });
      expect(seen[0]).toMatchObject({ caller, spokenYes: "not-a-uuid", previousAssistant: null });
      // No verified caller (e.g. an older host): memory is never consulted.
      seen.length = 0;
      await engine.handle("/voice/free/turn", { messages: [{ role: "user", content: "remember that the synthetic Wren desk opens at 8" }] }).catch(() => null);
      expect(seen).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("REVIEW-STAGE-D B4: ordinary speech never overwrites a fact", () => {
  test(
    "'Actually, …' goes to the brain; an explicit correction is read back, and only a yes supersedes",
    async () => {
      const { h, turn } = await rig();
      const r = await turn(usman, "Remember that the synthetic Kestrel clinic opens at 9am");
      const id = r!.facts_used[0];
      await turn(usman, "What do we know about the Kestrel clinic?");
      // The review's repros: none of these reach memory now.
      expect(await turn(usman, "Actually, can you open my email inbox for me")).toBeNull();
      expect(await turn(usman, "Actually open YouTube")).toBeNull();
      expect(await turn(usman, "actually it opens at 10am")).toBeNull();
      expect(h.api.item(id)!.row.status).toBe("current");
      // An explicit correction asks first; "no" (or anything else) changes nothing.
      const ask = await turn(usman, "Correct that: the synthetic Kestrel clinic opens at 10am.");
      expect(ask?.outcome).toBe("needs-confirm");
      expect(ask?.content).toContain('to "The synthetic Kestrel clinic opens at 10am."');
      const no = await turn(usman, "no", { previousAssistant: ask!.content });
      expect(no?.outcome).toBe("cancelled");
      expect(h.api.item(id)!.row.status).toBe("current");
      const ask2 = await turn(usman, "Correct that: the synthetic Kestrel clinic opens at 10am.");
      // A yes after some other line (not our question) is not an answer to it.
      expect(await turn(usman, "yes", { previousAssistant: "It is sunny in Sydney." })).toBeNull();
      expect(h.api.item(id)!.row.status).toBe("current");
      const yes = await turn(usman, "yes", { previousAssistant: ask2!.content });
      expect(yes?.outcome).toBe("corrected");
      expect(h.api.item(id)!.row.status).toBe("superseded");
    },
    T,
  );
});

describe("Stage D · preview and quiet copies", () => {
  test("a copy never reads the switch from the shared config and never writes the real vault", async () => {
    const { copyEnv } = await import("./plugin");
    expect(copyEnv("C:/nowhere", { ARGENTIC_PREVIEW: "1", MU_MEMORY_WRITES: "on" }).MU_MEMORY_WRITES).toBe("off");
    expect(copyEnv("C:/nowhere", { AGENTIC_OS_NO_BACKGROUND: "1", MU_MEMORY_WRITES: "on" }).MU_MEMORY_WRITES).toBe("off");
    expect(copyEnv("C:/nowhere", { AGENTIC_OS_NO_BACKGROUND: "1", MU_MEMORY_WRITES: "on", MU_WIKI_ROOT: "C:/synthetic" }).MU_MEMORY_WRITES).toBe("on");
    const { quietMemoryAllowed } = await import("../preview-guard");
    const own = { MU_WIKI_ROOT: "C:/synthetic", MEMORY_STATE_DIR: "C:/synthetic-state" };
    expect(quietMemoryAllowed("/__memory/remember", own)).toBe(true);
    expect(quietMemoryAllowed("/__operator/voice/free/turn", own)).toBe(true);
    expect(quietMemoryAllowed("/__memory/remember", {})).toBe(false);
    expect(quietMemoryAllowed("/__operator/voice/free/stt", own)).toBe(true);
    expect(quietMemoryAllowed("/__operator/voice/free/tts", own)).toBe(false);
    expect(quietMemoryAllowed("/__operator/away", own)).toBe(false);
  });
});
