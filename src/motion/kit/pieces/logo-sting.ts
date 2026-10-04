import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "logo-sting",
  name: "M&U logo sting",
  tagline: "A gold ring draws, the monogram settles, light sweeps",
  category: "Brand",
  move: "A gold ring draws round in 1.1 s, the M and U tighten from wide tracking as the italic ampersand scales in, VENTURES fades up underneath, then one soft sheen crosses the mark.",
  reduced: "The finished mark is shown at once: no draw, no tracking and no sheen.",
  useFor:
    "Video intros and outros, a proposal cover, or the moment a page loads. Swap the letters for a client's monogram.",
  html: `
<div class="mu-sting" data-mu-kit="logo-sting" role="img" aria-label="M&amp;U Ventures">
  <span class="mu-sting__disc" aria-hidden="true">
    <svg class="mu-sting__ring" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" pathLength="1" /></svg>
    <span class="mu-sting__mark"><span class="mu-sting__l">M</span><span class="mu-sting__amp">&amp;</span><span class="mu-sting__l">U</span></span>
    <span class="mu-sting__sheen"></span>
  </span>
  <span class="mu-sting__word" aria-hidden="true">Ventures</span>
</div>`,
  css: `
${rootRule(
  ".mu-sting",
  `  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  color: var(--mu-ink);`,
)}
.mu-sting__disc {
  position: relative;
  display: grid;
  place-items: center;
  width: clamp(120px, 26vw, 176px);
  aspect-ratio: 1;
  border-radius: 50%;
  overflow: hidden;
  background: radial-gradient(circle at 50% 38%, var(--mu-raised), var(--mu-bg) 70%);
}
.mu-sting__ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.mu-sting__ring circle {
  fill: none;
  stroke: var(--mu-gold);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-dasharray: 1;
  animation: mu-sting-draw 1.1s var(--mu-ease-in-out) both;
}
.mu-sting__mark {
  display: flex;
  align-items: baseline;
  font-family: var(--mu-display);
  font-size: clamp(2.2rem, 6vw, 3.2rem);
  font-weight: 500;
  letter-spacing: 0.02em;
  animation: mu-sting-track 1.2s var(--mu-ease) 0.35s both;
}
.mu-sting__amp {
  margin: 0 0.04em;
  font-style: italic;
  font-weight: 400;
  color: var(--mu-gold);
  animation: mu-sting-amp 0.9s var(--mu-ease) 0.7s both;
}
.mu-sting__sheen {
  position: absolute;
  inset: -20%;
  background: linear-gradient(105deg, transparent 38%, rgba(255, 236, 190, 0.28) 50%, transparent 62%);
  transform: translateX(-120%);
  animation: mu-sting-sheen 1.1s var(--mu-ease-in-out) 1.55s both;
  pointer-events: none;
}
.mu-sting__word {
  font-family: var(--mu-sans);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.42em;
  text-transform: uppercase;
  color: var(--mu-muted);
  padding-left: 0.42em;
  animation: mu-sting-up 0.8s var(--mu-ease) 1.2s both;
}
@keyframes mu-sting-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes mu-sting-track { from { letter-spacing: 0.5em; opacity: 0; filter: blur(4px); } to { letter-spacing: 0.02em; opacity: 1; filter: blur(0); } }
@keyframes mu-sting-amp { from { transform: scale(0.4) rotate(-12deg); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes mu-sting-sheen { to { transform: translateX(120%); } }
@keyframes mu-sting-up { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .mu-sting__ring circle,
  .mu-sting__mark,
  .mu-sting__amp,
  .mu-sting__word { animation: none; }
  .mu-sting__sheen { display: none; }
}`,
  loopMs: 4200,
  tags: ["logo", "sting", "brand", "intro", "outro", "monogram", "gold", "video"],
};
