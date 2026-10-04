import { rootRule } from "../snippet";
import type { KitPiece } from "../types";

/** A drawn page (hero, cards, a band) so the preview needs no image. Real use: an <img> of the full page. */
const PAGE = `<span class="mu-device__hero"><span class="mu-device__kicker"></span><span class="mu-device__h1"></span><span class="mu-device__h1 mu-device__h1--short"></span><span class="mu-device__btn"></span></span><span class="mu-device__photo"></span><span class="mu-device__cards"><span></span><span></span><span></span></span><span class="mu-device__band"></span><span class="mu-device__cards"><span></span><span></span><span></span></span><span class="mu-device__foot"></span>`;

export const piece: KitPiece = {
  id: "device-pan",
  name: "Device mockup pan",
  tagline: "A laptop and phone scroll the site, slowly",
  category: "Showcase",
  move: "Both screens pan down the full page and back over 16 s (ease in-out), the phone half a beat behind the laptop. Hovering tilts the pair a few degrees towards you.",
  reduced: "The screens show the top of the page, still; no pan and no tilt.",
  useFor:
    'Case studies and proposals: show a client\'s new site on both screens. Replace .mu-device__page contents with <img src="full-page.png" alt="…">.',
  html: `
<div class="mu-device" data-mu-kit="device-pan" role="img" aria-label="The new site on a laptop and a phone">
  <div class="mu-device__laptop">
    <div class="mu-device__screen"><div class="mu-device__page">${PAGE}</div></div>
    <div class="mu-device__base"></div>
  </div>
  <div class="mu-device__phone">
    <div class="mu-device__screen"><div class="mu-device__page mu-device__page--phone">${PAGE}</div></div>
  </div>
</div>`,
  css: `
${rootRule(
  ".mu-device",
  `  position: relative;
  width: min(100%, 560px);
  aspect-ratio: 16 / 10;
  perspective: 1400px;`,
)}
.mu-device__laptop {
  position: absolute;
  left: 0;
  top: 4%;
  width: 84%;
  transform: rotateY(-7deg) rotateX(3deg);
  transform-origin: 60% 50%;
  transition: transform 0.9s var(--mu-ease);
}
.mu-device__laptop .mu-device__screen {
  aspect-ratio: 16 / 10;
  border: 7px solid #1d1c1a;
  border-radius: 12px 12px 4px 4px;
  box-shadow: 0 30px 60px -30px rgba(0, 0, 0, 0.9), 0 0 0 1px var(--mu-line);
}
.mu-device__base {
  height: 12px;
  margin: 0 -6%;
  border-radius: 0 0 14px 14px;
  background: linear-gradient(180deg, #2a2926, #121110);
  box-shadow: 0 18px 30px -18px rgba(0, 0, 0, 0.9);
}
.mu-device__phone {
  position: absolute;
  right: 2%;
  bottom: 2%;
  width: 24%;
  transform: rotateY(-7deg) rotateX(3deg) translateZ(40px);
  transition: transform 0.9s var(--mu-ease);
}
.mu-device__phone .mu-device__screen {
  aspect-ratio: 9 / 19.5;
  border: 5px solid #1d1c1a;
  border-radius: 20px;
  box-shadow: 0 26px 50px -20px rgba(0, 0, 0, 0.95), 0 0 0 1px var(--mu-line);
}
.mu-device:hover .mu-device__laptop { transform: rotateY(-2deg) rotateX(1deg); }
.mu-device:hover .mu-device__phone { transform: rotateY(-2deg) rotateX(1deg) translateZ(60px); }
.mu-device__screen {
  position: relative;
  overflow: hidden;
  background: var(--mu-bg);
  container-type: size;
}
.mu-device__page {
  display: flex;
  flex-direction: column;
  gap: 5cqw;
  padding: 5cqw;
  animation: mu-device-pan 16s var(--mu-ease-in-out) infinite alternate;
}
.mu-device__page--phone { animation-delay: -1.2s; gap: 7cqw; padding: 7cqw; }
.mu-device__page > * { display: block; flex: none; }
.mu-device__page img { display: block; width: 100%; height: auto; }
.mu-device__hero { display: flex; flex-direction: column; gap: 2.4cqw; padding-top: 4cqw; }
.mu-device__kicker { width: 22%; height: 1.6cqw; border-radius: 99px; background: var(--mu-gold); }
.mu-device__h1 { width: 78%; height: 6cqw; border-radius: 6px; background: var(--mu-ink); opacity: 0.92; }
.mu-device__h1--short { width: 52%; }
.mu-device__btn { width: 24%; height: 5.2cqw; margin-top: 2cqw; border-radius: 99px; background: var(--mu-gold); }
.mu-device__photo { height: 44cqw; border-radius: 10px; background: radial-gradient(90% 80% at 30% 30%, #4a3d27, #1a1712 70%); }
.mu-device__cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3cqw; }
.mu-device__page--phone .mu-device__cards { grid-template-columns: 1fr; }
.mu-device__cards span { height: 22cqw; border-radius: 8px; background: var(--mu-raised); box-shadow: inset 0 0 0 1px var(--mu-line); }
.mu-device__band { height: 16cqw; border-radius: 10px; background: linear-gradient(90deg, var(--mu-gold), #8c6f33); opacity: 0.9; }
.mu-device__foot { height: 26cqw; border-radius: 8px; background: #0f0e0d; box-shadow: inset 0 0 0 1px var(--mu-line); }
@keyframes mu-device-pan {
  0%, 8% { transform: translateY(0); }
  92%, 100% { transform: translateY(calc(-100% + 100cqh)); }
}
@media (prefers-reduced-motion: reduce) {
  .mu-device__page { animation: none; }
  .mu-device__laptop, .mu-device__phone { transition: none; }
  .mu-device:hover .mu-device__laptop { transform: rotateY(-7deg) rotateX(3deg); }
  .mu-device:hover .mu-device__phone { transform: rotateY(-7deg) rotateX(3deg) translateZ(40px); }
}`,
  tags: [
    "device",
    "mockup",
    "laptop",
    "phone",
    "case study",
    "showcase",
    "scroll",
    "pan",
    "portfolio",
  ],
};
