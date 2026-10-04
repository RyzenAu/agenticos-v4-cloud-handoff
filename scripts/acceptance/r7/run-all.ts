#!/usr/bin/env bun
/**
 * Round 7 acceptance: run the synthetic-hub journeys ONE AT A TIME (one browser at a time; other workers run browsers too) and print a tally.
 * The hub must already be up (bun scripts/acceptance/r7/hub.ts reset). journey-l restarts the hub itself and runs last.
 *
 *   bun scripts/acceptance/r7/run-all.ts [--hub http://127.0.0.1:8128] [--only routes-sweep,journey-e-bots] [--label baseline-491b8ee0]
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forwardArgs } from "./hub-env";

const argv = process.argv.slice(2);
const arg = (n: string, d = "") => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] ?? d) : d);
const OUT = arg("out", "D:\\AgenticOS-r7-data\\h-out");
const ORDER = ["routes-sweep", "journey-b-session", "journey-e-bots", "journey-g-crm", "journey-f-coding", "journey-d-stop", "journey-i-vercel", "isolation", "journey-j-routine", "journey-l-restore"];
const only = arg("only") ? arg("only").split(",") : ORDER;
// Every journey gets the same hub, data folder, output folder and served tree as this run. (Before round 8 `--out` was not forwarded: a journey
// wrote its results to the default folder while this tally read the folder it was given, so every tally came back null.)
const pass = forwardArgs(argv);
const summary: Record<string, unknown> = {};
for (const name of ORDER.filter((n) => only.includes(n))) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(import.meta.dir, `${name}.ts`), ...pass], { stdio: "inherit", timeout: 3_600_000 });
  // The newest results file this script wrote in this run (isolation writes results-isolation-<role>.json).
  const file = readdirSync(OUT).filter((f) => f.startsWith(`results-${name}`) && f.endsWith(".json")).map((f) => join(OUT, f)).filter((f) => statSync(f).mtimeMs >= t).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const res = file ? (JSON.parse(readFileSync(file, "utf8")) as { tally: Record<string, number> }) : null;
  summary[name] = { exit: r.status, seconds: Math.round((Date.now() - t) / 1000), tally: res?.tally ?? null };
}
writeFileSync(join(OUT, `summary-${arg("label", "run")}.json`), JSON.stringify({ label: arg("label", "run"), at: new Date().toISOString(), summary }, null, 2));
console.log(JSON.stringify(summary, null, 1));
