/**
 * Forget approvals (Track 6: on Stage B2's durable approval service; Stage D's interim stub is gone).
 *
 * Consequential deletion (a Hindsight-only memory, vault content everywhere, or a held mass removal)
 * needs a SERVER-HELD approval bound to the exact action, target and plan digest. A client can only quote
 * an approval id; it can never assert "approved". The record lives in B2's ApprovalService (SQLite, WAL):
 * asked once, kept across restarts, consumed exactly once, its outcome written once.
 *
 * Who can approve (B2's allowedEvidence, on B1's actor):
 *   - a request a PERSON made on the Memory page: the card's button in their own verified browser session
 *     (a single-use nonce bound to that session), or their spoken yes to Jarvis's question;
 *   - a request a PROGRAM made (Claude Code or Hermes through /__memory/mcp, a script): only the spoken yes
 *     to the question Jarvis put, or the one-time code sent to the requester's own Telegram DM. Never a
 *     click, never the page token: an agent can never approve its own forget.
 *
 * The main AgenticOS uses the process-wide service (`jobsRuntime(root).approvals`, the one /__approvals
 * serves, recovered once at start). A fully synthetic copy (its own vault and store) keeps its own
 * `approvals.sqlite` in its state dir, so tests never touch the real one.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ApprovalService, type SpokenLedger } from "../approvals/service";
import { createMemoryApprovals, type CodeNotifier, type DurableMemoryApprovals, type MemoryApprovalDecision } from "../approvals/adapters/memory";
import type { Principal } from "./types";

export type { GrantChannel, GrantProof, GrantOutcome, MemoryApprovalView, CodeNotifier } from "../approvals/adapters/memory";
/** memory.bulk-retract: releasing a held mass removal (documents that vanished from the vault at once). */
export type ApprovalAction = "memory.forget" | "memory.bulk-retract";
export type ApprovalRequest = { action: ApprovalAction; target: string; digest: string };
export type ApprovalDecision = MemoryApprovalDecision;

export interface MemoryApprovals {
  require(req: ApprovalRequest & { principal: Principal; approvalId?: string | null; summary: string; display?: string }): ApprovalDecision;
}
export type Approvals = DurableMemoryApprovals;

/** B1's actor for a memory caller; missing = process (never assume a person). */
export const actorOf = (p: Principal): "human" | "process" => (p?.actor === "human" ? "human" : "process");

/** A synthetic copy's (or a test's) own durable store in its state dir. */
export function localApprovals(stateDir: string, options: { spoken?: SpokenLedger; now?: () => number; notify?: CodeNotifier; code?: () => string } = {}): Approvals {
  const service = new ApprovalService({ path: join(stateDir, "approvals.sqlite"), ...(options.spoken ? { spoken: options.spoken } : {}), ...(options.now ? { now: options.now } : {}), ...(options.code ? { code: options.code } : {}) });
  service.recover();
  return createMemoryApprovals(service, { notify: options.notify });
}

/**
 * A section heading as the approvals store keeps it: a hash, never the words (the store outlives the forget
 * and /__approvals lists it; REVIEW-T6 finding 6). Same normalisation as wiki-store's heading match.
 */
export function headingKey(heading: string): string {
  const norm = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  return `h-${createHash("sha256").update(norm).digest("hex").slice(0, 16)}`;
}
/** The heading in this note text whose key is `key`, or null. */
export function headingForKey(raw: string, key: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && headingKey(m[1]) === key) return m[1].trim();
  }
  return null;
}
export { approvalTarget } from "./approval-target";
