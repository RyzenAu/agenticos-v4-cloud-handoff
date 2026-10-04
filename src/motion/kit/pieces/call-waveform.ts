import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

// 33 bars with fixed, hand-shaped heights and timings: no randomness, the same every render.
const BARS = Array.from({ length: 33 }, (_, i) => {
  const h = 0.22 + 0.78 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.37 + 0.4));
  const d = 0.62 + (i % 5) * 0.11;
  const delay = -((i * 0.137) % 2);
  return `<span style="--h:${h.toFixed(2)};--d:${d.toFixed(2)}s;--w:${delay.toFixed(2)}s"></span>`;
}).join("");

export const piece: KitPiece = {
  id: "call-waveform",
  name: "Call waveform",
  tagline: "A gold waveform wakes when the front desk answers",
  category: "Showcase",
  move: "Two ring dots flash, the label flips from Ringing to Answered in 2 rings, and a flat gold line lifts into a live waveform that breathes until the loop resets (7 s).",
  reduced:
    "No ring flashing or breathing: the label reads Answered in 2 rings and the waveform shows as a still, shaped gold wave.",
  useFor:
    "The hero or first section of a receptionist page, and the opening shot of a promo film. The ring count is sample copy: set it to what the client's set-up really does.",
  html: `
<figure class="mu-wave" data-mu-kit="call-waveform">
  <div class="mu-wave__status">
    <span class="mu-wave__rings" aria-hidden="true"><i></i><i></i></span>
    <span class="mu-wave__labels">
      <span class="mu-wave__ringing" aria-hidden="true">Ringing</span>
      <span class="mu-wave__answered">Answered in 2 rings</span>
    </span>
  </div>
  <div class="mu-wave__bars" aria-hidden="true">${BARS}</div>
  <figcaption class="mu-wave__cap">Illustration · sample figures</figcaption>
</figure>`,
  css: `
@property --mu-live { syntax: "<number>"; inherits: true; initial-value: 1; }
${rootRule(
  ".mu-wave",
  `  margin: 0;
  width: min(100%, 440px);
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 22px 22px 18px;
  border-radius: 20px;
  background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-wave__status { display: flex; align-items: center; gap: 12px; }
.mu-wave__rings { display: flex; gap: 6px; }
.mu-wave__rings i { width: 9px; height: 9px; border-radius: 50%; background: var(--mu-gold); opacity: 0.9; }
.mu-wave__labels { display: grid; font-family: var(--mu-display); font-size: 1.15rem; font-weight: 500; }
.mu-wave__labels span { grid-area: 1 / 1; }
.mu-wave__ringing { opacity: 0; color: var(--mu-muted); }
.mu-wave__answered { color: var(--mu-ink); }
.mu-wave__bars {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 96px;
  transform: scaleY(max(var(--mu-live), 0.05));
  animation: mu-wave-gate 7s var(--mu-ease-in-out) infinite;
}
.mu-wave__bars span {
  flex: 1;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(180deg, var(--mu-gold-hi), var(--mu-gold));
  transform: scaleY(var(--h));
  animation: mu-wave-bar var(--d) ease-in-out var(--w) infinite alternate;
}
.mu-wave__cap { font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mu-muted); }
.mu-wave__rings i:nth-child(1) { animation: mu-wave-r1 7s linear infinite; }
.mu-wave__rings i:nth-child(2) { animation: mu-wave-r2 7s linear infinite; }
.mu-wave__ringing { animation: mu-wave-ringing 7s linear infinite; }
.mu-wave__answered { animation: mu-wave-answered 7s linear infinite; }
@keyframes mu-wave-bar { from { transform: scaleY(0.18); } to { transform: scaleY(var(--h)); } }
@keyframes mu-wave-gate {
  0%, 20% { --mu-live: 0.05; }
  30%, 90% { --mu-live: 1; }
  98%, 100% { --mu-live: 0.05; }
}
@keyframes mu-wave-r1 { 0%, 3% { opacity: 0.15; } 5%, 10% { opacity: 1; } 13%, 100% { opacity: 0.55; } }
@keyframes mu-wave-r2 { 0%, 11% { opacity: 0.15; } 13%, 18% { opacity: 1; } 21%, 100% { opacity: 0.55; } }
@keyframes mu-wave-ringing { 0% { opacity: 0; } 3%, 16% { opacity: 1; } 19%, 100% { opacity: 0; } }
@keyframes mu-wave-answered { 0%, 21% { opacity: 0; transform: translateY(6px); } 27%, 92% { opacity: 1; transform: none; } 97%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .mu-wave__bars { animation: none; transform: none; }
  .mu-wave__bars span { animation: none; transform: scaleY(var(--h)); }
  .mu-wave__rings i, .mu-wave__rings i:nth-child(1), .mu-wave__rings i:nth-child(2) { animation: none; opacity: 0.9; }
  .mu-wave__ringing { animation: none; opacity: 0; }
  .mu-wave__answered { animation: none; opacity: 1; transform: none; }
}
${PAUSE_CSS}`,
  sampleCopy: true,
  init: WATCH_ONLY,
  tags: ["call", "waveform", "audio", "receptionist", "answered", "rings", "hero", "voice"],
};
