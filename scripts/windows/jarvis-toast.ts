// Windows toast fallback: when no voice client has polled /jarvis/events recently (see
// pollIsStale/onFallbackToast in ../jarvis-events.ts), an event that would have been spoken is
// also shown as a native Windows toast, so it doesn't vanish because the operator panel isn't
// open. Fires the fixed PowerShell script in this folder via execFile, matching pc-hands.ts's
// existing pattern.
//
// Security: title/message are untrusted (an event's text can come from any source — a
// session watcher, a coach script, a cron job). They are passed purely as argv to a fixed
// -File script, never string-interpolated into a -Command, so nothing in the text can ever be
// parsed as PowerShell.
import { execFile } from "node:child_process";
import { join } from "node:path";

const SCRIPT_PATH = join(__dirname, "jarvis-toast.ps1");
const APP_NAME = "Jarvis";

export type ToastSender = (title: string, message: string) => void;
export type RunToastScript = (file: string, args: string[]) => void;

/** The exact argv passed to powershell.exe — no part of this is ever a single interpolated string. */
export function toastArgs(scriptPath: string, title: string, message: string, appId: string = APP_NAME): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Title", title, "-Message", message, "-AppId", appId];
}

const defaultRun: RunToastScript = (file, args) => {
  execFile(file, args, { windowsHide: true, timeout: 10_000 }, () => undefined);
};

/**
 * Builds a toast sender. `platform`/`run` are injectable so this stays unit-testable without
 * ever spawning a real process (and without ever popping a toast during `bun test`).
 */
export function createToastSender(deps: { platform?: NodeJS.Platform; run?: RunToastScript } = {}): ToastSender {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;
  return (title: string, message: string) => {
    if (platform !== "win32") return;
    run("powershell.exe", toastArgs(SCRIPT_PATH, title, message));
  };
}

/** The real, wired-up sender. Fire-and-forget; a failure here must never break the caller. */
export const showWindowsToast: ToastSender = createToastSender();
