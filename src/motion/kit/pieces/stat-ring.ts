import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "stat-ring",
  name: "Stat counter ring",
  tagline: "A gold arc fills as the number counts up",
  category: "Data",
  move: "When it scrolls into view the arc sweeps to its value over 1.4 s (ease out) while the number counts up in step, in tabular figures so nothing jitters.",
  reduced: "The ring and number show their final value straight away.",
  useFor:
    "Proof sections: on-time starts, years in practice, review average. Set data-value and data-max; every figure must be sourced.",
  html: `
<!-- Replace the figure and label with a sourced one (mu-business-evidence). -->
<figure class="mu-ring" data-mu-kit="stat-ring" data-value="94" data-max="100" style="--p: 0.94">
  <span class="mu-ring__dial">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="mu-ring__track" cx="60" cy="60" r="52" />
      <circle class="mu-ring__arc" cx="60" cy="60" r="52" pathLength="100" />
    </svg>
    <span class="mu-ring__value"><span class="mu-ring__num">94</span><span class="mu-ring__unit">%</span></span>
  </span>
  <figcaption class="mu-ring__label">of appointments start on time</figcaption>
</figure>`,
  css: `
${rootRule(
  ".mu-ring",
  `  margin: 0;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-ring__dial {
  position: relative;
  display: grid;
  place-items: center;
  width: clamp(132px, 30vw, 184px);
  aspect-ratio: 1;
}
.mu-ring__dial svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.mu-ring__track { fill: none; stroke: var(--mu-line); stroke-width: 7; }
.mu-ring__arc {
  fill: none;
  stroke: var(--mu-gold);
  stroke-width: 7;
  stroke-linecap: round;
  stroke-dasharray: 100;
  stroke-dashoffset: calc(100 - var(--p) * 100);
}
.mu-ring[data-armed] .mu-ring__arc { stroke-dashoffset: 100; }
.mu-ring[data-play] .mu-ring__arc {
  stroke-dashoffset: calc(100 - var(--p) * 100);
  transition: stroke-dashoffset 1.4s var(--mu-ease);
}
.mu-ring__value {
  display: flex;
  align-items: baseline;
  font-family: var(--mu-display);
  font-size: clamp(2.2rem, 6vw, 3rem);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.mu-ring__unit { font-size: 0.5em; margin-left: 2px; color: var(--mu-gold); }
.mu-ring__label {
  max-width: 18ch;
  text-align: center;
  font-size: 0.95rem;
  line-height: 1.35;
  color: var(--mu-muted);
}
@media (prefers-reduced-motion: reduce) {
  .mu-ring[data-armed] .mu-ring__arc,
  .mu-ring[data-play] .mu-ring__arc { stroke-dashoffset: calc(100 - var(--p) * 100); transition: none; }
}`,
  init: `
const value = Number(root.getAttribute("data-value") || "0");
const max = Number(root.getAttribute("data-max") || "100") || 100;
const num = root.querySelector(".mu-ring__num");
root.style.setProperty("--p", String(Math.min(1, Math.max(0, value / max))));
const decimals = (String(value).split(".")[1] || "").length;
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  if (num) num.textContent = value.toFixed(decimals);
  return;
}
root.setAttribute("data-armed", "");
if (num) num.textContent = (0).toFixed(decimals);
let raf = 0;
const io = new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  io.disconnect();
  root.setAttribute("data-play", "");
  const start = performance.now();
  raf = requestAnimationFrame(function tick(now) {
    const k = Math.min(1, (now - start) / 1400);
    const eased = 1 - Math.pow(1 - k, 4);
    if (num) num.textContent = (value * eased).toFixed(decimals);
    if (k < 1) raf = requestAnimationFrame(tick);
  });
}, { threshold: 0.4 });
io.observe(root);
return () => {
  io.disconnect();
  cancelAnimationFrame(raf);
};`,
  loopMs: 3800,
  sampleCopy: true,
  tags: ["stat", "counter", "ring", "number", "count up", "proof", "data", "progress"],
};
