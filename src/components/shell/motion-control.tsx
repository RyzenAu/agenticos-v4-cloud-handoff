// The header's motion control (NEXUS-ADDENDUM item 5): ambient motion is off ("still") by default; this
// turns it on or off, says when work is holding it still, and says when the system's reduced-motion
// setting has turned it off. It also starts the one motion controller (src/lib/motion.ts).
import { useEffect, useId, useState } from "react";
import { Pause, Waves } from "lucide-react";
import { HOLD_TEXT, readMotion, setMotionPreference, startMotionController, subscribeMotion, type MotionState } from "@/lib/motion";

export function MotionControl() {
  const [s, setS] = useState<MotionState | null>(null);
  const whyId = useId();
  useEffect(() => {
    const stop = startMotionController();
    setS(readMotion());
    const unsub = subscribeMotion(setS);
    return () => {
      unsub();
      stop();
    };
  }, []);
  // Server render and first paint: the default (still), so hydration matches.
  const state = s ?? { preference: "still" as const, reduced: false, holds: [], ambient: false };
  const on = state.preference === "ambient";
  const why = state.reduced
    ? "Reduced motion is on in your system settings, so there is no ambient motion."
    : on && state.holds.length
      ? `Ambient motion is paused ${state.holds.map((h) => HOLD_TEXT[h]).join(" and ")}.`
      : on
        ? "Ambient motion is on. It pauses while you edit, read, decide or talk to Jarvis."
        : "Ambient motion is off. Progress still animates when a step is confirmed.";
  // The button's name is its visible words ("Motion: off"); the reason is its description, said once
  // (audit P2-9: the label used to read "Ambient motion off. Ambient motion is off. ...").
  const word = state.reduced ? "reduced" : on ? (state.holds.length ? "held" : "on") : "off";
  return (
    <button
      type="button"
      className="op-header-ask mc-toggle"
      aria-describedby={whyId}
      aria-pressed={on}
      aria-disabled={state.reduced || undefined}
      data-motion-state={state.reduced ? "reduced" : state.ambient ? "ambient" : on ? "held" : "still"}
      onClick={() => !state.reduced && setMotionPreference(on ? "still" : "ambient")}
      title={why}
    >
      {on && !state.reduced ? <Waves size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
      <span className="hidden 2xl:inline">Motion: {word}</span>
      <span id={whyId} className="sr-only">{why}</span>
    </button>
  );
}
