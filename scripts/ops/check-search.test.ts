import { expect, test } from "bun:test";
import { join } from "node:path";

const script = join(import.meta.dir, "check-search.ts");

// Runs the real script against a port nothing listens on: it must FAIL plainly (exit 1, a "do this" line, RESULT: FAIL), never pass and never hang.
test("check-search fails plainly when SearXNG is not there, and says what to do", async () => {
  const proc = Bun.spawn(["bun", script, "--no-wsl"], { env: { ...process.env, MU_SEARXNG_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(code).toBe(1);
  expect(out).toContain("PASS  environments");
  expect(out).toMatch(/FAIL\s+searxng health\s+http:\/\/127\.0\.0\.1:1 is not reachable/);
  expect(out).toMatch(/FAIL\s+search\s+unavailable: SearXNG is not running or not reachable/);
  expect(out).toMatch(/FAIL\s+lead discovery\s+its search step could not search/);
  expect(out).toContain("do this:");
  expect(out).toContain("RESULT: FAIL (3 of 5 checks)");
}, 60_000);
