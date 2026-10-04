import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryCommand } from "../contracts";
import { cleanup, tempRoot } from "../test-fixtures";
import { claudeArgs, claudeRunner } from "./claude";
import { CM_BLOCKED_TOOLS, CM_DISALLOWED, CM_PINNED_VERSION, CM_TOOLS, contextModeLaunch, contextModePolicy, resolveContextMode } from "./context-helper";
import { FakeClaude, fakeSpawn, type FakeClaudeOptions } from "./fakes";
import { createPolicy, type PolicyContext } from "./policy";
import type { PolicyFn, RunnerEvent, RunnerStart } from "./types";

const root = tempRoot("coding-cm-");
const wt = join(root, "wt");
const install = join(root, "context-mode");
for (const d of [wt, join(wt, "src", "billing"), install]) mkdirSync(d, { recursive: true });
writeFileSync(join(wt, ".env"), "X=1\n");
writeFileSync(join(install, "server.bundle.mjs"), "// fake bundle\n");
writeFileSync(join(install, "package.json"), JSON.stringify({ name: "context-mode", version: CM_PINNED_VERSION, license: "Elastic-2.0" }));
afterAll(() => cleanup(root));

const commands: RegistryCommand[] = [{ id: "fx.test" as never, kind: "test", argv: ["node", "test.js"], cwd: ".", timeoutMs: 60_000, counts: "none" }];
const ctx: PolicyContext = { role: "builder", access: "write", worktree: wt, owns: { globs: ["src/billing/**"], newFiles: [] }, commands, nodeModules: "none", mayChangeDependencies: false, allowWeb: false, protectedRoots: [join(root, "canonical")] };
const base = createPolicy(ctx);
const wrapped = contextModePolicy(base, wt);
const P = "mcp__context-mode__";
const viaHelper = (name: string, input: Record<string, unknown>) => wrapped({ kind: "tool", tool: `${P}${name}`, input });
const bash = (command: string) => base({ kind: "tool", tool: "Bash", input: { command } });

describe("context helper: policy cannot be bypassed through the helper's tools", () => {
  // The same text must get the SAME decision from the Bash policy and from every helper entry point.
  const commandsToCheck = [
    "node test.js", "git status", "git push origin main", "git reset --hard", "cat .env", "cat ../outside.txt", "echo $(cat .env)", "curl https://example.com",
    "rm -rf src", "vercel deploy", "echo hi > ../x.txt", "bash -c 'git push'", "node -e \"require('child_process')\"", "ls ..", "type C:\\Users\\x\\.ssh\\id_rsa", "grep -rn legacyFormat src | wc -l",
  ];
  for (const c of commandsToCheck) {
    test(`same verdict as Bash: ${c}`, () => {
      const expected = bash(c).decision;
      expect(viaHelper("ctx_execute", { language: "shell", code: c }).decision).toBe(expected);
      expect(viaHelper("ctx_batch_execute", { commands: [{ label: "a", command: c }], queries: ["x"] }).decision).toBe(expected);
      expect(viaHelper("ctx_batch_execute", { commands: [{ label: "ok", command: "node test.js" }, { label: "a", command: c }], queries: ["x"] }).decision).toBe(expected === "auto-allow" ? "auto-allow" : expected);
    });
  }
  test("the denied ones really are denied (not just equal)", () => {
    for (const c of ["git push origin main", "cat .env", "echo $(cat .env)", "curl https://example.com", "rm -rf src", "cat ../outside.txt"])
      expect(viaHelper("ctx_execute", { language: "shell", code: c }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_execute", { language: "shell", code: "node test.js" }).decision).toBe("auto-allow");
  });
  test("any language other than shell is denied: JS, Python and friends can run anything", () => {
    for (const language of ["javascript", "typescript", "python", "ruby", "go", "rust", "php", "perl", "r", "elixir", "csharp"])
      expect(viaHelper("ctx_execute", { language, code: "console.log(1)" }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_execute", { code: "echo hi" }).decision).toBe("auto-deny");
  });
  test("background processes and a cwd outside the worktree are denied", () => {
    expect(viaHelper("ctx_execute", { language: "shell", code: "node test.js", background: true }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_execute", { language: "shell", code: "node test.js", cwd: join(root, "canonical") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_execute", { language: "shell", code: "node test.js", cwd: 5 }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_batch_execute", { commands: [{ label: "a", command: "node test.js" }], cwd: join(root, "canonical") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_execute", { language: "shell", code: "node test.js", cwd: join(wt, "src") }).decision).toBe("auto-allow");
  });
  test("malformed batches are denied (no commands, too many, non-strings, a hidden field)", () => {
    expect(viaHelper("ctx_batch_execute", {}).decision).toBe("auto-deny");
    expect(viaHelper("ctx_batch_execute", { commands: [] }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_batch_execute", { commands: Array.from({ length: 13 }, () => ({ label: "a", command: "node test.js" })) }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_batch_execute", { commands: [{ label: "a", command: 5 }] }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_batch_execute", { commands: [{ label: "a" }] }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_execute", { language: "shell", code: "" }).decision).toBe("auto-deny");
  });
  test("every other tool of the helper, and any other MCP tool, stays refused", () => {
    for (const t of CM_BLOCKED_TOOLS) expect(viaHelper(t, { url: "https://x", path: "a", code: "x" }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_unknown", {}).decision).toBe("auto-deny");
    expect(wrapped({ kind: "tool", tool: "mcp__other__thing", input: {} }).decision).toBe("auto-deny");
    expect(wrapped({ kind: "mcp", server: "context-mode", tool: "ctx_execute" }).decision).toBe("auto-deny");
  });
  test("ctx_index reads a path only under the Read policy; ctx_search stays inside its own store", () => {
    expect(viaHelper("ctx_index", { path: join(wt, ".env") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(root, "canonical", "x.md") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "src", "billing", "a.md") }).decision).toBe("auto-allow");
    expect(viaHelper("ctx_index", { content: "# notes" }).decision).toBe("auto-allow");
    expect(viaHelper("ctx_index", {}).decision).toBe("auto-deny");
  });
  // Open Dot review C4: a directory walk skips the per-file secret rules, so only one explicit regular file passes.
  test("ctx_index denies directories, globs, links and walk options; credentials files stay denied", () => {
    mkdirSync(join(wt, "config"), { recursive: true });
    writeFileSync(join(wt, "config", "credentials.json"), "{}");
    writeFileSync(join(wt, "config", "secrets.yaml"), "a: 1");
    writeFileSync(join(wt, "src", "billing", "real.md"), "# ok");
    expect(viaHelper("ctx_index", { path: wt }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "config") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: "." }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "src") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "src", "billing") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "**", "*") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: wt, followSymlinks: true, extensions: [".env", ".pem"], include: ["**"] }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "src", "billing", "real.md"), extensions: [".env"] }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "src", "billing", "real.md"), maxDepth: 3 }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "config", "credentials.json") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "config", "secrets.yaml") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, ".env") }).decision).toBe("auto-deny");
    expect(viaHelper("ctx_index", { path: join(wt, "src", "billing", "real.md"), source: "notes" }).decision).toBe("auto-allow");
    expect(viaHelper("ctx_index", { path: "src/billing/real.md" }).decision).toBe("auto-allow");
    expect(viaHelper("ctx_search", { queries: ["x"] }).decision).toBe("auto-allow");
  });
  test("a read-only role gets the read-only Bash rules through the helper too", () => {
    const reviewer = contextModePolicy(createPolicy({ ...ctx, role: "reviewer", access: "read-only", owns: { globs: [], newFiles: [] } }));
    expect(reviewer({ kind: "tool", tool: `${P}ctx_execute`, input: { language: "shell", code: "echo hi > src/billing/a.js" } }).decision).not.toBe("auto-allow");
    expect(reviewer({ kind: "tool", tool: `${P}ctx_execute`, input: { language: "shell", code: "git status" } }).decision).toBe("auto-allow");
  });
  test("without the wrapper the base policy refuses every helper tool (today's behaviour)", () => {
    expect(base({ kind: "tool", tool: `${P}ctx_execute`, input: { language: "shell", code: "node test.js" } }).decision).toBe("auto-deny");
    expect(base({ kind: "mcp", server: "context-mode", tool: `${P}ctx_search` }).decision).toBe("auto-deny");
  });
});

describe("context helper: install check and launch pieces", () => {
  test("a good pinned checkout resolves; wrong licence, version, name or missing bundle do not", () => {
    expect(resolveContextMode({ installDir: install })).toMatchObject({ ok: true, version: CM_PINNED_VERSION });
    const bad = (pkg: object, name: string) => { const d = join(root, name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "server.bundle.mjs"), "x"); writeFileSync(join(d, "package.json"), JSON.stringify(pkg)); return resolveContextMode({ installDir: d }); };
    expect(bad({ name: "context-mode", version: CM_PINNED_VERSION, license: "MIT" }, "lic")).toMatchObject({ ok: false });
    expect(bad({ name: "context-mode", version: "9.9.9", license: "Elastic-2.0" }, "ver")).toMatchObject({ ok: false });
    expect(bad({ name: "other", version: CM_PINNED_VERSION, license: "Elastic-2.0" }, "nam")).toMatchObject({ ok: false });
    expect(resolveContextMode({ installDir: join(root, "nothing") })).toMatchObject({ ok: false });
    expect(resolveContextMode({ installDir: "C:/Users/someone/.claude/plugins/cache/context-mode" })).toMatchObject({ ok: false });
    expect(resolveContextMode({ installDir: "C:/Users/someone/npm/node_modules/context-mode" })).toMatchObject({ ok: false });
  });
  test("launch: own data dir and stub profile per run, MCP only, no hooks, the real profile is never named", () => {
    const res = resolveContextMode({ installDir: install }) as Extract<ReturnType<typeof resolveContextMode>, { ok: true }>;
    const a = contextModeLaunch({ request: { kind: "context-mode", dataDir: join(root, "data", "job-a") }, resolution: res, runtime: "C:/bun.exe", worktree: wt, sessionId: "sess-a" });
    const b = contextModeLaunch({ request: { kind: "context-mode", dataDir: join(root, "data", "job-b") }, resolution: res, runtime: "C:/bun.exe", worktree: wt, sessionId: "sess-b" });
    const cfgA = JSON.parse(a.mcpConfig), cfgB = JSON.parse(b.mcpConfig);
    expect(Object.keys(cfgA.mcpServers)).toEqual(["context-mode"]);
    expect(cfgA.mcpServers["context-mode"].args).toEqual([res.server]);
    expect(cfgA.mcpServers["context-mode"].env.CONTEXT_MODE_DIR).not.toBe(cfgB.mcpServers["context-mode"].env.CONTEXT_MODE_DIR);
    expect(cfgA.mcpServers["context-mode"].env.CLAUDE_CONFIG_DIR).toContain("job-a");
    expect(cfgA.mcpServers["context-mode"].env.CLAUDE_SESSION_ID).toBe("sess-a");
    expect(a.mcpConfig).not.toContain(".claude-mu-max-2");
    expect(JSON.stringify(cfgA)).not.toMatch(/hooks/i);
    expect(existsSync(join(root, "data", "job-a", "store"))).toBe(true);
    expect(existsSync(join(install, "node_modules"))).toBe(false); // nothing was installed into the checkout
    expect(a.disallowed).toEqual(CM_DISALLOWED);
    expect(CM_TOOLS.some((t) => (CM_BLOCKED_TOOLS as readonly string[]).includes(t))).toBe(false);
  });
});

const SESSION = "11111111-2222-4333-8444-555555555555";
const allowAll: PolicyFn = (r) => ({ decision: r.kind === "tool" && r.tool.startsWith("mcp__") ? "auto-deny" : "auto-allow", rule: "read-in-worktree", target: "x", message: "ok" });
function run(fake: FakeClaudeOptions, over: Partial<RunnerStart> = {}, env: NodeJS.ProcessEnv = { PATH: "/bin" }) {
  const proc = new FakeClaude(fake);
  const { spawn } = fakeSpawn(proc);
  const events: RunnerEvent[] = [];
  const handle = claudeRunner({ binary: "C:/fake/claude.exe", spawn, platform: "linux", env, killGraceMs: 300, softEndMs: 50, tempDir: root, contextRuntime: "C:/bun.exe" }).start({
    jobId: "j", roleId: "builder-1", role: "builder",
    binding: { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max-2", model: "claude-sonnet-5-5", cliVersion: "2.1.286" },
    cwd: wt, prompt: "Do it.", system: "ROLE RULES.", readOnly: false, session: { mode: "new", id: SESSION }, policy: allowAll,
    signal: new AbortController().signal, onEvent: (e) => events.push(e), limits: { wallMs: 5000, maxTurns: 40, inputTimeoutMs: 400 }, stopAtWindowPercent: 95, creditsAllowed: false, ...over,
  });
  return { proc, handle, events };
}

describe("context helper: the Claude runner", () => {
  test("OFF: the launch args are exactly what they were before the helper existed", async () => {
    const { proc, handle } = run({});
    await handle.done;
    const systemFile = proc.args[proc.args.indexOf("--append-system-prompt-file") + 1];
    // The argv as it was at 1 Oct 2026 before this change (literal copy).
    const before = [
      "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--permission-prompt-tool", "stdio", "--permission-mode", "manual", "--model", "claude-sonnet-5-5",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--restricted", "--settings", '{"disableAllHooks":true}',
      "--tools", "Read,Edit,Write,Glob,Grep,Bash,NotebookEdit,AskUserQuestion", "--max-turns", "40", "--append-system-prompt-file", systemFile,
      "--disallowedTools", "Monitor", "Task", "Agent", "Skill", "Bash(git push:*)", "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(git reset:*)", "Bash(git config:*)", "Bash(git worktree:*)", "Bash(vercel:*)", "Bash(gh:*)",
      "--session-id", SESSION,
    ];
    expect(proc.args).toEqual(before);
    expect(claudeArgs({ binding: { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max-2", model: "claude-sonnet-5-5", cliVersion: "x" }, readOnly: false, session: { mode: "new", id: SESSION }, limits: { wallMs: 1, maxTurns: 40, inputTimeoutMs: 1 } }, systemFile)).toEqual(before);
  });
  test("OFF: an MCP tool is still presented to policy as MCP and refused", async () => {
    const seen: string[] = [];
    const { handle, proc } = run({ steps: [{ tool: `${P}ctx_execute`, input: { language: "shell", code: "git push" } }] }, { policy: (r) => { seen.push(r.kind); return base(r); } });
    await handle.done;
    expect(seen).toEqual(["mcp"]);
    expect(proc.decisions[0].behavior).toBe("deny");
  });
  test("ON: only the argv differs in the MCP config and the extra disallowed tools; hooks stay off, restricted stays on", async () => {
    const off = run({}); await off.handle.done;
    const on = run({}, { contextHelper: { kind: "context-mode", dataDir: join(root, "d-on"), installDir: install } }); await on.handle.done;
    const norm = (a: string[]) => a.filter((x, i) => a[i - 1] !== "--mcp-config" && a[i - 1] !== "--append-system-prompt-file" && !CM_DISALLOWED.includes(x));
    expect(norm(on.proc.args)).toEqual(norm(off.proc.args));
    expect(on.proc.args.filter((x) => CM_DISALLOWED.includes(x))).toEqual(CM_DISALLOWED);
    expect(Object.keys(JSON.parse(on.proc.args[on.proc.args.indexOf("--mcp-config") + 1]).mcpServers)).toEqual(["context-mode"]);
    expect(on.proc.args).toContain("--restricted");
    expect(on.proc.args).toContain("--strict-mcp-config");
    expect(JSON.parse(on.proc.args[on.proc.args.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true });
    const tools = on.proc.args[on.proc.args.indexOf("--tools") + 1];
    expect(tools).toBe(off.proc.args[off.proc.args.indexOf("--tools") + 1]);
  });
  test("ON: the helper's shell tools get the Bash verdict, its other tools are refused, and the decision reaches Claude", async () => {
    const { handle, proc, events } = run({
      steps: [
        { tool: `${P}ctx_execute`, input: { language: "shell", code: "node test.js" } },
        { tool: `${P}ctx_execute`, input: { language: "python", code: "print(1)" } },
        { tool: `${P}ctx_batch_execute`, input: { commands: [{ label: "a", command: "git push origin main" }], queries: ["x"] } },
        { tool: `${P}ctx_fetch_and_index`, input: { url: "https://example.com" } },
        { tool: `${P}ctx_search`, input: { queries: ["x"] } },
      ],
    }, { policy: base, contextHelper: { kind: "context-mode", dataDir: join(root, "d-on2"), installDir: install } });
    await handle.done;
    expect(proc.decisions.map((d) => d.behavior)).toEqual(["allow", "deny", "deny", "deny", "allow"]);
    expect(events.filter((e) => e.type === "policy").map((e: any) => e.verdict.decision)).toEqual(["auto-allow", "auto-deny", "auto-deny", "auto-deny", "auto-allow"]);
  });
  test("ON but the helper is not installed: the run proceeds exactly as OFF, with a one-line notice", async () => {
    const off = run({}); await off.handle.done;
    const { handle, proc, events } = run({}, { contextHelper: { kind: "context-mode", dataDir: join(root, "d-none"), installDir: join(root, "nope") } });
    await handle.done;
    expect(proc.args[proc.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(proc.args.length).toBe(off.proc.args.length);
    expect(events.some((e) => e.type === "step" && e.label === "Context helper not used")).toBe(true);
  });
  test("ON: the system file carries the one-paragraph guidance; OFF it does not", async () => {
    const seen: string[] = [];
    for (const helper of [false, true]) {
      const proc = new FakeClaude({});
      const { spawn } = fakeSpawn(proc);
      const wrapSpawn = ((c: string, a: string[], o: unknown) => { seen.push(readFileSync(a[a.indexOf("--append-system-prompt-file") + 1], "utf8")); return (spawn as any)(c, a, o); }) as any;
      const h = claudeRunner({ binary: "C:/fake/claude.exe", spawn: wrapSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 50, tempDir: root, contextRuntime: "C:/bun.exe" }).start({
        jobId: "j", roleId: "b", role: "builder", binding: { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max-2", model: "claude-sonnet-5-5", cliVersion: "x" },
        cwd: wt, prompt: "Do it.", system: "ROLE RULES.", readOnly: false, session: { mode: "new", id: SESSION }, policy: allowAll, signal: new AbortController().signal, onEvent: () => {},
        limits: { wallMs: 5000, maxTurns: 40, inputTimeoutMs: 400 }, stopAtWindowPercent: 95, creditsAllowed: false,
        ...(helper ? { contextHelper: { kind: "context-mode" as const, dataDir: join(root, "d-sys"), installDir: install } } : {}),
      });
      await h.done;
    }
    expect(seen[0]).toBe("ROLE RULES.");
    expect(seen[1]).toContain("ROLE RULES.");
    expect(seen[1]).toContain("CONTEXT HELPER");
  });
});

describe("context helper: the opt-in switch", () => {
  test("coding-prefs: absent = off; \"context-mode\" = on; anything else is refused", async () => {
    const { validatePrefs, DEFAULT_CODING_PREFS } = await import("../role-choice");
    expect(DEFAULT_CODING_PREFS.contextHelper).toBeUndefined();
    expect(validatePrefs({}).contextHelper).toBeUndefined();
    expect(validatePrefs({ contextHelper: "context-mode" }).contextHelper).toBe("context-mode");
    expect(() => validatePrefs({ contextHelper: "other" })).toThrow();
    expect(() => validatePrefs({ contextHelper: true })).toThrow();
  });
});

describe("context helper data location and cleanup", () => {
  test("the default data root is under the coding data dir, never a fixed drive; a job's dir deletes with all its roles", async () => {
    const { contextDataRootFor, contextDataName, removeContextJobData } = await import("./context-helper");
    const dataRoot = contextDataRootFor(join(root, "mu-data", "coding"));
    expect(dataRoot).toBe(join(root, "mu-data", "coding", "context-mode"));
    expect(dataRoot).not.toMatch(/^[A-Za-z]:[\/]prog-scratch/);
    const a = join(dataRoot, contextDataName("job-1", "builder"), "store");
    const b = join(dataRoot, contextDataName("job-1", "reviewer"), "store");
    const c = join(dataRoot, contextDataName("job-2", "builder"), "store");
    for (const d of [a, b, c]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "x.db"), "raw"); }
    expect(removeContextJobData(dataRoot, "job-1")).toBe(true);
    expect(existsSync(a) || existsSync(b)).toBe(false);
    expect(existsSync(c)).toBe(true);
    expect(removeContextJobData(dataRoot, "job-1")).toBe(false);
    expect(removeContextJobData(dataRoot, "..")).toBe(false); // never walks out of the root
    expect(existsSync(dataRoot)).toBe(true);
  });
});
