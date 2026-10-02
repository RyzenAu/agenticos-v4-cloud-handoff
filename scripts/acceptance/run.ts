#!/usr/bin/env bun
/**
 * The acceptance runner: one command runs the twelve outcome-based tasks and writes
 *   docs/programme-20261001/ACCEPTANCE-RESULTS.md  and  ACCEPTANCE-RESULTS.json
 *
 *   bun scripts/acceptance/run.ts [--only 1,6,9] [--quick] [--out <path without extension>] [--keep-scratch]
 *
 * What it does per task (see tasks.ts): set up synthetic fixtures, run the probes that can run on this PC now, re-read
 * earlier REAL evidence artefacts and re-evaluate them, and let an evaluator read the OBSERVED state. A task that can't run
 * says exactly what blocks it. Cleanup removes only what this run created (its own scratch folder, the hub and companion
 * processes it started, the one presentation it opened), last-in first-out, even after a failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixtures } from "./fixtures";
import { ROOT, rmScratch } from "./probes";
import { TASKS } from "./tasks";
import { LABELS, type Ctx, type TaskResult } from "./types";

const argv = process.argv.slice(2);
const opt = (n: string, d = "") => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const only = opt("only") ? new Set(opt("only").split(",").map(Number)) : null;
const quick = argv.includes("--quick");
const keep = argv.includes("--keep-scratch");
const outBase = resolve(ROOT, opt("out", join("docs", "programme-20261001", "ACCEPTANCE-RESULTS")));

const run = Math.random().toString(16).slice(2, 8);
const scratch = join(process.env.ACCEPT_SCRATCH ?? "D:\\prog-scratch", `acceptance-${run}`);
mkdirSync(scratch, { recursive: true });
const fixtures = makeFixtures(join(scratch, "fixtures"), run);
const cleanups: { name: string; fn: () => void | Promise<void> }[] = [];
const cleanupLog: string[] = [];
const ctx: Ctx = {
  scratch, run, fixtures, root: ROOT, quick,
  onCleanup: (name, fn) => void cleanups.push({ name, fn }),
  log: (l) => console.log(`  ${l}`),
};

const git = (...a: string[]) => spawnSync("git", ["-C", ROOT, ...a], { encoding: "utf8", windowsHide: true }).stdout.trim();

// A dropped connection to a process this run is killing on purpose must never take the runner (and its cleanup) down.
process.on("unhandledRejection", (e) => console.log(`  (ignored unhandled rejection: ${String((e as Error)?.message ?? e).slice(0, 120)})`));

async function main() {
  const results: TaskResult[] = [];
  const started = new Date();
  for (const t of TASKS) {
    if (only && !only.has(t.config.id)) continue;
    const t0 = Date.now();
    console.log(`[${t.config.id}] ${t.config.title}`);
    let r: Omit<TaskResult, "id" | "key" | "title" | "ms">;
    try {
      r = await t.run(ctx);
    } catch (e) {
      r = { status: "blocked", bestLabel: null, probes: [], blocker: `the task threw before it could observe anything: ${String((e as Error).message).slice(0, 300)}` };
    }
    const res: TaskResult = { id: t.config.id, key: t.config.key, title: t.config.title, ms: Date.now() - t0, ...r };
    results.push(res);
    console.log(`    -> ${res.status}${res.bestLabel ? ` (${res.bestLabel})` : ""}${res.blocker ? `  | ${res.blocker.slice(0, 140)}` : ""}`);
  }
  for (const c of cleanups.reverse()) {
    try { await c.fn(); cleanupLog.push(`removed: ${c.name}`); } catch (e) { cleanupLog.push(`FAILED to remove ${c.name}: ${String((e as Error).message).slice(0, 120)}`); }
  }
  if (!keep) cleanupLog.push((await rmScratch(scratch)) ? `removed: scratch folder ${scratch}` : `LEFT BEHIND (a handle is still held): scratch folder ${scratch}; delete it by hand`);

  const summary = { pass: 0, partial: 0, fail: 0, blocked: 0, owed: 0 } as Record<string, number>;
  for (const r of results) summary[r.status]++;
  const byLabel = Object.fromEntries(LABELS.map((l) => [l, results.filter((r) => r.probes.some((p) => p.label === l && p.checks.length && p.checks.every((c) => c.ok))).map((r) => r.id)]));
  const doc = { run, at: started.toISOString(), commit: git("rev-parse", "--short", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), machine: "this PC (Windows 11; WSL2 distro for the shared computers)", quick, summary, byLabel, cleanup: cleanupLog, tasks: results };
  mkdirSync(resolve(outBase, ".."), { recursive: true });
  writeFileSync(`${outBase}.json`, JSON.stringify(doc, null, 2) + "\n");
  writeFileSync(`${outBase}.md`, markdown(doc, results));
  console.log(JSON.stringify({ summary, json: `${outBase}.json`, md: `${outBase}.md` }));
  process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
}

function markdown(doc: any, results: TaskResult[]): string {
  const icon: Record<string, string> = { pass: "PASS", partial: "PARTIAL", fail: "FAIL", blocked: "BLOCKED", owed: "OWED" };
  const lines: string[] = [];
  lines.push("# Acceptance results (outcome-based)", "");
  lines.push(`Run ${doc.run} on ${doc.at} at commit \`${doc.commit}\` (${doc.branch}), ${doc.machine}${doc.quick ? ", quick mode" : ""}.`, "");
  lines.push("Adapted from OSWorld's idea (see REFERENCE-ADOPTION.md): each task is data (instruction, initial state, evaluator), and every check reads the OBSERVED state of the application, file, ledger or receipt. An agent's or driver's own \"done\" is never evidence. Fixtures are synthetic (`SYNTHETIC-ACCEPT-*`): no real lead, client or number.", "");
  lines.push(`**${doc.summary.pass} pass, ${doc.summary.partial} partial, ${doc.summary.fail} fail, ${doc.summary.blocked} blocked, ${doc.summary.owed} owed.**`, "");
  lines.push("Status meaning: PASS = all probes passed and at least one is a REAL run (what is still unproven is in the last column). PARTIAL = passed only at a mocked/synthetic level; the real run is blocked. BLOCKED = nothing could run. OWED = evaluator ready, needs the owner. FAIL = observed state was wrong.", "");
  lines.push("| # | Task | Status | Strongest passing label | Fresh or earlier | What is still not proven / the exact blocker |", "|---|---|---|---|---|---|");
  for (const r of results) {
    const best = r.probes.filter((p) => p.label === r.bestLabel && p.checks.every((c) => c.ok));
    const fresh = best.length ? (best.some((p) => p.freshness === "run-now") ? "run now" : `earlier evidence (${best[0].evidenceAt?.slice(0, 16).replace("T", " ")})`) : "-";
    lines.push(`| ${r.id} | ${r.title} | ${icon[r.status]} | ${r.bestLabel ?? "-"} | ${fresh} | ${(r.blocker ?? "").replace(/\|/g, "/")} |`);
  }
  lines.push("", "## Labels", "");
  lines.push("| Label | Tasks with a passing probe at this label |", "|---|---|");
  for (const l of LABELS) lines.push(`| ${l} | ${doc.byLabel[l].join(", ") || "none"} |`);
  lines.push("", "`real-cloud-vm` is empty by nature: no cloud VM exists yet. `real-remote-device` needs the other founder's own PC.", "");
  lines.push("## Per task", "");
  for (const r of results) {
    lines.push(`### ${r.id}. ${r.title}: ${icon[r.status]}`, "");
    if (r.blocker) lines.push(`Blocker / not proven: ${r.blocker}`, "");
    if (!r.probes.length) lines.push("No probe ran.", "");
    for (const p of r.probes) {
      lines.push(`- **${p.label}**, ${p.freshness === "run-now" ? "run now" : `earlier evidence written ${p.evidenceAt}`}: ${p.source}`);
      for (const c of p.checks) lines.push(`  - ${c.ok ? "ok" : "**FAILED**"}: ${c.name}${c.ok ? "" : ` (observed: ${JSON.stringify(c.observed).slice(0, 300)})`}`);
      for (const n of p.notes ?? []) lines.push(`  - note: ${n}`);
    }
    lines.push("");
  }
  lines.push("## Cleanup", "", ...doc.cleanup.map((c: string) => `- ${c}`), "", "Cleanup touches only what this run created: its scratch folder, the isolated hub and companion it started, and the one presentation it opened (closed by its unique title). Nothing of the owner's, the live 8081 server, the WSL computers of another run, or any other presentation is touched.", "");
  lines.push("## Re-run", "", "```", "bun scripts/acceptance/run.ts            # all twelve", "bun scripts/acceptance/run.ts --only 9   # one task", "```", "");
  return lines.join("\n");
}

void main().catch((e) => { console.error("acceptance runner failed:", (e as Error).message); process.exitCode = 2; });
