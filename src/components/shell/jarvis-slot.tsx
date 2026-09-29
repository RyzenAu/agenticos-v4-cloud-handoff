// The global Jarvis entry: a compact live-progress chip in the header of every page, and the
// panel slot on /jarvis. The shell owns the container; the Jev track owns what Jarvis does.
//
// ── Contract for the Jev track ───────────────────────────────────────────────────────────────
// 1. Progress (no import needed). Dispatch the latest state; `null` clears it:
//      window.dispatchEvent(new CustomEvent("jarvis:progress", { detail: JarvisProgress | null }))
//    The chip shows the newest event for 90 s after `done`/`error`, then returns to idle.
// 2. Your own surfaces (optional). Create `src/components/jarvis/surface.tsx` exporting either or
//    both of:
//      export function JarvisChip(props: JarvisChipProps): ReactNode    // replaces the header chip
//      export function JarvisPanel(props: JarvisPanelProps): ReactNode  // fills the /jarvis slot
//    They are picked up by file convention (import.meta.glob), lazily, client-only, inside an
//    error boundary. Keep the chip ≤ 240 px wide and 32 px tall; it must stay a single button.
// 3. Decisions and confidence go to the Inspector, not the chip:
//      window.dispatchEvent(new CustomEvent("jarvis:decision", { detail: { title, detail, confidence, source: "jev" } }))
// Without either, the shell derives progress from the agent feed (src/lib/agent-feed.ts) and the
// voice companion's `voice:surface` event, and the chip opens voice via `operator:voice`.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { readFeed, subscribeFeed, type FeedTask } from "@/lib/agent-feed";
import { IDLE, LINGER_MS, parseProgress, progressFromFeed, type JarvisChipProps, type JarvisPanelProps, type JarvisPhase, type JarvisProgress } from "./jarvis-progress";

export * from "./jarvis-progress";
import { cn } from "@/lib/utils";
import { startJobEventBridge } from "@/lib/job-events";

type SurfaceModule = { JarvisChip?: ComponentType<JarvisChipProps>; JarvisPanel?: ComponentType<JarvisPanelProps> };
const SURFACE = Object.values(import.meta.glob<SurfaceModule>("../jarvis/surface.tsx"))[0];
export const hasJarvisSurface = Boolean(SURFACE);

/** The current Jarvis progress: Jev's own events win, then the agent feed, then voice state. */
export function useJarvisProgress(): { progress: JarvisProgress; history: JarvisProgress[] } {
  const [jev, setJev] = useState<JarvisProgress | null>(null);
  const [feed, setFeed] = useState<FeedTask[]>([]);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [now, setNow] = useState(0);
  const history = useRef<JarvisProgress[]>([]);
  useEffect(() => {
    setNow(Date.now());
    setFeed(readFeed());
    const off = subscribeFeed(setFeed);
    // Stage B2: job events drive `jarvis:progress` / `jarvis:decision` (src/lib/job-events.ts).
    const offJobs = startJobEventBridge();
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail === null) return setJev(null);
      const p = parseProgress(detail);
      if (p) {
        history.current = [p, ...history.current].slice(0, 20);
        setJev(p);
      }
    };
    const onVoice = (event: Event) => setVoiceOpen(Boolean((event as CustomEvent).detail?.open));
    window.addEventListener("jarvis:progress", onProgress);
    window.addEventListener("voice:surface", onVoice);
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      off();
      offJobs();
      window.removeEventListener("jarvis:progress", onProgress);
      window.removeEventListener("voice:surface", onVoice);
      window.clearInterval(tick);
    };
  }, []);
  const progress = useMemo(() => {
    const fresh = jev && (jev.phase !== "done" && jev.phase !== "error" ? true : now - jev.at < LINGER_MS) ? jev : null;
    if (fresh && fresh.phase !== "idle") return fresh;
    const fromFeed = now ? progressFromFeed(feed, now) : null;
    if (fromFeed) return fromFeed;
    if (voiceOpen) return { phase: "listening" as const, label: "Voice open", source: "voice" as const, at: now };
    return IDLE;
  }, [jev, feed, voiceOpen, now]);
  return { progress, history: history.current };
}

export function openJarvis() {
  window.dispatchEvent(new CustomEvent("operator:voice"));
}

/** Jarvis in Text mode: typed requests go through the command registry and the same turn as speech. */
export function openJarvisText() {
  window.dispatchEvent(new CustomEvent("operator:voice-text"));
}

function elapsed(from: number | undefined, now: number) {
  if (!from || !now || now < from) return null;
  const s = Math.round((now - from) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The shell's own chip. Motion only while something is happening. */
export function DefaultJarvisChip({ progress, onOpen, compact }: JarvisChipProps) {
  const [now, setNow] = useState(0);
  const running = progress.phase === "acting" || progress.phase === "thinking";
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  const time = running ? elapsed(progress.startedAt, now) : null;
  const stepText = progress.step ? `Step ${progress.step.index}${progress.step.total ? ` of ${progress.step.total}` : ""}` : null;
  const idle = progress.phase === "idle";
  return (
    <button
      type="button"
      className={cn("sh-jarvis-chip", `is-${progress.phase}`, compact && "is-compact")}
      onClick={onOpen}
      aria-label={idle ? "Talk to Jarvis" : `Jarvis: ${progress.label}${stepText ? `, ${stepText}` : ""}. Open Jarvis`}
      title={progress.step?.text ?? (idle ? "Talk to Jarvis" : progress.label)}
    >
      <span className="sh-jarvis-signal" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact && <span className="sh-jarvis-label">{progress.label}</span>}
      {!compact && (stepText || time) && (
        <span className="sh-jarvis-meta ds-num">{[stepText, time].filter(Boolean).join(" · ")}</span>
      )}
    </button>
  );
}

class SurfaceBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const LazyChip = SURFACE
  ? lazy(() => SURFACE().then((m) => ({ default: (m.JarvisChip ?? DefaultJarvisChip) as ComponentType<JarvisChipProps> })))
  : null;
const LazyPanel = SURFACE
  ? lazy(() => SURFACE().then((m) => ({ default: (m.JarvisPanel ?? (() => null)) as ComponentType<JarvisPanelProps> })))
  : null;

/** Header slot: Jev's chip when the Jev track provides one, otherwise the shell's. */
export function JarvisChipSlot({ compact = false }: { compact?: boolean }) {
  const { progress } = useJarvisProgress();
  const [client, setClient] = useState(false);
  useEffect(() => setClient(true), []);
  const announce = useAnnouncement(progress);
  const fallback = <DefaultJarvisChip progress={progress} onOpen={openJarvis} compact={compact} />;
  return (
    <>
      {LazyChip && client ? (
        <SurfaceBoundary fallback={fallback}>
          <Suspense fallback={fallback}>
            <LazyChip progress={progress} onOpen={openJarvis} compact={compact} />
          </Suspense>
        </SurfaceBoundary>
      ) : (
        fallback
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </>
  );
}

/** Announce phase changes (not every step) to screen readers. */
function useAnnouncement(progress: JarvisProgress) {
  const [text, setText] = useState("");
  const last = useRef<JarvisPhase>("idle");
  useEffect(() => {
    if (progress.phase === last.current) return;
    last.current = progress.phase;
    setText(progress.phase === "idle" ? "" : `Jarvis: ${progress.label}`);
  }, [progress.phase, progress.label]);
  return text;
}

/** /jarvis slot: Jev's panel when provided; `fallback` otherwise. */
export function JarvisPanelSlot({ fallback }: { fallback: ReactNode }) {
  const { progress, history } = useJarvisProgress();
  const [client, setClient] = useState(false);
  useEffect(() => setClient(true), []);
  if (!LazyPanel || !client) return <>{fallback}</>;
  return (
    <SurfaceBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <LazyPanel progress={progress} history={history} onOpen={openJarvis} />
      </Suspense>
    </SurfaceBoundary>
  );
}
