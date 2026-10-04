import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "lower-third",
  name: "Lower third",
  tagline: "Name and role wipe in beside a gold bar",
  category: "Video",
  move: "A gold bar grows up from the baseline, the name wipes in from behind it and the role follows 150 ms later; it holds (data-hold, default 4 s), then wipes back out in reverse.",
  reduced: "It fades in, holds and fades out: no growing bar and no wipes.",
  useFor:
    'Testimonial and explainer videos, webinar overlays, or a team section on a site (set data-hold="0" to keep it up).',
  html: `
<div class="mu-lower" data-mu-kit="lower-third" data-hold="4000">
  <span class="mu-lower__bar" aria-hidden="true"></span>
  <div class="mu-lower__text">
    <p class="mu-lower__name">Dr Amelia Hart</p>
    <p class="mu-lower__role">Principal dentist · Lantern Dental</p>
  </div>
</div>`,
  css: `
${rootRule(
  ".mu-lower",
  `  display: inline-flex;
  align-items: stretch;
  gap: 14px;
  padding: 12px 22px 12px 14px;
  border-radius: 14px;
  background: linear-gradient(90deg, rgba(8, 8, 8, 0.82), rgba(8, 8, 8, 0.5));
  backdrop-filter: blur(8px);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-lower__bar {
  width: 4px;
  border-radius: 99px;
  background: linear-gradient(180deg, var(--mu-gold-hi), var(--mu-gold));
  transform-origin: bottom center;
  animation: mu-lower-bar 0.55s var(--mu-ease) both;
}
.mu-lower__text p { margin: 0; }
.mu-lower__name {
  font-family: var(--mu-display);
  font-size: clamp(1.15rem, 2.6vw, 1.6rem);
  font-weight: 500;
  line-height: 1.15;
  animation: mu-lower-wipe 0.7s var(--mu-ease) 0.18s both;
}
.mu-lower__text .mu-lower__role {
  margin-top: 3px;
  font-size: clamp(0.78rem, 1.6vw, 0.95rem);
  letter-spacing: 0.02em;
  color: var(--mu-gold);
  animation: mu-lower-wipe 0.7s var(--mu-ease) 0.33s both;
}
.mu-lower[data-out] .mu-lower__name,
.mu-lower[data-out] .mu-lower__role { animation: mu-lower-unwipe 0.45s var(--mu-ease-in-out) both; }
.mu-lower[data-out] .mu-lower__role { animation-delay: 0s; }
.mu-lower[data-out] .mu-lower__name { animation-delay: 0.08s; }
.mu-lower[data-out] .mu-lower__bar { animation: mu-lower-unbar 0.4s var(--mu-ease-in-out) 0.3s both; }
.mu-lower[data-out] { animation: mu-lower-bg-out 0.3s ease 0.55s both; }
@keyframes mu-lower-bar { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes mu-lower-unbar { from { transform: scaleY(1); } to { transform: scaleY(0); } }
@keyframes mu-lower-wipe { from { clip-path: inset(0 100% 0 0); transform: translateX(-10px); } to { clip-path: inset(0 0 0 0); transform: none; } }
@keyframes mu-lower-unwipe { from { clip-path: inset(0 0 0 0); } to { clip-path: inset(0 100% 0 0); } }
@keyframes mu-lower-bg-out { to { opacity: 0; } }
@keyframes mu-lower-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes mu-lower-fade-out { to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .mu-lower { animation: mu-lower-fade-in 0.4s ease both; }
  .mu-lower .mu-lower__bar, .mu-lower .mu-lower__name, .mu-lower .mu-lower__text .mu-lower__role,
  .mu-lower[data-out] .mu-lower__bar, .mu-lower[data-out] .mu-lower__name, .mu-lower[data-out] .mu-lower__text .mu-lower__role { animation: none; }
  .mu-lower[data-out] { animation: mu-lower-fade-out 0.4s ease both; }
}`,
  init: `
const hold = Number(root.getAttribute("data-hold") || "4000");
if (!hold) return;
const timer = setTimeout(() => root.setAttribute("data-out", ""), hold + 900);
return () => clearTimeout(timer);`,
  loopMs: 6800,
  stage: "video",
  sampleCopy: true,
  tags: ["lower third", "name", "title", "video", "overlay", "caption", "testimonial", "broadcast"],
};
