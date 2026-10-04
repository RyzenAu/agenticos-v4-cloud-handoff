import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const SECTORS: [string, string][] = [
  ["Dental", "Books new-patient visits and takes urgent messages for the team."],
  ["Legal", "Takes matter enquiries and sets callbacks with the right person."],
  ["Real estate", "Captures buyer and tenant enquiries, including after the open home."],
];
const card = ([n, t]: [string, string], i: number) =>
  `<div class="mu-sec__card" style="--i:${i}"><b>${n}</b><span>${t}</span></div>`;
// One face at a time: hold, turn 120 degrees, hold. The dots follow the same clock.
const dotKeys = [0, 1, 2]
  .map((i) => {
    const a = i * 33.3;
    return `@keyframes mu-sec-dot${i} { 0%, 100% { background: var(--mu-line); } ${i === 0 ? "0%, 28%" : `${a.toFixed(1)}%, ${(a + 28).toFixed(1)}%`} { background: var(--mu-gold); } }`;
  })
  .join("\n");

export const piece: KitPiece = {
  id: "sector-carousel",
  name: "Sector card carousel",
  tagline: "Dental, legal and real estate turn in 3D",
  category: "Showcase",
  move: "Three sector cards sit on a turning ring in 3D. Each faces front for about three seconds, then the ring turns 120 degrees to the next while a dot below follows. A full lap takes 10 s.",
  reduced: "No turning: the three cards sit side by side, flat, each with its one-line use.",
  useFor:
    "A 'who we work with' band on M&U's own site. The one-line uses are descriptive copy about the offer: edit them to match the real service for each sector.",
  html: `
<div class="mu-sec" data-mu-kit="sector-carousel">
  <div class="mu-sec__stage"><div class="mu-sec__ring">${SECTORS.map(card).join("")}</div></div>
  <div class="mu-sec__dots" aria-hidden="true"><i></i><i></i><i></i></div>
</div>`,
  css: `
${rootRule(
  ".mu-sec",
  `  width: min(100%, 460px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 34px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-sec__stage { width: 100%; height: 190px; perspective: 800px; }
.mu-sec__ring { position: relative; width: min(66%, 240px); height: 100%; margin: 0 auto; transform-style: preserve-3d; animation: mu-sec-turn 10s var(--mu-ease-in-out) infinite; }
.mu-sec__card {
  position: absolute; inset: 0; box-sizing: border-box; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px;
  padding: 18px; border-radius: 18px; backface-visibility: hidden;
  background: linear-gradient(160deg, var(--mu-raised), var(--mu-surface)); box-shadow: 0 0 0 1px var(--mu-line), inset 0 3px 0 var(--mu-gold);
  transform: rotateY(calc(var(--i) * 120deg)) translateZ(120px);
}
.mu-sec__card b { font-family: var(--mu-display); font-size: 1.4rem; font-weight: 500; color: var(--mu-gold-hi); }
.mu-sec__card span { font-size: 0.85rem; line-height: 1.45; color: var(--mu-muted); overflow-wrap: anywhere; }
.mu-sec__dots { display: flex; gap: 8px; }
.mu-sec__dots i { width: 8px; height: 8px; border-radius: 50%; background: var(--mu-line); }
.mu-sec__dots i:nth-child(1) { animation: mu-sec-dot0 10s linear infinite; }
.mu-sec__dots i:nth-child(2) { animation: mu-sec-dot1 10s linear infinite; }
.mu-sec__dots i:nth-child(3) { animation: mu-sec-dot2 10s linear infinite; }
@keyframes mu-sec-turn {
  0%, 28% { transform: rotateY(0deg); } 33.3%, 61.3% { transform: rotateY(-120deg); } 66.6%, 94.6% { transform: rotateY(-240deg); } 100% { transform: rotateY(-360deg); }
}
${dotKeys}
@media (max-width: 420px) { .mu-sec__card { transform: rotateY(calc(var(--i) * 120deg)) translateZ(90px); padding: 14px; } .mu-sec__card b { font-size: 1.2rem; } }
@media (prefers-reduced-motion: reduce) {
  .mu-sec__stage { height: auto; perspective: none; }
  .mu-sec__ring { width: 100%; height: auto; animation: none; transform: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .mu-sec__card, .mu-sec__card { position: relative; transform: none; padding: 12px; }
  .mu-sec__card b { font-size: 1.05rem; } .mu-sec__card span { font-size: 0.75rem; }
  .mu-sec__dots { display: none; }
}
${PAUSE_CSS}`,
  init: WATCH_ONLY,
  tags: ["carousel", "3d", "sectors", "dental", "legal", "real estate", "cards", "who we work with"],
};
