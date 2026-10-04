// The shared computers' screen: the authenticated live viewer (the hub's own noVNC page in a same-origin frame), the snapshot
// fallback, and the chooser between them. Used by the Computers page and by the Agents workspace's Computer tab.
// The hub decides who may act; these components only report it.
import { useEffect, useReducer, useRef, useState } from "react";
import { Button, Notice } from "@/components/ds";
import { NO_SCREEN, computerAction, readScreen, readSnapshot, renewLease } from "@/lib/computers-client";
import { useDocumentVisible } from "@/lib/ui-motion";
import {
  CONNECT_DEADLINE_MS,
  INITIAL_VIEWER,
  parseViewerMessage,
  retryDelayMs,
  viewerFlow,
  viewerReducer,
  viewerStatusText,
  type ScreenState,
} from "./viewer-state";

export { CONNECT_DEADLINE_MS, parseViewerMessage, screenPhase, viewerStatusText, type ScreenState, type ViewerMessage } from "./viewer-state";

/**
 * The live screen. A dropped screen (the desktop restarted, the network blipped) is retried with a growing pause, then offered as a button.
 * `nudge` changes when who holds the controls changes, so the frame re-reads the lease at once instead of on its next poll.
 * `deadlineMs`: a frame that has said nothing in this long is called "didn't connect" and goes through the same retry path (opt-in).
 */
export function LiveViewer({ name, online = true, nudge, onState, deadlineMs }: { name: string; online?: boolean; nudge?: string; onState?: (s: ScreenState) => void; deadlineMs?: number }) {
  const [state, dispatch] = useReducer(viewerReducer, INITIAL_VIEWER);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const m = parseViewerMessage(e.data, name);
      if (m) {
        const next = { connected: typeof m.connected === "boolean" ? m.connected : null, canControl: typeof m.canControl === "boolean" ? m.canControl : null, blank: typeof m.blank === "boolean" ? m.blank : null, diagnosis: m.diagnosis ?? null };
        dispatch({ type: "message", ...next });
        onStateRef.current?.(next);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [name]);
  // Tell the parent when the screen goes back to "connecting" or "didn't connect", so its chip never shows a stale "live".
  useEffect(() => {
    onStateRef.current?.({ connected: state.connected, canControl: state.canControl, blank: state.blank, diagnosis: state.diagnosis });
  }, [state.connected, state.canControl, state.blank, state.diagnosis]);
  const { dropped, retrying, gaveUp } = viewerFlow(state, online);
  useEffect(() => {
    if (!retrying) return;
    const t = window.setTimeout(() => dispatch({ type: "auto-retry" }), retryDelayMs(state.tries));
    return () => window.clearTimeout(t);
  }, [retrying, state.tries]);
  // The next action the hub named for a screen that cannot simply reconnect: restart the display, or check the host.
  const [checked, setChecked] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const next = state.diagnosis?.next ?? null;
  const needsRestart = next === "restart-display" && (state.connected === false || state.blank === true);
  const needsHost = next === "check-host" && state.connected === false;
  const restartDisplay = async () => {
    setActing(true);
    const r = await computerAction(name, "restart-display");
    setChecked(r.message);
    setActing(false);
    if (r.ok) dispatch({ type: "manual-retry" });
  };
  const checkHost = async () => {
    setActing(true);
    const r = await readScreen(name);
    setChecked(r.ok ? (r.screen.ok ? "The host answers and the screen is working. Reconnecting." : `${r.screen.reason ?? "The screen is not ready."}${r.screen.nextLabel ? ` Next: ${r.screen.nextLabel}.` : ""}`) : r.reason);
    setActing(false);
    if (r.ok && r.screen.ok) dispatch({ type: "manual-retry" });
  };
  const waiting = state.connected === null;
  useEffect(() => {
    if (!deadlineMs || !waiting || !online) return;
    const t = window.setTimeout(() => dispatch({ type: "deadline" }), deadlineMs);
    return () => window.clearTimeout(t);
  }, [deadlineMs, waiting, online, state.reload]);
  useEffect(() => {
    if (nudge !== undefined) frame.current?.contentWindow?.postMessage({ target: "mu-computer-viewer", type: "refresh" }, window.location.origin);
  }, [nudge]);
  return (
    <div className="flex flex-col gap-2">
      {(gaveUp || needsRestart) && (
        <div className="flex flex-wrap gap-2">
          {needsRestart ? (
            <Button variant="accent" size="sm" disabled={acting} onClick={() => void restartDisplay()}>Restart display</Button>
          ) : needsHost ? (
            <Button variant="accent" size="sm" disabled={acting} onClick={() => void checkHost()}>Check host</Button>
          ) : null}
          {gaveUp && (
            <Button variant="outline" size="sm" onClick={() => dispatch({ type: "manual-retry" })}>
              {state.timedOut ? "Retry" : "Reconnect"}
            </Button>
          )}
        </div>
      )}
      <p role="status" className="text-sm text-muted-foreground" data-screen-state={state.connected === true ? (state.blank === true ? "blank" : "live") : dropped ? (state.timedOut ? "timed-out" : "dropped") : "connecting"} data-screen-layer={state.diagnosis?.layer ?? undefined}>{viewerStatusText({ ...state, ...(dropped ? { retrying } : {}) })}</p>
      {checked && <p role="status" className="text-sm text-muted-foreground" data-testid="screen-action-result">{checked}</p>}
      <iframe
        key={state.reload}
        ref={frame}
        title={`Screen of ${name}`}
        src={`/__computers/${encodeURIComponent(name)}/viewer?bare=1`}
        sandbox="allow-scripts allow-same-origin"
        style={{ aspectRatio: "16 / 10" }}
        className="max-h-[max(220px,min(78vh,calc(100dvh_-_21rem)))] min-h-[220px] w-full rounded-xl border border-border bg-black"
      />
    </div>
  );
}

/** The computer's screen, as a JPEG snapshot refreshed every 3 s while this is open and the tab is visible. */
export function SnapshotPanel({ name, holding }: { name: string; holding: boolean }) {
  const visible = useDocumentVisible();
  const [shot, setShot] = useState<{ url: string } | { reason: string } | null>(null);
  useEffect(() => {
    if (!visible) return;
    let stop = false;
    let last: string | null = null;
    const tick = async () => {
      const s = await readSnapshot(name);
      if (stop) return;
      if ("url" in s && last) URL.revokeObjectURL(last);
      if ("url" in s) last = s.url;
      setShot(s);
    };
    void tick();
    const t = window.setInterval(() => void tick(), 3000);
    // A held lease expires unless the viewer keeps it alive.
    const renew = holding ? window.setInterval(() => void renewLease(name), 25_000) : undefined;
    return () => {
      stop = true;
      window.clearInterval(t);
      if (renew) window.clearInterval(renew);
      if (last) URL.revokeObjectURL(last);
    };
  }, [name, visible, holding]);
  if (!shot) return <p className="text-sm text-muted-foreground">Looking at the screen…</p>;
  if ("reason" in shot) return <Notice tone="info" title="No preview">{shot.reason}</Notice>;
  return <img src={shot.url} alt={`Screen of ${name}, a snapshot refreshed every few seconds`} className="w-full rounded-xl border border-border" />;
}

/** Live viewer when the hub says VNC is up, else the snapshot, else a plain "no screen yet". */
export function PreviewPanel({ name, holding, viewer, online, nudge, onState, deadlineMs }: { name: string; holding: boolean; viewer: { snapshot: boolean; vnc: boolean }; online?: boolean; nudge?: string; onState?: (s: ScreenState) => void; deadlineMs?: number }) {
  if (viewer.vnc) return <LiveViewer name={name} online={online} nudge={nudge} onState={onState} deadlineMs={deadlineMs} />;
  if (viewer.snapshot) return <SnapshotPanel name={name} holding={holding} />;
  return <Notice tone="info" title="No preview">{NO_SCREEN}</Notice>;
}
