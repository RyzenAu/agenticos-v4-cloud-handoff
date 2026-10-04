import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "testimonial-flip",
  name: "Testimonial card flip",
  tagline: "A review turns over to show who said it",
  category: "Proof",
  move: "Tap, click, or Enter/Space turns the card over in 0.7 s on a soft 3D axis: the quote on the front, the person and source on the back. A small nudge 1.5 s after it appears shows it can turn.",
  reduced: "The faces cross-fade instead of turning, and there is no nudge.",
  useFor:
    "Review sections. Use real reviews only, with the source and suburb; never invent a quote.",
  html: `
<!-- Use a real review, quoted exactly, with its source. -->
<div class="mu-flip" data-mu-kit="testimonial-flip">
  <button class="mu-flip__card" type="button" aria-pressed="false">
    <span class="mu-flip__face mu-flip__front">
      <span class="mu-flip__stars" aria-label="5 out of 5 stars">★★★★★</span>
      <span class="mu-flip__quote">“They found me a same-day appointment and explained every step before they started.”</span>
      <span class="mu-flip__hint">Turn over to see who said it</span>
    </span>
    <span class="mu-flip__face mu-flip__back">
      <span class="mu-flip__avatar" aria-hidden="true">JM</span>
      <span class="mu-flip__who">Jordan M.</span>
      <span class="mu-flip__meta">Google review · Parramatta</span>
      <span class="mu-flip__hint">Turn back to the review</span>
    </span>
  </button>
</div>`,
  css: `
${rootRule(
  ".mu-flip",
  `  width: min(100%, 380px);
  perspective: 1200px;
  font-family: var(--mu-sans);
  color: var(--mu-ink);`,
)}
.mu-flip__card {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 230px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transform-style: preserve-3d;
  transition: transform 0.7s var(--mu-ease);
  border-radius: 20px;
}
.mu-flip__card:focus-visible { outline: 2px solid var(--mu-gold); outline-offset: 4px; }
.mu-flip__card[aria-pressed="true"] { transform: rotateY(180deg); }
.mu-flip[data-nudge] .mu-flip__card { animation: mu-flip-nudge 0.9s var(--mu-ease-in-out); }
.mu-flip__face {
  grid-area: 1 / 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 26px 26px 22px;
  border-radius: 20px;
  background: linear-gradient(160deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line), 0 24px 48px -28px rgba(0, 0, 0, 0.9);
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  transition: opacity 0.35s ease;
}
.mu-flip__back { transform: rotateY(180deg); align-items: flex-start; justify-content: center; }
.mu-flip__stars { color: var(--mu-gold); letter-spacing: 0.18em; font-size: 0.95rem; }
.mu-flip__quote { font-family: var(--mu-display); font-size: 1.3rem; line-height: 1.35; }
.mu-flip__hint { margin-top: auto; font-size: 0.8rem; color: var(--mu-muted); }
.mu-flip__avatar {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--mu-gold);
  color: var(--mu-bg);
  font-weight: 700;
  letter-spacing: 0.04em;
}
.mu-flip__who { font-family: var(--mu-display); font-size: 1.45rem; }
.mu-flip__meta { color: var(--mu-gold); font-size: 0.9rem; }
@keyframes mu-flip-nudge {
  0%, 100% { transform: rotateY(0); }
  40% { transform: rotateY(-14deg); }
  70% { transform: rotateY(5deg); }
}
@media (prefers-reduced-motion: reduce) {
  .mu-flip__card, .mu-flip__card[aria-pressed="true"] { transform: none; transition: none; }
  .mu-flip[data-nudge] .mu-flip__card { animation: none; }
  .mu-flip__back { transform: none; opacity: 0; }
  .mu-flip__card[aria-pressed="true"] .mu-flip__front { opacity: 0; }
  .mu-flip__card[aria-pressed="true"] .mu-flip__back { opacity: 1; }
}`,
  init: `
const card = root.querySelector(".mu-flip__card");
if (!card) return;
const flip = () => card.setAttribute("aria-pressed", card.getAttribute("aria-pressed") === "true" ? "false" : "true");
card.addEventListener("click", flip);
let timer = 0;
const io = new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  io.disconnect();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  timer = window.setTimeout(() => root.setAttribute("data-nudge", ""), 1500);
}, { threshold: 0.6 });
io.observe(root);
return () => {
  card.removeEventListener("click", flip);
  io.disconnect();
  clearTimeout(timer);
};`,
  sampleCopy: true,
  tags: ["testimonial", "review", "quote", "flip", "card", "3d", "proof", "social proof"],
};
