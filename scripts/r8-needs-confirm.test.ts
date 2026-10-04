import { expect, test } from "bun:test";
import { join } from "node:path";

// Mocks @tanstack/react-router for its components; module mocks are process-global in bun, so it runs in its own process.
test("needs-confirm handling (isolated run)", () => {
  const root = join(import.meta.dir, "..");
  const out = Bun.spawnSync([process.execPath, "test", "./scripts/r8-needs-confirm.inner.tsx"], { cwd: root, env: process.env });
  const text = out.stdout.toString() + out.stderr.toString();
  if (out.exitCode !== 0) console.log(text.slice(-3000));
  expect(out.exitCode).toBe(0);
  expect(Number(text.match(/(\d+) pass/)?.[1] ?? 0)).toBeGreaterThan(0);
}, 120_000);
