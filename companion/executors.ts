import { execFile } from "node:child_process";
import type { ExecutorResult } from "../scripts/jarvis-command/contracts";
import { approvalValid, isRisky, type ProgressStep, type WireCommand } from "../scripts/devices/dispatch";
import type { DeviceOwner, PersonId } from "../scripts/devices/types";
import { abortableSleep, createWindowsExecutors, liveWindowsDeps, type WindowsDeps } from "../scripts/executors/windows";
import { createScreenGoalExecutor, liveScreenGoalDeps, type ScreenGoalDeps } from "../scripts/executors/screen-goal";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { createDesktopExecutors, liveBrowserDeps, type BrowserDeps, type DesktopTiming, type LiveBrowserOptions } from "../scripts/executors/desktop";

/**
 * What the companion may do on this PC. Anything not in the allow-list is refused locally,
 * whatever the hub sends. Send/pay/delete/publish additionally need this PC owner's own spoken
 * yes (an approval naming this owner, under two minutes old) — and none of those executors is
 * in the default allow-list, so today they are refused outright.
 *
 * The device actions (app.open, open-url, file.open, deck.blank, notepad.type) are the SAME code the
 * hub runs (scripts/executors/windows.ts); app.focus, browser.navigate and observe.window are the everyday
 * desktop set in scripts/executors/desktop.ts; every one returns an ExecutorResult whose `verified` is its
 * own post-action check. The Windows-only ones are registered on Windows only.
 */

export type ExecContext = {
  signal: AbortSignal;
  owner: PersonId;
  log: (line: string) => void;
  /** A long executor (a screen goal) reports each sub-step as it happens; the hub records it as a job step. Best effort, ordered. */
  progress?: (step: ProgressStep) => void;
};
export type Executor = (args: Record<string, unknown>, ctx: ExecContext) => Promise<unknown>;

export type Opener = (url: string) => void;

function defaultOpener(url: string) {
  if (process.platform === "win32") execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, () => undefined);
  else if (process.platform === "darwin") execFile("open", [url], () => undefined);
  else execFile("xdg-open", [url], () => undefined);
}

export type DefaultExecutorOptions = {
  /** Tests: where open-url hands the link instead of the real browser (then it can't be verified). */
  open?: Opener;
  /** This device's authorised folders for file.open. */
  roots?: string[];
  /** Replace the Windows dependencies (tests), or null for none of the Windows executors. */
  windows?: Partial<WindowsDeps> | null;
  platform?: string;
  /** Replace the browser side of browser.navigate (tests), or set the port / profile the real one uses. */
  browser?: BrowserDeps | LiveBrowserOptions;
  desktopTiming?: Partial<DesktopTiming>;
  /**
   * screen.goal's dependencies (the Jarvis entry and screen hands on this PC): tests inject fakes, null leaves screen.goal
   * out; by default the real ones are built on first use (nothing starts until a goal arrives).
   */
  screen?: ScreenGoalDeps | null;
  /** The repo folder the real screen loop loads its keys from (default: this checkout). */
  root?: string;
};

/** Things a running companion must close on exit (the app browser and warm PowerShell behind screen.goal). */
export const cleanups: Array<() => Promise<void> | void> = [];
export async function runCleanups() {
  for (const c of cleanups.splice(0)) await Promise.resolve(c()).catch(() => undefined);
}

/** Executors that act on (or look at) the interactive desktop: refused, honestly, while the PC is locked. */
export const NEEDS_DESKTOP = new Set(["app.open", "app.focus", "open-url", "file.open", "deck.blank", "notepad.type", "browser.navigate", "observe.window", "target.focus", "screen.goal"]);

export function defaultExecutors(opts: DefaultExecutorOptions = {}): Record<string, Executor> {
  const platform = opts.platform ?? process.platform;
  const injectedOpen = opts.open;
  const deps = liveWindowsDeps({
    platform,
    roots: opts.roots ?? [],
    // An injected opener has no browser to look at: open-url then reports verified:null, honestly.
    ...(injectedOpen ? { shellOpen: async (target: string) => injectedOpen(target), pageTitle: undefined } : platform === "win32" ? {} : { shellOpen: async (target: string) => defaultOpener(target), pageTitle: undefined }),
    ...(opts.windows ?? {}),
  });
  const shared = createWindowsExecutors(deps);
  const base: Record<string, Executor> = {
    /** Connectivity check. */
    echo: async (args) => {
      const echoed = String(args.text ?? "").slice(0, 500);
      return { ok: true, said: "Echoed.", verified: true, echoed, data: { echoed } } satisfies ExecutorResult & { echoed: string };
    },
    /** Show a line in the companion's own log (a stand-in for a desktop notification). */
    notify: async (args, ctx) => {
      const text = String(args.text ?? "").slice(0, 300);
      ctx.log(`[notify] ${text}`);
      return { ok: true, said: "Shown in the companion's log.", verified: null, shown: text, data: { shown: text } } satisfies ExecutorResult & { shown: string };
    },
    /** Open a plain http(s) link in this PC's default browser (the shared implementation). */
    "open-url": shared["open-url"],
    /** Wait (bounded) — lets cancellation be exercised end to end. */
    wait: async (args, ctx) => {
      const ms = Math.max(0, Math.min(Number(args.ms) || 0, 60_000));
      await abortableSleep(ms, ctx.signal);
      return { ok: true, said: `Waited ${ms} ms.`, verified: true, waited: ms, data: { waited: ms } } satisfies ExecutorResult & { waited: number };
    },
  };
  if (platform !== "win32" || opts.windows === null) return base;
  const browser: BrowserDeps = opts.browser && "hands" in opts.browser ? opts.browser : liveBrowserDeps(opts.browser);
  const desktop = createDesktopExecutors(deps, browser, shared, opts.desktopTiming);
  return {
    ...base,
    "app.open": shared["app.open"],
    "app.focus": desktop["app.focus"],
    "file.open": shared["file.open"],
    "deck.blank": shared["deck.blank"],
    "notepad.type": shared["notepad.type"],
    "browser.navigate": desktop["browser.navigate"],
    "observe.window": desktop["observe.window"],
    "target.focus": desktop["target.focus"],
    ...(opts.screen === null ? {} : screenGoal(opts)),
  };
}

export type Gate = { ok: true; run: Executor } | { ok: false; reason: string };

/** The local permission boundary: allow-list, then the owner's own spoken yes for risky actions. */
export function gate(command: WireCommand, owner: DeviceOwner, executors: Record<string, Executor>, now = Date.now()): Gate {
  if (command.personId !== owner) return { ok: false, reason: "That command is for someone else's device." };
  const run = Object.prototype.hasOwnProperty.call(executors, command.executor) ? executors[command.executor] : undefined;
  if (!run) return { ok: false, reason: `"${command.executor}" is not allowed on this PC.` };
  if (isRisky(command.executor, command.risk) && !approvalValid(command.approval, owner, now))
    return { ok: false, reason: "Send, pay, delete and publish need your own spoken yes." };
  return { ok: true, run };
}

function screenGoal(opts: DefaultExecutorOptions): Record<string, Executor> {
  // The folder the screen loop loads keys and keeps its browser profile under: this checkout when run from source; when run as
  // the packaged mu-companion.exe (no checkout beside it) this PC's own config folder.
  const checkout = resolvePath(import.meta.dir, "..");
  const root = opts.root ?? (existsSync(join(checkout, "package.json")) ? checkout : join(process.env.LOCALAPPDATA || homedir(), "mu-companion"));
  const deps = opts.screen ?? liveScreenGoalDeps({ root });
  if (deps.close) cleanups.push(() => deps.close!());
  // The owner is the one this PC is paired to: the worker passes it in each command's context.
  return {
    "screen.goal": (args, ctx) => createScreenGoalExecutor(deps, ctx.owner)(args as never, { signal: ctx.signal, owner: ctx.owner, progress: ctx.progress }),
  };
}
