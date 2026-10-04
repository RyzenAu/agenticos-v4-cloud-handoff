import { expect, test } from "bun:test";
import { sharedTtlCache } from "./assistant-adapters";

test("sharedTtlCache shares one in-flight build, reuses it within the TTL and rebuilds after or on refresh", async () => {
  let t = 1_000, builds = 0;
  const cache = sharedTtlCache<{ n: number; list: number[] }>(60_000, () => t);
  const build = async () => ({ n: ++builds, list: [1, 2] });
  const [a, b] = await Promise.all([cache("x", build), cache("x", build)]);
  expect(builds).toBe(1);
  expect(a).toEqual(b);
  a.list.push(3); // a caller mutating its copy must not leak into the cache
  expect((await cache("x", build)).list).toEqual([1, 2]);
  expect(builds).toBe(1);
  t += 60_001;
  expect((await cache("x", build)).n).toBe(2);
  expect((await cache("x", build, true)).n).toBe(3);
  expect((await cache("other", build)).n).toBe(4);
});

test("sharedTtlCache does not keep a failed build", async () => {
  let fail = true;
  const cache = sharedTtlCache<number>(60_000);
  const build = async () => { if (fail) throw new Error("down"); return 7; };
  await expect(cache("x", build)).rejects.toThrow("down");
  fail = false;
  expect(await cache("x", build)).toBe(7);
});

// Track 8 / audit F1-07: the plain GET /__operator/models waited 18-29 s whenever the TTL was up.
test("serveStale answers an expired entry at once and rebuilds once in the background", async () => {
  let t = 1_000, builds = 0;
  let release: () => void = () => {};
  const cache = sharedTtlCache<{ n: number }>(60_000, () => t, { serveStale: true });
  const slow = () => new Promise<{ n: number }>((resolve) => { builds++; const n = builds; release = () => resolve({ n }); });
  const first = cache("x", slow); // cold: the first caller waits for the build
  release();
  expect((await first).n).toBe(1);
  t += 60_001; // expired
  const started = performance.now();
  const stale = await cache("x", slow);
  expect(performance.now() - started).toBeLessThan(50); // answered at once, not after the build
  expect(stale.n).toBe(1);
  expect(builds).toBe(2); // one background rebuild started...
  expect((await cache("x", slow)).n).toBe(1); // ...and a second caller doesn't start another
  expect(builds).toBe(2);
  release();
  await Bun.sleep(0);
  expect((await cache("x", slow)).n).toBe(2); // the rebuilt value is served once it lands
});

test("serveStale keeps the last good value when the background rebuild fails; refresh still waits", async () => {
  let t = 0, fail = false, n = 0;
  const cache = sharedTtlCache<number>(1_000, () => t, { serveStale: true });
  const build = async () => { if (fail) throw new Error("probe down"); return ++n; };
  expect(await cache("x", build)).toBe(1);
  t = 5_000; fail = true;
  expect(await cache("x", build)).toBe(1); // stale, rebuild fails in the background
  await Bun.sleep(0);
  expect(await cache("x", build)).toBe(1); // still the last good value
  await expect(cache("x", build, true)).rejects.toThrow("probe down"); // an explicit refresh reports the failure
  fail = false;
  expect(await cache("x", build, true)).toBe(2);
});
