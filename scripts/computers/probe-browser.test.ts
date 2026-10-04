import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SCRIPT_PATH } from "./script-adapter";

/**
 * The probe's "browser" answer (round 7). Found on a real local computer: the probe said `browser: false` for a computer whose Chromium was open, so every real
 * desktop read as a blank screen (and its memory figure left the browser out). The cause: a computer's processes are recognised by an owner key in their
 * environment, but Chromium rewrites its own process title and with it /proc/<pid>/environ, so the key is not readable from a running browser. The browser is
 * now found by its profile on the command line. Runs inside the WSL distro (skipped where there is none); a fake "browser" stands in for Chromium.
 */

setDefaultTimeout(90_000);
const DISTRO = process.env.MU_COMPUTERS_WSL_DISTRO || "kali-linux";
const script = readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");
const haveHost = process.platform === "win32" && spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-c", "command -v setsid >/dev/null && echo yes"], { encoding: "utf8", windowsHide: true }).stdout.trim() === "yes";

const ROOT = `/tmp/mu-probe-test-${process.pid}-${Date.now()}`;
const wsl = (cmd: string) => (spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-s"], { encoding: "utf8", input: cmd, windowsHide: true }).stdout ?? "").replace(/\u0000/g, "").trim();
function probe(name: string, home = ROOT) {
  const exports = `export MU_COMPUTERS_HOME='${home}'\nexport MU_HUB_ID='probe-test'`;
  const r = spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-s", "--", "probe", name], { encoding: "utf8", input: `${exports}\n${script}`, windowsHide: true });
  const line = (r.stdout ?? "").replace(/\u0000/g, "").trim().split("\n").filter(Boolean).at(-1) ?? "";
  return JSON.parse(line) as { ok: boolean; browser: boolean; procs: number };
}

afterAll(() => {
  if (haveHost) wsl(`pkill -f 'mu-probe-test-${process.pid}' ; rm -rf ${ROOT}`);
});

describe("the probe finds a computer's browser by its profile, not by an environment Chromium rewrites", () => {
  test.skipIf(!haveHost)("no browser: false (and the probe's own grep does not count as one); a browser WITHOUT the owner key in its environment: true; gone again: false", () => {
    wsl(`mkdir -p ${ROOT}/pb/cfg ${ROOT}/pb/run ${ROOT}/pb/profile && echo 'probe-test.pb.nonce' > ${ROOT}/pb/cfg/owner.key`);
    expect(probe("pb")).toMatchObject({ ok: true, browser: false });
    // a stand-in browser: it has the profile on its command line and, like a running Chromium, NO owner key in its environment
    wsl(`env -u MU_COMPUTER_KEY setsid nohup bash -c 'sleep 120; true' fake-chromium --user-data-dir=${ROOT}/pb/profile --remote-debugging-port=1 </dev/null >/dev/null 2>&1 &\nsleep 0.5`);
    const up = probe("pb");
    expect(up).toMatchObject({ ok: true, browser: true });
    // a different computer's browser (another profile) is not this one's
    wsl(`mkdir -p ${ROOT}/other/cfg ${ROOT}/other/run ${ROOT}/other/profile && echo 'probe-test.other.nonce' > ${ROOT}/other/cfg/owner.key`);
    expect(probe("other")).toMatchObject({ ok: true, browser: false });
    wsl(`pkill -f 'user-data-dir=${ROOT}/pb/profile'; sleep 0.3`);
    expect(probe("pb")).toMatchObject({ ok: true, browser: false });
  });

  test.skipIf(!haveHost)("the hold marker: 'hold on' writes it, 'hold off' and a stop remove it (it is never left behind)", () => {
    const run = (action: string, ...args: string[]) => spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-s", "--", action, ...args], { encoding: "utf8", input: `export MU_COMPUTERS_HOME='${ROOT}'\nexport MU_HUB_ID='probe-test'\n${script}`, windowsHide: true });
    const has = () => wsl(`[ -e '${ROOT}/hd/cfg/hold' ] && echo yes || echo no`);
    wsl(`mkdir -p '${ROOT}/hd/cfg' '${ROOT}/hd/run' && echo 'probe-test.hd.nonce' > '${ROOT}/hd/cfg/owner.key'`);
    run("hold", "hd", "on");
    expect(has()).toBe("yes");
    run("hold", "hd", "off");
    expect(has()).toBe("no");
    run("hold", "hd", "on");
    run("stop", "hd"); // a stop clears a marker left behind
    expect(has()).toBe("no");
    expect(run("hold", "hd", "maybe").status).not.toBe(0);
  });

  test.skipIf(!haveHost)("a computers folder whose path holds regex characters is matched literally (+ ( ) | . are not operators)", () => {
    const home = `${ROOT}/we+ird(dir)|x.y`;
    wsl(`mkdir -p '${home}/pc/cfg' '${home}/pc/run' '${home}/pc/profile' '${home}/pcx/cfg' '${home}/pcx/run' '${home}/pcx/profile' && echo 'probe-test.pc.nonce' > '${home}/pc/cfg/owner.key' && echo 'probe-test.pcx.nonce' > '${home}/pcx/cfg/owner.key'`);
    wsl(`env -u MU_COMPUTER_KEY setsid nohup bash -c 'sleep 120; true' fake-chromium '--user-data-dir=${home}/pc/profile' </dev/null >/dev/null 2>&1 &
sleep 0.5`);
    expect(probe("pc", home)).toMatchObject({ ok: true, browser: true });
    // a path that the unescaped pattern would also match (the . and | and + as operators) belongs to nobody
    expect(probe("pcx", home)).toMatchObject({ ok: true, browser: false });
    wsl(`pkill -f 'fake-chromium'; sleep 0.3`);
  });
});
