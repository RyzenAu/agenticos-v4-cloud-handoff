import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The per-user logon entry. Both scripts take the folders as parameters, so the tests point them at temp
// folders: the real Startup folder and the real config folder are never touched, nothing is registered.

const win = process.platform === "win32";
const INSTALL = resolve(import.meta.dir, "install-autostart.ps1");
const UNINSTALL = resolve(import.meta.dir, "uninstall-autostart.ps1");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "autostart-"));
  dirs.push(root);
  const cfg = join(root, "cfg");
  const startup = join(root, "startup");
  mkdirSync(startup, { recursive: true });
  return { root, cfg, startup };
}
const ps = (script: string, args: string[]) => execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
const bunExe = process.execPath; // a real bun.exe path, so the script need not search for one

describe.skipIf(!win)("install-autostart.ps1 / uninstall-autostart.ps1", () => {
  test("-DryRun prints the plan and writes nothing", () => {
    const { cfg, startup } = sandbox();
    const out = ps(INSTALL, ["-DryRun", "-Bun", bunExe, "-ConfigDir", cfg, "-StartupDir", startup]);
    expect(out).toContain("DRY RUN: nothing was written");
    expect(out).toContain("run-companion.cmd");
    expect(out).toContain("MU Companion.vbs");
    expect(out).toContain("per-user, no admin");
    expect(existsSync(cfg)).toBe(false);
    expect(existsSync(join(startup, "MU Companion.vbs"))).toBe(false);
  });

  test("install writes a restarting launcher and a hidden Startup entry; uninstall removes only those (pairing and ledger stay)", () => {
    const { cfg, startup } = sandbox();
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "companion.json"), "{}");
    writeFileSync(join(cfg, "command-ledger.json"), "[]");
    ps(INSTALL, ["-Bun", bunExe, "-ConfigDir", cfg, "-StartupDir", startup]);
    const cmd = readFileSync(join(cfg, "run-companion.cmd"), "utf8");
    const vbs = readFileSync(join(startup, "MU Companion.vbs"), "utf8");
    expect(cmd).toContain(bunExe);
    expect(cmd).toContain("companion\\main.ts");
    expect(cmd).toMatch(/run >> .*companion\.log" 2>&1/);
    expect(cmd).toContain("if %ERRORLEVEL%==3 goto end"); // a revoked pairing stops for good
    expect(cmd).toContain("goto loop"); // a crash restarts
    expect(vbs).toContain("run-companion.cmd");
    expect(vbs).toMatch(/, 0, False/); // hidden window, don't wait
    const dry = ps(UNINSTALL, ["-DryRun", "-ConfigDir", cfg, "-StartupDir", startup]);
    expect(dry).toContain("would remove");
    expect(existsSync(join(startup, "MU Companion.vbs"))).toBe(true);
    const out = ps(UNINSTALL, ["-ConfigDir", cfg, "-StartupDir", startup]);
    expect(out).toContain("will not start at logon");
    expect(existsSync(join(startup, "MU Companion.vbs"))).toBe(false);
    expect(existsSync(join(cfg, "run-companion.cmd"))).toBe(false);
    expect(existsSync(join(cfg, "companion.json"))).toBe(true);
    expect(existsSync(join(cfg, "command-ledger.json"))).toBe(true);
  });

  test("uninstall when nothing is installed says so and succeeds", () => {
    const { cfg, startup } = sandbox();
    const out = ps(UNINSTALL, ["-ConfigDir", cfg, "-StartupDir", startup]);
    expect(out).toContain("not present");
  });

  test("a folder that isn't a repo with the companion in it is refused", () => {
    const { cfg, startup, root } = sandbox();
    let failed = false;
    try {
      ps(INSTALL, ["-Repo", root, "-Bun", bunExe, "-ConfigDir", cfg, "-StartupDir", startup]);
    } catch (e: any) {
      failed = true;
      expect(String(e.stdout)).toContain("no companion\\main.ts");
    }
    expect(failed).toBe(true);
    expect(existsSync(join(startup, "MU Companion.vbs"))).toBe(false);
  });
});
