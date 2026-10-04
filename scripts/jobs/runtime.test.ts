import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeJobsRuntime, jobsRuntime, storePaths } from "./runtime";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "b2-runtime-"));
});
afterEach(() => {
  closeJobsRuntime(root);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* WAL */
  }
});

test("the owner creates both stores under .operator-data and recovers once; the instance is shared", () => {
  const a = jobsRuntime(root, { owner: true });
  expect(jobsRuntime(root)).toBe(a);
  expect(storePaths(root).jobs).toBe(join(root, ".operator-data", "jobs.sqlite"));
  expect(a.recovered.jobs).toEqual({ unknown: 0, interrupted: 0 });
  const job = a.jobs.create({ kind: "voice", principal: { personId: "usman", via: "loopback-owner" }, targetDeviceId: "usman-pc", title: "x" });
  a.jobs.begin(job.id);
  closeJobsRuntime(root);
  // Next start: the running job's outcome is unknown and it is not re-run.
  const b = jobsRuntime(root, { owner: true });
  expect(b.recovered.jobs).toEqual({ unknown: 1, interrupted: 0 });
  expect(b.jobs.get(job.id)!.state).toBe("unknown");
});

test("a quiet second server opens read-only, never recovers, and refuses when nothing exists yet", () => {
  expect(() => jobsRuntime(root, { owner: false })).toThrow();
  jobsRuntime(root, { owner: true });
  closeJobsRuntime(root);
  const quiet = jobsRuntime(root, { owner: false });
  expect(quiet.recovered).toEqual({ approvals: null, jobs: null });
  expect(quiet.jobs.list()).toEqual([]);
  expect(() => quiet.jobs.create({ kind: "voice", principal: { personId: "usman", via: "loopback-owner" }, targetDeviceId: "usman-pc", title: "x" })).toThrow();
});
