import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { HOST_IDENTITY_REFUSAL, SCRIPT_PATH, type ExecResult, type HostRunner } from "./script-adapter";
import { SshTunnel, isOurTunnel, type TunnelChild } from "./ssh-tunnel";
import { VpsSshAdapter, defaultSshBin } from "./vps-ssh";
import { WslLocalAdapter } from "./wsl-local";

const script = "#!/usr/bin/env bash\necho script";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Call = { argv: string[]; stdin: string; raw: string | Uint8Array | undefined };
function recorder(answer: (argv: string[], stdin: string) => Partial<ExecResult> | void = () => undefined) {
  const calls: Call[] = [];
  const runner: HostRunner = async (argv, opts) => {
    const text = typeof opts?.stdin === "string" ? opts.stdin : opts?.stdin ? Buffer.from(opts.stdin).toString("utf8") : "";
    calls.push({ argv, stdin: text, raw: opts?.stdin });
    const a = answer(argv, text) ?? {};
    return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "", ...a };
  };
  return { runner, calls };
}
const actionOf = (argv: string[]) => argv[argv.indexOf("--", argv.indexOf("bash")) + 1];

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}
function fakeSpawner() {
  const spawned: { command: string; args: string[]; child: FakeChild }[] = [];
  const spawnFn = (command: string, args: string[]) => {
    const child = new FakeChild();
    spawned.push({ command, args, child });
    return child as unknown as TunnelChild;
  };
  return { spawned, spawnFn };
}

describe("vps-ssh on a Windows host: the script runs inside WSL through wsl.exe --exec", () => {
  test("every action is ssh <alias> wsl.exe -d <distro> -u root --exec bash -s -- <action>, secrets on stdin only", async () => {
    const host = recorder((argv) => {
      const action = actionOf(argv);
      if (action === "check") return { stdout: JSON.stringify({ ok: true, host: "ryzen", present: ["Xvfb", "chromium", "x11vnc", "xdotool", "node"], missing: [] }) };
      if (action === "alloc") return { stdout: JSON.stringify({ ok: true, display: 101, vncPort: 5901, cdpPort: 9301 }) };
    });
    const a = new VpsSshAdapter("ryzen-bots", host.runner, script, undefined, { wslDistro: "kali-linux", sshBin: "ssh" });
    await a.provision({ name: "bot1", display: 101, resolution: "1280x800x24", hubUrl: "http://127.0.0.1:18091", pairingCode: "ABCD-EFGH", label: "Bot 1" });
    const prov = host.calls.find((c) => c.argv.includes("provision"))!;
    expect(prov.argv).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "ryzen-bots", "wsl.exe", "-d", "kali-linux", "-u", "root", "--exec", "bash", "-s", "--", "provision", "bot1", "101", "1280x800x24", "5901", "9301"]);
    expect(prov.argv.join(" ")).not.toMatch(/ABCD|Bot 1/);
    expect(prov.stdin).toContain("export MU_PAIR_CODE='ABCD-EFGH'");
    expect(prov.stdin).toContain("export MU_HUB_URL='http://127.0.0.1:18091'");
    // nothing cmd.exe treats as an operator can ride an argument
    for (const c of host.calls) for (const arg of c.argv) expect(arg).not.toMatch(/[&|<>^%"'`$;]/);
  });

  test("without a distro the command is the plain Linux one", async () => {
    const host = recorder();
    await new VpsSshAdapter("vps", host.runner, script, undefined, { sshBin: "ssh" }).start({ name: "x" });
    expect(host.calls[0].argv).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "vps", "bash", "-s", "--", "start", "x"]);
  });

  test("bad distro, user, alias and remote port are refused at construction", () => {
    expect(() => new VpsSshAdapter("a", undefined, script, undefined, { wslDistro: "k; calc" })).toThrow();
    expect(() => new VpsSshAdapter("a", undefined, script, undefined, { wslUser: "ro ot" })).toThrow();
    expect(() => new VpsSshAdapter("a b", undefined, script)).toThrow();
    // a leading dash would read as an option to ssh or wsl.exe
    expect(() => new VpsSshAdapter("-oProxyCommand=calc", undefined, script)).toThrow();
    expect(() => new VpsSshAdapter("a", undefined, script, undefined, { wslDistro: "-d" })).toThrow();
    expect(() => new VpsSshAdapter("a", undefined, script, undefined, { wslUser: "-u" })).toThrow();
    expect(() => new VpsSshAdapter("a", undefined, script, undefined, { remotePort: 80 })).toThrow();
  });

  test("the ssh program: MU_COMPUTERS_SSH_BIN wins; on Windows the default is Windows OpenSSH, not Git's ssh", () => {
    expect(defaultSshBin({ MU_COMPUTERS_SSH_BIN: "D:/x/ssh.exe" })).toBe("D:/x/ssh.exe");
    if (process.platform === "win32") expect(defaultSshBin({})).toBe("C:/Windows/System32/OpenSSH/ssh.exe");
  });
});

describe("bundle push", () => {
  const dir = mkdtempSync(join(tmpdir(), "lan-bundle-"));
  const file = join(dir, "companion.mjs");
  const body = "export const x = 'café ✓';\n".repeat(1000);
  writeFileSync(file, body);
  const sum = createHash("sha256").update(Buffer.from(body)).digest("hex");
  const pre = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "ryzen-bots", "wsl.exe", "-d", "kali-linux", "-u", "root", "--exec"];
  const stage = "/root/mu-computers/bundle-hub1.mjs";
  const adapter = (runner: HostRunner) => {
    const a = new VpsSshAdapter("ryzen-bots", runner, script, undefined, { wslDistro: "kali-linux", sshBin: "ssh" });
    a.hubId = "hub1";
    return a;
  };

  test("stages raw bytes under the host user's computers folder (not /tmp) with a bounded dd, verifies sha256, installs by relative name, cleans up", async () => {
    const host = recorder((argv) => (argv.includes("sha256sum") ? { stdout: `${sum}  ${stage}.new\n` } : undefined));
    await adapter(host.runner).installBundle(file);
    const [mkdir, push, verify, mv, install, rm] = host.calls;
    expect(mkdir.argv).toEqual([...pre, "mkdir", "-p", "/root/mu-computers"]);
    expect(push.argv).toEqual([...pre, "dd", `of=${stage}.new`, "bs=65536", "iflag=fullblock,count_bytes", `count=${Buffer.byteLength(body)}`, "status=none"]);
    expect(typeof push.raw).not.toBe("string"); // bytes, not a utf8 string round trip
    expect(Buffer.from(push.raw as Uint8Array).equals(Buffer.from(body))).toBe(true);
    expect(verify.argv).toEqual([...pre, "sha256sum", `${stage}.new`]);
    expect(mv.argv.slice(pre.length)).toEqual(["mv", "-f", `${stage}.new`, stage]);
    expect(install.argv.slice(pre.length, pre.length + 5)).toEqual(["bash", "-s", "--", "install-bundle", "bundle-hub1.mjs"]);
    expect(rm.argv.slice(pre.length)).toEqual(["rm", "-f", `${stage}.new`, stage]);
    for (const c of host.calls) expect(c.argv.join(" ")).not.toContain("/tmp");
  });

  test("a damaged copy is caught before anything is installed, and the staged file is removed", async () => {
    const host = recorder((argv) => (argv.includes("sha256sum") ? { stdout: `${"0".repeat(64)}  x\n` } : undefined));
    await expect(adapter(host.runner).installBundle(file)).rejects.toThrow(/damaged/);
    expect(host.calls.some((c) => c.argv.includes("install-bundle"))).toBe(false);
    expect(host.calls.at(-1)!.argv.slice(pre.length)).toEqual(["rm", "-f", `${stage}.new`, stage]);
  });

  test("a failed push says why, and still cleans up", async () => {
    const host = recorder((argv) => (argv.includes("dd") ? { code: 255, stderr: "ssh: connect to host 192.168.1.120 port 22: Connection timed out" } : undefined));
    await expect(adapter(host.runner).installBundle(file)).rejects.toThrow(/couldn't copy.*timed out/);
    expect(host.calls.at(-1)!.argv).toContain("rm");
  });

  test("a plain Linux host stages under $HOME/mu-computers (its login shell expands it)", async () => {
    const host = recorder((argv) => (argv.includes("sha256sum") ? { stdout: `${sum}  x\n` } : undefined));
    const a = new VpsSshAdapter("vps", host.runner, script, undefined, { sshBin: "ssh" });
    a.hubId = "h";
    await a.installBundle(file);
    expect(host.calls[1].argv.join(" ")).toContain("of=$HOME/mu-computers/bundle-h.mjs.new");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the supervised reverse tunnel", () => {
  test("restarts with backoff when ssh dies, is up only after it has stayed alive, and stops on close", async () => {
    const f = fakeSpawner();
    const t = new SshTunnel({ command: "ssh", args: ["-N"], spawnFn: f.spawnFn, settleMs: 15, backoffMs: [10, 20] });
    await t.ensure(2000);
    expect(t.status().state).toBe("up");
    expect(f.spawned).toHaveLength(1);
    f.spawned[0].child.stderr.emit("data", "Warning: remote port forwarding failed for listen port 18091");
    f.spawned[0].child.emit("close", 255);
    expect(t.status().state).toBe("backoff");
    expect(t.status().lastExit?.stderr).toMatch(/forwarding failed/);
    await sleep(80);
    expect(f.spawned).toHaveLength(2);
    expect(t.status().state).toBe("up");
    t.close();
    expect(f.spawned[1].child.killed).toBe(true);
    await sleep(60);
    expect(f.spawned).toHaveLength(2); // no restart after close
    expect(t.status().state).toBe("closed");
  });

  test("a tunnel that never stays up rejects ensure() but keeps retrying in the background", async () => {
    const f = fakeSpawner();
    const t = new SshTunnel({
      command: "ssh",
      args: [],
      spawnFn: (c, a) => {
        const child = f.spawnFn(c, a) as unknown as FakeChild;
        setTimeout(() => child.emit("close", 255), 5);
        return child as unknown as TunnelChild;
      },
      settleMs: 200,
      backoffMs: [5],
    });
    await expect(t.ensure(80)).rejects.toThrow(/did not come up/);
    await sleep(60);
    expect(f.spawned.length).toBeGreaterThan(2);
    t.close();
  });

  test("a spawn that throws is retried, not fatal", async () => {
    let n = 0;
    const f = fakeSpawner();
    const t = new SshTunnel({
      command: "ssh",
      args: [],
      spawnFn: (c, a) => {
        if (n++ < 2) throw new Error("spawn ssh ENOENT");
        return f.spawnFn(c, a);
      },
      settleMs: 10,
      backoffMs: [5],
    });
    await t.ensure(1000);
    expect(t.status().state).toBe("up");
    t.close();
  });
});

describe("hubUrl through the tunnel", () => {
  let hub: Server | null = null;
  let adapter: VpsSshAdapter | null = null;
  afterEach(async () => {
    await adapter?.close();
    adapter = null;
    await new Promise<void>((r) => (hub ? hub.close(() => r()) : r()));
    hub = null;
  });

  test("starts a loopback-only bridge and ONE ssh -R tunnel; the companion sees http://127.0.0.1:<remotePort>; only companion routes get through", async () => {
    const seen: string[] = [];
    hub = createServer((req, res) => (seen.push(req.url ?? ""), res.end("{}")));
    await new Promise<void>((r) => hub!.listen(0, "127.0.0.1", () => r()));
    const hubPort = (hub.address() as { port: number }).port;
    const f = fakeSpawner();
    adapter = new VpsSshAdapter("ryzen-bots", recorder().runner, script, undefined, { wslDistro: "kali-linux", sshBin: "ssh", remotePort: 18091, spawnTunnel: f.spawnFn, tunnelSettleMs: 10 });
    adapter.hubPort = hubPort;
    const [a, b] = await Promise.all([adapter.hubUrl(), adapter.hubUrl()]);
    expect(a).toBe("http://127.0.0.1:18091");
    expect(b).toBe(a);
    expect(f.spawned).toHaveLength(1); // concurrent callers share one tunnel
    const args = f.spawned[0].args;
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("ServerAliveCountMax=3");
    const m = /^127\.0\.0\.1:18091:127\.0\.0\.1:(\d+)$/.exec(args[args.indexOf("-R") + 1])!;
    expect(m).toBeTruthy();
    expect(args.slice(args.indexOf("ryzen-bots"))).toEqual(["ryzen-bots", "wsl.exe", "-d", "kali-linux", "-u", "root", "--exec", "cat"]);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).not.toContain("-N");
    // the bridge answers on loopback and forwards only the companion wire routes
    const get = (path: string) =>
      new Promise<number>((resolve) => {
        const req = request({ host: "127.0.0.1", port: Number(m[1]), path }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
        req.on("error", () => resolve(0));
        req.end();
      });
    expect(await get("/__devices/companion/heartbeat")).toBe(200);
    expect(await get("/__operator/anything")).toBe(404);
    expect(seen).toEqual(["/__devices/companion/heartbeat"]);
    // close() kills the tunnel and the bridge
    await adapter.close();
    expect(f.spawned[0].child.killed).toBe(true);
    expect(await get("/__devices/companion/heartbeat")).toBe(0);
  });

  test("a plain Linux host runs plain cat; tunnel off means the hub's own loopback", async () => {
    const plain = new VpsSshAdapter("vps", recorder().runner, script, undefined, { sshBin: "ssh" });
    expect(plain.tunnelArgs(5555).slice(-2)).toEqual(["vps", "cat"]);
    const local = new VpsSshAdapter("vps", recorder().runner, script, undefined, { sshBin: "ssh", tunnel: false });
    local.hubPort = 8123;
    expect(await local.hubUrl()).toBe("http://127.0.0.1:8123");
    await expect(plain.hubUrl()).rejects.toThrow(/ports aren't known/);
  });

  test("a dead tunnel is visible in the host check", async () => {
    const f = fakeSpawner();
    const host = recorder((argv) => (argv.includes("check") ? { stdout: JSON.stringify({ ok: true, host: "r", present: ["node"], missing: [] }) } : undefined));
    adapter = new VpsSshAdapter("ryzen-bots", host.runner, script, undefined, { sshBin: "ssh", spawnTunnel: f.spawnFn, tunnelSettleMs: 10, tunnelBackoffMs: [10_000] });
    adapter.hubPort = 1;
    await adapter.hubUrl();
    f.spawned[0].child.emit("close", 255);
    const c = await adapter.check();
    expect(c.notes.join(" ")).toMatch(/SSH tunnel to the hub is backoff/);
  });
});

describe("two hosts at once", () => {
  test("wsl-local and vps-ssh each talk to their own host: allocations never cross, even for the same computer name", async () => {
    const answer = (host: string) => (argv: string[]) => {
      const action = actionOf(argv);
      if (action === "alloc") return { stdout: JSON.stringify({ ok: true, display: 101, vncPort: 5901, cdpPort: 9301 }) };
      if (action === "check") return { stdout: JSON.stringify({ ok: true, host, present: ["node"], missing: [] }) };
    };
    const local = recorder(answer("a"));
    const lan = recorder(answer("b"));
    const w = new WslLocalAdapter("kali-linux", local.runner, script);
    const v = new VpsSshAdapter("ryzen-bots", lan.runner, script, undefined, { wslDistro: "kali-linux", sshBin: "ssh" });
    const spec = { name: "bot", display: 101, resolution: "1280x800x24", hubUrl: "http://h", pairingCode: "ABCD-EFGH", label: "b" };
    await Promise.all([w.provision(spec), v.provision(spec)]);
    // each host's own allocator (alloc.json on THAT host) was asked, by that adapter alone
    expect(local.calls.every((c) => c.argv[0] === "wsl.exe")).toBe(true);
    expect(lan.calls.every((c) => c.argv[0] === "ssh")).toBe(true);
    expect(local.calls.filter((c) => c.argv.includes("alloc"))).toHaveLength(1);
    expect(lan.calls.filter((c) => c.argv.includes("alloc"))).toHaveLength(1);
  });
});

describe("an ssh left behind by a hard-killed hub", () => {
  test("the next tunnel stops it only when its command line is this tunnel's (a reused pid is left alone), and keeps its own pid on file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lan-pid-"));
    const pidFile = join(dir, "t.pid");
    writeFileSync(pidFile, "999999");
    const asked: { pid: number; needles: string[] }[] = [];
    const f = fakeSpawner();
    const t = new SshTunnel({
      command: "ssh",
      args: [],
      spawnFn: (c, a) => Object.assign(f.spawnFn(c, a), { pid: 4321 }),
      settleMs: 5,
      pidFile,
      matchArgs: ["-R 127.0.0.1:18091:", "ryzen-bots"],
      isOurTunnel: (pid, needles) => (asked.push({ pid, needles }), false),
    });
    await t.ensure(500);
    expect(asked).toEqual([{ pid: 999999, needles: ["-R 127.0.0.1:18091:", "ryzen-bots"] }]); // looked at by command line, not by image name, and left alone
    expect(readFileSync(pidFile, "utf8")).toBe("4321");
    t.close();
    expect(existsSync(pidFile)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("isOurTunnel needs EVERY needle on the command line (an unrelated ssh with the same image name is never ours)", () => {
    // this very process is bun, not an ssh: never ours whatever the needles
    expect(isOurTunnel(process.pid, ["-R 127.0.0.1:18091:"])).toBe(false);
    expect(isOurTunnel(process.pid, [])).toBe(false);
  });
});

describe("the tunnel is up only on a positive signal", () => {
  class Echo extends EventEmitter {
    stderr = new EventEmitter();
    stdout = new EventEmitter();
    written: string[] = [];
    stdin = { write: (c: string) => (this.written.push(c), true), on: () => undefined };
    killed = false;
    pid = 1;
    kill() {
      this.killed = true;
      queueMicrotask(() => this.emit("close", null));
      return true;
    }
  }

  test("writes the marker to ssh's stdin and is up only when the remote cat echoes it; a silent ssh stays not-up and is killed", async () => {
    const made: Echo[] = [];
    const t = new SshTunnel({ command: "ssh", args: [], readyMarker: "mu-ready", settleMs: 60, backoffMs: [5], spawnFn: () => (made.push(new Echo()), made.at(-1) as unknown as TunnelChild) });
    const up = t.ensure(2000);
    await sleep(15);
    expect(made[0].written).toEqual(["mu-ready\n"]);
    expect(t.status().state).toBe("starting"); // alive for 15 ms is not proof
    made[0].stdout.emit("data", "mu-rea");
    expect(t.status().state).toBe("starting");
    made[0].stdout.emit("data", "dy\n");
    await up;
    expect(t.status().state).toBe("up");
    t.close();

    const silent: Echo[] = [];
    const t2 = new SshTunnel({ command: "ssh", args: [], readyMarker: "mu-ready", settleMs: 30, backoffMs: [5, 5], spawnFn: () => (silent.push(new Echo()), silent.at(-1) as unknown as TunnelChild) });
    await expect(t2.ensure(50)).rejects.toThrow(/did not come up/);
    await sleep(80);
    expect(silent[0].killed).toBe(true); // no echo: the attempt was abandoned and retried
    expect(silent.length).toBeGreaterThan(1);
    t2.close();
  });

  test("backoff keeps growing for a flapping tunnel and restarts from the first step only after a sustained healthy period", async () => {
    const delays: number[] = [];
    const made: Echo[] = [];
    const t = new SshTunnel({
      command: "ssh",
      args: [],
      readyMarker: "m",
      settleMs: 1000,
      healthyMs: 120,
      backoffMs: [10, 20, 40],
      onLog: (l) => /retry in (\d+) ms/.exec(l)?.[1] && delays.push(Number(/retry in (\d+) ms/.exec(l)![1])),
      spawnFn: () => {
        const e = new Echo();
        made.push(e);
        queueMicrotask(() => e.stdout.emit("data", "m\n")); // comes up instantly...
        return e as unknown as TunnelChild;
      },
    });
    await t.ensure(500);
    made[0].emit("close", 255); // ...and dies at once, three times
    await sleep(25);
    made[1].emit("close", 255);
    await sleep(40);
    made[2].emit("close", 255);
    await sleep(70);
    expect(delays.slice(0, 3)).toEqual([10, 20, 40]); // a brief "up" did not reset the backoff
    await sleep(160); // now healthy for longer than healthyMs
    made.at(-1)!.emit("close", 255);
    expect(delays.at(-1)).toBe(10);
    t.close();
  });
});

describe("computer-ctl.sh install-bundle", () => {
  test("a relative name resolves inside the computers home; '..' and missing files are refused", () => {
    const home = mkdtempSync(join(tmpdir(), "ctl-home-")).split("\\").join("/");
    writeFileSync(join(home, "bundle-h.mjs"), "export {}");
    const run = (arg: string) => spawnSync("bash", [SCRIPT_PATH.split("\\").join("/"), "install-bundle", arg], { env: { ...process.env, MU_COMPUTERS_HOME: home }, encoding: "utf8", windowsHide: true });
    expect(JSON.parse(run("bundle-h.mjs").stdout.trim())).toEqual({ ok: true });
    expect(readFileSync(join(home, "bin", "companion.mjs"), "utf8")).toBe("export {}");
    expect(run("../x").status).toBe(2);
    expect(run("nope.mjs").status).toBe(2);
    rmSync(home, { recursive: true, force: true });
  }, 90_000);
});

describe("fonts, per-computer users and the root warning", () => {
  const ok = { ok: true, host: "r", uid: 0, runAs: false, present: ["Xvfb", "chromium", "x11vnc", "xdotool", "node"], missing: [] as string[] };
  test("a host without usable fonts is reported with the install command (not a silent unreadable desktop)", async () => {
    const host = recorder((argv) => (actionOf(argv) === "check" ? { stdout: JSON.stringify({ ...ok, runAs: true, missing: ["fonts"] }) } : undefined));
    const c = await new VpsSshAdapter("ryzen-bots", host.runner, script, undefined, { wslDistro: "kali-linux", sshBin: "ssh", runAsPrefix: "mu-" }).check();
    expect(c.ok).toBe(true); // still runs; the note says what is wrong
    expect(c.missing).toContain("fonts");
    expect(c.installCommand).toContain("fonts-noto-core");
    expect(c.notes.join(" ")).toMatch(/no usable fonts.*empty boxes/);
  });

  test("root without a per-computer user warns that Chromium's sandbox cannot start; with a prefix it does not", async () => {
    const mk = (opts: object, uid = 0, runAs = false) => new VpsSshAdapter("r", recorder((a) => (actionOf(a) === "check" ? { stdout: JSON.stringify({ ...ok, uid, runAs }) } : undefined)).runner, script, undefined, { sshBin: "ssh", ...opts });
    expect((await mk({}).check()).notes.join(" ")).toMatch(/runs as root.*sandbox/);
    expect((await mk({ runAsPrefix: "mu-" }, 0, true).check()).notes.join(" ")).not.toMatch(/sandbox/);
    expect((await mk({}, 1000).check()).notes.join(" ")).not.toMatch(/sandbox/);
  });

  test("the prefix and the computers home ride the stdin header, never the command line; bad values are refused", async () => {
    const host = recorder();
    const a = new VpsSshAdapter("ryzen-bots", host.runner, script, undefined, { wslDistro: "kali-linux", sshBin: "ssh", runAsPrefix: "mu-", computersHome: "/var/lib/mu-computers" });
    await a.start({ name: "research" });
    expect(host.calls[0].stdin).toContain("export MU_RUN_AS_PREFIX='mu-'");
    expect(host.calls[0].stdin).toContain("export MU_COMPUTERS_HOME='/var/lib/mu-computers'");
    expect(host.calls[0].argv.join(" ")).not.toMatch(/mu-computers|MU_RUN/);
    expect(() => new VpsSshAdapter("r", undefined, script, undefined, { runAsPrefix: "Bad Prefix" })).toThrow();
    for (const bad of ["root", "mu", "r", "-mu-", "m-u-", "1u-"]) expect(() => new VpsSshAdapter("r", undefined, script, undefined, { runAsPrefix: bad })).toThrow(); // a prefix needs its trailing dash: "r"+"oot" must never be root
    expect(() => new VpsSshAdapter("r", undefined, script, undefined, { runAsPrefix: "mu-" })).not.toThrow();
    expect(() => new VpsSshAdapter("r", undefined, script, undefined, { computersHome: "relative/path" })).toThrow();
    expect(() => new VpsSshAdapter("r", undefined, script, undefined, { computersHome: "/a b" })).toThrow();
  });
});

describe("the companion's shot command", () => {
  test("waits for its stdout write to finish before exiting (a frame cut at 64 KiB through ssh was found on the LAN host)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "companion", "linux", "main.ts"), "utf8");
    const at = src.indexOf('cmd === "shot"');
    const body = src.slice(at, src.indexOf('cmd === "run"'));
    expect(body).toMatch(/process\.stdout\.write\(frame, \(\) => done\(\)\)/);
    expect(body.indexOf("process.stdout.write")).toBeLessThan(body.indexOf("process.exit(0)"));
  });
});

describe("a prefix with a script that is not root, and fonts without fontconfig", () => {
  const base = { ok: true, host: "r", present: ["Xvfb", "chromium", "x11vnc", "xdotool", "node"], missing: [] as string[] };
  test("the prefix being ignored is said out loud", async () => {
    const host = recorder((a) => (actionOf(a) === "check" ? { stdout: JSON.stringify({ ...base, uid: 1000, runAs: false, runAsIgnored: true }) } : undefined));
    const c = await new VpsSshAdapter("r", host.runner, script, undefined, { sshBin: "ssh", runAsPrefix: "mu-" }).check();
    expect(c.notes.join(" ")).toMatch(/prefix is set but the script is not running as root/);
  });
  test("a host without fontconfig cannot be checked and is reported as missing fonts", async () => {
    const host = recorder((a) => (actionOf(a) === "check" ? { stdout: JSON.stringify({ ...base, uid: 0, runAs: true, missing: ["fonts"] }) } : undefined));
    const c = await new VpsSshAdapter("r", host.runner, script, undefined, { sshBin: "ssh", runAsPrefix: "mu-" }).check();
    expect(c.notes.join(" ")).toMatch(/fontconfig is missing/);
  });
});

describe("an unknown or changed host key is a refusal to connect, never 'the host did not answer'", () => {
  const stderrs = {
    unknown: "Host key verification failed.\r\n",
    changed: "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\nIt is possible that someone is doing something nasty!\r\nOffending ED25519 key in C:/Users/x/.ssh/known_hosts:7\r\nHost key verification failed.\r\n",
  };
  for (const [name, stderr] of Object.entries(stderrs)) {
    test(`${name} key: loud refusal, not a timeout, nothing claimed about packages`, async () => {
      const host = recorder(() => ({ code: 255, stdout: "", stderr }));
      const c = await new VpsSshAdapter("r", host.runner, script, undefined, { sshBin: "ssh", runAsPrefix: "mu-" }).check();
      expect(c.ok).toBe(false);
      expect(c.notes).toEqual([HOST_IDENTITY_REFUSAL]);
      expect(c.notes.join(" ")).not.toMatch(/did not answer|unreachable/);
      expect(c.missing).toEqual([]);
      expect(c.installCommand).toBeNull();
    });
  }
  test("a thrown host-key error is the same refusal", async () => {
    const runner: HostRunner = async () => { throw new Error("Host key verification failed."); };
    const c = await new VpsSshAdapter("r", runner, script, undefined, { sshBin: "ssh", runAsPrefix: "mu-" }).check();
    expect(c.notes).toEqual([HOST_IDENTITY_REFUSAL]);
  });
  test("an ordinary timeout is still 'did not answer'", async () => {
    const host = recorder(() => ({ code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.1 port 22: Connection timed out" }));
    const c = await new VpsSshAdapter("r", host.runner, script, undefined, { sshBin: "ssh", runAsPrefix: "mu-" }).check();
    expect(c.notes.join(" ")).toMatch(/did not answer/);
  });
});
