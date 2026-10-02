import { useEffect, useState } from "react";
import { Eye, GraduationCap, MousePointerClick, Square } from "lucide-react";
import { drivingTitle, stopDriving, subscribeDrive, type DriveState } from "@/lib/screen-drive";

/**
 * While screen_act drives his screen or a lesson runs: a small fixed pill with a "Teaching" or
 * "Driving" chip ("Jarvis is teaching… say next or stop" / "Jarvis is driving… say stop") and a
 * Stop button, and the same words at the front of the tab title so the taskbar shows it when the
 * OS window is behind the app being driven.
 */
export function ScreenDrivePill() {
  const [s, setS] = useState<DriveState>({ on: false, goal: "", step: "", mode: "driving" });
  useEffect(() => subscribeDrive(setS), []);
  useEffect(() => {
    document.title = drivingTitle(document.title, s.on, s.mode);
  }, [s.on, s.mode]);
  if (!s.on) return null;
  const teaching = s.mode === "teaching";
  const watching = s.mode === "watching";
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 top-3 z-[2147483000] flex -translate-x-1/2 items-center gap-2 rounded-full border border-sky-400/40 bg-slate-950/90 py-1.5 pl-3 pr-1.5 text-xs text-sky-100 shadow-2xl backdrop-blur-md"
      title={s.goal ? `Doing: ${s.goal}` : undefined}
    >
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${teaching ? "bg-amber-300/15 text-amber-200" : watching ? "bg-emerald-300/15 text-emerald-200" : "bg-sky-400/15 text-sky-200"}`}>
        {teaching ? <GraduationCap className="h-3.5 w-3.5" /> : watching ? <Eye className="h-3.5 w-3.5" /> : <MousePointerClick className="h-3.5 w-3.5 animate-pulse" />}
        {teaching ? "Teaching" : watching ? "Tutor on" : "Driving"}
      </span>
      <span>
        {watching ? (
          <>
            Quiet unless you look stuck… <span className="text-sky-300">say stop watching</span>
          </>
        ) : teaching ? (
          <>
            Follow the blue cursor… <span className="text-sky-300">say next or stop</span>
          </>
        ) : (
          <>
            Jarvis is driving… <span className="text-sky-300">say stop</span>
          </>
        )}
      </span>
      {s.step && <span className="hidden max-w-[220px] truncate text-sky-200/70 md:inline">· {s.step}</span>}
      <button className="ml-1 inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 hover:bg-white/20" onClick={() => void stopDriving()}>
        <Square className="h-3 w-3" /> Stop
      </button>
    </div>
  );
}
