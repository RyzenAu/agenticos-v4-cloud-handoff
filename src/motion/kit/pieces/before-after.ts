import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "before-after",
  name: "Before/after wipe",
  tagline: "Drag the gold handle between old and new",
  category: "Showcase",
  move: "On first view the divider glides from 85% to the middle (1.4 s) to show there is something to compare; after that it follows your drag, or the arrow keys (it's a range input underneath).",
  reduced: "No intro glide: it starts in the middle and still drags.",
  useFor:
    "Redesign pitches (their site today against our preview) and smile or renovation galleries. Put <img> tags inside the two panels.",
  html: `
<div class="mu-wipe" data-mu-kit="before-after" style="--split: 50%">
  <div class="mu-wipe__panel mu-wipe__after">
    <span class="mu-wipe__a-nav"><span></span><span></span></span>
    <span class="mu-wipe__a-hero"><span class="mu-wipe__a-kicker"></span><span class="mu-wipe__a-h1"></span><span class="mu-wipe__a-h1 mu-wipe__a-h1--short"></span><span class="mu-wipe__a-btn"></span></span>
  </div>
  <div class="mu-wipe__panel mu-wipe__before" aria-hidden="true">
    <span class="mu-wipe__b-nav"></span><span class="mu-wipe__b-h1"></span><span class="mu-wipe__b-row"><span></span><span></span></span><span class="mu-wipe__b-text"></span><span class="mu-wipe__b-text"></span>
  </div>
  <span class="mu-wipe__tag mu-wipe__tag--before">Before</span>
  <span class="mu-wipe__tag mu-wipe__tag--after">After</span>
  <span class="mu-wipe__handle" aria-hidden="true"><span></span></span>
  <input class="mu-wipe__range" type="range" min="0" max="100" value="50" aria-label="Compare before and after: move left for more of the new site">
</div>`,
  css: `
${rootRule(
  ".mu-wipe",
  `  position: relative;
  width: min(100%, 560px);
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-radius: 20px;
  box-shadow: 0 0 0 1px var(--mu-line);
  font-family: var(--mu-sans);
  user-select: none;`,
)}
.mu-wipe__panel { position: absolute; inset: 0; display: flex; flex-direction: column; }
.mu-wipe__panel img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
.mu-wipe__after { background: radial-gradient(70% 90% at 25% 60%, #4a3c24, #17140f 55%, var(--mu-bg) 80%); }
.mu-wipe__a-nav { display: flex; justify-content: space-between; align-items: center; padding: 5% 7% 0; }
.mu-wipe__a-nav span:first-child { width: 22px; height: 22px; border-radius: 50%; box-shadow: inset 0 0 0 2px var(--mu-gold); }
.mu-wipe__a-nav span:last-child { width: 18%; height: 22px; border-radius: 99px; background: var(--mu-gold); opacity: 0.9; }
.mu-wipe__a-hero { display: flex; flex-direction: column; gap: 12px; margin: auto 8% auto 56%; }
.mu-wipe__a-kicker { width: 30%; height: 6px; border-radius: 99px; background: var(--mu-gold); }
.mu-wipe__a-h1 { width: 100%; height: 26px; border-radius: 8px; background: var(--mu-ink); }
.mu-wipe__a-h1--short { width: 68%; }
.mu-wipe__a-btn { width: 46%; height: 26px; margin-top: 8px; border-radius: 99px; background: var(--mu-gold); }
.mu-wipe__before {
  gap: 10px;
  padding: 0 0 6%;
  background: #d9d6cf;
  clip-path: inset(0 calc(100% - var(--split)) 0 0);
}
.mu-wipe__b-nav { height: 13%; background: #3d5a8a; }
.mu-wipe__b-h1 { width: 60%; height: 18px; margin: 4% 7% 0; background: #7a2f2f; }
.mu-wipe__b-row { display: flex; gap: 10px; margin: 0 7%; }
.mu-wipe__b-row span { flex: 1; height: 70px; background: #a9a59c; border: 3px double #6b6760; }
.mu-wipe__b-text { width: 80%; height: 8px; margin: 0 7%; background: #8f8b83; }
.mu-wipe__tag {
  position: absolute;
  bottom: 12px;
  padding: 5px 10px;
  border-radius: 99px;
  background: rgba(8, 8, 8, 0.72);
  color: var(--mu-ink);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  pointer-events: none;
}
.mu-wipe__tag--before { left: 12px; }
.mu-wipe__tag--after { right: 12px; color: var(--mu-gold); }
.mu-wipe__handle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--split);
  width: 2px;
  margin-left: -1px;
  background: var(--mu-gold);
  pointer-events: none;
}
.mu-wipe__handle span {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 38px;
  height: 38px;
  margin: -19px 0 0 -19px;
  border-radius: 50%;
  background: var(--mu-bg);
  box-shadow: 0 0 0 2px var(--mu-gold), 0 8px 20px rgba(0, 0, 0, 0.6);
  transition: transform 0.3s var(--mu-ease);
}
.mu-wipe__handle span::before, .mu-wipe__handle span::after {
  content: "";
  position: absolute;
  top: 50%;
  width: 7px;
  height: 7px;
  margin-top: -4px;
  border: solid var(--mu-gold);
  border-width: 0 0 2px 2px;
}
.mu-wipe__handle span::before { left: 9px; transform: rotate(45deg); }
.mu-wipe__handle span::after { right: 9px; transform: rotate(-135deg); }
.mu-wipe:hover .mu-wipe__handle span { transform: scale(1.08); }
.mu-wipe__range {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: ew-resize;
}
.mu-wipe:focus-within .mu-wipe__handle span { box-shadow: 0 0 0 2px var(--mu-gold), 0 0 0 6px rgba(199, 163, 90, 0.35); }
@media (prefers-reduced-motion: reduce) {
  .mu-wipe__handle span { transition: none; }
  .mu-wipe:hover .mu-wipe__handle span { transform: none; }
}`,
  init: `
const range = root.querySelector(".mu-wipe__range");
if (!range) return;
const set = (v = 50) => root.style.setProperty("--split", v + "%");
const onInput = () => set(Number(range.value));
range.addEventListener("input", onInput);
let raf = 0;
const io = new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  io.disconnect();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const start = performance.now();
  raf = requestAnimationFrame(function glide(now) {
    const k = Math.min(1, (now - start) / 1400);
    const eased = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const v = 85 - 35 * eased;
    set(v);
    range.value = String(Math.round(v));
    if (k < 1) raf = requestAnimationFrame(glide);
  });
}, { threshold: 0.5 });
io.observe(root);
return () => {
  range.removeEventListener("input", onInput);
  io.disconnect();
  cancelAnimationFrame(raf);
};`,
  loopMs: 5200,
  tags: ["before", "after", "compare", "wipe", "slider", "redesign", "gallery", "drag"],
};
