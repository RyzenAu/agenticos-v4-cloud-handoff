/**
 * Bulk, newsletter and marketing mail (L10, 29 Sep 2026; audit AUD-OS P2-10).
 *
 * The Inbox "To answer" list must hold conversations a person is waiting on, never a cloud
 * vendor's promotion or a shopping site's price alert. One pure rule, shared by the classifier
 * at ingest (scripts/account-connections.ts) and the Inbox display (so mail stored before this
 * rule existed is still kept out of "To answer"). It reads metadata only: the sender, Gmail's own
 * category labels, the standard bulk headers and the subject/opening words. Nothing here reads a
 * mailbox, replies, archives or labels anything.
 *
 * Signals, strongest first:
 *  1. Gmail put it in Promotions, Social, Updates or Forums (labelIds CATEGORY_*).
 *  2. A List-Unsubscribe or List-Id header, or Precedence: bulk/list/junk.
 *  3. A sender that is a robot or a campaign tool: no-reply, newsletter, marketing, deals ...
 *     and mailer subdomains (mail., email., news., e.), unless the message is a reply to us.
 *  4. Marketing-style subjects: "% off", "price alert", "sale ends", "back in stock", "your cart".
 * A message the owner replied to (or a draft) is a conversation and is never bulk.
 */

export type BulkInput = {
  from?: string | null;
  subject?: string | null;
  body?: string | null;
  labelIds?: readonly string[] | null;
  /** A List-Unsubscribe / List-Id header was present. */
  listUnsubscribe?: boolean;
  /** The Precedence header ("bulk", "list", "junk"). */
  precedence?: string | null;
  /** In-Reply-To was set: someone answered a message, so it is a conversation. */
  isReply?: boolean;
  /** A draft reply exists for it. */
  hasDraft?: boolean;
};

const GMAIL_BULK_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]);

const ROBOT_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|newsletters?|news|marketing|promo(?:tions?)?|deals?|offers?|mailer|mailer-daemon|bounces?|notifications?|notify|updates?|alerts?|digest|campaigns?|announce(?:ments?)?|receipts?)(?:[-_.+].*)?$/i;
const MAILER_SUBDOMAIN = /^(?:mail|email|e|em|mg|news|newsletter|newsletters|marketing|promo|send|sender|bounce|notify|notifications|info-mail|reply|go|click|links?|t)\d*$/i;
const MARKETING_SUBJECT = /(?:\b\d{1,3}\s?% off\b|\bprice (?:alert|drop)\b|\bsale (?:ends|now on|starts)\b|\bback in stock\b|\byour (?:cart|basket)\b|\blimited[- ]time\b|\bfree (?:shipping|trial|delivery)\b|\bexclusive (?:offer|deal|access)\b|\bdon'?t miss\b|\bdeal of the day\b|\bnewsletter\b|\bwebinar\b|\bnew arrivals?\b|\bwe(?:'|’)ve updated our (?:terms|privacy))/i;
const UNSUBSCRIBE_TEXT = /\b(?:unsubscribe|manage (?:your )?(?:email )?preferences|view (?:this )?(?:email )?in (?:your )?browser|you(?:'|’)re receiving this (?:email|message) because)\b/i;

/** "Name <a@b.com>" or "a@b.com" -> { local, domain } (lower case), or null. */
export function senderParts(from: string | null | undefined): { local: string; domain: string } | null {
  const m = /<?([A-Za-z0-9._%+'-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/.exec(String(from ?? ""));
  return m ? { local: m[1].toLowerCase(), domain: m[2].toLowerCase() } : null;
}

/** Why this is bulk/marketing mail, or null when it looks like a person's message. */
export function bulkReason(m: BulkInput): string | null {
  if (m.hasDraft || m.isReply) return null;
  const labels = m.labelIds ?? [];
  const label = labels.find((l) => GMAIL_BULK_LABELS.has(l));
  if (label) return `Gmail filed it under ${label.replace("CATEGORY_", "").toLowerCase()}.`;
  if (m.listUnsubscribe) return "Sent with an unsubscribe header (bulk or marketing mail).";
  if (/^(?:bulk|list|junk)$/i.test(String(m.precedence ?? "").trim())) return "Marked as bulk mail by the sender.";
  const s = senderParts(m.from);
  if (s) {
    if (ROBOT_LOCAL.test(s.local)) return "Sent from a no-reply or marketing address.";
    const first = s.domain.split(".")[0];
    if (s.domain.split(".").length > 2 && MAILER_SUBDOMAIN.test(first)) return "Sent from a mailing-list subdomain.";
  }
  const subject = String(m.subject ?? "");
  if (MARKETING_SUBJECT.test(subject)) return "The subject reads like a promotion or an alert.";
  if (UNSUBSCRIBE_TEXT.test(String(m.body ?? "").slice(0, 20_000))) return "Contains unsubscribe or bulk-mail wording.";
  return null;
}

export const isBulkMail = (m: BulkInput): boolean => bulkReason(m) !== null;
