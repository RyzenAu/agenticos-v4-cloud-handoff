// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { isChunkLoadError, loadFailureCopy, routeKey } from "./offline-notice";
import { pendingFrom } from "./signed-in";

test("a load failure is said plainly: offline first, then a code-fetch failure, and nothing for other errors", () => {
  expect(loadFailureCopy(new Error("Failed to fetch dynamically imported module: http://x/src/routes/activity.tsx"), false)?.title).toBe("You're offline");
  expect(loadFailureCopy(new Error("Failed to fetch dynamically imported module: http://x/a.tsx"), true)?.title).toBe("This page couldn't load");
  expect(loadFailureCopy(new Error("Cannot read properties of undefined"), true)).toBeNull();
  expect(isChunkLoadError(new Error("Importing a module script failed."))).toBe(true);
});

test("a route's code is identified by its first path segment", () => {
  expect(routeKey("/workspaces/abc")).toBe("/workspaces");
  expect(routeKey("/memory/vault")).toBe("/memory");
  expect(routeKey("/")).toBe("/");
});

test("only a pending hub session needs its confirm code", () => {
  expect(pendingFrom({ hubSession: { pending: true } })).toBe(true);
  expect(pendingFrom({ hubSession: { pending: false } })).toBe(false);
  expect(pendingFrom({ hubSession: null })).toBe(false);
  expect(pendingFrom(null)).toBe(false);
});
