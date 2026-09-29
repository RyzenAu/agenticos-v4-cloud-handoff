// Three workspaces (owner, 29 Sep 2026): worktrees collapse into their project, projects map to one
// of the three, the migration backs up first, re-runs keep hand moves, and the undo deletes nothing.
// Synthetic data only, in a temp folder; git is injected.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProject, groupProjects, locateFolder, parseWorkspacesFile, projectOfFolder, type ProjectRecord } from "./three-workspaces";
import { consolidateWorkspaces, formatReport, workspacesFilePath, type GitParent } from "./consolidate-workspaces";
import { latestBackup, undoConsolidation } from "./consolidate-workspaces-undo";
import { savedGroupsReader, workspaceMiddleware } from "./plugin";

const f = (path: string, extra: Partial<ProjectRecord> = {}): ProjectRecord => ({
  key: path.replace(/[:/~.]+/g, "-"),
  displayName: path.split("/").pop(),
  path,
  sessions: 1,
  lastActiveMs: 1_000,
  lastActiveAgo: "1 h ago",
  ...extra,
});

// Shapes like the owner's list: one OS checkout, many agent worktrees, scratch, home, the hub.
const SAMPLE: ProjectRecord[] = [
  f("~/source/repos/AgenticOS-v4", { sessions: 40, lastActiveMs: 9_000, lastActiveAgo: "2 min ago" }),
  f("~/source/repos/AgenticOS-v4-wt/t6c"),
  f("~/source/repos/AgenticOS-v4-wt/receptionist", { sessions: 3 }),
  f("~/source/repos/AgenticOS-v4-wt/w2-rx-dash"),
  f("D:/MU-Receptionist-wt-sms", { sessions: 2 }),
  f("~/source/repos/muv-marketing-wt-design"),
  f("~/source/repos/aldergate/.claude/worktrees/hero"),
  f("~/source/repos/MU-Workspace", { sessions: 7, lastActiveMs: 8_000 }),
  f("D:/agent-scratch/t3/probe-f1/wt"),
  f("~/AppData/Local/Temp/claude/x/scratchpad"),
  f("~", { displayName: "Home folder" }),
  f("~/source/repos/some-experiment"),
];
const projectOf = (path: string) => projectOfFolder(SAMPLE.find((s) => s.path === path)!).name;

describe("folder → project", () => {
  test("agent and Claude worktrees collapse into their parent repo", () => {
    expect(projectOf("~/source/repos/AgenticOS-v4-wt/t6c")).toBe("AgenticOS-v4");
    expect(projectOf("~/source/repos/AgenticOS-v4-wt/receptionist")).toBe("AgenticOS-v4");
    expect(projectOf("D:/MU-Receptionist-wt-sms")).toBe("MU-Receptionist");
    expect(projectOf("~/source/repos/muv-marketing-wt-design")).toBe("muv-marketing");
    expect(projectOf("~/source/repos/aldergate/.claude/worktrees/hero")).toBe("aldergate");
  });
  test("scratch and temp folders are one project; the home folder is its own", () => {
    expect(projectOf("D:/agent-scratch/t3/probe-f1/wt")).toBe("Scratch and temp folders");
    expect(projectOf("~/AppData/Local/Temp/claude/x/scratchpad")).toBe("Scratch and temp folders");
    expect(projectOf("~")).toBe("Home folder");
  });
  test("without a path, the slugged key still resolves", () => {
    expect(projectOfFolder({ key: "C--Users-X-source-repos-AgenticOS-v4" }).name).toBe("C--Users-X-source-repos-AgenticOS-v4");
  });
});

describe("project → workspace", () => {
  const where = (name: string) => classifyProject({ id: name.toLowerCase(), name });
  test("M&U's known repos", () => {
    for (const n of ["muv-marketing", "M-U-Ventures", "muv-demo-dental", "muv-demo-conveyancing", "muv-flagship-legal", "aldergate", "bianca-brown-realty", "mu-video-demos", "MU-Workspace"]) expect(where(n)).toEqual({ workspace: "websites", placement: "known" });
    expect(where("MU-Receptionist")).toEqual({ workspace: "receptionist", placement: "known" });
    for (const n of ["AgenticOS-v4", "mu-ventures-obsidian-wiki", "jarvis-next"]) expect(where(n)).toEqual({ workspace: "mu-ventures", placement: "known" });
  });
  test("rules for new repos; anything else is unmatched in M&U Ventures", () => {
    expect(where("muv-demo-plumbing").workspace).toBe("websites");
    expect(where("smith-realty").workspace).toBe("websites");
    expect(where("retell-evals").workspace).toBe("receptionist");
    expect(where("some-experiment")).toEqual({ workspace: "mu-ventures", placement: "unmatched" });
    expect(where("proxy-lab").placement).toBe("unmatched");
  });
});

describe("grouping", () => {
  test("a handful of projects per workspace; every folder in exactly one project", () => {
    const [mu, rx, web] = groupProjects(SAMPLE, null);
    expect(mu.projects.map((p) => p.name).sort()).toEqual(["AgenticOS-v4", "Home folder", "Scratch and temp folders", "some-experiment"]);
    expect(rx.projects.map((p) => p.name)).toEqual(["MU-Receptionist"]);
    expect(web.projects.map((p) => p.name).sort()).toEqual(["aldergate", "MU-Workspace", "muv-marketing"].sort());
    const folders = [mu, rx, web].flatMap((g) => g.projects.flatMap((p) => p.folders.map((x) => x.key)));
    expect(folders.sort()).toEqual(SAMPLE.map((s) => s.key).sort());
    const os = mu.projects.find((p) => p.id === "agenticos-v4")!;
    expect(os.folders).toHaveLength(4);
    expect(os.sessions).toBe(40 + 1 + 3 + 1);
    expect(os.mainFolder).toBe(SAMPLE[0].key);
    expect(mu.lastActiveAgo).toBe("2 min ago");
    expect(locateFolder([mu, rx, web], SAMPLE[1].key)?.project.name).toBe("AgenticOS-v4");
  });
  test("override > saved > rules; saved projects with no folder this week stay listed", () => {
    const saved = parseWorkspacesFile({
      version: 2,
      migratedAt: "2026-09-29T00:00:00Z",
      workspaces: [
        { id: "websites", projects: [{ id: "muv-demo-dental", name: "muv-demo-dental", placement: "known", path: "C:/r/muv-demo-dental" }] },
        { id: "receptionist", projects: [{ id: "agenticos-v4", name: "AgenticOS-v4", placement: "known" }] },
      ],
      parents: { [SAMPLE[11].key]: { id: "agenticos-v4", name: "AgenticOS-v4" } },
      overrides: { "Home": "websites", bogus: "nowhere" },
      archived: { at: "", note: "", records: [] },
    })!;
    expect(saved.overrides).toEqual({ home: "websites" });
    const [mu, rx, web] = groupProjects(SAMPLE, saved);
    expect(rx.projects.find((p) => p.id === "agenticos-v4")).toMatchObject({ placement: "saved" });
    expect(rx.projects.find((p) => p.id === "agenticos-v4")!.folders.map((x) => x.key)).toContain(SAMPLE[11].key);
    expect(web.projects.find((p) => p.id === "home")?.placement).toBe("override");
    expect(web.projects.find((p) => p.id === "muv-demo-dental")).toMatchObject({ folders: [], sessions: 0, mainFolder: null, path: "C:/r/muv-demo-dental" });
    expect(mu.projects.some((p) => p.id === "agenticos-v4")).toBe(false);
  });
  test("a broken or old-format saved file is ignored, never a crash", () => {
    expect(parseWorkspacesFile(null)).toBeNull();
    expect(parseWorkspacesFile({ version: 1, workspaces: [] })).toBeNull();
    expect(parseWorkspacesFile("x")).toBeNull();
  });
});

// ── Migration ──────────────────────────────────────────────────────────────────────────────────
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
/** Root with .operator-data and live data; `repos` holds fake repos for discovery. */
function fixture(opts: { workspaceJson?: unknown; saved?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wg-three-"));
  roots.push(root);
  mkdirSync(join(root, "os", ".operator-data"), { recursive: true });
  mkdirSync(join(root, "os", "src", "data"), { recursive: true });
  writeFileSync(join(root, "os", "src", "data", "live-data.json"), JSON.stringify({ recentProjects: SAMPLE, allProjects: [f("~/source/repos/old-thing")] }));
  writeFileSync(join(root, "os", ".operator-data", "workspace.json"), JSON.stringify(opts.workspaceJson ?? { version: 1, sources: [{ id: "s1" }] }));
  if (opts.saved !== undefined) writeFileSync(workspacesFilePath(join(root, "os")), opts.saved);
  const repos = join(root, "repos");
  for (const [name, git] of [["muv-demo-dental", true], ["bianca-brown-realty", false], ["muv-demo-dental-wt-x", true], ["random-tool", true], ["not-a-repo", false]] as const) {
    mkdirSync(join(repos, name), { recursive: true });
    if (git) writeFileSync(join(repos, name, ".git"), "gitdir: x");
  }
  return { root, os: join(root, "os"), repos };
}
/** Fake git: -wt-x worktrees belong to their base; other repos are their own. */
const fakeGit: GitParent = (dir) => (existsSync(join(dir, ".git")) ? dir.replace(/-wt-x$/, "") : null);
const NOW = () => new Date("2026-09-29T04:00:00.000Z");
const LATER = () => new Date("2026-09-29T05:00:00.000Z");
const run = (x: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof consolidateWorkspaces>[0]> = {}) =>
  consolidateWorkspaces({ root: x.os, discover: [x.repos], git: (dir) => (dir.startsWith(x.root) ? fakeGit(dir) : null), home: join(x.root, "home"), now: NOW, ...extra });

describe("consolidation migration", () => {
  test("dry run writes nothing and reports projects, unmatched and every folder", () => {
    const x = fixture();
    const before = readFileSync(join(x.os, ".operator-data", "workspace.json"), "utf8");
    const r = run(x);
    expect(r.applied).toBe(false);
    expect(existsSync(workspacesFilePath(x.os))).toBe(false);
    expect(existsSync(join(x.os, ".operator-data", "backups"))).toBe(false);
    expect(r.records).toBe(SAMPLE.length + 1);
    expect(r.counts).toEqual({ "mu-ventures": 5, receptionist: 1, websites: 5 });
    // discovery: known folders (even without git) and rule matches; never random repos
    const web = r.projects.filter((p) => p.to === "websites").map((p) => p.name).sort();
    expect(web).toEqual(["aldergate", "bianca-brown-realty", "MU-Workspace", "muv-demo-dental", "muv-marketing"].sort());
    expect(r.projects.some((p) => p.name === "random-tool" || p.name === "not-a-repo")).toBe(false);
    expect(r.unmatched.map((p) => p.name).sort()).toEqual(["old-thing", "some-experiment"]);
    expect(r.mapping.find((m) => m.folder === "t6c")).toMatchObject({ project: "AgenticOS-v4", to: "mu-ventures", resolvedBy: "path" });
    const report = formatReport(r);
    expect(report).toContain("## Unmatched");
    expect(report).toContain("  Websites: 5 projects");
    expect(readFileSync(join(x.os, ".operator-data", "workspace.json"), "utf8")).toBe(before);
  });

  test("git decides the parent of a folder that still exists", () => {
    const x = fixture();
    const wt = join(x.root, "home", "source", "repos", "some-experiment");
    mkdirSync(wt, { recursive: true });
    const r = run(x, { git: (dir) => (dir.replace(/\\/g, "/").endsWith("some-experiment") ? "C:/r/AgenticOS-v4" : dir.startsWith(x.root) ? fakeGit(dir) : null) });
    expect(r.mapping.find((m) => m.folder === "some-experiment")).toMatchObject({ project: "AgenticOS-v4", resolvedBy: "git" });
    expect(r.unmatched.map((p) => p.name)).toEqual(["old-thing"]);
  });

  test("apply backs up first, writes the three and archives every old record", () => {
    const x = fixture();
    const r = run(x, { apply: true });
    expect(r.backupDir).toBe(join(x.os, ".operator-data", "backups", "workspaces-20260929T040000Z"));
    expect(readdirSync(r.backupDir!).sort()).toEqual(["manifest.json", "projects-before.json"]);
    const manifest = JSON.parse(readFileSync(join(r.backupDir!, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ kind: "workspaces-consolidation", previousFile: null });
    expect(manifest.undo).toContain("consolidate-workspaces-undo.ts");
    const saved = parseWorkspacesFile(JSON.parse(readFileSync(workspacesFilePath(x.os), "utf8")))!;
    expect(saved.workspaces.map((w) => w.projects.length)).toEqual([5, 1, 5]);
    expect(Object.keys(saved.parents)).toHaveLength(r.records);
    expect(saved.archived.records).toHaveLength(r.records);
    // the page, from the saved file, shows the same projects (discovered ones included)
    const groups = groupProjects(SAMPLE, saved);
    expect(groups.map((g) => g.projects.length)).toEqual([5, 1, 5]);
  });

  test("re-running keeps assignments and hand overrides, and backs up the previous file", () => {
    const x = fixture();
    run(x, { apply: true });
    const file = workspacesFilePath(x.os);
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited.overrides = { "some-experiment": "receptionist" };
    writeFileSync(file, JSON.stringify(edited));
    const r = run(x, { apply: true, now: LATER });
    expect(readdirSync(r.backupDir!).sort()).toEqual(["manifest.json", "projects-before.json", "workspaces.json.before"]);
    expect(r.projects.find((p) => p.id === "some-experiment")).toMatchObject({ to: "receptionist", placement: "override" });
    expect(r.projects.filter((p) => p.placement === "saved")).toHaveLength(r.projects.length - 1);
    expect(r.mapping.every((m) => m.resolvedBy === "saved")).toBe(true);
    expect(parseWorkspacesFile(JSON.parse(readFileSync(file, "utf8")))!.archived.at).toBe(NOW().toISOString());
  });

  test("workspace records in workspace.json, if any, are merged too", () => {
    const x = fixture({ workspaceJson: { workspaces: [{ id: "ws-dental", name: "Dental site" }] } });
    const r = run(x);
    expect(r.found.workspaceJson).toBe(1);
    expect(r.mapping.find((m) => m.key === "workspace-json:ws-dental")?.from).toBe("workspace.json");
  });

  test("a broken saved file is backed up, not trusted; a same-second re-run refuses", () => {
    const x = fixture({ saved: "{ not json" });
    expect(run(x).warnings.join(" ")).toContain("could not be parsed");
    const r = run(x, { apply: true });
    expect(readFileSync(join(r.backupDir!, "workspaces.json.before"), "utf8")).toBe("{ not json");
    expect(() => run(x, { apply: true })).toThrow("BACKUP_EXISTS");
  });
});

describe("undo", () => {
  test("after a first run: the saved file is set aside in the backup, not deleted", () => {
    const x = fixture();
    const r = run(x, { apply: true });
    const written = readFileSync(workspacesFilePath(x.os), "utf8");
    expect(latestBackup(x.os)).toBe(r.backupDir);
    expect(undoConsolidation({ root: x.os, now: LATER })).toMatchObject({ applied: false, action: "set-aside" });
    expect(existsSync(workspacesFilePath(x.os))).toBe(true);
    const u = undoConsolidation({ root: x.os, apply: true, now: LATER });
    expect(u).toMatchObject({ applied: true, action: "set-aside" });
    expect(existsSync(workspacesFilePath(x.os))).toBe(false);
    expect(readFileSync(u.keptCurrentAs!, "utf8")).toBe(written);
  });

  test("after a re-run: the previous saved file comes back and the current one is kept", () => {
    const x = fixture();
    run(x, { apply: true });
    const first = readFileSync(workspacesFilePath(x.os), "utf8");
    const second = run(x, { apply: true, now: LATER });
    const secondText = readFileSync(workspacesFilePath(x.os), "utf8");
    const u = undoConsolidation({ root: x.os, backupDir: second.backupDir!, apply: true, now: () => new Date("2026-09-29T06:00:00Z") });
    expect(u.action).toBe("restore-previous");
    expect(readFileSync(workspacesFilePath(x.os), "utf8")).toBe(first);
    expect(readFileSync(u.keptCurrentAs!, "utf8")).toBe(secondText);
  });

  test("no backup, or not a workspaces backup: nothing happens", () => {
    const x = fixture();
    expect(undoConsolidation({ root: x.os, apply: true })).toMatchObject({ applied: false, action: "nothing-to-undo" });
    const other = join(x.os, ".operator-data", "backups", "workspaces-x");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "manifest.json"), JSON.stringify({ kind: "finance" }));
    expect(undoConsolidation({ root: x.os, backupDir: other, apply: true }).error).toBe("Not a workspaces backup");
  });
});

// ── /__workspace/groups ─────────────────────────────────────────────────────────────────────────
describe("/__workspace/groups", () => {
  const call = (mw: ReturnType<typeof workspaceMiddleware>, url: string, remote = "127.0.0.1") =>
    new Promise<{ status: number; body: unknown }>((resolve) => {
      const res = { statusCode: 0, setHeader() {}, end(text: string) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
      mw({ url, method: "GET", headers: { host: "127.0.0.1:8081" }, socket: { remoteAddress: remote } } as never, res as never, () => resolve({ status: -1, body: null }));
    });

  test("answers the saved grouping, null before any migration, an error for a broken file, and keeps the guard", async () => {
    const x = fixture();
    const mw = workspaceMiddleware({} as never, undefined, savedGroupsReader(x.os));
    expect(await call(mw, "/groups")).toMatchObject({ status: 200, body: { saved: null } });
    run(x, { apply: true });
    expect(((await call(mw, "/groups")).body as { saved: { workspaces: unknown[] } }).saved.workspaces).toHaveLength(3);
    writeFileSync(workspacesFilePath(x.os), "[]");
    expect(await call(mw, "/groups")).toMatchObject({ status: 200, body: { saved: null, error: "workspaces.json is not a saved grouping" } });
    expect((await call(mw, "/groups", "10.0.0.5")).status).toBe(403);
  });
});
