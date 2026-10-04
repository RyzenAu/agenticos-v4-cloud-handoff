import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "proof-marquee",
  name: "Proof marquee",
  tagline: "Reasons to trust drift past, and pause for you",
  category: "Proof",
  move: "A single row of proof points glides left at reading pace (about 40 px a second) with soft faded edges; hovering or focusing it pauses the row. The script repeats the items once so the loop never shows a gap.",
  reduced: "The row doesn't move: the points wrap onto as many lines as they need.",
  useFor:
    "Under a hero: review average, years open, health funds, languages spoken. Every point must be true and sourced.",
  html: `
<!-- Every point must be true and sourced (mu-business-evidence). -->
<div class="mu-marquee" data-mu-kit="proof-marquee">
  <ul class="mu-marquee__track" aria-label="Why people choose us">
    <li>4.9 from 212 Google reviews</li>
    <li>Same-week appointments</li>
    <li>All health funds, HICAPS on the spot</li>
    <li>Open Saturdays</li>
    <li>Two minutes from the station</li>
    <li>Care in English, Arabic and Hindi</li>
  </ul>
</div>`,
  css: `
${rootRule(
  ".mu-marquee",
  `  width: 100%;
  overflow: hidden;
  padding: 14px 0;
  border-block: 1px solid var(--mu-line);
  font-family: var(--mu-sans);
  color: var(--mu-ink);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);`,
)}
.mu-marquee__track {
  display: flex;
  width: max-content;
  margin: 0;
  padding: 0;
  list-style: none;
}
.mu-marquee[data-ready] .mu-marquee__track { animation: mu-marquee-slide var(--mu-marquee-dur, 30s) linear infinite; }
.mu-marquee:hover .mu-marquee__track, .mu-marquee:focus-within .mu-marquee__track { animation-play-state: paused; }
.mu-marquee__track li {
  display: inline-flex;
  align-items: center;
  gap: 18px;
  padding: 0 18px;
  white-space: nowrap;
  font-size: 1rem;
}
.mu-marquee__track li::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--mu-gold);
  flex: none;
}
@keyframes mu-marquee-slide { to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) {
  .mu-marquee { -webkit-mask-image: none; mask-image: none; }
  .mu-marquee__track, .mu-marquee[data-ready] .mu-marquee__track { width: auto; flex-wrap: wrap; justify-content: center; row-gap: 8px; animation: none; }
  .mu-marquee__track [data-copy] { display: none; }
}`,
  init: `
const track = root.querySelector(".mu-marquee__track");
if (!track) return;
const originals = [...track.children];
originals.forEach((li) => {
  const copy = li.cloneNode(true);
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("data-copy", "");
  track.appendChild(copy);
});
const px = track.scrollWidth / 2;
root.style.setProperty("--mu-marquee-dur", Math.max(12, px / 40).toFixed(1) + "s");
root.setAttribute("data-ready", "");
return () => {
  for (const el of track.querySelectorAll("[data-copy]")) el.remove();
  root.removeAttribute("data-ready");
};`,
  sampleCopy: true,
  tags: ["marquee", "ticker", "proof", "trust", "reviews", "logos", "scroll", "loop"],
};
