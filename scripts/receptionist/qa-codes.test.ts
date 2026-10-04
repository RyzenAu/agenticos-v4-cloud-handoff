import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { KNOWN_QA_CODES, qaLabel } from "./qa-codes";

// QaFlagCode union in MU-Receptionist src/lib/qa/rules.ts (read-only reference, 1 Oct 2026), plus the
// Jev flag code in grade.ts. Kept literal so the test runs without the other repo.
const RECEPTIONIST_CODES = [
  "BOOKING_CLAIMED_NOT_RECORDED", "BOOKING_WRITE_FAILED", "BOOKING_NO_PROVIDER_REF",
  "TRANSFER_PROMISED_NOT_ATTEMPTED", "TRANSFER_FAILED", "TRANSFER_OUTCOME_UNKNOWN",
  "HUMAN_REQUEST_UNMET", "ESCAPE_HATCH_REPEATED", "REPEAT_LOOP", "FEE_NOT_IN_KB", "FEE_UNCHECKED_NO_KB",
  "FRUSTRATED_HANGUP", "LIFE_SAFETY_NOT_ROUTED", "URGENT_NOT_ROUTED", "URGENT_BY_MESSAGE_IN_HOURS", "URGENT_CALL",
  "MEDICATION_MENTIONED", "INJECTION_ATTEMPT", "NO_TRANSCRIPT",
  "KB_UNSUPPORTED_CLAIM", "CALLER_FRUSTRATED", "LOOP_OR_NO_ESCAPE", "URGENT_POSSIBLE", "MANIPULATION_SUSPECTED",
];

test("every receptionist QA flag code has an OS label", () => {
  for (const c of RECEPTIONIST_CODES) expect(KNOWN_QA_CODES).toContain(c);
  expect(qaLabel("MANIPULATION_SUSPECTED")).not.toBe("Manipulation suspected");
});

test("when the receptionist worktree is present, its QaFlagCode union matches", () => {
  const f = "D:/MU-Receptionist-wt-prog-20261001/src/lib/qa/rules.ts";
  if (!existsSync(f)) return;
  const src = readFileSync(f, "utf8");
  const union = src.slice(src.indexOf("export type QaFlagCode"), src.indexOf("export type QaSeverity"));
  const codes = [...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  expect(codes.length).toBeGreaterThan(15);
  for (const c of codes) expect(KNOWN_QA_CODES).toContain(c);
});
