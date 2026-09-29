/**
 * The M&U motion kit (W-F, 29 Sep 2026): ready-to-use web motion pieces in M&U black and gold, for client
 * and prospect sites. Each piece is plain HTML + CSS, with a few lines of DOM JS only where it needs them
 * (count-ups, a drag handle, a scroll trigger). Built in code: no paid generation.
 *
 * Framework-free like src/motion/engine: nothing here imports React, the router or a server module.
 */

export type KitCategory =
  | "Type"
  | "Brand"
  | "Video"
  | "Data"
  | "Showcase"
  | "Proof"
  | "Local"
  | "Conversion";

export interface KitPiece {
  /** kebab-case, equal to the file name in src/motion/kit/pieces, and the `data-mu-kit` value in its HTML. */
  id: string;
  name: string;
  /** One line for the card. */
  tagline: string;
  category: KitCategory;
  /** How it moves, in one or two sentences. */
  move: string;
  /** What happens with prefers-reduced-motion: reduce. Every piece has one. */
  reduced: string;
  /** Where to use it on a site (or in a video). */
  useFor: string;
  /** The markup. The root element carries data-mu-kit="<id>". */
  html: string;
  /** The styles, scoped under the piece's own class names. Must include a prefers-reduced-motion block. */
  css: string;
  /**
   * Optional DOM code: the BODY of `function init(root) { … }`, run once per root element. May return a
   * cleanup function. Plain JS that also type-checks when `root` is `any` (it becomes the React version).
   */
  init?: string;
  /** Preview only: replay every N ms so a play-once piece keeps showing its motion. */
  loopMs?: number;
  /** Preview only: how the piece sits in the preview frame. */
  stage?: "center" | "video";
  /** The copy in the preview is sample text (quotes, figures): replace it with sourced copy. */
  sampleCopy?: boolean;
  tags: string[];
}
