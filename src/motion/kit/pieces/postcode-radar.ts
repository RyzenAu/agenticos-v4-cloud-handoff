import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

// A made-up suburb grid: rounded blocks and two "roads". No real map data, no real places.
const BLOCKS: [number, number, number, number][] = [
  [28, 30, 22, 14], [58, 26, 26, 16], [90, 34, 24, 12], [136, 28, 20, 18], [166, 40, 18, 14],
  [24, 56, 18, 20], [52, 62, 30, 14], [96, 58, 18, 22], [126, 64, 26, 14], [160, 70, 20, 18],
  [30, 100, 24, 16], [62, 92, 20, 22], [98, 104, 28, 14], [140, 96, 22, 20], [170, 108, 16, 14],
  [26, 132, 20, 18], [56, 140, 28, 14], [94, 134, 18, 20], [128, 144, 24, 14], [160, 138, 22, 18],
  [40, 168, 26, 12], [80, 166, 22, 16], [116, 172, 28, 12], [154, 166, 20, 14],
];
// Pings: [x, y] on a 200 x 200 plane. Delay is derived from the angle so each lights as the sweep passes.
const PINGS: [number, number][] = [[62, 48], [140, 70], [150, 142], [96, 150], [48, 110], [112, 98]];
const PERIOD = 6;
const pingHtml = PINGS.map(([x, y]) => {
  const ang = ((Math.atan2(x - 100, 100 - y) * 180) / Math.PI + 360) % 360;
  const delay = (ang / 360) * PERIOD - PERIOD;
  return `<span class="mu-radar__ping" style="left:${x / 2}%;top:${y / 2}%;--d:${delay.toFixed(2)}s"><i></i><b></b></span>`;
}).join("");

export const piece: KitPiece = {
  id: "postcode-radar",
  name: "Service-area radar",
  tagline: "A radar sweep pings across a suburb grid",
  category: "Local",
  move: "A gold sweep turns once every 6 s over a stylised suburb grid, and each ping flashes and sends out a ring as the sweep passes it.",
  reduced: "The radar is still: the grid, a fixed sweep wedge and every ping dot lit, with no rings.",
  useFor:
    "Local-business pages: 'the area we cover' or 'enquiries from across your patch'. The grid is a generic drawing, not a real map: do not label it with real streets or addresses.",
  html: `
<figure class="mu-radar" data-mu-kit="postcode-radar">
  <div class="mu-radar__dial" role="img" aria-label="A radar sweep over a stylised suburb grid with enquiry pings">
    <svg viewBox="0 0 200 200" aria-hidden="true">
      <path class="mu-radar__road" d="M0 84H200M0 124H200M76 0V200M120 0V200" />
      ${BLOCKS.map(([x, y, w, h]) => `<rect class="mu-radar__blk" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" />`).join("")}
      <circle class="mu-radar__rg" cx="100" cy="100" r="33" /><circle class="mu-radar__rg" cx="100" cy="100" r="66" />
    </svg>
    <span class="mu-radar__sweep"></span>
    ${pingHtml}
  </div>
  <figcaption class="mu-radar__cap">Enquiries across the area · illustration</figcaption>
</figure>`,
  css: `
${rootRule(
  ".mu-radar",
  `  margin: 0;
  width: min(100%, 320px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-radar__dial { position: relative; width: 100%; aspect-ratio: 1; border-radius: 50%; overflow: hidden; background: radial-gradient(circle, var(--mu-raised), var(--mu-bg) 78%); box-shadow: 0 0 0 1px var(--mu-line), 0 0 0 5px var(--mu-surface), 0 0 0 6px var(--mu-line); }
.mu-radar__dial svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.mu-radar__road { fill: none; stroke: var(--mu-line); stroke-width: 5; }
.mu-radar__blk { fill: var(--mu-surface); stroke: var(--mu-line); stroke-width: 0.6; }
.mu-radar__rg { fill: none; stroke: var(--mu-line); stroke-width: 0.8; stroke-dasharray: 2 3; }
.mu-radar__sweep {
  position: absolute; inset: 0; border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0deg, transparent 292deg, rgba(199, 163, 90, 0.08) 310deg, rgba(228, 200, 135, 0.5) 359deg, var(--mu-gold-hi) 360deg);
  animation: mu-radar-turn ${PERIOD}s linear infinite;
}
.mu-radar__ping { position: absolute; width: 0; height: 0; }
.mu-radar__ping i { position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; border-radius: 50%; background: var(--mu-gold-hi); animation: mu-radar-dot ${PERIOD}s linear var(--d) infinite; }
.mu-radar__ping b { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%; box-shadow: 0 0 0 1.5px var(--mu-gold); opacity: 0; animation: mu-radar-ring ${PERIOD}s ease-out var(--d) infinite; }
.mu-radar__cap { font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--mu-muted); text-align: center; }
@keyframes mu-radar-turn { to { transform: rotate(360deg); } }
@keyframes mu-radar-dot { 0% { opacity: 1; transform: scale(1.5); } 30% { opacity: 0.55; transform: none; } 100% { opacity: 0.3; transform: none; } }
@keyframes mu-radar-ring { 0% { opacity: 0.9; transform: scale(0.3); } 35%, 100% { opacity: 0; transform: scale(1.6); } }
@media (prefers-reduced-motion: reduce) {
  .mu-radar__sweep { animation: none; transform: rotate(40deg); opacity: 0.7; }
  .mu-radar__ping i { animation: none; opacity: 0.9; }
  .mu-radar__ping b { animation: none; opacity: 0; }
}
${PAUSE_CSS}`,
  init: WATCH_ONLY,
  tags: ["radar", "map", "local", "suburb", "service area", "ping", "sweep", "western sydney"],
};
