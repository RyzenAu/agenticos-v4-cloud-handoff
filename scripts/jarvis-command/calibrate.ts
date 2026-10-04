#!/usr/bin/env bun
/**
 * Recalibrate Jev's command thresholds from LOGGED outcomes (TARGET-ARCHITECTURE §3.4): the job store's
 * voice/command jobs hold every Jev decision (a step with a `jev` ref) and the checks after the action
 * (a step's `verification`). Read-only: opens the store read-only, prints a report, changes nothing.
 *
 *   bun scripts/jarvis-command/calibrate.ts [--jobs .operator-data/jobs.sqlite] [--surface command.voice]
 *
 * A proposal is only a proposal: thresholds are code-reviewed (thresholds.ts) with the run id printed here.
 */
import { resolve } from "node:path";
import type { Job } from "../jobs/types";
import { calibrate, DEFAULT_THRESHOLDS, type LoggedDecision } from "./thresholds";

/**
 * One row per job whose route came from Jev and that then ACTED and was checked. Asks, refusals,
 * delegations and unchecked actions are not outcomes of a Jev act, so they don't count (REVIEW-JEV §3:
 * an ask is not a task success). Pure.
 */
export function rowsFromJobs(jobs: Job[]): LoggedDecision[] {
  const rows: LoggedDecision[] = [];
  for (const job of jobs) {
    if (job.kind !== "voice" && job.kind !== "command") continue;
    const jevStep = job.steps.find((s) => s.jev && /^route: Jev/.test(s.intent));
    const decision = job.steps.find((s) => s.jev && /^decision: /.test(s.intent));
    if (!jevStep?.jev || !decision?.jev || decision.jev.policy !== "act") continue;
    const checks = job.steps.filter((s) => s.verification && s.verification.ok !== null);
    if (!checks.length || job.state === "cancelled" || job.state === "interrupted") continue;
    const verified = job.state === "succeeded" && checks.every((s) => s.verification!.ok === true);
    rows.push({ surface: job.kind === "voice" ? "command.voice" : "command.typed", verified, decision: { confidence: jevStep.jev.confidence, source: "jev", policy: "act" } });
  }
  return rows;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const path = resolve(flag("--jobs") ?? ".operator-data/jobs.sqlite");
  const surface = flag("--surface") ?? "command.voice";
  const { JobService } = await import("../jobs/service");
  const store = new JobService({ path, readOnly: true });
  // The store lists at most 200 per query (newest first): the latest 200 of each command kind.
  const jobs = [...store.list({ kind: "voice", limit: 200 }), ...store.list({ kind: "command", limit: 200 })].map((s) => store.get(s.id)).filter((j): j is Job => !!j);
  const report = calibrate(rowsFromJobs(jobs), surface, DEFAULT_THRESHOLDS[surface] ?? DEFAULT_THRESHOLDS["command.voice"]);
  console.log(JSON.stringify(report, null, 2));
}
