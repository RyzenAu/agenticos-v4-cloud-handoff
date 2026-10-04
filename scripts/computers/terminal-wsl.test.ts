// Round 10: the terminal bridge that runs INSIDE a bot computer (computer-ctl.sh `term_bridge`), against this PC's real WSL distro (kali-linux).
//   - the bridge: a real pseudo-terminal, framed keystrokes in, raw output back, the window size set by a resize frame, 'q' ends it;
//   - the script's own refusals through the real WSL adapter: an unknown computer, and (when MU_TERM_TEST_COMPUTER names a provisioned computer that
//     runs as the host's login user) the refusal to give a shell as a user that is not the computer's own.
// Skipped when WSL or the distro is not available. Nothing here runs as root and nothing is installed.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SCRIPT_PATH } from "./script-adapter";
import { frame, resizeFrame } from "./terminal";
import { WslLocalAdapter } from "./wsl-local";

const DISTRO = "kali-linux";
const hasWsl = process.platform === "win32" && spawnSync("wsl.exe", ["-d", DISTRO, "--", "true"], { timeout: 30_000 }).status === 0;
const script = readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");
const bridge = /term_bridge\(\) \{\n {2}cat <<'PYEOF'\n([\s\S]*?)\nPYEOF\n\}/.exec(script)?.[1] ?? "";
const enc = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!hasWsl)("the terminal bridge in the real WSL distro", () => {
  test("a real pty: keystrokes in, output out, the window size from a resize frame, q ends it with the shell", async () => {
    expect(bridge).toContain("pty.fork()");
    const file = `/tmp/r10-term-bridge-${process.pid}.py`;
    expect(spawnSync("wsl.exe", ["-d", DISTRO, "--", "bash", "-c", `cat > ${file}`], { input: bridge, timeout: 30_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).status).toBe(0);
    try {
      const child = spawn("wsl.exe", ["-d", DISTRO, "--", "env", "-i", "HOME=/tmp", "PATH=/usr/bin:/bin", "TERM=xterm-256color", "LANG=C.UTF-8", "python3", file, "/tmp"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
      let out = "";
      child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
      const exited = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
      const until = async (re: RegExp, ms = 20_000) => {
        const end = Date.now() + ms;
        while (!re.test(out)) {
          if (Date.now() > end) throw new Error(`timed out waiting for ${re} in ${JSON.stringify(out.slice(-300))}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      child.stdin.write(resizeFrame(100, 30));
      child.stdin.write(frame("d", enc("echo r10-ok-$((6*7))\r")));
      await until(/r10-ok-42/);
      child.stdin.write(frame("d", enc("stty size\r")));
      await until(/\b30 100\b/);
      child.stdin.write(resizeFrame(120, 40));
      child.stdin.write(frame("d", enc("stty size; tty\r")));
      await until(/\b40 120\b[\s\S]*\/dev\/pts\//);
      child.stdin.write(frame("q"));
      expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 15_000))])).not.toBe("still running");
    } finally {
      spawnSync("wsl.exe", ["-d", DISTRO, "--", "rm", "-f", file], { timeout: 30_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    }
  }, 90_000);

  test("through the real WSL adapter: an unknown computer is refused by the script, nothing half open", async () => {
    const adapter = new WslLocalAdapter(DISTRO);
    const r = await adapter.openTerminal({ name: "r10-no-such-computer" }, { cols: 80, rows: 24 });
    expect(r).toEqual({ refused: "No terminal: this computer is not provisioned." });
  }, 60_000);

  test.skipIf(!process.env.MU_TERM_TEST_COMPUTER)("a provisioned computer that runs as the host's login user gets no shell", async () => {
    const adapter = new WslLocalAdapter(DISTRO);
    const name = String(process.env.MU_TERM_TEST_COMPUTER);
    // The computer's own folder (the hub passes MU_COMPUTERS_HOME the same way).
    (adapter as unknown as { hostEnv: () => Record<string, string> }).hostEnv = () => (process.env.MU_TERM_TEST_HOME ? { MU_COMPUTERS_HOME: String(process.env.MU_TERM_TEST_HOME) } : {});
    const r = await adapter.openTerminal({ name }, { cols: 80, rows: 24 });
    expect(r).toEqual({ refused: "No terminal: this computer runs as the host login user, not a user of its own, so no terminal is offered (a shell there could read the other computers files)." });
  }, 60_000);
});
