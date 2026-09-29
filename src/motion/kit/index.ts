/**
 * The M&U motion kit registry. Add a piece: create src/motion/kit/pieces/<id>.ts exporting `piece`
 * (see ./types.ts), import it here. Order here is the order on the Motion library's "M&U kit" tab.
 */
import { piece as kineticHeadline } from "./pieces/kinetic-headline";
import { piece as logoSting } from "./pieces/logo-sting";
import { piece as lowerThird } from "./pieces/lower-third";
import { piece as statRing } from "./pieces/stat-ring";
import { piece as devicePan } from "./pieces/device-pan";
import { piece as testimonialFlip } from "./pieces/testimonial-flip";
import { piece as mapPinDrop } from "./pieces/map-pin-drop";
import { piece as beforeAfter } from "./pieces/before-after";
import { piece as ctaPulse } from "./pieces/cta-pulse";
import { piece as proofMarquee } from "./pieces/proof-marquee";
import { piece as revealStagger } from "./pieces/reveal-stagger";
import type { KitPiece } from "./types";

export type { KitCategory, KitPiece } from "./types";
export { htmlSnippet, previewDoc, reactSnippet, hasReducedCss, MU_TOKENS } from "./snippet";

export const KIT: readonly KitPiece[] = [
  kineticHeadline,
  logoSting,
  statRing,
  ctaPulse,
  mapPinDrop,
  beforeAfter,
  testimonialFlip,
  devicePan,
  lowerThird,
  proofMarquee,
  revealStagger,
];

export function kitPieceById(id: string): KitPiece | undefined {
  return KIT.find((p) => p.id === id);
}

/** Search the kit the same way the wall is searched: name, tagline, category, move and tags. Pure. */
export function searchKit(query: string, pieces: readonly KitPiece[] = KIT): KitPiece[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...pieces];
  return pieces.filter((p) =>
    [p.name, p.tagline, p.category, p.move, p.useFor, ...p.tags]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}
