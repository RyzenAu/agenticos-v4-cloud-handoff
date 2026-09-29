// String similarity for speech-to-text slips ("spotfy", "whatsap", "vs cod"). This is the
// Ratcliff/Obershelp "gestalt" ratio, the same measure as Python's difflib.SequenceMatcher.ratio():
// 2 × matched characters ÷ total characters, where matches are found by repeatedly taking the
// longest common block and recursing either side. Our own implementation of the published
// algorithm; no code copied. Pure.

function longestBlock(a: string, b: string, aLo: number, aHi: number, bLo: number, bHi: number) {
  let bestI = aLo,
    bestJ = bLo,
    bestSize = 0;
  // lengths[j] = length of the common suffix ending at a[i-1], b[j-1].
  let previous = new Map<number, number>();
  for (let i = aLo; i < aHi; i++) {
    const current = new Map<number, number>();
    for (let j = bLo; j < bHi; j++) {
      if (a[i] !== b[j]) continue;
      const size = (previous.get(j - 1) ?? 0) + 1;
      current.set(j, size);
      if (size > bestSize) {
        bestI = i - size + 1;
        bestJ = j - size + 1;
        bestSize = size;
      }
    }
    previous = current;
  }
  return { i: bestI, j: bestJ, size: bestSize };
}

function matches(a: string, b: string, aLo: number, aHi: number, bLo: number, bHi: number): number {
  const block = longestBlock(a, b, aLo, aHi, bLo, bHi);
  if (!block.size) return 0;
  return (
    block.size +
    matches(a, b, aLo, block.i, bLo, block.j) +
    matches(a, b, block.i + block.size, aHi, block.j + block.size, bHi)
  );
}

/** 0–1; 1 means identical. Case-sensitive: normalise first. */
export function similarity(a: string, b: string) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  return (2 * matches(a, b, 0, a.length, 0, b.length)) / (a.length + b.length);
}

/** The single best candidate at or above the threshold, or null (also null on a tie between two). */
export function bestMatch<T>(query: string, items: T[], keys: (item: T) => string[], threshold = 0.8): T | null {
  let best: T | null = null,
    bestScore = 0,
    tie = false;
  for (const item of items) {
    const score = Math.max(0, ...keys(item).map((key) => similarity(query, key)));
    if (score > bestScore + 1e-9) {
      best = item;
      bestScore = score;
      tie = false;
    } else if (Math.abs(score - bestScore) < 1e-9 && score > 0 && item !== best) tie = true;
  }
  return bestScore >= threshold && !tie ? best : null;
}
