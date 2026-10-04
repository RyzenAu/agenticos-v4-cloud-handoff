import { rootRule } from "../snippet";
import { IN_VIEW, PAUSE_CSS, WATCH_ONLY } from "../in-view";
import type { KitPiece } from "../types";

export const piece: KitPiece = {
  id: "gold-foil-wordmark",
  name: "Gold foil wordmark",
  tagline: "M&U set in gold foil with a light sweep",
  category: "Brand",
  move: "The M&U letters carry a slow gold foil gradient and a narrow bright band glides across them left to right every 5.5 s, with a soft gold glow. A thin rule and VENTURES sit beneath.",
  reduced: "The foil is still, lit from the middle: no sweep and no drift.",
  useFor:
    "Site footers, a closing frame on a film, or a loading hold. It is typeset text in the kit's display font, not a logo file: swap in the real artwork if it exists.",
  html: `
<div class="mu-foil" data-mu-kit="gold-foil-wordmark" role="img" aria-label="M&amp;U Ventures">
  <span class="mu-foil__mark" aria-hidden="true">M&amp;U</span>
  <span class="mu-foil__rule" aria-hidden="true"></span>
  <span class="mu-foil__sub" aria-hidden="true">Ventures</span>
</div>`,
  css: `
${rootRule(
  ".mu-foil",
  `  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-family: var(--mu-display);`,
)}
.mu-foil__mark {
  font-size: clamp(4rem, 20vw, 8rem);
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.03em;
  color: var(--mu-gold);
  background-image:
    linear-gradient(105deg, transparent 38%, rgba(243, 239, 230, 0.95) 50%, transparent 62%),
    linear-gradient(100deg, color-mix(in srgb, var(--mu-gold) 55%, var(--mu-bg)) 0%, var(--mu-gold) 22%, var(--mu-gold-hi) 38%, var(--mu-gold) 55%, color-mix(in srgb, var(--mu-gold) 60%, var(--mu-bg)) 78%, var(--mu-gold-hi) 100%);
  background-size: 300% 100%, 200% 100%;
  background-repeat: no-repeat;
  background-position: 0% 0, 40% 0;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 6px 26px rgba(199, 163, 90, 0.22));
  animation: mu-foil-sweep 5.5s var(--mu-ease-in-out) infinite;
}
.mu-foil__rule { width: 42%; height: 1px; background: linear-gradient(90deg, transparent, var(--mu-gold), transparent); }
.mu-foil__sub { font-family: var(--mu-sans); font-size: clamp(0.75rem, 3vw, 1rem); letter-spacing: 0.55em; padding-left: 0.55em; text-transform: uppercase; color: var(--mu-muted); }
@keyframes mu-foil-sweep {
  0% { background-position: 0% 0, 40% 0; }
  40% { background-position: 100% 0, 50% 0; }
  50% { background-position: 100% 0, 60% 0; }
  100% { background-position: 100% 0, 40% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .mu-foil__mark { animation: none; background-position: 50% 0, 50% 0; }
}
${PAUSE_CSS}`,
  init: WATCH_ONLY,
  tags: ["wordmark", "logo", "gold", "foil", "shimmer", "brand", "sting", "footer"],
};
