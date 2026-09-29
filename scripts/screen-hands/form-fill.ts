// "Fill this form with my business details" in one go (flag `formFill`; the playjev pattern).
//
// Every EMPTY text field on the window is matched to one of his saved details at once: plain label
// rules first ("Business name", "Email"), then ONE Jev request with a choice question per leftover
// field. Only the detail's name and a description go to Jev; his values never leave the PC. Each
// match is typed through screen_act's usual vetted path and read back.
//
// Safety, in code:
// - only empty fields, so nothing he typed is overwritten (it's undone by clearing them);
// - never a password, card, bank, ID, code or other secure field (secureField / SENSITIVE_FIELD),
//   and every value still passes vetAction and the deny-list;
// - never a button: the submit is his, and is never pressed or batched;
// - a detail that isn't saved is left blank and named, never guessed.
//
// The details come from .operator-data/business.json (the business page's profile): his name, the
// business, his partner and what the business does, plus email/phone/website/address/role only if
// the profile holds them.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { labelOf, secureField, SENSITIVE_FIELD, type Snapshot, type UiElement } from "./plan";

export type Detail = { key: string; about: string; value: string };
export type FillMatch = { field: UiElement; detail: Detail; via: "rules" | "jev"; confidence: number };
export type FillPlan = { matches: FillMatch[]; unmatched: UiElement[]; jevMs: number | null };
/** Jev: which saved detail belongs in each field (by field id), with a confidence. */
export type FillAsk = (
  fields: Array<{ id: number; label: string }>,
  details: Array<Pick<Detail, "key" | "about">>,
  context: { window: string },
  signal: AbortSignal,
) => Promise<Map<number, { key: string; confidence: number }> | null>;

export const FILL_MIN = 0.6;
export const MAX_FILL_FIELDS = 15;

/** "fill this form with my (business) details", "fill in my details here", "fill this in for me". Pure. */
export const FORM_FILL_GOAL =
  /\b(?:fill|complete|pop|put)\b(?: (?:in|out|up))?(?: (?:this|the|that|these|it))?(?: (?:form|application|page|fields?|bits?))?(?: (?:in|out))?(?: (?:with|using|from)) (?:my|our|the) (?:business |company |usual |saved )?(?:details|info(?:rmation)?|profile)\b|^(?:can you )?fill (?:this|it|the form|this form) (?:in|out)(?: for me)?$|\bfill in my (?:business )?details\b/i;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** His saved details from the business profile (no model call; missing ones simply aren't there). */
export function businessDetails(profile: unknown): Detail[] {
  const p = (profile && typeof profile === "object" ? profile : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? clip(p[k] as string, 200) : "");
  const what = str("whatYouDo") ? String(p.whatYouDo) : "";
  const out: Detail[] = [];
  const add = (key: string, about: string, value: string) => value && out.push({ key, about, value });
  add("first_name", "his first name (a first or given name, or just 'name')", str("preferredName"));
  add("full_name", "his full name (first and last)", str("fullName"));
  add("last_name", "his last name or surname", str("lastName"));
  add("business", "the name of his business or company", str("businessName") || (what.match(/\b[Mm]y business is ([A-Z][\w&'. -]{1,40}?)(?:,| run by|\.| and )/)?.[1] ?? "").trim());
  add("partner", "his business partner or co-founder's name", str("partnerName") || (what.match(/\b[Mm]y (?:business )?(?:partner|co-?founder),? ([A-Z][a-z]+)/)?.[1] ?? ""));
  add("role", "his role or job title", str("role"));
  add("email", "his email address", str("email"));
  add("phone", "his phone or mobile number", str("phone"));
  add("website", "his business website", str("website"));
  add("address", "his business address", str("address"));
  const offer = str("offer") || (what.match(/\bprovides ([^.]{10,160}?) for (?:other )?businesses\b/)?.[1] ?? "");
  add("services", "what his business does or offers (a short description)", offer ? `${offer.charAt(0).toUpperCase()}${offer.slice(1)} for businesses.` : "");
  return out;
}

/** The details saved in .operator-data/business.json (read at call time; a missing file is none). */
export function savedDetails(file = join(ROOT, ".operator-data", "business.json")): Detail[] {
  try {
    return businessDetails((JSON.parse(readFileSync(file, "utf8")) as { profile?: unknown }).profile);
  } catch {
    return [];
  }
}

const TEXT_FIELDS = ["Edit", "ComboBox"];
/** Empty, editable, non-secure text fields in reading order (web content only in a browser). Pure. */
export function fillableFields(snap: Snapshot): UiElement[] {
  return snap.elements
    .filter(
      (e) =>
        TEXT_FIELDS.includes(e.type) &&
        e.enabled &&
        !e.readOnly &&
        !e.password &&
        !secureField(e) &&
        !SENSITIVE_FIELD.test(`${e.name} ${e.help} ${e.aid}`) &&
        !e.value.trim() &&
        !!labelOf(e) &&
        e.w >= 8 &&
        e.h >= 8 &&
        !(snap.browser && e.web === false) &&
        // The browser's own search/address bars and a page's search box aren't form fields.
        !/\b(?:search|address and search|find|filter|url)\b/i.test(labelOf(e)),
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, MAX_FILL_FIELDS);
}

/** Label rules: field label → detail key. First match wins; order matters (last name before name). */
const RULES: Array<[RegExp, string]> = [
  [/\b(?:last|family|sur) ?name\b|\bsurname\b/i, "last_name"],
  [/\bfull name\b/i, "full_name"],
  [/\b(?:business|company|organi[sz]ation|trading|practice|firm) name\b|^(?:business|company|organi[sz]ation)$/i, "business"],
  [/\b(?:partner|co-?founder|co-?owner)\b|\bwho else (?:runs|owns|works on|is in)\b|\bruns? (?:it|the business) with you\b/i, "partner"],
  [/\be-?mail\b/i, "email"],
  [/\b(?:phone|mobile|telephone|tel)\b/i, "phone"],
  [/\b(?:website|web site|url|homepage)\b/i, "website"],
  [/\b(?:address|street)\b/i, "address"],
  [/\b(?:role|job title|position|title at)\b/i, "role"],
  [/\bfirst name\b|\bgiven name\b|^(?:your )?name\b|\bcontact name\b|\bpreferred name\b/i, "first_name"],
  [/\bwhat (?:does|do) (?:your|you)\b|\b(?:describe|about) (?:your )?(?:business|company)\b|\bservices?\b|\bbusiness description\b|\bwhat you do\b/i, "services"],
];
/** A label that asks for a KIND of value (email, phone, date, number) only that detail can fill. */
const KINDS: Array<[RegExp, string[]]> = [
  [/\be-?mail\b/i, ["email"]],
  [/\b(?:phone|mobile|telephone|tel)\b/i, ["phone"]],
  [/\b(?:website|url|homepage)\b/i, ["website"]],
  [/\b(?:last|family|sur) ?name\b|\bsurname\b/i, ["last_name"]],
  [/\bfull name\b/i, ["full_name"]],
  [/\b(?:date|dob|birthday|age|amount|price|budget|quantity|number of|how many|postcode|zip|abn|acn)\b/i, []],
];

/** The rule for this label, or null ("" = nothing saved fits: leave it). Pure. */
export function ruleFor(label: string): string | null {
  for (const [re, key] of RULES) if (re.test(label)) return key;
  return null;
}
/** Would this detail be wrong in a field labelled like this (a name in an email box)? Pure. */
export function conflicts(label: string, key: string) {
  for (const [re, keys] of KINDS) if (re.test(label)) return !keys.includes(key);
  return false;
}

/**
 * Match every fillable field to a saved detail: rules first, then one Jev call for the rest.
 * A field whose detail isn't saved is left for him. Never touches the screen.
 */
export async function planFill(snap: Snapshot, details: Detail[], ask: FillAsk | undefined, context: { window: string }, signal: AbortSignal): Promise<FillPlan> {
  const fields = fillableFields(snap);
  const byKey = new Map(details.map((d) => [d.key, d]));
  const matches: FillMatch[] = [];
  const leftover: UiElement[] = [];
  const unmatched: UiElement[] = [];
  for (const f of fields) {
    const key = ruleFor(labelOf(f));
    if (key === null) leftover.push(f);
    else if (byKey.has(key)) matches.push({ field: f, detail: byKey.get(key)!, via: "rules", confidence: 1 });
    else unmatched.push(f);
  }
  let jevMs: number | null = null;
  if (leftover.length && ask && details.length && !signal.aborted) {
    const t0 = Date.now();
    const answers = await ask(
      leftover.map((f) => ({ id: f.id, label: clip(`${labelOf(f)}${f.help && f.help !== labelOf(f) ? ` (${f.help})` : ""}`, 120) })),
      details.map(({ key, about }) => ({ key, about })),
      context,
      signal,
    ).catch(() => null);
    jevMs = Date.now() - t0;
    for (const f of leftover) {
      const a = answers?.get(f.id);
      const d = a && a.confidence >= FILL_MIN ? byKey.get(a.key) : undefined;
      if (d && !conflicts(labelOf(f), d.key)) matches.push({ field: f, detail: d, via: "jev", confidence: a!.confidence });
      else unmatched.push(f);
    }
  } else unmatched.push(...leftover);
  // One detail per field; the same detail may go in two fields (a name asked twice is fine).
  matches.sort((a, b) => a.field.y - b.field.y || a.field.x - b.field.x);
  unmatched.sort((a, b) => a.y - b.y || a.x - b.x);
  return { matches, unmatched, jevMs };
}

/** The spoken line after a fill. Pure. */
export function fillLine(filled: string[], blank: string[], failed: string[], submit: string | null) {
  const names = (xs: string[]) => {
    const q = xs.slice(0, 4).map((x) => `"${clip(x, 28)}"`);
    const more = xs.length > 4 ? ` and ${xs.length - 4} more` : "";
    return q.length > 1 && !more ? `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}` : `${q.join(", ")}${more}`;
  };
  const parts: string[] = [];
  parts.push(filled.length ? `Filled ${names(filled)}.` : "I didn't fill anything.");
  if (failed.length) parts.push(`${names(failed)} didn't take.`);
  if (blank.length) parts.push(`I left ${names(blank)} blank: I don't have ${blank.length === 1 ? "that" : "those"} saved.`);
  parts.push(submit ? `I haven't pressed "${clip(submit, 30)}".` : "I haven't submitted anything.");
  return parts.join(" ");
}
