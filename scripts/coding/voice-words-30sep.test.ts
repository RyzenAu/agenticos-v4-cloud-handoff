import { describe, expect, test } from "bun:test";
import { isCodingRequest } from "../../src/lib/commands/coding";
import { validateAccounts } from "./accounts";
import { claudeSlotFromWords, spokenClaude } from "./shaper";

/** 30 Sep 2026, live voice: the owner's real transcript went to Hermes instead of the coding harness. */
const REAL = "In agentic os add a test file script slash coding slash voice account dot test dot ts that checks is clots law except clod max semicolon max dash two and rejects clod dash other son it builds on cloud account two.";
const TWO = validateAccounts({ version: 1, codex: [], claude: [{ slot: "claude:max", configDir: null }, { slot: "claude:max-2", configDir: "C:/x/.claude-mu-max-2" }] });

describe("spoken coding requests (30 Sep 2026)", () => {
  test("the target said first still reaches the coding harness", () => {
    expect(isCodingRequest(REAL, ["agentic-os"])).toBe(true);
    expect(isCodingRequest("in agentic-os add a test file scripts/coding/voice-account.test.ts. Sonnet builds on Claude account 2.", ["agentic-os"])).toBe(true);
    expect(isCodingRequest("On the dental site, fix the booking button", [])).toBe(true);
  });
  test("non-code errands with a leading place are still not coding", () => {
    expect(isCodingRequest("in the kitchen add milk to the list", ["agentic-os"])).toBe(false);
    expect(isCodingRequest("on Friday add a meeting with Mehroz", ["agentic-os"])).toBe(false);
    expect(isCodingRequest("in my calendar add a reminder for prayer", ["agentic-os"])).toBe(false);
  });
  test("speech-to-text's 'cloud account two' names the second Claude account", () => {
    expect(spokenClaude("builds on cloud account two")).toBe("builds on claude account 2");
    expect(claudeSlotFromWords(REAL, TWO)).toBe("claude:max-2");
    expect(spokenClaude("save it to the cloud")).toBe("save it to the cloud");
  });
});

describe("the coding handoff is one memory fact the memory service accepts (30 Sep 2026)", () => {
  test("a long objective and many receipts still pass the memory screen, naming the accounts that ran", async () => {
    const { handoffFact, handoffFactTitle } = await import("./orchestrator");
    const { screenFact } = await import("../memory/guard");
    const h = {
      id: "h", jobId: "j", repoId: "agentic-os", baseSha: "a".repeat(40), jobBranch: "coding/in-agentic-os-add-a-286ff8", headSha: "bd5f70feed63d25f441a3949aa7676f45cd5360b",
      outcome: "completed-verified", objective: "In agentic-os, add a new test file scripts/coding/account-label.test.ts: ".repeat(8),
      changedFiles: [{ path: "scripts/coding/account-label.test.ts", status: "A" }],
      tests: [{ commandId: "aos.test-coding", passed: 342, failed: 0, exitCode: 0 }, { commandId: "aos.typecheck", passed: null, failed: null, exitCode: 0 }],
      review: { verdict: "approve", blockers: 0, majors: 0, minors: 2 },
      usage: [{ roleId: "builder-1", model: "claude-sonnet-5", accountSlot: "claude:max-2", turns: 1, inputTokens: 28, outputTokens: 2520 }, { roleId: "reviewer", model: "claude-opus-5-5", accountSlot: "claude:max-2", turns: 1, inputTokens: 1, outputTokens: 1 }],
      followUps: [], notDone: [], links: { job: "/coding/j", work: "/coding", memory: null }, createdAt: "2026-09-30T10:00:00Z",
    } as never;
    const text = handoffFact(h, "286ff8");
    const title = handoffFactTitle("In agentic-os, add a new test file scripts/coding/account-label.test.ts: ".repeat(3));
    expect(screenFact(text, title)).toEqual({ ok: true });
    expect(text).toContain("builder-1 claude-sonnet-5 on Claude Max 2");
    expect(text).toContain("/coding/j");
  });
});

describe("'start a coding job' anywhere in a spoken turn (30 Sep 2026, live)", () => {
  test("the owner's real turns reach the coding harness", () => {
    expect(isCodingRequest("A job is started quitting job in a Gentek OS. Had a small test for the cloud account slots. Use cloud account too.", ["agentic-os"])).toBe(true);
    expect(isCodingRequest("um the one which is under muhammad khan's name the second one and i want you to start a coding job in agentic os and which is just add a small test for the cloud sorry cloud account slots and", ["agentic-os"])).toBe(true);
  });
  test("talk about quitting a job is not coding", () => {
    expect(isCodingRequest("I'm thinking about quitting my job", ["agentic-os"])).toBe(false);
    expect(isCodingRequest("what's a coding job worth these days", ["agentic-os"])).toBe(false);
  });
});
