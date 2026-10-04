import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "kinetic-headline",
  name: "Kinetic headline",
  tagline: "Words rise from a mask, a gold rule draws",
  category: "Type",
  move: "Each word rises out of its own mask with a soft stagger (90 ms apart); the accent word lands last in gold italic and a hairline rule draws under it. Plays once when it scrolls into view.",
  reduced: "The words simply fade in together; no rise and no rule animation.",
  useFor: "The hero headline of a client site, or a section opener. Keep it to two short lines.",
  html: `
<h2 class="mu-kinetic" data-mu-kit="kinetic-headline">
  <span class="mu-kinetic__line"><span class="mu-kinetic__word" style="--i:0">Care</span> <span class="mu-kinetic__word" style="--i:1">that</span> <span class="mu-kinetic__word" style="--i:2">fits</span></span>
  <span class="mu-kinetic__line"><span class="mu-kinetic__word" style="--i:3">your</span> <em class="mu-kinetic__word mu-kinetic__accent" style="--i:4">week.</em></span>
</h2>`,
  css: `
${rootRule(
  ".mu-kinetic",
  `  margin: 0;
  font-family: var(--mu-display);
  font-weight: 500;
  font-size: clamp(2.4rem, 7vw, 4.6rem);
  line-height: 1.04;
  letter-spacing: -0.02em;
  color: var(--mu-ink);`,
)}
.mu-kinetic__line {
  display: block;
  overflow: hidden;
  padding: 0.02em 0 0.16em;
  margin-bottom: -0.12em;
}
.mu-kinetic__word {
  display: inline-block;
  will-change: transform;
}
.mu-kinetic__accent {
  position: relative;
  font-style: italic;
  color: var(--mu-gold);
}
.mu-kinetic__accent::after {
  content: "";
  position: absolute;
  left: 0.04em;
  right: 0.1em;
  bottom: 0.02em;
  height: max(2px, 0.045em);
  border-radius: 99px;
  background: var(--mu-gold);
  transform-origin: left center;
}
/* Armed by the script (no script = the words are simply there). */
.mu-kinetic[data-armed] .mu-kinetic__word {
  transform: translateY(110%);
  opacity: 0;
}
.mu-kinetic[data-armed] .mu-kinetic__accent::after {
  transform: scaleX(0);
}
.mu-kinetic[data-play] .mu-kinetic__word {
  animation: mu-kinetic-rise 0.95s var(--mu-ease) forwards;
  animation-delay: calc(var(--i) * 90ms + 80ms);
}
.mu-kinetic[data-play] .mu-kinetic__accent::after {
  animation: mu-kinetic-rule 0.8s var(--mu-ease) 0.85s forwards;
}
@keyframes mu-kinetic-rise {
  to { transform: none; opacity: 1; }
}
@keyframes mu-kinetic-rule {
  to { transform: scaleX(1); }
}
@keyframes mu-kinetic-fade {
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .mu-kinetic[data-armed] .mu-kinetic__word { transform: none; }
  .mu-kinetic[data-play] .mu-kinetic__word { animation: mu-kinetic-fade 0.4s ease forwards; animation-delay: 0s; }
  .mu-kinetic[data-armed] .mu-kinetic__accent::after,
  .mu-kinetic[data-play] .mu-kinetic__accent::after { transform: none; animation: none; }
}`,
  init: `
root.setAttribute("data-armed", "");
const io = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) {
    root.setAttribute("data-play", "");
    io.disconnect();
  }
}, { threshold: 0.3 });
io.observe(root);
return () => io.disconnect();`,
  loopMs: 4200,
  tags: ["headline", "hero", "type", "reveal", "stagger", "mask", "kinetic"],
};
