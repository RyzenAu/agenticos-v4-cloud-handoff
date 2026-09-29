import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { inputs, call, NOW } from "./aggregate.test";
import { buildReceptionistSnapshot as build } from "./aggregate";
import { fetchRetell } from "./retell";
import { callFlags } from "./flags";
import { createSummaries } from "./summaries";
import { createReceptionistService, receptionistMiddleware } from "./plugin";
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "receptionist-round2-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const changed = () => { const i = inputs(); if (i.agent.ok) i.agent.modified = new Date(NOW - 30_000).toISOString(); return i; };
test("R2 #1 draft and low balance still answer", () => {
  const i = inputs(); if (i.agent.ok) Object.assign(i.agent, { published: false, version: 0 });
  if (i.twilio.ok) i.twilio.balanceUsd = 1;
  const s = build(i, NOW);
  expect(s.health[0]).toMatchObject({ tone: "warn", detail: "Draft v0 · not published", next: "Publish a version before selling" });
  expect(s.verdict.facts[0]).toBe("Answering on unpublished draft v0");
});
test("R2 #2 latest agent or LLM edit defines changedAt and versions", async () => {
  for (const [a, l] of [[NOW, NOW + 1000], [NOW + 2000, NOW]]) {
    const r = await fetchRetell({ agentId: "fixture", number: "fixture", providerKey: () => "synthetic", flagCache: new Map(), fetch: (async (url: any) => {
      const u = String(url);
      return new Response(JSON.stringify(u.includes("get-agent") ? { version: 0, last_modification_timestamp: a, response_engine: { llm_id: "fixture" } } : u.includes("get-retell-llm") ? { version: 3, last_modification_timestamp: l, general_prompt: "AI recording privacy" } : []));
    }) as typeof fetch });
    expect(r.agent).toMatchObject({ modified: new Date(Math.max(a, l)).toISOString(), version: 0, llmVersion: 3, overseas: false });
  }
});
test("R2 #3 gates separate old flags, untested prompts, failures and signoffs", () => {
  const i = changed(); i.calls = { ok: true, rows: [call({ flags: ["FALSE_BOOKING"] })] };
  let s = build(i, NOW);
  expect(s.readiness.blockers[0]).toMatchObject({ state: "not-tested", stateNote: "1 flagged call, before the 26 Sep prompt change" });
  expect(s.readiness.cleanStreak.count).toBe(0);
  i.calls.rows.push(call({ id: "call_recent1", startedAt: new Date(NOW).toISOString(), flags: ["URGENT_NO_000"] }));
  i.signoffs["urgent-wording"] = { done: true, by: "Usman", at: new Date(NOW).toISOString() };
  s = build(i, NOW);
  expect(s.readiness.blockers[1].state).toBe("fail");
  expect(s.readiness.open).toBe(5);
  i.signoffs["hours-handoff"] = { done: true, by: "Usman", at: new Date(NOW).toISOString() };
  // UI-truth H5: "Transfer tool on agent: no" contradicts the sign-off, so it can't pass...
  expect(build(i, NOW).readiness.blockers[3]).toMatchObject({ state: "evidence-missing", done: false, evidencePresent: false });
  // ...and with the transfer tool on the agent the same sign-off passes.
  if (i.agent.ok) i.agent.transfer = true;
  expect(build(i, NOW).readiness.blockers[3]).toMatchObject({ state: "pass", stateNote: "Signed off by Usman" });
});
test("R2 #4 compliance next follows actual disclosure gaps", () => {
  const i = inputs(); if (i.agent.ok) Object.assign(i.agent, { recording: true, overseas: true });
  expect(build(i, NOW).readiness.blockers[2].next).toBe("Hear the disclosure and consent on a real call, then sign off");
  if (i.agent.ok) i.agent.overseas = false;
  expect(build(i, NOW).readiness.blockers[2].next).toContain("overseas");
});
test("R2 #5 local negation and medication deferral", () => {
  const flags = (content: string) => callFlags([{ role: "agent", content: "I am an AI assistant." }, { role: "agent", content }]);
  expect(flags("Don't worry, you're all booked in for Monday")).toEqual(["FALSE_BOOKING"]);
  expect(flags("No worries, you'll get a confirmation text shortly")).toEqual(["SMS_PROMISE"]);
  for (const t of ["I can't confirm a booking today", "I'm unable to send you a text", "I can't give medical advice about antibiotics", "the dentist can talk to you about antibiotics"]) expect(flags(t)).toEqual([]);
  expect(flags("The dentist can talk to you about antibiotics. Take paracetamol now.")).toContain("CLINICAL_ADVICE");
});
test("R2 #6 names redacted on write and cache read; fallback ends at word boundary", async () => {
  const root = temp(); const summary = createSummaries(root, { enabled: false });
  const text = "Existing patient named Alice Smith called Robert Jones saw Dr Green and patient Sarah White at a clinic.";
  const r = await summary("call_names1", text);
  expect(r?.line).toBe("Existing patient named [name] called [name] saw Dr [name] and patient [name] at a clinic.");
  const long = await summary("call_long01", "A caller " + "requested ".repeat(30));
  expect(long!.line.length).toBeLessThanOrEqual(110); expect(long!.line).toMatch(/requested…$/);
  writeFileSync(join(root, ".operator-data/receptionist-summaries.json"), JSON.stringify({ old: { line: "Mrs Alice Smith called Tom Brown", source: "mimo" } }));
  expect((await createSummaries(root, { enabled: false })("old", "anything"))?.line).toBe("Mrs [name] called [name]");
  expect(readFileSync(join(root, ".operator-data/receptionist-summaries.json"), "utf8")).not.toContain("transcript");
});
test("R2 #7 verdict prioritizes caller consequence and limits Jarvis sentence", () => {
  const s = build(inputs([call({ flags: ["FALSE_BOOKING", "SMS_PROMISE"] })]), NOW);
  expect(s.verdict).toMatchObject({ decision: "Not safe to sell", tone: "bad", next: "Follow up the flagged 26 Sep call" });
  expect(s.verdict.facts).toContain("1 real call today · 1 flagged");
  expect(s.verdict.facts).toContain("1 caller may be expecting a booking or text");
  expect(s.sentence).toBe(s.verdict.decision + " · " + s.verdict.facts.slice(0, 2).join(" · ") + " — next: " + s.verdict.next[0].toLowerCase() + s.verdict.next.slice(1) + ".");
  expect(s.sentence.length).toBeLessThanOrEqual(160);
  const i = inputs(); i.agent = { ok: false, reason: "Retell unreachable" };
  expect(build(i, NOW).verdict).toMatchObject({ decision: "Status unknown", tone: "neutral" });
});
async function post(service: ReturnType<typeof createReceptionistService>, route: string, body: unknown, token = "fixture") {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: route, headers: { host: "127.0.0.1:8081", "x-claude-os-token": token }, socket: { remoteAddress: "127.0.0.1" } });
  const result = new Promise<{ status: number; body: any }>(resolve => { const res = { statusCode: 0, setHeader() {}, end(s: string) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } }; receptionistMiddleware(service, "fixture")(req as any, res as any, () => resolve({ status: 404, body: {} })); });
  req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); return result;
}
test("R2 #8 incidents persist followups atomically alongside signoffs with token validation", async () => {
  const root = temp(); const i = inputs([call({ id: "call_fixture1", flags: ["FALSE_BOOKING", "SMS_PROMISE", "URGENT_NO_000", "CLINICAL_ADVICE"] }), call({ id: "call_old000", startedAt: new Date(NOW - 15 * 86400000).toISOString(), flags: ["SMS_PROMISE"] }), call({ kind: "web", flags: ["SMS_PROMISE"] })]);
  const service = createReceptionistService({ root, token: "fixture", providerKey: () => "" }, { load: async () => structuredClone(i), now: () => NOW });
  const before = await service.get(); expect(before.incidents).toHaveLength(1);
  expect(before.incidents[0].consequence).toBe("Caller may expect a booking that wasn't made, may expect a text that won't come, raised an urgent symptom and wasn't given 000 advice and may have heard medication advice.");
  expect((await post(service, "/incident", { callId: "call_fixture1", by: "Usman" }, "")).status).toBe(403);
  expect((await post(service, "/incident", { callId: "../bad", by: "Usman" })).status).toBe(400);
  expect((await post(service, "/readiness", { id: "urgent-wording", by: "Usman", done: true })).body).toEqual({ error: "Can't sign off: a real call since the last prompt change was flagged" });
  await service.saveReadiness({ id: "hours-handoff", done: true }, "Usman");
  const result = await post(service, "/incident", { callId: "call_fixture1", by: "Usman", note: "Called back" });
  expect(result.status).toBe(200); expect(result.body.incidents).toEqual([]);
  const saved = JSON.parse(readFileSync(join(root, ".operator-data/receptionist-readiness.json"), "utf8"));
  expect(saved.followedUp.call_fixture1.by).toBe("Usman"); expect(saved["hours-handoff"].done).toBe(true);
  const restarted = createReceptionistService({ root, token: "fixture", providerKey: () => "" }, { load: async () => structuredClone(i), now: () => NOW });
  expect((await restarted.get()).incidents).toEqual([]);
});
test("R2 #9 webhook detail explains missing records QA and alerts", () => {
  expect(build(inputs(), NOW).health.find(h => h.id === "webhook")?.detail).toBe("Calls aren't reaching MU-Receptionist: no call records, QA or handoff alerts");
});
test("R2 #10 singular cost evidence and economics", () => {
  const s = build(inputs([call({ durationSec: 180, usdCents: 40 })]), NOW);
  expect(s.readiness.blockers[4].evidence[0]).toBe("Retell A$0.20/min measured on 1 call (3 min)");
  expect(s.commercial.economics.caveat).toContain("from 1 call /");
});
test("R2 #11 leads preserve zero buckets without invented data", () => {
  const i = inputs(); i.leads = { ok: true, total: 1, byStage: [{ stage: "won", label: "Won", count: 1 }, { stage: "closed", label: "Closed", count: 0 }] };
  expect(build(i, NOW).commercial.leads).toEqual(i.leads);
});
test("R3 sign-off is refused on an untested gate (no real call since the prompt change)", async () => {
  const root = temp(); const i = changed();
  const service = createReceptionistService({ root, token: "fixture", providerKey: () => "" }, { load: async () => structuredClone(i), now: () => NOW });
  expect((await service.get()).readiness.blockers[1].state).toBe("not-tested");
  const r = await post(service, "/readiness", { id: "urgent-wording", by: "Usman", done: true });
  expect(r).toEqual({ status: 400, body: { error: "Can't sign off: no real call since the last prompt change" } });
});
