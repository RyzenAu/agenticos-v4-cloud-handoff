// Telegram one-time codes for approvals a PROCESS asked for (B2's `telegramCode` evidence), Track 6.
//
// The Hermes gateway's away-mode plugin relays "approve K7PQ-M4XZ" / "deny K7PQ-M4XZ" from a person's own
// Telegram DM to /__away/telegram, where B1 verifies the sender (resolveTelegramPrincipal). A reply in the
// Telegram-code format (8 characters, "XXXX-XXXX", docs/APPROVAL-CODES.md) is answered HERE and never goes
// on to away mode: the approval service claims it for one of the sender's own pending approvals, or counts
// a miss against the sender (REVIEW-T6 finding 1: an unmatched code used to be free, so 248 wrong codes cost
// nothing). The handler registered for the approval's action then answers it. Away mode's own 4-character
// codes ("approve K7PQ") never reach this module and behave exactly as before.
import type { ApprovalService } from "./service";
import type { Principal } from "../identity/principal";
import { canonicalTelegramCode } from "./service";

export type TelegramCodeHandler = {
  actions: readonly string[];
  /** Answer one approval of these actions for its requester's own DM: the reply to send (never the item's text). */
  answer: (approvalId: string, sender: Principal, yes: boolean, code: string) => Promise<string> | string;
};

const handlers = new Set<TelegramCodeHandler>();

/** Register one handler (a memory service at start). Returns the unregister function. */
export function registerTelegramCodeHandler(handler: TelegramCodeHandler): () => void {
  handlers.add(handler);
  return () => void handlers.delete(handler);
}

/**
 * A yes or no word, then a Telegram-format code: 8 characters with a dash (or a space) in the middle. The
 * separator is required, so ordinary words ("approve payments") are never taken for a code or a miss.
 */
const CODE_REPLY = /^\s*(yes|approve|approved|y|no|deny|denied|reject|n)\s+([A-Za-z0-9]{4}[-\s][A-Za-z0-9]{4})\s*[.!]?\s*$/i;

export function parseCodeReply(text: string): { yes: boolean; code: string } | null {
  const m = CODE_REPLY.exec(String(text ?? ""));
  if (!m) return null;
  const code = canonicalTelegramCode(m[2]);
  return code ? { yes: /^(yes|approve|approved|y)$/i.test(m[1]), code } : null;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: "Australia/Sydney" });

/**
 * A verified Telegram sender's reply. Null when it isn't a Telegram-format code reply (away mode takes it),
 * or the sender isn't a person's own interactive DM. Otherwise the reply to send: this module decides.
 */
export type CodeAnswerOptions = {
  /**
   * A line to a person's own Telegram DM. When a miss starts a lockout, the person whose codes are paused is
   * told directly (REVIEW-T6 R2): the "paused" reply otherwise goes only to whoever posted the relay
   * request, which may be the program doing the guessing.
   */
  notify?: (personId: string, text: string) => Promise<unknown> | unknown;
};

export async function answerTelegramCode(sender: Principal | null, text: string, service: (() => ApprovalService) | null, options: CodeAnswerOptions = {}): Promise<string | null> {
  const reply = parseCodeReply(text);
  if (!reply) return null;
  if (!sender || sender.via !== "telegram-owner" || sender.actor !== "human") return null;
  let approvals: ApprovalService;
  try {
    if (!service) throw new Error("no approval service");
    approvals = service();
  } catch {
    return "Approvals aren't available on the PC right now. Nothing was done.";
  }
  const claim = approvals.claimCode(reply.code, sender.personId);
  if (claim.kind === "nothing-pending") return "Nothing is waiting for a code from you. Nothing was done.";
  if (claim.kind === "miss" && claim.lockedNow && options.notify) {
    try {
      void Promise.resolve(
        options.notify(
          sender.personId,
          `Jarvis: 3 wrong approval codes were sent for you, so your Telegram approval codes are paused until ${hhmm(claim.until)} and the waiting ones are void. If that wasn't you, something on the PC may be guessing: check the Memory page. You can still approve by saying yes to Jarvis.`,
        ),
      ).catch(() => undefined);
    } catch {
      /* the notice is best effort; the lockout itself already holds */
    }
  }
  if (claim.kind === "locked")
    return `Too many wrong codes, so codes are paused until ${hhmm(claim.until)}. Nothing was done. You can still approve by saying yes to Jarvis.`;
  if (claim.kind === "miss")
    return claim.voided
      ? `That code doesn't match anything waiting for you (${claim.misses}/3). Nothing was done, and your waiting codes are now void: approve by saying yes to Jarvis, or ask again for a new code.`
      : `That code doesn't match anything waiting for you (${claim.misses}/3). Nothing was done.`;
  if (claim.kind !== "match") return null;
  for (const h of [...handlers].reverse()) {
    // Newest first: one memory service per server, and the latest registered is the live one.
    if (!h.actions.includes(claim.action)) continue;
    try {
      return await h.answer(claim.approvalId, sender, reply.yes, reply.code);
    } catch {
      return "That approval couldn't be completed on the PC. Nothing was done; check the Memory page.";
    }
  }
  return "That code is right, but this kind of approval can't be answered from Telegram yet. Nothing was done.";
}
