import { describe, expect, test } from "bun:test";
import { childEnv, CHILD_ENV_ALLOWLIST, forbiddenChildEnvName, realExecutable } from "./assistant-runtime";

// C1 (b) and (c): delegated agents get the allowlisted env only and the real .exe, never a shim.
// Every Windows case uses synthetic paths through the injectable file probe.

const HOME = "C:\\Users\\example";
const APPDATA = `${HOME}\\AppData\\Roaming`;
const LOCALAPPDATA = `${HOME}\\AppData\\Local`;
const NPM = `${APPDATA}\\npm`;
const winEnv = { PATH: `C:\\Windows\\System32;${NPM}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", APPDATA, LOCALAPPDATA };
const CLAUDE_REAL = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const CODEX_REAL = `${NPM}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const lookup = (files: string[], extra: object = {}) => ({
  platform: "win32" as const, env: winEnv, home: HOME, arch: "x64", exists: (candidate: string) => files.includes(candidate), ...extra,
});

describe("realExecutable: the real program, never an npm shim", () => {
  test("claude.cmd on PATH resolves to the claude.exe its package installed", () => {
    expect(realExecutable("claude", lookup([`${NPM}\\claude.cmd`, CLAUDE_REAL]))).toBe(CLAUDE_REAL);
  });
  test("codex.cmd resolves to the nested per-architecture codex.exe", () => {
    expect(realExecutable("codex", lookup([`${NPM}\\codex.cmd`, CODEX_REAL]))).toBe(CODEX_REAL);
  });
  test("codex on arm64 finds the hoisted arm64 package", () => {
    const arm = `${NPM}\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe`;
    expect(realExecutable("codex", lookup([`${NPM}\\codex.cmd`, arm], { arch: "arm64" }))).toBe(arm);
    expect(realExecutable("codex", lookup([`${NPM}\\codex.cmd`, CODEX_REAL], { arch: "arm64" }))).toBeUndefined();
  });
  test("a native .exe earlier on PATH wins", () => {
    const native = "C:\\Tools\\claude.exe";
    const options = lookup([native, `${NPM}\\claude.cmd`, CLAUDE_REAL], { env: { ...winEnv, PATH: `C:\\Tools;${NPM}` } });
    expect(realExecutable("claude", options)).toBe(native);
  });
  test("a shim whose package lost its exe falls back to the pinned bridge copy, else fails closed", () => {
    const pinned = `${LOCALAPPDATA}\\claude-bridge\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    expect(realExecutable("claude", lookup([`${NPM}\\claude.cmd`, pinned]))).toBe(pinned);
    expect(realExecutable("claude", lookup([`${NPM}\\claude.cmd`]))).toBeUndefined();
    expect(realExecutable("codex", lookup([`${NPM}\\codex.cmd`, `${NPM}\\codex.bat`]))).toBeUndefined();
  });
  test("never returns a .cmd or .bat, whatever is installed", () => {
    for (const files of [[`${NPM}\\claude.cmd`], [`${NPM}\\claude.bat`], [`${NPM}\\claude.cmd`, CLAUDE_REAL], []]) {
      const found = realExecutable("claude", lookup(files));
      expect(found === undefined || /\.exe$/i.test(found)).toBe(true);
    }
  });
  test("a relative PATH entry is never trusted", () => {
    const files = ["tools\\claude.exe", `${NPM}\\claude.cmd`, CLAUDE_REAL];
    const options = lookup(files, { env: { ...winEnv, PATH: `tools;${NPM}` } });
    expect(realExecutable("claude", options)).toBe(CLAUDE_REAL);
  });
  test("POSIX is the ordinary PATH lookup", () => {
    expect(realExecutable("codex", { platform: "darwin", env: { PATH: "/opt/bin" }, home: "/Users/example", exists: (c) => c === "/opt/bin/codex" })).toBe("/opt/bin/codex");
  });
});

describe("childEnv: an allowlist, not a blocklist", () => {
  const synthetic = {
    Path: "C:\\Windows", SystemRoot: "C:\\Windows", USERPROFILE: HOME, APPDATA, LOCALAPPDATA, TEMP: "C:\\Temp",
    // Names seen on this PC (values here are fake): none may reach an agent.
    AGENTROUTER_API_KEY: "fake-1", DEEPSEEK_API_KEY: "fake-2", GEMINI_API_KEY: "fake-3", GOOGLE_OAUTH_CLIENT_SECRET: "fake-4",
    NV_BRIDGE_KEY: "fake-5", OPENROUTER_API_KEY: "fake-6", ANTHROPIC_BASE_URL: "http://fake.invalid", ANTHROPIC_API_KEY: "fake-7",
    OPENAI_API_KEY: "fake-8", CLAUDE_CODE_USE_BEDROCK: "1", GITHUB_TOKEN: "fake-9", VERCEL_TOKEN: "fake-10",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-11", DATABASE_URL: "postgres://fake", HERMES_HOME: "C:\\fake", NODE_OPTIONS: "--require x",
  };
  test("only allowlisted system variables pass; every fake secret is dropped", () => {
    const env = childEnv({ env: synthetic });
    expect(env).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", USERPROFILE: HOME, APPDATA, LOCALAPPDATA, TEMP: "C:\\Temp" });
    expect(JSON.stringify(env)).not.toMatch(/fake-|fake\.invalid|postgres/);
  });
  test("the CLI's own login/config and shell locations pass, so agents stay signed in", () => {
    const env = childEnv({ env: { CODEX_HOME: "C:\\codex", CLAUDE_CONFIG_DIR: "C:\\claude", CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe", CLAUDE_CODE_OAUTH_TOKEN: "fake" } });
    expect(env).toEqual({ CODEX_HOME: "C:\\codex", CLAUDE_CONFIG_DIR: "C:\\claude", CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe" });
  });
  test("matching is case-insensitive and keeps one spelling", () => {
    const env = childEnv({ env: { Path: "a", PATH: "b", systemroot: "c" } });
    expect(Object.keys(env).filter((name) => name.toLowerCase() === "path")).toHaveLength(1);
    expect(env.systemroot).toBe("c");
  });
  test("fixed CLI settings are added; provider overrides and secret-shaped names are refused as settings", () => {
    expect(childEnv({ env: synthetic, extra: { RUST_LOG: "error" } }).RUST_LOG).toBe("error");
    for (const name of ["ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CLAUDE_CODE_USE_VERTEX", "MY_API_KEY", "SOME_TOKEN", "X_SECRET", "NODE_OPTIONS", "DATABASE_URL", "PATH"])
      expect(() => childEnv({ env: {}, extra: { [name]: "v" } })).toThrow("Refusing");
  });
  test("scoped credentials must be named explicitly and can never be provider billing overrides", () => {
    expect(childEnv({ env: {}, scopedCredentials: { RX_SYNTHETIC_TOKEN: "scoped" } })).toEqual({ RX_SYNTHETIC_TOKEN: "scoped" });
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CLAUDE_CODE_USE_BEDROCK"])
      expect(() => childEnv({ env: {}, scopedCredentials: { [name]: "v" } })).toThrow("metered API billing");
  });
  test("the allowlist itself holds no secret-shaped or provider names", () => {
    expect(CHILD_ENV_ALLOWLIST.filter(forbiddenChildEnvName)).toEqual([]);
  });
  test("this server's real environment never leaks a forbidden name (names only are inspected)", () => {
    expect(Object.keys(childEnv()).filter(forbiddenChildEnvName)).toEqual([]);
    expect(Object.keys(childEnv()).some((name) => /^(ANTHROPIC|OPENAI|CLAUDE_CODE_USE)_/i.test(name))).toBe(false);
    expect(Object.keys(childEnv()).filter((name) => /^CLAUDE_CODE_/i.test(name))).toEqual(
      Object.keys(childEnv()).filter((name) => name === "CLAUDE_CODE_GIT_BASH_PATH"));
  });
});
