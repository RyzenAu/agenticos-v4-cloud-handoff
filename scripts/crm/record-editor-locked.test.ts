import { expect, test } from "bun:test";
import { join } from "node:path";

// The editor test mocks the router and installs its own DOM, both global in one bun process: run it in its own process so it
// can neither pollute nor be polluted by other test files (the same pattern as scripts/r7-app-usability.test.ts).
test("an unconfirmed caller's Restrictions box is locked and never sent (isolated run)", () => {
  const root = join(import.meta.dir, "..", "..");
  const out = Bun.spawnSync([process.execPath, "test", "./scripts/crm/record-editor-locked.inner.tsx"], { cwd: root, env: process.env });
  const text = out.stdout.toString() + out.stderr.toString();
  if (out.exitCode !== 0) console.log(text.slice(-3000));
  expect(out.exitCode).toBe(0);
  expect(Number(text.match(/(\d+) pass/)?.[1] ?? 0)).toBeGreaterThan(0);
}, 120_000);
