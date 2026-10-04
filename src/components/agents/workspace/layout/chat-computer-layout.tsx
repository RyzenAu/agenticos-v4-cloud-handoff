// The Agents conversation with the bot's live computer beside it. Chat is primary and is mounted ONCE, first, in every layout, so the draft,
// the scroll position and the live stream survive opening, resizing, expanding and (on narrow screens) switching to the computer.
//   wide (>= 1200 px): "Show computer" opens a resizable side panel (drag, or keyboard on the separator); Expand makes it a full-width overlay over the conversation.
//   tablet and phone: a Conversation / Computer switch; both stay mounted in one grid cell, the hidden one is inert and invisible.
//   the panel's width is kept inside the row it is in: the row is measured (and watched with a ResizeObserver), so a saved width that was fine for the
//   viewport but too wide for the row beside the sidebar is clamped as soon as the row has a size, and again whenever the row changes.
// The computer itself is whatever `renderComputer` returns (the existing viewer and control-lease controls); this file only places it.
// Ideas only, no code copied: OpenBot's right rail (MIT); Rakazo's resizable rail that remembers its width and its full-screen computer (elie222/rakazo @ df70849, Apache-2.0).
// The show/hide control and the phone switch can live on the page's tab row (toolbarHost), so the header stays two lines and the composer stays in view.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Segmented } from "@/components/ds";
import { useReducedMotion } from "@/lib/ui-motion";
import { cn } from "@/lib/utils";
import { PANEL_DEFAULT, SIDE_BY_SIDE_MIN, clampWidth, modeFor, panelMax, readPrefs, widthForKey, writePrefs, type PanelPrefs } from "./panel-state";

export type LayoutView = "conversation" | "computer";

function useViewportWidth(override?: number): number {
  const read = () => (typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0 ? window.innerWidth : 1280);
  const [w, setW] = useState(read);
  useEffect(() => {
    if (override !== undefined || typeof window === "undefined") return;
    const on = () => setW(read());
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [override]);
  return override ?? w;
}

const KEYFRAMES = "@keyframes ws-panel-in{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion: reduce){.ws-panel,.ws-pane{animation:none!important;transition:none!important}}";

export function ChatComputerLayout({
  botName,
  hasComputer,
  computerLabel,
  chat,
  renderComputer,
  openRequest = false,
  onOpenRequestHandled,
  viewportWidth,
  initialPrefs,
  className,
  toolbarHost,
  onExpandedChange,
  onComputerShownChange,
}: {
  /** Tells the page when the computer is full screen, so it can make everything outside the overlay inert. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Tells the page whether the computer is showing (the side panel is open, or the phone switch is on Computer). */
  onComputerShownChange?: (shown: boolean) => void;
  /** Where the show/hide control (or the Conversation / Computer switch) goes: an element on the page's tab row. Without one, a row of its own sits above the panes. */
  toolbarHost?: HTMLElement | null;
  botName: string;
  /** The bot has a computer assigned. Without one there is no panel, no toggle and no switch: just a note. */
  hasComputer: boolean;
  computerLabel: string;
  /** The conversation. Rendered once, first, always. */
  chat: ReactNode;
  renderComputer: () => ReactNode;
  /** A deep link (?tab=computer) or an "Open computer" link asked for the computer: show it, then say it was handled. */
  openRequest?: boolean;
  onOpenRequestHandled?: () => void;
  /** Tests and previews: pretend the window is this wide. */
  viewportWidth?: number;
  initialPrefs?: PanelPrefs;
  className?: string;
}) {
  const vw = useViewportWidth(viewportWidth);
  // The row's own width (state, so a measurement re-renders and re-clamps); the viewport only until the row has been measured.
  const [rowW, setRowW] = useState(0);
  // R11: a wide window whose row is still too narrow for two comfortable panes (a banner, a zoomed desktop app, a narrow window
  // beside the sidebar) gets the Conversation / Computer switch, never a squeezed side panel.
  const viewportMode = modeFor(vw);
  const mode = viewportMode === "wide" && rowW > 0 && rowW < SIDE_BY_SIDE_MIN ? "tablet" : viewportMode;
  const wide = mode === "wide";
  const reduced = useReducedMotion();
  const [prefs, setPrefs] = useState<PanelPrefs>(() => initialPrefs ?? readPrefs());
  const [view, setView] = useState<LayoutView>("conversation");
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);
  const panelId = useId();
  const [dragging, setDragging] = useState(false);

  const persist = useCallback((next: PanelPrefs) => {
    setPrefs(next);
    writePrefs(next);
  }, []);

  // A link that asks for the computer opens it, wherever the layout is.
  useEffect(() => {
    if (!openRequest) return;
    if (hasComputer) {
      if (wide) persist({ ...prefs, open: true });
      else setView("computer");
    }
    onOpenRequestHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  // No computer, nothing to expand.
  useEffect(() => {
    if (!hasComputer || !wide) setExpanded(false);
  }, [hasComputer, wide]);
  // Full screen: the browser's own full-screen mode where it allows it (Escape is then the browser's, and we follow it out); otherwise the
  // overlay over the conversation does the job on its own.
  const asideRef = useRef<HTMLElement>(null);
  const nativeFullscreen = useRef(false);
  const setFull = (next: boolean) => {
    setExpanded(next);
    const el = asideRef.current;
    if (next && el && typeof el.requestFullscreen === "function") {
      try {
        // Some embedded views return nothing instead of a promise, or throw; either way the overlay already works.
        const asked: unknown = el.requestFullscreen();
        if (asked && typeof (asked as Promise<void>).then === "function") (asked as Promise<void>).then(() => { nativeFullscreen.current = true; }, () => undefined);
        else if (typeof document !== "undefined" && document.fullscreenElement === el) nativeFullscreen.current = true;
      } catch {
        /* the overlay stands in */
      }
    } else if (!next && nativeFullscreen.current && typeof document !== "undefined" && document.fullscreenElement) {
      nativeFullscreen.current = false;
      void document.exitFullscreen?.().catch(() => undefined);
    }
  };
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => {
      if (!document.fullscreenElement && nativeFullscreen.current) {
        nativeFullscreen.current = false;
        setExpanded(false);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Escape meant for a dialog or for the remote screen is theirs, not ours.
      const at = document.activeElement as HTMLElement | null;
      if (at && (at.tagName === "IFRAME" || at.tagName === "CANVAS" || at.closest?.('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog'))) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog')) return;
      setFull(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);
  // Focus follows the overlay in and back out.
  useEffect(() => {
    if (expanded) collapseRef.current?.focus();
    else if (wasExpanded.current) expandRef.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);

  const showPanel = hasComputer && (wide ? prefs.open : view === "computer");
  // The overlay only exists with the panel: when the panel closes (the toggle, the phone switch, a layout change) the full screen ends with it,
  // so the conversation is never left inert behind nothing.
  useEffect(() => {
    if (expanded && !showPanel) setFull(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, showPanel]);
  const callbacks = useRef({ onExpandedChange, onComputerShownChange });
  callbacks.current = { onExpandedChange, onComputerShownChange };
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);
  useEffect(() => {
    onComputerShownChange?.(showPanel);
  }, [showPanel, onComputerShownChange]);
  useEffect(
    () => () => {
      callbacks.current.onExpandedChange?.(false);
      callbacks.current.onComputerShownChange?.(false);
    },
    [],
  );
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = () => setRowW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [wide, hasComputer]);
  const available = () => rowW || rowRef.current?.clientWidth || vw;
  const width = clampWidth(prefs.width, available());
  const max = panelMax(available());

  const onSeparatorKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = widthForKey(e.key, width, available(), e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    persist({ ...prefs, width: next });
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* a synthetic pointer */
    }
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !rowRef.current) return;
    const right = rowRef.current.getBoundingClientRect().right;
    setPrefs((p) => ({ ...p, width: clampWidth(right - e.clientX, available()) }));
  };
  const endDrag = () => {
    if (!dragging) return;
    setDragging(false);
    setPrefs((p) => {
      writePrefs(p);
      return p;
    });
  };

  const pane = (active: boolean) => ({ transition: reduced ? "none" : "opacity 160ms ease", opacity: active ? 1 : 0 });

  // The controls for the computer. In the page's tab row (toolbarHost) when it gave one, otherwise a row of their own above the panes.
  // With a host the page's own status line already says a bot has no computer, so nothing is repeated on the tab row.
  const toolbar = !hasComputer ? (
    toolbarHost === undefined ? <p className="text-sm text-muted-foreground" data-testid="no-computer-note">{botName} has no computer. Pick one in Setup.</p> : null
  ) : wide ? (
    <button
      ref={toggleRef}
      type="button"
      aria-pressed={prefs.open}
      aria-controls={panelId}
      onClick={() => persist({ ...prefs, open: !prefs.open })}
      className="ds-interactive inline-flex h-10 items-center gap-2 rounded-xl border border-border px-3.5 text-sm font-medium hover:bg-surface-raised"
    >
      {prefs.open ? <PanelRightClose aria-hidden="true" className="size-4" /> : <PanelRightOpen aria-hidden="true" className="size-4" />}
      {prefs.open ? "Hide computer" : "Show computer"}
    </button>
  ) : (
    <Segmented<LayoutView> ariaLabel={`${botName}: conversation or computer`} value={view} onChange={setView} options={[{ value: "conversation", label: "Conversation" }, { value: "computer", label: "Computer" }]} />
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3", className)} data-chat-computer data-layout={mode} data-view={wide ? undefined : view} data-motion={reduced ? "reduced" : "full"} data-expanded={expanded ? "true" : undefined}>
      <style>{KEYFRAMES}</style>
      {toolbarHost === undefined ? <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">{toolbar}</div> : toolbarHost ? createPortal(toolbar, toolbarHost) : null}

      <div
        ref={rowRef}
        className={cn(wide ? "flex" : "grid", "relative min-h-[22rem] flex-1 pb-[env(safe-area-inset-bottom)]")}
      >
        <div
          key="conversation"
          data-pane="conversation"
          className={cn("ws-pane flex min-h-0 min-w-0 flex-col", wide ? "flex-1" : "col-start-1 row-start-1", !wide && view !== "conversation" && "pointer-events-none invisible")}
          style={wide ? undefined : pane(view === "conversation")}
          {...((!wide && view !== "conversation") || expanded ? { inert: true, "aria-hidden": true } : {})}
        >
          {chat}
        </div>

        {wide && showPanel && !expanded && (
          <div
            key="separator"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the computer panel"
            aria-controls={panelId}
            aria-valuenow={width}
            aria-valuemin={320}
            aria-valuemax={max}
            tabIndex={0}
            onKeyDown={onSeparatorKey}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => persist({ ...prefs, width: clampWidth(PANEL_DEFAULT, available()) })}
            className="group relative w-3 shrink-0 cursor-col-resize touch-none outline-none"
          >
            <span aria-hidden="true" className={cn("absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-brand group-focus-visible:w-0.5 group-focus-visible:bg-brand", dragging && "w-0.5 bg-brand")} />
            {/* R11: a visible grip, so the panel reads as resizable before anyone hovers it. */}
            <span aria-hidden="true" className={cn("absolute left-1/2 top-1/2 h-12 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-strong group-hover:bg-brand group-focus-visible:bg-brand", dragging && "bg-brand")} />
          </div>
        )}

        {showPanel && (
          <aside
            ref={asideRef}
            key="computer"
            id={panelId}
            aria-label={`${botName}'s computer`}
            data-pane="computer"
            data-expanded={expanded ? "true" : undefined}
            className={cn(
              "ws-panel flex min-h-0 min-w-0 flex-col gap-3",
              wide && !expanded && "shrink-0",
              wide && expanded && "absolute inset-0 z-10 overflow-hidden rounded-2xl border border-border bg-background p-4 shadow-2xl",
              !wide && "col-start-1 row-start-1",
            )}
            style={{
              ...(wide && !expanded ? { width } : {}),
              ...(reduced ? { transition: "none", animation: "none" } : { animation: "ws-panel-in 180ms ease-out" }),
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="min-w-0 truncate text-sm font-medium text-muted-foreground" title={computerLabel}>{computerLabel}</h2>
              {wide && (
                <span className="flex items-center gap-1">
                  <button
                    ref={expanded ? collapseRef : expandRef}
                    type="button"
                    aria-label={expanded ? "Collapse the computer" : "Expand the computer"}
                    aria-pressed={expanded}
                    onClick={() => setFull(!expanded)}
                    className="ds-interactive inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-raised hover:text-foreground"
                  >
                    {expanded ? <Minimize2 aria-hidden="true" className="size-4" /> : <Maximize2 aria-hidden="true" className="size-4" />}
                  </button>
                  {!expanded && (
                    <button
                      type="button"
                      aria-label="Hide the computer"
                      onClick={() => {
                        persist({ ...prefs, open: false });
                        toggleRef.current?.focus();
                      }}
                      className="ds-interactive inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-raised hover:text-foreground"
                    >
                      <PanelRightClose aria-hidden="true" className="size-4" />
                    </button>
                  )}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">{renderComputer()}</div>
          </aside>
        )}
      </div>
    </div>
  );
}
