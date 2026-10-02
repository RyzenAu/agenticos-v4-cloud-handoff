import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findSystemPythonInstalls, loadRegistry, validateRegistry, type PythonEnv, type PythonEnvRegistry } from "./python-envs";

const root = join(import.meta.dir, "..", "..");
const env = (over: Partial<PythonEnv>): PythonEnv => ({ id: "x", class: "operational", where: "windows", path: "D:/x/venv", usedBy: [], interpreterPinned: true, ...over });
const reg = (...environments: PythonEnv[]): PythonEnvRegistry => ({ environments, rules: { experimentalWslEnvsLiveUnder: "~/experiments/" } });

describe("python environment isolation", () => {
  test("the committed registry passes every rule, and keeps SearXNG operational and OpenShell experimental", () => {
    const registry = loadRegistry(root);
    expect(validateRegistry(registry)).toEqual([]);
    expect(registry.environments.find((e) => e.id === "searxng")?.class).toBe("operational");
    expect(registry.environments.find((e) => e.id === "openshell-pilot")?.class).toBe("experimental");
  });

  test("an experiment at or under an operational path is refused (the shape of the 2 Oct failure)", () => {
    const op = env({ id: "searxng", where: "wsl:kali-linux", path: "~/searxng-venv" });
    expect(validateRegistry(reg(op, env({ id: "pilot", class: "experimental", where: "wsl:kali-linux", path: "~/searxng-venv/pilot" })))[0]).toContain("overlaps operational");
    expect(validateRegistry(reg(op, env({ id: "pilot", class: "experimental", where: "wsl:kali-linux", path: "~/searxng-venv" }))).some((p) => p.includes("overlaps"))).toBe(true);
  });

  test("an experimental WSL environment must live under ~/experiments/, never loose in the distro", () => {
    expect(validateRegistry(reg(env({ id: "pilot", class: "experimental", where: "wsl:kali-linux", path: "~/pilot-venv" })))).toEqual(['experimental WSL environment "pilot" must live under ~/experiments/']);
    expect(validateRegistry(reg(env({ id: "pilot", class: "experimental", where: "wsl:kali-linux", path: "~/experiments/pilot/venv" })))).toEqual([]);
  });

  test("duplicate ids, a missing class and two operational environments on one path are refused", () => {
    expect(validateRegistry(reg(env({ id: "a" }), env({ id: "a", path: "D:/y" })))[0]).toContain("duplicate");
    expect(validateRegistry(reg(env({ id: "a", class: undefined as never })))[0]).toContain("no class");
    expect(validateRegistry(reg(env({ id: "a", path: "D:/same/venv" }), env({ id: "b", path: "D:\\Same\\venv\\" })))[0]).toContain("share the path");
  });

  test("no repo script installs into a system Python (history in comments and docs is fine)", () => {
    expect(findSystemPythonInstalls(root)).toEqual([]);
  });
});
