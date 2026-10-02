/**
 * Programme round 3 (1 Oct 2026), the coding handoff that failed with `prohibited-content`.
 *
 * Diagnosis (synthetic text only, no real handoff or memory read): the memory screen was refusing ordinary coding
 * requests that talk ABOUT credentials ("the password is stored hashed", "the api key is never logged", "the token is
 * validated before use"). A strong label (password, api key, access token, credentials, passcode, licence key) followed by
 * "is" and a word was read as "label is VALUE", so the HANDLING word after "is" was taken for the secret: 220 of 435
 * synthetic objective sentences were refused. Words like token or key on their own, file paths, commit hashes and model
 * names were never the problem.
 *
 * Fix, two layers: (1) the screen knows the words that describe how a credential is handled (hashed, logged, validated,
 * masked, never, ...) and does not read them as a value; (2) the orchestrator saves the same handoff without the request's
 * words if the screen still refuses it (see scripts/coding/orchestrator.test.ts). The screen is not otherwise relaxed: a
 * value after the label, or after a colon, is still a secret.
 */
import { describe, expect, test } from "bun:test";
import type { Handoff } from "../coding/contracts";
import { handoffFact, handoffFactNeutral, handoffFactTitle } from "../coding/orchestrator";
import { screenFact } from "./guard";

const handoff = (objective: string, over: Partial<Handoff> = {}): Handoff =>
  ({
    id: "00000000-0000-4000-8000-000000000000",
    jobId: "674f43aa-1b2c-4d3e-8f90-a1b2c3d4e5f6",
    repoId: "agenticos",
    baseSha: "a".repeat(40),
    jobBranch: "coding/fix-the-handoff-674f43",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    outcome: "failed",
    objective,
    changedFiles: [{ path: "scripts/memory/guard.ts", status: "M" }],
    tests: [{ commandId: "bun-test", passed: 12, failed: 1, exitCode: 1 }],
    review: { verdict: "request-changes", blockers: 1, majors: 1, minors: 0 },
    usage: [{ roleId: "builder", model: "claude-sonnet-5-5", accountSlot: "claude:max-2", turns: 2, inputTokens: 10, outputTokens: 20 }],
    followUps: [],
    notDone: [],
    links: { job: "/coding/674f43aa-1b2c-4d3e-8f90-a1b2c3d4e5f6", work: "/coding?repo=agenticos", memory: null },
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  }) as Handoff;

const screened = (objective: string, over: Partial<Handoff> = {}) => {
  const h = handoff(objective, over);
  return screenFact(handoffFact(h, "674f43"), handoffFactTitle(objective));
};

describe("a normal coding handoff is saved", () => {
  const SUBJECTS = ["the password", "the api key", "the access token", "the refresh token", "the credentials", "the passcode", "the licence key", "the token", "the secret", "the pin", "the encryption key"];
  const HANDLING = [
    "is stored hashed", "is hashed with argon2", "is never logged", "is checked on every request", "is validated before use", "is read from the environment",
    "is passed to the worker", "is masked in the logs", "is refreshed when it expires", "is compared in constant time", "is leaked in the error message",
    "is committed by mistake", "is used by the companion", "is ignored by the screen", "is accepted by the guard", "was refused by the memory screen", "is too short",
  ];
  test("requests that describe how a credential is handled (the false-positive class: 220 of 435 before the fix)", () => {
    const refused: string[] = [];
    for (const s of SUBJECTS) for (const p of HANDLING) if (!screened(`Make sure ${s} ${p}`).ok) refused.push(`${s} ${p}`);
    expect(refused).toEqual([]);
  });

  test("paths, commit hashes, branch names, model names, account slots, test counts and the words token and key", () => {
    for (const objective of [
      "Fix the token refresh in src/lib/auth.ts and add a key per model to the usage receipt",
      "Revert commit 748d9901b3c2e5f6a7b8c9d0e1f2a3b4c5d6e7f8 and rerun bun test in scripts/coding",
      "Review the account fallback for claude:max-2 without replaying a turn",
      "Handoff for job 674f43aa-1b2c-4d3e-8f90-a1b2c3d4e5f6: add the wake word code to scripts/voice",
      "Implement the keyboard shortcut code and the pin icon on the Work page",
    ])
      expect(screened(objective).ok, objective).toBe(true);
    expect(screened("Fix a bug", { jobBranch: "coding/in-scripts-coding-orchestrator-ts-add-the-handoff-fact-674f43aa", headSha: null, tests: [], review: null, usage: [] }).ok).toBe(true);
  });
});

describe("real credentials are still refused", () => {
  const FAKE = "Zq7781-Fake-Pw-xyz";
  test("a value after the label, after a colon, or in a classic secret shape", () => {
    for (const objective of [
      `Set the Xero password is now ${FAKE} in the config`,
      `Use the api key is ${FAKE} for the worker`,
      `The wifi password is sunflowerfield`,
      `The password is hashed: ${FAKE}`,
      `Rotate the access token to ${FAKE.toLowerCase()}`,
      `Config uses sk-ant-api03-${"A1b2C3d4E5f6".repeat(3)} for the review step`,
      `-----BEGIN RSA PRIVATE KEY----- synthetic`,
      `Login: admin / ${FAKE}`,
    ]) {
      const r = screened(objective);
      expect(r.ok, objective).toBe(false);
      if (!r.ok) expect(r.code).toBe("prohibited-content");
    }
  });

  test("a bare fake password sentence is refused directly, as before", () => {
    for (const text of ["the password is sunflower", "my wifi password is Summer2026!", "the api key is abc12345XYZ-fake", "remember that the passcode is 482913"])
      expect(screenFact(text).ok, text).toBe(false);
  });
});

describe("the neutral handoff (used when the screen still refuses the full one)", () => {
  test("carries every structured fact and none of the request's words", () => {
    const secret = "Zq7781-Fake-Pw-xyz";
    const h = handoff(`Set the Xero password is now ${secret}`, { jobBranch: "coding/set-the-xero-password-is-now-zq7781-674f43" });
    for (const _unused of [0]) {
      const n = handoffFactNeutral(h, "674f43");
      expect(n.text).toContain("Coding job 674f43 on agenticos: failed.");
      expect(n.text).toContain("bun-test 12 passed/1 failed");
      expect(n.text).toContain("builder claude-sonnet-5-5 on claude:max-2");
      expect(n.text).toContain("/coding/674f43aa-1b2c-4d3e-8f90-a1b2c3d4e5f6");
      expect(n.text).not.toContain(secret);
      expect(n.text).not.toContain("Xero");
      expect(n.title.length).toBeLessThanOrEqual(90);
      expect(screenFact(n.text, n.title).ok).toBe(true);
    }
    expect(handoffFactNeutral(h, "674f43").text).not.toContain("coding/set-the-xero");
  });
});
