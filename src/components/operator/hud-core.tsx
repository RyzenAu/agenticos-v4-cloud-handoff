// The heart of the HUD: the model orb inside a status ring. Each arc of the ring is one connected
// service (Hermes, Jev, Hindsight, SearXNG, Telegram) with a live health dot, read from GET
// /__operator/hud/services (the capability registry plus a 1.5 s ping of the local services —
// no model probes). Hover or focus a service for its evidence.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BRAINS, readSignal, subscribeSignal } from "@/lib/jarvis-signal";
import { ModelOrb } from "./model-orb";
import "./jarvis-hud-upgrade.css";

type Dot = { id: string; label: string; state: "up" | "warn" | "down" | "unknown"; detail: string };
type Services = { checkedAt: string; services: Dot[] };

const SIZE = 196;
const R = 90;
const GAP = 14; // degrees between arcs

function arc(startDeg: number, endDeg: number) {
  const rad = (d: number) => ((d - 90) * Math.PI) / 180;
  const c = SIZE / 2;
  const [x1, y1] = [c + R * Math.cos(rad(startDeg)), c + R * Math.sin(rad(startDeg))];
  const [x2, y2] = [c + R * Math.cos(rad(endDeg)), c + R * Math.sin(rad(endDeg))];
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${endDeg - startDeg > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function useHudServices(enabled = true) {
  return useQuery<Services>({
    queryKey: ["hud-services"],
    queryFn: async () => {
      const r = await fetch("/__operator/hud/services", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    refetchInterval: 20_000,
    enabled,
    retry: false,
  });
}

// "unknown" covers configured-but-unverified (a key is present) as well as not-yet-checked: never green.
const stateWord = { up: "verified up", warn: "needs setup", down: "down or failing", unknown: "not verified" } as const;

export function HudCore() {
  const services = useHudServices();
  const dots = services.data?.services ?? [];
  const n = Math.max(dots.length, 1);
  const span = 360 / n;
  const c = SIZE / 2;
  return (
    <section className="hud-core" aria-label="Jarvis and connected services">
      <div className="hud-core-stage" style={{ width: SIZE, height: SIZE }}>
        <svg className="hud-ring" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle cx={c} cy={c} r={R} className="hud-ring-track" />
          {dots.map((dot, i) => {
            const start = i * span + GAP / 2;
            const end = (i + 1) * span - GAP / 2;
            const mid = ((start + end) / 2 - 90) * (Math.PI / 180);
            return (
              <g key={dot.id} data-state={dot.state}>
                <path d={arc(start, end)} className="hud-ring-arc" />
                <circle cx={c + R * Math.cos(mid)} cy={c + R * Math.sin(mid)} r={2.6} className="hud-ring-dot" />
              </g>
            );
          })}
        </svg>
        <ModelOrb className="hud-core-orb" />
      </div>
      <ModelOrbCaption />
      <ul className="hud-services" aria-label="Service health">
        {services.isError && <li className="hud-service" data-state="unknown">Service health unavailable</li>}
        {dots.map((dot) => (
          <li key={dot.id} className="hud-service" data-state={dot.state} title={dot.detail} tabIndex={0} aria-label={`${dot.label}: ${stateWord[dot.state]}. ${dot.detail}`}>
            <i aria-hidden="true" />
            {dot.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Groq · listening" under the orb, following the live voice signal. */
function ModelOrbCaption() {
  const [signal, setSignal] = useState(() => ({ ...readSignal() }));
  useEffect(() => subscribeSignal((s) => setSignal({ ...s })), []);
  const info = BRAINS[signal.brain];
  const doing = signal.working && signal.phase === "idle" ? "working" : signal.phase === "connecting" ? "connecting" : signal.phase === "idle" ? (signal.active ? "ready" : "at rest") : signal.phase;
  return (
    <p className="hud-core-caption" title={signal.model ? `${info.hint} · ${signal.model}` : info.hint}>
      <strong>{info.label}</strong>
      <span>{doing}</span>
    </p>
  );
}
