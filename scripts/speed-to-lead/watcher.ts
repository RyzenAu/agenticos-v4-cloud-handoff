// Speed-to-lead: pure detection. Takes rows that already carry nothing but metadata (sender,
// subject, received-at — e.g. from inbox-triage's own log, see run.ts) and picks out the ones
// that are the marketing site's enquiry notifications. Never touches a body, and deliberately
// takes a plain object shape rather than inbox-triage's own TriageRow so a future caller can't
// accidentally widen this to include TriageRow's `summary` field.
import { parseEnquirySubject } from "./subject";

export type MetadataRow = {
  messageId: string;
  senderAddress: string;
  subject: string;
  receivedAt: string;
};

export type DetectedEnquiry = {
  messageId: string;
  ref: string;
  topic: string;
  receivedAt: string;
};

/** "M&U Ventures <enquiries@muventures.com.au>" / "enquiries@muventures.com.au" → the bare,
 *  lower-cased address. Used on both sides of the sender comparison so display-name formatting
 *  never causes a false negative (or, worse, a false positive against the wrong address). */
export function normalizeAddress(value: string): string {
  const match = value.match(/<([^<>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

/**
 * Which of `rows` are a new-enquiry notification from `fromAddress`, with a recognised subject.
 * Anything else — a reply from the visitor, a bounce, an unrelated email that happens to share a
 * sender — is silently skipped. Pure; the caller (run.ts) owns dedupe against what's already in
 * the CRM (openEnquiryStore().upsert is idempotent on ref) and owns sending any alert.
 */
export function detectNewEnquiries(
  rows: MetadataRow[],
  opts: { fromAddress: string },
): DetectedEnquiry[] {
  const from = normalizeAddress(opts.fromAddress);
  if (!from) return [];
  const out: DetectedEnquiry[] = [];
  for (const row of rows) {
    if (normalizeAddress(row.senderAddress) !== from) continue;
    const parsed = parseEnquirySubject(row.subject);
    if (!parsed) continue;
    out.push({
      messageId: row.messageId,
      ref: parsed.ref,
      topic: parsed.topic,
      receivedAt: row.receivedAt,
    });
  }
  return out;
}
