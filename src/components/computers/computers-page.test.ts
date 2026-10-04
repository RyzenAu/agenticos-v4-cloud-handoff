// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { emptyComputersBody } from "./computers-page";

describe("the Computers page empty state", () => {
  test("points at Add a shared computer only when a host exists to add one on; otherwise it does not promise a control", () => {
    expect(emptyComputersBody(true)).toContain("Add a shared computer above");
    const none = emptyComputersBody(false);
    expect(none).not.toContain("above");
    expect(none).toContain("until this hub has a computer host");
  });
});
