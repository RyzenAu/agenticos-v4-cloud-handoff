/**
 * Local, network-free text utilities and the local index the connector falls back to when
 * Hindsight is off or down: BM25 over term frequencies plus hashed-term vectors (feature
 * hashing, NOT a neural embedding — no model, no network). Built in memory from the
 * connector's desired documents, so it always obeys tombstones and exclusions.
 */
import { createHash } from "node:crypto";
import type { IndexDoc } from "./types";

export const VECTOR_DIM = 256;

const STOP = new Set(
  "a an and are as at be but by for from has have i in is it its of on or our so that the their them they this to was we were what when where which who will with you your about into than then there these those do does did can could should would just also not no yes me my us".split(" "),
);

/** Lowercase word/number tokens, light plural folding, stopwords dropped. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) || []) {
    if (STOP.has(raw) || raw.length < 2) continue;
    out.push(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** sha256 of normalised text (case and whitespace folded). */
export function contentHash(text: string) {
  return createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

export function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function hashIndex(token: string) {
  const h = createHash("md5").update(token).digest();
  return { idx: h.readUInt16LE(0) % VECTOR_DIM, sign: h[2] & 1 ? 1 : -1 };
}

/** Sparse unit vector over unigrams and bigrams: [index, weight][]. */
export function hashedVector(text: string): [number, number][] {
  const tokens = tokenize(text);
  const acc = new Map<number, number>();
  const add = (t: string, w: number) => {
    const { idx, sign } = hashIndex(t);
    acc.set(idx, (acc.get(idx) ?? 0) + sign * w);
  };
  tokens.forEach((t, i) => {
    add(t, 1);
    if (i > 0) add(tokens[i - 1] + " " + t, 0.5);
  });
  const norm = Math.sqrt([...acc.values()].reduce((s, v) => s + v * v, 0)) || 1;
  return [...acc.entries()].filter(([, v]) => v !== 0).map(([i, v]) => [i, v / norm]);
}

export function cosine(a: [number, number][], b: [number, number][]) {
  const m = new Map(a);
  let dot = 0;
  for (const [i, v] of b) dot += (m.get(i) ?? 0) * v;
  return dot;
}

function jaccard(a: string[], b: string[]) {
  const A = new Set(a),
    B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Likely the same subject stated differently (e.g. a price changed). */
export function likelyConflict(a: string, b: string) {
  return contentHash(a) !== contentHash(b) && jaccard(tokenize(a), tokenize(b)) >= 0.5;
}

export type LocalHit = { doc: IndexDoc; score: number };

/** Rank documents for a query. Facts and memories outrank whole notes at equal relevance. */
export function searchDocs(docs: IndexDoc[], query: string, limit = 10): LocalHit[] {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !docs.length) return [];
  const prepared = docs.map((doc) => {
    const tokens = tokenize(`${doc.title}\n${doc.content}`);
    const tf: Record<string, number> = {};
    for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
    return { doc, tf, len: tokens.length };
  });
  const N = prepared.length;
  const avgLen = prepared.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of prepared) for (const t of Object.keys(d.tf)) df.set(t, (df.get(t) ?? 0) + 1);
  const qVec = hashedVector(query);
  const hits: LocalHit[] = [];
  for (const d of prepared) {
    let bm25 = 0;
    for (const t of qTokens) {
      const tf = d.tf[t];
      if (!tf) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      bm25 += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.len / avgLen)));
    }
    const cos = cosine(qVec, hashedVector(`${d.doc.title}\n${d.doc.content.slice(0, 4000)}`));
    if (bm25 <= 0 && cos < 0.35) continue;
    const score = (bm25 + 3 * Math.max(0, cos)) * (d.doc.kind === "note" ? 1 : 1.25);
    hits.push({ doc: d.doc, score: Math.round(score * 1000) / 1000 });
  }
  hits.sort((a, b) => b.score - a.score);
  // Weak tail matches (one common word) are noise next to a strong hit.
  const floor = (hits[0]?.score ?? 0) * 0.25;
  return hits.filter((h) => h.score >= floor).slice(0, limit);
}

/** The paragraph of a body that best matches the query, trimmed for display. */
export function excerpt(body: string, query: string, max = 280) {
  const qTokens = new Set(tokenize(query));
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p && !p.startsWith("---") && !/^#+\s/.test(p));
  let best = paras[0] ?? body.slice(0, max),
    bestScore = -1;
  for (const p of paras) {
    const s = tokenize(p).filter((t) => qTokens.has(t)).length;
    if (s > bestScore) (best = p), (bestScore = s);
  }
  return best.length > max ? best.slice(0, max - 3) + "…" : best;
}
