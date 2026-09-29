import { expect, test } from "bun:test";
import { actorName, validateActor, validatePatch } from "./readiness";
import { buildReceptionistSnapshot } from "./aggregate";
import { inputs, call, NOW } from "./aggregate.test";
import { ownerRetestLabel, GateRow } from "../../src/components/receptionist/gates";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { callFlags } from "./flags";
import { consequenceOf } from "./aggregate";

test("shared gas/live-wire and negated 000 flags reopen urgent readiness", () => {
  for (const caller of ["I smell gas", "There are live wires", "My partner is threatening me"]) {
    const flags = callFlags([{ role: "user", content: caller }, { role: "agent", content: "I am an AI receptionist. No need to call 000." }]);
    expect(flags).toContain("URGENT_NO_000");
    const i = inputs([call({ flags })]);
    i.signoffs["urgent-wording"] = { done: true, by: "Synthetic reviewer", at: new Date(NOW - 120_000).toISOString() };
    const gate = buildReceptionistSnapshot(i, NOW).readiness.blockers.find(b => b.id === "urgent-wording")!;
    expect(gate.state).toBe("fail"); expect(gate.done).toBe(false); expect(gate.warning).toBeDefined();
    expect(consequenceOf(flags)).toContain("wasn't given 000 advice");
  }
});

test("missing legal human route reaches incidents and fails urgent/handoff signoffs", () => {
  const flags = callFlags([{ role: "user", content: "I have court tomorrow" }, { role: "agent", content: "I am an AI assistant. Goodbye." }], { niche: "LEGAL" });
  expect(flags).toContain("URGENT_NO_HUMAN_ROUTE"); expect(flags).not.toContain("URGENT_NO_000");
  expect(consequenceOf(flags)).toContain("without being offered a human route");
  const i = inputs([call({ flags })]);
  for (const id of ["urgent-wording", "hours-handoff"] as const) i.signoffs[id] = { done: true, by: "Synthetic reviewer", at: new Date(NOW - 120_000).toISOString() };
  const result = buildReceptionistSnapshot(i, NOW);
  for (const id of ["urgent-wording", "hours-handoff"]) expect(result.readiness.blockers.find(b => b.id === id)).toMatchObject({ state: "fail", done: false });
  expect(result.verdict.decision).not.toBe("Safe to sell");
});

test("danger and legal-review flags cannot be hidden by a manual urgency signoff", () => {
  for (const flag of ["DANGER_LANGUAGE", "LEGAL_URGENT", "URGENT_NO_HUMAN_ROUTE"] as const) {
    const i = inputs([call({ flags: [flag] })]);
    i.signoffs["urgent-wording"] = { done: true, by: "Synthetic reviewer", at: new Date(NOW - 120_000).toISOString() };
    expect(buildReceptionistSnapshot(i, NOW).readiness.blockers.find(b => b.id === "urgent-wording")).toMatchObject({ state: "fail", done: false });
  }
});
test("strict manual patches", () => {
  // RX-5 (intended change): the body's `by` is tolerated but IGNORED; the signer is the verified
  // principal, supplied by the server. So an empty or over-long `by` no longer matters either.
  expect(validatePatch({ id: "compliance", done: true, by: " Owner ", note: "checked" })).toEqual({ id: "compliance", done: true, note: "checked" });
  expect(validatePatch({ id: "compliance", done: true, by: "" })).toEqual({ id: "compliance", done: true });
  expect(validatePatch({ id: "compliance", done: false })).toEqual({ id: "compliance", done: false });
  for (const p of [
    { id: "no-false-actions", done: true, by: "Owner" },
    { id: "unknown", done: true, by: "Owner" },
    { id: "compliance", done: 1, by: "Owner" },
    { id: "compliance", done: true, by: "Owner", note: "x".repeat(201) },
    { id: "compliance", done: true, by: "Owner", extra: true },
  ])
    expect(() => validatePatch(p)).toThrow();
  // The stored actor (from the principal) is still validated: trimmed, 1–40 characters.
  expect(validateActor(" Usman ")).toBe("Usman");
  for (const bad of ["", "   ", "x".repeat(41), 5, null]) expect(() => validateActor(bad)).toThrow();
  expect(actorName({ personId: "usman", displayName: "Usman" })).toBe("Usman");
  expect(actorName({ personId: "mehroz", displayName: "" })).toBe("mehroz");
  expect(() => actorName(null)).toThrow();
});
test("a flagged real call since the last prompt change fails a signed-off gate (round 2)", () => {
  const i = inputs([call({ flags: ["URGENT_NO_000"] })]);
  i.signoffs = {
    "urgent-wording": { done: true, by: "Owner", at: new Date(NOW - 120_000).toISOString() },
  };
  const s = buildReceptionistSnapshot(i, NOW);
  expect(s.readiness.blockers[1]).toMatchObject({ state: "fail", done: false });
  expect(s.readiness.blockers[1].warning).toBeDefined();
  expect(s.readiness.open).toBe(5);
  // Once the prompt is changed after that call, the old flag is history: the gate is re-testable.
  if (i.agent.ok) i.agent.modified = new Date(NOW - 30_000).toISOString();
  expect(buildReceptionistSnapshot(i, NOW).readiness.blockers[1].state).toBe("pass");
});

test("incomplete derived call gate is not tested, never awaiting a manual sign-off", () => {
  const s = buildReceptionistSnapshot(inputs([call()]), NOW);
  expect(s.readiness.blockers[0]).toMatchObject({ state: "not-tested", done: false });
  expect(s.readiness.cleanStreak).toEqual({ count: 1, target: 5 });
  expect(s.verdict.decision).toBe("Not safe to sell");
});

test("a prompt that loses signed-off evidence reopens the gate and cannot be sale-ready", () => {
  const i = inputs(Array.from({ length: 5 }, (_, n) => call({ id: String(n), startedAt: new Date(NOW).toISOString() })));
  if (i.agent.ok) Object.assign(i.agent, { modified: new Date(NOW - 30_000).toISOString(), prompt000: false });
  i.signoffs["urgent-wording"] = { done: true, by: "Owner", at: new Date(NOW - 60_000).toISOString() };
  const s = buildReceptionistSnapshot(i, NOW);
  expect(s.readiness.blockers[1]).toMatchObject({ state: "evidence-missing", done: false });
  expect(s.readiness.blockers[1].next).toContain("Restore 000 wording");
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(GateRow, { blocker: s.readiness.blockers[1] })));
  expect(html).toContain("Evidence missing");
  expect(html).toContain("Restore 000 wording");
  expect(html).not.toContain("Awaiting owner sign-off");
  expect(html).toMatch(/<button[^>]*disabled/);
  expect(s.verdict.decision).not.toBe("Safe to sell");
});

test("owner retests stay untracked without attribution, independently of clean calls", () => {
  const data = buildReceptionistSnapshot(inputs(Array.from({ length: 5 }, (_, n) => call({ id: String(n) }))), NOW).readiness;
  expect(data.cleanStreak.count).toBe(5);
  expect(data.ownerRetestCalls).toBeNull();
  expect(ownerRetestLabel(data)).toBe("Owner retest calls: not yet tracked — count from Retell call history");
});

test("owner retests count only explicitly attributed qualifying calls since the prompt change", () => {
  const i = inputs([
    call({ id: "owner", ownerTestBy: "Fixture owner" }),
    call({ id: "owner", ownerTestBy: "Fixture owner" }),
    call({ id: "ordinary" }),
    call({ id: "blank", ownerTestBy: " " }),
    call({ id: "web", kind: "web", ownerTestBy: "Fixture owner" }),
    call({ id: "unchecked", checked: false, ownerTestBy: "Fixture owner" }),
    call({ id: "short", durationSec: 10, ownerTestBy: "Fixture owner" }),
    call({ id: "old", startedAt: new Date(NOW - 180_000).toISOString(), ownerTestBy: "Fixture owner" }),
  ]);
  if (i.agent.ok) i.agent.modified = new Date(NOW - 120_000).toISOString();
  const data = buildReceptionistSnapshot(i, NOW).readiness;
  expect(data.ownerRetestCalls).toEqual({ count: 1, target: 5 });
  expect(ownerRetestLabel(data)).toBe("Owner retest calls: 1 of 5");
});

test("missing compliance and handoff evidence name the corrective step", () => {
  const i = inputs();
  if (i.agent.ok) i.agent.modified = new Date(NOW - 30_000).toISOString();
  for (const id of ["compliance", "hours-handoff"] as const) {
    i.signoffs[id] = { done: true, by: "Fixture owner", at: new Date(NOW - 60_000).toISOString() };
  }
  const blockers = buildReceptionistSnapshot(i, NOW).readiness.blockers;
  expect(blockers[2]).toMatchObject({ state: "evidence-missing", done: false });
  expect(blockers[2].next).toContain("Add NSW recording consent and APP 8 overseas-processing wording");
  expect(blockers[3]).toMatchObject({ state: "evidence-missing", done: false });
  expect(blockers[3].next).toContain("Restore the transfer tool");
});

test("automated eval success cannot pass untested or unsigned gates", () => {
  const i = inputs([]);
  i.evals = { ok: true, passed: 100, total: 100, reports: 1, date: "2026-09-26" };
  const s = buildReceptionistSnapshot(i, NOW);
  expect(s.readiness.cleanStreak.count).toBe(0);
  expect(s.readiness.blockers.every(b => b.state !== "pass")).toBe(true);
  expect(s.verdict.decision).toBe("Not safe to sell");
});
