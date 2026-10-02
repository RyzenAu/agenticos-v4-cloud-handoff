import { describe, expect, test } from "bun:test";
import type { CodingEvent } from "./contracts";
import { commitRefusalNote } from "./postcheck";

const policy = (seq: number, at: string, target: string, decision: "auto-allow" | "auto-deny" | "escalate", rule = "runtime-path", roleId = "builder-1") =>
  ({ jobId: "j", seq, at, type: "policy", roleId, payload: { requestId: `r${seq}`, roleId, nativeKind: "Bash", decision, rule, target } }) as unknown as CodingEvent;

describe("commitRefusalNote", () => {
  const since = Date.parse("2026-10-01T10:00:00Z");
  test("names refused git commits in this turn, with the rule and no command text", () => {
    const note = commitRefusalNote([
      policy(1, "2026-10-01T10:01:00Z", 'git commit -q -m "secret wording"', "auto-deny"),
      policy(2, "2026-10-01T10:02:00Z", 'cd "C:/wt" && git add -- a.md', "auto-deny"),
      policy(3, "2026-10-01T10:03:00Z", "git add -- a.md", "auto-allow", "git-local-safe"),
    ], "builder-1", since);
    expect(note).toContain("refused by the coding policy 2 times");
    expect(note).toContain("runtime-path");
    expect(note).not.toContain("secret wording");
  });
  test("ignores allowed commands, other roles, older turns and non-git refusals", () => {
    expect(commitRefusalNote([
      policy(1, "2026-10-01T10:01:00Z", "git commit -m x", "auto-allow", "git-local-safe"),
      policy(2, "2026-10-01T10:01:00Z", "git commit -m x", "auto-deny", "runtime-path", "reviewer-1"),
      policy(3, "2026-10-01T09:00:00Z", "git commit -m x", "auto-deny"),
      policy(4, "2026-10-01T10:01:00Z", "bun test", "auto-deny"),
    ], "builder-1", since)).toBeNull();
  });
});
