import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const ITEMS = [
  "Greeting and tone agreed with you",
  "Calendar connected",
  "Confirmation texts tested",
  "Test calls made",
  "Message format checked",
];
// Item i ticks at 8 + 14 i % of an 11 s loop; everything clears together at 95%.
const keys = ITEMS.map((_, i) => {
  const a = 8 + i * 14;
  return `@keyframes mu-chk-box${i} { 0%, ${a}% { background: transparent; box-shadow: inset 0 0 0 1.5px var(--mu-line); } ${a + 4}%, 92% { background: var(--mu-gold); box-shadow: none; } 96%, 100% { background: transparent; box-shadow: inset 0 0 0 1.5px var(--mu-line); } }
@keyframes mu-chk-tick${i} { 0%, ${a + 2}% { stroke-dashoffset: 20; } ${a + 7}%, 92% { stroke-dashoffset: 0; } 96%, 100% { stroke-dashoffset: 20; } }
@keyframes mu-chk-txt${i} { 0%, ${a}% { color: var(--mu-muted); } ${a + 4}%, 92% { color: var(--mu-ink); } 96%, 100% { color: var(--mu-muted); } }`;
}).join("\n");
const rules = ITEMS.map(
  (_, i) =>
    `.mu-chk li:nth-child(${i + 1}) .mu-chk__box { animation: mu-chk-box${i} 11s linear infinite; }
.mu-chk li:nth-child(${i + 1}) path { animation: mu-chk-tick${i} 11s ease-out infinite; }
.mu-chk li:nth-child(${i + 1}) span:last-child { animation: mu-chk-txt${i} 11s linear infinite; }`,
).join("\n");

export const piece: KitPiece = {
  id: "checklist-tick",
  name: "Go-live checklist",
  tagline: "Set up and tested, one gold tick at a time",
  category: "Proof",
  move: "Five set-up steps tick off in turn, each box filling gold as its tick draws and its text brightens, ending on a Then we go live line. After a hold the list clears and runs again (11 s).",
  reduced: "Every step is ticked and the list shows Then we go live. Nothing animates.",
  useFor:
    "The 'how we hand it over' section: setup and testing before a receptionist goes live. Edit the steps to match the delivery checklist actually used for that client.",
  html: `
<div class="mu-chk" data-mu-kit="checklist-tick">
  <p class="mu-chk__title">Set up and tested before going live</p>
  <ul>
${ITEMS.map(
  (t) =>
    `    <li><span class="mu-chk__box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9" /></svg></span><span>${t}</span></li>`,
).join("\n")}
  </ul>
  <p class="mu-chk__ready">Then we go live</p>
  <p class="mu-chk__sample">Illustration of our setup process · sample steps</p>
</div>`,
  css: `
${rootRule(
  ".mu-chk",
  `  width: min(100%, 380px);
  box-sizing: border-box;
  padding: 20px 20px 18px;
  border-radius: 20px;
  background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-chk__title { margin: 0 0 14px; font-family: var(--mu-display); font-size: 1.1rem; font-weight: 500; }
.mu-chk ul { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
.mu-chk li { min-width: 0; display: flex; align-items: center; gap: 12px; padding: 9px 0; border-top: 1px solid var(--mu-line); font-size: 0.9rem; }
.mu-chk li span:last-child { min-width: 0; overflow-wrap: anywhere; color: var(--mu-ink); }
.mu-chk__box { flex: none; width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; background: var(--mu-gold); }
.mu-chk__box svg { width: 16px; height: 16px; fill: none; stroke: var(--mu-bg); stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
.mu-chk path { stroke-dasharray: 20; stroke-dashoffset: 0; }
.mu-chk__sample { margin: 10px 0 0; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--mu-muted); opacity: 0.8; }
.mu-chk__ready { margin: 12px 0 0; padding-top: 12px; border-top: 1px solid var(--mu-line); font-size: 0.8rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--mu-gold); animation: mu-chk-ready 11s linear infinite; }
${rules}
${keys}
@keyframes mu-chk-ready { 0%, 78% { opacity: 0; transform: translateY(6px); } 84%, 92% { opacity: 1; transform: none; } 96%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .mu-chk .mu-chk__box, .mu-chk path, .mu-chk li span:last-child, .mu-chk__ready { animation: none !important; }
  .mu-chk__ready { opacity: 1; transform: none; }
}
${PAUSE_CSS}`,
  sampleCopy: true,
  init: WATCH_ONLY,
  tags: ["checklist", "setup", "testing", "go live", "tick", "onboarding", "proof", "delivery"],
};
