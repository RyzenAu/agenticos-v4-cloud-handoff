// Memory forget (kinds b and c) and bulk retraction on the durable Approval service.
//
// Stage D (scripts/memory/approvals.ts) defines `MemoryApprovals.require` as the interface Stage B
// implements. This adapter IS that implementation (Track 6 wired it in, replacing Stage D's interim stub):
// `require` / `grant` / `pending` backed by approvals.request / decide / consume, so a forget approval
// survives a restart, is asked once and is consumed exactly once.
//
// Evidence (B2's allowedEvidence): a request a PERSON made in the UI is answered by the card in a verified
// browser session (uiConfirm) or a spoken yes; a request a PROCESS made (Claude Code, Hermes, a script) only
// by either founder's spoken yes to the question Jarvis put (one shared workspace, lead decision 28 Sep), or
// by the one-time code sent to the REQUESTER's own Telegram DM. The page token alone never approves
// anything, a spoken yes counts only from a person (B1 actor human), and the approver is always the
// server-resolved B1 principal (its session id comes from the session cookie, never from a body).
import { argsDigest } from "../canonical";
import type { Approval, ApprovalService, Evidence } from "../service";
import type { PersonId, Principal, PrincipalVia } from "../principal";
import { allowedEvidence } from "../policy";
import { mayWithdraw } from "../service";

export type MemoryApprovalAction = "memory.forget" | "memory.bulk-retract";
export const MEMORY_ACTIONS: readonly MemoryApprovalAction[] = ["memory.forget", "memory.bulk-retract"];
/** B1's resolved principal, as the memory connector carries it (server-side only; never in a response). */
export type OsIdentity = { personId: string; via: string; actor?: "human" | "process"; sessionId?: string; deviceId?: string };
/** Stage D's Principal (scripts/memory/types.ts), with B1's own principal when the server resolved one. */
export type MemoryPrincipal = {
  id: string;
  name: string;
  via: "local" | "tailnet" | "telegram" | "voice" | "system";
  /** B1's actor, passed through (missing = process). */ actor?: "human" | "process";
  os?: OsIdentity;
};
export type MemoryApprovalDecision =
  | { status: "approved"; approvalId: string }
  | { status: "pending"; approvalId: string; expiresAt: string; requestedActor: "human" | "process"; telegram?: TelegramDelivery }
  | { status: "denied"; reason: "unknown" | "expired" | "consumed" | "mismatch" | "not-yours"; approvalId?: string };
/** A program's code: "sending" until `hermes send` finishes, then "sent" or "not-sent" (REVIEW-T6 R2 nit). */
export type TelegramDelivery = "sending" | "sent" | "not-sent";
/** Stage D's StubApproval view, so the Memory page keeps rendering the same fields. */
export type MemoryApprovalView = {
  id: string;
  action: MemoryApprovalAction;
  target: string;
  summary: string;
  requested_by: string;
  /** Who asked: a person in the UI, or a program acting for them. */
  requested_actor: "human" | "process";
  /** How it can be approved: the card's button, or only a spoken yes / the Telegram code. */
  approve_with: "button" | "voice-or-telegram";
  state: Approval["state"];
  requested_at: string;
  expires_at: string;
  granted_by: string | null;
  granted_via: "ui" | "voice" | "telegram" | null;
  granted_at: string | null;
  consumed_at: string | null;
  outcome: Approval["outcome"] | null;
  /** A program's request: whether its one-time code reached the requester's Telegram DM. */
  telegram: TelegramDelivery | null;
};
export type GrantProof = { sessionId?: string; cardNonce: string } | { spokenYes: string; questionId: string } | { telegramCode: string };
export type GrantChannel = "ui" | "voice" | "telegram";
export type GrantOutcome = { ok: true; approval: MemoryApprovalView } | { ok: false; reason: string; code: string };
/** Sends one line to a person's own Telegram DM (the requester's). Never logs the text. */
export type CodeNotifier = (personId: PersonId, text: string) => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };

const B1_VIAS: readonly PrincipalVia[] = ["loopback-owner", "paired-session", "tailnet-person", "telegram-owner", "companion", "routine"];

/**
 * Stage D's caller as a B2 Principal. With B1's own principal attached (`os`, set by the server's resolver),
 * that is used as it is: its via, actor, session id and device. Without it (tests, older callers) the
 * Stage D via is mapped, and there is no session id, so no UI confirm is possible (fail closed).
 * `system` (automation) is never a person.
 */
export function principalFromMemory(p: MemoryPrincipal): Principal | null {
  const personId = String(p?.id ?? "").trim().toLowerCase() as PersonId;
  if (personId !== "usman" && personId !== "mehroz") return null;
  if (p.via === "system") return null;
  const os = p.os;
  if (os && String(os.personId).toLowerCase() === personId && B1_VIAS.includes(os.via as PrincipalVia))
    return {
      personId,
      via: os.via as PrincipalVia,
      // Fail closed: a person only if BOTH the memory caller and B1's own principal say so.
      actor: os.actor === "human" && p.actor === "human" ? "human" : "process",
      ...(typeof os.sessionId === "string" && os.sessionId.length >= 8 ? { sessionId: os.sessionId } : {}),
      ...(typeof os.deviceId === "string" && os.deviceId ? { deviceId: os.deviceId } : {}),
      displayName: p.name,
    };
  switch (p.via) {
    case "local":
    case "voice":
      return { personId, via: "loopback-owner", actor: p.actor === "human" ? "human" : "process", displayName: p.name };
    case "tailnet":
      return { personId, via: "tailnet-person", actor: p.actor === "human" ? "human" : "process", displayName: p.name };
    case "telegram":
      return { personId, via: "telegram-owner", actor: p.actor === "human" ? "human" : "process", displayName: p.name };
    default:
      return null;
  }
}

const memoryArgs = (target: string, digest: string) => ({ target, planDigest: digest });
const requestedActor = (a: Approval): "human" | "process" => (a.requester.actor === "human" ? "human" : "process");

function view(a: Approval, delivery: Map<string, TelegramDelivery> = new Map()): MemoryApprovalView {
  const actor = requestedActor(a);
  return {
    id: a.id,
    action: a.action as MemoryApprovalAction,
    target: a.scope.resource ?? "",
    summary: a.summary,
    requested_by: a.requester.personId,
    requested_actor: actor,
    approve_with: allowedEvidence(a.action, actor === "human").includes("uiConfirm") ? "button" : "voice-or-telegram",
    state: a.state,
    requested_at: a.createdAt,
    expires_at: a.expiresAt,
    granted_by: a.approver?.personId ?? null,
    granted_via: a.evidence === "uiConfirm" ? "ui" : a.evidence === "spokenYes" ? "voice" : a.evidence === "telegramCode" ? "telegram" : null,
    granted_at: a.state === "approved" || a.state === "consumed" ? (a.decidedAt ?? null) : null,
    consumed_at: a.consumedAt ?? null,
    outcome: a.outcome ?? null,
    telegram: delivery.get(a.id) ?? null,
  };
}

/**
 * The line sent to the requester's own Telegram DM for a program's request. Ids only (the stored summary),
 * never the item's title or text: Telegram and Hermes keep their history (REVIEW-T6 finding 6).
 */
export function telegramCodeText(storedSummary: string, code: string, minutes: number) {
  return `Jarvis memory: a program on your PC asked for this, and it needs you:\n${storedSummary}\nThe item is on the Memory page.\nTo approve, reply: approve ${code}\nTo refuse: deny ${code}\n(Valid ${minutes} minutes. If you didn't expect this, deny it.)`;
}

export function createMemoryApprovals(service: ApprovalService, options: { notify?: CodeNotifier } = {}) {
  /** Where each program's code is (memory only, like the code's key: a restart makes the code unusable anyway). */
  const delivery = new Map<string, TelegramDelivery>();
  const viewOf = (a: Approval) => view(a, delivery);
  const live = (id: string) => {
    service.sweep();
    return typeof id === "string" ? service.get(id) : null;
  };
  const isMemory = (a: Approval | null): a is Approval => !!a && (MEMORY_ACTIONS as readonly string[]).includes(a.action);
  return {
    /** The approval service itself (the Telegram relay claims codes against it). */
    service,
    /**
     * Without `approvalId`: issue (or return the matching live) approval, as pending. A program's request
     * gets a one-time code, sent to the requester's own Telegram DM (never returned to the caller).
     * With `approvalId`: approved AND consumed (single use) only when it was granted, is unexpired and
     * unused, and matches action + target + plan digest exactly; pending while undecided; else denied.
     * A granted approval whose action changed (another target, or the item changed) is voided.
     */
    require(req: {
      action: MemoryApprovalAction;
      target: string;
      digest: string;
      principal: MemoryPrincipal;
      approvalId?: string | null;
      /** STORED with the approval: ids only, never the text being forgotten (the store outlives the forget). */
      summary: string;
      /** Readable, for the person asking in the OS (a reply, never stored and never sent to Telegram). */
      display?: string;
    }): MemoryApprovalDecision {
      const args = memoryArgs(req.target, req.digest);
      if (!req.approvalId) {
        const requester = principalFromMemory(req.principal);
        if (!requester) return { status: "denied", reason: "unknown" };
        const r = service.request({ action: req.action, args, requester, summary: req.summary, origin: "principal", scope: { resource: req.target } });
        if (!r.ok) return { status: "denied", reason: "unknown" };
        let telegram: TelegramDelivery | undefined;
        if (r.telegramCode) {
          telegram = "not-sent";
          if (options.notify) {
            const minutes = Math.max(1, Math.round((Date.parse(r.approval.expiresAt) - Date.now()) / 60_000));
            try {
              const id = r.approval.id;
              const sent = options.notify(requester.personId, telegramCodeText(r.approval.summary, r.telegramCode, minutes));
              telegram = "sending";
              delivery.set(id, "sending");
              // "sent" only once hermes send says so; a failure is recorded as "not-sent".
              void Promise.resolve(sent)
                .then((res) => delivery.set(id, res && typeof res === "object" && "ok" in res && res.ok === false ? "not-sent" : "sent"))
                .catch(() => delivery.set(id, "not-sent"));
            } catch {
              telegram = "not-sent";
            }
          }
          delivery.set(r.approval.id, delivery.get(r.approval.id) ?? telegram);
        }
        return { status: "pending", approvalId: r.approval.id, expiresAt: r.approval.expiresAt, requestedActor: requestedActor(r.approval), ...(telegram ? { telegram } : {}) };
      }
      const a = live(req.approvalId);
      if (!isMemory(a)) return { status: "denied", reason: "unknown" };
      if (a.action !== req.action || a.argsDigest !== argsDigest(req.action, args)) {
        // The thing to delete changed after it was approved (or this id is for something else). Void it only
        // when this caller may withdraw it (a person, or the program that asked: S1's mayWithdraw); anyone
        // else is just refused, so a mistyped or hostile request can't cancel someone's approval (REVIEW-T6 7).
        const caller = principalFromMemory(req.principal);
        if ((a.state === "approved" || a.state === "pending") && caller && mayWithdraw(a, caller)) service.cancel(a.id, "args-changed", caller);
        return { status: "denied", reason: "mismatch", approvalId: a.id };
      }
      if (a.state === "consumed") return { status: "denied", reason: "consumed", approvalId: a.id };
      if (a.state === "expired") return { status: "denied", reason: "expired", approvalId: a.id };
      if (a.state === "pending") return { status: "pending", approvalId: a.id, expiresAt: a.expiresAt, requestedActor: requestedActor(a) };
      if (a.state !== "approved") return { status: "denied", reason: "unknown", approvalId: a.id };
      // Bound to its approver (REVIEW-T6 R2 nit): an approved-but-unused approval is used only by the person
      // who approved it, so another caller holding its id can't spend it.
      const caller = principalFromMemory(req.principal);
      if (!caller || !a.approver || caller.personId !== a.approver.personId) return { status: "denied", reason: "not-yours", approvalId: a.id };
      const used = service.consume(a.id, argsDigest(req.action, args));
      if (used.ok) return { status: "approved", approvalId: a.id };
      return { status: "denied", reason: used.code === "expired" ? "expired" : used.code === "consumed" ? "consumed" : used.code === "digest-mismatch" ? "mismatch" : "unknown", approvalId: a.id };
    },
    /**
     * Server-internal (the voice path, never HTTP): Jarvis is putting this approval's question to this
     * person now. Only a spoken yes heard while it is the open question, from that person, answers it.
     */
    ask(approvalId: string, to: MemoryPrincipal): { questionId: string; expiresAt: number } | null {
      const who = principalFromMemory(to);
      const a = live(approvalId);
      // A question is put to a person (B1 actor human), never to a program (REVIEW-T6 finding 5).
      if (!who || who.actor !== "human" || !isMemory(a) || a.state !== "pending") return null;
      try {
        const q = service.ask(approvalId, who);
        return { questionId: q.questionId, expiresAt: q.expiresAt };
      } catch {
        return null;
      }
    },
    /** The card rendered in a verified browser session: a single-use nonce bound to it (null otherwise). */
    card(approvalId: string, viewer: MemoryPrincipal): { cardNonce: string; expiresAt: number } | null {
      const who = principalFromMemory(viewer);
      const a = live(approvalId);
      if (!who || !isMemory(a)) return null;
      // A program's request is never answered by a click, so its card has no confirm nonce at all.
      if (!allowedEvidence(a.action, requestedActor(a) === "human").includes("uiConfirm")) return null;
      return service.card(approvalId, who);
    },
    /**
     * A person grants: the card in their verified browser session (`ui`), a spoken yes to the question
     * Jarvis put (`voice`), or the code from their Telegram DM (`telegram`, the relay's verified sender).
     * Automation (`system`) and a caller without the matching evidence never approve.
     */
    grant(approvalId: string, principal: MemoryPrincipal, channel: GrantChannel, proof: GrantProof): GrantOutcome {
      const mapped = principalFromMemory(principal);
      if (!mapped) return { ok: false, code: "unverified", reason: "Automated callers can't approve a forget." };
      const a = live(approvalId);
      if (!isMemory(a)) return { ok: false, code: "unknown", reason: "No such approval." };
      let evidence: Evidence;
      let approver: Principal = mapped;
      if (channel === "ui" && proof && "cardNonce" in proof && principal.via !== "voice" && mapped.via !== "telegram-owner") {
        // The session id is ONLY the server-resolved one (B1's session cookie); a body can't supply one.
        if (!mapped.sessionId) return { ok: false, code: "unverified-session", reason: "Confirming needs your own signed-in browser session on the Memory page." };
        if (proof.sessionId && proof.sessionId !== mapped.sessionId) return { ok: false, code: "wrong-session", reason: "That card belongs to another session." };
        evidence = { uiConfirm: true, cardNonce: proof.cardNonce };
      } else if (channel === "voice" && proof && "spokenYes" in proof) {
        // A spoken yes counts only from a person (B1 actor human), never from a program (REVIEW-T6 finding 5).
        if (mapped.actor !== "human") return { ok: false, code: "unverified", reason: "Only a person's spoken yes approves a forget." };
        evidence = { spokenYes: proof.spokenYes, questionId: proof.questionId };
      }
      else if (channel === "telegram" && proof && "telegramCode" in proof) evidence = { telegramCode: proof.telegramCode };
      else return { ok: false, code: "evidence-required", reason: "Approve on the Memory page's card, say yes right after Jarvis asks, or answer the code in your Telegram DM." };
      const r = service.decide(approvalId, approver, "approve", evidence);
      return r.ok ? { ok: true, approval: viewOf(r.approval) } : { ok: false, code: r.code, reason: r.reason };
    },
    /** A person says no (card, voice or Telegram): nothing is removed, and it can't be approved later. */
    reject(approvalId: string, principal: MemoryPrincipal): GrantOutcome {
      const mapped = principalFromMemory(principal);
      if (!mapped || mapped.actor !== "human") return { ok: false, code: "unverified", reason: "Only a person can refuse it." };
      const a = live(approvalId);
      if (!isMemory(a)) return { ok: false, code: "unknown", reason: "No such approval." };
      const r = service.decide(approvalId, mapped, "reject");
      return r.ok ? { ok: true, approval: viewOf(r.approval) } : { ok: false, code: r.code, reason: r.reason };
    },
    /** Whether this approval is a memory approval that a Telegram code can answer (a program's request). */
    telegramAnswerable(approvalId: string): boolean {
      const a = live(approvalId);
      return isMemory(a) && a.state === "pending" && allowedEvidence(a.action, requestedActor(a) === "human").includes("telegramCode");
    },
    /** After the forget ran: its outcome, once (so a restart doesn't turn it into "unknown"). */
    recordOutcome(approvalId: string, outcome: "succeeded" | "failed" | "unknown"): boolean {
      return service.recordOutcome(approvalId, outcome);
    },
    get(approvalId: string): MemoryApprovalView | null {
      const a = live(approvalId);
      return isMemory(a) ? viewOf(a) : null;
    },
    pending(): MemoryApprovalView[] {
      return [...service.list({ state: "pending", limit: 100 }), ...service.list({ state: "approved", limit: 100 })]
        .filter((a) => (MEMORY_ACTIONS as readonly string[]).includes(a.action))
        .map(viewOf);
    },
  };
}
export type DurableMemoryApprovals = ReturnType<typeof createMemoryApprovals>;
