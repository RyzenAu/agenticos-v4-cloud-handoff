import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "voice-to-text",
  name: "Voice to message card",
  tagline: "Spoken words become a structured message",
  category: "Showcase",
  move: "A caller's words type onto a transcript line behind a gold caret, then the line settles and the three fields of a message card (name, reason, callback) fill in one by one. It holds, then replays.",
  reduced: "The transcript line and the completed message card are shown together, still.",
  useFor:
    "The 'takes a proper message' beat on a receptionist page, or a two-step scene in a film. The caller and the fields are sample copy: no real person is shown.",
  html: `
<div class="mu-v2t" data-mu-kit="voice-to-text">
  <p class="mu-v2t__line"><span class="mu-v2t__tag">Caller</span><span class="mu-v2t__text" data-full="Hi, I'm a new patient. Could someone call me back this afternoon about booking a check-up?">Hi, I'm a new patient. Could someone call me back this afternoon about booking a check-up?</span></p>
  <div class="mu-v2t__card">
    <div class="mu-v2t__head"><span>Message taken · sample</span><i></i></div>
    <dl>
      <div><dt>Name</dt><dd>Sample caller</dd></div>
      <div><dt>Reason</dt><dd>Book a check-up</dd></div>
      <div><dt>Callback</dt><dd>This afternoon</dd></div>
    </dl>
  </div>
</div>`,
  css: `
${rootRule(
  ".mu-v2t",
  `  width: min(100%, 400px);
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-v2t__line { margin: 0; min-height: 4.6em; display: flex; flex-direction: column; gap: 6px; font-size: 0.95rem; line-height: 1.5; }
.mu-v2t__tag { font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--mu-muted); }
.mu-v2t__text { min-width: 0; overflow-wrap: anywhere; }
.mu-v2t[data-armed] .mu-v2t__text::after { content: ""; display: inline-block; width: 2px; height: 1.05em; margin-left: 2px; vertical-align: text-bottom; background: var(--mu-gold); animation: mu-v2t-caret 0.8s steps(1) infinite; }
.mu-v2t[data-armed][data-stage="card"] .mu-v2t__text::after { display: none; }
.mu-v2t__card { padding: 16px 16px 6px; border-radius: 16px; background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface)); box-shadow: 0 0 0 1px var(--mu-line), inset 3px 0 0 var(--mu-gold); transition: opacity 0.5s var(--mu-ease), transform 0.5s var(--mu-ease); }
.mu-v2t__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-family: var(--mu-display); font-size: 1.05rem; }
.mu-v2t__head i { width: 8px; height: 8px; border-radius: 50%; background: var(--mu-gold); }
.mu-v2t dl { margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.mu-v2t dl div { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; padding: 9px 0; border-top: 1px solid var(--mu-line); font-size: 0.88rem; transition: opacity 0.45s var(--mu-ease), transform 0.45s var(--mu-ease); }
.mu-v2t dt { color: var(--mu-muted); }
.mu-v2t dd { margin: 0; min-width: 0; color: var(--mu-gold-hi); }
.mu-v2t[data-armed] .mu-v2t__card { opacity: 0.35; }
.mu-v2t[data-armed] dl div { opacity: 0; transform: translateY(6px); }
.mu-v2t[data-armed][data-stage="card"] .mu-v2t__card { opacity: 1; }
.mu-v2t[data-armed][data-stage="card"] dl div { opacity: 1; transform: none; }
.mu-v2t[data-armed][data-stage="card"] dl div:nth-child(2) { transition-delay: 0.35s; }
.mu-v2t[data-armed][data-stage="card"] dl div:nth-child(3) { transition-delay: 0.7s; }
@keyframes mu-v2t-caret { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .mu-v2t[data-armed] .mu-v2t__text::after { display: none; animation: none; }
  .mu-v2t[data-armed] .mu-v2t__card, .mu-v2t[data-armed] dl div { opacity: 1; transform: none; transition: none; }
}
${PAUSE_CSS}`,
  init: IN_VIEW + `
const text = root.querySelector(".mu-v2t__text");
if (!text) return;
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
const full = text.getAttribute("data-full") || text.textContent || "";
root.setAttribute("data-armed", "");
const CHAR = 34;
const lead = 400;
const events = [];
for (let i = 1; i <= full.length; i++) events.push([lead + i * CHAR, () => { text.textContent = full.slice(0, i); }]);
const typed = lead + full.length * CHAR;
events.push([typed + 500, () => root.setAttribute("data-stage", "card")]);
const seq = muSeq(() => {
  root.setAttribute("data-stage", "typing");
  text.textContent = "";
}, events, typed + 500 + 5200);
seq.start();
const watch = muInView(root, (on) => {
  if (on) seq.resume();
  else seq.pause();
});
if (!watch.running()) seq.pause();
return () => {
  seq.stop();
  watch.stop();
};`,
  sampleCopy: true,
  tags: ["transcript", "voice", "message", "caret", "typing", "structured", "receptionist", "card"],
};
