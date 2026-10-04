import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const PHONE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5h3l1.4 4-2 1.3a11 11 0 0 0 5.2 5.2l1.3-2 4 1.4v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" /></svg>`;

export const piece: KitPiece = {
  id: "before-after-phone",
  name: "Missed to answered phone",
  tagline: "A phone rings out, then the same call is answered",
  category: "Showcase",
  move: "The phone shakes while it rings, rings out to a muted No answer, then the same screen turns gold and reads Answered, with a small live waveform. The tag above flips from Before to After. 9 s loop.",
  reduced: "No ringing or morphing: the phone shows the Answered state and the After tag.",
  useFor:
    "The 'why a receptionist' argument on a landing page, or a before-and-after scene in a film. No call data is shown: it is a picture of the idea.",
  html: `
<div class="mu-ph" data-mu-kit="before-after-phone" role="img" aria-label="A phone that rings out unanswered, then the same phone answered">
  <div class="mu-ph__tags"><span class="mu-ph__tag mu-ph__tag--before">Before</span><span class="mu-ph__tag mu-ph__tag--after">After</span></div>
  <div class="mu-ph__body">
    <div class="mu-ph__screen">
      <div class="mu-ph__layer mu-ph__miss">
        <span class="mu-ph__ico">${PHONE}</span>
        <b>No answer</b><small>Missed call</small>
      </div>
      <div class="mu-ph__layer mu-ph__ans">
        <span class="mu-ph__ico mu-ph__ico--on">${PHONE}</span>
        <b>Answered</b>
        <span class="mu-ph__bars"><i></i><i></i><i></i><i></i><i></i></span>
      </div>
    </div>
  </div>
</div>`,
  css: `
${rootRule(
  ".mu-ph",
  `  width: 214px;
  box-sizing: border-box;
  padding: 0 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-ph__tags { display: grid; height: 1.4em; }
.mu-ph__tag { grid-area: 1 / 1; text-align: center; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }
.mu-ph__tag--before { color: var(--mu-muted); animation: mu-ph-before 9s linear infinite; }
.mu-ph__tag--after { color: var(--mu-gold); opacity: 1; animation: mu-ph-after 9s linear infinite; }
.mu-ph__body { width: 100%; padding: 10px; box-sizing: border-box; border-radius: 34px; background: var(--mu-surface); box-shadow: 0 0 0 1px var(--mu-line), 0 22px 40px rgba(0, 0, 0, 0.5); animation: mu-ph-shake 9s linear infinite; transform-origin: 50% 70%; }
.mu-ph__screen { position: relative; aspect-ratio: 9 / 15; border-radius: 26px; overflow: hidden; background: var(--mu-bg); }
.mu-ph__layer { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 0 10px; }
.mu-ph__layer b { font-family: var(--mu-display); font-size: 1.25rem; font-weight: 500; }
.mu-ph__layer small { font-size: 0.72rem; color: var(--mu-muted); letter-spacing: 0.06em; text-transform: uppercase; }
.mu-ph__miss { color: var(--mu-muted); animation: mu-ph-miss 9s linear infinite; opacity: 0; }
.mu-ph__ans { background: radial-gradient(90% 70% at 50% 35%, rgba(199, 163, 90, 0.28), var(--mu-bg) 75%); opacity: 1; animation: mu-ph-ans 9s linear infinite; }
.mu-ph__ico { display: grid; place-items: center; width: 58px; height: 58px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--mu-line); }
.mu-ph__ico svg { width: 26px; height: 26px; fill: currentColor; }
.mu-ph__ico--on { background: var(--mu-gold); color: var(--mu-bg); box-shadow: 0 0 0 7px rgba(199, 163, 90, 0.18); }
.mu-ph__bars { display: flex; align-items: center; gap: 4px; height: 26px; }
.mu-ph__bars i { width: 4px; height: 100%; border-radius: 99px; background: var(--mu-gold-hi); animation: mu-ph-bar 0.8s ease-in-out infinite alternate; }
.mu-ph__bars i:nth-child(1) { animation-delay: -0.1s; } .mu-ph__bars i:nth-child(2) { animation-delay: -0.4s; }
.mu-ph__bars i:nth-child(3) { animation-delay: -0.2s; } .mu-ph__bars i:nth-child(4) { animation-delay: -0.6s; } .mu-ph__bars i:nth-child(5) { animation-delay: -0.3s; }
@keyframes mu-ph-bar { from { transform: scaleY(0.25); } to { transform: scaleY(1); } }
@keyframes mu-ph-shake {
  0%, 2%, 12%, 22%, 32% { transform: none; } 4% { transform: rotate(-3deg); } 6% { transform: rotate(3deg); } 8% { transform: rotate(-3deg); } 10% { transform: rotate(2deg); }
  14% { transform: rotate(-3deg); } 16% { transform: rotate(3deg); } 18% { transform: rotate(-3deg); } 20% { transform: rotate(2deg); }
  24% { transform: rotate(-3deg); } 26% { transform: rotate(3deg); } 28% { transform: rotate(-2deg); } 30%, 100% { transform: none; }
}
@keyframes mu-ph-miss { 0%, 1% { opacity: 1; } 49% { opacity: 1; } 55%, 100% { opacity: 0; } }
@keyframes mu-ph-ans { 0%, 49% { opacity: 0; } 55%, 92% { opacity: 1; } 97%, 100% { opacity: 0; } }
@keyframes mu-ph-before { 0%, 1% { opacity: 1; } 49% { opacity: 1; } 55%, 100% { opacity: 0; } }
@keyframes mu-ph-after { 0%, 49% { opacity: 0; } 55%, 92% { opacity: 1; } 97%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .mu-ph__body { animation: none; }
  .mu-ph__tag, .mu-ph__miss, .mu-ph__ans, .mu-ph__bars i { animation: none; }
  .mu-ph__tag--before, .mu-ph__miss { opacity: 0; }
  .mu-ph__tag--after, .mu-ph__ans { opacity: 1; }
}
${PAUSE_CSS}`,
  init: WATCH_ONLY,
  tags: ["phone", "missed call", "answered", "before after", "morph", "receptionist", "comparison"],
};
