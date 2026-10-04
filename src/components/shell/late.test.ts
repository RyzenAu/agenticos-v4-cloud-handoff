// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { dropQueued } from "./late";

test("a cancelled typed request is dropped from the replay queue; everything else stays (R11 M5)", () => {
  const q = [
    { type: "operator:voice-text", detail: { request: "a", requestId: "jr-1" } },
    { type: "operator:voice-text", detail: { request: "b", requestId: "jr-2" } },
    { type: "operator:voice", detail: null },
  ];
  expect(dropQueued(q, { type: "operator:voice-text", requestId: "jr-1" }).map((e) => (e.detail as { request?: string } | null)?.request ?? e.type)).toEqual(["b", "operator:voice"]);
  expect(dropQueued(q, { type: "operator:voice-text" })).toHaveLength(3);
  expect(dropQueued(q, null)).toHaveLength(3);
});
