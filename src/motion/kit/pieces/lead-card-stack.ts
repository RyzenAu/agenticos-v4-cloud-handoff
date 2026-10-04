import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

// [bin column, row in that bin, title, detail]. Listed in the order they get dealt. Sample wording only.
const CARDS: [number, number, string, string][] = [
  [1, 0, "Visit enquiry", "Thu 10:30 am"],
  [0, 0, "Quote request", "Call back today"],
  [2, 0, "Parking question", "Message taken"],
  [1, 1, "Follow-up visit", "Fri 2:00 pm"],
  [0, 1, "Billing question", "Call back by 5"],
];
const BINS = ["Call back", "Booked", "Message"];
const card = ([c, r, t, d]: (typeof CARDS)[number], n: number) =>
  `<div class="mu-leads__card" data-n="${n}" style="--c:${c};--r:${r};--n:${n}"><b>${t}</b><small>${d}</small></div>`;
const bin = (name: string, c: number) =>
  `<div class="mu-leads__bin"><h4>${name}</h4>${CARDS.map((x, n) => ({ x, n }))
    .filter(({ x }) => x[0] === c)
    .sort((a, b) => a.x[1] - b.x[1])
    .map(({ x, n }) => card(x, n))
    .join("")}</div>`;

export const piece: KitPiece = {
  id: "lead-card-stack",
  name: "Lead card sort",
  tagline: "Enquiries deal out and sort into three trays",
  category: "Conversion",
  move: "A pile of enquiry cards sits above three trays. One at a time they fly out, turning slightly, and settle under Call back, Booked or Message. After a hold they gather back into the pile and deal again.",
  reduced: "The cards are already sorted into their three trays. Nothing flies.",
  useFor:
    "Lead-handling sections: what happens to every call. The cards are sample wording, not real enquiries: replace them with the client's own categories.",
  html: `
<div class="mu-leads" data-mu-kit="lead-card-stack">
  <p class="mu-leads__deckl">Incoming calls</p>
  <div class="mu-leads__deck"></div>
  <div class="mu-leads__bins">${BINS.map(bin).join("")}</div>
  <p class="mu-leads__sample">Sample cards · illustration</p>
</div>`,
  css: `
${rootRule(
  ".mu-leads",
  `  width: min(100%, 520px);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-leads__deckl { margin: 0 0 8px; text-align: center; font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--mu-muted); }
.mu-leads__deck { height: 58px; margin-bottom: 14px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--mu-line); }
.mu-leads__bins { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.mu-leads__bins > * { min-width: 0; }
.mu-leads__card { min-width: 0; overflow: hidden; }
.mu-leads__bin { display: flex; flex-direction: column; gap: 8px; min-height: 148px; padding: 0 0 8px; }
.mu-leads__sample { margin: 6px 0 0; text-align: center; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--mu-muted); opacity: 0.8; }
.mu-leads__bin h4 { order: 2; margin: auto 0 0; height: 28px; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mu-gold); border-top: 1px solid var(--mu-line); display: flex; align-items: center; }
.mu-leads__card {
  height: 54px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; gap: 3px;
  padding: 0 11px; border-radius: 12px; overflow: hidden; white-space: nowrap;
  background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line), 0 6px 14px rgba(0, 0, 0, 0.35);
  position: relative;
}
.mu-leads__card b { font-size: 0.8rem; font-weight: 600; text-overflow: ellipsis; overflow: hidden; }
.mu-leads__card small { font-size: 0.7rem; color: var(--mu-muted); text-overflow: ellipsis; overflow: hidden; }
.mu-leads__card::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 0 3px 3px 0; background: var(--mu-gold); }
.mu-leads[data-armed] .mu-leads__card {
  transition: transform 0.75s var(--mu-ease), box-shadow 0.75s var(--mu-ease);
  z-index: calc(10 - var(--n));
}
.mu-leads[data-armed] .mu-leads__card:not([data-on]) {
  transform: translate(calc((1 - var(--c)) * (100% + 10px)), calc(-1 * (70px + var(--r) * 62px))) rotate(calc((var(--n) - 2) * 2.5deg));
  box-shadow: 0 0 0 1px var(--mu-line), 0 2px 6px rgba(0, 0, 0, 0.5);
}
@media (max-width: 480px) {
  .mu-leads__card { padding: 0 8px 0 10px; }
  .mu-leads__card b { font-size: 0.7rem; }
  .mu-leads__card small { font-size: 0.62rem; }
  .mu-leads__bin h4 { font-size: 0.68rem; }
}
@media (prefers-reduced-motion: reduce) {
  .mu-leads[data-armed] .mu-leads__card,
  .mu-leads[data-armed] .mu-leads__card:not([data-on]) { transform: none; transition: none; }
}
${PAUSE_CSS}`,
  init: IN_VIEW + `
const cards = Array.from(root.querySelectorAll(".mu-leads__card")).sort((a, b) => Number(a.getAttribute("data-n")) - Number(b.getAttribute("data-n")));
if (!cards.length) return;
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
root.setAttribute("data-armed", "");
const events = cards.map((c, i) => [900 + i * 650, () => c.setAttribute("data-on", "")]);
const seq = muSeq(() => cards.forEach((c) => c.removeAttribute("data-on")), events, 900 + cards.length * 650 + 3000);
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
  tags: ["leads", "cards", "sort", "triage", "call back", "booked", "message", "conversion"],
};
