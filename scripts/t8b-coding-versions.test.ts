// Review T8b-F1 and the priming request: the coding harness's CLI version read never rejects, never
// caches a failure (it shows "unknown" and is asked again, at most once a minute), and is started at
// server start rather than by the first /coding/* request.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCliVersions } from "./coding/plugin";

const ok = (value: string) => ({ value, failed: false });
const failed = { value: null, failed: true };

test("a probe that throws (e.g. a synchronous spawn error) resolves to 'unknown' and is not cached", async () => {
  let clock = 0;
  let calls = 0;
  let mode: "throw" | "ok" = "throw";
  const v = createCliVersions({
    now: () => clock,
    probe: async () => {
      calls++;
      if (mode === "throw") throw new Error("spawn EINVAL");
      return [ok("2.1.280"), ok("0.154.0")];
    },
  });
  await v.ready(); // resolves, never rejects
  expect(v.current()).toEqual({ claude: null, codex: null });
  await v.ready(); // failed a moment ago: answered at once, not re-run on every request
  expect(calls).toBe(1);
  clock = 61_000;
  mode = "ok";
  await v.ready(); // a minute later it is asked again
  expect(calls).toBe(2);
  expect(v.current()).toEqual({ claude: "2.1.280", codex: "0.154.0" });
  clock = 10 * 60_000;
  await v.ready(); // a success IS cached
  expect(calls).toBe(2);
});

test("one CLI failing to start keeps the other's version and retries only after the backoff", async () => {
  let clock = 0;
  let calls = 0;
  const v = createCliVersions({ now: () => clock, probe: async () => (calls++, calls === 1 ? [ok("2.1.280"), failed] : [ok("2.1.280"), ok("0.154.0")]) });
  await v.ready();
  expect(v.current()).toEqual({ claude: "2.1.280", codex: null });
  clock = 30_000;
  v.current(); // a read inside the backoff doesn't start another probe
  await v.ready();
  expect(calls).toBe(1);
  clock = 60_001;
  await v.ready();
  expect(v.current()).toEqual({ claude: "2.1.280", codex: "0.154.0" });
});

test("concurrent first requests share one probe", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const v = createCliVersions({ probe: async () => (calls++, await gate, [ok("2.1.280"), ok("0.154.0")]) });
  const all = Promise.all([v.ready(), v.ready(), v.ready()]);
  release();
  await all;
  expect(calls).toBe(1);
});

test("the versions are primed at server start, before any /coding/* request, and a failed spawn isn't cached", () => {
  const plugin = readFileSync(join(import.meta.dir, "coding", "plugin.ts"), "utf8");
  const configure = plugin.slice(plugin.indexOf('name: "agentic-os-coding"'));
  expect(configure.indexOf("void codingCliVersions().ready();")).toBeGreaterThan(-1);
  expect(configure.indexOf("void codingCliVersions().ready();")).toBeLessThan(configure.indexOf("server.middlewares.use("));
  expect(plugin).toContain("if (r.error) return { value: null, failed: true };");
  expect(readFileSync(join(import.meta.dir, "coding", "runners", "claude.ts"), "utf8")).toContain("if (r.error) return null; // couldn't start, or timed out: not cached");
});
