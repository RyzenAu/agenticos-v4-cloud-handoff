// Who the lead engine should never pitch at all: government bodies, legal aid/community
// services, non-profits, universities, hospitals, and national chains/franchises. These aren't
// "low score" leads — a two-person Sydney studio can't realistically win National Criminal
// Lawyers® off a cold call, and Legal Aid NSW was never a prospect. An excluded lead is kept in
// the CRM (never deleted — the audit trail matters) with `excluded = true` and a plain reason;
// `calls`/`cards`/`list` skip it.
export type ExclusionInput = {
  name: string;
  /** OSM `operator` tag: who actually runs this location (a franchisor, a department). */
  operator?: string;
  /** OSM `brand` tag: the chain/brand this location trades under. */
  brand?: string;
};

export type ExclusionResult = { excluded: boolean; reason: string };

/** Editable by hand — add a line rather than teaching the pattern matcher a new special case.
 *  Each entry is a name (or name fragment) M&U has already identified as government, legal
 *  aid/community, non-profit, or a national chain/franchise not worth cold-calling. */
export const DENYLIST: { pattern: RegExp; reason: string }[] = [
  { pattern: /\blegal aid\s+nsw\b/i, reason: "government legal aid service (Legal Aid NSW)" },
  { pattern: /\baboriginal legal service\b/i, reason: "community legal service (ALS)" },
  { pattern: /\bcommunity justice centre/i, reason: "government community justice service" },
  { pattern: /\bpacific smiles\b/i, reason: "national dental chain (Pacific Smiles Dental)" },
  { pattern: /\bshine\s+lawyers\b/i, reason: "national law firm chain (Shine Lawyers)" },
  { pattern: /\bstarr\s+partners\b/i, reason: "real-estate franchise network (Starr Partners)" },
  { pattern: /\bnational criminal lawyers\b/i, reason: "multi-city chain-style law firm brand (National Criminal Lawyers)" },
  { pattern: /\bray\s+white\b/i, reason: "real-estate franchise network (Ray White)" },
  { pattern: /\blj\s*hooker\b/i, reason: "real-estate franchise network (LJ Hooker)" },
  { pattern: /\bmcgrath\s+(estate\s+agents?|real\s*estate)\b/i, reason: "real-estate franchise network (McGrath)" },
  { pattern: /\bfirst\s*national\s+real\s*estate\b/i, reason: "real-estate franchise network (First National)" },
  { pattern: /\bharcourts\b/i, reason: "real-estate franchise network (Harcourts)" },
  { pattern: /\b1300\s*smiles\b/i, reason: "national dental chain (1300SMILES)" },
  { pattern: /\bnational\s+dental\s+care\b/i, reason: "national dental chain" },
  { pattern: /\bsmiles?\s+inclusive\b/i, reason: "national dental group" },
  { pattern: /\bmaurice\s+blackburn\b/i, reason: "national law firm chain (Maurice Blackburn)" },
  { pattern: /\bslater\s*(&|and)\s*gordon\b/i, reason: "national law firm chain (Slater & Gordon)" },
];

/** Name patterns that mark a government body, court, or emergency service (not a business M&U
 *  can pitch a website/receptionist to). */
const GOVERNMENT = /\b(nsw\s+government|department\s+of|city\s+of\s+\w+\s+council|\w+\s+council\b|local\s+court|district\s+court|supreme\s+court|nsw\s+police|centrelink|medicare|nsw\s+health|local\s+health\s+district)\b/i;

/** Non-profit / community-service name shapes — an org, not a fee-for-service practice. */
const NONPROFIT = /\b(incorporated|not[- ]for[- ]profit|charity|charitable|community\s+service|community\s+legal\s+centre|foundation|salvation\s+army|st\s+vincent\s+de\s+paul|red\s+cross|uniting\s+care|anglicare)\b/i;

/** Universities and hospitals — teaching/public institutions, not small-practice leads. */
const EDU_HEALTH = /\b(university|tafe\b|\bhospital\b|medical\s+centre\s+district|public\s+hospital)\b/i;

/** True for a lead this engine should mark `excluded` rather than score and pitch. Checks the
 *  editable denylist first (exact/near-exact brand or org names already identified), then a small
 *  set of name-pattern families for government/non-profit/education-health bodies, then OSM's own
 *  `operator`/`brand` tags against the same denylist (a location can be untagged in its `name` but
 *  still carry a franchisor in `operator`/`brand`). */
export function checkExclusion(input: ExclusionInput): ExclusionResult {
  const name = (input.name || "").trim();
  for (const { pattern, reason } of DENYLIST) if (pattern.test(name)) return { excluded: true, reason };
  if (GOVERNMENT.test(name)) return { excluded: true, reason: "name matches a government-body pattern" };
  if (NONPROFIT.test(name)) return { excluded: true, reason: "name matches a non-profit/community-service pattern" };
  if (EDU_HEALTH.test(name)) return { excluded: true, reason: "name matches a university/hospital pattern" };
  for (const field of [input.operator, input.brand]) {
    if (!field) continue;
    for (const { pattern, reason } of DENYLIST) if (pattern.test(field)) return { excluded: true, reason: `${reason} (OSM operator/brand: ${field})` };
    if (GOVERNMENT.test(field)) return { excluded: true, reason: `OSM operator/brand is a government body (${field})` };
  }
  return { excluded: false, reason: "" };
}
