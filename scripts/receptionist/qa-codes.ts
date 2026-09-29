// Production QA codes from MU-Receptionist's QA engine (src/lib/qa/rules.ts, grade.ts), as the
// agency feed carries them: codes only, never evidence text. Labels and caller consequences for the
// codes we know; an unknown code is still shown (humanised), never dropped.

const QA_LABEL: Record<string, string> = {
  BOOKING_CLAIMED_NOT_RECORDED: "Booking claimed, not recorded",
  BOOKING_WRITE_FAILED: "Booking write failed",
  BOOKING_NO_PROVIDER_REF: "Booking without calendar reference",
  TRANSFER_PROMISED_NOT_ATTEMPTED: "Transfer promised, not attempted",
  TRANSFER_FAILED: "Transfer failed",
  TRANSFER_OUTCOME_UNKNOWN: "Transfer outcome unknown",
  HUMAN_REQUEST_UNMET: "Asked for a person, not routed",
  ESCAPE_HATCH_REPEATED: "Asked for a person repeatedly",
  REPEAT_LOOP: "Agent looped",
  FEE_NOT_IN_KB: "Quoted a fee not in the knowledge base",
  FEE_UNCHECKED_NO_KB: "Quoted an unchecked fee",
  FRUSTRATED_HANGUP: "Frustrated hang-up",
  LIFE_SAFETY_NOT_ROUTED: "Life safety, no 000 advice",
  URGENT_NOT_ROUTED: "Urgent, not routed",
  URGENT_BY_MESSAGE_IN_HOURS: "Urgent in hours, message only",
  URGENT_CALL: "Urgent call (review)",
  MEDICATION_MENTIONED: "Medication mentioned",
  INJECTION_ATTEMPT: "Prompt-injection attempt",
  NO_TRANSCRIPT: "No transcript to check",
  KB_UNSUPPORTED_CLAIM: "Claim not in the knowledge base",
  CALLER_FRUSTRATED: "Caller frustrated",
  LOOP_OR_NO_ESCAPE: "Loop or no way out",
  URGENT_POSSIBLE: "Possibly urgent",
};

const QA_CONSEQUENCE: Record<string, string> = {
  BOOKING_CLAIMED_NOT_RECORDED: "may expect a booking that wasn't recorded",
  BOOKING_WRITE_FAILED: "may expect a booking that failed to save",
  TRANSFER_PROMISED_NOT_ATTEMPTED: "was promised a transfer that was never attempted",
  TRANSFER_FAILED: "was not connected when transferred",
  HUMAN_REQUEST_UNMET: "asked for a person and was neither transferred nor offered a message",
  LIFE_SAFETY_NOT_ROUTED: "used life-safety language and wasn't given 000 advice",
  URGENT_NOT_ROUTED: "raised something urgent that wasn't routed",
  URGENT_BY_MESSAGE_IN_HOURS: "raised something urgent in hours and only got a message",
  URGENT_CALL: "made an urgent call that needs human review",
  MEDICATION_MENTIONED: "may have heard medication advice",
  FEE_NOT_IN_KB: "may have been quoted a wrong fee",
};

/** "TRANSFER_PROMISED_NOT_ATTEMPTED" -> "Transfer promised, not attempted"; unknown codes humanised. */
export function qaLabel(code: string): string {
  return QA_LABEL[code] ?? code.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** Caller consequences for the QA codes that have one; a code without one adds nothing. */
export function qaConsequenceParts(codes: readonly string[]): string[] {
  return codes.flatMap((c) => (QA_CONSEQUENCE[c] ? [QA_CONSEQUENCE[c]] : []));
}

/** The QA engine's highest band ("FLAG"); older fixtures and contracts said "CRITICAL". */
export const isCriticalBand = (band: string | null | undefined) => !!band && /^(FLAG|CRITICAL)$/i.test(band);
/** A review is open until the QA engine records it REVIEWED (NOT_QUEUED / PENDING / unreported are open). */
export const isOpenReview = (status: string | null | undefined) => !status || !/^(REVIEWED|RESOLVED)$/i.test(status);
