// H-07: a background Vercel call must never start a login (the CLI opens a browser on the hub's desktop). A stub `vercel` on PATH records
// whether the environment it was given would let the real CLI start a device sign-in, and what it was asked.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERCEL_NOT_SIGNED_IN, refreshVercelIfStale, runVercelList, vercelBackgroundEnv } from "./catalogue";

test("the background environment carries CI=1 whatever the hub was started with", () => {
  expect(vercelBackgroundEnv({ CI: "", PATH: "x" }).CI).toBe("1");
  expect(vercelBackgroundEnv({ PATH: "x" }).CI).toBe("1");
});

test.skipIf(process.platform !== "win32")("with no login the list call says so, passes --non-interactive and never reaches the login flow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stub-vercel-"));
  try {
    const log = join(dir, "calls.log");
    // The real CLI starts its device sign-in when it has no credentials and CI is not set. The stub records that instead of opening anything.
    writeFileSync(join(dir, "vercel.cmd"), [
      "@echo off",
      `echo CI=%CI% %* >> "${log}"`,
      `if not "%CI%"=="1" echo LOGIN_ATTEMPTED >> "${log}"`,
      "echo No existing credentials found. Please run `vercel login`.",
      "exit /b 1",
    ].join("\r\n"));
    // A hub started inside an agent or terminal must not matter: CI is forced even if the parent says otherwise.
    const env = { ...process.env, PATH: `${dir};${process.env.PATH}`, CI: "" };
    await expect(runVercelList({ env, timeoutMs: 30_000 })).rejects.toThrow(VERCEL_NOT_SIGNED_IN);
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("LOGIN_ATTEMPTED");
    expect(calls).toContain("CI=1");
    expect(calls).toContain("--non-interactive");
    expect(calls).toContain("project ls");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

test("a page view that finds no login stores the plain message and tries nothing else", async () => {
  const root = mkdtempSync(join(tmpdir(), "stub-root-"));
  const prev = process.env.MU_DATA_DIR;
  process.env.MU_DATA_DIR = root;
  try {
    const { refreshing } = refreshVercelIfStale(root, () => Promise.reject(new Error(VERCEL_NOT_SIGNED_IN)));
    expect(refreshing).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const cache = JSON.parse(readFileSync(join(root, "websites-vercel.json"), "utf8"));
    expect(cache.error).toBe(VERCEL_NOT_SIGNED_IN);
  } catch (e) { throw e; }
  finally { if (prev === undefined) delete process.env.MU_DATA_DIR; else process.env.MU_DATA_DIR = prev; rmSync(root, { recursive: true, force: true }); }
});
