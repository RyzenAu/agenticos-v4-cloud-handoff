import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_MARKER, harnessFakePublish } from "./fake-publish";

const scratch = mkdtempSync(join(tmpdir(), "harness-scratch-"));
const marked = join(scratch, "marked");
const unmarked = join(scratch, "unmarked");
mkdirSync(marked, { recursive: true });
mkdirSync(unmarked, { recursive: true });
writeFileSync(join(marked, HARNESS_MARKER), "harness setup made this");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the harness-only fake publishers are inert unless every condition holds", () => {
  const on = { MU_HARNESS_FAKE_PUBLISH: "1", MU_HUB_ROLE: "server", MU_DATA_DIR: marked };
  test("off by default, and off without the server role or an explicit data dir", () => {
    expect(harnessFakePublish({})).toBeNull();
    expect(harnessFakePublish({ ...on, MU_HARNESS_FAKE_PUBLISH: "" })).toBeNull();
    expect(harnessFakePublish({ ...on, MU_HARNESS_FAKE_PUBLISH: "true" })).toBeNull();
    expect(harnessFakePublish({ ...on, MU_HUB_ROLE: "pc" })).toBeNull();
    expect(harnessFakePublish({ ...on, MU_HUB_ROLE: undefined })).toBeNull();
    expect(harnessFakePublish({ ...on, MU_DATA_DIR: "" })).toBeNull();
  });
  test("on with all four (flag, server role, data dir, marker): fake deploy, take-down and Blotato exist", () => {
    const f = harnessFakePublish(on);
    expect(f).not.toBeNull();
    expect(typeof f!.leadSites.deploy).toBe("function");
    expect(f!.blotatoKey()).toBe("harness-fake-key");
  });
  test("the flag without the marker in the data folder fails CLOSED and loudly: nothing is faked and nothing real runs", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const f = harnessFakePublish({ ...on, MU_DATA_DIR: unmarked });
      expect(f).not.toBeNull(); // not null: null would hand the real publishers to a process that says it is a harness
      expect(f!.blotatoKey()).toBe(""); // not the fake key
      await expect((f!.leadSites.deploy as any)()).rejects.toThrow(/.mu-harness-scratch is missing/);
      await expect((f!.leadSites.takedown as any)()).rejects.toThrow(/publishing is disabled/);
      await expect((f!.blotato as any)("k", "/media", {})).rejects.toThrow(/publishing is disabled/);
      expect(errors.mock.calls.map((c) => String(c[0])).join(" ")).toContain("[harness]");
    } finally {
      errors.mockRestore();
    }
  });
  test("the marker must be INSIDE the data folder, not beside it", () => {
    const f = harnessFakePublish({ ...on, MU_DATA_DIR: join(marked, "child") });
    expect(f!.blotatoKey()).toBe("");
  });
});
