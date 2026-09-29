import { describe, expect, test } from "bun:test";
import { buildDraft } from "./build";
import type { Evidence } from "./evidence";
import type { ImageryResult } from "./imagery";

function evidence(): Evidence {
  return {
    leadId: 1,
    name: "St Clair Dental",
    vertical: "dental",
    area: "Mount Druitt NSW",
    generatedAt: new Date().toISOString(),
    facts: [],
    services: [],
    hasOwnWebsite: false,
    ownSiteReachable: false,
    robotsBlocked: false,
    complianceNotes: ["AHPRA advertising rules apply."],
  };
}

const imagery: ImageryResult = { engine: "css-svg-fallback", available: false, reason: "", assets: [], totalCredits: 0 };

describe("buildDraft", () => {
  test("never passes --bare, and scopes tools to file edits only", async () => {
    let seenArgs: string[] = [];
    const run = async (args: string[]) => {
      seenArgs = args;
      return JSON.stringify({ is_error: false, result: "ok", usage: { input_tokens: 10, output_tokens: 10 } });
    };
    const result = await buildDraft("/tmp/some-draft-dir", evidence(), "# direction", imagery, { run });
    expect(result.ok).toBe(true);
    expect(seenArgs).not.toContain("--bare");
    expect(seenArgs).not.toContain("--dangerously-skip-permissions");
    expect(seenArgs.join(" ")).toMatch(/--allowedTools Write Edit Read Glob Grep/);
    expect(seenArgs.join(" ")).toMatch(/--permission-mode acceptEdits/);
    expect(seenArgs.join(" ")).toMatch(/--permission-prompts none/);
  });

  test("includes evidence and direction in the prompt sent over stdin", async () => {
    let seenStdin = "";
    const run = async (_args: string[], stdin: string) => {
      seenStdin = stdin;
      return JSON.stringify({ is_error: false, result: "ok" });
    };
    await buildDraft("/tmp/some-draft-dir", evidence(), "# direction brief", imagery, { run });
    expect(seenStdin).toMatch("St Clair Dental");
    expect(seenStdin).toMatch("direction brief");
    expect(seenStdin).toMatch("AHPRA advertising rules apply");
  });

  test("reports failure cleanly when Claude Code errors", async () => {
    const run = async () => JSON.stringify({ is_error: true, result: "denied" });
    const result = await buildDraft("/tmp/some-draft-dir", evidence(), "# direction", imagery, { run });
    expect(result.ok).toBe(false);
  });

  test("reports failure cleanly on a timeout-style rejection", async () => {
    const run = async () => {
      throw new Error("Claude Code build exceeded the 1s time cap.");
    };
    const result = await buildDraft("/tmp/some-draft-dir", evidence(), "# direction", imagery, { run, timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/time cap/);
  });
});
