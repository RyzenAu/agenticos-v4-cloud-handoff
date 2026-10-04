import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDecisions, decisionPath, decisionRevision, readDecisions, saveDecision } from "./decisions";
import { createWorkspace } from "./sources";
import type { Approval } from "./approvals";

const item: Approval = { id: "sample-opening", title: "Choose the opening", detail: "Choose the reviewed opening for the sample page.", href: "/websites", area: "websites", source: "Synthetic review", since: "2026-09-30" };
const now = Date.parse("2026-09-30T01:00:00Z");
function fixture() { const root = mkdtempSync(join(tmpdir(), "decision-synthetic-")); mkdirSync(join(root, "scripts/workspace"), { recursive: true }); writeFileSync(join(root, "scripts/workspace/approvals.json"), JSON.stringify({ version: 1, items: [item] })); return root; }
describe("actionable owner decisions", () => {
  test("save, amend and reopen persist without changing the source list", () => {
    const root = fixture(); const seed = readFileSync(join(root, "scripts/workspace/approvals.json"), "utf8");
    const body = { id: item.id, revision: decisionRevision(item), answer: "approved", note: "Use the second option." };
    saveDecision(root, body, "usman", now);
    expect(readDecisions(decisionPath(root))).toHaveLength(1);
    expect(applyDecisions([item], readDecisions(decisionPath(root)))).toEqual([]);
    saveDecision(root, { ...body, answer: "declined", note: "Revise the opening." }, "mehroz", now + 1);
    expect(readDecisions(decisionPath(root))).toHaveLength(1);
    expect(readDecisions(decisionPath(root))[0]).toMatchObject({ answer: "declined", by: "mehroz" });
    saveDecision(root, { ...body, answer: "reopen" }, "usman", now + 2);
    expect(applyDecisions([item], readDecisions(decisionPath(root)))).toEqual([item]);
    expect(readFileSync(join(root, "scripts/workspace/approvals.json"), "utf8")).toBe(seed);
  });
  test("changed instructions, arbitrary gates and private notes cannot be dismissed", () => {
    const root = fixture(); const body = { id: item.id, revision: decisionRevision(item), answer: "approved" };
    for (const input of [{ ...body, revision: "old" }, { ...body, id: "receptionist-gate-live" }, { ...body, note: "person@example.invalid" }, { ...body, answer: "run" }]) expect(() => saveDecision(root, input, "usman", now)).toThrow();
    expect(readDecisions(decisionPath(root))).toEqual([]);
    saveDecision(root, body, "usman", now);
    expect(applyDecisions([{ ...item, detail: "A different release needs review." }], readDecisions(decisionPath(root)))).toHaveLength(1);
  });
  test("a fresh workspace after restart reads the saved answer and retains live gates", async () => {
    const root = fixture(); saveDecision(root, { id: item.id, revision: decisionRevision(item), answer: "approved" }, "usman", now);
    const workspace = createWorkspace({ approvalsFile: join(root, "scripts/workspace/approvals.json"), decisionsFile: decisionPath(root), now: () => now, get: async () => ({ readiness: { blockers: [{ id: "routing", title: "Call routing", state: "open" }] } }) });
    const result = await workspace.panel("today", { fresh: true });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.data.approvals.map(a => a.id)).toEqual(["receptionist-gate-routing"]); expect(result.data.decisions?.[0].answer).toBe("approved"); }
  });
  test("corrupt local records fail visibly instead of reporting everything clear", async () => {
    const root = fixture(); mkdirSync(join(root, ".operator-data")); writeFileSync(decisionPath(root), "broken");
    const workspace = createWorkspace({ approvalsFile: join(root, "scripts/workspace/approvals.json"), decisionsFile: decisionPath(root), now: () => now, get: async () => ({ readiness: null }) });
    expect((await workspace.panel("today", { fresh: true })).ok).toBe(false);
  });
});
