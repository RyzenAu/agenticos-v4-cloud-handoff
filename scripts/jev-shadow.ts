/**
 * Shared Jev shadow-mode recorder (MINISTRY-JEV-BUSINESS.md, 25 Sep 2026): one common private
 * decision record for every new Jev use case, instead of five bespoke evaluators. Mirrors the
 * labelled-case -> raw-answer capture -> offline rescore pattern already proven by jev-bench.ts,
 * the guardian's 12-command calibration and screen-hands' 20-phrase calibration.
 *
 * Recording a shadow entry is purely observational: nothing here ever reaches display, ranking,
 * a hold, the CRM or publication on its own, and a failure to record must never break the real
 * (unchanged) result the caller already produced — see the try/catch in recordDecisionShadow.
 *
 * Only sanitised fixtures belong in docs/jev-bench/; real mail/transcripts/contact records stay
 * private under .operator-data/jev-shadow/, which this file is the only writer of.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The one shared record shape from the Ministry report's "shared shadow-mode method". */
export type ShadowRecord<TDecision = unknown, TAnswers = unknown> = {
  caseId: string;
  useCase: string;
  timestamp: string;
  /** A hash of the real input, never the input itself — see hashInput(). */
  inputHash: string;
  /** An opaque pointer back to the source (a lead id, a thread ref) when one exists and is safe
   *  to keep; omit rather than store anything sensitive. */
  inputRef?: string;
  questionVersion: string;
  model: string;
  baselineDecision: TDecision;
  proposedDecision: TDecision;
  rawAnswers: TAnswers;
  elapsedMs: number;
  usage?: { promptTokens?: number; completionTokens?: number } | null;
  error?: string | null;
  humanLabel?: TDecision | null;
  reviewer?: string | null;
  policyVersion: string;
};

export function shadowDir(root: string): string {
  return join(root, ".operator-data", "jev-shadow");
}

/** A short, stable, irreversible fingerprint of an input — never the input itself. */
export function hashInput(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Appends one record to `useCase`'s shared shadow log. Best-effort and silent on failure: a
 * logging problem (disk full, bad permissions) must never surface as a failure of the real
 * decision path that called it, and never throws back into a hot path like meeting mode's audio
 * handler.
 */
export function recordDecisionShadow<TDecision = unknown, TAnswers = unknown>(root: string, record: ShadowRecord<TDecision, TAnswers>): void {
  try {
    const dir = shadowDir(root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeUseCase = record.useCase.replace(/[^a-z0-9-]/gi, "-");
    appendFileSync(join(dir, `${safeUseCase}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    /* shadow logging is observational only; never break the caller over it */
  }
}

/** Reads back every shadow record for a use case (oldest first), for offline rescoring. */
export function readShadow<TDecision = unknown, TAnswers = unknown>(root: string, useCase: string): ShadowRecord<TDecision, TAnswers>[] {
  const safeUseCase = useCase.replace(/[^a-z0-9-]/gi, "-");
  const file = join(shadowDir(root), `${safeUseCase}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ShadowRecord<TDecision, TAnswers>);
}
