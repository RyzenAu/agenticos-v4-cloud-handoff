import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "map-pin-drop",
  name: "Map pin drop",
  tagline: "Streets draw in, a gold pin lands, the address rises",
  category: "Local",
  move: "The streets draw in over a second, a gold pin drops onto the practice with one soft bounce, two ripples spread from where it lands, and the address card rises beside it. Plays once when it scrolls into view.",
  reduced: "The map, pin and card are shown in place: no drawing, drop, bounce or ripple.",
  useFor:
    'The "Find us" section of a local business: the suburb, the landmark and the nearest station. Link the card to the real map listing.',
  html: `
<div class="mu-map" data-mu-kit="map-pin-drop">
  <svg class="mu-map__streets" viewBox="0 0 400 250" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <path class="mu-map__road mu-map__road--main" d="M-10 170 C 90 150, 150 120, 230 128 S 360 150, 410 110" />
    <path class="mu-map__road" d="M60 -10 L 90 260" />
    <path class="mu-map__road" d="M170 -10 L 185 260" />
    <path class="mu-map__road" d="M300 -10 L 280 260" />
    <path class="mu-map__road" d="M-10 60 L 410 80" />
    <path class="mu-map__road" d="M-10 225 L 410 205" />
    <path class="mu-map__rail" d="M-10 30 C 120 45, 260 10, 410 38" />
    <rect class="mu-map__park" x="196" y="150" width="70" height="44" rx="10" />
  </svg>
  <span class="mu-map__ripple" aria-hidden="true"></span>
  <span class="mu-map__ripple mu-map__ripple--2" aria-hidden="true"></span>
  <svg class="mu-map__pin" viewBox="0 0 32 44" aria-hidden="true"><path d="M16 1C7.7 1 1 7.6 1 15.8 1 27 16 43 16 43s15-16 15-27.2C31 7.6 24.3 1 16 1z" /><circle cx="16" cy="16" r="5.6" /></svg>
  <div class="mu-map__card">
    <p class="mu-map__name">Lantern Dental</p>
    <p class="mu-map__meta">2 min walk from Parramatta station</p>
  </div>
</div>`,
  css: `
${rootRule(
  ".mu-map",
  `  position: relative;
  width: min(100%, 560px);
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-radius: 20px;
  background: radial-gradient(120% 100% at 45% 55%, #17150f, var(--mu-bg) 75%);
  box-shadow: 0 0 0 1px var(--mu-line);
  font-family: var(--mu-sans);
  color: var(--mu-ink);
  --pin-x: 46%;
  --pin-y: 50%;`,
)}
.mu-map__streets { position: absolute; inset: 0; width: 100%; height: 100%; }
.mu-map__road { fill: none; stroke: rgba(243, 239, 230, 0.14); stroke-width: 5; stroke-linecap: round; stroke-dasharray: 600; stroke-dashoffset: 0; }
.mu-map__road--main { stroke: rgba(199, 163, 90, 0.35); stroke-width: 9; }
.mu-map__rail { fill: none; stroke: rgba(243, 239, 230, 0.22); stroke-width: 2; stroke-dasharray: 6 6; }
.mu-map__park { fill: rgba(120, 140, 90, 0.16); }
.mu-map__pin {
  position: absolute;
  left: var(--pin-x);
  top: var(--pin-y);
  width: 34px;
  height: 46px;
  margin: -46px 0 0 -17px;
  filter: drop-shadow(0 10px 10px rgba(0, 0, 0, 0.6));
}
.mu-map__pin path { fill: var(--mu-gold); }
.mu-map__pin circle { fill: var(--mu-bg); }
.mu-map__ripple {
  position: absolute;
  left: var(--pin-x);
  top: var(--pin-y);
  width: 90px;
  height: 36px;
  margin: -18px 0 0 -45px;
  border-radius: 50%;
  border: 2px solid var(--mu-gold);
  opacity: 0;
}
.mu-map__card {
  position: absolute;
  left: calc(var(--pin-x) + 26px);
  top: calc(var(--pin-y) - 34px);
  padding: 10px 14px;
  border-radius: 14px;
  background: rgba(19, 19, 19, 0.92);
  box-shadow: 0 0 0 1px var(--mu-line), 0 16px 30px -16px rgba(0, 0, 0, 0.9);
}
.mu-map__card p { margin: 0; }
.mu-map__name { font-family: var(--mu-display); font-size: 1.1rem; }
.mu-map__meta { margin-top: 2px; font-size: 0.8rem; color: var(--mu-muted); }
.mu-map[data-armed] .mu-map__road { stroke-dashoffset: 600; }
.mu-map[data-armed] .mu-map__pin { transform: translateY(-140px); opacity: 0; }
.mu-map[data-armed] .mu-map__card { transform: translateY(10px); opacity: 0; }
.mu-map[data-play] .mu-map__road { animation: mu-map-draw 1.2s var(--mu-ease-in-out) forwards; }
.mu-map[data-play] .mu-map__road:nth-of-type(2n) { animation-delay: 0.12s; }
.mu-map[data-play] .mu-map__pin { animation: mu-map-drop 0.75s cubic-bezier(0.34, 1.5, 0.64, 1) 0.85s forwards; }
.mu-map[data-play] .mu-map__ripple { animation: mu-map-ripple 1.4s ease-out 1.35s; }
.mu-map[data-play] .mu-map__ripple--2 { animation-delay: 1.75s; }
.mu-map[data-play] .mu-map__card { animation: mu-map-card 0.7s var(--mu-ease) 1.5s forwards; }
@keyframes mu-map-draw { to { stroke-dashoffset: 0; } }
@keyframes mu-map-drop { 0% { transform: translateY(-140px); opacity: 0; } 30% { opacity: 1; } 100% { transform: none; opacity: 1; } }
@keyframes mu-map-ripple { 0% { transform: scale(0.2); opacity: 0.9; } 100% { transform: scale(1.6); opacity: 0; } }
@keyframes mu-map-card { to { transform: none; opacity: 1; } }
@media (max-width: 420px) {
  .mu-map__card { left: 8%; right: 8%; top: auto; bottom: 7%; }
}
@media (prefers-reduced-motion: reduce) {
  .mu-map[data-armed] .mu-map__road,
  .mu-map[data-play] .mu-map__road { stroke-dashoffset: 0; animation: none; }
  .mu-map[data-armed] .mu-map__pin, .mu-map[data-play] .mu-map__pin,
  .mu-map[data-armed] .mu-map__card, .mu-map[data-play] .mu-map__card { transform: none; opacity: 1; animation: none; }
  .mu-map__ripple, .mu-map[data-play] .mu-map__ripple { animation: none; opacity: 0; }
}`,
  init: `
root.setAttribute("data-armed", "");
const io = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) {
    root.setAttribute("data-play", "");
    io.disconnect();
  }
}, { threshold: 0.35 });
io.observe(root);
return () => io.disconnect();`,
  loopMs: 5200,
  sampleCopy: true,
  tags: ["map", "pin", "location", "local", "find us", "address", "suburb", "drop", "bounce"],
};
