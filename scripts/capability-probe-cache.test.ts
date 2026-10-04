import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PROBE_TTL_MS, cachedClaudeInit } from "./capability-registry";

describe("Claude init probe cache", () => {
  test("spends one claude -p turn per TTL window", async () => {
    const root = mkdtempSync(join(tmpdir(), "probe-cache-"));
    mkdirSync(join(root, ".operator-data"));
    let calls = 0;
    const exec = async () => {
      calls++;
      return `init ${calls}`;
    };
    const start = 1_000_000;
    expect(await cachedClaudeInit(root, exec as any, start)).toBe("init 1");
    expect(await cachedClaudeInit(root, exec as any, start + 60_000)).toBe("init 1");
    expect(calls).toBe(1);
    expect(await cachedClaudeInit(root, exec as any, start + CLAUDE_PROBE_TTL_MS + 1)).toBe("init 2");
    expect(calls).toBe(2);
  });

  test("an empty result isn't cached", async () => {
    const root = mkdtempSync(join(tmpdir(), "probe-cache-"));
    mkdirSync(join(root, ".operator-data"));
    let calls = 0;
    const exec = async () => {
      calls++;
      return "";
    };
    await cachedClaudeInit(root, exec as any, 0);
    await cachedClaudeInit(root, exec as any, 1);
    expect(calls).toBe(2);
  });
});
