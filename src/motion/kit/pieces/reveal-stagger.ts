import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "reveal-stagger",
  name: "Service cards reveal",
  tagline: "Cards rise in turn as the section arrives",
  category: "Type",
  move: "As the section scrolls in, each card rises 24 px and fades up, 110 ms after the one before; the gold icon ring draws itself last. Once, never on the way back up.",
  reduced: "The cards are simply there: no rise, no fade and no ring drawing.",
  useFor: "Services, treatments, practice areas or listings: any grid of three to six cards.",
  html: `
<ul class="mu-reveal" data-mu-kit="reveal-stagger">
  <li class="mu-reveal__card" style="--i:0"><svg class="mu-reveal__ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" pathLength="1" /></svg><h3>Check-ups</h3><p>Unhurried, with photos of what we see.</p></li>
  <li class="mu-reveal__card" style="--i:1"><svg class="mu-reveal__ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" pathLength="1" /></svg><h3>Emergencies</h3><p>Same-day slots held every morning.</p></li>
  <li class="mu-reveal__card" style="--i:2"><svg class="mu-reveal__ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" pathLength="1" /></svg><h3>Whitening</h3><p>In the chair or take-home, priced up front.</p></li>
</ul>`,
  css: `
${rootRule(
  ".mu-reveal",
  `  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px;
  width: min(100%, 620px);
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--mu-sans);
  color: var(--mu-ink);`,
)}
.mu-reveal__card {
  padding: 20px 18px 22px;
  border-radius: 18px;
  background: linear-gradient(170deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line);
}
.mu-reveal__card h3 { margin: 14px 0 6px; font-family: var(--mu-display); font-size: 1.2rem; font-weight: 500; }
.mu-reveal__card p { margin: 0; font-size: 0.9rem; line-height: 1.45; color: var(--mu-muted); }
.mu-reveal__ring { width: 40px; height: 40px; transform: rotate(-90deg); }
.mu-reveal__ring circle { fill: none; stroke: var(--mu-gold); stroke-width: 2.2; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 0; }
.mu-reveal[data-armed] .mu-reveal__card { opacity: 0; transform: translateY(24px); }
.mu-reveal[data-armed] .mu-reveal__ring circle { stroke-dashoffset: 1; }
.mu-reveal[data-play] .mu-reveal__card { animation: mu-reveal-rise 0.8s var(--mu-ease) forwards; animation-delay: calc(var(--i) * 110ms); }
.mu-reveal[data-play] .mu-reveal__ring circle { animation: mu-reveal-draw 0.9s var(--mu-ease-in-out) forwards; animation-delay: calc(var(--i) * 110ms + 450ms); }
@keyframes mu-reveal-rise { to { opacity: 1; transform: none; } }
@keyframes mu-reveal-draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .mu-reveal[data-armed] .mu-reveal__card, .mu-reveal[data-play] .mu-reveal__card { opacity: 1; transform: none; animation: none; }
  .mu-reveal[data-armed] .mu-reveal__ring circle, .mu-reveal[data-play] .mu-reveal__ring circle { stroke-dashoffset: 0; animation: none; }
}`,
  init: `
root.setAttribute("data-armed", "");
const io = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) {
    root.setAttribute("data-play", "");
    io.disconnect();
  }
}, { threshold: 0.25 });
io.observe(root);
return () => io.disconnect();`,
  loopMs: 3600,
  sampleCopy: true,
  tags: ["reveal", "stagger", "cards", "services", "scroll", "fade up", "grid", "on view"],
};
