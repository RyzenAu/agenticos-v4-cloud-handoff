/**
 * Round 3 fixer (1 Oct 2026), review findings 1-3. Synthetic values only.
 * 1. Handling words ("only", "always", "never", "read", "exposed", "passed") must not silence a value after them.
 * 2. A lower-case path-like token is exempt only after a handling or location word, never straight after a label.
 * 3. The refused-handoff fallback carries nothing derived from the request (the branch slug included).
 */
import { describe, expect, test } from "bun:test";
import type { Handoff } from "../coding/contracts";
import { handoffFactNeutral } from "../coding/orchestrator";
import { slugOf } from "../coding/spec";
import { jobBranchName } from "../coding/worktree";
import { screenFact } from "./guard";

const refused = (t: string) => screenFact(t).ok === false;

describe("finding 1: a value after filler or handling words is still refused", () => {
  const SECRETS = [
    "the password is only hunter2",
    "the password is always Xk9#mP2vL",
    "my password is never sunflower",
    "the password is read hunter2",
    "password was exposed sunflower99",
    "the passcode is passed 4821",
    "pw is only hunter2",
    "the password is only correct/horse",
    "password is based horse-battery-staple",
    "the api key is only sk-live-4f8a9b2c1d3e5f60718293a4b5c6d7e8",
    "the token is used ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "the password is hashed: Xk9#mP2vL",
    "the key is shown sunflowerfield",
  ];
  test.each(SECRETS)("refused: %s", (t) => expect(refused(t)).toBe(true));

  const HANDOFF = [
    "the password is stored hashed",
    "the api key is never logged",
    "the password is hashed with bcrypt",
    "the token is validated before use",
    "the password is never logged in plain text",
    "the secret is only used by the worker",
    "the api key is never rotated manually",
    "the password is validated against the hash",
    "the token is read from the environment",
  ];
  test.each(HANDOFF)("saved: %s", (t) => expect(refused(t)).toBe(false));
});

describe("finding 2: path-like tokens", () => {
  test.each(["token: scripts/voice", "the password is read from correct/horse", "token: correct/horse", "password is lib/horse", "the key is never a/b"])("refused: %s", (t) =>
    expect(refused(t)).toBe(true));
  test.each([
    "the token is used by scripts/jarvis-command/service.ts",
    "the password is read from scripts/voice",
    "the password is stored in src/lib/auth2.ts",
    "the token is read from config.json",
  ])("saved: %s", (t) => expect(refused(t)).toBe(false));
});

describe("finding 3: the neutral handoff carries no request-derived text", () => {
  const h = (objective: string): Handoff =>
    ({
      id: "00000000-0000-4000-8000-000000000000",
      jobId: "ab12cd00-1b2c-4d3e-8f90-a1b2c3d4e5f6",
      repoId: "agenticos",
      baseSha: "a".repeat(40),
      jobBranch: jobBranchName(slugOf(objective), "ab12cd"),
      headSha: "0123456789abcdef0123456789abcdef01234567",
      outcome: "completed",
      objective,
      changedFiles: [],
      tests: [],
      review: null,
      usage: [],
      followUps: [],
      notDone: [],
      links: { job: "/coding/ab12cd00-1b2c-4d3e-8f90-a1b2c3d4e5f6", work: "/coding?repo=agenticos", memory: null },
      createdAt: "2026-10-01T00:00:00.000Z",
    }) as Handoff;
  test.each([
    "Password is sunflowerfield fix login",
    "the api key is zzqpwxkvbnmt, rotate",
    "wifi pw sunflower fix router page",
    "password: hunter2 fix the page",
    "bearer token abcdefghijklmnopqrstuvwxyz fix",
  ])("no word of the request survives: %s", (obj) => {
    const n = handoffFactNeutral(h(obj), "ab12cd");
    const words = obj.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !["fix", "page", "login", "rotate", "router", "token"].includes(w));
    for (const w of words) expect(n.text.toLowerCase()).not.toContain(w);
    expect(n.text).not.toContain("Branch");
    expect(n.text).toContain("ab12cd");
    expect(screenFact(n.text, n.title).ok).toBe(true);
  });
});
