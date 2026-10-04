import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardArgs, hostEnvFor, hubArgsFor } from "./hub-env";

const dirs: string[] = [];
const seeded = (host: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "r8c-hub-env-"));
  dirs.push(d);
  if (host !== undefined) writeFileSync(join(d, "gate-host.json"), JSON.stringify(host));
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("round 8: the acceptance runner drives the hub it was given", () => {
  test("run-all forwards --out, --data and --repo to every journey (before: only --hub and --data, so each tally was null)", () => {
    const argv = ["--hub", "http://127.0.0.1:8140", "--data", "D:\AgenticOS-r8-data\c\hub", "--out", "D:\AgenticOS-r8-data\c\out", "--repo", "D:\AgenticOS-r7-candidate", "--label", "candidate-74ace895", "--only", "routes-sweep"];
    expect(forwardArgs(argv)).toEqual(["--hub", "http://127.0.0.1:8140", "--data", "D:\AgenticOS-r8-data\c\hub", "--out", "D:\AgenticOS-r8-data\c\out", "--repo", "D:\AgenticOS-r7-candidate"]);
    expect(forwardArgs(["--label", "x"])).toEqual([]);
  });

  test("a journey that restarts its hub names its own port, data folder and served tree (never hub.ts's defaults)", () => {
    expect(hubArgsFor("http://127.0.0.1:8140", "D:\AgenticOS-r8-data\c\hub", "D:\AgenticOS-r7-candidate")).toEqual(["--port", "8140", "--data", "D:\AgenticOS-r8-data\c\hub", "--repo", "D:\AgenticOS-r7-candidate"]);
    expect(hubArgsFor("http://127.0.0.1:8128", "D:\AgenticOS-r7-data\h")).toEqual(["--port", "8128", "--data", "D:\AgenticOS-r7-data\h"]);
  });

  test("no host file, or a host-none seed: no computer environment at all", () => {
    expect(hostEnvFor(seeded(undefined))).toEqual({});
    expect(hostEnvFor(seeded({ host: "none", env: {} }), { computersHome: "/home/x/mu-computers-r8c", displayBase: "41" })).toEqual({});
  });

  test("a local-wsl seed: the distro, this run's own computers folder and display range", () => {
    const env = hostEnvFor(seeded({ host: "local-wsl", env: { MU_COMPUTERS_WSL_DISTRO: "kali-linux" } }), { computersHome: "/home/ryzen/mu-computers-r8c", displayBase: "41" });
    expect(env).toEqual({ MU_COMPUTERS_WSL_DISTRO: "kali-linux", MU_COMPUTERS_HOME: "/home/ryzen/mu-computers-r8c", WSLENV: "MU_COMPUTERS_HOME", MU_COMPUTERS_DISPLAY_BASE: "41", MU_COMPUTERS_MONITOR_MS: "5000" });
  });

  test("only MU_COMPUTERS_* names are accepted from the host file, and the computers folder is never a shared one", () => {
    expect(() => hostEnvFor(seeded({ env: { PATH: "x" } }))).toThrow(/Refusing the environment name PATH/);
    expect(() => hostEnvFor(seeded({ env: { MU_COMPUTERS_WSL_DISTRO: "kali-linux" } }), { computersHome: "/tmp/shared" })).toThrow(/computers-home/);
    // Git Bash rewrites a leading-slash argument into a Windows path: that is refused, not used.
    expect(() => hostEnvFor(seeded({ env: { MU_COMPUTERS_WSL_DISTRO: "kali-linux" } }), { computersHome: "C:/Program Files/Git/home/ryzen/mu-computers-r8c" })).toThrow(/computers-home/);
  });
});
