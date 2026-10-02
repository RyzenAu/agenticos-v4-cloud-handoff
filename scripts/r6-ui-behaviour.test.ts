// Runs the rendered/behavioural tests (scripts/r6-behaviour/behaviour.inner.tsx) in their own process: they install a
// fake DOM at import time, which must not leak into any other test file in the same run.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("rendered behaviour: lead editor drafts, Do not contact, Back and ?view=today, Leads polling, Models POST", () => {
  const root = join(import.meta.dir, "..");
  const out = Bun.spawnSync([process.execPath, "test", "./scripts/r6-behaviour/behaviour.inner.tsx"], { cwd: root });
  const text = out.stdout.toString() + out.stderr.toString();
  const pass = Number(text.match(/(\d+) pass/)?.[1] ?? 0);
  if (out.exitCode !== 0) console.log(text.slice(-3000));
  expect(out.exitCode).toBe(0);
  expect(pass).toBeGreaterThanOrEqual(15);
}, 120_000);
