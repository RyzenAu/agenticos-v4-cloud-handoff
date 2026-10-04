// voice-intents is bundled into the browser (the command bar), so it must not reach the approval
// service (node:crypto, bun:sqlite): that broke `bun run build` after the live merge (review T8).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalTarget } from "./approval-target";
import { approvalTarget as reExported } from "./approvals";

describe("approvalTarget lives in a browser-safe module", () => {
  test("voice-intents imports the pure parser, not ./approvals", () => {
    const src = readFileSync(join(import.meta.dir, "voice-intents.ts"), "utf8");
    expect(src).not.toMatch(/from "\.\/approvals"/);
    expect(src).toContain('from "./approval-target"');
    const pure = readFileSync(join(import.meta.dir, "approval-target.ts"), "utf8");
    expect(pure).not.toMatch(/^import /m);
  });
  test("parses the same targets, and ./approvals still exports it", () => {
    expect(reExported).toBe(approvalTarget);
    expect(approvalTarget("full:n-abc#h-1")).toEqual({ kind: "full", target: "n-abc", headingKey: "h-1" });
    expect(approvalTarget("memory:mem-x")).toEqual({ kind: "memory", target: "mem-x" });
    expect(approvalTarget("vanished:12")).toEqual({ kind: "vanished", target: "12" });
    expect(approvalTarget("nocolon")).toBeNull();
  });
});
