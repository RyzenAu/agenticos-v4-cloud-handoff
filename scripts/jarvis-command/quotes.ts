// Quoted text in his words, shared by the command rules (plan.ts) and the named-deck parser (jev-powerpoint.ts).
// Pure, no imports.

/**
 * Paired quotes only (REVIEW-T2 R3): "…" closes on ", “…” on ”, ‘…’ on ’, and '…' only on a ' that isn't
 * inside a word — so an apostrophe inside ("I'll call you back", "Usman's plan", 'don't forget') never cuts
 * the text short.
 */
export const QUOTED = /"([^"]{1,200})"|“([^”]{1,200})”|‘(.{1,200}?)’(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])'(.{1,200}?)'(?![\p{L}\p{N}])/gu;
/** The first quoted span: its text, where it starts and how long it is. Pure. */
export function findQuoted(text: string): { text: string; index: number; length: number } | null {
  const re = new RegExp(QUOTED.source, "u");
  const m = re.exec(text);
  if (!m) return null;
  const inner = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
  return inner ? { text: inner, index: m.index, length: m[0].length } : null;
}
