#!/usr/bin/env bun
/**
 * Shadow evaluation for candidate #2 (MINISTRY-JEV-BUSINESS.md): replays the synthetic dialogue
 * fixtures (objection-fixtures.ts — 16 invented cases, never a real recording) through the live
 * classifyObjectionCues() and reports tag-level precision/recall and latency, following the same
 * labelled-case -> raw-answer capture -> offline rescore pattern as jev-bench.ts. Every call is
 * also appended to the shared shadow log (jev-shadow.ts, use case "meeting-cues") with the
 * fixture's own label attached, so a later policy change can be rescored offline without calling
 * Jev again.
 *
 *   bun scripts/meeting-mode/objection-bench.ts [--label <name>]
 *
 * Needs TYPESAFE_API_KEY or JEV_API_KEY configured (see provider-config.ts); costs a few cents.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JEV_MODEL } from "../jev-client";
import { hashInput, recordDecisionShadow } from "../jev-shadow";
import { providerKey } from "../provider-config";
import { classifyObjectionCues, type ClassifyResult } from "./objection-jev";
import { OBJECTION_FIXTURES, type ObjectionFixture } from "./objection-fixtures";

const root = join(import.meta.dir, "..", "..");

type Row = {
  fixture: ObjectionFixture;
  result: ClassifyResult | null;
  ms: number;
  correctAbstain: boolean | null; // null when the fixture wasn't supposed to abstain
};

function precisionRecall(rows: Row[]) {
  // Tag-level, over the prospect-attributed rows only (a non-prospect row is scored as a
  // separate abstention check below, not folded into precision/recall).
  const scored = rows.filter((r) => r.fixture.speaker === "prospect");
  let tp = 0, fp = 0, fn = 0;
  for (const r of scored) {
    const predicted = new Set(r.result?.suggestedTags ?? []);
    const expected = new Set(r.fixture.expectedTags);
    for (const tag of predicted) (expected.has(tag) ? tp++ : fp++);
    for (const tag of expected) if (!predicted.has(tag)) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return { tp, fp, fn, precision, recall };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const label = flag("label") ?? `meeting-cues-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
  const key = providerKey(root, "TYPESAFE_API_KEY") || providerKey(root, "JEV_API_KEY");
  if (!key) throw new Error("No TYPESAFE_API_KEY/JEV_API_KEY configured.");

  const rows: Row[] = [];
  for (const fixture of OBJECTION_FIXTURES) {
    const started = Date.now();
    const result = await classifyObjectionCues(
      { sessionId: "bench", chunkId: fixture.id, capturedAt: new Date().toISOString(), speaker: fixture.speaker, text: fixture.text, previousChunkText: fixture.previousChunkText },
      { key },
    );
    const ms = Date.now() - started;
    const correctAbstain = fixture.speaker === "prospect" ? null : result === null;
    rows.push({ fixture, result, ms, correctAbstain });
    recordDecisionShadow(root, {
      caseId: fixture.id, useCase: "meeting-cues", timestamp: new Date().toISOString(), inputHash: hashInput(fixture.text),
      questionVersion: "objection-cues-v1", model: JEV_MODEL, baselineDecision: fixture.expectedTags,
      proposedDecision: result?.suggestedTags ?? null, rawAnswers: result?.answers ?? null, elapsedMs: result?.ms ?? ms,
      humanLabel: fixture.expectedTags, reviewer: "synthetic-fixture", policyVersion: "meeting-cues-v1",
      error: fixture.speaker !== "prospect" && result !== null ? "expected-abstain-but-answered" : null,
    });
    const got = result ? result.suggestedTags.join(",") || "(none)" : "(abstained)";
    const want = fixture.speaker !== "prospect" ? "(must abstain)" : fixture.expectedTags.join(",") || "(none)";
    console.log(`${String(ms).padStart(5)} ms  ${fixture.id.padEnd(28)} got: ${got.padEnd(24)} want: ${want}`);
  }

  const { precision, recall, tp, fp, fn } = precisionRecall(rows);
  const abstainChecks = rows.filter((r) => r.correctAbstain !== null);
  const abstainCorrect = abstainChecks.filter((r) => r.correctAbstain).length;
  const latencies = rows.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];

  const summary = [
    `Tag-level: precision ${(precision * 100).toFixed(0)}% (tp=${tp} fp=${fp}), recall ${(recall * 100).toFixed(0)}% (fn=${fn})`,
    `Non-prospect abstention: ${abstainCorrect}/${abstainChecks.length} correctly abstained (founder's own words / unknown speaker)`,
    `Latency: p50 ${p50} ms, p95 ${p95} ms (Ministry's cutover bar: p95 < 1000 ms)`,
  ].join("\n");
  console.log(`\n${summary}`);

  const directory = join(root, "docs", "jev-bench");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${label}.json`);
  writeFileSync(file, JSON.stringify({ label, at: new Date().toISOString(), summary, rows }, null, 2));
  console.log(`\nSaved ${file}`);
}

if (import.meta.main) await main();
