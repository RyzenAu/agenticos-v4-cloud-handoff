import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

// Skyline: [x, width, height] bottom-aligned on a 200 x 60 plane, with fixed window dots.
const TOWERS: [number, number, number][] = [
  [4, 22, 34], [30, 16, 48], [50, 26, 28], [80, 18, 54], [102, 28, 38], [134, 16, 30], [154, 22, 46], [180, 18, 26],
];
const towers = TOWERS.map(([x, w, h]) => `<rect class="mu-n2d__tw" x="${x}" y="${60 - h}" width="${w}" height="${h}" />`).join("");
const windows = TOWERS.flatMap(([x, w, h], t) => {
  const out: string[] = [];
  for (let r = 0; r < Math.floor((h - 6) / 9); r++)
    for (let c = 0; c < Math.floor((w - 4) / 6); c++)
      if ((r * 3 + c * 5 + t) % 3 !== 0)
        out.push(`<rect class="mu-n2d__win" x="${x + 3 + c * 6}" y="${60 - h + 5 + r * 9}" width="3" height="4" />`);
  return out;
}).join("");

export const piece: KitPiece = {
  id: "night-to-day",
  name: "Night to day skyline",
  tagline: "Night turns to day while the front desk stays on",
  category: "Showcase",
  move: "The sky fades from night to a warm gold day and back over 12 s. A moon becomes a sun as it crosses the upper sky, windows light up at night, and the Front desk: on badge in the bottom bar never changes.",
  reduced: "A still dusk: a gold sky, lit windows and the same Front desk: on badge. No crossing and no fade.",
  useFor:
    "The 'covered all hours' story: a hero band behind a receptionist headline, or a film transition. A generic skyline, not a real place.",
  html: `
<figure class="mu-n2d" data-mu-kit="night-to-day" role="img" aria-label="A skyline moving from night to day with a Front desk: on badge">
  <div class="mu-n2d__sky">
    <span class="mu-n2d__day"></span>
    <span class="mu-n2d__stars"><i></i><i></i><i></i><i></i><i></i><i></i></span>
    <span class="mu-n2d__orb"></span>
    <svg class="mu-n2d__city" viewBox="0 0 200 60" preserveAspectRatio="none" aria-hidden="true">${towers}${windows}</svg>
  </div>
  <div class="mu-n2d__bar"><span class="mu-n2d__badge"><i></i>Front desk: on</span></div>
</figure>`,
  css: `
${rootRule(
  ".mu-n2d",
  `  margin: 0;
  width: min(100%, 440px);
  border-radius: 18px;
  overflow: hidden;
  background: var(--mu-bg);
  box-shadow: 0 0 0 1px var(--mu-line);
  font-family: var(--mu-sans);`,
)}
.mu-n2d__sky { position: relative; aspect-ratio: 16 / 8; overflow: hidden; background: linear-gradient(180deg, var(--mu-surface), var(--mu-bg)); }
.mu-n2d__day { position: absolute; inset: 0; background: linear-gradient(180deg, var(--mu-ink) 0%, var(--mu-gold-hi) 70%, var(--mu-gold) 100%); animation: mu-n2d-day 12s linear infinite; }
.mu-n2d__stars i { position: absolute; width: 2px; height: 2px; border-radius: 50%; background: var(--mu-ink); animation: mu-n2d-star 12s linear infinite; }
.mu-n2d__stars i:nth-child(1) { left: 12%; top: 14%; } .mu-n2d__stars i:nth-child(2) { left: 30%; top: 28%; animation-delay: -1.5s; }
.mu-n2d__stars i:nth-child(3) { left: 48%; top: 10%; animation-delay: -0.7s; } .mu-n2d__stars i:nth-child(4) { left: 66%; top: 24%; animation-delay: -2.2s; }
.mu-n2d__stars i:nth-child(5) { left: 82%; top: 12%; animation-delay: -1s; } .mu-n2d__stars i:nth-child(6) { left: 92%; top: 30%; animation-delay: -1.9s; }
.mu-n2d__orb { position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: var(--mu-ink); box-shadow: 0 0 18px 4px rgba(243, 239, 230, 0.25); left: 50%; top: 22%; animation: mu-n2d-orb 12s linear infinite; }
.mu-n2d__city { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 42%; }
.mu-n2d__tw { fill: var(--mu-bg); }
.mu-n2d__win { fill: var(--mu-gold-hi); animation: mu-n2d-win 12s linear infinite; }
.mu-n2d__bar { display: flex; justify-content: center; padding: 12px; background: var(--mu-bg); border-top: 1px solid var(--mu-line); }
.mu-n2d__badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 99px; box-shadow: inset 0 0 0 1px var(--mu-gold); color: var(--mu-gold-hi); font-size: 0.82rem; font-weight: 600; letter-spacing: 0.04em; }
.mu-n2d__badge i { width: 8px; height: 8px; border-radius: 50%; background: var(--mu-gold); box-shadow: 0 0 0 4px rgba(199, 163, 90, 0.2); }
@keyframes mu-n2d-day { 0%, 28% { opacity: 0; } 48%, 78% { opacity: 1; } 98%, 100% { opacity: 0; } }
@keyframes mu-n2d-star { 0%, 22% { opacity: 0.9; } 40%, 82% { opacity: 0; } 98%, 100% { opacity: 0.9; } }
@keyframes mu-n2d-win { 0%, 25% { opacity: 1; } 45%, 80% { opacity: 0.12; } 98%, 100% { opacity: 1; } }
@keyframes mu-n2d-orb {
  0% { left: 12%; top: 40%; background: var(--mu-ink); } 25% { left: 30%; top: 22%; background: var(--mu-ink); } 50% { left: 50%; top: 16%; background: var(--mu-gold); box-shadow: 0 0 26px 8px rgba(199, 163, 90, 0.45); }
  75% { left: 70%; top: 22%; background: var(--mu-gold); } 100% { left: 88%; top: 40%; background: var(--mu-ink); }
}
@media (prefers-reduced-motion: reduce) {
  .mu-n2d__day { animation: none; opacity: 0.8; }
  .mu-n2d__stars, .mu-n2d__orb { display: none; }
  .mu-n2d__win { animation: none; opacity: 0.85; }
}
${PAUSE_CSS}`,
  init: WATCH_ONLY,
  tags: ["night", "day", "skyline", "all hours", "24/7", "badge", "hero", "transition"],
};
