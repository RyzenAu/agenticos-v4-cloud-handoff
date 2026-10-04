// The model orb: Jarvis's presence. Colour is the brain answering right now; motion is the real
// voice state (see src/lib/jarvis-signal.ts). Drawn by the pure renderOrb(); this component only
// smooths inputs and schedules frames — 60 fps while something is happening, 30 fps at rest,
// nothing at all while hidden or scrolled away, one still frame for reduced motion.
import { useEffect, useRef, useState } from "react";
import { BRAINS, readSignal, subscribeSignal, type BrainId, type SignalPhase } from "@/lib/jarvis-signal";
import { ORB_PALETTES, orbParticles, orbSprite, renderOrb } from "@/lib/model-orb-render";
import "./jarvis-hud-upgrade.css";

type Perf = { frames: number; renderMs: number; since: number };
declare global {
  // Frames drawn and ms spent drawing, for the orb's CPU check in the browser console.
  var __jarvisOrbPerf: Perf | undefined;
}

export type OrbOverride = { phase?: SignalPhase; mic?: number; out?: number; brain?: BrainId; working?: boolean };

export function ModelOrb({
  compact = false,
  showLabel = false,
  className = "",
  override,
}: {
  compact?: boolean;
  showLabel?: boolean;
  className?: string;
  /** Force a state (previews); otherwise the live voice signal drives the orb. */
  override?: OrbOverride;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overrideRef = useRef(override);
  overrideRef.current = override;
  const [brain, setBrain] = useState<BrainId>(() => override?.brain ?? readSignal().brain);
  const [model, setModel] = useState(() => readSignal().model);
  const [phase, setPhase] = useState<SignalPhase>(() => override?.phase ?? readSignal().phase);

  useEffect(
    () =>
      subscribeSignal((signal) => {
        setBrain(overrideRef.current?.brain ?? signal.brain);
        setModel(signal.model);
        setPhase(overrideRef.current?.phase ?? signal.phase);
      }),
    [],
  );
  useEffect(() => {
    if (override?.brain) setBrain(override.brain);
    if (override?.phase) setPhase(override.phase);
  }, [override?.brain, override?.phase]);

  const brainRef = useRef(brain);
  brainRef.current = brain;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d", { alpha: true });
    if (!el || !ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const particles = orbParticles(compact ? 150 : 320);
    let spriteBrain: BrainId | null = null;
    let sprites: HTMLCanvasElement[] = [];
    const ensureSprites = () => {
      if (spriteBrain === brainRef.current) return;
      spriteBrain = brainRef.current;
      const p = ORB_PALETTES[spriteBrain];
      sprites = [orbSprite(p.core, 32), orbSprite(p.mid), orbSprite(p.rim)];
    };
    let width = 0,
      height = 0,
      raf = 0,
      sleeper = 0,
      last = 0,
      visible = true,
      stillKey = "";
    const mix = { listen: 0, think: 0, speak: 0, mic: 0, out: 0 };
    const perf: Perf = (globalThis.__jarvisOrbPerf ??= { frames: 0, renderMs: 0, since: performance.now() });

    const resize = () => {
      // Layout size, not getBoundingClientRect: that one shrinks mid open-animation (scale).
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = el.clientWidth;
      height = el.clientHeight;
      el.width = Math.max(1, Math.round(width * ratio));
      el.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      stillKey = "";
      schedule();
    };

    const draw = (t: number) => {
      ensureSprites();
      const started = performance.now();
      renderOrb(ctx, t, { width, height, ...mix, sprites, palette: ORB_PALETTES[spriteBrain!], compact }, particles);
      perf.frames++;
      perf.renderMs += performance.now() - started;
    };

    const tick = (stamp: number) => {
      raf = 0;
      if (!visible || document.hidden) return; // resumes on visibility/intersection
      const signal = readSignal();
      const o = overrideRef.current;
      const phaseNow = o?.phase ?? signal.phase;
      const working = o?.working ?? signal.working;
      if (reduced.matches) {
        // One finished still per state/colour/size; no loop.
        const key = `${brainRef.current}:${width}x${height}`;
        if (key !== stillKey) {
          stillKey = key;
          Object.assign(mix, { listen: 0, think: 0, speak: 0, mic: 0, out: 0 });
          draw(2.2);
        }
        return;
      }
      const busy = phaseNow !== "idle" || working;
      // 20 fps is plenty for a 5 s breath and a slow spin; anything live gets the full 60. Paced on
      // a fixed grid so a 120/144 Hz screen doesn't double the work.
      const frameMs = busy ? 1000 / 60 : 1000 / 20;
      if (stamp - last >= frameMs - 2) {
        const dt = last ? Math.min(0.1, (stamp - last) / 1000) : 1 / 60;
        last = stamp - last > frameMs * 3 ? stamp : last + frameMs;
        const ease = 1 - Math.exp(-dt * 5);
        const target = {
          listen: phaseNow === "listening" ? 1 : 0,
          think: phaseNow === "thinking" || phaseNow === "connecting" ? 1 : working ? 0.55 : 0,
          speak: phaseNow === "speaking" ? 1 : 0,
        };
        mix.listen += (target.listen - mix.listen) * ease;
        mix.think += (target.think - mix.think) * ease;
        mix.speak += (target.speak - mix.speak) * ease;
        let levels = { mic: o?.mic ?? 0, out: o?.out ?? 0 };
        if (!o || (o.mic === undefined && o.out === undefined)) {
          try {
            levels = signal.meter ? signal.meter() : { mic: 0, out: 0 };
          } catch {
            levels = { mic: 0, out: 0 };
          }
          // Browser speech (text mode) can't be metered; give it a gentle syllable rhythm instead.
          if (!signal.meter && phaseNow === "speaking") {
            const s = stamp / 1000;
            levels.out = 0.22 + 0.3 * Math.abs(Math.sin(s * 6.1)) * Math.abs(Math.sin(s * 1.7 + 0.6));
          }
        }
        // Fast attack, slower release, so syllables read as pulses rather than jitter.
        for (const key of ["mic", "out"] as const) {
          const v = Math.min(1, Math.max(0, levels[key] * 1.6));
          mix[key] += (v - mix[key]) * (v > mix[key] ? 0.55 : 0.14);
        }
        draw(stamp / 1000);
      }
      // At rest, sleep until the next frame is due instead of waking on every vsync (each
      // requestAnimationFrame costs a main-thread frame even when nothing is drawn).
      const wait = last + frameMs - performance.now() - 6;
      if (!busy && wait > 4) sleeper = window.setTimeout(schedule, wait);
      else schedule();
    };
    function schedule() {
      if (sleeper) {
        window.clearTimeout(sleeper);
        sleeper = 0;
      }
      if (!raf) raf = requestAnimationFrame(tick);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) schedule();
    });
    io.observe(el);
    const onVisibility = () => !document.hidden && schedule();
    document.addEventListener("visibilitychange", onVisibility);
    const onMotion = () => {
      stillKey = "";
      schedule();
    };
    reduced.addEventListener("change", onMotion);
    const unsubscribe = subscribeSignal(() => schedule());
    resize();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(sleeper);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotion);
      unsubscribe();
    };
  }, [compact]);

  const info = BRAINS[brain];
  const state =
    phase === "speaking" ? "speaking" : phase === "listening" ? "listening" : phase === "thinking" || phase === "connecting" ? "thinking" : "at rest";
  return (
    <div className={`model-orb ${compact ? "is-compact" : ""} ${className}`} data-brain={brain} data-phase={phase}>
      <canvas ref={canvas} className="model-orb-canvas" aria-hidden="true" />
      {showLabel && (
        <p className="model-orb-label" title={model ? `${info.hint} · ${model}` : info.hint}>
          <i aria-hidden="true" />
          <span>{info.label}</span>
          <span className="model-orb-state">{state}</span>
        </p>
      )}
      {!showLabel && <span className="sr-only">{`${info.label}, ${state.toLowerCase()}`}</span>}
    </div>
  );
}
