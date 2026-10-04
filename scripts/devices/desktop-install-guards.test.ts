import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R7 journey A guards on the installer text (scripts/windows/install-jarvis-desktop.ps1). The installer can only run on the owner's PC outside
 * the Claude sandbox, so these pin what it must keep doing. On 2 Oct 2026 it was run with `-HubUrl ... -RepoRoot <a linked worktree>`: it wrote
 * that worktree as repoRoot next to hubUrl, left the 0.1.0 app.exe in Claude desktop's package cache, and an older build that ignores hubUrl
 * then tried (and refused, in a loop) to start a local hub from the worktree.
 */
const script = readFileSync(join(import.meta.dir, "..", "windows", "install-jarvis-desktop.ps1"), "utf8");

test("remote mode never writes a real checkout as repoRoot", () => {
  const step6 = script.slice(script.indexOf("# 6. Runtime config"), script.indexOf("# 7. Point every Jarvis shortcut"));
  expect(step6).toMatch(/if \(\$remoteOnly\) \{[\s\S]*remote-mode-no-local-checkout[\s\S]*\} else \{[\s\S]*repoRoot -NotePropertyValue \$RepoRoot/);
  // the only place $RepoRoot reaches the config is the local-mode branch
  expect(step6.match(/NotePropertyValue \$RepoRoot/g)?.length).toBe(1);
});

test("stale app.exe copies in the package cache are retired (renamed after the backup), never deleted", () => {
  const backupAt = script.indexOf("Copy-Item $exe (Join-Path $backup");
  const retireAt = script.indexOf("# 4b. Remote mode only");
  expect(backupAt).toBeGreaterThan(0);
  expect(retireAt).toBeGreaterThan(backupAt);
  const block = script.slice(retireAt, script.indexOf("# 5. Install silently"));
  expect(block).toContain("Rename-Item");
  expect(block).toContain(".retired-$stamp");
  expect(block).not.toMatch(/Remove-Item/);
  expect(block).toContain("*\\Packages\\*");
});

test("remote mode lists shortcuts that still open the local hub", () => {
  expect(script).toMatch(/if \(\$remoteOnly\) \{[\s\S]*localhost:\$Port\|127\\\.0\\\.0\\\.1:\$Port[\s\S]*no longer runs/);
});

test("the installer still refuses to run inside the MSIX sandbox and never logs config values", () => {
  expect(script).toContain("redirected into");
  expect(script).toContain("values not logged");
});

test("review: retirement happens only in remote mode, and the shortcut listing searches Start Menu subfolders", () => {
  const block = script.slice(script.indexOf("# 4b. Remote mode only"), script.indexOf("# 5. Install silently"));
  expect(block).toContain("$remoteOnly -and");
  expect(script).toMatch(/-Filter \*\.lnk -Recurse/);
});
