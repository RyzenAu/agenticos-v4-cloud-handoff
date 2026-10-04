import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changesInLiveCheckout,
  claudeRefusal,
  codexRefusal,
  commandRefusal,
  expandPathText,
  insidePath,
  LINK_REFUSAL,
  LIVE_CHECKOUT_REFUSAL,
  OUTSIDE_TASK_REFUSAL,
  PATHLESS_CHANGE_REFUSAL,
  pathTouchesLiveCheckout,
  type LiveCheckoutGuard,
} from "./agent-jobs-guard";

// C1 (d) and review B2: every repro from REVIEW-C1C2 against REAL folders, so realpath, 8.3 names
// and junctions behave as on the owner's PC. Nothing here touches a real checkout.
const win = process.platform === "win32";
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "guard-")));
const live = join(base, "AgenticOS-LiveCheckout");
mkdirSync(join(live, "scripts"), { recursive: true });
writeFileSync(join(live, "scripts", "a.ts"), "x\n");
const legacyCwd = join(live, ".operator-data", "agent-tasks", "job-1", "claude");
const outsideCwd = join(base, "home", ".agentic-os", "agent-tasks", "job-1", "claude");
mkdirSync(legacyCwd, { recursive: true });
mkdirSync(outsideCwd, { recursive: true });
const links: string[] = [];
afterAll(() => {
  for (const link of links) try { unlinkSync(link); } catch { /* gone */ }
  rmSync(base, { recursive: true, force: true });
});
const env = { USERPROFILE: base, HOME: base, APPDATA: join(base, "AppData") };
const guards: Array<[string, LiveCheckoutGuard]> = [
  ["legacy task folder inside the checkout", { protectedRoot: live, cwd: legacyCwd, env, home: base }],
  ["task folder outside the checkout", { protectedRoot: live, cwd: outsideCwd, env, home: base }],
];

/** The Windows 8.3 short form of an existing path, or null when 8.3 names are off for the volume. */
function shortName(path: string): string | null {
  if (!win) return null;
  const r = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${path}") do @echo %~sI`], { encoding: "utf8", windowsHide: true });
  const out = (r.stdout ?? "").trim();
  return out && out.toLowerCase() !== path.toLowerCase() && out.includes("~") ? out : null;
}

describe("live-checkout guard: review B2 repros are refused", () => {
  for (const [label, g] of guards) {
    test(`${label}: climbs, chains, home/env forms and spelled-out roots`, () => {
      for (const command of [
        `echo x > "${g.cwd}/../../../../scripts/a.ts"`,
        `echo x > "${g.cwd}\\..\\..\\..\\..\\scripts\\a.ts"`,
        "cd ./../../../.. && echo x > scripts/a.ts",
        "cd .\\..\\..\\..\\.. & echo x > scripts\\a.ts",
        "pushd .. && del a.ts",
        `echo x > ~/AgenticOS-LiveCheckout/scripts/a.ts`,
        `echo x > %USERPROFILE%\\AgenticOS-LiveCheckout\\scripts\\a.ts`,
        `Set-Content $env:USERPROFILE\\AgenticOS-LiveCheckout\\scripts\\a.ts x`,
        `echo x > \${HOME}/AgenticOS-LiveCheckout/scripts/a.ts`,
        `git -C "${live}" checkout -- .`,
        `echo x > ${live.toLowerCase()}/scripts/a.ts`,
      ]) expect([command, commandRefusal(command, g)]).toEqual([command, LIVE_CHECKOUT_REFUSAL]);
    });
    test(`${label}: creating junctions, symlinks or hard links is refused outright`, () => {
      for (const command of [
        "mklink /J link %CD%\\..\\..\\..\\..",
        "cmd /c mklink /D link C:\\",
        "New-Item -ItemType Junction -Path link -Target C:\\",
        "New-Item -ItemType SymbolicLink -Path l -Value x",
        "ln -s ../../../.. link",
        "fsutil hardlink create a b",
        "python -c \"import os; os.symlink('a','b')\"",
      ]) expect([command, commandRefusal(command, g)]).toEqual([command, LINK_REFUSAL]);
    });
    test(`${label}: write tools resolve real paths`, () => {
      // A climb that lands in the checkout: 4 levels from the legacy folder, 3 more from the new one.
      const climb = g.cwd === legacyCwd ? "../../../../scripts/a.ts" : "../../../../../AgenticOS-LiveCheckout/scripts/a.ts";
      expect(insidePath(join(g.cwd, climb), live)).toBe(true);
      for (const file of [
        join(live, "scripts", "a.ts"),
        `${g.cwd}/${climb}`,
        climb,
        "~/AgenticOS-LiveCheckout/scripts/a.ts",
        "%USERPROFILE%\\AgenticOS-LiveCheckout\\scripts\\a.ts",
      ]) expect([file, claudeRefusal("Write", { file_path: file }, g)]).toEqual([file, LIVE_CHECKOUT_REFUSAL]);
      expect(claudeRefusal("Write", { file_path: join(g.cwd, "note.md") }, g)).toBeNull();
      expect(claudeRefusal("Write", { file_path: "note.md" }, g)).toBeNull();
      expect(claudeRefusal("Read", { file_path: join(live, "AGENTS.md") }, g)).toBeNull();
    });
    test(`${label}: ordinary commands in the task folder still go to the owner`, () => {
      for (const command of ["bun --version", "echo v1..v2", `type "${join(g.cwd, "note.md")}"`, "mkdir src && echo x > src/a.ts", "cd src"])
        expect([command, commandRefusal(command, g)]).toEqual([command, null]);
    });
  }

  test("a junction made inside the task folder can't be used to write into the checkout", () => {
    const g = guards[1][1];
    const link = join(g.cwd, "link");
    symlinkSync(live, link, "junction");
    links.push(link);
    expect(pathTouchesLiveCheckout(join(link, "scripts", "a.ts"), g)).toBe(true);
    expect(pathTouchesLiveCheckout("link/scripts/new.ts", g)).toBe(true);
    expect(commandRefusal("echo x > link/scripts/a.ts", g)).toBe(LIVE_CHECKOUT_REFUSAL);
  });

  test("8.3 short names (AGENTI~1) resolve to the checkout", () => {
    const short = shortName(live);
    if (!short) return; // 8.3 names disabled on this volume: nothing to bypass with
    const g = guards[1][1];
    expect(pathTouchesLiveCheckout(join(short, "scripts", "a.ts"), g)).toBe(true);
    expect(claudeRefusal("Edit", { file_path: join(short, "scripts", "a.ts") }, g)).toBe(LIVE_CHECKOUT_REFUSAL);
    expect(commandRefusal(`echo x > ${short}\\scripts\\a.ts`, g)).toBe(LIVE_CHECKOUT_REFUSAL);
  });

  test("UNC admin-share and \\\\?\\ long-path forms resolve to the checkout", () => {
    if (!win) return;
    const g = guards[1][1];
    const drive = live.slice(0, 1);
    const unc = `\\\\localhost\\${drive}$${live.slice(2)}\\scripts\\a.ts`;
    const longForm = `\\\\?\\${live}\\scripts\\a.ts`;
    expect(expandPathText(unc, g).toLowerCase()).toBe(`${live}\\scripts\\a.ts`.toLowerCase());
    expect(claudeRefusal("Write", { file_path: unc }, g)).toBe(LIVE_CHECKOUT_REFUSAL);
    expect(claudeRefusal("Write", { file_path: longForm }, g)).toBe(LIVE_CHECKOUT_REFUSAL);
    expect(commandRefusal(`copy x "${unc}"`, g)).toBe(LIVE_CHECKOUT_REFUSAL);
  });
});

describe("review R2 regressions: unquoted UNC and Git Bash spellings", () => {
  const g = guards[1][1];
  const drive = live.slice(0, 1);
  const rest = live.slice(2); // \Users\...\AgenticOS-LiveCheckout
  const gitBash = `/${drive.toLowerCase()}${rest.replace(/\\/g, "/")}`;
  const wsl = `/mnt/${drive.toLowerCase()}${rest.replace(/\\/g, "/")}`;
  const unc = `\\\\localhost\\${drive}$${rest}`;
  test("an unquoted UNC admin-share path anywhere in the command is refused", () => {
    if (!win) return;
    for (const command of [`echo x > ${unc}\\scripts\\a.ts`, `copy note.md ${unc}\\scripts\\a.ts`, `type x>${unc}\\scripts\\a.ts`, `echo x > \\\\127.0.0.1\\${drive.toLowerCase()}$${rest}\\scripts\\a.ts`])
      expect([command, commandRefusal(command, g)]).toEqual([command, LIVE_CHECKOUT_REFUSAL]);
  });
  test("the Git Bash /c/… and WSL /mnt/c/… spellings are refused as commands and as paths", () => {
    if (!win) return;
    for (const command of [
      `echo x > "${gitBash}/scripts/a.ts"`, `echo x > ${gitBash}/scripts/a.ts`, `cp note.md '${gitBash}/scripts/a.ts'`,
      `echo x > ${wsl}/scripts/a.ts`, `rm -f ${gitBash}/scripts/a.ts`,
    ]) expect([command, commandRefusal(command, g)]).toEqual([command, LIVE_CHECKOUT_REFUSAL]);
    for (const file of [`${gitBash}/scripts/a.ts`, `${wsl}/scripts/a.ts`, `/${drive}:${rest.replace(/\\/g, "/")}/scripts/a.ts`])
      expect([file, claudeRefusal("Write", { file_path: file }, g)]).toEqual([file, LIVE_CHECKOUT_REFUSAL]);
  });
  test("ordinary commands with slash flags or Git Bash paths inside the task folder still go to the owner", () => {
    if (!win) return;
    const taskBash = `/${g.cwd.slice(0, 1).toLowerCase()}${g.cwd.slice(2).replace(/\\/g, "/")}`;
    for (const command of ["dir /b", "findstr /c:\"x\" notes.md", `echo x > "${taskBash}/note.md"`, "ls /c/Windows/System32 | head"])
      expect([command, commandRefusal(command, g)]).toEqual([command, null]);
  });
});

describe("Codex requests", () => {
  const g = guards[1][1];
  test("a file-change approval with no announced paths is refused (never a pathless card)", () => {
    expect(codexRefusal("item/fileChange/requestApproval", { itemId: "i1", reason: "patch" }, g, undefined)).toBe(PATHLESS_CHANGE_REFUSAL);
    expect(codexRefusal("item/fileChange/requestApproval", { itemId: "i1" }, g, [])).toBe(PATHLESS_CHANGE_REFUSAL);
  });
  test("announced paths are checked: live checkout and anywhere outside the task folder are refused", () => {
    expect(codexRefusal("item/fileChange/requestApproval", { itemId: "i1" }, g, [join(live, "scripts", "a.ts")])).toBe(LIVE_CHECKOUT_REFUSAL);
    expect(codexRefusal("item/fileChange/requestApproval", { itemId: "i1" }, g, [join(base, "elsewhere.txt")])).toBe(OUTSIDE_TASK_REFUSAL);
    expect(codexRefusal("item/fileChange/requestApproval", { itemId: "i1" }, g, [join(g.cwd, "a.ts"), "b.ts"])).toBeNull();
  });
  test("grant roots, permission writes and commands are resolved the same way", () => {
    expect(codexRefusal("item/fileChange/requestApproval", { grantRoot: live }, g, [join(g.cwd, "a.ts")])).toBe(LIVE_CHECKOUT_REFUSAL);
    expect(codexRefusal("item/permissions/requestApproval", { permissions: { fileSystem: { write: [join(live, "src")] } } }, g)).toBe(LIVE_CHECKOUT_REFUSAL);
    expect(codexRefusal("item/commandExecution/requestApproval", { command: "cd ../../../.. && git checkout -- ." }, g)).toBe(LIVE_CHECKOUT_REFUSAL);
    expect(codexRefusal("item/commandExecution/requestApproval", { command: "ls", cwd: g.cwd }, g)).toBeNull();
    expect(codexRefusal("item/tool/requestUserInput", { command: live }, g)).toBeNull();
  });
  test("after the fact, completed changes that landed in the checkout are reported", () => {
    expect(changesInLiveCheckout([join(live, "scripts", "a.ts"), join(g.cwd, "ok.ts")], g)).toEqual([join(live, "scripts", "a.ts")]);
  });
});
