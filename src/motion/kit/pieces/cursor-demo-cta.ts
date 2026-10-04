import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "cursor-demo-cta",
  name: "Cursor demo button",
  tagline: "A cursor glides in and presses Book a demo",
  category: "Conversion",
  move: "A cursor rises from below to the arrow at the right end of the button without crossing its label, presses (the button dips), and a soft ripple spreads behind the text. It fades and replays every 6 s.",
  reduced: "The button sits still with no cursor and no ripple.",
  useFor:
    "A closing call to action on a landing page or film, nudging towards the 15-minute demo. Purely a visual cue: wire the real button to the real booking link.",
  html: `
<div class="mu-cur" data-mu-kit="cursor-demo-cta">
  <span class="mu-cur__btn">
    <span class="mu-cur__ripple"></span>
    <span class="mu-cur__label">Book a 15-minute demo</span>
    <span class="mu-cur__arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
  </span>
  <svg class="mu-cur__ptr" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8-6 2 3.5 6.5-3 1.5L10 14.5 5 19z" /></svg>
</div>`,
  css: `
${rootRule(
  ".mu-cur",
  `  position: relative;
  width: min(100%, 320px);
  height: 140px;
  font-family: var(--mu-sans);`,
)}
.mu-cur__btn {
  position: relative; display: flex; align-items: center; justify-content: space-between; gap: 10px; box-sizing: border-box; width: 100%; height: 56px;
  padding: 0 10px 0 22px; overflow: hidden; border-radius: 99px; background: var(--mu-gold); color: var(--mu-bg); font-weight: 600; font-size: 0.95rem;
  box-shadow: 0 10px 28px rgba(199, 163, 90, 0.25); animation: mu-cur-press 6s var(--mu-ease) infinite;
}
.mu-cur__label { position: relative; z-index: 1; min-width: 0; }
.mu-cur__arrow { position: relative; z-index: 1; flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--mu-bg); }
.mu-cur__arrow svg { width: 18px; height: 18px; fill: none; stroke: var(--mu-gold); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.mu-cur__ripple { position: absolute; z-index: 0; right: 28px; top: 28px; width: 20px; height: 20px; margin: -10px; border-radius: 50%; background: rgba(243, 239, 230, 0.35); opacity: 0; transform: scale(0); animation: mu-cur-ripple 6s ease-out infinite; }
.mu-cur__ptr { position: absolute; z-index: 2; width: 26px; height: 26px; fill: var(--mu-ink); stroke: var(--mu-bg); stroke-width: 1.4; stroke-linejoin: round; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5)); left: calc(100% - 38px); top: 30px; animation: mu-cur-move 6s var(--mu-ease-in-out) infinite; }
@keyframes mu-cur-move {
  0%, 6% { top: 130px; left: calc(100% - 20px); opacity: 0; transform: scale(1); }
  14% { opacity: 1; } 42% { top: 30px; left: calc(100% - 38px); opacity: 1; transform: scale(1); }
  46% { transform: scale(0.85); } 52% { transform: scale(1); } 80% { top: 30px; left: calc(100% - 38px); opacity: 1; } 92%, 100% { top: 30px; left: calc(100% - 38px); opacity: 0; }
}
@keyframes mu-cur-press { 0%, 43% { transform: none; } 46% { transform: scale(0.97); } 52%, 100% { transform: none; } }
@keyframes mu-cur-ripple { 0%, 45% { opacity: 0; transform: scale(0); } 47% { opacity: 1; transform: scale(0.4); } 70%, 100% { opacity: 0; transform: scale(18); } }
@media (prefers-reduced-motion: reduce) {
  .mu-cur__btn, .mu-cur__ripple, .mu-cur__ptr { animation: none; }
  .mu-cur__ptr, .mu-cur__ripple { display: none; }
}
${PAUSE_CSS}`,
  init: WATCH_ONLY,
  tags: ["cta", "cursor", "button", "demo", "click", "ripple", "conversion", "book a demo"],
};
