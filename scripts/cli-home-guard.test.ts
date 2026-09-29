import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startCodexJob } from "./agent-jobs-codex";
import { cliHomeGuard, isCopy, setAccountHomeForTest } from "./cli-home-guard";
import { withConnectedRead } from "./codex-connected-read";
import { codexRunner } from "./coding/runners/codex";
import { FakeCodex, fakeSpawn } from "./coding/runners/fakes";

/**
 * F3-26 (with A1-6): a preview or quiet copy with a SYNTHETIC home must run Codex and Claude on that home
 * (and Codex with a file credential store, so the Windows keyring login is never reached), or refuse.
 * Synthetic paths only; no real CLI runs.
 */
const FAKE_HOME = "D:/agent-scratch/synthetic-home";
const COPY = { ARGENTIC_PREVIEW: "1", USERPROFILE: FAKE_HOME, HOME: FAKE_HOME, PATH: "/bin" };

describe("cliHomeGuard", () => {
  test("the live server is unchanged", () => {
    setAccountHomeForTest(() => "C:\\Users\\Owner");
    try {
      const env = { USERPROFILE: "C:/Users/Owner", PATH: "/bin" };
      expect(cliHomeGuard("codex", env)).toMatchObject({ ok: true, copy: false, args: [] });
      expect((cliHomeGuard("codex", env) as { env: NodeJS.ProcessEnv }).env).toBe(env);
    } finally { setAccountHomeForTest(null); }
  });
  test("REVIEW-T3: a synthetic home is a copy even without the preview flags", () => {
    setAccountHomeForTest(() => "C:\\Users\\Owner");
    try {
      const env = { USERPROFILE: FAKE_HOME, PATH: "/bin" };
      expect(isCopy(env)).toBe(true);
      const v = cliHomeGuard("codex", env);
      expect(v.ok && v.copy && v.env.CODEX_HOME).toBe(join(FAKE_HOME, ".codex"));
      expect(v.ok && v.args).toEqual(["-c", 'cli_auth_credentials_store="file"']);
      expect(isCopy({ USERPROFILE: "c:/users/owner/", PATH: "/bin" })).toBe(false);
    } finally { setAccountHomeForTest(null); }
  });
  test("a copy runs Codex on its own home with a file credential store", () => {
    const v = cliHomeGuard("codex", COPY);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.env.CODEX_HOME).toBe(join(FAKE_HOME, ".codex"));
    expect(v.args).toEqual(["-c", 'cli_auth_credentials_store="file"']);
    const quiet = cliHomeGuard("codex", { AGENTIC_OS_NO_BACKGROUND: "1", USERPROFILE: FAKE_HOME });
    expect(quiet.ok && quiet.env.CODEX_HOME).toBe(join(FAKE_HOME, ".codex"));
  });
  test("a copy runs Claude on its own home", () => {
    const v = cliHomeGuard("claude", COPY);
    expect(v.ok && v.env.CLAUDE_CONFIG_DIR).toBe(join(FAKE_HOME, ".claude"));
  });
  test("a CODEX_HOME / CLAUDE_CONFIG_DIR outside the copy's home, or no home at all, is refused", () => {
    expect(cliHomeGuard("codex", { ...COPY, CODEX_HOME: "C:/Users/Owner/.codex" })).toMatchObject({ ok: false });
    expect(cliHomeGuard("claude", { ...COPY, CLAUDE_CONFIG_DIR: "C:/Users/Owner/.claude" })).toMatchObject({ ok: false });
    expect(cliHomeGuard("codex", { ARGENTIC_PREVIEW: "1", PATH: "/bin" })).toMatchObject({ ok: false });
    // One already inside the copy's home is kept.
    const inside = cliHomeGuard("codex", { ...COPY, CODEX_HOME: `${FAKE_HOME}/slot-1` });
    expect(inside.ok && inside.env.CODEX_HOME).toBe(`${FAKE_HOME}/slot-1`);
  });
});

describe("every Codex spawn site honours it", () => {
  test("coding runner: the copy's CODEX_HOME and the file store reach the child", async () => {
    const proc = new FakeCodex({});
    const { spawn } = fakeSpawn(proc);
    const handle = codexRunner({ binary: "C:/fake/codex.exe", spawn, platform: "linux", env: COPY, killGraceMs: 200, softEndMs: 20 }).start({
      jobId: "j", roleId: "builder-1", role: "builder", binding: { provider: "openai", route: "codex-app-server", accountSlot: "codex:openai-2", model: "gpt-6-astra", cliVersion: "0.154.0" },
      cwd: "D:/agent-scratch/wt", prompt: "x", system: "y", readOnly: true, session: { mode: "new", id: "n" },
      policy: () => ({ decision: "auto-allow", rule: "read-in-worktree", target: "x", message: "" }), signal: new AbortController().signal, onEvent: () => {},
      limits: { wallMs: 5000, maxTurns: 5, inputTimeoutMs: 500 }, stopAtWindowPercent: 95, creditsAllowed: false,
    });
    await handle.done;
    expect(proc.args).toContain('cli_auth_credentials_store="file"');
    expect(proc.options.env.CODEX_HOME).toBe(join(FAKE_HOME, ".codex"));
  });
  test("coding runner: a copy with no home is refused before anything starts", async () => {
    let spawned = false;
    const handle = codexRunner({ binary: "C:/fake/codex.exe", spawn: (() => { spawned = true; throw new Error("no"); }) as never, platform: "linux", env: { ARGENTIC_PREVIEW: "1" } }).start({
      jobId: "j", roleId: "builder-1", role: "builder", binding: { provider: "openai", route: "codex-app-server", accountSlot: "codex:openai-2", model: "gpt-6-astra", cliVersion: "0.154.0" },
      cwd: "D:/x", prompt: "x", system: "y", readOnly: true, session: { mode: "new", id: "n" },
      policy: () => ({ decision: "auto-allow", rule: "read-in-worktree", target: "x", message: "" }), signal: new AbortController().signal, onEvent: () => {},
      limits: { wallMs: 5000, maxTurns: 5, inputTimeoutMs: 500 }, stopAtWindowPercent: 95, creditsAllowed: false,
    });
    const out = await handle.done;
    expect(spawned).toBe(false);
    expect(out.error?.code).toBe("signed_out");
  });
  test("C1 agent jobs: same rule", async () => {
    const proc = new FakeCodex({});
    const events: unknown[] = [];
    const job = startCodexJob({ cwd: "D:/x", prompt: "x", signal: new AbortController().signal, onEvent: (e) => events.push(e) }, {
      binary: "C:/fake/codex.exe", launch: ((b: string, args: string[], o: any) => { proc.args = args; proc.options = o; queueMicrotask(() => proc.close(0)); return proc; }) as never, env: COPY, isolation: () => ({ ok: true, message: "" }), timeoutMs: 2000,
    });
    await job.done;
    expect(proc.args).toContain('cli_auth_credentials_store="file"');
    expect(proc.options.env.CODEX_HOME).toBe(join(FAKE_HOME, ".codex"));
  });
  test("Calendar's Codex connected read (F3-26's path): scoped, or refused with no home", async () => {
    let launched: { args: string[]; env: Record<string, string> } | null = null;
    const fake = new FakeCodex({});
    const read = withConnectedRead("D:/x", async () => "never", {
      binary: "C:/fake/codex.exe", env: COPY, platform: "linux", timeoutMs: 1000, callTimeoutMs: 200,
      launch: ((file: string, args: string[], o: any) => { launched = { args, env: o.env }; queueMicrotask(() => fake.close(0)); return fake; }) as never,
    }).catch((e) => e);
    await read;
    expect(launched!.args).toContain('cli_auth_credentials_store="file"');
    expect(launched!.env.CODEX_HOME).toBe(join(FAKE_HOME, ".codex"));
    const refused = await withConnectedRead("D:/x", async () => "never", { binary: "C:/fake/codex.exe", env: { ARGENTIC_PREVIEW: "1" }, platform: "linux", launch: (() => { throw new Error("must not launch"); }) as never }).catch((e) => e as Error);
    expect(String((refused as Error).message)).toContain("owner's login");
  });
});

describe("R3: the agent-jobs status probes run on a copy's home too", () => {
  test("discoverCodexModels in a copy uses the copy's CODEX_HOME and file credential store, or doesn't start", async () => {
    const { discoverCodexModels } = await import("./assistant-adapters");
    const launched: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const launch = ((file: string, args: string[], options: any) => {
      launched.push({ args, env: options.env });
      throw new Error("no real codex in this test");
    }) as never;
    await discoverCodexModels("/fake/codex", launch, COPY).catch(() => null);
    expect(launched).toHaveLength(1);
    expect(launched[0].args).toContain('cli_auth_credentials_store="file"');
    expect(launched[0].env?.CODEX_HOME).toBe(join(FAKE_HOME, ".codex"));
    const refused = await discoverCodexModels("/fake/codex", launch, { ...COPY, CODEX_HOME: "C:/Users/Owner/.codex" });
    expect(refused).toMatchObject({ ready: false });
    expect(launched).toHaveLength(1);
  });
  test("claudeSignInStatus in a copy asks about the copy's own Claude home", async () => {
    const { claudeSignInStatus } = await import("./assistant-runtime");
    const runs: any[] = [];
    await claudeSignInStatus("/fake/claude", async (_f, _a, options) => { runs.push(options); return { stdout: '{"loggedIn":false}' }; }, { platform: "linux", env: { PATH: "/bin" } }, COPY);
    expect(runs[0].env?.CLAUDE_CONFIG_DIR).toBe(join(FAKE_HOME, ".claude"));
    const refused = await claudeSignInStatus("/fake/claude", async () => { runs.push("ran"); return { stdout: "{}" }; }, { platform: "linux", env: { PATH: "/bin" } }, { ARGENTIC_PREVIEW: "1", PATH: "/bin" });
    expect(refused).toMatchObject({ ready: false });
    expect(runs).toHaveLength(1);
  });
});

describe("R4: Claude model discovery runs on a copy's home too", () => {
  test("discoverClaudeModels in a copy uses the copy's Claude home, or doesn't start", async () => {
    const { discoverClaudeModels } = await import("./assistant-adapters");
    const launched: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const launch = ((_file: string, _args: string[], options: any) => {
      launched.push({ env: options.env });
      throw new Error("no real claude in this test");
    }) as never;
    await discoverClaudeModels("/fake/claude", launch, COPY).catch(() => null);
    expect(launched).toHaveLength(1);
    expect(launched[0].env?.CLAUDE_CONFIG_DIR).toBe(join(FAKE_HOME, ".claude"));
    const refused = await discoverClaudeModels("/fake/claude", launch, { ...COPY, CLAUDE_CONFIG_DIR: "C:/Users/Owner/.claude" });
    expect(refused).toMatchObject({ ready: false });
    expect(launched).toHaveLength(1);
  });
});
