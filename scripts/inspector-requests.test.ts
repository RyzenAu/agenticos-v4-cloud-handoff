import { expect, test } from "bun:test";
import {
  EARLY_REQUEST_TIMING_SCRIPT,
  isCachedTiming,
  localRequestRows,
  requestTimingLabel,
  sortRequestRows,
} from "../src/components/shell/inspector";

const ORIGIN = "http://127.0.0.1:8190";
const entry = (name: string, o: Partial<{ duration: number; startTime: number; transferSize: number; decodedBodySize: number; responseStatus: number; deliveryType: string }> = {}) => ({
  name,
  duration: 120,
  startTime: 10,
  transferSize: 900,
  decodedBodySize: 600,
  ...o,
});

test("keeps only this origin's /__* requests, drops Vite modules and other hosts, dedupes", () => {
  const vite = Array.from({ length: 300 }, (_, i) => entry(`${ORIGIN}/src/components/c${i}.tsx`, { startTime: i }));
  const api = entry(`${ORIGIN}/__workspace/today?x=1`, { startTime: 400 });
  const rows = localRequestRows(
    [...vite, api, api, entry("https://fonts.googleapis.com/__x"), entry(`${ORIGIN}/__operator/state`, { startTime: 401, responseStatus: 500 })],
    ORIGIN,
  );
  expect(rows.map((r) => r.name)).toEqual(["/__workspace/today", "/__operator/state"]);
  expect(rows[0]).toMatchObject({ ms: 120, cached: false, kb: 0.9, status: null, start: 400 });
  expect(rows[1].status).toBe(500);
});

test("cache hits are labelled cached, not a measured 0 ms", () => {
  expect(isCachedTiming({ transferSize: 0, decodedBodySize: 512, duration: 0.2 })).toBe(true);
  expect(isCachedTiming({ transferSize: 0, decodedBodySize: 0, duration: 0 })).toBe(true);
  expect(isCachedTiming({ transferSize: 0, decodedBodySize: 0, duration: 3, deliveryType: "cache" })).toBe(true);
  // A 304 revalidation still crossed the network (Chrome reports it as deliveryType "cache" with
  // header bytes transferred): its duration is a real round trip.
  expect(isCachedTiming({ transferSize: 300, decodedBodySize: 512, duration: 4, deliveryType: "cache" })).toBe(false);
  expect(isCachedTiming({ transferSize: 300, decodedBodySize: 512, duration: 4 })).toBe(false);
  // A failed request moved nothing but took real time: measured, not cached.
  expect(isCachedTiming({ transferSize: 0, decodedBodySize: 0, duration: 250 })).toBe(false);
  const [cached] = localRequestRows([entry(`${ORIGIN}/__devices/me`, { transferSize: 0, duration: 0 })], ORIGIN);
  expect(cached).toMatchObject({ cached: true, ms: null, kb: null });
  expect(requestTimingLabel(cached)).toBe("cached");
  expect(requestTimingLabel({ cached: false, ms: 0 })).toBe("<1");
  expect(requestTimingLabel({ cached: false, ms: 42 })).toBe("42");
});

test("slowest measured first, cached rows last", () => {
  const rows = localRequestRows(
    [
      entry(`${ORIGIN}/__a`, { duration: 5, startTime: 1 }),
      entry(`${ORIGIN}/__cached`, { transferSize: 0, duration: 0, startTime: 2 }),
      entry(`${ORIGIN}/__b`, { duration: 900, startTime: 3 }),
    ],
    ORIGIN,
  );
  expect(sortRequestRows(rows).map((r) => r.name)).toEqual(["/__b", "/__a", "/__cached"]);
});

test("the early head script raises the resource-timing buffer past Vite's 250 dev modules", () => {
  let size = 0;
  new Function("performance", EARLY_REQUEST_TIMING_SCRIPT)({ setResourceTimingBufferSize: (n: number) => (size = n) });
  expect(size).toBeGreaterThanOrEqual(5000);
  // And it never throws where the API is missing.
  expect(() => new Function("performance", EARLY_REQUEST_TIMING_SCRIPT)({})).not.toThrow();
});
