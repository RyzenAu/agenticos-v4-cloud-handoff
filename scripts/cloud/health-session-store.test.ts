// R8 F review: an unreadable sign-in store is a named condition on /__health, with the owner's recovery, not a silent "Something went wrong".
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHealth } from "./health";

const TMP_BASE = existsSync("D:/") ? "D:/tmp" : tmpdir();
let work: string;
beforeEach(() => {
  mkdirSync(TMP_BASE, { recursive: true });
  work = mkdtempSync(join(TMP_BASE, "mu-health-ss-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const base = {
  version: async () => ({ version: "9.9.9", gitSha: "abc1234", dirty: false, buildTime: "" }),
  jobs: () => ({ owner: true }),
  companions: () => ({ online: 0, total: 0 }),
  fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
};
const health = (data: string) =>
  collectHealth({ ...base, root: work, env: { MU_DATA_DIR: data, HINDSIGHT_URL: "off" } });

test("no sign-in records yet: ok", async () => {
  const data = join(work, "data");
  mkdirSync(data, { recursive: true });
  const h = await health(data);
  expect(h.components.sessionStore.status).toBe("ok");
  expect(h.failed.find((f) => f.component === "sessionStore")).toBeUndefined();
});

test("readable records: ok", async () => {
  const data = join(work, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "devices.json"), JSON.stringify({ version: 1, sessions: [] }));
  expect((await health(data)).components.sessionStore).toEqual({
    status: "ok",
    detail: "Sign-in records read.",
  });
});

for (const [name, text] of [
  ["damaged", '{"sessions": ['],
  ["wrong shape", "null"],
] as const) {
  test(`${name} records: failed, with the plain sentence and the recovery, no row contents`, async () => {
    const data = join(work, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "devices.json"), text);
    const h = await health(data);
    expect(h.status).toBe("failed");
    expect(h.components.sessionStore.status).toBe("failed");
    expect(h.components.sessionStore.detail).toContain("Sign-in records can't be read");
    expect(h.components.sessionStore.detail).toContain("nothing will be overwritten");
    const f = h.failed.find((x) => x.component === "sessionStore");
    expect(f?.recovery).toContain("newest verified backup");
    expect(f?.recovery).toContain("sign-in records file");
    expect(f?.recovery).toContain("3. Start the hub");
    // plain words: no file or document names shown to the owner
    expect(f?.recovery).not.toMatch(/devices\.json|R8-F-OPS|\.md\b|corrupt-/);
    expect(f?.detail).not.toMatch(/devices\.json|R8-F-OPS/);
  });
}
