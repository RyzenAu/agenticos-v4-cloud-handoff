/**
 * A deal: client details, a website scenario, a receptionist scenario and quote text, saved and reopened as
 * one JSON document. Synthetic seed deals only; nothing here reads CRM, finance or customer records.
 */
import { getReceptionistPackage, type PackageId } from "../receptionist-packages";
import { calculateRxDeal, defaultRxInput, RX_COLUMN_LABELS, type RxColumnId, type RxDealInput } from "./receptionist";
import { calculateWebsite, defaultWebsiteInput, type WebsiteInput } from "./website";

export type Sector = "dental" | "legal" | "property" | "other";
export type ClientDetails = { business: string; contact: string; email: string; phone: string; address: string; abn: string; sector: Sector };
/** Free text, one item per line, so the quote stays editable without a rich editor. */
export type QuoteText = {
  number: string; preparedOn: string; validDays: number; preparedBy: string; projectTitle: string; summary: string;
  scope: string; deliverables: string; exclusions: string; timeline: string; responsibilities: string; notes: string;
  /** Show an illustrative monthly receptionist invoice at the expected usage. */
  usageIllustration: boolean;
  /** true once the founder has edited the scope text by hand; until then it is regenerated from the scenario. */
  customText: boolean;
};
export type Deal = {
  schemaVersion: 1; id: string; name: string; synthetic: boolean; updatedAt: string;
  client: ClientDetails; include: { website: boolean; receptionist: boolean };
  website: WebsiteInput; rx: RxDealInput; quote: QuoteText;
};

export const STORAGE_KEY = "mu-deal-desk/v1";

export function newId(): string {
  return `deal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function blankDeal(today: string, id = newId()): Deal {
  return {
    schemaVersion: 1, id, name: "New deal", synthetic: false, updatedAt: today,
    client: { business: "", contact: "", email: "", phone: "", address: "", abn: "", sector: "other" },
    include: { website: true, receptionist: false },
    website: defaultWebsiteInput(), rx: defaultRxInput("receptionist-professional"),
    quote: {
      number: `Q-${today.replace(/-/g, "")}-${id.slice(-4).toUpperCase()}`, preparedOn: today, validDays: 14, preparedBy: "Usman and Mehroz, M&U Ventures",
      projectTitle: "", summary: "", scope: "", deliverables: "", exclusions: "", timeline: "", responsibilities: "", notes: "", usageIllustration: true, customText: false,
    },
  };
}

/** Fill text the founder has not written yet from the scenario (never overwrites edited text unless forced). */
export function fillQuoteText(deal: Deal, force = false): Deal {
  const t = defaultQuoteText(deal);
  const q = { ...deal.quote };
  for (const key of ["projectTitle", "summary", "scope", "deliverables", "exclusions", "timeline", "responsibilities"] as const) {
    if (force || !q[key].trim()) q[key] = t[key];
  }
  if (force) q.customText = false;
  return { ...deal, quote: q };
}

/** The quote text to show and export: the founder's own text once edited, otherwise always fresh from the scenario. */
export function effectiveQuote(deal: Deal): QuoteText {
  return deal.quote.customText ? deal.quote : { ...deal.quote, ...defaultQuoteText(deal) };
}

export function defaultQuoteText(deal: Deal) {
  const web = deal.include.website; const rx = deal.include.receptionist;
  const pkg = getReceptionistPackage(deal.rx.packageId);
  const w = deal.website;
  const what = [web ? (w.kind === "redesign" ? "website redesign" : "new business website") : "", rx ? `AI receptionist (${pkg.shortName})` : ""].filter(Boolean).join(" and ");
  const name = deal.client.business || "the client";
  const rxIncluded = pkg.functions.filter((f) => f.state !== "not-offered").map((f) => f.state === "at-go-live" ? `${f.label} (at go-live, after activation and acceptance tests)` : f.label);
  return {
    projectTitle: what ? what[0].toUpperCase() + what.slice(1) : "Proposal",
    summary: `A ${what || "project"} for ${name}, set up and tested before going live.`,
    scope: [
      ...(web ? [
        `${w.kind === "redesign" ? "Redesign" : "Design and build"} of a responsive business website: discovery, agreed page list, design, build, basic search setup, testing and launch.`,
        `Editing: ${w.cmsComplexity === "none" ? "M&U makes content changes (no CMS)" : `${w.cmsComplexity} CMS setup so your team can edit agreed content`}.`,
        `${w.revisions.includedRounds} rounds of revisions on the design and build${w.revisions.extraRoundFeeCents === null ? "." : "; further rounds are charged at the rate below."}`,
      ] : []),
      ...(rx ? [
        `AI receptionist, ${pkg.name}: ${pkg.audience}`,
        "When a caller asks for a person, the receptionist takes their details and a callback request, and (once staff alerts are switched on at go-live) alerts your team by email. It does not transfer live calls.",
        ...rxIncluded.map((x) => `Receptionist: ${x}`),
        "Booking integrations vary by business and scheduling system. We confirm compatibility during setup; where direct booking is unavailable, we offer an agreed booking-request or lead-capture workflow.",
      ] : []),
    ].join("\n"),
    deliverables: [
      ...(web ? ["Approved design for the agreed pages", "Live website on the agreed domain", "Basic on-page search setup (titles, descriptions, sitemap)", w.cmsComplexity === "none" ? "Handover notes" : "CMS access and a short editing guide"] : []),
      ...(rx ? [`Configured receptionist on ${pkg.inclusions.phoneNumbers} number${pkg.inclusions.phoneNumbers === 1 ? "" : "s"} and up to ${pkg.inclusions.calendars} calendar${pkg.inclusions.calendars === 1 ? "" : "s"}`, ...pkg.inclusions.reports.map((r) => `Report: ${r}`), "Five scripted test calls with you before go-live"] : []),
    ].join("\n"),
    exclusions: [
      ...(web ? ["Copywriting beyond the agreed pages", "Paid advertising, ongoing SEO campaigns and photography", "Third-party subscriptions, plugins and licences unless listed", "Revision rounds beyond those included"] : []),
      ...(rx ? [...pkg.functions.filter((f) => f.state === "not-offered").map((f) => `${f.label} (not offered)`), ...pkg.limitations] : []),
    ].join("\n"),
    timeline: [
      ...(web ? ["Week 1: kickoff, content and access gathered", "Weeks 2–3: design and first build; revision round 1", "Week 4: revision round 2, testing, launch on approval"] : []),
      ...(rx ? pkg.onboarding.map((s, i) => `Receptionist step ${i + 1}: ${s}`) : []),
      "Exact dates are agreed after acceptance, deposit, content and access.",
    ].join("\n"),
    responsibilities: [
      ...(web ? ["Client: brand assets, approved copy and images, domain access, one person to approve work", "Domain renewal and payer: agree in writing", "Hosting under the care plan while it is active (draft care terms, awaiting confirmation)"] : []),
      ...(rx ? ["Client: switch on call forwarding for the agreed cover; grant calendar access (no passwords shared)", "Client: privacy policy names overseas processors (call audio and transcripts are processed in the United States)", "M&U: provider costs (voice, telephony, SMS within the allowance) are included in the monthly fee"] : []),
    ].join("\n"),
  };
}

const seed = (id: string, name: string, f: (d: Deal) => void): Deal => {
  const d = blankDeal("2026-10-03", id); d.name = name; d.synthetic = true; f(d); return fillQuoteText(d);
};
/** Synthetic examples only: invented businesses, no real people, contacts or usage. */
export function seedDeals(): Deal[] {
  return [
    seed("seed-dental-pro", "Example Dental Studio (synthetic): Professional receptionist", (d) => {
      d.client = { business: "Example Dental Studio (synthetic)", contact: "Practice manager (synthetic)", email: "", phone: "", address: "Western Sydney NSW", abn: "", sector: "dental" };
      d.include = { website: false, receptionist: true }; d.rx = defaultRxInput("receptionist-professional");
    }),
    seed("seed-legal-web", "Example Conveyancing (synthetic): website build", (d) => {
      d.client = { business: "Example Conveyancing (synthetic)", contact: "Principal (synthetic)", email: "", phone: "", address: "Parramatta NSW", abn: "", sector: "legal" };
      d.include = { website: true, receptionist: false };
      d.website.cmsComplexity = "structured"; d.website.effortMinutes.cms = 360;
    }),
    seed("seed-realty-both", "Example Realty (synthetic): website + Essential", (d) => {
      d.client = { business: "Example Realty (synthetic)", contact: "Director (synthetic)", email: "", phone: "", address: "Blue Mountains NSW", abn: "", sector: "property" };
      d.include = { website: true, receptionist: true }; d.rx = defaultRxInput("receptionist-essential");
    }),
    seed("seed-edge-heavy", "Edge case (synthetic): heavy Essential with a discount", (d) => {
      d.client = { business: "Example Heavy-Use Clinic (synthetic)", contact: "", email: "", phone: "", address: "", abn: "", sector: "dental" };
      d.include = { website: false, receptionist: true }; d.rx = defaultRxInput("receptionist-essential");
      d.rx.monthlyDiscountBps = 1000; d.rx.columns.expected = { billableSeconds: 54_000, smsSegments: 260, supportMinutes: 120 };
      d.rx.columns.extra = { billableSeconds: 90_030, smsSegments: 400, supportMinutes: 180 };
    }),
  ];
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Fill a saved object from defaults. Unknown keys are dropped (except in open records), and prototype keys never copied. */
function mergeDefaults<T>(defaults: T, value: unknown, openRecord = false): T {
  if (Array.isArray(defaults)) return (Array.isArray(value) ? value : defaults) as T;
  // Only a missing field takes the default. A wrong type is kept so assertDeal rejects it rather than hiding it.
  if (defaults === null || typeof defaults !== "object") return (value === undefined ? defaults : value) as T;
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  if (value && typeof value === "object" && !Array.isArray(value)) for (const k of Object.keys(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const v = (value as Record<string, unknown>)[k];
    // `discount` is a tagged union ({type, bps} or {type, cents}): take it whole; assertDeal checks its shape.
    if (k === "discount" && v && typeof v === "object" && !Array.isArray(v)) out[k] = { ...(v as object) };
    else if (Object.prototype.hasOwnProperty.call(out, k)) out[k] = mergeDefaults(out[k], v, k === "rateOverrides");
    else if (openRecord) out[k] = v;
  }
  return out as T;
}

/** Strict shape check after merging: wrong types, unknown enum values, negative, fractional or absurd numbers are rejected. */
function assertDeal(d: Deal, n: string) {
  const fail = (what: string): never => { throw new Error(`${n}: ${what}`); };
  const str = (v: unknown, k: string, max = 20000) => { if (typeof v !== "string" || v.length > max) fail(`${k} must be text (up to ${max} characters)`); };
  const int = (v: unknown, k: string, max = 1e12, min = 0) => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) fail(`${k} must be a whole number from ${min} to ${max}`); };
  const intOrNull = (v: unknown, k: string) => { if (v !== null) int(v, k); };
  const bool = (v: unknown, k: string) => { if (typeof v !== "boolean") fail(`${k} must be yes or no`); };
  const oneOf = (v: unknown, k: string, options: readonly string[]) => { if (typeof v !== "string" || !options.includes(v)) fail(`${k} must be one of ${options.join(", ")}`); };
  const date = (v: unknown, k: string) => { if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) fail(`${k} must be a real date (YYYY-MM-DD)`); };
  const fx = (f: Deal["rx"]["fx"], k: string) => { int(f?.usdPerAudMillionths, `${k} rate`, 100_000_000, 1); date(f?.date, `${k} date`); int(f?.cardFeeBps, `${k} buffer`, 10000); };
  const gst = ["inclusive", "exclusive"] as const;

  str(d.id, "id", 200); str(d.name, "name", 300); bool(d.synthetic, "synthetic"); str(d.updatedAt, "updatedAt", 40);
  for (const k of ["business", "contact", "email", "phone", "address", "abn"] as const) str(d.client[k], `client ${k}`, 500);
  oneOf(d.client.sector, "sector", ["dental", "legal", "property", "other"]);
  bool(d.include.website, "include website"); bool(d.include.receptionist, "include receptionist");

  const w = d.website;
  oneOf(w.kind, "website kind", ["build", "redesign"]); int(w.price.cents, "website price"); oneOf(w.price.gst, "website price GST", gst);
  oneOf(w.discount?.type, "discount type", ["none", "percent", "fixed"]);
  if (w.discount.type === "percent") int(w.discount.bps, "discount percent", 10000);
  if (w.discount.type === "fixed") int(w.discount.cents, "discount amount");
  int(w.labourHourlyCents, "hourly rate", 10_000_000);
  for (const k of ["discovery", "design", "build", "content", "cms", "qa", "pm"] as const) int(w.effortMinutes[k], `effort ${k}`, 1_000_000);
  oneOf(w.cmsComplexity, "CMS complexity", ["none", "simple", "structured", "custom"]);
  int(w.revisions.includedRounds, "included rounds", 100); int(w.revisions.minutesPerRound, "minutes per round", 100_000); int(w.revisions.expectedExtraRounds, "extra rounds", 100); intOrNull(w.revisions.extraRoundFeeCents, "extra round fee");
  if (!Array.isArray(w.costs) || w.costs.length > 60) fail("costs must be a list of up to 60 items");
  w.costs.forEach((c, i) => {
    if (!c || typeof c !== "object") fail(`cost ${i + 1} is not an object`);
    str(c.id, `cost ${i + 1} id`, 200); str(c.label, `cost ${i + 1} label`, 300); oneOf(c.currency, `cost ${i + 1} currency`, ["AUD", "USD"]); intOrNull(c.cents, `cost ${i + 1} amount`);
    oneOf(c.frequency, `cost ${i + 1} frequency`, ["one-off", "monthly"]); int(c.sharedAcross, `cost ${i + 1} shared across`, 100000, 1);
    oneOf(c.evidence, `cost ${i + 1} evidence`, ["owner-confirmed", "public-list", "assumption", "entered", "unknown"]);
    if (c.source !== null) str(c.source, `cost ${i + 1} source`, 500); if (c.checkedAt !== null) str(c.checkedAt, `cost ${i + 1} checked date`, 40); str(c.note, `cost ${i + 1} note`, 1000);
  });
  int(w.contingencyBps, "contingency", 10000); int(w.targetMarginBps, "target margin", 9999);
  if (!Array.isArray(w.stages) || w.stages.length < 1 || w.stages.length > 12) fail("payment stages must be a list of 1 to 12");
  w.stages.forEach((s, i) => { if (!s || typeof s !== "object") fail(`stage ${i + 1} is not an object`); str(s.label, `stage ${i + 1} label`, 200); str(s.trigger, `stage ${i + 1} trigger`, 300); int(s.shareBps, `stage ${i + 1} share`, 10000); });
  str(w.payment.label, "payment label", 200); int(w.payment.percentBps, "payment fee percent", 10000); int(w.payment.fixedCents, "payment fixed fee", 1_000_000); bool(w.payment.gstCreditable, "payment fee GST");
  bool(w.care.enabled, "care plan"); int(w.care.monthly.cents, "care plan fee"); oneOf(w.care.monthly.gst, "care plan GST", gst);
  int(w.care.maintenanceMinutes, "maintenance minutes", 100_000); int(w.care.includedChangeMinutes, "included change minutes", 100_000); int(w.care.expectedChangeMinutes, "expected change minutes", 100_000); int(w.care.termMonths, "care months", 120);
  fx(w.fx, "website FX");

  const r = d.rx;
  for (const id of ["low", "expected", "full", "extra"] as const) { int(r.columns[id]?.billableSeconds, `${id} billable seconds`, 1_000_000_000); int(r.columns[id]?.smsSegments, `${id} SMS`, 10_000_000); int(r.columns[id]?.supportMinutes, `${id} support minutes`, 1_000_000); }
  int(r.avgCallSeconds, "average call length", 86400, 5); int(r.shortCallShareBps, "short-call share", 10000); int(r.webhookEventsPerCall, "webhook events per call", 100);
  int(r.voiceMicros, "voice rate", 1_000_000_000); int(r.clientsSharingPlatform, "clients sharing hosting", 10000, 1); fx(r.fx, "receptionist FX");
  int(r.labourHourlyCents, "receptionist hourly rate", 10_000_000); int(r.onboardingMinutes, "onboarding minutes", 1_000_000);
  int(r.payment.percentBps, "receptionist payment percent", 10000); int(r.payment.fixedCents, "receptionist fixed fee", 1_000_000);
  int(r.monthlyDiscountBps, "monthly discount", 10000); intOrNull(r.setupFeeCents, "setup fee"); int(r.termMonths, "term months", 120);
  for (const [k, v] of Object.entries(r.rateOverrides)) { if (!/^[a-z0-9-]{1,40}$/.test(k)) fail("a cost override has an unknown name"); intOrNull(v, `cost override ${k}`); }

  const q = d.quote;
  str(q.number, "quote number", 80); date(q.preparedOn, "quote date"); int(q.validDays, "quote validity days", 365, 1); str(q.preparedBy, "prepared by", 300);
  for (const k of ["projectTitle", "summary", "scope", "deliverables", "exclusions", "timeline", "responsibilities", "notes"] as const) str(q[k], `quote ${k}`);
  bool(q.usageIllustration, "usage illustration"); bool(q.customText, "custom text");
}

/**
 * Shape-only parse of one saved deal object: defaults filled, types and enums enforced, NOT calculated.
 * Used to keep an unfinished draft (for example a payment schedule that does not add to 100% yet), which
 * must be preserved even though it cannot be quoted. Throws on anything malformed.
 */
export function parseDealShape(raw: unknown, label = "Deal"): Deal {
  if (!raw || typeof raw !== "object" || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) throw new Error(`${label}: unsupported or missing schemaVersion.`);
  const r = raw as Partial<Deal>;
  const base = blankDeal(typeof r.updatedAt === "string" ? r.updatedAt.slice(0, 10) : "2026-10-03", typeof r.id === "string" ? r.id : newId());
  const pkgId = (r.rx?.packageId ?? base.rx.packageId) as PackageId;
  getReceptionistPackage(pkgId);
  const merged = mergeDefaults(base, r);
  merged.rx = mergeDefaults(defaultRxInput(pkgId), r.rx);
  assertDeal(merged, label);
  return merged;
}

/** Reopen saved deals. Unknown or older shapes are filled from defaults; anything unreadable is rejected loudly. */
export function parseDeals(json: string): Deal[] {
  const data = JSON.parse(json) as unknown;
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { deals?: unknown }).deals) ? (data as { deals: unknown[] }).deals : null;
  if (!list) throw new Error("Not a deal desk export: expected a list of deals.");
  return list.map((raw, i) => {
    const merged = parseDealShape(raw, `Deal ${i + 1}`);
    // Validate by calculating once: a deal that cannot be calculated is not silently accepted.
    try { calculateWebsite(merged.website); calculateRxDeal(merged.rx); } catch (e) { throw new Error(`Deal ${i + 1}: ${(e as Error).message}`); }
    return merged;
  });
}

export function serializeDeals(deals: readonly Deal[]): string {
  return JSON.stringify({ app: "M&U deal desk", schemaVersion: 1, mode: "draft-only", exportedFrom: "local browser storage", deals }, null, 2) + "\n";
}

/** Text cells are always quoted, and a leading formula character is neutralised so a spreadsheet never runs it. */
const csvCell = (v: string | number | null) => v === null ? "unknown" : typeof v === "number" ? (v / 100).toFixed(2)
  : `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
/** Scenario comparison as CSV (A$, ex GST). Unknown values print as "unknown", never 0. */
export function comparisonCsv(deal: Deal): string {
  const rows: (string | number | null)[][] = [["Deal", "Scenario", "Kind", "Revenue ex GST (A$)", "Delivery/operating cost (A$)", "Profit (A$)", "Margin %", "Effective hourly (A$)", "Unknown costs excluded"]];
  if (deal.include.website) {
    const w = calculateWebsite(deal.website);
    rows.push([deal.name, "Website build", "one-off", w.oneOff.revenueExGstCents, w.oneOff.deliveryCostCents, w.oneOff.grossProfitCents, w.oneOff.marginBps === null ? "n/a" : (w.oneOff.marginBps / 100).toFixed(1), w.oneOff.effectiveHourlyCents, w.oneOff.unknownCosts.join("; ") || "none"]);
    if (w.recurring.enabled) rows.push([deal.name, "Care plan", "monthly", w.recurring.revenueExGstCents, w.recurring.costCents, w.recurring.profitCents, w.recurring.marginBps === null ? "n/a" : (w.recurring.marginBps / 100).toFixed(1), w.recurring.effectiveHourlyCents, w.recurring.unknownCosts.join("; ") || "none"]);
  }
  if (deal.include.receptionist) {
    const r = calculateRxDeal(deal.rx);
    for (const c of r.columns) rows.push([deal.name, `Receptionist: ${RX_COLUMN_LABELS[c.id as RxColumnId]} (${(c.billableSeconds / 60).toFixed(2)} min)`, "monthly", c.revenueExGstCents, c.revenueExGstCents - c.operatingCents, c.operatingCents, c.operatingMarginBps === null ? "n/a" : (c.operatingMarginBps / 100).toFixed(1), c.effectiveHourlyCents, c.unknownCosts.length ? `${c.unknownCosts.length} provider items` : "none"]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
