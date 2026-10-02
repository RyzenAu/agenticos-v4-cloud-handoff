import { describe, expect, test } from "bun:test";
import { assignSteps, computerSummary, jobFiles, jobResultText, verificationText, type ComputerJobView } from "../src/lib/agent-workspace";
import { accountWords, codingSummary, latestAgentLine } from "../src/components/coding/job-workspace";

const base = {
  name: "w-desk", id: "d1", label: "Research computer", kind: "cloud-computer", owner: "shared", adapter: "wsl", state: "online", desired: "running", desktop: true, browser: true, capabilities: ["browser.navigate", "file.write"],
  assigned: null, controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null }, takeoverPending: null, paused: null, lastJob: null, resource: null, lastSeen: null, failure: null, recoveries: 0, createdBy: "usman", createdAt: 0, viewer: { snapshot: true, vnc: true },
} as never;
const c = (o: object) => ({ ...(base as object), ...o }) as never;

describe("computer workspace summary", () => {
  test("idle, busy with a job, held by you, paused, failed, offline", () => {
    expect(computerSummary(base, "usman").headline).toBe("Research computer — ready for work");
    const busy = c({ state: "busy", controller: { kind: "agent", who: "assistant", jobId: "j", expiresAt: 1, epoch: 1 }, assigned: { agent: "assistant", jobId: "j", by: "usman", title: "Checking three businesses" } });
    expect(computerSummary(busy, "usman").headline).toBe("Research computer — checking three businesses");
    const mine = c({ state: "busy", controller: { kind: "person", who: "usman", jobId: null, expiresAt: 1, epoch: 2 }, paused: { jobId: "j", agent: "assistant" } });
    const s = computerSummary(mine, "usman");
    expect(s.waiting).toContain("Waiting for you — return the controls");
    expect(computerSummary(mine, "mehroz", (i) => i).waiting).toBeNull();
    const failed = computerSummary(c({ state: "failed", failure: { at: 1, reason: "browser died" } }), "usman");
    expect(failed.tone).toBe("danger");
    expect(failed.waiting).toContain("browser died");
    expect(computerSummary(c({ state: "offline" }), "usman")).toMatchObject({ headline: "Research computer — offline", waiting: null });
  });
});

describe("computer job words", () => {
  const job: ComputerJobView = { id: "j", state: "succeeded", note: null, title: "t", computer: "w-desk", agent: "assistant", paused: false, steps: [
    { seq: 1, executor: "companion", action: null, outcome: "ok", ms: 5, intent: "step 1 browser.navigate: Opened example.com", verification: { method: "title", ok: true, evidence: "title matched" } },
    { seq: 2, executor: "companion", action: null, outcome: "ok", ms: 5, intent: "step 2 file.write: Wrote note.txt (9 bytes)", verification: null },
  ] };
  test("result, files and checks are only what steps said", () => {
    expect(jobResultText(job)).toContain("2 of 2 steps ran, 1 checked");
    expect(jobFiles(job)).toEqual([{ seq: 2, text: "Wrote note.txt (9 bytes)", outcome: "ok" }]);
    expect(jobFiles(null)).toEqual([]);
    expect(verificationText(job.steps[0]!.verification)).toBe("checked: title matched");
    expect(verificationText(null)).toBeNull();
    expect(jobResultText(null)).toContain("No job has run");
  });
});

describe("assign steps", () => {
  test("needs a task, a real address, and a browser for a page", () => {
    expect(assignSteps({ title: " ", url: "", agent: "a" }, null).ok).toBe(false);
    expect(assignSteps({ title: "x", url: "javascript:alert(1)", agent: "a" }, null).ok).toBe(false);
    expect(assignSteps({ title: "x", url: "https://example.com", agent: "a" }, ["file.write"]).ok).toBe(false);
    const ok = assignSteps({ title: "Check it", url: "https://example.com", agent: "a" }, ["browser.navigate", "file.write"]);
    expect(ok.ok && ok.steps.map((s) => s.executor)).toEqual(["browser.navigate", "file.write"]);
  });
});

describe("coding workspace summary", () => {
  test("account words and headline", () => {
    expect(accountWords("claude:max-2")).toBe("Claude Max 2");
    expect(accountWords("claude:max")).toBe("Claude Max");
    expect(accountWords(null)).toContain("isn't reported");
    const job = { state: "building", runs: [{ roleId: "builder-1", state: "running", binding: { accountSlot: "claude:max-2", model: "claude-sonnet-5-5" } }] } as never;
    expect(codingSummary(job).headline).toBe("Coding agent — building on Claude Max 2");
    const wait = codingSummary({ state: "awaiting_approval", runs: [] } as never);
    expect(wait.waiting).toContain("Waiting for you");
  });
  test("the latest line is the agent's own summary, else Jarvis, else null", () => {
    expect(latestAgentLine([])).toBeNull();
    expect(latestAgentLine([{ type: "spoken", payload: { line: "Started." } }, { type: "text", roleId: "builder-1", payload: { final: true, text: "Done: fixed." } }] as never)).toEqual({ who: "builder-1", text: "Done: fixed." });
    expect(latestAgentLine([{ type: "spoken", payload: { line: "Started." } }] as never)).toEqual({ who: "Jarvis", text: "Started." });
  });
});
