import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

const HIDE = "opacity: 0; transform: translateY(10px) scale(0.96);";
const SHOW = "opacity: 1; transform: none;";
/** A bubble that arrives at `a`%, holds to 92%, then clears for the next lap of the 12 s loop. */
const pop = (name: string, a: number) =>
  `@keyframes ${name} { 0%, ${a}% { ${HIDE} } ${a + 3}%, 92% { ${SHOW} } 97%, 100% { ${HIDE} } }`;
/** The typing dots: shown between `a`% and `b`%. */
const typing = (name: string, a: number, b: number) =>
  `@keyframes ${name} { 0%, ${a - 1}% { opacity: 0; } ${a + 1}%, ${b - 1}% { opacity: 1; } ${b}%, 100% { opacity: 0; } }`;

export const piece: KitPiece = {
  id: "sms-thread",
  name: "SMS confirmation thread",
  tagline: "A booking text types in, then the calendar ticks",
  category: "Conversion",
  move: "Typing dots pulse, the confirmation text lands, a short reply comes back, a second text follows, and a gold tick draws on an Added to calendar chip. It clears and replays every 12 s.",
  reduced:
    "No typing dots or arrivals: the whole thread and the ticked calendar chip are shown at once.",
  useFor:
    "The 'every booking gets a text' beat on a receptionist page, or a phone-frame scene in a film. All wording is sample copy: swap in the client's real confirmation template.",
  html: `
<div class="mu-sms" data-mu-kit="sms-thread">
  <div class="mu-sms__bar"><span class="mu-sms__who">Sample Dental</span><span class="mu-sms__sub">Sample message · illustration</span></div>
  <div class="mu-sms__thread">
    <div class="mu-sms__slot mu-sms__slot--in">
      <span class="mu-sms__typing mu-sms__typing--1" aria-hidden="true"><i></i><i></i><i></i></span>
      <p class="mu-sms__msg mu-sms__msg--in mu-sms__b1">Hi, this is the front desk at Sample Dental. Your visit is booked for Thursday at 10:30 am.</p>
    </div>
    <div class="mu-sms__slot mu-sms__slot--out">
      <p class="mu-sms__msg mu-sms__msg--out mu-sms__b2">Perfect, thanks.</p>
    </div>
    <div class="mu-sms__slot mu-sms__slot--in">
      <span class="mu-sms__typing mu-sms__typing--3" aria-hidden="true"><i></i><i></i><i></i></span>
      <p class="mu-sms__msg mu-sms__msg--in mu-sms__b3">You're all set. Reply C if you need to change it.</p>
    </div>
  </div>
  <div class="mu-sms__cal">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" /><path d="M7 12.5l3.6 3.6L17.5 8.8" /></svg>
    <span>Thu 10:30 am · added to calendar</span>
  </div>
</div>`,
  css: `
${rootRule(
  ".mu-sms",
  `  width: min(100%, 320px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 14px 16px;
  border-radius: 28px;
  background: var(--mu-surface);
  box-shadow: 0 0 0 1px var(--mu-line), 0 24px 48px rgba(0, 0, 0, 0.5);
  color: var(--mu-ink);
  font-family: var(--mu-sans);`,
)}
.mu-sms__bar { display: flex; flex-direction: column; align-items: center; padding: 6px 0 10px; border-bottom: 1px solid var(--mu-line); }
.mu-sms__who { font-weight: 600; font-size: 0.95rem; }
.mu-sms__sub { font-size: 0.7rem; color: var(--mu-muted); letter-spacing: 0.04em; }
.mu-sms__thread { display: flex; flex-direction: column; gap: 8px; }
.mu-sms__slot { display: grid; }
.mu-sms__slot > * { grid-area: 1 / 1; }
.mu-sms__slot--out { justify-items: end; }
.mu-sms__msg { margin: 0; max-width: 84%; padding: 9px 13px; border-radius: 18px; font-size: 0.86rem; line-height: 1.4; }
.mu-sms__msg--in { justify-self: start; border-bottom-left-radius: 6px; background: var(--mu-raised); box-shadow: inset 0 0 0 1px var(--mu-line); }
.mu-sms__msg--out { border-bottom-right-radius: 6px; background: var(--mu-gold); color: var(--mu-bg); font-weight: 500; }
.mu-sms__typing { align-self: start; justify-self: start; display: inline-flex; gap: 4px; padding: 13px 14px; border-radius: 18px; border-bottom-left-radius: 6px; background: var(--mu-raised); opacity: 0; }
.mu-sms__typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--mu-muted); animation: mu-sms-dot 0.9s ease-in-out infinite; }
.mu-sms__typing i:nth-child(2) { animation-delay: 0.15s; }
.mu-sms__typing i:nth-child(3) { animation-delay: 0.3s; }
.mu-sms__cal { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--mu-gold); font-size: 0.82rem; color: var(--mu-gold-hi); }
.mu-sms__cal svg { flex: none; width: 22px; height: 22px; fill: none; stroke: var(--mu-gold); stroke-width: 1.6; }
.mu-sms__cal path { stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 20; stroke-dashoffset: 0; }
.mu-sms__b1 { animation: mu-sms-b1 12s var(--mu-ease) infinite; }
.mu-sms__b2 { animation: mu-sms-b2 12s var(--mu-ease) infinite; }
.mu-sms__b3 { animation: mu-sms-b3 12s var(--mu-ease) infinite; }
.mu-sms__typing--1 { animation: mu-sms-t1 12s linear infinite; }
.mu-sms__typing--3 { animation: mu-sms-t3 12s linear infinite; }
.mu-sms__cal { animation: mu-sms-cal 12s var(--mu-ease) infinite; }
.mu-sms__cal path { animation: mu-sms-tick 12s ease-out infinite; }
${pop("mu-sms-b1", 11)}
${pop("mu-sms-b2", 31)}
${pop("mu-sms-b3", 51)}
${typing("mu-sms-t1", 4, 10)}
${typing("mu-sms-t3", 39, 50)}
${pop("mu-sms-cal", 67)}
@keyframes mu-sms-tick { 0%, 72% { stroke-dashoffset: 20; } 80%, 92% { stroke-dashoffset: 0; } 97%, 100% { stroke-dashoffset: 20; } }
@keyframes mu-sms-dot { 0%, 100% { transform: translateY(0); opacity: 0.5; } 50% { transform: translateY(-3px); opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .mu-sms__msg, .mu-sms__cal, .mu-sms__cal path { animation: none; opacity: 1; transform: none; }
  .mu-sms__cal path { stroke-dashoffset: 0; }
  .mu-sms__typing { animation: none; display: none; }
}
${PAUSE_CSS}`,
  sampleCopy: true,
  init: WATCH_ONLY,
  tags: ["sms", "text", "confirmation", "booking", "phone", "calendar", "conversion", "receptionist"],
};
