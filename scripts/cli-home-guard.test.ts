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

// ───────────────────────────── round 7 (H-05): a synthetic hub cannot see the owner's real logins ─────────────────────────────
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isSyntheticHub, ownerLoginsAllowed, parseProfileImagePath, parseSid } from "./cli-home-guard";

const fwd = (p: string) => p.split(String.fromCharCode(92)).join("/");

describe("the account's own profile folder is read from the OS, not the environment", () => {
  test("whoami and registry output are parsed (pure)", () => {
    expect(parseSid(String.raw`"desktop-abc\nebula pc","S-1-5-21-111-222-333-1001"` + "\r\n")).toBe("S-1-5-21-111-222-333-1001");
    expect(parseSid("ERROR: nope")).toBeNull();
    const reg = "\r\nHKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\S-1-5-21-1\r\n    ProfileImagePath    REG_EXPAND_SZ    C:\Users\Owner Name\r\n";
    expect(parseProfileImagePath(reg, {})).toBe("C:\Users\Owner Name");
    expect(parseProfileImagePath("    ProfileImagePath    REG_EXPAND_SZ    %SystemDrive%\Users\Owner", { SystemDrive: "D:" })).toBe("D:\Users\Owner");
    expect(parseProfileImagePath("    ProfileImagePath    REG_EXPAND_SZ    %Nope%\Users\Owner", {})).toBeNull();
    expect(parseProfileImagePath("garbage", {})).toBeNull();
  });
  test.skipIf(process.platform !== "win32")("on Windows, a process whose HOME and USERPROFILE are redirected IS a copy (Bun's os.userInfo() followed the redirect, so it was not)", () => {
    const home = mkdtempSync(join(tmpdir(), "r7-empty-home-"));
    try {
      const code = `const g = require(${JSON.stringify(fwd(join(import.meta.dir, "cli-home-guard.ts")))}); const v = g.cliHomeGuard("codex", process.env); console.log(JSON.stringify({ copy: g.isCopy(process.env), ok: v.ok, codexHome: v.ok ? v.env.CODEX_HOME : null, args: v.ok ? v.args : null }));`;
      const redirected = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home }, stdout: "pipe", stderr: "pipe" });
      const out = JSON.parse(redirected.stdout.toString().trim().split("\n").at(-1)!);
      expect(out.copy).toBe(true);
      expect(fwd(out.codexHome).toLowerCase()).toBe(fwd(join(home, ".codex")).toLowerCase());
      expect(out.args).toEqual(["-c", 'cli_auth_credentials_store="file"']);
      // The same process with its real environment is the live server, unchanged.
      const real = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, MU_DATA_DIR: "", MU_SYNTHETIC_HUB: "" }, stdout: "pipe", stderr: "pipe" });
      expect(JSON.parse(real.stdout.toString().trim().split("\n").at(-1)!)).toMatchObject({ copy: false, ok: true });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("a synthetic hub on the owner's real home gets a home of its own unless the owner opts in", () => {
  const OWNER_HOME = "C:/Users/Owner";
  const withHub = (fn: (data: string) => void, marker: ".gate-seed.json" | ".synthetic-hub" | null = ".synthetic-hub") => {
    const data = mkdtempSync(join(tmpdir(), "r7-hub-data-"));
    if (marker) writeFileSync(join(data, marker), "{}");
    setAccountHomeForTest(() => OWNER_HOME);
    try { fn(data); } finally { setAccountHomeForTest(null); rmSync(data, { recursive: true, force: true }); }
  };
  test("the marker or the flag makes it synthetic; the explicit word makes the opt-in", () => {
    withHub((data) => {
      expect(isSyntheticHub({ MU_DATA_DIR: data })).toBe(true);
      expect(isSyntheticHub({ MU_DATA_DIR: join(data, "elsewhere") })).toBe(false);
      expect(isSyntheticHub({ MU_SYNTHETIC_HUB: "1" })).toBe(true);
      expect(ownerLoginsAllowed({ MU_OWNER_CLI_LOGINS: "allow" })).toBe(true);
      expect(ownerLoginsAllowed({ MU_OWNER_CLI_LOGINS: "1" })).toBe(false);
    });
    withHub((data) => expect(isSyntheticHub({ MU_DATA_DIR: data })).toBe(true), ".gate-seed.json");
  });
  test("Codex and Claude run on <data>/cli-home with a file credential store (the owner's real home is never offered)", () => {
    withHub((data) => {
      const env = { USERPROFILE: OWNER_HOME, HOME: OWNER_HOME, MU_DATA_DIR: data, PATH: "/bin" };
      expect(isCopy(env)).toBe(true);
      const codex = cliHomeGuard("codex", env);
      expect(codex.ok && codex.copy && codex.env.CODEX_HOME).toBe(join(data, "cli-home", ".codex"));
      expect(codex.ok && codex.args).toEqual(["-c", 'cli_auth_credentials_store="file"']);
      const claude = cliHomeGuard("claude", env);
      expect(claude.ok && claude.env.CLAUDE_CONFIG_DIR).toBe(join(data, "cli-home", ".claude"));
      // Pointing one at the owner's profile is refused, and the refusal says how a deliberate run opts in.
      const refused = cliHomeGuard("claude", { ...env, CLAUDE_CONFIG_DIR: `${OWNER_HOME}/.claude-second` });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.reason).toMatch(/MU_OWNER_CLI_LOGINS=allow/);
    });
  });
  test("a synthetic hub with no data folder of its own is refused (it would fall back to the owner's profile)", () => {
    setAccountHomeForTest(() => OWNER_HOME);
    try {
      expect(cliHomeGuard("codex", { USERPROFILE: OWNER_HOME, MU_SYNTHETIC_HUB: "1" })).toMatchObject({ ok: false, copy: true });
    } finally { setAccountHomeForTest(null); }
  });
  test("with MU_OWNER_CLI_LOGINS=allow the same hub uses the real login, unchanged: the one deliberate opt-in", () => {
    withHub((data) => {
      const env = { USERPROFILE: OWNER_HOME, HOME: OWNER_HOME, MU_DATA_DIR: data, MU_OWNER_CLI_LOGINS: "allow", PATH: "/bin" };
      expect(isCopy(env)).toBe(false);
      expect(cliHomeGuard("codex", env)).toMatchObject({ ok: true, copy: false, args: [] });
      // The opt-in does not rescue a REDIRECTED home: that is a copy whatever it says, and runs on its own home.
      expect(isCopy({ ...env, USERPROFILE: FAKE_HOME, HOME: FAKE_HOME })).toBe(true);
    });
  });
  void mkdirSync;
});

describe("review finding 8: when the account's own profile folder cannot be found the guard fails closed", () => {
  test("no real home to compare with: a copy, and Codex or Claude are refused in words; the explicit opt-in is the only way past", () => {
    setAccountHomeForTest(() => null);
    try {
      const env = { USERPROFILE: "C:/Users/Owner", PATH: "/bin" };
      expect(isCopy(env)).toBe(true);
      const v = cliHomeGuard("codex", env);
      expect(v.ok).toBe(false);
      expect(!v.ok && v.reason).toMatch(/profile folder could not be found.*MU_OWNER_CLI_LOGINS=allow/);
      expect(cliHomeGuard("claude", env).ok).toBe(false);
      expect(isCopy({ ...env, MU_OWNER_CLI_LOGINS: "allow" })).toBe(false);
      expect(cliHomeGuard("codex", { ...env, MU_OWNER_CLI_LOGINS: "allow" })).toMatchObject({ ok: true, copy: false });
    } finally { setAccountHomeForTest(null); }
  });
});
