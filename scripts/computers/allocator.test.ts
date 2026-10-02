import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SCRIPT_PATH } from "./script-adapter";

setDefaultTimeout(120_000);

/**
 * The host-level allocator and owned cleanup (round 3b), against a REAL Linux host: they need /proc, flock-style locking, Xvfb and real pids, so they
 * run inside the WSL distro and are skipped where there is none. Every test works in its own temp folders (MU_ALLOC_DIR, MU_COMPUTERS_HOME under
 * /tmp) and its own high display numbers, and stops only processes it started.
 */

const DISTRO = process.env.MU_COMPUTERS_WSL_DISTRO || "kali-linux";
const script = readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");
const probe = process.platform === "win32" ? spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-c", "command -v python3 Xvfb x11vnc setsid >/dev/null && echo yes"], { encoding: "utf8", windowsHide: true }) : null;
const haveHost = !!probe && probe.stdout.trim() === "yes";

function wsl(cmd: string, stdin = ""): { code: number; out: string } {
  const r = spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-s"], { encoding: "utf8", input: `${cmd}\n${stdin}`, windowsHide: true });
  return { code: r.status ?? -1, out: (r.stdout ?? "").replace(/\u0000/g, "").trim() };
}

/** One script action on the host, with environment, the script on stdin (exactly how the adapter runs it). */
function ctl(env: Record<string, string>, action: string, ...args: string[]): { code: number; json: any; raw: string } {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}='${v}'`).join("\n");
  const r = spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-s", "--", action, ...args], { encoding: "utf8", input: `${exports}\n${script}`, windowsHide: true });
  const raw = (r.stdout ?? "").replace(/\u0000/g, "").trim();
  let json: any = null;
  try {
    json = JSON.parse(raw.split("\n").filter(Boolean).at(-1) ?? "");
  } catch {
    /* not JSON */
  }
  return { code: r.status ?? -1, json, raw };
}

const ROOT = `/tmp/mu-alloc-test-${process.pid}-${Date.now()}`;
beforeAll(() => {
  if (haveHost) wsl(`mkdir -p ${ROOT}`);
});
afterAll(() => {
  // Only what this run made: its own folder, and processes carrying this run's marker in their command line.
  if (haveHost) wsl(`for p in $(grep -l -a "${ROOT}" /proc/[0-9]*/cmdline 2>/dev/null | sed -n 's|^/proc/\\([0-9]*\\)/cmdline$|\\1|p' | grep -vx $$); do kill $p 2>/dev/null; done; rm -rf ${ROOT}`);
});

const env = (name: string, hub = "hubtest") => ({ MU_HUB_ID: hub, MU_ALLOC_DIR: `${ROOT}/${name}/alloc`, MU_COMPUTERS_HOME: `${ROOT}/${name}/home`, MU_DISPLAY_BASE: "700" });

describe.skipIf(!haveHost)("the host allocator (real host)", () => {
  test("two hub PROCESSES racing for displays never get the same display or port", async () => {
    const e = env("race");
    // Two separate child processes, one per hub id, each firing 10 allocations at once at the same registry.
    const child = (hub: string) =>
      new Promise<{ name: string; display: number; vncPort: number; cdpPort: number }[]>((resolve, reject) => {
        const code = `
          const { spawn } = require("node:child_process");
          const fs = require("node:fs");
          const script = fs.readFileSync(${JSON.stringify(SCRIPT_PATH)}, "utf8").replace(/\\r\\n/g, "\\n");
          const env = ${JSON.stringify({ ...e, MU_HUB_ID: hub })};
          const exp = Object.entries(env).map(([k, v]) => "export " + k + "='" + v + "'").join("\\n");
          const one = (i) => new Promise((res) => {
            const c = spawn("wsl.exe", ["-d", ${JSON.stringify(DISTRO)}, "--", "bash", "-s", "--", "alloc", "c" + i], { windowsHide: true });
            let out = ""; c.stdout.on("data", (d) => out += d); c.on("close", () => res({ name: "c" + i, ...JSON.parse(out.trim().split("\\n").pop()) }));
            c.stdin.end(exp + "\\n" + script);
          });
          Promise.all(Array.from({ length: 10 }, (_, i) => one(i))).then((r) => console.log(JSON.stringify(r)));`;
        const p = spawn(process.execPath, ["-e", code], { windowsHide: true });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("close", () => {
          try {
            resolve(JSON.parse(out.trim().split("\n").pop()!));
          } catch {
            reject(new Error("child failed: " + out.slice(0, 200)));
          }
        });
      });
    const [a, b] = await Promise.all([child("hub-a"), child("hub-b")]);
    const all = [...a, ...b];
    expect(all).toHaveLength(20);
    expect(all.every((x) => x.display >= 700)).toBe(true);
    expect(new Set(all.map((x) => x.display)).size).toBe(20);
    expect(new Set(all.map((x) => x.vncPort)).size).toBe(20);
    expect(new Set(all.map((x) => x.cdpPort)).size).toBe(20);
    // The registry agrees: 20 entries, each owned by the hub that asked.
    const list = ctl(e, "alloc-list").json.entries as { hub: string; name: string; display: number }[];
    expect(list).toHaveLength(20);
    expect(list.filter((x) => x.hub === "hub-a")).toHaveLength(10);
    expect(list.filter((x) => x.hub === "hub-b")).toHaveLength(10);
    // Asking again for the same computer returns the same numbers (idempotent), and the same name under another hub is a different computer.
    const again = ctl({ ...e, MU_HUB_ID: "hub-a" }, "alloc", "c3").json;
    expect(again.display).toBe(a.find((x) => x.name === "c3")!.display);
    const other = ctl({ ...e, MU_HUB_ID: "hub-c" }, "alloc", "c3").json;
    expect(all.map((x) => x.display)).not.toContain(other.display);
  });

  test("a display another X server holds on the host is skipped", () => {
    const e = env("busy");
    wsl(`setsid Xvfb :700 -screen 0 320x200x8 -nolisten tcp ${"-nolisten unix"} >/dev/null 2>&1 < /dev/null & disown; for i in $(seq 1 30); do grep -q '@/tmp/.X11-unix/X700$' /proc/net/unix && break; sleep 0.1; done; echo up`);
    try {
      const got = ctl(e, "alloc", "a-one").json;
      expect(got.display).toBe(701);
    } finally {
      wsl(`for p in $(ps -eo pid=,args= | awk '$2=="Xvfb" && $3==":700" {print $1}'); do kill $p; done`);
    }
  });

  test("an entry is reclaimed only when its directory is gone AND its recorded processes are dead; a stopped computer keeps its numbers", () => {
    const e = env("reclaim");
    const home = `${ROOT}/reclaim/home`;
    const keep = ctl(e, "alloc", "a-stopped").json; // 700: its folder will exist, nothing running
    const live = ctl(e, "alloc", "a-live").json; // 701: a live recorded process
    const dead = ctl(e, "alloc", "a-dead").json; // 702: dead process, folder gone
    const fresh = ctl(e, "alloc", "a-fresh").json; // 703: just allocated, nothing recorded yet, folder not made yet
    expect([keep.display, live.display, dead.display, fresh.display]).toEqual([700, 701, 702, 703]);
    wsl(`mkdir -p ${home}/a-stopped/run ${home}/a-stopped/cfg ${home}/a-live/run ${home}/a-live/cfg ${home}/a-dead/run ${home}/a-dead/cfg`);
    // a-live: a real process with a pid file; a-dead: a process that has already exited.
    wsl(`cd ${home}; nohup setsid sleep 300 >/dev/null 2>&1 < /dev/null & p=$!; disown; sleep 0.4; echo $p >/tmp/lp.$$; p=$(cat /tmp/lp.$$); echo "$p $(sed 's/^.*) //' /proc/$p/stat | awk '{print $20}')" > a-live/run/companion.pid; rm /tmp/lp.$$`);
    wsl(`cd ${home}; sleep 0.2 & p=$!; echo "$p $(sed 's/^.*) //' /proc/$p/stat | awk '{print $20}')" > a-dead/run/companion.pid; wait $p`);
    // The pid files above carry no marker, so record them straight into the registry as the script would.
    ctl(e, "alloc-record", "a-live");
    ctl(e, "alloc-record", "a-dead");
    wsl(`rm -rf ${home}/a-dead ${home}/a-live/cfg`); // a-dead's folder is gone (a destroyed computer whose release was lost); a-live's too, so only its LIVE process protects it
    wsl(`mv ${home}/a-live/run /tmp/mu-live-run-${process.pid}; rm -rf ${home}/a-live`);
    // The next allocation sweeps: a-dead is reclaimed (702 is free again) and the rest stay.
    const next = ctl(e, "alloc", "a-next").json;
    expect(next.display).toBe(702);
    const names = (ctl(e, "alloc-list").json.entries as { name: string }[]).map((x) => x.name).sort();
    expect(names).toEqual(["a-fresh", "a-live", "a-next", "a-stopped"]);
    wsl(`kill $(awk '{print $1}' /tmp/mu-live-run-${process.pid}/companion.pid) 2>/dev/null; rm -rf /tmp/mu-live-run-${process.pid}`);
  });

  test("the bridge port is per hub, stable, and skips ports the caller found busy", () => {
    const e = env("bridge");
    const a1 = ctl({ ...e, MU_HUB_ID: "hub-a" }, "alloc-bridge").json.port;
    const b1 = ctl({ ...e, MU_HUB_ID: "hub-b" }, "alloc-bridge").json.port;
    expect(a1).not.toBe(b1);
    expect(ctl({ ...e, MU_HUB_ID: "hub-a" }, "alloc-bridge").json.port).toBe(a1);
    const moved = ctl({ ...e, MU_HUB_ID: "hub-a", MU_AVOID_PORTS: String(a1) }, "alloc-bridge").json.port;
    expect(moved).not.toBe(a1);
    expect(moved).not.toBe(b1);
  });
});

describe.skipIf(!haveHost)("owned cleanup (real host): only this computer's processes are ever stopped", () => {
  const setup = (name: string, display: number) => {
    const e = env("own-" + name);
    const home = `${ROOT}/own-${name}/home`;
    wsl(`mkdir -p ${home}/${name}/cfg ${home}/${name}/run ${home}/${name}/logs && echo '{"display":"${display}","resolution":"320x200x8","vncPort":${6000 + display}}' > ${home}/${name}/cfg/computer.json`);
    return { e, home };
  };
  const procs = (pat: string) => wsl(`ps -eo pid=,args= | grep -E '${pat}' | grep -v grep | awk '{print $1}'`).out.split("\n").filter(Boolean);

  test("destroy stops this computer's Xvfb and x11vnc, and leaves a foreign Xvfb on the next display alone", () => {
    const { e, home } = setup("a-own", 761);
    // A foreign X server on the neighbouring display (no marker: it belongs to somebody else).
    wsl(`setsid Xvfb :762 -screen 0 320x200x8 -nolisten tcp -nolisten unix >/dev/null 2>&1 < /dev/null & disown; for i in $(seq 1 30); do grep -q '@/tmp/.X11-unix/X762$' /proc/net/unix && break; sleep 0.1; done`);
    try {
      const started = ctl(e, "start", "a-own"); // no companion bundle here: the display and VNC come up, then it stops with a clear error
      expect(started.code === 0 || started.code === 3).toBe(true);
      expect(procs("Xvfb :761")).toHaveLength(1);
      expect(procs("x11vnc -norc -display :761")).toHaveLength(1);
      expect(procs("Xvfb :762")).toHaveLength(1);
      expect(ctl(e, "destroy", "a-own").json.ok).toBe(true);
      expect(procs("Xvfb :761")).toHaveLength(0);
      expect(procs("x11vnc -norc -display :761")).toHaveLength(0);
      expect(wsl(`test -d ${home}/a-own && echo yes || echo no`).out).toBe("no");
      expect(procs("Xvfb :762")).toHaveLength(1); // the neighbour survived
    } finally {
      for (const p of procs("Xvfb :76[12]")) wsl(`kill ${p}`);
    }
  });

  test("a recycled pid is not killed: a pid file pointing at a stranger's process (even with its real start time) is ignored", () => {
    const { e, home } = setup("a-reuse", 763);
    wsl(`printf 'hubtest.a-reuse.abc123' > ${home}/a-reuse/cfg/owner.key`);
    // A stranger: no marker in its environment. Its pid file entry has the correct pid AND the correct start time.
    const pid = wsl(`nohup setsid sleep 300 >/dev/null 2>&1 < /dev/null & p=$!; disown; sleep 0.4; echo $p`).out;
    wsl(`echo "${pid} $(sed 's/^.*) //' /proc/${pid}/stat | awk '{print $20}')" > ${home}/a-reuse/run/companion.pid`);
    // And one that wrongly claims another start time.
    const pid2 = wsl(`nohup setsid sleep 300 >/dev/null 2>&1 < /dev/null & p=$!; disown; sleep 0.4; echo $p`).out;
    wsl(`echo "${pid2} 1" > ${home}/a-reuse/run/xvfb.pid`);
    // A genuine member: the marker is in its environment, no pid file at all (an orphaned browser).
    const mine = wsl(`MU_COMPUTER_KEY=hubtest.a-reuse.abc123 nohup setsid sleep 300 >/dev/null 2>&1 < /dev/null & p=$!; disown; sleep 0.4; echo $p`).out;
    try {
      expect(ctl(e, "stop", "a-reuse").json.ok).toBe(true);
      expect(wsl(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`).out).toBe("alive");
      expect(wsl(`kill -0 ${pid2} 2>/dev/null && echo alive || echo dead`).out).toBe("alive");
      expect(wsl(`kill -0 ${mine} 2>/dev/null && echo alive || echo dead`).out).toBe("dead"); // proven ours by its marker, so stopped
      // The probe does not count the stranger as this computer's companion either.
      expect(ctl(e, "probe", "a-reuse").json.companion).toBe(false);
    } finally {
      wsl(`kill ${pid} ${pid2} ${mine} 2>/dev/null; true`);
    }
  });
});
