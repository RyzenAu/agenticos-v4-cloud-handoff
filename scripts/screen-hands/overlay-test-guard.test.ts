// Guard (Track 8, 28 Sep): the test suite must never start a real jarvis-overlay. Before this, a
// screen-hands test that forgot `overlay: nullOverlay()` spawned one per glide/caption and left it
// running (76 in one 6-file run; 60-70 alive machine-wide, adding to a memory-starved PC).
import { expect, test } from "bun:test";
import { createOverlay } from "./overlay";

test("bun test runs as NODE_ENV=test, which is what keeps the real overlay off (b2f836b)", () => {
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.AGENTIC_OVERLAY_IN_TESTS).not.toBe("1");
});

test("createOverlay() under test starts nothing, whatever it is asked to do", async () => {
  const overlay = createOverlay({ sleep: async () => undefined });
  overlay.warm();
  await overlay.glide({ x: 10, y: 10 }, { ms: 0 });
  overlay.caption("hello");
  overlay.ring({ x: 0, y: 0, w: 10, h: 10 } as never);
  overlay.follow(true);
  expect(await overlay.excludeFromCapture(true)).toBe(false);
  expect(await overlay.stat()).toBeNull();
  // A real overlay has a child process by now (glide starts it); the null overlay never does.
  expect(overlay.pid()).toBeNull();
  overlay.close();
});
