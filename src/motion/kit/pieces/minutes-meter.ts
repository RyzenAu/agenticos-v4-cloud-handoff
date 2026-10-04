import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "minutes-meter",
  name: "Included-minutes meter",
  tagline: "A gauge fills and the seconds tick by",
  category: "Data",
  move: "When it scrolls into view the gold arc sweeps to the used share over 1.4 s while the counter climbs in step, then the counter ticks one second at a time and the arc creeps with it.",
  reduced: "The gauge shows its used share and the figure, still: no sweep and no ticking.",
  useFor:
    "A pricing or dashboard section showing usage against an allowance, billed by the second. All figures are sample: replace them with the plan's real allowance and a real usage figure.",
  html: `
<figure class="mu-meter" data-mu-kit="minutes-meter" data-used="12240" data-allow="18000" style="--p: 0.68">
  <div class="mu-meter__gauge">
    <svg viewBox="0 0 120 68" aria-hidden="true">
      <path class="mu-meter__track" d="M 10 60 A 50 50 0 0 1 110 60" pathLength="100" />
      <path class="mu-meter__arc" d="M 10 60 A 50 50 0 0 1 110 60" pathLength="100" />
    </svg>
    <div class="mu-meter__read">
      <span class="mu-meter__used">204:00</span>
      <span class="mu-meter__unit">minutes used</span>
    </div>
  </div>
  <figcaption class="mu-meter__foot">
    <span>of 300 included</span>
    <span class="mu-meter__left">95:59 left</span>
    <span class="mu-meter__chip">Billed by the second</span>
  </figcaption>
  <p class="mu-meter__note">Sample figures</p>
</figure>`,
  css: `
${rootRule(
  ".mu-meter",
  `  margin: 0;
  width: min(100%, 360px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 24px 22px 18px;
  border-radius: 20px;
  background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-meter__gauge { position: relative; width: 100%; aspect-ratio: 120 / 68; }
.mu-meter__gauge svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.mu-meter__track, .mu-meter__arc { fill: none; stroke-width: 9; stroke-linecap: round; }
.mu-meter__track { stroke: var(--mu-line); }
.mu-meter__arc { stroke: var(--mu-gold); stroke-dasharray: calc(var(--p) * 100) 100; }
.mu-meter__read { position: absolute; left: 0; right: 0; bottom: 4%; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.mu-meter__used { font-family: var(--mu-display); font-size: clamp(2rem, 8vw, 2.7rem); font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; }
.mu-meter__unit { font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mu-muted); }
.mu-meter__foot { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 6px 12px; font-size: 0.85rem; color: var(--mu-muted); }
.mu-meter__left { font-variant-numeric: tabular-nums; color: var(--mu-ink); }
.mu-meter__chip { padding: 3px 10px; border-radius: 99px; box-shadow: inset 0 0 0 1px var(--mu-gold); color: var(--mu-gold); font-size: 0.75rem; }
.mu-meter__note { margin: 0; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--mu-muted); opacity: 0.7; }
@media (prefers-reduced-motion: reduce) {
  .mu-meter__arc { transition: none; }
}
${PAUSE_CSS}`,
  init: IN_VIEW + `
const used0 = Number(root.getAttribute("data-used") || "0");
const allow = Number(root.getAttribute("data-allow") || "1") || 1;
const usedEl = root.querySelector(".mu-meter__used");
const leftEl = root.querySelector(".mu-meter__left");
if (!usedEl || !leftEl) return;
const pad = (n) => (n < 10 ? "0" : "") + n;
const fmt = (s) => Math.floor(s / 60) + ":" + pad(Math.floor(s % 60));
const paint = (s) => {
  usedEl.textContent = fmt(s);
  leftEl.textContent = fmt(Math.max(0, allow - s)) + " left";
  root.style.setProperty("--p", String(Math.min(1, s / allow)));
};
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  paint(used0);
  return;
}
paint(0);
let raf = 0;
let timer = 0;
let phase = 0;
let s = used0;
const stop = () => {
  cancelAnimationFrame(raf);
  clearInterval(timer);
  timer = 0;
};
const tick = () => {
  if (s >= allow) {
    phase = 3;
    paint(allow);
    return;
  }
  phase = 2;
  if (timer) return;
  timer = setInterval(() => {
    s += 1;
    if (s >= allow) {
      s = allow;
      clearInterval(timer);
      timer = 0;
      phase = 3;
    }
    paint(s);
  }, 1000);
};
const sweep = () => {
  phase = 1;
  const t0 = performance.now();
  raf = requestAnimationFrame(function f(now) {
    const k = Math.min(1, (now - t0) / 1400);
    paint(Math.min(allow, used0) * (1 - Math.pow(1 - k, 4)));
    if (k < 1) {
      raf = requestAnimationFrame(f);
      return;
    }
    s = used0;
    tick();
  });
};
const watch = muInView(root, (on) => {
  if (!on) stop();
  else if (phase === 1) sweep();
  else if (phase === 2) tick();
});
const io = new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  io.disconnect();
  if (watch.running()) sweep();
  else phase = 1;
}, { threshold: 0.4 });
io.observe(root);
return () => {
  io.disconnect();
  watch.stop();
  stop();
};`,
  loopMs: 9000,
  sampleCopy: true,
  tags: ["minutes", "usage", "meter", "gauge", "allowance", "counter", "billing", "data", "receptionist"],
};
