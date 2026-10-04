import { spawn } from "node:child_process";
import { join } from "node:path";

export class ChildTerminationUnverified extends Error {
  constructor() { super("Child termination not verified"); }
}

/** Resolve only after the OS acknowledges the owned tree stop. Parent close alone
 * cannot establish that its descendants stopped. Does not collect process output. */
export function stopOwnedChild(child: { pid?: number }): Promise<boolean> {
  if (!child.pid) return Promise.resolve(false);
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); return Promise.resolve(true); }
    catch { return Promise.resolve(false); }
  }
  return new Promise((resolve) => {
    const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"], { env: {}, stdio: "ignore", windowsHide: true });
    killer.once("close", (code) => resolve(code === 0));
    killer.once("error", () => resolve(false));
  });
}

/** Trusted server adapter only: never pass model-supplied executable/argv/cwd here.
 * No shell, output collection, environment inheritance or automatic retries.
 * Cancellation waits for the owned process tree kill before touching its parent.
 */
export function runChild(input: {
  executable: string; args: string[]; cwd: string; signal: AbortSignal; timeoutMs: number;
  onStarted?: (pid: number) => void;
}): Promise<{ ok: boolean; cancelled: boolean; exitCode: number | null }> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 900_000)
    return Promise.reject(new Error("Invalid execution timeout"));
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd, env: {}, stdio: "ignore", shell: false,
      windowsHide: true, detached: process.platform !== "win32",
    });
    let stopping = false, settled = false, childClosed = false, treeStopped = false;
    let finalExitCode: number | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); clearTimeout(grace); input.signal.removeEventListener("abort", stop); };
    const finish = () => {
      if (settled || !childClosed || (stopping && !treeStopped)) return;
      settled = true; cleanup();
      resolve({ ok: finalExitCode === 0 && !stopping, cancelled: stopping, exitCode: finalExitCode });
    };
    const unverified = () => {
      if (settled) return;
      settled = true; cleanup(); reject(new ChildTerminationUnverified());
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      grace = setTimeout(() => {
        if (settled) return;
        unverified();
      }, 5000);
      const direct = () => { try { child.kill("SIGKILL"); } catch { /* close/error decides outcome */ } };
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
          ["/pid", String(child.pid), "/t", "/f"], { env: {}, stdio: "ignore", windowsHide: true });
        // Killing the parent first races taskkill's discovery of its descendants.
        killer.once("close", (code) => {
          if (code !== 0) { direct(); unverified(); }
          else { treeStopped = true; finish(); }
        });
        killer.once("error", () => { direct(); unverified(); });
      } else {
        try { process.kill(-child.pid!, "SIGKILL"); treeStopped = true; finish(); }
        catch { direct(); unverified(); }
      }
    };
    const timer = setTimeout(stop, input.timeoutMs);
    input.signal.addEventListener("abort", stop, { once: true });
    child.once("error", () => {
      if (settled) return;
      settled = true; cleanup(); reject(new Error("Child could not start"));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      childClosed = true; finalExitCode = exitCode; finish();
    });
    child.once("spawn", () => {
      if (input.signal.aborted) stop();
      try { input.onStarted?.(child.pid!); } catch { stop(); }
    });
    if (input.signal.aborted) stop();
  });
}
