import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const STAR = "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)";
// Star i starts filling at 6 + 10 i % of a 7 s loop; all clear at 96%.
const keys = [0, 1, 2, 3, 4]
  .map((i) => {
    const a = 6 + i * 10;
    return `@keyframes mu-star${i} { 0%, ${a}% { width: 0; } ${a + 8}%, 92% { width: 100%; } 97%, 100% { width: 0; } }`;
  })
  .join("\n");
const rules = [0, 1, 2, 3, 4]
  .map((i) => `.mu-stars__s:nth-child(${i + 1}) .mu-stars__fill { animation: mu-star${i} 7s var(--mu-ease) infinite; }`)
  .join("\n");
const star = `<span class="mu-stars__s"><span class="mu-stars__fill"><i></i></span></span>`;

export const piece: KitPiece = {
  id: "review-stars-fill",
  name: "Review stars fill",
  tagline: "Five stars fill with gold, one after another",
  category: "Proof",
  move: "Five outlined stars fill left to right with gold, each wiping in from its left edge about 0.7 s after the one before, then the row clears and repeats (7 s). A Sample review tag stays visible.",
  reduced: "All five stars are filled gold and still.",
  useFor:
    "Proof sections once there is a real, sourced rating. As shipped it is a sample: the tag and placeholder lines make that plain. Remove the tag only when the review is real and quoted with permission.",
  html: `
<figure class="mu-stars" data-mu-kit="review-stars-fill">
  <div class="mu-stars__row" role="img" aria-label="Five out of five stars, sample review">
    ${star}${star}${star}${star}${star}
  </div>
  <span class="mu-stars__tag">Sample review</span>
  <figcaption class="mu-stars__lines" aria-hidden="true"><span></span><span></span></figcaption>
</figure>`,
  css: `
${rootRule(
  ".mu-stars",
  `  margin: 0;
  width: min(100%, 320px);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 22px 20px;
  border-radius: 20px;
  background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-stars__row { display: grid; grid-template-columns: repeat(5, minmax(0, 40px)); gap: 6px; justify-content: center; width: 100%; }
.mu-stars__s { position: relative; min-width: 0; aspect-ratio: 1; background: var(--mu-line); clip-path: ${STAR}; }
.mu-stars__fill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; overflow: hidden; }
.mu-stars__fill i { display: block; height: 100%; width: 40px; max-width: none; background: linear-gradient(180deg, var(--mu-gold-hi), var(--mu-gold)); }
.mu-stars__tag { padding: 3px 12px; border-radius: 99px; box-shadow: inset 0 0 0 1px var(--mu-gold); color: var(--mu-gold); font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; }
.mu-stars__lines { width: 80%; display: flex; flex-direction: column; align-items: center; gap: 7px; }
.mu-stars__lines span { height: 6px; border-radius: 99px; background: var(--mu-line); width: 100%; }
.mu-stars__lines span:last-child { width: 62%; }
${rules}
${keys}
@media (max-width: 340px) { .mu-stars__fill i { width: 34px; } }
@media (prefers-reduced-motion: reduce) {
  .mu-stars__fill { animation: none !important; width: 100%; }
}
${PAUSE_CSS}`,
  sampleCopy: true,
  init: WATCH_ONLY,
  tags: ["stars", "review", "rating", "proof", "gold", "sample", "social proof"],
};
