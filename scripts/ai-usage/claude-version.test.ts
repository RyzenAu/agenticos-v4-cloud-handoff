import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeCodeVersion } from "./sources";

/**
 * M1 (review T8b): the usage request's `claude --version` runs the real executable, not cmd.exe,
 * and its timeout stops the whole process tree. Synthetic stand-ins only (bun scripts).
 */

const dir = mkdtempSync(join(tmpdir(), "m1-claude-version-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("readClaudeCodeVersion", () => {
  test("reads the version the executable prints", async () => {
    expect(await readClaudeCodeVersion(process.execPath, { args: ["-e", "console.log('2.1.299 (Claude Code)')"] })).toBe("2.1.299");
  });

  test("no CLI, a path that can't start, or a failed run answers the fallback, never an error", async () => {
    // "No CLI resolved" is an empty path: `undefined` would trigger the default and find the real installed CLI.
    expect(await readClaudeCodeVersion("")).toBe("2.1.278");
    expect(await readClaudeCodeVersion(join(dir, "missing", "claude.exe"))).toBe("2.1.278");
    expect(await readClaudeCodeVersion(process.execPath, { args: ["-e", "console.log('9.9.9'); process.exit(3)"] })).toBe("2.1.278");
  });

  test("a timeout stops the CLI and everything it started, not just a shell", async () => {
    const pidFile = join(dir, "grandchild.pid");
    // The stand-in starts a grandchild (as claude.exe's own helpers would), then hangs.
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setTimeout(() => {}, 60000);`;
    writeFileSync(join(dir, "hang.js"), script);
    const t0 = Date.now();
    const version = await readClaudeCodeVersion(process.execPath, { args: [join(dir, "hang.js")], timeoutMs: 1500 });
    expect(version).toBe("2.1.278");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 10_000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
  }, 30_000);

  test("the usage source resolves the real executable and never goes through a shell", async () => {
    const src = await Bun.file(join(import.meta.dir, "sources.ts")).text();
    expect(src).not.toContain('"claude --version"');
    expect(src).not.toMatch(/\brunText\s*\(/);
    expect(src).toContain('binary: string | undefined = realExecutable("claude")');
    expect(src).toContain("await runCapture(binary,");
  });
});
