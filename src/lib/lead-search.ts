// Pure, shared search and filters for every Leads view. These are stored-record filters:
// they never discover a site, verify contact details, or change outreach eligibility.
import type { BoardLead } from "./leads";

export type WebsitePresence =
  | "verified_none"
  | "has_site"
  | "social_only"
  | "unknown"
  | "wrong_site";
export type LeadSort = "relevance" | "score" | "newest" | "name" | "next";
export type LeadFilters = {
  q: string;
  vertical: string;
  pitch: string;
  status: string;
  stage: string;
  website: "" | WebsitePresence;
  owner: "" | "usman" | "mehroz" | "unassigned";
  area: string;
  source: string;
  contact: "" | "phone" | "email" | "both" | "missing_phone" | "missing_email" | "none";
  created: "" | "7" | "30" | "90";
  followup: "" | "overdue" | "today" | "unscheduled";
  verifiedOnly: boolean;
  showExcluded: boolean;
  sort: LeadSort;
};

export const DEFAULT_LEAD_FILTERS: Readonly<LeadFilters> = Object.freeze({
  q: "",
  vertical: "",
  pitch: "",
  status: "",
  stage: "",
  website: "",
  owner: "",
  area: "",
  source: "",
  contact: "",
  created: "",
  followup: "",
  verifiedOnly: false,
  showExcluded: false,
  sort: "relevance",
});

export type LeadFilterOption = { value: string; label: string };
export const WEBSITE_FILTER_OPTIONS: LeadFilterOption[] = [
  { value: "verified_none", label: "No website · verified" },
  { value: "has_site", label: "Website on file" },
  { value: "social_only", label: "Social link only" },
  { value: "unknown", label: "Website unknown" },
  { value: "wrong_site", label: "Wrong website" },
];
export const OWNER_FILTER_OPTIONS: LeadFilterOption[] = [
  { value: "usman", label: "Usman" },
  { value: "mehroz", label: "Mehroz" },
  { value: "unassigned", label: "Unassigned" },
];
export const CONTACT_FILTER_OPTIONS: LeadFilterOption[] = [
  { value: "phone", label: "Has phone" },
  { value: "email", label: "Has email" },
  { value: "both", label: "Phone and email" },
  { value: "missing_phone", label: "Missing phone" },
  { value: "missing_email", label: "Missing email" },
  { value: "none", label: "No phone or email" },
];
export const CREATED_FILTER_OPTIONS: LeadFilterOption[] = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];
export const FOLLOWUP_FILTER_OPTIONS: LeadFilterOption[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "unscheduled", label: "Not scheduled" },
];
export const LEAD_SORT_OPTIONS: LeadFilterOption[] = [
  { value: "relevance", label: "Best match" },
  { value: "score", label: "Highest score" },
  { value: "newest", label: "Newest first" },
  { value: "name", label: "Business A–Z" },
  { value: "next", label: "Next follow-up" },
];

const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "threads.net",
  "threads.com",
];

/** URL presence is not site verification. Only the existing, explicit absence state can
 * establish "no website". Discovery failures and social links never establish absence. */
export function websitePresence(lead: BoardLead): WebsitePresence {
  const website = text(lead.website).trim();
  const status = lead.deal?.websiteStatus;
  if (!website && status === "no_website_verified") return "verified_none";
  if (status === "not_their_site") return "wrong_site";
  if (!website) return "unknown";
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(website) ? website : `https://${website}`);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname.includes("."))
      return "unknown";
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`)))
      return "social_only";
    return "has_site";
  } catch {
    return "unknown";
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Accent- and punctuation-insensitive words without changing the stored display values. */
function normalized(value: unknown): string {
  return text(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compareText(a: string, b: string): number {
  // Code-point order is stable across host locales; use raw text only to break folded ties.
  const x = normalized(a),
    y = normalized(b);
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Options reflect the records we actually loaded, retaining their source/area labels. */
export function leadFilterOptions(leads: readonly BoardLead[]): {
  areas: LeadFilterOption[];
  sources: LeadFilterOption[];
} {
  const options = (values: string[]) =>
    [...new Set(values.map((v) => v.trim()).filter(Boolean))]
      .sort(compareText)
      .map((value) => ({ value, label: value }));
  return {
    areas: options(leads.map((lead) => text(lead.area))),
    sources: options(leads.map((lead) => text(lead.source))),
  };
}

/** Australian local/international spellings are equivalent in this Sydney CRM. Keep the
 * original digits too, so other countries and partial numbers remain searchable. */
function phoneForms(value: unknown): string[] {
  const digits = text(value).replace(/\D/g, "");
  if (!digits) return [];
  const forms = new Set([digits]);
  const international = digits.startsWith("00") ? digits.slice(2) : digits;
  forms.add(international);
  const au = international.replace(/^610(?=\d{9}$)/, "61");
  if (/^61[23478]\d{8}$/.test(au)) {
    forms.add(au);
    forms.add(`00${au}`);
    forms.add(`0${au.slice(2)}`);
  } else if (/^0[23478]\d{8}$/.test(digits)) {
    forms.add(`61${digits.slice(1)}`);
    forms.add(`0061${digits.slice(1)}`);
  }
  return [...forms];
}

/** Keep phone-like runs in order instead of treating formatted digit groups as
 * independent words that can match different numbers or fields. */
function queryTerms(value: string): string[] {
  const identifiers = [...value.matchAll(/(?:^|\s)#(\d+)(?=\s|$)/g)].map((match) => match[1]);
  const withoutIds = value.replace(/(?:^|\s)#\d+(?=\s|$)/g, " ");
  const compactPhones = withoutIds.replace(/\+?\d[\d\s().-]*\d/g, (part) => {
    const digits = part.replace(/\D/g, "");
    return digits.length >= 8 ? digits : part;
  });
  return [...new Set([...normalized(compactPhones).split(" ").filter(Boolean), ...identifiers])];
}

function dateValue(value: unknown): number | null {
  if (!text(value).trim()) return null;
  const date = Date.parse(text(value));
  return Number.isFinite(date) ? date : null;
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const day = (value: number): string => dayFormat.format(new Date(value));
const safeScore = (lead: BoardLead): number => (Number.isFinite(lead.score) ? lead.score : 0);

/** All query terms must match, but may match different fields. Relevance promotes exact
 * identifiers, whole business names, then name prefixes before considering lead score. */
function matchQuery(
  lead: BoardLead,
  query: string,
  terms: string[],
  rawQuery: string,
): number | null {
  if (!terms.length) return 0;
  const name = normalized(lead.name);
  const fields = [lead.name, lead.area, lead.address, lead.website, ...(lead.emails ?? [])].map(
    normalized,
  );
  const phones = phoneForms(lead.phone);
  const id = String(lead.id);
  // An explicit #ID is an identifier constraint, not a phone/address substring.
  const ids = [...rawQuery.matchAll(/(?:^|\s)#(\d+)(?=\s|$)/g)].map((match) => match[1]);
  if (ids.some((wanted) => wanted !== id)) return null;
  if (
    !terms.every(
      (term) =>
        fields.some((field) => field.includes(term)) ||
        term === id ||
        // Short digit runs ("12", "2770") are street numbers, postcodes or IDs, never a slice of someone's phone;
        // only six or more digits are looked for inside phone numbers.
        (/^\d{6,}$/.test(term) &&
          phoneForms(term).some((form) => phones.some((phone) => phone.includes(form)))),
    )
  )
    return null;
  if (terms.length === 1 && terms[0] === id) return 7;
  if (/^[\d\s+().-]+$/.test(rawQuery) && phoneForms(rawQuery).some((form) => phones.includes(form)))
    return 6;
  if (name === query) return 5;
  if (name.startsWith(query)) return 4;
  if (name.includes(query)) return 3;
  if (terms.every((term) => name.includes(term))) return 2;
  return 1;
}

/** Non-mutating selection for list, table and board. DNC/closed statuses stay searchable;
 * a saved phone/email is merely present, not verified or permission to contact. "Today"
 * and "overdue" use Sydney calendar days, matching the existing call queue. */
export function selectLeadResults(
  leads: readonly BoardLead[],
  filters: Partial<LeadFilters> = {},
  now = Date.now(),
): BoardLead[] {
  const f = { ...DEFAULT_LEAD_FILTERS, ...filters };
  const query = normalized(f.q),
    terms = queryTerms(text(f.q));
  const nowValid = Number.isFinite(now) && Math.abs(now) <= 8.64e15;
  const today = nowValid ? day(now) : null;
  return leads
    .flatMap((lead) => {
      if (!f.showExcluded && lead.excluded) return [];
      if (
        (f.vertical && lead.vertical !== f.vertical) ||
        (f.pitch && lead.pitch !== f.pitch) ||
        (f.status && lead.status !== f.status) ||
        (f.stage && lead.deal?.stage !== f.stage)
      )
        return [];
      if (f.website && websitePresence(lead) !== f.website) return [];
      const owner = text(lead.owner).trim().toLowerCase();
      if (f.owner && (f.owner === "unassigned" ? !!owner : owner !== f.owner)) return [];
      if (
        (f.area && text(lead.area).trim() !== f.area) ||
        (f.source && text(lead.source).trim() !== f.source)
      )
        return [];
      if (f.contact) {
        const phone = phoneForms(lead.phone).length > 0;
        const email = (lead.emails ?? []).some((email) => text(email).trim().length > 0);
        const matches = {
          phone,
          email,
          both: phone && email,
          missing_phone: !phone,
          missing_email: !email,
          none: !phone && !email,
        };
        if (!matches[f.contact]) return [];
      }
      if (f.created) {
        const created = dateValue(lead.createdAt);
        if (
          !nowValid ||
          created === null ||
          created > now ||
          created < now - Number(f.created) * 86_400_000
        )
          return [];
      }
      if (f.followup) {
        // Closed and do-not-contact leads are never "overdue": the overview tile leaves them out, so this filter does too.
        if (f.followup === "overdue" && (lead.deal?.closed || lead.status === "do_not_contact")) return [];
        const next = dateValue(lead.nextAt);
        if (
          f.followup === "unscheduled"
            ? next !== null
            : next === null ||
              !today ||
              (f.followup === "today" ? day(next) !== today : day(next) >= today)
        )
          return [];
      }
      // Match the existing taggedReasons() rule: rewritten discovery claims lose verification.
      if (
        f.verifiedOnly &&
        !(lead.reasons ?? []).some(
          (reason, i) => !!lead.verified?.[i] && !/no website(?: found)?/i.test(reason),
        )
      )
        return [];
      const relevance = matchQuery(lead, query, terms, text(f.q).trim());
      return relevance === null ? [] : [{ lead, relevance }];
    })
    .sort((a, b) => {
      let result = 0;
      switch (f.sort) {
        case "relevance":
          result = b.relevance - a.relevance || safeScore(b.lead) - safeScore(a.lead);
          break;
        case "score":
          result = safeScore(b.lead) - safeScore(a.lead);
          break;
        case "name":
          result = compareText(text(a.lead.name), text(b.lead.name));
          break;
        case "newest":
          result =
            (dateValue(b.lead.createdAt) ?? -Infinity) - (dateValue(a.lead.createdAt) ?? -Infinity);
          break;
        case "next":
          result = (dateValue(a.lead.nextAt) ?? Infinity) - (dateValue(b.lead.nextAt) ?? Infinity);
          break;
      }
      return (Number.isNaN(result) ? 0 : result) || a.lead.id - b.lead.id;
    })
    .map(({ lead }) => lead);
}
