import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "cta-pulse",
  name: "CTA pulse",
  tagline: "A gold button that breathes, and an arrow that leans in",
  category: "Conversion",
  move: "Every 3.2 s a soft gold halo breathes out from the button and fades; on hover or focus the button lifts 2 px and the arrow leans forward. The pulse stops while it's hovered, so it never fights the pointer.",
  reduced: "No halo and no lean: a still button with a clear focus ring.",
  useFor:
    "The one primary action on a page (Book, Call, Get a quote). Use it once per screen; two pulsing buttons cancel each other out.",
  html: `
<a class="mu-cta" data-mu-kit="cta-pulse" href="#book">
  <span class="mu-cta__label">Book a visit</span>
  <svg class="mu-cta__arrow" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
</a>`,
  css: `
${rootRule(
  ".mu-cta",
  `  position: relative;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 0 26px 0 30px;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--mu-gold-hi), var(--mu-gold));
  color: var(--mu-bg);
  font-family: var(--mu-sans);
  font-size: 1.02rem;
  font-weight: 650;
  letter-spacing: 0.01em;
  text-decoration: none;
  box-shadow: 0 10px 28px -12px rgba(199, 163, 90, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.35);
  transition: transform 0.35s var(--mu-ease), box-shadow 0.35s var(--mu-ease);`,
)}
.mu-cta::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  box-shadow: 0 0 0 0 rgba(199, 163, 90, 0.55);
  animation: mu-cta-breathe 3.2s var(--mu-ease) infinite;
}
.mu-cta__arrow {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.35s var(--mu-ease);
}
.mu-cta:hover, .mu-cta:focus-visible {
  transform: translateY(-2px);
  box-shadow: 0 16px 34px -12px rgba(199, 163, 90, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.35);
}
.mu-cta:hover::before, .mu-cta:focus-visible::before { animation-play-state: paused; opacity: 0; }
.mu-cta:hover .mu-cta__arrow, .mu-cta:focus-visible .mu-cta__arrow { transform: translateX(4px); }
.mu-cta:focus-visible { outline: 2px solid var(--mu-ink); outline-offset: 4px; }
.mu-cta:active { transform: translateY(0); }
@keyframes mu-cta-breathe {
  0% { box-shadow: 0 0 0 0 rgba(199, 163, 90, 0.5); }
  55% { box-shadow: 0 0 0 16px rgba(199, 163, 90, 0); }
  100% { box-shadow: 0 0 0 16px rgba(199, 163, 90, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .mu-cta, .mu-cta__arrow { transition: none; }
  .mu-cta::before { animation: none; }
  .mu-cta:hover, .mu-cta:focus-visible { transform: none; }
  .mu-cta:hover .mu-cta__arrow, .mu-cta:focus-visible .mu-cta__arrow { transform: none; }
}`,
  tags: ["cta", "button", "pulse", "call to action", "book", "conversion", "hover", "breathe"],
};
