import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const digit = (d: string) => `<span class="mu-flap__d"><b>${d}</b></span>`;

export const piece: KitPiece = {
  id: "missed-call-counter",
  name: "Split-flap call tally",
  tagline: "An after-hours tally flips like a departures board",
  category: "Data",
  move: "When it scrolls into view the three-digit tally sits at its starting figure, then every 1.4 s the last digit flips over like a split-flap board, carrying into the next digit when it rolls.",
  reduced: "The tally shows its final figure, still. No flipping.",
  useFor:
    "Proof or results sections: calls handled outside opening hours. All figures are sample copy: replace the value with a real, sourced count from the client's own call log.",
  html: `
<figure class="mu-flap" data-mu-kit="missed-call-counter" data-value="128" data-start="122">
  <figcaption class="mu-flap__title">Calls answered after hours</figcaption>
  <div class="mu-flap__board" role="img" aria-label="128 calls answered after hours, sample figure">
    ${digit("1")}${digit("2")}${digit("8")}
  </div>
  <p class="mu-flap__note">This month · sample figures</p>
</figure>`,
  css: `
${rootRule(
  ".mu-flap",
  `  margin: 0;
  width: min(100%, 360px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 22px 18px 16px;
  box-sizing: border-box;
  border-radius: 20px;
  background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-flap__title { text-align: center; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--mu-muted); }
.mu-flap__board { display: grid; grid-template-columns: repeat(3, minmax(0, 76px)); gap: 8px; justify-content: center; width: 100%; perspective: 500px; }
.mu-flap__d {
  position: relative; min-width: 0; aspect-ratio: 3 / 4; display: grid; place-items: center; overflow: hidden;
  border-radius: 10px; background: linear-gradient(180deg, var(--mu-raised) 50%, var(--mu-bg) 50%);
  box-shadow: 0 0 0 1px var(--mu-line);
}
.mu-flap__d::after { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; background: var(--mu-bg); }
.mu-flap__d b { font-family: var(--mu-display); font-size: clamp(2.4rem, 11vw, 3.4rem); font-weight: 500; line-height: 1; color: var(--mu-gold-hi); font-variant-numeric: tabular-nums; transform-origin: 50% 50%; }
.mu-flap__d b[data-flip="a"] { animation: mu-flap-a 0.5s var(--mu-ease); }
.mu-flap__d b[data-flip="b"] { animation: mu-flap-b 0.5s var(--mu-ease); }
@keyframes mu-flap-a { from { transform: rotateX(-90deg); opacity: 0.2; } to { transform: rotateX(0); opacity: 1; } }
@keyframes mu-flap-b { from { transform: rotateX(-90deg); opacity: 0.2; } to { transform: rotateX(0); opacity: 1; } }
.mu-flap__note { margin: 0; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--mu-muted); opacity: 0.7; }
@media (prefers-reduced-motion: reduce) {
  .mu-flap__d b[data-flip] { animation: none; }
}
${PAUSE_CSS}`,
  init: IN_VIEW + `
const value = Number(root.getAttribute("data-value") || "0");
const start = Number(root.getAttribute("data-start") || String(value));
const digits = Array.from(root.querySelectorAll(".mu-flap__d b"));
if (!digits.length) return;
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
const show = (n, flip) => {
  const s = String(n);
  const padded = new Array(Math.max(0, digits.length - s.length) + 1).join("0") + s;
  digits.forEach((b, i) => {
    if (b.textContent === padded[i]) return;
    b.textContent = padded[i];
    if (flip) b.setAttribute("data-flip", b.getAttribute("data-flip") === "a" ? "b" : "a");
  });
};
show(start, false);
let n = start;
let timer = 0;
let started = false;
const stop = () => {
  clearInterval(timer);
  timer = 0;
};
const go = () => {
  if (timer || n >= value) return;
  timer = setInterval(() => {
    if (n >= value) {
      stop();
      return;
    }
    n += 1;
    show(n, true);
  }, 1400);
};
const watch = muInView(root, (on) => {
  if (!on) stop();
  else if (started) go();
});
const io = new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  io.disconnect();
  started = true;
  if (watch.running()) go();
}, { threshold: 0.4 });
io.observe(root);
return () => {
  io.disconnect();
  watch.stop();
  stop();
};`,
  loopMs: 11000,
  sampleCopy: true,
  tags: ["counter", "split-flap", "tally", "after hours", "calls", "flip", "data", "proof"],
};
