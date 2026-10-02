import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Monitor, Pause, Play, Square, Volume2 } from "lucide-react";
import {
  pauseShare,
  screenShareSupported,
  setCloudVision,
  shareState,
  startShare,
  stopShare,
  subscribeShare,
  type ShareState,
} from "@/lib/screen-share";

/**
 * Header control for sharing a screen/window/tab with Jarvis. Off by default; he picks what to
 * share. While sharing, a live pill says exactly that Jarvis can see it, with pause and stop.
 * Frames are only taken when he asks about the screen, and only if he has allowed analysis.
 */
export function ScreenShareControl({ labels = "xl" }: { labels?: "xl" | "always" } = {}) {
  const [s, setS] = useState<ShareState>(() => shareState());
  const [asking, setAsking] = useState(false);
  const [withAudio, setWithAudio] = useState(false);
  const [error, setError] = useState("");
  // Whether getDisplayMedia exists depends on the browser and only the client knows. Default to
  // the same value on the server and on first client paint (button enabled, unsupported only
  // discovered post-mount) so hydration never disagrees with what was actually rendered.
  const [mounted, setMounted] = useState(false);
  const [supported, setSupported] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => subscribeShare(setS), []);
  useEffect(() => {
    setMounted(true);
    setSupported(screenShareSupported());
  }, []);
  const unsupported = mounted && !supported;

  useEffect(() => {
    if (!asking) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAsking(false);
    };
    const closeOutside = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setAsking(false);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("mousedown", closeOutside);
    return () => {
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("mousedown", closeOutside);
    };
  }, [asking]);

  async function begin() {
    setError("");
    try {
      await startShare({ audio: withAudio });
      setAsking(false);
    } catch (e) {
      const msg = (e as Error).message || "";
      // Cancelling Chrome's picker isn't an error worth shouting about.
      if (!/denied|abort|cancel/i.test(msg)) setError(msg);
    }
  }

  if (!s.sharing)
    return (
      <div className="relative" ref={wrap}>
        <button
          className="op-header-ask inline-flex items-center gap-1.5"
          onClick={() => {
            if (unsupported) return;
            s.cloudVision ? void begin() : setAsking((v) => !v);
          }}
          disabled={unsupported}
          aria-disabled={unsupported || undefined}
          aria-label="Share screen"
          title={unsupported ? "Screen sharing isn't supported in this browser" : "Let Jarvis see a window, tab or screen you choose"}
        >
          <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
          {/* Text only where there is room (xl); the drawer, which has room, always shows it. */}
          <span className={labels === "always" ? "" : "hidden xl:inline"}>Share screen</span>
        </button>
        {asking && !unsupported && (
          <div className="absolute right-0 top-10 z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover p-4 text-xs text-popover-foreground shadow-2xl" data-testid="share-consent">
            <div className="mb-2 text-sm font-medium text-foreground">Let Jarvis see your screen?</div>
            <p className="mb-2 leading-relaxed text-muted-foreground">
              Jarvis only looks when you ask. You choose the window, tab or screen; each time you
              ask, one downscaled frame goes to GPT-6 through your ChatGPT subscription (Gemini if
              that's down) and the answer is read back. Nothing is saved.
            </p>
            <p className="mb-3 leading-relaxed text-muted-foreground">
              Don't share banking, passwords or a client's private records. Pause any time.
            </p>
            <label className="mb-3 flex items-center gap-2 text-muted-foreground">
              <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} />
              Include the tab's audio (last 30 s, memory only)
            </label>
            {error && <div className="mb-2 text-red-400">{error}</div>}
            <div className="flex justify-end gap-2">
              <button className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground" onClick={() => setAsking(false)}>
                Not now
              </button>
              <button
                className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                onClick={() => {
                  setCloudVision(true);
                  void begin();
                }}
              >
                Allow and choose
              </button>
            </div>
          </div>
        )}
      </div>
    );

  return (
    <div
      className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 py-1 pl-2.5 pr-1 text-xs text-emerald-300"
      title={`Jarvis can see: ${s.label}`}
    >
      {s.paused ? <EyeOff className="h-3.5 w-3.5 text-amber-300" /> : <Eye className="h-3.5 w-3.5 animate-pulse" />}
      <span className="max-w-[160px] truncate">
        {s.paused ? "Paused" : "Jarvis can see"}
        <span className="hidden text-emerald-200/70 lg:inline">: {s.label}</span>
      </span>
      {s.audio && !s.paused && <Volume2 className="h-3 w-3 text-emerald-200/80" aria-label="Hearing tab audio" />}
      <button className="ml-1 rounded-full p-1 hover:bg-white/10" onClick={() => pauseShare(!s.paused)} title={s.paused ? "Resume" : "Pause"}>
        {s.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
      </button>
      <button className="rounded-full p-1 hover:bg-white/10" onClick={() => stopShare()} title="Stop sharing">
        <Square className="h-3 w-3" />
      </button>
    </div>
  );
}
