import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryCommand } from "../contracts";
import { cleanup, tempRoot } from "../test-fixtures";
import { commandVerdict, createPolicy, splitSegments, tokenize, unwrapShell, type PolicyContext } from "./policy";

/** A synthetic layout: a canonical checkout, a live OS checkout, and one builder's worktree. */
const root = tempRoot("coding-policy-");
const canonical = join(root, "canonical");
const live = join(root, "live-os");
const wt = join(root, "wt", "coding-abc123-builder-1");
for (const d of [canonical, live, wt, join(canonical, "node_modules", "pkg"), join(wt, "src", "app"), join(wt, "lib"), join(wt, "docs")]) mkdirSync(d, { recursive: true });
writeFileSync(join(wt, "src", "app", "page.ts"), "export {};\n");
writeFileSync(join(wt, "lib", "c.ts"), "export {};\n");
writeFileSync(join(wt, ".env"), "X=1\n");
symlinkSync(join(canonical, "node_modules"), join(wt, "node_modules"), "junction");
afterAll(() => cleanup(root));

const commands: RegistryCommand[] = [
  { id: "fx.test" as never, kind: "test", argv: ["bun", "--no-env-file", "test"], cwd: ".", timeoutMs: 60_000, counts: "bun" },
  { id: "fx.typecheck" as never, kind: "typecheck", argv: ["bunx", "tsc", "--noEmit", "-p", "."], cwd: ".", timeoutMs: 60_000 },
];
const base: PolicyContext = {
  role: "builder",
  access: "write",
  worktree: wt,
  owns: { globs: ["src/app/**"], newFiles: ["src/app/new.test.ts"] },
  commands,
  nodeModules: "junction",
  mayChangeDependencies: false,
  allowWeb: false,
  denyRead: ["docs/private/**"],
  protectedRoots: [canonical, live],
};
const builder = createPolicy(base);
const reviewer = createPolicy({ ...base, role: "reviewer", access: "read-only", owns: { globs: [], newFiles: [] } });
const tool = (t: string, input: Record<string, unknown>) => builder({ kind: "tool", tool: t, input });
const cmd = (command: string) => builder({ kind: "command", command });

describe("policy: reads", () => {
  test("reads inside the worktree are auto-allowed", () => {
    expect(tool("Read", { file_path: join(wt, "lib", "c.ts") })).toMatchObject({ decision: "auto-allow", rule: "read-in-worktree" });
    expect(tool("Grep", { pattern: "x" })).toMatchObject({ decision: "auto-allow" });
    expect(tool("Glob", { pattern: "src/**/*.ts" })).toMatchObject({ decision: "auto-allow" });
  });
  test("dependencies are readable through the node_modules junction", () => {
    expect(tool("Read", { file_path: join(wt, "node_modules", "pkg", "index.js") })).toMatchObject({ decision: "auto-allow" });
  });
  test("reads outside the worktree are denied (C1C2 limit: reads confined)", () => {
    expect(tool("Read", { file_path: join(canonical, "a.ts") })).toMatchObject({ decision: "auto-deny", rule: "read-outside-worktree" });
    expect(tool("Read", { file_path: join(wt, "..", "..", "live-os", "x") })).toMatchObject({ decision: "auto-deny" });
    expect(tool("Glob", { pattern: "../../**/*.env" })).toMatchObject({ decision: "auto-deny" });
  });
  test("secret and registry-denied paths are denied even inside the worktree", () => {
    expect(tool("Read", { file_path: join(wt, ".env") })).toMatchObject({ decision: "auto-deny", rule: "secret-path" });
    expect(tool("Read", { file_path: join(wt, "docs", "private", "plan.md") })).toMatchObject({ decision: "auto-deny", rule: "secret-path" });
    expect(cmd("cat .env")).toMatchObject({ decision: "auto-deny", rule: "secret-path" });
  });
});

describe("policy: edits", () => {
  test("owned paths and declared new files are auto-allowed", () => {
    expect(tool("Edit", { file_path: join(wt, "src", "app", "page.ts") })).toMatchObject({ decision: "auto-allow", rule: "edit-owned" });
    expect(tool("Write", { file_path: join(wt, "src", "app", "new.test.ts") })).toMatchObject({ decision: "auto-allow", rule: "edit-owned" });
  });
  test("edits outside ownership are denied with a message the agent can act on", () => {
    const v = tool("Edit", { file_path: join(wt, "lib", "c.ts") });
    expect(v).toMatchObject({ decision: "auto-deny", rule: "edit-not-owned" });
    expect(v.message).toContain("report");
  });
  test("edits in node_modules, .git, outside the worktree or on secrets are denied", () => {
    expect(tool("Write", { file_path: join(wt, "node_modules", "pkg", "x.js") })).toMatchObject({ decision: "auto-deny", rule: "dependency-install" });
    expect(tool("Write", { file_path: join(canonical, "src", "app", "page.ts") })).toMatchObject({ decision: "auto-deny", rule: "live-checkout" });
    expect(tool("Write", { file_path: join(wt, "src", "app", ".env.local") })).toMatchObject({ decision: "auto-deny", rule: "secret-path" });
  });
  test("a read-only role can't edit anything", () => {
    expect(reviewer({ kind: "tool", tool: "Edit", input: { file_path: join(wt, "src", "app", "page.ts") } })).toMatchObject({ decision: "auto-deny" });
    expect(reviewer({ kind: "command", command: "git commit -m x" })).toMatchObject({ decision: "auto-deny" });
    expect(reviewer({ kind: "command", command: "bun --no-env-file test" })).toMatchObject({ decision: "auto-deny", rule: "registry-command" });
    expect(reviewer({ kind: "command", command: "git diff HEAD~1" })).toMatchObject({ decision: "auto-allow" });
  });
  test("Codex file changes: owned allowed, pathless or unowned denied", () => {
    expect(builder({ kind: "file-change", paths: [join(wt, "src", "app", "page.ts")] })).toMatchObject({ decision: "auto-allow" });
    expect(builder({ kind: "file-change", paths: ["src/app/page.ts"] })).toMatchObject({ decision: "auto-allow" });
    expect(builder({ kind: "file-change", paths: [] })).toMatchObject({ decision: "auto-deny" });
    expect(builder({ kind: "file-change", paths: ["lib/c.ts"] })).toMatchObject({ decision: "auto-deny", rule: "edit-not-owned" });
    expect(builder({ kind: "file-change", paths: ["src/app/page.ts"], grantRoot: live })).toMatchObject({ decision: "auto-deny", rule: "live-checkout" });
  });
});

describe("policy: commands", () => {
  test("registry commands by argv prefix", () => {
    expect(cmd("bun --no-env-file test src/app/page.test.ts")).toMatchObject({ decision: "auto-allow", rule: "registry-command" });
    expect(cmd("bunx tsc --noEmit -p .")).toMatchObject({ decision: "auto-allow", rule: "registry-command" });
    expect(cmd("bun test")).toMatchObject({ decision: "escalate" });
  });
  test("local git is allowed; git add/commit only for owned paths", () => {
    expect(cmd("git status")).toMatchObject({ decision: "auto-allow", rule: "git-local-safe" });
    expect(cmd("git diff --stat && git log --oneline -3")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("git add src/app/page.ts")).toMatchObject({ decision: "auto-allow" });
    expect(cmd('git add -- src/app/page.ts && git commit -m "fix: tz grouping"')).toMatchObject({ decision: "auto-allow" });
    expect(cmd("git add lib/c.ts")).toMatchObject({ decision: "auto-deny", rule: "edit-not-owned" });
    expect(cmd("git add -A")).toMatchObject({ decision: "auto-deny", rule: "git-consequential" });
    expect(cmd("git add .")).toMatchObject({ decision: "auto-deny" });
    expect(cmd("git commit -am x")).toMatchObject({ decision: "auto-deny" });
    expect(cmd("git commit -a -m x")).toMatchObject({ decision: "auto-deny" });
  });
  test("consequential git, git config and worktree commands are denied", () => {
    for (const c of ["git push origin HEAD", "git merge main", "git rebase main", "git reset --hard", "git stash", "git checkout -- x", "git restore x", "git clean -fd", "git switch main", "git fetch", "git branch -D x"])
      expect(cmd(c)).toMatchObject({ decision: "auto-deny", rule: "git-consequential" });
    expect(cmd("git config core.fsmonitor evil")).toMatchObject({ decision: "auto-deny", rule: "git-config" });
    expect(cmd("git worktree add x")).toMatchObject({ decision: "auto-deny", rule: "git-config" });
    expect(cmd("git worktree add ../x")).toMatchObject({ decision: "auto-deny" });
    expect(cmd("git -c core.pager=evil log")).toMatchObject({ decision: "auto-deny", rule: "git-config" });
    expect(cmd(`git --git-dir=${join(canonical, ".git")} status`)).toMatchObject({ decision: "auto-deny" });
  });
  test("package installs in a junctioned tree are denied", () => {
    for (const c of ["bun install", "bun add zod", "npm i left-pad", "pnpm add x", "npx -y create-thing"]) expect(cmd(c)).toMatchObject({ decision: "auto-deny", rule: "dependency-install" });
    const own = createPolicy({ ...base, nodeModules: "real-install-only", mayChangeDependencies: true });
    expect(own({ kind: "command", command: "bun add zod" })).toMatchObject({ decision: "escalate", rule: "dependency-install" });
  });
  test("deploy tools are denied", () => {
    for (const c of ["vercel --prod", "gh pr merge 1", "npx prisma migrate deploy", "npm publish", "wrangler deploy", "docker push x"]) expect(cmd(c)).toMatchObject({ decision: "auto-deny", rule: "deploy-tool" });
  });
  test("network is denied; localhost escalates", () => {
    expect(cmd("curl https://example.com")).toMatchObject({ decision: "auto-deny", rule: "network" });
    expect(cmd("Invoke-WebRequest https://evil.test/x")).toMatchObject({ decision: "auto-deny", rule: "network" });
    expect(cmd("curl http://127.0.0.1:55432/health")).toMatchObject({ decision: "escalate", rule: "network" });
    expect(tool("WebFetch", { url: "https://docs.example.com" })).toMatchObject({ decision: "auto-deny", rule: "network" });
    expect(createPolicy({ ...base, allowWeb: true })({ kind: "tool", tool: "WebSearch", input: {} })).toMatchObject({ decision: "auto-allow" });
  });
  test("recursive deletes, links and system tools are denied; single owned deletes allowed", () => {
    for (const c of ["rm -rf src", "Remove-Item -Recurse src", "rd /s /q src", "rm -r src/app", "del /s x", "mklink /J x y", "New-Item -ItemType Junction -Path x -Target y", "icacls x", "taskkill /f /im node.exe"])
      expect(cmd(c)).toMatchObject({ decision: "auto-deny", rule: "destructive-fs" });
    expect(cmd("rm src/app/page.ts")).toMatchObject({ decision: "auto-allow", rule: "edit-owned" });
    expect(cmd("rm lib/c.ts")).toMatchObject({ decision: "auto-deny" });
    expect(cmd("rm src/app/*.ts")).toMatchObject({ decision: "auto-deny" });
  });
  test("the words source/eval/iex are refused as commands but are data inside a quoted commit message (job 674f43)", () => {
    // The refusal that stranded a creative job's staged commit: "source note" in a double-quoted message.
    expect(cmd('git commit -q -m "Correct brief source note and speech-rate wording"')).toMatchObject({ decision: "auto-allow", rule: "git-local-safe" });
    expect(cmd('git commit -m "Explain why eval is avoided" -m "iex and Invoke-Expression too"')).toMatchObject({ decision: "auto-allow" });
    for (const c of ["source ./x.sh", "eval ls", "git status && source x", 'git commit -m "note" && eval ls', 'git commit -m "$(eval ls)"', 'git commit -m "`source x`"', "iex (gc x)", 'echo "a" ; source "x"'])
      expect(cmd(c)).toMatchObject({ decision: "auto-deny", rule: "runtime-path" });
  });
  test("run-time-built paths and inline code are denied (C1C2 limit: runtime paths)", () => {
    for (const c of ['cat "$(dirname x)/../../a"', "cat `pwd`/x", "echo ${HOME}", "cat $HOME/.config/agentic-os.env", "type %USERPROFILE%\\x", "Get-Content $env:USERPROFILE\\x", "powershell -EncodedCommand ZQBjAGgAbwA=", "iex (gc x)", 'python -c "import os"', 'node -e "1"', 'ls && bash -c "cat x"', "[Environment]::GetFolderPath('x')"])
      expect(cmd(c)).toMatchObject({ decision: "auto-deny" });
    expect(cmd("echo '$HOME is literal here'")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("git status 2>$null")).toMatchObject({ decision: "auto-allow" });
    // A leading wrapper is unwrapped (Codex runs every command that way) and the inner command decided.
    expect(cmd('bash -c "cat src/app/page.ts"')).toMatchObject({ decision: "auto-allow" });
    expect(cmd('bash -c "cat .env"')).toMatchObject({ decision: "auto-deny" });
  });
  test("the live checkout is refused in every spelling (the C1 guard)", () => {
    expect(cmd(`cat "${join(live, "scripts", "a.ts")}"`)).toMatchObject({ decision: "auto-deny", rule: "live-checkout" });
    expect(cmd(`echo x > "${join(canonical, "a.ts")}"`)).toMatchObject({ decision: "auto-deny", rule: "live-checkout" });
    expect(cmd("cd ../.. && ls")).toMatchObject({ decision: "auto-deny", rule: "live-checkout" });
    expect(builder({ kind: "command", command: "ls", cwd: canonical })).toMatchObject({ decision: "auto-deny", rule: "live-checkout" });
  });
  test("redirects write: owned targets only", () => {
    expect(cmd("echo hi > src/app/out.txt")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("echo hi > lib/out.txt")).toMatchObject({ decision: "auto-deny", rule: "edit-not-owned" });
    expect(cmd("git diff > /dev/null")).toMatchObject({ decision: "auto-allow" });
  });
  test("Codex's shell wrappers are unwrapped before deciding", () => {
    expect(unwrapShell(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command 'git status'`)).toBe("git status");
    expect(unwrapShell(`bash -lc "git diff"`)).toBe("git diff");
    expect(builder({ kind: "command", command: `pwsh.exe -Command 'git push origin main'` })).toMatchObject({ decision: "auto-deny", rule: "git-consequential" });
    expect(builder({ kind: "command", command: `bash -lc "git status"` })).toMatchObject({ decision: "auto-allow" });
  });
  test("anything unclassified escalates to the owner", () => {
    expect(cmd("make build")).toMatchObject({ decision: "escalate", rule: "unclassified" });
    expect(tool("SomeNewTool", {})).toMatchObject({ decision: "escalate" });
  });
});

describe("policy: MCP, questions, permissions", () => {
  test("every MCP tool is denied, including write tools (C1C2 limit: MCP writes)", () => {
    expect(tool("mcp__filesystem__write_file", { path: join(live, "x") })).toMatchObject({ decision: "auto-deny", rule: "mcp-tool" });
    expect(tool("mcp__github__create_pull_request", {})).toMatchObject({ decision: "auto-deny", rule: "mcp-tool" });
    expect(builder({ kind: "mcp", server: "gmail" })).toMatchObject({ decision: "auto-deny", rule: "mcp-tool" });
  });
  test("questions always escalate; permissions requests are denied", () => {
    expect(tool("AskUserQuestion", { questions: [] })).toMatchObject({ decision: "escalate" });
    expect(builder({ kind: "question", questions: [{ id: "q", question: "Which?" }] })).toMatchObject({ decision: "escalate" });
    expect(builder({ kind: "permissions", permissions: { network: { enabled: true } } })).toMatchObject({ decision: "auto-deny", rule: "network" });
    expect(builder({ kind: "permissions", permissions: { fileSystem: { write: ["C:/"] } } })).toMatchObject({ decision: "auto-deny" });
  });
  test("tools that act outside the role are refused (worktrees, schedules, notifications)", () => {
    for (const t of ["EnterWorktree", "CronCreate", "RemoteTrigger", "PushNotification", "Workflow", "ScheduleWakeup"]) expect(tool(t, {})).toMatchObject({ decision: "auto-deny" });
  });
  test("bookkeeping tools are harmless", () => {
    expect(tool("TodoWrite", { todos: [] })).toMatchObject({ decision: "auto-allow", rule: "harmless-tool" });
  });
});

describe("shell parsing", () => {
  test("segments respect quotes", () => {
    expect(splitSegments(`git commit -m "a && b; c | d" && git status`)).toEqual([`git commit -m "a && b; c | d"`, "git status"]);
    expect(splitSegments(`echo "unbalanced`)).toBeNull();
  });
  test("redirect targets are found", () => {
    expect(tokenize("echo x > out.txt 2>&1").redirects).toEqual(["out.txt"]);
    expect(tokenize(`cat "a b.txt"`).words).toEqual(["cat", "a b.txt"]);
  });
  test("a verdict target is redacted", () => {
    const v = commandVerdict(base, "curl -H 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz' https://x.test");
    expect(v.target).not.toContain("sk-ant-abcdefghijklmnop");
  });
});

describe("policy: review fixes (REVIEW-T3 F1–F5)", () => {
  test("F1: Monitor and sub-agent tools are refused, not harmless", () => {
    expect(tool("Monitor", { command: "cat x" })).toMatchObject({ decision: "auto-deny" });
    for (const t of ["Task", "Agent", "Skill", "ToolSearch", "BashOutput", "KillShell", "TaskStop"]) expect(tool(t, {})).toMatchObject({ decision: "auto-deny" });
  });
  test("F2: sed prints and in-place substitutions are narrow; exec/read/write commands are not", () => {
    expect(cmd("sed -n '1,20p' src/app/page.ts")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("sed -i 's/a/b/g' src/app/page.ts")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("sed -i 's/a/b/' lib/c.ts")).toMatchObject({ decision: "auto-deny" });
    for (const c of ["sed '1e id' src/app/page.ts", "sed 's/x/y/e' src/app/page.ts", "sed 'r /etc/passwd' src/app/page.ts", "sed 'w out.txt' src/app/page.ts", "sed 's/a/b/w lib/c.ts' src/app/page.ts", "sed -f script.sed src/app/page.ts"])
      expect(cmd(c).decision).not.toBe("auto-allow");
    for (const c of [`awk '{ print > "lib/c.ts" }' src/app/page.ts`, `awk 'BEGIN { "id" | getline x }'`, `awk '{ system("id") }' src/app/page.ts`])
      expect(cmd(c).decision).not.toBe("auto-allow");
  });
  test("F2: rg --pre and git grep -O run programs and are denied; plain searches are allowed", () => {
    expect(cmd("rg -n foo src")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("rg --pre ./evil.sh foo")).toMatchObject({ decision: "auto-deny" });
    expect(cmd("rg --pre=./evil.sh foo")).toMatchObject({ decision: "auto-deny" });
    expect(cmd("rg --hostname-bin ./evil.sh foo").decision).not.toBe("auto-allow");
    expect(cmd("git grep -n foo")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("git grep -Oevil foo")).toMatchObject({ decision: "auto-deny" });
    expect(cmd("git grep --open-files-in-pager=evil foo")).toMatchObject({ decision: "auto-deny" });
  });
  test("F2: find actions that write and sort -o are not read-only", () => {
    expect(cmd("find src -name '*.ts'")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("find src -fprint lib/c.ts").decision).not.toBe("auto-allow");
    expect(cmd("find src -fprint0 x").decision).not.toBe("auto-allow");
    expect(cmd("sort -o lib/c.ts src/app/page.ts").decision).not.toBe("auto-allow");
    expect(cmd("tee lib/c.ts").decision).not.toBe("auto-allow");
  });
  test("R2: a bare secret name as a git read argument is refused like any secret path", () => {
    for (const c of ["git diff --no-index .env src/app/page.ts", "git diff --no-index src/app/page.ts .env", "git show HEAD:.env", "git diff --no-index .env.local x", "git log -p -- .env", "git diff --no-index '.env' x", "git blame .ENV"])
      expect([c, cmd(c).decision]).toEqual([c, "auto-deny"]);
    expect(cmd("git diff --no-index src/app/page.ts lib/c.ts")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("git diff HEAD~1 -- src/app/page.ts")).toMatchObject({ decision: "auto-allow" });
    expect(cmd("git show HEAD:src/app/page.ts")).toMatchObject({ decision: "auto-allow" });
  });
  test("R3: index-stage forms and drive-relative paths are refused", () => {
    for (const c of ["git show :0:.env", "git show :2:.env.local", "git show :.env", "git cat-file -p :0:.env"])
      expect([c, cmd(c).decision]).toEqual([c, "auto-deny"]);
    expect(cmd("git show :0:src/app/page.ts")).toMatchObject({ decision: "auto-allow" });
    if (process.platform === "win32") {
      for (const c of ["git show C:secret", "git diff --no-index C:secret src/app/page.ts", "cat C:secret", "type D:notes.txt"])
        expect([c, cmd(c).decision]).toEqual([c, "auto-deny"]);
      expect(tool("Read", { file_path: "C:secret" })).toMatchObject({ decision: "auto-deny" });
    }
  });
  test("F3: git commit -F/-t paths outside the worktree are refused", () => {
    expect(cmd(`git commit -F "${join(canonical, "secret.txt")}"`)).toMatchObject({ decision: "auto-deny" });
    expect(cmd(`git commit -t ../../live-os/x`)).toMatchObject({ decision: "auto-deny" });
    expect(cmd(`git commit --file=${join(live, "a")}`)).toMatchObject({ decision: "auto-deny" });
    expect(cmd("git commit -F .env").decision).toBe("auto-deny");
  });
  test("F4: builders can't write agent config (.claude, .codex, AGENTS.md, hooks)", () => {
    const wide = createPolicy({ ...base, owns: { globs: ["**"], newFiles: [] } });
    for (const p of [".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/x.ps1", ".codex/config.toml", "AGENTS.md", "CLAUDE.md", ".mcp.json", ".husky/pre-commit", ".github/workflows/ci.yml", "src/app/CLAUDE.md"])
      expect(wide({ kind: "tool", tool: "Write", input: { file_path: join(wt, p) } })).toMatchObject({ decision: "auto-deny", rule: "agent-config" });
    expect(wide({ kind: "tool", tool: "Write", input: { file_path: join(wt, ".CLAUDE", "settings.json") } })).toMatchObject({ decision: "auto-deny", rule: "agent-config" });
    expect(wide({ kind: "command", command: "echo {} > .claude/settings.local.json" })).toMatchObject({ decision: "auto-deny" });
    expect(wide({ kind: "file-change", paths: [".codex/config.toml"] })).toMatchObject({ decision: "auto-deny", rule: "agent-config" });
    expect(wide({ kind: "tool", tool: "Write", input: { file_path: join(wt, "src", "app", "x.ts") } })).toMatchObject({ decision: "auto-allow" });
  });
  test("F5: deploys are refused outright via wrappers, scripts and deploy branches", () => {
    for (const c of ["npx vercel --prod", "bunx vercel deploy", "pnpm dlx wrangler deploy", "npx -y netlify-cli deploy", "npx firebase deploy", "gh release create v1", "npm run deploy", "bun run deploy:prod", "pnpm run release", "fly deploy", "node ./scripts/vercel.js"])
      expect(cmd(c)).toMatchObject({ decision: "auto-deny", rule: "deploy-tool" });
    // Through the dependency junction it is refused too (it resolves outside the worktree); pushes are never agent actions.
    expect(cmd("node node_modules/.bin/vercel")).toMatchObject({ decision: "auto-deny" });
    expect(cmd("git push origin HEAD:production")).toMatchObject({ decision: "auto-deny" });
  });
  test("Glob patterns can't climb out, and .env aliases stay secret", () => {
    expect(tool("Glob", { pattern: "**/../../**" })).toMatchObject({ decision: "auto-deny" });
    expect(tool("Glob", { pattern: "src/../../x" })).toMatchObject({ decision: "auto-deny" });
    expect(tool("Read", { file_path: join(wt, ".env.") })).toMatchObject({ decision: "auto-deny", rule: "secret-path" });
    expect(tool("Read", { file_path: join(wt, ".env::$DATA") })).toMatchObject({ decision: "auto-deny", rule: "secret-path" });
    expect(tool("Read", { file_path: join(wt, ".ENV ") })).toMatchObject({ decision: "auto-deny", rule: "secret-path" });
  });
});
