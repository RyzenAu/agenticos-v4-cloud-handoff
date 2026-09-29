// The header's "More" menu (W-G, 29 Sep 2026: the top bar had ten controls, four of them tiny
// icons without labels). The view and tooling toggles live here as labelled rows: the Jarvis HUD,
// ambient motion, the Inspector and the theme. What reports live state stays in the bar itself:
// Jarvis, screen sharing, meeting mode and background jobs.
//
// The panel is hidden, never unmounted: MotionControl starts the one motion controller when it
// mounts, and the Inspector toggle keeps its id for the hydration click guard.
import { useEffect, useId, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { JarvisHudToggle } from "@/components/operator/jarvis-hud";
import { InspectorToggle, useInspector } from "./inspector";
import { MotionControl } from "./motion-control";

export function HeaderMore() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { entries } = useInspector();
  const warnings = entries.filter((e) => e.tone === "danger" || e.tone === "warn").length;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        wrap.current?.querySelector<HTMLButtonElement>(".sh-more-trigger")?.focus();
      }
    };
    const onDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={wrap} className="sh-more">
      <button
        type="button"
        className="op-header-ask sh-more-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        aria-label={`More${warnings > 0 ? `, ${warnings} Inspector ${warnings === 1 ? "warning" : "warnings"}` : ""}`}
        title="HUD, motion, Inspector and theme"
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        <span className="hidden xl:inline">More</span>
        {warnings > 0 && (
          <b className="sh-count" aria-hidden="true">
            {warnings > 9 ? "9+" : warnings}
          </b>
        )}
      </button>
      <div
        id={panelId}
        className="sh-more-panel"
        role="group"
        aria-label="More controls"
        hidden={!open}
        // A chosen action closes the menu (the theme switch stays open so its change is seen).
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(".op-header-ask")) setOpen(false);
        }}
      >
        <JarvisHudToggle id="jarvis-hud-toggle" />
        <MotionControl />
        <InspectorToggle />
        <div className="sh-more-row">
          <span>Dark mode</span>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
