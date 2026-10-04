import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { childEnv } from "../assistant-runtime";
import type { CommandId, RegistryCommand } from "./contracts";
import { runRegistryCommand } from "./gate";
import { validateRegistry } from "./registry";
import { resolveRegistryLaunch } from "./registry-launch";
import { cleanup, commitIn, fixtureRepo, tempRoot, type FixtureRepo } from "./test-fixtures";

const fold = (path: string) => win32.normalize(path).toLowerCase();
const windows = (files: string[]) => ({ platform: "win32" as const, isFile: (path: string) => files.map(fold).includes(fold(path)) });
const npmDir = "C:\\Program Files\\nodejs";
const npmScript = win32.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js");
const npmShim = win32.join(npmDir, "npm.cmd");
const node = win32.join(npmDir, "node.exe");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

describe("Windows registry launch resolution (platform-injected, no native Windows claim)", () => {
  test("npm uses its known installed script with sibling Node; argv stays literal", () => {
    const argv = ["npm", "run", "check", "--", "a b", "& echo unsafe", "$(unsafe)", 'a"b', "%PATH%"];
    expect(resolveRegistryLaunch(argv, { Path: npmDir }, windows([npmShim, npmScript, node]))).toEqual({ file: node, args: [npmScript, ...argv.slice(1)] });
    expect(argv[0]).toBe("npm");
    expect(argv).toHaveLength(9);
  });
  test("npx has a separate allowlisted entry and cannot map to npm-cli.js", () => {
    const shim = win32.join(npmDir, "npx.cmd");
    const script = win32.join(npmDir, "node_modules", "npm", "bin", "npx-cli.js");
    expect(resolveRegistryLaunch(["npx", "--no-install", "tsc"], { PATH: npmDir }, windows([shim, script, node]))).toEqual({ file: node, args: [script, "--no-install", "tsc"] });
    expect(() => resolveRegistryLaunch(["npx"], { PATH: npmDir }, windows([shim, npmScript, node]))).toThrow("npx-cli.js");
  });
  test("PATH name and executable case are Windows-insensitive; quoted paths keep spaces", () => {
    const native = "C:\\Other Tools\\BUN.EXE";
    expect(resolveRegistryLaunch(["BuN", "test"], { pAtH: '"C:\\Other Tools"' }, windows([native]))).toEqual({ file: "C:\\Other Tools\\BuN.exe", args: ["test"] });
    expect(resolveRegistryLaunch(["NPM"], { pAtH: `"${npmDir}"` }, windows([npmShim.toUpperCase(), npmScript.toUpperCase(), node.toUpperCase()]))).toEqual({ file: node, args: [npmScript] });
  });
  test("a native exe wins over an earlier shim without evaluating the shim", () => {
    const native = "D:\\Native\\npm.exe";
    expect(resolveRegistryLaunch(["npm", "test"], { PATH: `${npmDir};D:\\Native` }, windows([npmShim, npmScript, node, native]))).toEqual({ file: native, args: ["test"] });
    expect(resolveRegistryLaunch(["bun"], { PATH: `${npmDir};D:\\Native` }, windows([win32.join(npmDir, "bun.cmd"), "D:\\Native\\bun.exe"])).file).toBe("D:\\Native\\bun.exe");
  });
  test("native executables preserve PATH order and explicit .exe names", () => {
    expect(resolveRegistryLaunch(["tool.EXE", "x"], { PATH: "C:\\first;D:\\second" }, windows(["C:\\first\\tool.exe", "D:\\second\\tool.exe"]))).toEqual({ file: "C:\\first\\tool.EXE", args: ["x"] });
  });
  test("npm prefers sibling Node rather than an earlier PATH installation", () => {
    expect(resolveRegistryLaunch(["npm"], { PATH: `D:\\Other Node;${npmDir}` }, windows([npmShim, npmScript, node, "D:\\Other Node\\node.exe"])).file).toBe(node);
  });
  test("npm without sibling Node uses only an absolute real node.exe from child PATH", () => {
    const fallback = "D:\\Real Node\\node.exe";
    expect(resolveRegistryLaunch(["npm", "test"], { PATH: `${npmDir};D:\\Real Node` }, windows([npmShim, npmScript, fallback]))).toEqual({ file: fallback, args: [npmScript, "test"] });
    expect(() => resolveRegistryLaunch(["npm"], { PATH: npmDir }, windows([npmShim, npmScript, win32.join(npmDir, "node.cmd")]))).toThrow("real node.exe");
  });
  test("missing npm script or shim fails closed instead of using a bare fallback", () => {
    expect(() => resolveRegistryLaunch(["npm"], { PATH: npmDir }, windows([npmShim, node]))).toThrow("npm-cli.js");
    expect(() => resolveRegistryLaunch(["npm"], { PATH: npmDir }, windows([npmScript, node]))).toThrow("no real .exe");
    expect(() => resolveRegistryLaunch(["npm"], {}, windows([npmShim, npmScript, node]))).toThrow("no real .exe");
  });
  test("a broken first npm install is reported rather than silently selecting a later one", () => {
    expect(() => resolveRegistryLaunch(["npm"], { PATH: `D:\\Broken;${npmDir}` }, windows(["D:\\Broken\\npm.cmd", npmShim, npmScript, node]))).toThrow("npm-cli.js");
  });
  test("arbitrary cmd/bat shims and PATHEXT scripts never launch", () => {
    for (const suffix of ["cmd", "bat", "ps1", "js", "com"]) {
      expect(() => resolveRegistryLaunch(["tool"], { PATH: npmDir, PATHEXT: `.${suffix}` }, windows([win32.join(npmDir, `tool.${suffix}`)]))).toThrow("no real .exe");
    }
    // Even a familiar name is not enough: only the npm .cmd layout is mapped.
    expect(() => resolveRegistryLaunch(["npm"], { PATH: npmDir }, windows([win32.join(npmDir, "npm.bat"), npmScript, node]))).toThrow("no real .exe");
  });
  test("explicit npm/cmd/bat/script argv paths remain refused", () => {
    for (const program of ["npm.cmd", "NPM.CMD", "tool.bat", npmShim, "D:\\tool.js"]) {
      expect(() => resolveRegistryLaunch([program], { PATH: npmDir }, windows([program, npmScript, node]))).toThrow();
    }
  });
  test("relative, drive-relative and root-relative program paths are refused", () => {
    for (const program of [".", "..", ".\\node.exe", "..\\node.exe", "tools/node.exe", "C:node.exe", "\\node.exe", "/node.exe"]) {
      expect(() => resolveRegistryLaunch([program], { PATH: npmDir }, windows([program, node]))).toThrow("fully qualified");
    }
  });
  test("empty and relative PATH entries cannot select a worktree-controlled executable", () => {
    const env = { PATH: `;.;;tools;C:tools;\\tools;${npmDir}` };
    expect(resolveRegistryLaunch(["node"], env, windows(["node.exe", "tools\\node.exe", "C:tools\\node.exe", "\\tools\\node.exe", node])).file).toBe(node);
    expect(() => resolveRegistryLaunch(["node"], { PATH: ";.;tools;C:tools;\\tools" }, windows(["node.exe", "tools\\node.exe"]))).toThrow("no real .exe");
  });
  test("an absolute executable needs no PATH; UNC paths and spaces stay literal", () => {
    for (const file of [node, "\\\\server\\share\\Tools Here\\check.exe"]) {
      expect(resolveRegistryLaunch([file, "hello world"], {}, windows([file]))).toEqual({ file, args: ["hello world"] });
    }
    expect(resolveRegistryLaunch(["C:\\Tools\\check"], {}, windows(["C:\\Tools\\check.exe"])).file).toBe("C:\\Tools\\check.exe");
    expect(() => resolveRegistryLaunch([node], {}, windows([]))).toThrow("no real .exe");
  });
  test("resolution sees the sanitized child PATH, not Bun's fake node or hub overrides", () => {
    const fake = "C:\\Temp\\bun-node-abc123";
    const env = childEnv({ env: { pAtH: `${fake};${npmDir}`, NODE_OPTIONS: "--require should-not-load.js", OPENAI_API_KEY: "synthetic-only" }, extra: { CI: "1", NO_COLOR: "1" } });
    expect(env.pAtH).toBe(npmDir);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(resolveRegistryLaunch(["npm", "test"], env, windows([win32.join(fake, "node.exe"), npmShim, npmScript, node])).file).toBe(node);
  });
  test("PATH normalization cannot reintroduce quoted, padded or dotted Bun fake-node folders", () => {
    const fake = "C:\\Temp\\bun-node-abc123";
    for (const dir of [`"${fake}"`, ` ${fake} `, `${fake}\\.`, `${fake}\\sub\\..`, `"${fake}\\"`]) {
      const env = childEnv({ env: { Path: `${dir};${npmDir}` } });
      const files = windows([win32.join(fake, "node.exe"), npmShim, npmScript, node]);
      expect(resolveRegistryLaunch(["node", "--check", "server.js"], env, files).file).toBe(node);
      expect(resolveRegistryLaunch(["npm", "test"], env, files).file).toBe(node);
    }
  });
});

describe("POSIX registry launch compatibility", () => {
  test("bare binaries resolve on child PATH while explicit paths and arguments are preserved", () => {
    const options = { platform: "linux" as const, isFile: (path: string) => path === "/usr/local/bin/npm" };
    expect(resolveRegistryLaunch(["npm", "run", "check"], { PATH: "/missing:/usr/local/bin" }, options)).toEqual({ file: "/usr/local/bin/npm", args: ["run", "check"] });
    for (const program of ["/opt/bin/custom", "./bin/check"]) expect(resolveRegistryLaunch([program, "a b"], {}, options)).toEqual({ file: program, args: ["a b"] });
    expect(resolveRegistryLaunch(["missing"], { PATH: "/missing" }, options).file).toBe("missing");
    expect(resolveRegistryLaunch(["npm"], { Path: "/usr/local/bin" }, options).file).toBe("npm");
  });
  test.skipIf(process.platform === "win32")("default probe skips directories and non-executable files", () => {
    const root = tempRoot("registry-launch-"); roots.push(root);
    const dirs = ["directory", "nonexec", "real"].map((part) => join(root, part));
    for (const dir of dirs) mkdirSync(dir);
    mkdirSync(join(dirs[0], "check"));
    writeFileSync(join(dirs[1], "check"), "ignored"); chmodSync(join(dirs[1], "check"), 0o600);
    writeFileSync(join(dirs[2], "check"), "#!/bin/sh\nexit 0\n"); chmodSync(join(dirs[2], "check"), 0o700);
    expect(resolveRegistryLaunch(["check"], { PATH: dirs.join(":") }).file).toBe(join(dirs[2], "check"));
  });
});

function fixture(command: Partial<RegistryCommand> = {}): FixtureRepo {
  const r = fixtureRepo({ dirty: false }); roots.push(r.root);
  r.entry.commands = [{ id: "fx.launch" as CommandId, kind: "test", argv: [process.execPath, "probe.ts"], cwd: ".", timeoutMs: 10_000, counts: "none", ...command }];
  return r;
}
const run = (r: FixtureRepo) => runRegistryCommand({ entry: r.entry, commandId: "fx.launch", worktreePath: r.canonical, sha: r.baseSha, killGraceMs: 100 });

describe("registry gate launch integration", () => {
  test("actual argv, cwd and allowlisted environment survive the launch boundary", async () => {
    const args = ["with spaces", "& echo not-a-command", 'quote"literal', "%PATH%"];
    const r = fixture({ argv: [process.execPath, "probe.ts", ...args], cwd: "checks" });
    r.baseSha = commitIn(r.canonical, { "checks/probe.ts": 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), ci: process.env.CI, color: process.env.NO_COLOR, leaked: process.env.REGISTRY_TEST_SECRET ?? null }));\n' });
    const saved = process.env.REGISTRY_TEST_SECRET;
    process.env.REGISTRY_TEST_SECRET = "synthetic-only";
    try {
      const result = await run(r);
      expect(result.result.exitCode).toBe(0);
      expect(result.result.timedOut).toBe(false);
      expect(result.result.argv).toEqual(r.entry.commands[0].argv);
      expect(JSON.parse(result.output.trim())).toEqual({ args, cwd: join(r.canonical, "checks"), ci: "1", color: "1", leaked: null });
    } finally { if (saved === undefined) delete process.env.REGISTRY_TEST_SECRET; else process.env.REGISTRY_TEST_SECRET = saved; }
  });
  test("a launched check still times out and settles with a null exit code", async () => {
    const r = fixture({ timeoutMs: 1_000 });
    r.baseSha = commitIn(r.canonical, { "probe.ts": 'console.log("started"); setInterval(() => {}, 1000);\n' });
    const result = await run(r);
    expect(result.result.timedOut).toBe(true);
    expect(result.result.exitCode).toBeNull();
    expect(result.output).toContain("started");
    expect(result.result.durationMs).toBeLessThan(10_000);
  });
  test("launch resolution cannot bypass existing explicit shell and shim registry bans", () => {
    const r = fixture();
    for (const program of ["cmd.exe", "powershell.exe", "bash", "npm.cmd", "npx.cmd", "D:\\tools\\custom.bat"]) {
      const entry = { ...r.entry, commands: [{ ...r.entry.commands[0], argv: [program] }] };
      expect(() => validateRegistry({ version: 1, repos: [entry] })).toThrow();
    }
    expect(() => validateRegistry({ version: 1, repos: [r.entry] })).not.toThrow();
  });
});
