import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// These tests start real bash processes; on a loaded Windows PC Git Bash takes ~15 s to spawn (the 5 s default timed out).
setDefaultTimeout(60_000);
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerStore } from "./store";
import { startComputersHub, type ComputersHub } from "./test-harness";
import { SCRIPT_PATH, type ExecResult, type HostRunner } from "./script-adapter";
import { WslLocalAdapter } from "./wsl-local";

// Defects found running two REAL desktops at once on WSL2 (programme 1 Oct, round 3, Track A).

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

describe("two computers provisioned at once share one bridge", () => {
  test("concurrent hubUrl() calls start the bridge once (the second used to fail: port already in use)", async () => {
    let routeCalls = 0;
    const runner: HostRunner = async () => {
      routeCalls++;
      await new Promise((r) => setTimeout(r, 30)); // a slow `wsl.exe ip route`, so both callers are inside hubUrl() together
      return { code: 0, stdout: "default via 127.0.0.1 dev eth0\n", stderr: "" } satisfies ExecResult;
    };
    const a = new WslLocalAdapter("kali-linux", runner, "#!/bin/sh");
    a.hubPort = await freePort();
    a.bridgePort = await freePort();
    closers.push(() => a.close());
    const urls = await Promise.all([a.hubUrl(), a.hubUrl(), a.hubUrl()]);
    expect(new Set(urls).size).toBe(1);
    expect(urls[0]).toBe(`http://127.0.0.1:${a.bridgePort}`);
    expect(routeCalls).toBe(1);
    expect(await a.hubUrl()).toBe(urls[0]); // and later calls reuse it
  });

  test("a failed start leaves nothing half-made: the next call tries again", async () => {
    let fail = true;
    const runner: HostRunner = async () => (fail ? { code: 1, stdout: "", stderr: "no route" } : { code: 0, stdout: "default via 127.0.0.1 dev eth0\n", stderr: "" });
    const a = new WslLocalAdapter("kali-linux", runner, "#!/bin/sh");
    a.hubPort = await freePort();
    a.bridgePort = await freePort();
    closers.push(() => a.close());
    await expect(a.hubUrl()).rejects.toThrow(/address/);
    fail = false;
    expect(await a.hubUrl()).toBe(`http://127.0.0.1:${a.bridgePort}`);
  });
});

const bash = spawnSync("bash", ["--version"], { windowsHide: true });
const haveBash = bash.status === 0;

describe("the display is ready when EITHER Xvfb socket exists (WSLg mounts /tmp/.X11-unix read-only)", () => {
  const ready = (n: string, env: Record<string, string>) => {
    const script = SCRIPT_PATH.replace(/\\/g, "/");
    return spawnSync("bash", [script, "display-ready", n], { env: { ...process.env, ...env }, windowsHide: true }).status;
  };
  test.skipIf(!haveBash)("file socket, abstract socket, or neither", () => {
    const dir = mkdtempSync(join(tmpdir(), "xdisp-"));
    try {
      const noFile = join(dir, "x11-empty");
      const unixTable = join(dir, "unix");
      writeFileSync(unixTable, "Num RefCount Protocol Flags Type St Inode Path\n0000: 2 0 00010000 0001 01 1 @/tmp/.X11-unix/X101\n0000: 2 0 00010000 0001 01 2 /run/foo\n");
      // abstract socket only (the WSLg case): ready
      expect(ready("101", { MU_X11_DIR: noFile, MU_PROC_NET_UNIX: unixTable })).toBe(0);
      // a different display number is not ready, and X10 must not match X101
      expect(ready("102", { MU_X11_DIR: noFile, MU_PROC_NET_UNIX: unixTable })).toBe(1);
      expect(ready("10", { MU_X11_DIR: noFile, MU_PROC_NET_UNIX: unixTable })).toBe(1);
      // neither
      expect(ready("101", { MU_X11_DIR: noFile, MU_PROC_NET_UNIX: join(dir, "missing") })).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("real-desktop launch hygiene", () => {
  test("a computer's processes are X11 only, and its resource probe counts shared pages once", () => {
    const sh = readFileSync(SCRIPT_PATH, "utf8");
    // WSLg exports WAYLAND_DISPLAY: x11vnc then exits, and a browser could draw on the owner's desktop.
    expect(sh).toMatch(/env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE -u MU_COMPUTER_NO_SANDBOX "MU_COMPUTER_KEY=\$KEY"/);
    // PSS, with RSS only as the fallback.
    expect(sh).toMatch(/smaps_rollup/);
  });
});

describe("computer.json is written by the computer's own user, so the root script validates what it uses", () => {
  test.skipIf(!haveBash)("a display, port or resolution that is not plain digits is refused before anything runs (it would reach rm and the process arguments)", () => {
    const dir = mkdtempSync(join(tmpdir(), "badcfg-"));
    try {
      const slash = (p: string) => p.split("\\").join("/");
      const home = slash(join(dir, "home"));
      for (const cfg of [{ display: "1; touch /tmp/pwned", resolution: "1280x800x24", vncPort: 6001 }, { display: "101", resolution: "1280x800x24", vncPort: "6001 -rfbauth /etc/shadow" }, { display: "101", resolution: "$(id)x800x24", vncPort: 6001 }]) {
        mkdirSync(join(home, "a-one", "cfg"), { recursive: true });
        writeFileSync(join(home, "a-one", "cfg", "computer.json"), JSON.stringify(cfg));
        const r = spawnSync("bash", [slash(SCRIPT_PATH), "start", "a-one"], { env: { ...process.env, MU_COMPUTERS_HOME: home }, encoding: "utf8", windowsHide: true });
        expect(r.status).toBe(2);
        expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual({ ok: false, error: "computer.json has an invalid display, port or resolution" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("two hubs on one host (found when Track C and Track A both ran real desktops in one distro)", () => {
  test.skipIf(!haveBash)("starting a computer on a display that another X server already holds is refused, not silently shared", () => {
    const dir = mkdtempSync(join(tmpdir(), "xhost-"));
    try {
      const slash = (p: string) => p.split("\\").join("/");
      const home = slash(join(dir, "home"));
      const bin = join(dir, "bin");
      mkdirSync(join(home, "a-one", "cfg"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(home, "a-one", "cfg", "computer.json"), JSON.stringify({ display: "101", resolution: "1280x800x24", vncPort: 6001 }));
      writeFileSync(join(bin, "Xvfb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const unixTable = join(dir, "unix");
      writeFileSync(unixTable, "Num RefCount Protocol Flags Type St Inode Path\n0000: 2 0 00010000 0001 01 1 @/tmp/.X11-unix/X101\n");
      const script = slash(SCRIPT_PATH);
      const r = spawnSync("bash", [script, "start", "a-one"], {
        env: { ...process.env, PATH: `${slash(bin)}:${process.env.PATH}`, MU_COMPUTERS_HOME: home, MU_X11_DIR: join(dir, "none"), MU_PROC_NET_UNIX: unixTable },
        encoding: "utf8",
        windowsHide: true,
      });
      expect(r.status).toBe(6);
      expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual({ ok: false, error: "display :101 is already in use by another X server" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hub can be given its own display range, and never hands out one below it", () => {
    const root = mkdtempSync(join(tmpdir(), "xstore-"));
    const saved = process.env.MU_COMPUTERS_DISPLAY_BASE;
    try {
      const mk = (base: string | undefined) => {
        if (base === undefined) delete process.env.MU_COMPUTERS_DISPLAY_BASE;
        else process.env.MU_COMPUTERS_DISPLAY_BASE = base;
        return new ComputerStore(root, join(root, "c.json"));
      };
      expect(mk(undefined).nextDisplay()).toBe(101);
      expect(mk("401").nextDisplay()).toBe(401);
      expect(mk("0").nextDisplay()).toBe(101); // nonsense falls back to the default
      const s = mk("401");
      s.put({ name: "a-one", adapter: "wsl-local", createdBy: "usman", createdAt: 1, label: "x", display: 401, resolution: "1280x800x24", desired: "running", desktop: false, handle: {}, startedAt: 1, recoveries: 0 } as never);
      expect(s.nextDisplay()).toBe(402);
    } finally {
      if (saved === undefined) delete process.env.MU_COMPUTERS_DISPLAY_BASE;
      else process.env.MU_COMPUTERS_DISPLAY_BASE = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the pid file really holds the process id (a mangled `$$` once left every pid file saying `$`, so stop and destroy killed nothing)", () => {
    const sh = readFileSync(SCRIPT_PATH, "utf8");
    expect(sh).toContain(`sh -c 'echo $$ >"$0"; exec "$@"'`); // the pid is written by the shell that then execs the real process (through setpriv + env)
  });
});

describe("a computer whose provisioning failed can still be cleaned up (round 3)", () => {
  let hub: ComputersHub | undefined;
  afterEach(async () => {
    await hub?.close();
    hub = undefined;
  });

  test("destroy and start reach the adapter with the computer's name, not an empty handle (it threw \"bad computer name\")", async () => {
    hub = await startComputersHub();
    const host = hub.host;
    const seen: { action: string; handle: Record<string, unknown> }[] = [];
    // The real adapters refuse a handle with no name; so does this stand-in.
    const named = (action: string, h: Record<string, unknown>) => {
      seen.push({ action, handle: h });
      if (typeof h.name !== "string") throw new Error("bad computer name");
    };
    host.provision = async () => {
      throw new Error("couldn't start: display :401 is already in use by another X server");
    };
    host.start = async (h) => named("start", h);
    host.destroy = async (h) => named("destroy", h);
    const made = await hub.api("usman", "POST", "/", { name: "a-one" });
    expect(made.status).toBe(502);
    expect(made.json.error).toMatch(/already in use/);
    expect(hub.computers.view("a-one").failure?.reason).toMatch(/provisioning failed/);
    // start: the adapter is given the name (it fails for its own reason here, not for a bad name)
    const started = await hub.api("usman", "POST", "/a-one/action", { action: "start" });
    expect(started.json.error ?? "").not.toMatch(/bad computer name/);
    expect(seen.find((x) => x.action === "start")?.handle).toMatchObject({ name: "a-one", display: 101, vncPort: 6001 });
    // destroy removes it
    const gone = await hub.api("usman", "POST", "/a-one/action", { action: "destroy" });
    expect(gone.status).toBe(200);
    expect(seen.find((x) => x.action === "destroy")?.handle).toMatchObject({ name: "a-one" });
    expect((await hub.api("usman", "GET", "/")).json.computers.map((c: { name: string }) => c.name)).not.toContain("a-one");
  });
});
