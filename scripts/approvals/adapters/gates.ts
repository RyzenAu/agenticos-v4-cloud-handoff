// Adapters the screen, control, lesson and away gates migrate onto AFTER safety-r3 merges (the r3
// builder owns those gates now; this file doesn't touch them). Each adapter keeps the gate's existing
// shape (ask → yes → one-shot admission) but makes it durable, digest-bound and consumed once.
// The exact per-gate migration is in docs/APPROVALS-JOBS-MIGRATION.md.
import { argsDigest } from "../canonical";
import type { AwayPaymentArgs } from "../policy";
import type { Approval, ApprovalService, ConsumeResult, DecideResult } from "../service";
import type { Principal } from "../principal";

export type SpokenGateAction = "screen.press" | "control.run" | "lesson.run";

/**
 * Spoken-yes gates (screen final button, control_pc task, lesson). Replaces the in-memory question /
 * grant maps: `request` + `ask` when the read-back question is spoken, `confirm` with the STT event id,
 * `admit` immediately before the press/launch with the args re-derived from the live target.
 */
export function spokenGate(service: ApprovalService, action: SpokenGateAction) {
  return {
    request(input: { args: unknown; requester: Principal; summary: string; jobId?: string; deviceId?: string }) {
      return service.request({ action, args: input.args, requester: input.requester, summary: input.summary, origin: "principal", jobId: input.jobId, scope: input.deviceId ? { deviceId: input.deviceId } : undefined });
    },
    /** The server is speaking the question to `to` now (the ONE registry: supersedes any open question). */
    ask: (approvalId: string, to: Principal) => service.ask(approvalId, to),
    confirm(approvalId: string, approver: Principal, spoken: { spokenYes: string; questionId: string }): DecideResult {
      return service.decide(approvalId, approver, "approve", spoken);
    },
    /** A UI confirm from the card in a verified session (screen and lesson only; control stays voice-only). */
    confirmInUi(approvalId: string, approver: Principal, cardNonce: string): DecideResult {
      return service.decide(approvalId, approver, "approve", { uiConfirm: true, cardNonce });
    },
    /** For a request a PROCESS made: the code the owner sent back from his Telegram DM (a click can't answer it). */
    confirmByTelegram(approvalId: string, approver: Principal, telegramCode: string): DecideResult {
      return service.decide(approvalId, approver, "approve", { telegramCode });
    },
    admit(approvalId: string, liveArgs: unknown): ConsumeResult {
      return service.consume(approvalId, argsDigest(action, liveArgs));
    },
  };
}

/**
 * Away mode. Non-money steps (`away.run`: a delete, a publish, an irreversible button) and the V8
 * payment (`away.payment`) are both answered with the away one-time code from the owner's verified
 * channel. The code is returned once to send on Telegram and never stored in plain text.
 */
export function awayGate(service: ApprovalService) {
  return {
    requestRun(input: { args: unknown; requester: Principal; summary: string; jobId?: string }) {
      return service.request({ action: "away.run", args: input.args, requester: input.requester, summary: input.summary, origin: "principal", jobId: input.jobId });
    },
    /**
     * V8: bound to host, payee, amount, element and task; single use; 10-minute expiry. The refusal list
     * (trades, crypto, betting, new payees, typed credentials, observed-content origin) runs first.
     * `origin` must be the owner's own away task, never text read off a page or an email.
     */
    requestPayment(input: { args: AwayPaymentArgs; requester: Principal; summary: string; origin: "principal" | "observed-content"; jobId?: string }) {
      return service.request({ action: "away.payment", args: input.args, requester: input.requester, summary: input.summary, origin: input.origin, jobId: input.jobId });
    },
    /** "yes CODE" / "no CODE" from the owner's Telegram channel, or on his OS card (pass the card nonce). */
    answer(approvalId: string, approver: Principal, yes: boolean, code: string, cardNonce?: string): DecideResult {
      if (!yes) {
        // Refusing is always safe, so a "no" needs no code, but only the person it's for can refuse it.
        const a = service.get(approvalId);
        if (!a || a.requester.personId !== approver.personId) return { ok: false, code: "wrong-approver", reason: "Only the owner can answer." };
        return service.decide(approvalId, approver, "reject");
      }
      return service.decide(approvalId, approver, "approve", cardNonce ? { awayCode: code, cardNonce } : { awayCode: code });
    },
    /**
     * Immediately before the press: `reverified` is read back from the live page (host, payee, amount,
     * the button), not copied from the request. Any difference voids the approval; a second press is refused.
     */
    beforePress(approvalId: string, action: "away.run" | "away.payment", reverified: unknown): ConsumeResult {
      return service.consume(approvalId, argsDigest(action, reverified));
    },
    /** The receipt after the press: the job records the outcome once. */
    afterPress(approvalId: string, outcome: "succeeded" | "failed" | "unknown"): boolean {
      return service.recordOutcome(approvalId, outcome);
    },
  };
}

export type PendingView = Pick<Approval, "id" | "action" | "summary" | "state" | "expiresAt" | "questionId">;
