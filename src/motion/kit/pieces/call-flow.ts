import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const STAGES: [string, string][] = [
  ["Ring", "A caller gets through"],
  ["Answer", "Front desk picks up"],
  ["Qualify", "Who, what, how urgent"],
  ["Book or message", "Calendar or a clean note"],
  ["Handoff", "Summary lands with you"],
];
// Node i lights at 8 + 16 i % of a 10 s loop; the dot, the fill and the nodes share that clock.
const T = [8, 24, 40, 56, 72];
const OFF = "background: var(--mu-surface); box-shadow: 0 0 0 1px var(--mu-line); color: var(--mu-muted);";
const ON = "background: var(--mu-gold); box-shadow: 0 0 0 6px rgba(199, 163, 90, 0.18); color: var(--mu-bg);";
const nodeKeyframes = T.map(
  (t, i) =>
    `@keyframes mu-flow-n${i} { 0%, ${t - 1}% { ${OFF} } ${t + 2}%, 90% { ${ON} } 96%, 100% { ${OFF} } }`,
).join("\n");
const nodeRules = T.map(
  (_, i) => `.mu-flow__node:nth-child(${i + 1}) .mu-flow__dot { animation: mu-flow-n${i} 10s linear infinite; }`,
).join("\n");

export const piece: KitPiece = {
  id: "call-flow",
  name: "Call flow path",
  tagline: "Ring, answer, qualify, book, hand off",
  category: "Showcase",
  move: "A gold dot travels the path while each stage lights as it arrives and the line fills behind it; the five stages reset together every 10 s.",
  reduced: "All five stages sit lit with the line filled and no travelling dot.",
  useFor:
    "A how-it-works section for the AI receptionist, or a one-slide explainer in a film. Edit the stage labels to match the client's actual set-up.",
  html: `
<div class="mu-flow" data-mu-kit="call-flow" role="img" aria-label="Call flow: ring, answer, qualify, book or message, handoff">
  <div class="mu-flow__track"><span class="mu-flow__fill"></span><span class="mu-flow__travel"></span></div>
  <ol class="mu-flow__nodes">
${STAGES.map(
  ([n, s], i) =>
    `    <li class="mu-flow__node"><span class="mu-flow__dot">${i + 1}</span><b>${n}</b><small>${s}</small></li>`,
).join("\n")}
  </ol>
</div>`,
  css: `
${rootRule(
  ".mu-flow",
  `  position: relative;
  width: min(100%, 760px);
  padding: 28px 8px 8px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-flow__track { position: absolute; left: 10%; right: 10%; top: 50px; height: 2px; background: var(--mu-line); }
.mu-flow__fill { position: absolute; inset: 0; background: var(--mu-gold); transform-origin: left; animation: mu-flow-fill 10s linear infinite; }
.mu-flow__travel { position: absolute; top: -5px; left: 0; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: var(--mu-gold-hi); box-shadow: 0 0 14px 3px rgba(228, 200, 135, 0.6); animation: mu-flow-dot 10s linear infinite; }
.mu-flow__nodes { position: relative; display: grid; grid-template-columns: repeat(5, 1fr); margin: 0; padding: 0; list-style: none; text-align: center; }
.mu-flow__node { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0 2px; }
.mu-flow__dot {
  display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%;
  background: var(--mu-gold); color: var(--mu-bg);
  box-shadow: 0 0 0 6px rgba(199, 163, 90, 0.18);
  font-family: var(--mu-display); font-weight: 600; font-variant-numeric: tabular-nums;
}
.mu-flow__node b { margin-top: 6px; font-size: 0.95rem; font-weight: 600; line-height: 1.2; }
.mu-flow__node small { font-size: 0.78rem; line-height: 1.3; color: var(--mu-muted); max-width: 14ch; }
${nodeRules}
${nodeKeyframes}
@keyframes mu-flow-fill {
  0%, 8% { transform: scaleX(0); opacity: 1; } 24% { transform: scaleX(0.25); } 40% { transform: scaleX(0.5); }
  56% { transform: scaleX(0.75); } 72%, 90% { transform: scaleX(1); opacity: 1; } 96%, 100% { transform: scaleX(1); opacity: 0; }
}
@keyframes mu-flow-dot {
  0%, 4% { left: 0%; opacity: 0; } 8% { left: 0%; opacity: 1; } 24% { left: 25%; } 40% { left: 50%; }
  56% { left: 75%; } 72% { left: 100%; opacity: 1; } 78%, 100% { left: 100%; opacity: 0; }
}
@media (max-width: 520px) {
  .mu-flow__node small { display: none; }
  .mu-flow__node b { font-size: 0.8rem; }
  .mu-flow__dot { width: 36px; height: 36px; }
  .mu-flow__track { top: 46px; }
}
@media (prefers-reduced-motion: reduce) {
  .mu-flow__travel { display: none; animation: none; }
  .mu-flow__fill { animation: none; transform: none; opacity: 1; }
  .mu-flow__dot { animation: none !important; }
}
${PAUSE_CSS}`,
  init: WATCH_ONLY,
  tags: ["flow", "process", "steps", "receptionist", "how it works", "path", "timeline", "handoff"],
};
