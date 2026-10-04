import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleAssignment, RoleId } from "./contracts";
import { checkOwnership, commandById, globToRegExp, isProtectedBranch, loadRegistry, ownsPath, RegistryInvalid, repoById, reposFor, validateRegistry } from "./registry";
import { cleanup, tempRoot } from "./test-fixtures";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) cleanup(r); });

const entry = () => ({
  id: "agentic-os",
  description: "this OS",
  canonicalPath: "C:\\Users\\Nebula PC\\source\\repos\\AgenticOS-v4",
  defaultBaseRef: "jarvis-voice",
  worktreeParent: "C:\\Users\\Nebula PC\\source\\repos\\AgenticOS-v4-wt",
  protectedBranches: ["main", "master", "production"],
  remotes: [{ name: "origin", class: "production", vercelLinked: true }, { name: "backup", class: "backup-private", vercelLinked: false }],
  commands: [
    { id: "aos.test", kind: "test", argv: ["bun", "--no-env-file", "test", "scripts"], cwd: ".", timeoutMs: 900_000, counts: "bun" },
    { id: "aos.typecheck", kind: "typecheck", argv: ["bunx", "tsc", "--noEmit", "-p", "."], cwd: ".", timeoutMs: 600_000, counts: "none" },
  ],
  nodeModules: "junction",
  allowedPeople: ["usman", "mehroz"],
});
const registry = (...repos: object[]) => ({ version: 1, repos });
const errorsOf = (value: unknown) => { try { validateRegistry(value); return []; } catch (e) { return (e as RegistryInvalid).errors.map((x) => `${x.path}: ${x.message}`); } };

describe("repo registry validation", () => {
  test("a well-formed entry validates and is queryable", () => {
    const r = validateRegistry(registry(entry()));
    expect(repoById(r, "agentic-os")?.defaultBaseRef).toBe("jarvis-voice");
    expect(commandById(r.repos[0], "aos.test")?.argv).toEqual(["bun", "--no-env-file", "test", "scripts"]);
    expect(reposFor(r, "mehroz").map((x) => x.id)).toEqual(["agentic-os"]);
    expect(reposFor(r, "someone-else")).toEqual([]);
    expect(isProtectedBranch(r.repos[0], "refs/heads/main")).toBe(true);
    expect(isProtectedBranch(r.repos[0], "coding/x-abcdef")).toBe(false);
  });
  test("commands must be exact argv of a real program: no shells, shims, free text or escaping cwd", () => {
    const bad = (command: object) => errorsOf(registry({ ...entry(), commands: [{ id: "aos.x", kind: "test", argv: ["bun"], cwd: ".", timeoutMs: 60_000, ...command }] }));
    expect(bad({ argv: ["cmd.exe", "/c", "bun test"] }).join()).toContain("not a shell");
    expect(bad({ argv: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "x"] }).join()).toContain("not a shell");
    expect(bad({ argv: ["bash", "-c", "rm -rf /"] }).join()).toContain("not a shell");
    expect(bad({ argv: ["C:\\npm\\codex.cmd"] }).join()).toContain(".cmd/.bat");
    expect(bad({ argv: "bun test" }).join()).toContain("argv");
    expect(bad({ argv: [] }).join()).toContain("argv");
    expect(bad({ cwd: "..\\other" }).join()).toContain("cwd");
    expect(bad({ cwd: "C:\\" }).join()).toContain("cwd");
    expect(bad({ timeoutMs: 10 }).join()).toContain("timeoutMs");
    expect(bad({ id: "test" }).join()).toContain(".id");
    expect(bad({ shell: true }).join()).toContain('unknown field "shell"');
  });
  test("remotes: anything Vercel-linked is production; protected branches always include main/master/production", () => {
    expect(errorsOf(registry({ ...entry(), remotes: [{ name: "origin", class: "backup-private", vercelLinked: true }] })).join()).toContain("always production");
    expect(errorsOf(registry({ ...entry(), protectedBranches: ["main"] })).join()).toContain("must include master");
  });
  test("worktrees never live inside the canonical checkout; paths are absolute; ids and people are ids", () => {
    expect(errorsOf(registry({ ...entry(), worktreeParent: "C:\\Users\\Nebula PC\\source\\repos\\AgenticOS-v4\\wt" })).join()).toContain("outside the canonical");
    expect(errorsOf(registry({ ...entry(), canonicalPath: "relative/path" })).join()).toContain("absolute");
    expect(errorsOf(registry({ ...entry(), id: "Agentic OS" })).join()).toContain(".id");
    expect(errorsOf(registry({ ...entry(), allowedPeople: ["Usman Khan"] })).join()).toContain("person ids");
  });
  test("duplicates and unknown fields refuse the whole registry", () => {
    expect(errorsOf(registry(entry(), entry())).join()).toContain("unique");
    expect(errorsOf(registry(entry(), { ...entry(), id: "copy" })).join()).toContain("same checkout");
    expect(errorsOf({ version: 2, repos: [] }).join()).toContain("must be 1");
    expect(errorsOf({ version: 1, repos: [], extra: 1 }).join()).toContain("unknown field");
    expect(() => validateRegistry(registry({ ...entry(), nodeModules: "copy" }))).toThrow(RegistryInvalid);
  });
  test("loading: missing = empty; invalid JSON, a symlink or bad content is refused", () => {
    const root = tempRoot("coding-registry-");
    roots.push(root);
    expect(loadRegistry(join(root, "missing.json"))).toEqual({ version: 1, repos: [] });
    writeFileSync(join(root, "bad.json"), "{");
    expect(() => loadRegistry(join(root, "bad.json"))).toThrow("not valid JSON");
    writeFileSync(join(root, "good.json"), JSON.stringify(registry(entry())));
    expect(loadRegistry(join(root, "good.json")).repos).toHaveLength(1);
    let linked = true;
    try { symlinkSync(join(root, "good.json"), join(root, "link.json"), "file"); }
    catch { linked = false; } // Windows without Developer Mode can't create file symlinks
    if (linked) expect(() => loadRegistry(join(root, "link.json"))).toThrow("safely");
  });
});

describe("ownership", () => {
  const limits = { maxWallMinutes: 1, maxTurns: 1, stopAtWindowPercent: 95 };
  const role = (roleId: string, globs: string[], newFiles: string[] = [], access: RoleAssignment["access"] = "write"): RoleAssignment => ({
    roleId: roleId as RoleId, role: access === "write" ? "builder" : "reviewer", agent: null, access, owns: { globs, newFiles }, dependsOn: [], limits,
  });
  const files = ["src/app/calls/page.tsx", "src/app/calls/table.tsx", "src/lib/dates/tz.ts", "README.md"];
  test("globs: ** spans folders, * stays in one", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/x.ts")).toBe(false);
    expect(globToRegExp("src/(dashboard)/**").test("src/(dashboard)/calls/p.tsx")).toBe(true);
    expect(ownsPath({ globs: [], newFiles: ["src/new.test.ts"] }, "src/new.test.ts")).toBe(true);
  });
  test("disjoint builders pass; an overlap, an empty set, a read-only owner or an escaping path fails", () => {
    expect(checkOwnership([role("builder-1", ["src/app/calls/**"]), role("builder-2", ["src/lib/**"], ["src/lib/dates/tz.test.ts"])], files)).toEqual([]);
    expect(checkOwnership([role("builder-1", ["src/**"]), role("builder-2", ["src/lib/**"])], files).map((p) => p.code)).toContain("ownership_overlap");
    expect(checkOwnership([role("builder-1", ["nothing/**"])], files).map((p) => p.code)).toEqual(["ownership_empty"]);
    expect(checkOwnership([role("reviewer", ["src/**"], [], "read-only")], files).map((p) => p.code)).toContain("ownership_overlap");
    expect(checkOwnership([role("builder-1", ["../other/**"], ["src/x.ts"])], files).map((p) => p.code)).toContain("path_outside_repo");
    // REVIEW-T3 F4: agent and tool configuration is never owned, by glob or by name.
    for (const g of [".claude/**", ".codex/config.toml", "AGENTS.md", "**/CLAUDE.md", ".husky/**", ".github/workflows/**"])
      expect(checkOwnership([role("builder-1", [g], ["src/x.ts"])], files).map((p) => p.code)).toContain("agent_config");
    expect(checkOwnership([role("builder-1", ["src/**"], [".claude/settings.local.json"])], files).map((p) => p.code)).toContain("agent_config");
    // A declared new file claimed by two builders overlaps too.
    expect(checkOwnership([role("builder-1", [], ["src/new.ts"]), role("builder-2", ["src/*.ts"])], files).map((p) => p.code)).toContain("ownership_overlap");
  });
});
