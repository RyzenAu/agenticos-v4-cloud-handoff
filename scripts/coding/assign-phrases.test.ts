// "Assign a builder to fix X and a reviewer to check it": the phrase is recognised as build+review by the ONE
// detector (typed registry and spoken rules), its objective is the task and not the team words, and non-coding
// or money words never become a coding job. Synthetic only.
import { afterAll, describe, expect, test } from "bun:test";
import { buildCommandIndex, resolveCommand } from "../../src/lib/commands/registry";
import { isCodingRequest } from "../../src/lib/commands/coding";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry, VerifiedPrincipal } from "./contracts";
import { createShaper, objectiveFrom, templateFrom } from "./shaper";
import { isCodingStart } from "./voice";
import { cleanup, fixtureRepo } from "./test-fixtures";

const ASSIGN: [string, string][] = [
  ["assign a builder to fix the login bug in src/a.ts and a reviewer to check it", "fix the login bug in src/a.ts"],
  ["Jarvis, assign a builder to fix the login bug in the dental site and reviewer to check it", "fix the login bug in the dental site"],
  ["assign Codex to fix the login bug in src/a.ts and Opus to review it", "fix the login bug in src/a.ts"],
  ["have a builder fix the login bug in src/a.ts and a reviewer check it", "fix the login bug in src/a.ts"],
  ["get a builder to fix the flaky test in AgenticOS and a second agent to check it", "fix the flaky test in AgenticOS"],
  ["Jarvis, have a builder fix the calls table in the receptionist app. Then a reviewer checks it.", "fix the calls table in the receptionist app"],
  ["assign a builder and a reviewer to fix the footer on the marketing site", "fix the footer on the marketing site"],
];
const NOT_CODE = [
  "assign a builder to book a dentist appointment and a reviewer to check it",
  "assign a builder to fix my calendar and a reviewer to check it",
  "assign a reviewer to review my email",
  "assign a builder to send the invoice to Sam",
  "have a builder remind me to call Mehroz at 3",
  "who is the reviewer for the dental site",
];
const MONEY = [
  "assign a builder to pay the invoice and a reviewer to check it",
  "assign a builder to fix the login bug and transfer $500 to Sam",
];

describe("the assign phrase is a build+review coding request, typed and spoken", () => {
  const index = buildCommandIndex({});
  test.each(ASSIGN)("%p", (text, objective) => {
    expect(isCodingRequest(text)).toBe(true);
    expect(isCodingStart(text)).toBe(true);
    expect(templateFrom(text)).toBe("build+review");
    expect(objectiveFrom(text)).toBe(objective);
    // The command registry (typed AND voice) hands it to the coding draft, never to another entry.
    for (const channel of ["typed", "voice"] as const) {
      const r = resolveCommand(text, index, { channel });
      expect(r.status).toBe("resolved");
      if (r.status === "resolved") expect(r.entry.id).toBe("coding:request");
    }
  });
  test.each([
    ["assign a builder to fix the login bug in src/a.ts, no reviewer", "build-only"],
    ["have a builder fix the login bug in src/a.ts without a reviewer", "build-only"],
    ["assign a builder to fix the login bug in src/a.ts and add a tester", "build+review+test-author"],
    ["just review the branch for the login fix", "review-only"],
  ])("template for %p is %p", (text, template) => {
    expect(templateFrom(text)).toBe(template as never);
  });
  test.each(NOT_CODE)("non-coding words stay out: %p", (text) => {
    expect(isCodingRequest(text)).toBe(false);
    const r = resolveCommand(text, index, { channel: "typed" });
    if (r.status === "resolved") expect(r.entry.id).not.toBe("coding:request");
  });
  test("an objective that merely contains a role word is left alone", () => {
    expect(objectiveFrom("Fix the reviewer check button in the calls page so it stays visible")).toBe("Fix the reviewer check button in the calls page so it stays visible");
    expect(objectiveFrom("The reviewer badge is wrong on the calls page in the dental site")).toBe("The reviewer badge is wrong on the calls page in the dental site");
  });
});

describe("money words stay refused, through every lane", () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) cleanup(r); });
  const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
  test("money orders that aren't code changes never reach the coding detector", () => {
    for (const text of ["assign a builder to pay the invoice and a reviewer to check it", "assign a builder to buy 10 Tesla shares"]) expect(isCodingRequest(text)).toBe(false);
  });
  test.each(MONEY)("%p never becomes a coding job", async (text) => {
    const fx = fixtureRepo();
    roots.push(fx.root);
    const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app" }] };
    const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
    const r = await shaper.shape({ utterance: text, channel: "typed", principal, usePlanner: false });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("never pays");
  });
});
