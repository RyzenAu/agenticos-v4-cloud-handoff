/**
 * Jev's per-surface thresholds (TARGET-ARCHITECTURE §3.4): stored WITH the calibration run that set
 * them, recalibrated from logged outcomes, never permission. The owner never manages these (V7).
 *
 * Today's values are the inherited W2 ones (act ≥ 0.60, look again once in 0.40–0.60, else ask).
 * REVIEW-JEV finding 4: the W2 sample (70 decisions, 2 failed checks, 0 in the look-again band) can't
 * validate or tune them, so their run id says exactly that. `calibrate()` reads logged decisions and
 * their verified outcomes (the job store's steps) and proposes new values only when every band it
 * relies on has enough evidence; otherwise it keeps the current set and says why.
 */
import { createHash } from "node:crypto";
import type { JevDecision, SurfaceThresholds } from "./contracts";

export const INHERITED_RUN = "w2-inherited-20260927";

export const DEFAULT_THRESHOLDS: Record<string, SurfaceThresholds> = {
  "command.voice": { surface: "command.voice", act: 0.6, lookAgain: 0.4, calibrationRunId: INHERITED_RUN, note: "Inherited W2 values; not statistically validated (REVIEW-JEV §3). Recalibrate from logged outcomes." },
  "command.typed": { surface: "command.typed", act: 0.6, lookAgain: 0.4, calibrationRunId: INHERITED_RUN, note: "Same as voice until typed outcomes are logged." },
};

export function thresholdsFor(source: string, table: Record<string, SurfaceThresholds> = DEFAULT_THRESHOLDS): SurfaceThresholds {
  return table[source === "typed" ? "command.typed" : "command.voice"] ?? DEFAULT_THRESHOLDS["command.voice"];
}

/** act / look-again / ask for a Jev confidence on a surface. Pure. */
export function policyFor(confidence: number, t: SurfaceThresholds): "act" | "look-again" | "ask" {
  if (confidence >= t.act) return "act";
  if (confidence >= t.lookAgain) return "look-again";
  return "ask";
}

/** Wilson score interval lower bound (95%). Pure. */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

export type LoggedDecision = { decision: Pick<JevDecision, "confidence" | "source" | "policy">; verified: boolean | null; surface: string };
export type Band = { from: number; to: number; n: number; verified: number; failed: number; lower: number };
export type CalibrationReport = {
  runId: string;
  surface: string;
  sample: number;
  bands: Band[];
  proposed: SurfaceThresholds;
  changed: boolean;
  reason: string;
};

const BANDS: Array<[number, number]> = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0001]];
const MIN_PER_BAND = 30;
const TARGET_LOWER = 0.9;

/**
 * Recalibrate one surface from logged Jev decisions (only `source: "jev"` rows that ACTED and were then
 * checked). The act threshold becomes the lowest band edge from which every band upward has ≥30
 * checked outcomes and a Wilson lower bound ≥ 0.90. Not enough evidence → no change, stated. Pure.
 */
export function calibrate(rows: LoggedDecision[], surface: string, current: SurfaceThresholds): CalibrationReport {
  const acted = rows.filter((r) => r.surface === surface && r.decision.source === "jev" && r.decision.policy === "act" && r.verified !== null);
  const bands: Band[] = BANDS.map(([from, to]) => {
    const inBand = acted.filter((r) => r.decision.confidence >= from && r.decision.confidence < to);
    const verified = inBand.filter((r) => r.verified === true).length;
    return { from, to: Math.min(to, 1), n: inBand.length, verified, failed: inBand.length - verified, lower: wilsonLower(verified, inBand.length) };
  });
  const runId = `cal-${surface}-${createHash("sha256").update(JSON.stringify(bands)).digest("hex").slice(0, 12)}`;
  let act: number | null = null;
  for (let i = bands.length - 1; i >= 0; i--) {
    const b = bands[i];
    if (b.n < MIN_PER_BAND || b.lower < TARGET_LOWER) break;
    act = b.from;
  }
  if (act === null || act === 0)
    return { runId, surface, sample: acted.length, bands, proposed: current, changed: false, reason: `Not enough checked outcomes (need ≥${MIN_PER_BAND} per band with a 95% lower bound ≥ ${TARGET_LOWER}); keeping ${current.calibrationRunId}.` };
  const proposed: SurfaceThresholds = { surface, act, lookAgain: Math.max(0, act - 0.2), calibrationRunId: runId, note: `From ${acted.length} checked Jev actions; every band ≥ ${act} has n ≥ ${MIN_PER_BAND} and a 95% lower bound ≥ ${TARGET_LOWER}.` };
  return { runId, surface, sample: acted.length, bands, proposed, changed: proposed.act !== current.act, reason: proposed.note };
}
