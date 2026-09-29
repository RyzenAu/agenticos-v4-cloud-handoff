import { execFile } from "node:child_process";
import type { ExecutorResult } from "../scripts/jarvis-command/contracts";
import { approvalValid, isRisky, type WireCommand } from "../scripts/devices/dispatch";
import type { PersonId } from "../scripts/devices/types";
import { abortableSleep, createWindowsExecutors, liveWindowsDeps, type WindowsDeps } from "../scripts/executors/windows";

/**
 * What the companion may do on this PC. Anything not in the allow-list is refused locally,
 * whatever the hub sends. Send/pay/delete/publish additionally need this PC owner's own spoken
 * yes (an approval naming this owner, under two minutes old) — and none of those executors is
 * in the default allow-list, so today they are refused outright.
 *
 * The device actions (app.open, open-url, file.open, deck.blank, notepad.type) are the SAME code the
 * hub runs (scripts/executors/windows.ts); every one returns an ExecutorResult whose `verified` is its
 * own post-action check. The Windows-only ones are registered on Windows only.
 */

export type ExecContext = { signal: AbortSignal; owner: PersonId; log: (line: string) => void };
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
};

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
  return { ...base, "app.open": shared["app.open"], "file.open": shared["file.open"], "deck.blank": shared["deck.blank"], "notepad.type": shared["notepad.type"] };
}

export type Gate = { ok: true; run: Executor } | { ok: false; reason: string };

/** The local permission boundary: allow-list, then the owner's own spoken yes for risky actions. */
export function gate(command: WireCommand, owner: PersonId, executors: Record<string, Executor>, now = Date.now()): Gate {
  if (command.personId !== owner) return { ok: false, reason: "That command is for someone else's device." };
  const run = Object.prototype.hasOwnProperty.call(executors, command.executor) ? executors[command.executor] : undefined;
  if (!run) return { ok: false, reason: `"${command.executor}" is not allowed on this PC.` };
  if (isRisky(command.executor, command.risk) && !approvalValid(command.approval, owner, now))
    return { ok: false, reason: "Send, pay, delete and publish need your own spoken yes." };
  return { ok: true, run };
}
