// Speed-to-lead: the one contract between muv-marketing's enquiry route
// (src/app/api/enquiry/route.ts, a sibling repo) and this watcher.
//
// The watcher (watcher.ts / run.ts) is only ever allowed to look at email METADATA — sender,
// subject, received-at — never a body (see docs/SPEED-TO-LEAD.md and AGENT-RULES.md). That means
// anything it needs to know about a given enquiry — which one it is, and what it's about — has to
// live in the Subject line of the internal notification email M&U already sends itself for every
// enquiry. This file defines that line's shape and parses it back out.
//
// Keep PREFIX and the regex byte-for-byte in sync with muv-marketing's
// buildInternalSubject()/ENQUIRY_SUBJECT_PREFIX (src/app/api/enquiry/route.ts). Neither repo can
// import the other, so this is a documented convention, not a shared module — a mismatch here
// only ever fails closed (nothing detected), never open.
export const ENQUIRY_SUBJECT_PREFIX = "[M&U enquiry]";

// "[M&U enquiry] <topic> · ref:<ref>" — anything after the ref (e.g. a name, for the human
// reading the real inbox) is ignored on purpose; the watcher never needs it and never keeps it.
const SUBJECT_RE = /^\[M&U enquiry\]\s+(.+?)\s+·\s+ref:([a-z0-9]{6,12})\b/i;

export type ParsedEnquirySubject = { topic: string; ref: string };

/**
 * Recognises the marketing route's subject pattern and pulls out the topic and a short dedupe
 * ref. Returns null for anything else — a reply, a forward, spam, or anything a person typed by
 * hand — so nothing but the route's own machine-generated line is ever picked up.
 */
export function parseEnquirySubject(subject: string): ParsedEnquirySubject | null {
  const match = SUBJECT_RE.exec(subject.trim());
  if (!match) return null;
  const topic = match[1].trim().slice(0, 120);
  const ref = match[2].toLowerCase();
  return topic && ref ? { topic, ref } : null;
}
