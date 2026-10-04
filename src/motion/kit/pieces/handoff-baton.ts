import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "handoff-baton",
  name: "Message handoff baton",
  tagline: "A gold baton carries the message to your team",
  category: "Showcase",
  move: "A gold baton slides along a track from the AI receptionist to your team, the summary note unfolds under it, and the caption confirms the message was handed over. 8 s loop.",
  reduced: "The baton rests at your team's end with the summary note and caption shown. No travel.",
  useFor:
    "Explaining what happens after the call: the team gets a ready summary. It shows a message being handed over, not a live call transfer: keep the caption that way.",
  html: `
<div class="mu-baton" data-mu-kit="handoff-baton">
  <div class="mu-baton__row">
    <div class="mu-baton__node"><span class="mu-baton__dot mu-baton__dot--a"></span><b>AI receptionist</b></div>
    <div class="mu-baton__track"><span class="mu-baton__rail"></span><span class="mu-baton__stick"></span></div>
    <div class="mu-baton__node"><span class="mu-baton__dot mu-baton__dot--b"></span><b>Your team</b></div>
  </div>
  <div class="mu-baton__note" aria-hidden="true"><span></span><span></span><span></span></div>
  <p class="mu-baton__cap">Message handed to your team</p>
</div>`,
  css: `
${rootRule(
  ".mu-baton",
  `  width: min(100%, 460px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-baton__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(40px, 1.2fr) minmax(0, 1fr); align-items: center; gap: 8px; width: 100%; }
.mu-baton__node { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; font-size: 0.85rem; }
.mu-baton__dot { width: 46px; height: 46px; border-radius: 50%; box-shadow: inset 0 0 0 2px var(--mu-gold); background: var(--mu-surface); }
.mu-baton__dot--b { background: var(--mu-gold); box-shadow: 0 0 0 6px rgba(199, 163, 90, 0.2); animation: mu-baton-glow 8s linear infinite; }
.mu-baton__track { position: relative; height: 46px; min-width: 0; }
.mu-baton__rail { position: absolute; left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; background: var(--mu-line); }
.mu-baton__stick { position: absolute; left: 0; top: 50%; width: 36px; height: 10px; margin: -5px 0 0; border-radius: 99px; background: linear-gradient(90deg, var(--mu-gold), var(--mu-gold-hi)); box-shadow: 0 0 14px rgba(228, 200, 135, 0.5); animation: mu-baton-go 8s var(--mu-ease-in-out) infinite; }
.mu-baton__note { width: min(100%, 260px); display: flex; flex-direction: column; gap: 8px; padding: 14px; box-sizing: border-box; border-radius: 12px; background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface)); box-shadow: 0 0 0 1px var(--mu-line), inset 3px 0 0 var(--mu-gold); animation: mu-baton-note 8s var(--mu-ease) infinite; transform-origin: 50% 0; }
.mu-baton__note span { height: 6px; border-radius: 99px; background: var(--mu-line); }
.mu-baton__note span:nth-child(1) { width: 40%; background: var(--mu-gold); opacity: 0.85; }
.mu-baton__note span:nth-child(2) { width: 90%; } .mu-baton__note span:nth-child(3) { width: 65%; }
.mu-baton__cap { margin: 0; font-family: var(--mu-display); font-size: 1.05rem; text-align: center; animation: mu-baton-cap 8s linear infinite; }
@keyframes mu-baton-go { 0%, 8% { left: 0; opacity: 0; } 12% { left: 0; opacity: 1; } 50%, 90% { left: calc(100% - 36px); opacity: 1; } 96%, 100% { left: calc(100% - 36px); opacity: 0; } }
@keyframes mu-baton-glow { 0%, 48% { box-shadow: 0 0 0 0 rgba(199, 163, 90, 0); } 56%, 90% { box-shadow: 0 0 0 6px rgba(199, 163, 90, 0.3); } 100% { box-shadow: 0 0 0 0 rgba(199, 163, 90, 0); } }
@keyframes mu-baton-note { 0%, 50% { opacity: 0; transform: scaleY(0.4); } 62%, 90% { opacity: 1; transform: none; } 96%, 100% { opacity: 0; transform: scaleY(0.4); } }
@keyframes mu-baton-cap { 0%, 58% { opacity: 0; } 68%, 90% { opacity: 1; } 96%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .mu-baton__stick { animation: none; left: calc(100% - 36px); opacity: 1; }
  .mu-baton__dot--b, .mu-baton__note, .mu-baton__cap { animation: none; }
  .mu-baton__note, .mu-baton__cap { opacity: 1; transform: none; }
}
${PAUSE_CSS}`,
  init: WATCH_ONLY,
  tags: ["handoff", "baton", "message", "team", "receptionist", "summary", "process", "showcase"],
};
