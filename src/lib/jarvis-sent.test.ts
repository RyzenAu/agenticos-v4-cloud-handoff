// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { SENT_MAX, SENT_TTL_MS, readSent, rememberSent, tidySent, unshownSent } from "./jarvis-sent";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test("a sent request survives a reload until the conversation shows it", () => {
  const s = mem();
  rememberSent({ requestId: "jr-1", text: "check the site", at: 1000 }, 1000, s);
  expect(readSent(2000, s).map((r) => r.text)).toEqual(["check the site"]);
  expect(unshownSent(readSent(2000, s), [{ role: "oracle", text: "check the site" }])).toHaveLength(1);
  expect(unshownSent(readSent(2000, s), [{ role: "user", text: " check the site " }])).toHaveLength(0);
});

test("one entry per request id; old, malformed and excess entries are dropped", () => {
  const s = mem();
  rememberSent({ requestId: "jr-1", text: "a", at: 1 }, 1, s);
  rememberSent({ requestId: "jr-1", text: "a", at: 2 }, 2, s);
  expect(readSent(3, s)).toHaveLength(1);
  expect(tidySent([{ requestId: "x", text: "old", at: 0 }, { nope: 1 }], SENT_TTL_MS + 1)).toEqual([]);
  const many = Array.from({ length: SENT_MAX + 5 }, (_, i) => ({ requestId: `r${i}`, text: `t${i}`, at: 10 }));
  expect(tidySent(many, 11)).toHaveLength(SENT_MAX);
  expect(readSent(1, { getItem: () => { throw new Error("blocked"); }, setItem: () => {} })).toEqual([]);
});
