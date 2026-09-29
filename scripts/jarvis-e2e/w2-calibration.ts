/**
 * Jev control-loop calibration from RECORDED outcomes (Wave 2): reads every calibration.json the W2
 * acceptance runs wrote (D:\tmp\jarvis-acceptance\run-w-*\_evidence\) and reports, per confidence band,
 * how often an acted decision's deterministic check passed and how often the task succeeded.
 *
 *   bun --no-env-file scripts/jarvis-e2e/w2-calibration.ts [--json]
 *
 * Only decisions with a check count toward "verified" (done/ask decisions have none). Pure analysis:
 * reads the evidence files, prints a table; never calls a model.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Decision = { task: string; step: number; op: string; confidence: number; policy: string; verified: boolean | null; taskOk: boolean | null; ms: number };
export const BANDS: Array<[number, number]> = [
  [0, 0.4],
  [0.4, 0.6],
  [0.6, 0.75],
  [0.75, 0.9],
  [0.9, 1.0001],
];

export function bandTable(decisions: Decision[]) {
  return BANDS.map(([lo, hi]) => {
    const inBand = decisions.filter((d) => d.confidence >= lo && d.confidence < hi);
    const acted = inBand.filter((d) => d.policy === "act");
    const checked = acted.filter((d) => d.verified !== null);
    const verified = checked.filter((d) => d.verified === true).length;
    const taskKnown = inBand.filter((d) => d.taskOk !== null);
    const taskOk = taskKnown.filter((d) => d.taskOk === true).length;
    return {
      band: `${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}`,
      decisions: inBand.length,
      acted: acted.length,
      checked: checked.length,
      verifiedRate: checked.length ? verified / checked.length : null,
      taskSuccessRate: taskKnown.length ? taskOk / taskKnown.length : null,
      ops: [...new Set(inBand.map((d) => d.op))].join(","),
    };
  });
}

export function loadDecisions(root = String.raw`D:\tmp\jarvis-acceptance`): { decisions: Decision[]; runs: string[] } {
  const runs = existsSync(root) ? readdirSync(root).filter((d) => /^run-w-/.test(d) && existsSync(join(root, d, "_evidence", "calibration.json"))) : [];
  const decisions: Decision[] = [];
  for (const r of runs) {
    try {
      const j = JSON.parse(readFileSync(join(root, r, "_evidence", "calibration.json"), "utf8")) as { decisions?: Decision[] };
      decisions.push(...(j.decisions ?? []));
    } catch {
      // a partial file from an interrupted run is skipped
    }
  }
  return { decisions, runs };
}

if (import.meta.main) {
  const { decisions, runs } = loadDecisions();
  const table = bandTable(decisions);
  const lat = decisions.map((d) => d.ms).sort((a, b) => a - b);
  const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)] : null);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ runs, n: decisions.length, table, latencyMs: { p50: p(0.5), p95: p(0.95) } }, null, 2));
  else {
    console.log(`${decisions.length} Jev decisions from ${runs.length} runs; latency p50 ${p(0.5)} ms, p95 ${p(0.95)} ms`);
    console.log("band        n   acted checked verified%  task%  ops");
    for (const t of table)
      console.log(`${t.band.padEnd(11)} ${String(t.decisions).padStart(3)} ${String(t.acted).padStart(6)} ${String(t.checked).padStart(7)} ${t.verifiedRate === null ? "   -   " : `${(t.verifiedRate * 100).toFixed(0).padStart(5)}% `} ${t.taskSuccessRate === null ? "  -  " : `${(t.taskSuccessRate * 100).toFixed(0).padStart(4)}%`}  ${t.ops}`);
  }
}
