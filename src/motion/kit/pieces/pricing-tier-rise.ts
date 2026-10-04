import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const TIERS: { name: string; h: number; feat: number[] }[] = [
  { name: "Plan A", h: 78, feat: [78, 60, 70] },
  { name: "Plan B", h: 100, feat: [86, 72, 80, 64] },
  { name: "Plan C", h: 88, feat: [82, 66, 74] },
];
// Column i rises at 6 + 9 i % of an 8 s loop, holds, and drops together at 94%.
const rise = TIERS.map((_, i) => {
  const a = 4 + i * 9;
  return `@keyframes mu-tier-${i} { 0%, ${a}% { opacity: 0; transform: translateY(46px); } ${a + 12}%, 90% { opacity: 1; transform: none; } 96%, 100% { opacity: 0; transform: translateY(18px); } }`;
}).join("\n");
const col = (t: (typeof TIERS)[number], i: number) =>
  `<div class="mu-tier__col mu-tier__col--${i}${i === 1 ? " mu-tier__col--hi" : ""}" style="height:${t.h}%">
      <b class="mu-tier__name">${t.name}</b>
      <span class="mu-tier__price"></span>
      <ul>${t.feat.map((w) => `<li><i></i><span style="width:${w}%"></span></li>`).join("")}</ul>
      <span class="mu-tier__btn">Book a demo</span>
    </div>`;

export const piece: KitPiece = {
  id: "pricing-tier-rise",
  name: "Pricing tier rise",
  tagline: "Three plan columns rise, the middle one lights up",
  category: "Conversion",
  move: "Three columns rise one after another in a staircase, then a bright band sweeps across the middle one and its gold edge glows. They drop and replay every 8 s.",
  reduced: "All three columns sit in place, the middle one outlined in gold. No rising and no sweep.",
  useFor:
    "A plans section or a one-shot in a film. The labels are neutral placeholders (Plan A, B, C) with grey skeleton lines: it carries no prices, minutes or inclusions. Replace them with approved copy only.",
  html: `
<div class="mu-tier" data-mu-kit="pricing-tier-rise" role="img" aria-label="Three plan columns with the middle plan highlighted">
  ${TIERS.map(col).join("\n  ")}
</div>`,
  css: `
${rootRule(
  ".mu-tier",
  `  display: flex;
  align-items: flex-end;
  gap: 12px;
  width: min(100%, 520px);
  height: 300px;
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-tier__col {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 14px 14px;
  box-sizing: border-box;
  overflow: hidden;
  border-radius: 16px;
  background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line);
}
.mu-tier__col--hi { box-shadow: 0 0 0 1.5px var(--mu-gold), 0 0 32px rgba(199, 163, 90, 0.18); }
.mu-tier__name { font-family: var(--mu-display); font-size: 1.1rem; font-weight: 500; }
.mu-tier__price { display: block; width: 52%; height: 22px; border-radius: 6px; background: var(--mu-gold); opacity: 0.85; }
.mu-tier__col ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; flex: 1; }
.mu-tier__col li { display: flex; align-items: center; gap: 8px; }
.mu-tier__col li i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--mu-gold); }
.mu-tier__col li span { height: 6px; border-radius: 99px; background: var(--mu-line); }
.mu-tier__btn { display: block; padding: 8px 0; border-radius: 99px; text-align: center; font-size: 0.78rem; font-weight: 600; box-shadow: inset 0 0 0 1px var(--mu-line); color: var(--mu-muted); }
.mu-tier__col--hi .mu-tier__btn { background: var(--mu-gold); color: var(--mu-bg); box-shadow: none; }
.mu-tier__col--hi::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 35%, rgba(228, 200, 135, 0.28) 50%, transparent 65%);
  transform: translateX(-130%);
  pointer-events: none;
  animation: mu-tier-sweep 8s var(--mu-ease-in-out) infinite;
}
.mu-tier__col--0 { animation: mu-tier-0 8s var(--mu-ease) infinite; }
.mu-tier__col--1 { animation: mu-tier-1 8s var(--mu-ease) infinite; }
.mu-tier__col--2 { animation: mu-tier-2 8s var(--mu-ease) infinite; }
${rise}
@keyframes mu-tier-sweep { 0%, 40% { transform: translateX(-130%); } 62%, 100% { transform: translateX(130%); } }
@media (max-width: 420px) { .mu-tier { height: 260px; gap: 8px; } .mu-tier__col { padding: 14px 10px 10px; } .mu-tier__name { font-size: 0.95rem; } }
@media (prefers-reduced-motion: reduce) {
  .mu-tier__col, .mu-tier__col--0, .mu-tier__col--1, .mu-tier__col--2 { animation: none; opacity: 1; transform: none; }
  .mu-tier__col--hi::after { animation: none; transform: translateX(-130%); }
}
${PAUSE_CSS}`,
  sampleCopy: true,
  init: WATCH_ONLY,
  tags: ["pricing", "plans", "tiers", "columns", "rise", "conversion", "highlight", "comparison"],
};
