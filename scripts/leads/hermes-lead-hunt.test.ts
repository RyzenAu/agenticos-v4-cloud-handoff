// Runs the Hermes lead-hunt wrapper's Python tests (scripts/leads/hermes/test_lead_hunt.py) from
// the bun suite, so `bun test scripts` covers the wrapper too. Skipped only when Python is absent.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const python = ["python", "python3", "py"].find((exe) => spawnSync(exe, ["--version"], { encoding: "utf8" }).status === 0);

test.skipIf(!python)("lead-hunt wrapper: 504 is a timeout, failed nights exit non-zero and alert, stuck suburbs are skipped", () => {
  const run = spawnSync(python!, ["-m", "unittest", "-v", join(import.meta.dir, "hermes", "test_lead_hunt.py")], {
    encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }, timeout: 60_000,
  });
  expect(run.stderr).toContain("OK");
  expect(run.status).toBe(0);
}, 70_000);
