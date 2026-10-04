import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

// Bands on a 24-hour dial (hours, 0 = midnight at the top). Sample hours: edit to the client's own.
const BANDS: { from: number; len: number; cls: string }[] = [
  { from: 18, len: 6, cls: "after" },
  { from: 0, len: 8, cls: "after" },
  { from: 8, len: 1, cls: "over" },
  { from: 17, len: 1, cls: "over" },
  { from: 9, len: 8, cls: "biz" },
];
const arc = (b: { from: number; len: number; cls: string }) => {
  const len = ((b.len / 24) * 100).toFixed(3);
  const off = ((b.from / 24) * 100).toFixed(3);
  return `<circle class="mu-clock__band mu-clock__band--${b.cls}" cx="100" cy="100" r="78" pathLength="100" stroke-dasharray="${len} ${(100 - Number(len)).toFixed(3)}" stroke-dashoffset="-${off}" />`;
};
const ticks = [0, 6, 12, 18]
  .map((h) => {
    const a = (h / 24) * 2 * Math.PI;
    const x = 100 + Math.sin(a) * 100;
    const y = 100 - Math.cos(a) * 100;
    return `<text class="mu-clock__tick" x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="middle">${String(h).padStart(2, "0")}</text>`;
  })
  .join("");

export const piece: KitPiece = {
  id: "always-on-clock",
  name: "24-hour coverage dial",
  tagline: "A sweep through business, overflow and after hours",
  category: "Data",
  move: "A gold hand sweeps the 24-hour dial (16 s a lap) while the centre reads the time and which band it is in: business hours, overflow, or after hours. The front desk is shown as on in every band.",
  reduced:
    "No sweep: the dial is still, with every band visible and the centre reading Front desk on, around the clock.",
  useFor:
    "The 'we never close' section of a receptionist page, or a coverage explainer in a film. The band hours are sample copy: set them to the client's real trading hours.",
  html: `
<figure class="mu-clock" data-mu-kit="always-on-clock" data-period="16000" data-start-hour="7">
  <div class="mu-clock__dial">
    <svg viewBox="-12 -12 224 224" aria-hidden="true">
      <circle cx="100" cy="100" r="78" class="mu-clock__rail" />
      <g transform="rotate(-90 100 100)">${BANDS.map(arc).join("")}</g>
      ${ticks}
      <g class="mu-clock__hand"><line x1="100" y1="36" x2="100" y2="14" /><circle cx="100" cy="14" r="5" /></g>
    </svg>
    <div class="mu-clock__centre">
      <span class="mu-clock__time">24/7</span>
      <span class="mu-clock__state">Front desk on, around the clock</span>
    </div>
  </div>
  <figcaption class="mu-clock__legend">
    <em class="mu-clock__sample">Illustration · sample hours</em>
    <span><i class="mu-clock__sw mu-clock__sw--biz"></i>Business hours</span>
    <span><i class="mu-clock__sw mu-clock__sw--over"></i>Overflow</span>
    <span><i class="mu-clock__sw mu-clock__sw--after"></i>After hours</span>
  </figcaption>
</figure>`,
  css: `
${rootRule(
  ".mu-clock",
  `  margin: 0;
  width: min(100%, 340px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-clock__dial { position: relative; width: 100%; aspect-ratio: 1; }
.mu-clock__dial svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.mu-clock__rail, .mu-clock__band { fill: none; stroke-width: 14; }
.mu-clock__rail { stroke: var(--mu-surface); }
.mu-clock__band--biz { stroke: var(--mu-gold); }
.mu-clock__band--over { stroke: var(--mu-gold-hi); opacity: 0.6; }
.mu-clock__band--after { stroke: var(--mu-muted); opacity: 0.35; }
.mu-clock__tick { fill: var(--mu-muted); font-size: 9px; font-variant-numeric: tabular-nums; }
.mu-clock__hand { transform-origin: 100px 100px; }
.mu-clock__hand line { stroke: var(--mu-ink); stroke-width: 1.5; }
.mu-clock__hand circle { fill: var(--mu-bg); stroke: var(--mu-ink); stroke-width: 2; }
.mu-clock__centre { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; }
.mu-clock__time { font-family: var(--mu-display); font-size: clamp(2rem, 9vw, 2.8rem); font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; }
.mu-clock__state { max-width: 11ch; font-size: 0.8rem; line-height: 1.3; color: var(--mu-gold); }
.mu-clock__legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 16px; font-size: 0.78rem; color: var(--mu-muted); }
.mu-clock__legend span { display: inline-flex; align-items: center; gap: 6px; }
.mu-clock__sample { flex-basis: 100%; text-align: center; font-style: normal; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; }
.mu-clock__sw { width: 10px; height: 10px; border-radius: 3px; }
.mu-clock__sw--biz { background: var(--mu-gold); }
.mu-clock__sw--over { background: var(--mu-gold-hi); opacity: 0.6; }
.mu-clock__sw--after { background: var(--mu-muted); opacity: 0.35; }
@media (prefers-reduced-motion: reduce) {
  .mu-clock__hand { display: none; }
}
${PAUSE_CSS}`,
  init: IN_VIEW + `
const hand = root.querySelector(".mu-clock__hand");
const time = root.querySelector(".mu-clock__time");
const state = root.querySelector(".mu-clock__state");
if (!hand || !time || !state) return;
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
const PERIOD = Number(root.getAttribute("data-period") || "16000") || 16000;
const START_H = Number(root.getAttribute("data-start-hour") || "7");
const pad = (n) => (n < 10 ? "0" : "") + n;
const band = (h) => (h >= 9 && h < 17 ? "Business hours" : (h >= 8 && h < 9) || (h >= 17 && h < 18) ? "Overflow" : "After hours");
let last = "";
let raf = 0;
let start = performance.now();
let pausedAt = 0;
const tick = (now) => {
  const h = (((now - start) / PERIOD) * 24 + START_H) % 24;
  hand.style.transform = "rotate(" + (h / 24) * 360 + "deg)";
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 12) * 5;
  time.textContent = pad(hh) + ":" + pad(mm);
  const b = band(h);
  if (b !== last) {
    last = b;
    state.textContent = b + " · front desk on";
  }
  raf = requestAnimationFrame(tick);
};
const watch = muInView(root, (on) => {
  if (!on) {
    cancelAnimationFrame(raf);
    if (!pausedAt) pausedAt = performance.now();
  } else if (pausedAt) {
    start += performance.now() - pausedAt;
    pausedAt = 0;
    raf = requestAnimationFrame(tick);
  }
});
if (watch.running()) raf = requestAnimationFrame(tick);
else pausedAt = performance.now();
return () => {
  cancelAnimationFrame(raf);
  watch.stop();
};`,
  sampleCopy: true,
  tags: ["clock", "24/7", "hours", "after hours", "coverage", "dial", "receptionist", "data"],
};
