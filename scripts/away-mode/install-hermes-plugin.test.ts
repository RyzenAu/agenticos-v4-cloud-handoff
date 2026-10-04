// Track 6 (REVIEW-T6 R2): the installer installs the T6 plugin variant (approval codes, plus S2d's narrow
// free-text money-ORDER relay), copies what was installed aside first, and --restore puts that copy back. TEMP
// folders only; never real Hermes.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin, pluginTarget, restorePlugin, PLUGIN_SOURCE } from "./install-hermes-plugin";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "t6-plugin-"));
  dirs.push(d);
  return d;
};

test("installs the T6 variant (codes relayed, money ORDERS put to the OS), backing up the plugin that was there; --restore puts it back", () => {
  const root = temp();
  const target = join(temp(), "plugins", "away-mode");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "__init__.py"), "# the plugin that was installed before\n");
  writeFileSync(join(target, "plugin.yaml"), "name: away-mode\n");
  writeFileSync(join(target, "relay.json"), '{"url":"http://127.0.0.1:8081/__away/telegram","tokenFile":"x"}');
  const r = installPlugin({ root, target, port: 8081, stamp: "t1" });
  expect(r.ok).toBe(true);
  const installed = readFileSync(join(target, "__init__.py"), "utf8");
  expect(installed).toBe(readFileSync(join(PLUGIN_SOURCE, "__init__.py"), "utf8"));
  expect(installed).toContain("XXXX-XXXX");
  // S2d: only money-looking free text is put to the OS; the broad S2 pre-check (word-list refusals while the
  // OS answers) is not in the installed variant.
  expect(installed).toContain("_money_order_check");
  expect(installed).not.toContain("_check_free_text");
  expect(JSON.parse(readFileSync(join(target, "relay.json"), "utf8")).url).toBe("http://127.0.0.1:8081/__away/telegram");
  expect(r.backup).toBe(join(root, ".operator-data", "away-mode", "plugin-backups", "t1"));
  expect(readFileSync(join(r.backup!, "__init__.py"), "utf8")).toBe("# the plugin that was installed before\n");
  // Rollback: exactly what was there before.
  expect(restorePlugin(r.backup!, target)).toBe(true);
  expect(readFileSync(join(target, "__init__.py"), "utf8")).toBe("# the plugin that was installed before\n");
  expect(() => restorePlugin(join(root, "nope"), target)).toThrow();
});

test("the plugin target is under Hermes' home (HERMES_HOME, else %LOCALAPPDATA%\hermes)", () => {
  expect(pluginTarget({ HERMES_HOME: "X:\h" })).toBe(join("X:\h", "plugins", "away-mode"));
  expect(pluginTarget({ LOCALAPPDATA: "X:\L" })).toBe(join("X:\L", "hermes", "plugins", "away-mode"));
});

const python = spawnSync("python", ["--version"], { encoding: "utf8" });
test.skipIf(python.status !== 0)("the installed variant's own tests: codes as before; money ORDERS refused, questions untouched, OS down fails closed for orders only", () => {
  const out = spawnSync("python", ["-m", "unittest", "test_installed_variant"], { cwd: PLUGIN_SOURCE, encoding: "utf8", timeout: 90_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect({ status: out.status, error: out.error?.message ?? null, tail: out.stderr?.slice(-600) ?? "" }).toMatchObject({ status: 0, error: null });
  expect(out.stderr).toMatch(/Ran \d+ tests[\s\S]*\nOK/);
}, 120_000);
