// The ask / decide / run-once pattern for an outward action, in one place (generalised from scripts/lead-sites/publish-approval.ts,
// which now calls this; scripts/design-publish.ts is the second user). It follows what B2 already does for "release a quarantined job"
// (scripts/jobs/routes.ts):
//
//   1. ASK     the caller's request                 -> 202 { approval }   (nothing runs; one live record per exact action)
//   2. DECIDE  /__approvals/<id>/card + /decide     per B2's rules (a human requester confirms on the card in a verified
//                                                   session; a program's request needs the spoken yes or the Telegram code)
//   3. RUN     the same request + { approvalId }    consume (atomic, once, bound to a digest derived from the LIVE state) ->
//                                                   run -> record the outcome. A second call, or a restart, never replays it.
//
// Nothing here decides who may approve: that is B2 (policy.allowedEvidence, ApprovalService.decide). Nothing here knows what is
// being published: callers pass the action name, the resource key, the digest arguments and the plain-words summary.
import { createHash } from "node:crypto";
import { argsDigest, type Approval, type ApprovalService } from "./service";
import { publicView, type Principal } from "./principal";

export type GatedNotify = (personId: string, text: string) => Promise<{ ok: boolean; detail: string }>;
export type GatedReply = { status: number; body: Record<string, unknown> };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Who a request is bound to. A browser's request is bound to THAT confirmed human session (a hash of the server-only session key;
 * the key itself is never stored), so a program holding only the owner token, or another session of the same person, can't complete
 * an action a browser asked for. A program's request is bound to "process" (answered by the spoken yes or Telegram code, and run
 * from the same kind of caller). The binding is carried in the approval's scope.resource, so it needs no schema.
 */
export function requesterBinding(p: Principal): string {
  return p.actor === "human" && typeof p.sessionId === "string" && p.sessionId.length >= 8 ? `human:${createHash("sha256").update(p.sessionId).digest("hex").slice(0, 16)}` : "process";
}
/** The scope.resource an approval is stored under: the action's own resource key plus who asked. */
export const boundResource = (resource: string, p: Principal) => `${resource}:${requesterBinding(p)}`;

/**
 * The live state can't be bound to a digest (a folder too big, too many files, unreadable): the action is refused, never approved
 * against a constant. Throw this from `args` (pass `args` as a function to have it evaluated inside the gate).
 */
export class Unbindable extends Error {}

/** `args` as given, or the result of the function that derives it from the live state (which may throw Unbindable). */
function bound(args: unknown): { ok: true; args: unknown } | { ok: false; reply: { status: number; body: Record<string, unknown> } } {
  try {
    return { ok: true, args: typeof args === "function" ? (args as () => unknown)() : args };
  } catch (error) {
    if (error instanceof Unbindable) return { ok: false, reply: { status: 409, body: { error: error.message, code: "unbindable" } } };
    throw error;
  }
}

/** What an approval is bound to. `args` is hashed (canonical JSON); anything that changes the outward effect must be in it. */
export type GatedSpec = { action: string; resource: string };

/** Step 1: ask. Nothing runs. A repeat of the same exact request returns the same live approval. */
export async function askGated(
  approvals: ApprovalService,
  notify: GatedNotify,
  input: GatedSpec & { args: unknown; summary: string; requester: Principal; /** the sentence the 202 carries as `next`, given the approval id */ next: (approvalId: string) => string },
): Promise<GatedReply> {
  const derived = bound(input.args);
  if (!derived.ok) return derived.reply;
  let result;
  try {
    result = approvals.request({ action: input.action, args: derived.args, requester: input.requester, summary: input.summary, origin: "principal", scope: { resource: boundResource(input.resource, input.requester) } });
  } catch (error) {
    return { status: 409, body: { error: error instanceof Error ? error.message : "Approvals aren't available here." } };
  }
  if (!result.ok) return { status: 409, body: { error: result.refusal.reason } };
  // B2 merges the same person's identical request into one live record whatever session asked. If that live record belongs to a
  // DIFFERENT session of this person, this session could never run it (bound above), so say so instead of handing it over.
  if (result.approval.scope.resource !== boundResource(input.resource, input.requester))
    return { status: 409, body: { error: "Another session of yours already has this exact request waiting for approval. Finish or cancel it there, or wait for it to expire, then ask again." } };
  // A program's request (a script, Hermes) is answered by the spoken yes or the code in the requester's OWN Telegram DM.
  // The code goes only there, once; it is never in this response.
  let codeSent: boolean | undefined;
  if (result.telegramCode) {
    const sent = await notify(input.requester.personId, `Approval needed: ${result.approval.summary} Reply: approve ${result.telegramCode}`).catch(() => ({ ok: false, detail: "not sent" }));
    codeSent = sent.ok;
  }
  return {
    status: 202,
    body: {
      needsApproval: true,
      approval: publicView(result.approval),
      ...(codeSent !== undefined ? { codeSent } : {}),
      next: input.next(result.approval.id),
    },
  };
}

export type RunWords = {
  /** "preview" / "post": what the digest is of, for the "changed" message. */
  noun: string;
  /** "Only the person who asked for this can run it." etc. are fixed; this names the missing approval's subject. */
  notFound?: string;
};

export type GatedRun<T> = { ok: true; value: T; approvalId: string } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Step 3: run an approved request exactly once. `args` MUST be derived from the live state now, so a change after approval is a
 * digest mismatch (ApprovalService.consume voids the approval). `run` is only called after the approval was consumed.
 * `succeeded` (default: always) decides whether the recorded outcome is "succeeded" or "failed" for a run that returned normally.
 */
export async function runGated<T>(
  approvals: ApprovalService,
  input: GatedSpec & { args: unknown; approvalId: unknown; caller: Principal; words: RunWords },
  run: (by: string) => Promise<T>,
  succeeded: (value: T) => boolean = () => true,
): Promise<GatedRun<T>> {
  const id = input.approvalId;
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, status: 400, body: { error: "That isn't an approval id." } };
  const approval: Approval | null = approvals.get(id);
  if (!approval || approval.action !== input.action || !String(approval.scope.resource ?? "").startsWith(`${input.resource}:`))
    return { ok: false, status: 404, body: { error: input.words.notFound ?? `No such approval for this ${input.words.noun}.` } };
  // Whoever asked is who runs it: the same person AND the same confirmed session (or, for a program's request, a program).
  // Refused (403) BEFORE anything is consumed or voided, so another session's attempt costs the asker nothing.
  if (approval.requester.personId !== input.caller.personId || approval.scope.resource !== boundResource(input.resource, input.caller))
    return { ok: false, status: 403, body: { error: "Only the person and the browser session that asked for this can run it." } };
  if (approval.state !== "approved") return { ok: false, status: 409, body: { error: `Not approved yet (it is ${approval.state}).`, approval: publicView(approval) } };
  // Atomic and single use, with the digest re-derived from the live state. A changed state voids the approval.
  const live = bound(input.args);
  if (!live.ok) return { ok: false, status: live.reply.status, body: live.reply.body };
  const consumed = approvals.consume(id, argsDigest(input.action, live.args));
  if (!consumed.ok)
    return {
      ok: false,
      status: 409,
      body: {
        error:
          consumed.code === "digest-mismatch" ? `The ${input.words.noun} changed after it was approved, so the approval is void. Ask again.`
          : consumed.code === "consumed" ? "That approval was already used."
          : consumed.code === "expired" ? "That approval expired. Ask again."
          : "That approval can't be used.",
        code: consumed.code,
      },
    };
  try {
    const value = await run(approval.requester.personId);
    approvals.recordOutcome(id, succeeded(value) ? "succeeded" : "failed");
    return { ok: true, value, approvalId: id };
  } catch (error) {
    approvals.recordOutcome(id, "failed");
    return { ok: false, status: 400, body: { error: error instanceof Error ? error.message : "That didn't work.", approvalId: id, outcome: "failed" } };
  }
}
