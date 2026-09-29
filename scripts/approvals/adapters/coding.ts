// The coding-merge placeholder on the durable Approval service (CODING-HARNESS §3.9).
//
// Consequential coding actions are never agent tools: the orchestrator builds an apply step bound to
// {action, repoId, remote|branch, fromSha, toRef, specDigest}, asks ONCE, and consumes the approval
// exactly once immediately before performing it, with the digest re-derived from the LIVE sha/ref, so a
// new commit voids the approval. C4's orchestrator calls these two functions; nothing else changes.
import { argsDigest } from "../canonical";
import type { ApprovalService } from "../service";
import type { PersonId, Principal } from "../principal";

/** coding-harness-contracts.ts ApprovalAction, plus the generic merge used before C4. */
export type CodingApprovalAction = "coding.merge" | "git.merge.protected" | "git.push.production" | "deploy" | "db.migrate.production" | "provider.config.change";
export type CodingApplyInput = {
  action: CodingApprovalAction;
  jobId: string;
  applyStepId: string;
  repoId: string;
  remote: string | null;
  branch: string | null;
  fromSha: string;
  toRef: string;
  specDigest: string;
  requestedBy: Principal;
  /** Always the owner for production actions. */
  approverPersonId: PersonId;
  targetDeviceId: string;
  summary: string;
};
/** coding-harness-contracts.ts ApprovalRequestRef. */
export type CodingApprovalRef = {
  approvalId: string;
  subject: { kind: "coding.apply"; jobId: string; applyStepId: string };
  action: CodingApprovalAction;
  digest: string;
  requestedBy: Principal;
  approverPersonId: PersonId;
  targetDeviceId: string;
  summary: string;
  state: "pending" | "approved" | "rejected" | "expired" | "cancelled" | "consumed";
  issuedVia: "ui" | "spoken-yes" | "telegram" | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

/** A FULL commit id (SHA-1 or SHA-256): a short prefix could name a different commit. */
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** The exact bound fields (the digest's inputs). */
export function codingApplyArgs(input: Pick<CodingApplyInput, "action" | "repoId" | "remote" | "branch" | "fromSha" | "toRef" | "specDigest">) {
  if (!SHA.test(input.fromSha)) throw new Error("fromSha must be a full 40- or 64-hex git sha");
  return { action: input.action, repoId: input.repoId, remote: input.remote, branch: input.branch, fromSha: input.fromSha.toLowerCase(), toRef: input.toRef, specDigest: input.specDigest };
}

function ref(service: ApprovalService, id: string, input: CodingApplyInput): CodingApprovalRef {
  const a = service.get(id)!;
  return {
    approvalId: a.id,
    subject: { kind: "coding.apply", jobId: input.jobId, applyStepId: input.applyStepId },
    action: input.action,
    digest: a.argsDigest,
    requestedBy: a.requester,
    approverPersonId: input.approverPersonId,
    targetDeviceId: input.targetDeviceId,
    summary: a.summary,
    state: a.state,
    issuedVia: a.evidence === "uiConfirm" ? "ui" : a.evidence === "spokenYes" ? "spoken-yes" : a.evidence === "telegramCode" ? "telegram" : null,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    consumedAt: a.consumedAt ?? null,
  };
}

/** Ask ONCE for this exact apply step (a repeat returns the same live approval). */
/**
 * The coding orchestrator is a PROCESS: its merge/deploy approvals are answered by the owner's spoken yes
 * or the code it sends to his Telegram DM (`telegramCode`, returned once), never by a UI confirm.
 */
export function requestCodingApply(service: ApprovalService, input: CodingApplyInput): { ok: true; ref: CodingApprovalRef; telegramCode?: string } | { ok: false; reason: string } {
  if (!UUID.test(input.jobId)) return { ok: false, reason: "A coding apply step belongs to a job (UUID)." };
  let args: ReturnType<typeof codingApplyArgs>;
  try {
    args = codingApplyArgs(input);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const r = service.request({
    action: input.action,
    args,
    requester: input.requestedBy,
    summary: input.summary,
    origin: "principal",
    jobId: input.jobId,
    scope: { deviceId: input.targetDeviceId, resource: `${input.repoId}:${input.toRef}`, approverPersonId: input.approverPersonId },
  });
  return r.ok ? { ok: true, ref: ref(service, r.approval.id, input), ...(r.telegramCode ? { telegramCode: r.telegramCode } : {}) } : { ok: false, reason: r.refusal.reason };
}

/**
 * Immediately before the apply: consume with the digest of what is about to happen NOW (live fromSha,
 * toRef, spec). A changed sha voids the approval; a second call is refused (single use).
 */
export function consumeCodingApply(service: ApprovalService, approvalId: string, live: Parameters<typeof codingApplyArgs>[0]) {
  return service.consume(approvalId, argsDigest(live.action, codingApplyArgs(live)));
}
