import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { consumeCodingApply, requestCodingApply, type CodingApplyInput } from "./adapters/coding";
import { awayGate, spokenGate } from "./adapters/gates";
import { createMemoryApprovals, principalFromMemory, type MemoryPrincipal } from "./adapters/memory";
import type { AwayPaymentArgs } from "./policy";
import type { Principal } from "./principal";
import { ApprovalService } from "./service";

let dir: string;
let clock: number;
let ledger: SpokenConfirmationLedger;
let service: ApprovalService;
const reopen = () => {
  service.close();
  service = new ApprovalService({ path: join(dir, "a.sqlite"), now: () => clock, spoken: ledger, code: () => "K7PQ", telegramCode: () => "K7PQ-M4XZ" });
  service.recover();
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b2-adapters-"));
  clock = Date.parse("2026-09-28T03:00:00Z");
  ledger = new SpokenConfirmationLedger(() => clock);
  service = new ApprovalService({ path: join(dir, "a.sqlite"), now: () => clock, spoken: ledger, code: () => "K7PQ", telegramCode: () => "K7PQ-M4XZ" });
});
afterEach(() => {
  service.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* WAL */
  }
});

/** The Memory page in a browser session: a human, making the request in the UI himself. */
// With B1's own principal, as the server resolves it: the session key comes from the cookie, never a body.
const usmanMem: MemoryPrincipal = { id: "usman", name: "Usman", via: "local", actor: "human", os: { personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-0001" } };
const mehrozMem: MemoryPrincipal = { id: "mehroz", name: "Mehroz", via: "tailnet", actor: "human", os: { personId: "mehroz", via: "paired-session", actor: "human", sessionId: "sess-mehroz-0001" } };
/** A program acting for Usman (the coding orchestrator, the away runner, the screen loop). */
const usman: Principal = { personId: "usman", via: "loopback-owner" };
const usmanTg: Principal = { personId: "usman", via: "telegram-owner", actor: "human" };
/** The card the Memory page rendered in a verified browser session. */
const cardFor = (id: string, who: MemoryPrincipal, sessionId: string) => {
  const p = principalFromMemory(who)!;
  return { sessionId, cardNonce: service.card(id, { ...p, sessionId })!.cardNonce };
};

describe("memory forget (kinds b and c) on approvals.request", () => {
  const req = { action: "memory.forget" as const, target: "memory:m-123", digest: "plan-abc", principal: usmanMem, summary: "Forget the Hindsight memory about proposal terms" };

  test("ask → grant on the card (UI session) → approved and consumed once; replay denied; survives a restart; outcome recorded", () => {
    const gate = createMemoryApprovals(service);
    const ask = gate.require(req);
    expect(ask.status).toBe("pending");
    if (ask.status !== "pending") return;
    expect(gate.require(req)).toMatchObject({ status: "pending", approvalId: ask.approvalId });
    expect(gate.require({ ...req, approvalId: ask.approvalId })).toMatchObject({ status: "pending" });
    expect(gate.pending().map((a) => a.id)).toContain(ask.approvalId);
    reopen();
    const gate2 = createMemoryApprovals(service);
    expect(gate2.grant(ask.approvalId, mehrozMem, "ui", cardFor(ask.approvalId, mehrozMem, "sess-mehroz-0001"))).toMatchObject({ ok: true, approval: { granted_by: "mehroz", granted_via: "ui" } });
    reopen();
    const gate3 = createMemoryApprovals(service);
    // Bound to its approver (REVIEW-T6 R2): only Mehroz, who approved it, can use it.
    expect(gate3.require({ ...req, approvalId: ask.approvalId })).toMatchObject({ status: "denied", reason: "not-yours" });
    expect(gate3.require({ ...req, principal: mehrozMem, approvalId: ask.approvalId })).toEqual({ status: "approved", approvalId: ask.approvalId });
    expect(gate3.require({ ...req, principal: mehrozMem, approvalId: ask.approvalId })).toMatchObject({ status: "denied", reason: "consumed" });
    expect(gate3.recordOutcome(ask.approvalId, "succeeded")).toBe(true);
    reopen();
    expect(service.get(ask.approvalId)!.outcome).toBe("succeeded");
  });

  test("a UI grant without a session card, or from a voice caller through 'ui', is refused (review H1, item 7)", () => {
    const gate = createMemoryApprovals(service);
    const ask = gate.require(req);
    if (ask.status !== "pending") throw new Error();
    expect(gate.grant(ask.approvalId, usmanMem, "ui", { sessionId: "sess-usman-0001", cardNonce: "00000000-0000-4000-8000-000000000000" }).ok).toBe(false);
    const voice: MemoryPrincipal = { id: "usman", name: "Usman", via: "voice" };
    expect(gate.grant(ask.approvalId, voice, "ui", cardFor(ask.approvalId, usmanMem, "sess-usman-0001")).ok).toBe(false);
  });

  test("a forged id, a changed plan and automation are all denied", () => {
    const gate = createMemoryApprovals(service);
    expect(gate.require({ ...req, approvalId: "apr-client-says-yes" })).toMatchObject({ status: "denied", reason: "unknown" });
    const ask = gate.require(req);
    if (ask.status !== "pending") throw new Error();
    expect(gate.grant(ask.approvalId, { id: "usman", name: "cron", via: "system" }, "ui", { sessionId: "sess-x-000001", cardNonce: "x" })).toMatchObject({ ok: false });
    gate.grant(ask.approvalId, usmanMem, "ui", cardFor(ask.approvalId, usmanMem, "sess-usman-0001"));
    expect(gate.require({ ...req, digest: "plan-changed", approvalId: ask.approvalId })).toMatchObject({ status: "denied", reason: "mismatch" });
    expect(gate.require({ ...req, action: "memory.bulk-retract", approvalId: ask.approvalId })).toMatchObject({ status: "denied", reason: "mismatch" });
  });

  test("a voice grant needs the spoken yes stamped with the question put to that person", () => {
    const gate = createMemoryApprovals(service);
    const ask = gate.require(req);
    if (ask.status !== "pending") throw new Error();
    const early = ledger.record("yes")!;
    const q = service.ask(ask.approvalId, usman);
    expect(gate.grant(ask.approvalId, usmanMem, "voice", { spokenYes: early.id, questionId: q.questionId })).toMatchObject({ ok: false });
    clock += 1_000;
    const yes = ledger.record("yes")!;
    expect(gate.grant(ask.approvalId, mehrozMem, "voice", { spokenYes: yes.id, questionId: q.questionId })).toMatchObject({ ok: false });
    expect(gate.grant(ask.approvalId, usmanMem, "voice", { spokenYes: yes.id, questionId: q.questionId })).toMatchObject({ ok: true, approval: { granted_via: "voice" } });
  });

  test("expiry after 10 minutes", () => {
    const gate = createMemoryApprovals(service);
    const ask = gate.require(req);
    if (ask.status !== "pending") throw new Error();
    gate.grant(ask.approvalId, usmanMem, "ui", cardFor(ask.approvalId, usmanMem, "sess-usman-0001"));
    clock += 10 * 60_000 + 1;
    expect(gate.require({ ...req, approvalId: ask.approvalId })).toMatchObject({ status: "denied", reason: "expired" });
  });

  test("principal mapping: never a person from an unknown id", () => {
    expect(principalFromMemory({ id: "bob", name: "Bob", via: "local" })).toBeNull();
    expect(principalFromMemory({ id: "usman", name: "x", via: "system" })).toBeNull();
    expect(principalFromMemory({ ...mehrozMem, os: undefined })).toMatchObject({ personId: "mehroz", via: "tailnet-person" });
    expect(principalFromMemory(mehrozMem)).toMatchObject({ personId: "mehroz", via: "paired-session", sessionId: "sess-mehroz-0001" });
  });
});

describe("coding merge placeholder on approvals.request", () => {
  const sha = "9c1e2ab4d5f60718293a4b5c6d7e8f9012345678";
  const input: CodingApplyInput = {
    action: "git.merge.protected", jobId: "8a1f0b6e-2d7c-4a55-9b0e-0e9c2b7d1a33", applyStepId: "s1", repoId: "mu-receptionist", remote: null, branch: "main",
    fromSha: sha.toUpperCase(), toRef: "main", specDigest: "spec-1", requestedBy: usman, approverPersonId: "usman", targetDeviceId: "usman-pc",
    summary: "Merge coding/rx-calls-tz @ 9c1e2ab into main of mu-receptionist; this triggers a production deploy",
  };
  const usmanUi: Principal = { personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-0001" };
  const confirm = (id: string, p: Principal = usmanUi) => service.decide(id, p, "approve", { uiConfirm: true, cardNonce: service.card(id, p)?.cardNonce ?? "x" });

  const tg = (id: string, p: Principal = usmanTg) => service.decide(id, p, "approve", { telegramCode: "K7PQ-M4XZ" });
  test("asked once, bound to the FULL sha; a new commit voids it; single use", () => {
    const a = requestCodingApply(service, input);
    const b = requestCodingApply(service, input);
    expect(a.ok && b.ok && a.ref.approvalId === b.ref.approvalId).toBe(true);
    if (!a.ok) return;
    expect(a.telegramCode).toBe("K7PQ-M4XZ");
    expect(a.ref).toMatchObject({ state: "pending", subject: { kind: "coding.apply", jobId: input.jobId }, approverPersonId: "usman" });
    expect(tg(a.ref.approvalId, { personId: "mehroz", via: "telegram-owner", actor: "human" })).toMatchObject({ ok: false, code: "wrong-approver" });
    expect(tg(a.ref.approvalId).ok).toBe(true);
    expect(service.get(a.ref.approvalId)!.evidence).toBe("telegramCode");
    expect(consumeCodingApply(service, a.ref.approvalId, { ...input, fromSha: "abcdef0123456789abcdef0123456789abcdef01" })).toMatchObject({ ok: false, code: "digest-mismatch" });
    const again = requestCodingApply(service, input);
    if (!again.ok) throw new Error();
    tg(again.ref.approvalId);
    expect(consumeCodingApply(service, again.ref.approvalId, input).ok).toBe(true);
    expect(consumeCodingApply(service, again.ref.approvalId, input)).toMatchObject({ ok: false, code: "consumed" });
  });

  test("a short sha or a non-UUID job id is refused, never silently accepted (review item 6)", () => {
    expect(requestCodingApply(service, { ...input, fromSha: "9c1e2ab" })).toMatchObject({ ok: false });
    expect(requestCodingApply(service, { ...input, jobId: "job-7" })).toMatchObject({ ok: false });
    expect(() => consumeCodingApply(service, "8a1f0b6e-2d7c-4a55-9b0e-0e9c2b7d1a33", { ...input, fromSha: "9c1e2ab" })).toThrow();
  });

  test("a merge a coding job requested can't be approved by any UI confirm, not even a real human session (B1 R2)", () => {
    const r = requestCodingApply(service, input);
    if (!r.ok) throw new Error();
    // Any local program can make the owner's browser look like a human session, so a click isn't proof here.
    expect(confirm(r.ref.approvalId)).toMatchObject({ ok: false, code: "evidence-required" });
    expect(service.card(r.ref.approvalId, usman)).toBeNull();
    // The code from a local process (not the Telegram DM) is refused too.
    expect(service.decide(r.ref.approvalId, usman, "approve", { telegramCode: "K7PQ-M4XZ" })).toMatchObject({ ok: false, code: "wrong-channel" });
    expect(service.decide(r.ref.approvalId, usmanUi, "approve", { telegramCode: "K7PQ-M4XZ" })).toMatchObject({ ok: false, code: "wrong-channel" });
    // A spoken yes to the question Jarvis asks works.
    const q = service.ask(r.ref.approvalId, usman);
    clock += 500;
    const yes = ledger.record("yes")!;
    expect(service.decide(r.ref.approvalId, usman, "approve", { spokenYes: yes.id, questionId: q.questionId }).ok).toBe(true);
  });
});

describe("gate adapters for the post-r3 migration", () => {
  const usmanUi: Principal = { personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-0001" };
  test("spoken gate: ask → spoken yes → admit once with the live args", () => {
    const gate = spokenGate(service, "screen.press");
    const args = { window: "Outlook", button: "Send", automationId: "send" };
    const r = gate.request({ args, requester: usman, summary: "Press Send in Outlook" });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const q = gate.ask(r.approval.id, usman);
    clock += 500;
    const yes = ledger.record("yes")!;
    expect(gate.confirm(r.approval.id, usman, { spokenYes: yes.id, questionId: q.questionId }).ok).toBe(true);
    expect(gate.admit(r.approval.id, { ...args, button: "Delete" }).ok).toBe(false);
    // A press the human asked for in the UI himself may be confirmed on the card; a program's may not.
    const r2 = gate.request({ args, requester: usmanUi, summary: "Press Send in Outlook" });
    if (!r2.ok) throw new Error();
    gate.confirmInUi(r2.approval.id, usmanUi, service.card(r2.approval.id, usmanUi)!.cardNonce);
    expect(gate.admit(r2.approval.id, args).ok).toBe(true);
    expect(gate.admit(r2.approval.id, args).ok).toBe(false);
    const r3 = gate.request({ args: { ...args, button: "Send all" }, requester: usman, summary: "Press Send all" });
    if (!r3.ok) throw new Error();
    expect(gate.confirmInUi(r3.approval.id, usmanUi, service.card(r3.approval.id, usmanUi)?.cardNonce ?? "x").ok).toBe(false);
    expect(r3.telegramCode).toBe("K7PQ-M4XZ");
    expect(gate.confirmByTelegram(r3.approval.id, usmanTg, "K7PQ-M4XZ").ok).toBe(true);
  });

  test("away payment end to end: code on Telegram → re-verified page → one press → receipt", () => {
    const away = awayGate(service);
    const args: AwayPaymentArgs = {
      taskId: "away-7", host: "billing.telstra.com.au", payee: { id: "biller-telstra", name: "Telstra", saved: true },
      amount: { minor: 8900, currency: "AUD" }, element: { label: "Pay now", ref: "cdp:#pay-now" }, category: "bill",
    };
    const r = away.requestPayment({ args, requester: usman, summary: "Pay Telstra A$89.00", origin: "principal" });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.awayCode).toBe("K7PQ");
    const tg: Principal = { personId: "usman", via: "telegram-owner" };
    expect(away.answer(r.approval.id, tg, true, "K7PQ").ok).toBe(true);
    expect(away.beforePress(r.approval.id, "away.payment", args).ok).toBe(true);
    expect(away.beforePress(r.approval.id, "away.payment", args).ok).toBe(false);
    expect(away.afterPress(r.approval.id, "succeeded")).toBe(true);
    const injected = away.requestPayment({ args, requester: usman, summary: "Pay", origin: "observed-content" });
    expect(injected.ok).toBe(false);
  });

  test("the away code on the OS card needs the verified session's card nonce, and only for his own request", () => {
    const away = awayGate(service);
    const mine = away.requestRun({ args: { task: "delete D:/tmp/a.txt" }, requester: usmanUi, summary: "Delete a.txt" });
    if (!mine.ok) throw new Error();
    expect(away.answer(mine.approval.id, usmanUi, true, "K7PQ").ok).toBe(false);
    expect(away.answer(mine.approval.id, usmanUi, true, "K7PQ", service.card(mine.approval.id, usmanUi)!.cardNonce).ok).toBe(true);
    // The away runner (a process) asked: the OS card can't answer, only the Telegram DM.
    const runner = away.requestRun({ args: { task: "delete D:/tmp/b.txt" }, requester: usman, summary: "Delete b.txt" });
    if (!runner.ok) throw new Error();
    expect(away.answer(runner.approval.id, usmanUi, true, "K7PQ", service.card(runner.approval.id, usmanUi)?.cardNonce ?? "x").ok).toBe(false);
    expect(away.answer(runner.approval.id, usmanTg, true, "K7PQ").ok).toBe(true);
  });

  test("away 'no CODE' rejects; another person can't answer", () => {
    const away = awayGate(service);
    const r = away.requestRun({ args: { task: "delete D:/tmp/a.txt" }, requester: usman, summary: "Delete a.txt" });
    if (!r.ok) throw new Error();
    expect(away.answer(r.approval.id, { personId: "mehroz", via: "telegram-owner" }, false, "K7PQ").ok).toBe(false);
    expect(away.answer(r.approval.id, { personId: "usman", via: "telegram-owner" }, false, "K7PQ").ok).toBe(true);
    expect(service.get(r.approval.id)!.state).toBe("rejected");
  });
});
