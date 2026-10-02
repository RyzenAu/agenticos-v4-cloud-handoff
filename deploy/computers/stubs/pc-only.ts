/**
 * Stand-ins for the Windows PC executors in the Linux computer build. companion/executors.ts imports the Windows, desktop and
 * screen-goal executors for a PC; a computer passes its own executor set to the worker and never calls these. The build swaps them
 * in (deploy/computers/build-companion.ts) so the computer's one file doesn't carry the whole Jarvis stack.
 */
const no = (): never => {
  throw new Error("This runs on a PC companion, not on a cloud computer.");
};
export const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
export const createWindowsExecutors = no;
export const liveWindowsDeps = no;
export const createDesktopExecutors = no;
export const liveBrowserDeps = no;
export const createScreenGoalExecutor = no;
export const liveScreenGoalDeps = no;
export type WindowsDeps = never;
export type BrowserDeps = never;
export type DesktopTiming = never;
export type LiveBrowserOptions = never;
export type ScreenGoalDeps = never;
