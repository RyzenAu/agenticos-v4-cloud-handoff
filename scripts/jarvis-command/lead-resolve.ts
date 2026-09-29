/**
 * Which CRM lead did he mean? (F1 flow 3, 29 Sep 2026.) Pure over an injected leads API, so the live server and
 * the tests share it. Three ways in, in order of how sure the words are:
 *
 *   description  "the dentist in Parramatta", "that physio at Blacktown", "the Parramatta dentist":
 *                a vertical word plus a place, matched against the leads' vertical and area.
 *   search       the CRM's own search on the words as said (one exact title, or one hit).
 *   fuzzy        nothing came back: near-misses ("Harbor Dental" for Harbour Dental, a dropped "Pty Ltd", a
 *                mis-heard letter) scored over the whole lead list.
 *
 * One clear winner is acted on (and the reply says which lead it was, and how it was matched, when that was
 * not his exact words). Two or three close ones are asked about, by name and suburb, in one short question.
 * Never a guess between close candidates, never a lead that isn't in the CRM.
 */

export type LeadsApiLike = { handle(path: string, method: string, body: unknown, params: URLSearchParams, remote: boolean): Promise<unknown> };

export type LeadRef = { id: number; name: string; area: string | null; vertical: string | null; status: string | null };
export type Resolved =
  | { kind: "one"; lead: LeadRef; how: "exact" | "search" | "fuzzy" | "description" }
  | { kind: "many"; options: LeadRef[] }
  | { kind: "none" };

const q = (o: Record<string, string>) => new URLSearchParams(o);

const VERTICAL_WORDS: Array<[RegExp, string]> = [
  [/\b(?:dentists?|dental|dentistry|orthodontists?)\b/i, "dental"],
  [/\b(?:real[- ]?estate(?: agents?| agency| agencies)?|realtors?|property agents?|estate agents?)\b/i, "real-estate"],
  [/\b(?:lawyers?|solicitors?|conveyancers?|law firms?|legal)\b/i, "legal"],
];
const verticalIn = (text: string): string | null => VERTICAL_WORDS.find(([re]) => re.test(text))?.[1] ?? null;

/** "the dentist in Parramatta" → { vertical: "dental", place: "parramatta" }; null when it isn't that shape. */
export function describedLead(spoken: string): { vertical: string; place: string } | null {
  const t = spoken.trim().replace(/[.!?]+$/, "").replace(/^(?:the|that|this|my|our|a|an)\s+/i, "");
  const inPlace = /^(.{3,40}?)\s+(?:in|at|near|from|over in|out at|around|up in)\s+([a-z][a-z' -]{2,40})$/i.exec(t);
  if (inPlace) {
    const vertical = verticalIn(inPlace[1]);
    // "Harbour Dental in Parramatta" names a business; "the dentist in Parramatta" doesn't: only a bare
    // role word (dentist, physio-type, agent, lawyer) is a description.
    if (vertical && /^(?:the |that |our |my )?(?:local )?(?:dentists?|dental (?:clinic|practice|surgery)|orthodontists?|real[- ]?estate (?:agents?|agency)|estate agents?|property agents?|realtors?|lawyers?|solicitors?|conveyancers?|law firms?)$/i.test(inPlace[1].trim()))
      return { vertical, place: inPlace[2].trim().toLowerCase() };
  }
  const placeFirst = /^([a-z][a-z' -]{2,40}?)\s+(?:dentists?|dental (?:clinic|practice)|real[- ]?estate agents?|estate agents?|lawyers?|solicitors?|conveyancers?)$/i.exec(t);
  if (placeFirst) {
    const vertical = verticalIn(t);
    if (vertical) return { vertical, place: placeFirst[1].trim().toLowerCase() };
  }
  return null;
}

// ─────────────────────────── fuzzy names ───────────────────────────

const STOP = new Set(["the", "a", "an", "and", "pty", "ltd", "limited", "p/l", "inc", "co", "company"]);
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}
function lev(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
const tokenSim = (a: string, b: string) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length, 1));

/** How well `spoken` names `name`, 0..1. Every spoken word must find a near match in the name. */
export function nameScore(spoken: string, name: string): number {
  const s = tokens(spoken);
  const n = tokens(name);
  if (!s.length || !n.length) return 0;
  const used = new Set<number>();
  let matched = 0;
  let simSum = 0;
  for (const word of s) {
    let best = -1;
    let bestSim = 0;
    n.forEach((other, i) => {
      if (used.has(i)) return;
      // A short word must match exactly (dental / dentist are different words); longer ones tolerate a slip.
      const sim = tokenSim(word, other);
      const ok = word.length <= 4 || other.length <= 4 ? sim === 1 : sim >= 0.78;
      if (ok && sim > bestSim) { best = i; bestSim = sim; }
    });
    if (best >= 0) { used.add(best); matched++; simSum += bestSim; }
  }
  // Every spoken word has to find its word in the name; a name with more words than he said scores a little lower.
  if (matched < s.length) return (matched / s.length) * 0.6;
  return 0.55 + 0.25 * (simSum / s.length) + 0.2 * (matched / n.length);
}

// ─────────────────────────── the resolver ───────────────────────────

const refOf = (row: Record<string, unknown>): LeadRef => ({
  id: Number(row.id ?? row.leadId),
  name: String(row.name ?? row.title ?? `Lead #${row.id ?? row.leadId}`),
  area: typeof row.area === "string" && row.area ? row.area : null,
  vertical: typeof row.vertical === "string" && row.vertical ? row.vertical : null,
  status: typeof row.status === "string" && row.status ? row.status : null,
});

async function allLeads(api: LeadsApiLike, extra: Record<string, string> = {}): Promise<LeadRef[]> {
  const r = (await api.handle("/leads/list", "GET", {}, q({ all: "1", ...extra }), false)) as { leads?: Array<Record<string, unknown>> };
  return (r.leads ?? []).filter((l) => Number.isFinite(Number(l.id))).map(refOf);
}

const areaScore = (area: string | null, place: string) => (area ? Math.max(...tokens(area).map((a) => Math.max(...tokens(place).map((p) => tokenSim(a, p)), 0)), 0) : 0);

export async function resolveLead(api: LeadsApiLike, spoken: string): Promise<Resolved> {
  const words = spoken.trim().replace(/^(?:the|that|my|our)\s+lead\s+(?:called|named)?\s*/i, "").replace(/[.!?]+$/, "").trim();
  if (!words) return { kind: "none" };

  // 1. "the dentist in Parramatta": a vertical and a place.
  const described = describedLead(words);
  if (described) {
    const rows = await allLeads(api, { vertical: described.vertical });
    const scored = rows.map((l) => ({ l, s: areaScore(l.area, described.place) })).filter((x) => x.s >= 0.8);
    // Prefer leads still in play: a lead he has already won, lost or told to go away is rarely the one meant.
    const live = scored.filter((x) => !["won", "lost", "not_interested", "do_not_contact"].includes(x.l.status ?? ""));
    const pool = (live.length ? live : scored).sort((a, b) => b.s - a.s);
    if (pool.length === 1) return { kind: "one", lead: pool[0].l, how: "description" };
    if (pool.length > 1) return { kind: "many", options: pool.slice(0, 3).map((x) => x.l) };
    return { kind: "none" };
  }

  // 2. The CRM's own search on his words.
  const found = (await api.handle("/leads/search", "GET", {}, q({ q: words }), false)) as { hits?: Array<{ group: string; leadId: number; title: string; detail?: string }> };
  const hits = [...new Map((found.hits ?? []).filter((h) => h.group === "leads").map((h) => [h.leadId, h])).values()];
  const asRef = (h: { leadId: number; title: string; detail?: string }): LeadRef => ({ id: h.leadId, name: h.title, area: h.detail ? h.detail.split(" · ")[0] || null : null, vertical: null, status: null });
  const exact = hits.filter((h) => h.title.trim().toLowerCase() === words.toLowerCase());
  if (exact.length === 1) return { kind: "one", lead: asRef(exact[0]), how: "exact" };
  if (hits.length === 1) return { kind: "one", lead: asRef(hits[0]), how: "search" };
  if (hits.length > 1) return { kind: "many", options: hits.slice(0, 3).map(asRef) };

  // 3. Nothing matched his exact words: near-misses over the whole list.
  const rows = await allLeads(api);
  const scored = rows.map((l) => ({ l, s: nameScore(words, l.name) })).filter((x) => x.s >= 0.75).sort((a, b) => b.s - a.s);
  if (!scored.length) return { kind: "none" };
  const [best, next] = scored;
  if (!next || best.s - next.s >= 0.12) return { kind: "one", lead: best.l, how: "fuzzy" };
  return { kind: "many", options: scored.filter((x) => best.s - x.s < 0.12).slice(0, 3).map((x) => x.l) };
}

/** "Harbour Dental (Parramatta)" — the name, and the suburb when the CRM has it. */
export const leadLabel = (l: LeadRef) => (l.area ? `${l.name} (${l.area})` : l.name);
