import { execFile } from "node:child_process";

/**
 * Is an interactive, unlocked desktop session available on this PC right now?
 *
 * Windows runs LogonUI.exe while the lock screen or the sign-in screen is showing; with it running, windows
 * can't be opened, focused or read, and an executor that tried would only appear to do something. A companion
 * reports this in every heartbeat so the hub can say "this PC is locked" instead of sending commands at it,
 * and refuses desktop executors itself while it is false.
 *
 * true = unlocked desktop; false = locked or at sign-in; null = this worker can't tell (not Windows, or the
 * process list wasn't readable). Never throws; one cheap `tasklist` call, no PowerShell.
 */
export type RunTasklist = () => Promise<string | null>;

function defaultTasklist(): Promise<string | null> {
  return new Promise((resolve) =>
    execFile("tasklist.exe", ["/FI", "IMAGENAME eq LogonUI.exe", "/NH", "/FO", "CSV"], { windowsHide: true, timeout: 5_000 }, (error, stdout) => resolve(error ? null : String(stdout))),
  );
}

export async function desktopInteractive(platform: string = process.platform, run: RunTasklist = defaultTasklist): Promise<boolean | null> {
  if (platform !== "win32") return null;
  const out = await run().catch(() => null);
  if (out === null) return null;
  return !/logonui\.exe/i.test(out);
}
