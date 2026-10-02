import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DESKTOP_PACKAGES, INSTALL_COMMAND, SCRIPT_PATH, validName, type ExecResult, type HostRunner } from "./script-adapter";
import { VpsSshAdapter } from "./vps-ssh";
import { toWslPath, WslLocalAdapter } from "./wsl-local";

type Call = { argv: string[]; stdin: string };

/** A host that answers the script's actions from a table; records every command line and the script text it was fed. */
function fakeHost(answers: Record<string, unknown | ((args: string[]) => unknown)>, code = 0) {
  const calls: Call[] = [];
  const runner: HostRunner = async (argv, opts) => {
    calls.push({ argv, stdin: opts?.stdin ?? "" });
    const dash = argv.indexOf("--", argv.indexOf("bash"));
    const action = argv[dash + 1];
    const a = answers[action] ?? (action === "alloc" ? { ok: true, display: 101, vncPort: 6001, cdpPort: 9401 } : undefined);
    const out = typeof a === "function" ? (a as (x: string[]) => unknown)(argv.slice(dash + 2)) : a;
    return { code, stdout: out === undefined ? JSON.stringify({ ok: true }) : typeof out === "string" ? out : JSON.stringify(out), stderr: "" } satisfies ExecResult;
  };
  return { runner, calls };
}

const script = "#!/usr/bin/env bash\necho script";

describe("wsl-local adapter (the WSL stand-in)", () => {
  test("every action is 'wsl.exe -d <distro> -- bash -s -- <action> <args>' with the script on stdin; secrets never ride the command line", async () => {
    const host = fakeHost({ check: { ok: true, host: "kali", node: "v22.0.0", present: ["Xvfb", "chromium", "x11vnc", "xdotool", "node"], missing: [] } });
    const a = new WslLocalAdapter("kali-linux", host.runner, script);
    const { handle, desktop } = await a.provision({ name: "research", display: 101, resolution: "1280x800x24", hubUrl: "http://172.19.48.1:8113", pairingCode: "ABCD-EFGH", label: "Research computer" });
    expect(desktop).toBe(true);
    expect(handle).toMatchObject({ name: "research", display: 101, vncPort: 6001 });
    const prov = host.calls.find((c) => c.argv.includes("provision"))!;
    expect(prov.argv.slice(0, 7)).toEqual(["wsl.exe", "-d", "kali-linux", "--", "bash", "-s", "--"]);
    expect(prov.argv.slice(7)).toEqual(["provision", "research", "101", "1280x800x24", "6001", "9401"]);
    expect(prov.argv.join(" ")).not.toMatch(/ABCD|172\.19|Research computer/);
    expect(prov.stdin).toContain("export MU_PAIR_CODE='ABCD-EFGH'");
    expect(prov.stdin).toContain("export MU_HUB_URL='http://172.19.48.1:8113'");
    expect(prov.stdin).toContain("export MU_LABEL='Research computer'");
    expect(prov.stdin.endsWith(script)).toBe(true);
    // provisioning ends by starting it
    expect(host.calls.at(-1)!.argv.slice(7)).toEqual(["start", "research"]);
  });

  test("a host missing the desktop packages still provisions (headless) and says exactly what to install", async () => {
    const host = fakeHost({ check: { ok: true, host: "kali", present: ["node"], missing: ["Xvfb", "chromium", "x11vnc", "xdotool"] } });
    const a = new WslLocalAdapter("kali-linux", host.runner, script);
    const check = await a.check();
    expect(check.ok).toBe(true);
    expect(check.missing).toEqual(["Xvfb", "chromium", "x11vnc", "xdotool"]);
    expect(check.installCommand).toBe(INSTALL_COMMAND);
    expect(INSTALL_COMMAND).toBe("sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji");
    expect(DESKTOP_PACKAGES).toEqual(["xvfb", "chromium", "x11vnc", "xdotool"]);
    expect(check.notes.join(" ")).toMatch(/headless/);
    const { desktop } = await a.provision({ name: "research", display: 101, resolution: "1280x800x24", hubUrl: "http://172.19.48.1:8113", pairingCode: "ABCD-EFGH", label: "x" });
    expect(desktop).toBe(false);
  });

  test("a host without node cannot run a computer", async () => {
    const host = fakeHost({ check: { ok: true, host: "x", present: [], missing: ["node", "Xvfb"] } });
    const check = await new WslLocalAdapter("kali-linux", host.runner, script).check();
    expect(check.ok).toBe(false);
    expect(check.notes.join(" ")).toMatch(/node is missing/);
  });

  test("an unreachable host is reported, not thrown", async () => {
    const runner: HostRunner = async () => {
      throw new Error("spawn wsl.exe ENOENT");
    };
    const check = await new WslLocalAdapter("kali-linux", runner, script).check();
    expect(check.ok).toBe(false);
    expect(check.notes.join(" ")).toMatch(/unreachable/);
  });

  test("probe turns the script's JSON into a resource reading; a dead companion is visible", async () => {
    const host = fakeHost({ probe: { ok: true, companion: false, xvfb: true, vnc: null, browser: false, procs: 3, rssKb: 184320, cpu: 7 } });
    const r = await new WslLocalAdapter("kali-linux", host.runner, script, () => 42).probe({ name: "research" });
    expect(r).toEqual({ hostUp: true, companionAlive: false, displayAlive: true, vncAlive: null, browserAlive: false, resource: { rssMb: 180, cpuPct: 7, procs: 3, sampledAt: 42 }, at: 42 });
    const down = await new WslLocalAdapter("kali-linux", async () => ({ code: 1, stdout: "", stderr: "WSL is not running" }), script).probe({ name: "research" });
    expect(down.hostUp).toBe(false);
  });

  test("lifecycle: suspend and stop stop it, resume and start start it, recover stops then starts, destroy removes", async () => {
    const host = fakeHost({});
    const a = new WslLocalAdapter("kali-linux", host.runner, script);
    const h = { name: "research" };
    await a.suspend(h);
    await a.resume(h);
    await a.recover(h);
    await a.destroy(h);
    expect(host.calls.map((c) => c.argv[7])).toEqual(["stop", "start", "stop", "start", "destroy"]);
  });

  test("a snapshot is decoded from base64 in memory; none when the computer has no browser", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const a = new WslLocalAdapter("kali-linux", fakeHost({ shot: jpeg.toString("base64") }).runner, script);
    expect(await a.snapshot({ name: "research" })).toEqual({ mime: "image/jpeg", data: Uint8Array.from(jpeg) });
    const cut = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 7)]); // no end-of-image marker: truncated in transit
    expect(await new WslLocalAdapter("kali-linux", fakeHost({ shot: cut.toString("base64") }).runner, script).snapshot({ name: "research" })).toBeNull();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20, 1), Buffer.from("0000000049454e44ae426082", "hex")]);
    expect((await new WslLocalAdapter("kali-linux", fakeHost({ shot: png.toString("base64") }).runner, script).snapshot({ name: "research" }))?.mime).toBe("image/png");
    const none = new WslLocalAdapter("kali-linux", fakeHost({ shot: { ok: false, error: "computer not running" } }, 2).runner, script);
    expect(await none.snapshot({ name: "research" })).toBeNull();
  });

  test("arguments outside the script's alphabet and bad names are refused before anything runs", async () => {
    const host = fakeHost({});
    const a = new WslLocalAdapter("kali-linux", host.runner, script);
    await expect(a.start({ name: "a; rm -rf /" })).rejects.toThrow(/bad computer name/);
    await expect(a.start({ name: "Research" })).rejects.toThrow();
    await expect(a.provision({ name: "ok", display: 101, resolution: "1280x800x24; id", hubUrl: "http://h", pairingCode: "X", label: "l" })).rejects.toThrow(/doesn't accept/);
    expect(() => new WslLocalAdapter("kali linux; x")).toThrow();
    expect(host.calls).toHaveLength(0); // refused before even the package check or an allocation
    expect(validName("research")).toBe(true);
    expect(validName("../etc")).toBe(false);
  });

  test("windows paths map to where WSL sees them", () => {
    expect(toWslPath("D:\\prog-scratch\\companion.mjs")).toBe("/mnt/d/prog-scratch/companion.mjs");
    expect(toWslPath("C:/x/y")).toBe("/mnt/c/x/y");
  });
});

describe("vps-ssh adapter (sketched, not run): the same script over SSH", () => {
  test("runs through the operator's ssh alias, key auth only, never a password, and the same actions", async () => {
    const host = fakeHost({ check: { ok: true, host: "syd-1", present: ["Xvfb", "chromium", "x11vnc", "xdotool", "node"], missing: [] }, alloc: { ok: true, display: 102, vncPort: 6002, cdpPort: 9402 } });
    const a = new VpsSshAdapter("mu-computers", host.runner, script, undefined, { sshBin: "ssh" });
    await a.provision({ name: "builder", display: 102, resolution: "1280x800x24", hubUrl: "http://127.0.0.1:8081", pairingCode: "WXYZ-2345", label: "Builder" });
    const prov = host.calls.find((c) => c.argv.includes("provision"))!;
    expect(prov.argv).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "mu-computers", "bash", "-s", "--", "provision", "builder", "102", "1280x800x24", "6002", "9402"]);
    expect(prov.argv.join(" ")).not.toMatch(/WXYZ|Builder/);
    expect(() => new VpsSshAdapter("bad alias;")).toThrow();
  });
});

describe("the runtime script", () => {
  const text = readFileSync(SCRIPT_PATH, "utf8");
  test("installs nothing and needs no root", () => {
    expect(text).not.toMatch(/\bsudo\b(?! apt)/);
    expect(text).not.toMatch(/apt-get|apt install|dpkg -i|curl |wget /);
    expect(text).toContain("never does");
  });
  test("root writes nothing into a computer's own folder: logs are opened after privileges drop, pids and keys live in a root-owned sibling, config is validated, x11vnc ignores rc files and IPv6", () => {
    expect(text).toContain('CTL="$BASE/.ctl/$NAME"');
    expect(text).toMatch(/sh -c 'exec >>"\$0" 2>&1 <\/dev\/null; exec "\$@"' "\$log"/); // the inner shell, after setpriv, opens the log
    expect(text).not.toMatch(/\$DIR\/run/);
    expect(text).not.toMatch(/\$DIR\/cfg\/(owner\.key|hub\.id)/);
    expect(text).toMatch(/valid_cfg \|\|/);
    expect(text).toMatch(/x11vnc -norc .*-noipv6 -rfbportv6 -1 /);
    expect(text).toMatch(/as_user "\$NODE" "\$BIN" shot/);
    expect(text).toMatch(/-u MU_COMPUTER_NO_SANDBOX/);
    expect(text).not.toMatch(/--code "\$MU_PAIR_CODE"/); // the pairing code is not on a command line other users can read
    expect(text).toContain("user_ok()");
    expect(text).toMatch(/the user \$RUN_USER exists but is not this computer's/);
    expect(text).toMatch(/could not be deleted/);
    expect(text).toMatch(/not machine isolation/i);
  });
  test("the script never turns the browser sandbox off; per-computer users come from setpriv, and fonts are checked", () => {
    expect(text.replace("-u MU_COMPUTER_NO_SANDBOX", "")).not.toMatch(/NO_SANDBOX|--no-sandbox/); // (it is only ever scrubbed from the environment)
    expect(text).toContain("setpriv");
    expect(text).toContain("MU_RUN_AS_PREFIX");
    expect(text).toMatch(/fc-match/);
    expect(text).toMatch(/LC_ALL=C\.UTF-8 LANGUAGE=en_AU:en/);
  });
  test("the desktop's VNC server is loopback only, and every process gets its own session", () => {
    expect(text).toMatch(/x11vnc .*-localhost/);
    expect(text).toContain("setsid");
    expect(text).toContain("-nolisten tcp");
  });
});
