import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const TIMES = ["9", "10", "11", "1", "2", "3"];
// Which slots fill, in the order they land (sample pattern: day index, time index).
const FILLS: [number, number][] = [
  [0, 1], [2, 0], [1, 3], [3, 2], [0, 4], [4, 1], [2, 5], [3, 0], [1, 1], [4, 4], [2, 3], [0, 2],
];
const order = new Map(FILLS.map(([d, t], n) => [d * 10 + t, n]));
const cells = TIMES.map((t, ti) =>
  [
    `<span class="mu-cal__time">${t}</span>`,
    ...DAYS.map((_, di) => {
      const n = order.get(di * 10 + ti);
      return n === undefined
        ? `<span class="mu-cal__slot"></span>`
        : `<span class="mu-cal__slot mu-cal__slot--b" data-n="${n}"></span>`;
    }),
  ].join(""),
).join("");

export const piece: KitPiece = {
  id: "calendar-slot-fill",
  name: "Calendar slot fill",
  tagline: "A week grid fills with gold as bookings land",
  category: "Data",
  move: "Empty slots in a Monday to Friday grid fill with gold one at a time, about every third of a second, while the counter ticks up. After a hold the week clears and fills again.",
  reduced: "The week is shown already filled, with the final count. Nothing animates.",
  useFor:
    "The 'books straight into your calendar' section, or a scheduling beat in a film. The pattern is sample: it is a picture of the idea, not real booking data.",
  html: `
<figure class="mu-cal" data-mu-kit="calendar-slot-fill">
  <div class="mu-cal__head"><span>This week</span><span class="mu-cal__count"><b class="mu-cal__n">12</b> booked</span></div>
  <div class="mu-cal__grid" aria-hidden="true">
    <span></span>${DAYS.map((d) => `<span class="mu-cal__day">${d}</span>`).join("")}
    ${cells}
  </div>
  <figcaption class="mu-cal__cap">Sample figures · illustration</figcaption>
</figure>`,
  css: `
${rootRule(
  ".mu-cal",
  `  margin: 0;
  width: min(100%, 420px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border-radius: 20px;
  background: linear-gradient(180deg, var(--mu-raised), var(--mu-surface));
  box-shadow: 0 0 0 1px var(--mu-line);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-cal__head { display: flex; justify-content: space-between; align-items: baseline; font-family: var(--mu-display); font-size: 1.1rem; }
.mu-cal__count { font-family: var(--mu-sans); font-size: 0.85rem; color: var(--mu-muted); }
.mu-cal__n { color: var(--mu-gold); font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.mu-cal__grid { display: grid; grid-template-columns: 22px repeat(5, 1fr); gap: 6px; align-items: center; }
.mu-cal__day { text-align: center; font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mu-muted); }
.mu-cal__time { font-size: 0.7rem; color: var(--mu-muted); font-variant-numeric: tabular-nums; }
.mu-cal__slot { height: 28px; border-radius: 8px; background: var(--mu-bg); box-shadow: inset 0 0 0 1px var(--mu-line); }
.mu-cal__slot--b { background: linear-gradient(180deg, var(--mu-gold-hi), var(--mu-gold)); box-shadow: none; }
.mu-cal[data-armed] .mu-cal__slot--b:not([data-on]) { background: var(--mu-bg); box-shadow: inset 0 0 0 1px var(--mu-line); transform: scale(0.94); }
.mu-cal[data-armed] .mu-cal__slot--b { transition: background 0.45s var(--mu-ease), box-shadow 0.45s var(--mu-ease), transform 0.45s var(--mu-ease); }
.mu-cal__cap { font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--mu-muted); opacity: 0.7; }
@media (prefers-reduced-motion: reduce) {
  .mu-cal[data-armed] .mu-cal__slot--b,
  .mu-cal[data-armed] .mu-cal__slot--b:not([data-on]) { background: linear-gradient(180deg, var(--mu-gold-hi), var(--mu-gold)); box-shadow: none; transform: none; transition: none; }
}
${PAUSE_CSS}`,
  init: IN_VIEW + `
const slots = Array.from(root.querySelectorAll(".mu-cal__slot--b"));
const count = root.querySelector(".mu-cal__n");
if (!slots.length) return;
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
root.setAttribute("data-armed", "");
const sorted = slots.slice().sort((a, b) => Number(a.getAttribute("data-n")) - Number(b.getAttribute("data-n")));
const events = sorted.map((s, i) => [700 + i * 340, () => {
  s.setAttribute("data-on", "");
  if (count) count.textContent = String(i + 1);
}]);
const seq = muSeq(() => {
  sorted.forEach((s) => s.removeAttribute("data-on"));
  if (count) count.textContent = "0";
}, events, 700 + sorted.length * 340 + 2600);
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
  tags: ["calendar", "booking", "slots", "week", "schedule", "grid", "appointments", "data"],
};
