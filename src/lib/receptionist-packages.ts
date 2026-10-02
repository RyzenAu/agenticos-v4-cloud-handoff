/**
 * One package catalogue for the M&U booking receptionist (27 Sep 2026).
 *
 * Owner-approved prices (28 Sep 2026): A$699 / A$1,099 / A$1,999 per month and A$0.80 / A$0.75 / A$0.70
 * per extra minute, with 400 / 1,000 / 1,800 included minutes as launch allowances; all ex GST, and M&U is
 * GST registered, so GST is added. Setup fees (A$990 / A$1,490 / A$2,490) remain PROPOSED: setupStatus
 * gates them, and nothing may invoice a proposed setup fee.
 *
 * Capability states are deliberately conservative:
 *   - "available"    works on the current live line today (message-taking prompt v3, 000 line).
 *   - "at-go-live"   code exists in D:/MU-Receptionist-wt-prompt but awaits owner activation
 *                    (deploy, migrations, Retell tools, Twilio messaging). Never sold as live.
 *   - "not-offered"  not built or not accepted; excluded from every tier.
 * A catalogue entry never enables a provider tool; see projectReceptionistConfiguration.
 */
export type GstTreatment = "inclusive" | "exclusive" | "none";
export type PackagePrice = { cents: number; currency: "AUD"; gst: GstTreatment };
export type CapabilityState = "available" | "at-go-live" | "not-offered";
export type PackageCapability = { id: string; label: string; state: CapabilityState; evidence: string };
export type Sector = "dental" | "property" | "legal";
export type UsageScenario = {
  id: "low" | "base" | "high"; label: string;
  /** Per client per month. Synthetic planning assumptions, never caller records. */
  calls: { count: number; seconds: number }[];
  smsSegments: number; supportMinutes: number;
};
export type PackageId = "receptionist-essential" | "receptionist-professional" | "receptionist-premium";
export type ReceptionistPackage = {
  id: PackageId;
  tier: 1 | 2 | 3;
  version: string;
  name: string;
  shortName: string;
  kind: "receptionist";
  audience: string;
  sectors: Sector[];
  pricing: {
    /** Approval of the monthly price, included minutes and extra-minute rate. */
    status: "proposed" | "approved";
    approvedAt: string | null;
    approvalReference: string | null;
    setup: PackagePrice;
    /** Setup fees are approved separately. While "proposed", nothing may invoice them. */
    setupStatus: "proposed" | "approved";
    monthly: PackagePrice;
    includedMinutes: number;
    overagePerMinute: PackagePrice;
    includedSmsSegments: number;
    extraSmsSegment: PackagePrice;
    /** Per-second usage, summed per billing period, rounded up to a whole minute once. */
    customerBilling: "per-second-aggregate-period";
    billing: { incrementSeconds: 1; periodRounding: "ceil-minute"; minimumBillableSeconds: number; rollover: false; receptionistRoundingMode: "PER_PERIOD"; excluded: string[] };
    minimumTermMonths: number;
    noticeDays: number;
    rationale: string;
  };
  inclusions: {
    phoneNumbers: number; locations: number; calendars: number;
    concurrentCallsFairUse: number;
    coverModes: string[];
    sms: string[];
    reports: string[];
  };
  support: { hours: string; firstResponse: string; channels: string[]; reviews: string };
  fairUse: string[];
  model: { onboardingMinutes: number; scenarios: readonly UsageScenario[] };
  readiness: { state: "internal-testing" | "unsupported"; checkedAt: string; evidence: string[]; releaseGates: string[] };
  functions: PackageCapability[];
  integrations: { name: string; state: "live" | "local-code" | "absent"; limitation: string }[];
  limitations: string[];
  onboarding: string[];
};

export const CATALOGUE_VERSION = "2026-09-27";
const date = CATALOGUE_VERSION;
const exGst = (cents: number): PackagePrice => ({ cents, currency: "AUD", gst: "exclusive" });
const RX = "D:/MU-Receptionist-wt-prompt (branch fix/prompt-truth-20260927)";
const EVIDENCE = {
  prompt: `${RX}: prompt v3 applied to the Retell draft 27 Sep (message-taking, AI + recording disclosure, 000 first); docs/sales/dental-call-pack-2026-09-28/receptionist-prompt/v3-live-2026-09-27.md`,
  booking: `${RX}: src/lib/calendar/* (Google Calendar, Cal.com adapters), src/app/api/retell/tools/route.ts, docs/BOOKING-DEMO-ENABLEMENT.md (commit 4b8f483; new booking paths not yet test-proven; deploy, migrations and Retell tools need owner yes)`,
  sms: `${RX}: src/lib/sms/* + docs/SMS-ENABLEMENT.md STATUS 27 Sep (built and tested: send functions, STOP webhook, reminder cron, 85 tests; dry-run by default, nothing sent, not deployed; Twilio messaging, live send and deploy need owner yes, docs/GO-LIVE-CHECKLIST.md steps 9-12)`,
  qa: `${RX}: docs/delivery/ADD-ONS.md (Call QA + weekly proof report built, synthetic data only, never run on a real call)`,
  transfer: `${RX}: TRANSFER_EXECUTION_ENABLED defaults false; audit 27 Sep found a branch that announced a transfer that never happened. Not offered.`,
  billing: `${RX}: docs/BILLING-POLICY.md (roundingMode PER_CALL default, PER_PERIOD supported; minimumBillableSeconds 5; demo calls excluded)`,
  niches: `${RX}: src/lib/buildmaster/client-profile.ts SUPPORTED_NICHES = REAL_ESTATE, DENTAL, LEGAL`,
} as const;
const GATES = [
  "Owner yes: deploy + migrations for booking and SMS (receptionist branch fix/prompt-truth-20260927)",
  "Owner yes: attach booking tools, booking prompt and inbound webhook to the Retell agent; 5 retest calls",
  "Owner yes: Twilio messaging on +61 485 011 208, STOP webhook and Vercel env; 5-text live test to the owner's own mobile",
  "Booking and SMS synthetic suites written and passing (DST, race, no slots, out of hours, opt-out)",
  "Client calendar connected and a test booking confirmed in the client's own calendar",
  "Signed service agreement after qualified legal review; client privacy policy names overseas processors (APP 1, 5, 8)",
];
const BILLING = {
  incrementSeconds: 1 as const, periodRounding: "ceil-minute" as const, minimumBillableSeconds: 5,
  rollover: false as const, receptionistRoundingMode: "PER_PERIOD" as const,
  excluded: ["Calls under 5 seconds", "Calls that never reach the receptionist", "M&U demo and test calls"],
};
const SUPPORT_HOURS = "Mon–Fri 9:00am–5:00pm Sydney time, excluding NSW public holidays";

/**
 * Owner decision (a), settled 1 Oct 2026 (source: owner brief 1 Oct 2026): "The receptionist can operate
 * during business hours, alongside staff, after hours or as overflow." Every tier has every cover mode;
 * plans differ by included minutes and extra-minute rate, not by cover mode. This replaces the audit A3
 * placeholder (28 Sep) that was held because Essential's coverModes were after hours + busy only.
 */

const common = {
  version: date, kind: "receptionist" as const, sectors: ["dental", "property", "legal"] as Sector[],
  readiness: {
    state: "internal-testing" as const, checkedAt: date,
    evidence: [EVIDENCE.prompt, EVIDENCE.booking, EVIDENCE.sms, EVIDENCE.niches],
    releaseGates: GATES,
  },
  limitations: [
    "The live demo line does not book yet: it takes a message. Booking and SMS start at go-live after owner activation and acceptance tests.",
    "Not an emergency service. Anyone describing an emergency is told to hang up and call 000.",
    "No clinical, legal or financial advice. No live transfer to a person in any tier.",
    "Books only into a connected Google Calendar or Cal.com calendar. Practice-management software (Cliniko, Dentally, Core Practice) is not integrated.",
    "Call audio and transcripts are processed by overseas providers, including in the United States.",
    "No guaranteed number of bookings, patients or revenue.",
  ],
};
const capability = (id: string, label: string, state: CapabilityState, evidence: string): PackageCapability => ({ id, label, state, evidence });
const ANSWER_ALL_MODES = "Answers calls in business hours, after hours, alongside your team or as overflow, as configured for each business; says it is automated and the call is recorded";
const baseFunctions = (answerLabel: string = ANSWER_ALL_MODES): PackageCapability[] => [
  capability("answer", answerLabel, "available", EVIDENCE.prompt),
  capability("message", "Takes a structured message and callback request", "available", EVIDENCE.prompt),
  capability("safety", "Urgent or life-threatening wording gets the 000 line first", "available", EVIDENCE.prompt),
  capability("booking", "Checks availability and books into a connected Google Calendar or Cal.com calendar, with a reference (a booking request otherwise)", "at-go-live", EVIDENCE.booking),
  capability("staff-alert", "Email alert to the practice for each new booking or urgent message", "at-go-live", EVIDENCE.booking),
  capability("sms-confirmation", "SMS booking confirmation with STOP opt-out (caller consent asked on the call)", "at-go-live", EVIDENCE.sms),
  capability("transfer", "Live transfer to a person", "not-offered", EVIDENCE.transfer),
];
const integrations = (calendars: number): ReceptionistPackage["integrations"] => [
  { name: "Retell AI voice agent + Twilio AU mobile number", state: "live", limitation: "Demo line +61 485 011 208 is live on prompt v3 (message-taking). Client numbers are set up per client." },
  { name: `Google Calendar or Cal.com (up to ${calendars})`, state: "local-code", limitation: "Adapters exist; not yet activated in production. Confirmed bookings need a connected calendar." },
  { name: "Twilio SMS (confirmations, reminders, STOP)", state: "local-code", limitation: "Built and tested (send functions, STOP webhook, reminder cron); dry-run by default, not deployed; nothing has been sent." },
  { name: "Practice-management software", state: "absent", limitation: "Cliniko, Dentally, Core Practice and similar are not integrated. Scoped separately if ever built." },
];

const essential: ReceptionistPackage = {
  ...structuredClone(common), id: "receptionist-essential", tier: 1, name: "Booking Receptionist · Essential", shortName: "Essential",
  audience: "One location that wants its calls answered and booked in business hours, after hours or as overflow.",
  pricing: {
    status: "approved", approvedAt: "2026-09-28", approvalReference: "Owner decision 28 Sep 2026: monthly price, launch allowance of included minutes and extra-minute rate approved, plus GST (M&U is GST registered). Review after 30 days or the first five paying clients. Setup fee NOT approved (setupStatus proposed).",
    setup: exGst(99000), setupStatus: "proposed", monthly: exGst(69900), includedMinutes: 400, overagePerMinute: exGst(80),
    includedSmsSegments: 200, extraSmsSegment: exGst(15),
    customerBilling: "per-second-aggregate-period", billing: structuredClone(BILLING),
    minimumTermMonths: 3, noticeDays: 30,
    rationale: "Owner-approved A$699/month and A$0.80 per extra minute (28 Sep). 400 minutes covers about 160 calls of 2.5 minutes at one location.",
  },
  inclusions: {
    phoneNumbers: 1, locations: 1, calendars: 1, concurrentCallsFairUse: 3,
    coverModes: ["After hours", "When busy / no answer", "All calls"],
    sms: ["Booking confirmation (at go-live)"],
    reports: ["Monthly usage summary: minutes used, remaining and overage"],
  },
  support: { hours: SUPPORT_HOURS, firstResponse: "Next business day", channels: ["Email", "Phone"], reviews: "Setup review after the first 2 weeks" },
  fairUse: [
    "Inbound calls to the client's own business number(s) only; no outbound or marketing calls.",
    "Up to 3 simultaneous calls; more by arrangement.",
    "Included minutes and SMS reset each billing period and do not roll over.",
  ],
  model: { onboardingMinutes: 480, scenarios: [
    { id: "low", label: "Low", calls: [{ count: 64, seconds: 150 }], smsSegments: 30, supportMinutes: 30 },
    { id: "base", label: "Base", calls: [{ count: 128, seconds: 150 }], smsSegments: 80, supportMinutes: 60 },
    { id: "high", label: "High", calls: [{ count: 240, seconds: 150 }], smsSegments: 150, supportMinutes: 120 },
  ] },
  functions: baseFunctions(),
  integrations: integrations(1),
  onboarding: [
    "45-minute kickoff: hours, services and appointment lengths, what may be booked by phone, urgent-call wording",
    "Connect one Google Calendar or Cal.com calendar (client grants access; no passwords shared)",
    "Configure prompt, knowledge summary and disclosures; set billing to per-period rounding",
    "Client switches on call forwarding in the agreed cover; until Acceptance the line only takes messages; rollback = switch it off",
    "5 scripted test calls with the client: a booking (or booking request), an urgent-wording call, and calls through the configured cover; a text too when SMS is configured",
  ],
};

const professional: ReceptionistPackage = {
  ...structuredClone(common), id: "receptionist-professional", tier: 2, name: "Booking Receptionist · Professional", shortName: "Professional",
  audience: "A busy practice with several practitioners that wants reminders and a weekly report.",
  pricing: {
    status: "approved", approvedAt: "2026-09-28", approvalReference: "Owner decision 28 Sep 2026: monthly price, launch allowance of included minutes and extra-minute rate approved, plus GST (M&U is GST registered). Review after 30 days or the first five paying clients. Setup fee NOT approved (setupStatus proposed).",
    setup: exGst(149000), setupStatus: "proposed", monthly: exGst(109900), includedMinutes: 1000, overagePerMinute: exGst(75),
    includedSmsSegments: 600, extraSmsSegment: exGst(15),
    customerBilling: "per-second-aggregate-period", billing: structuredClone(BILLING),
    minimumTermMonths: 3, noticeDays: 30,
    rationale: "Owner-approved A$1,099/month and A$0.75 per extra minute (28 Sep). 2.5x Essential's minutes for 1.57x the price; reminders and the weekly proof report add retention value, and support time doubles.",
  },
  inclusions: {
    phoneNumbers: 1, locations: 1, calendars: 3, concurrentCallsFairUse: 5,
    coverModes: ["After hours", "When busy / no answer", "All calls"],
    sms: ["Booking confirmation (at go-live)", "Appointment reminder (at go-live)", "Callback confirmation (at go-live)"],
    reports: ["Monthly usage summary", "Weekly proof report: calls, bookings, urgent calls routed, issues flagged (at go-live)"],
  },
  support: { hours: SUPPORT_HOURS, firstResponse: "Same business day (within 4 business hours)", channels: ["Email", "Phone"], reviews: "Monthly 20-minute check-in" },
  fairUse: [
    "Inbound calls to the client's own business number(s) only; no outbound or marketing calls.",
    "Up to 5 simultaneous calls; more by arrangement.",
    "Included minutes and SMS reset each billing period and do not roll over.",
  ],
  model: { onboardingMinutes: 720, scenarios: [
    { id: "low", label: "Low", calls: [{ count: 160, seconds: 150 }], smsSegments: 120, supportMinutes: 60 },
    { id: "base", label: "Base", calls: [{ count: 320, seconds: 150 }], smsSegments: 300, supportMinutes: 120 },
    { id: "high", label: "High", calls: [{ count: 560, seconds: 150 }], smsSegments: 520, supportMinutes: 240 },
  ] },
  functions: [...baseFunctions().slice(0, 6),
    capability("sms-reminder", "SMS appointment reminders outside 8pm–9am quiet hours", "at-go-live", EVIDENCE.sms),
    capability("weekly-report", "Weekly proof report with automatic call-quality checks", "at-go-live", EVIDENCE.qa),
    baseFunctions()[6]],
  integrations: integrations(3),
  onboarding: [
    ...essential.onboarding.slice(0, 1),
    "Connect up to 3 practitioner calendars (Google Calendar or Cal.com) and map services to each",
    ...essential.onboarding.slice(2),
    "SMS consent wording and reminder timing agreed; first weekly report date set",
  ],
};

const premium: ReceptionistPackage = {
  ...structuredClone(common), id: "receptionist-premium", tier: 3, name: "Booking Receptionist · Premium", shortName: "Premium",
  audience: "Multi-location or high-volume practices that want all calls covered and M&U reviewing call quality every week.",
  pricing: {
    status: "approved", approvedAt: "2026-09-28", approvalReference: "Owner decision 28 Sep 2026: monthly price, launch allowance of included minutes and extra-minute rate approved, plus GST (M&U is GST registered). Review after 30 days or the first five paying clients. Setup fee NOT approved (setupStatus proposed).",
    setup: exGst(249000), setupStatus: "proposed", monthly: exGst(199900), includedMinutes: 1800, overagePerMinute: exGst(70),
    includedSmsSegments: 1200, extraSmsSegment: exGst(15),
    customerBilling: "per-second-aggregate-period", billing: structuredClone(BILLING),
    minimumTermMonths: 6, noticeDays: 30,
    rationale: "Owner-approved A$1,999/month and A$0.70 per extra minute (28 Sep). Covers up to 3 numbers and 3 extra hours a month of M&U call review.",
  },
  inclusions: {
    phoneNumbers: 3, locations: 3, calendars: 10, concurrentCallsFairUse: 8,
    coverModes: ["After hours", "When busy / no answer", "All calls"],
    sms: ["Booking confirmation (at go-live)", "Appointment reminder (at go-live)", "Callback confirmation (at go-live)"],
    reports: ["Monthly usage summary", "Weekly proof report (at go-live)", "M&U works the call-review queue weekly and writes fix notes (at go-live)"],
  },
  support: { hours: SUPPORT_HOURS, firstResponse: "Within 2 business hours", channels: ["Email", "Phone", "Named contact"], reviews: "Monthly 45-minute optimisation review" },
  fairUse: [
    "Inbound calls to the client's own business number(s) only; no outbound or marketing calls.",
    "Up to 8 simultaneous calls across locations; more by arrangement.",
    "Included minutes and SMS reset each billing period and do not roll over.",
  ],
  model: { onboardingMinutes: 1200, scenarios: [
    { id: "low", label: "Low", calls: [{ count: 288, seconds: 150 }], smsSegments: 220, supportMinutes: 90 },
    { id: "base", label: "Base", calls: [{ count: 576, seconds: 150 }], smsSegments: 540, supportMinutes: 180 },
    { id: "high", label: "High", calls: [{ count: 1008, seconds: 150 }], smsSegments: 950, supportMinutes: 360 },
  ] },
  functions: [...professional.functions.slice(0, 8),
    capability("assured-review", "M&U reviews flagged calls weekly and fixes prompt or knowledge gaps", "at-go-live", EVIDENCE.qa),
    baseFunctions()[6]],
  integrations: integrations(10),
  onboarding: [
    ...essential.onboarding.slice(0, 1),
    "Connect up to 10 calendars across up to 3 locations; one number per location",
    ...essential.onboarding.slice(2),
    "SMS consent wording and reminder timing agreed; first weekly report date set",
    "30-day hypercare: daily call-review for the first 2 weeks, then weekly",
  ],
};

export const RECEPTIONIST_PACKAGES: readonly ReceptionistPackage[] = [essential, professional, premium];
export const UNSUPPORTED_SECTORS = [{ sector: "trades", reason: "No trades playbook in SUPPORTED_NICHES; video material labels it 'Example trade set-up'. Not sold." }] as const;

/** Ids used by older callers (the Operations workbench before 27 Sep). Resolve, never expose. */
export const LEGACY_PACKAGE_ALIASES: Readonly<Record<string, PackageId>> = {
  "dental-receptionist": "receptionist-essential",
  "property-receptionist": "receptionist-essential",
  "legal-receptionist": "receptionist-essential",
};

export function getReceptionistPackage(id: string): ReceptionistPackage {
  const resolved = LEGACY_PACKAGE_ALIASES[id] ?? id;
  const result = RECEPTIONIST_PACKAGES.find((entry) => entry.id === resolved);
  if (!result) throw new Error(`Unknown package: ${id}`);
  return result;
}

/** A$ string for cents, e.g. 69900 -> "A$699.00". */
export function formatAud(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("cents must be a safe integer");
  const sign = cents < 0 ? "-" : ""; const abs = Math.abs(cents);
  return `${sign}A$${Math.floor(abs / 100).toLocaleString("en-AU")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Ex/incl GST display for a price. M&U is GST registered (owner decision 28 Sep 2026): 10% GST is added. */
export function priceDisplay(price: PackagePrice) {
  const cents = BigInt(price.cents);
  const ex = price.gst === "inclusive" ? cents - (cents + 5n) / 11n : cents;
  const inc = price.gst === "exclusive" ? cents + (cents + 5n) / 10n : cents;
  return { exGstCents: Number(ex), inclGstCents: Number(inc) };
}

/** Pure document data; serialisable and detached so a proposal editor cannot mutate the catalogue. */
export function projectPackageProposal(id: string) {
  const pkg = getReceptionistPackage(id);
  return structuredClone({
    catalogueId: pkg.id, catalogueVersion: pkg.version, title: pkg.name, tier: pkg.tier, shortName: pkg.shortName,
    audience: pkg.audience, sectors: pkg.sectors,
    pricing: pkg.pricing, display: {
      monthly: priceDisplay(pkg.pricing.monthly), setup: priceDisplay(pkg.pricing.setup), setupStatus: pkg.pricing.setupStatus,
      overagePerMinute: priceDisplay(pkg.pricing.overagePerMinute), extraSmsSegment: priceDisplay(pkg.pricing.extraSmsSegment),
      gstNote: "Prices are quoted excluding GST. M&U Ventures is registered for GST, so 10% GST is added to every invoice.",
    },
    inclusions: pkg.inclusions, support: pkg.support, fairUse: pkg.fairUse,
    readiness: pkg.readiness, scope: pkg.functions,
    integrations: pkg.integrations, limitations: pkg.limitations, onboarding: pkg.onboarding,
    approvalRequired: pkg.pricing.status !== "approved", publishable: false as const,
  });
}

const NICHE = { dental: "DENTAL", property: "REAL_ESTATE", legal: "LEGAL" } as const;
/** Configuration draft only. Never translates a catalogue selection into enabled provider tools. */
export function projectReceptionistConfiguration(id: string, sector: Sector | null = null) {
  const pkg = getReceptionistPackage(id);
  if (sector !== null && !pkg.sectors.includes(sector)) throw new Error(`Unsupported sector: ${sector}`);
  return structuredClone({
    catalogueId: pkg.id, catalogueVersion: pkg.version,
    niche: sector ? NICHE[sector] : null,
    supportedNiches: pkg.sectors.map((s) => NICHE[s]),
    configurationState: "draft-requires-tenant-acceptance" as const,
    provisionable: false as const,
    enabledTools: [] as string[],
    calendarConfigured: false, transferConfigured: false, smsConfigured: false,
    calendarsAllowed: pkg.inclusions.calendars, phoneNumbersAllowed: pkg.inclusions.phoneNumbers,
    includedMinutes: pkg.pricing.includedMinutes,
    includedSmsSegments: pkg.pricing.includedSmsSegments,
    customerBilling: pkg.pricing.customerBilling,
    roundingMode: pkg.pricing.billing.receptionistRoundingMode,
    minimumBillableSeconds: pkg.pricing.billing.minimumBillableSeconds,
    priceApproval: pkg.pricing.status,
    onboarding: pkg.onboarding, releaseGates: pkg.readiness.releaseGates,
  });
}

/** Stable, versioned integration manifest. No wall-clock timestamp or machine state. */
export function exportReceptionistCatalogueJson(): string {
  return JSON.stringify({
    schemaVersion: 2,
    catalogueVersion: date,
    source: "src/lib/receptionist-packages.ts",
    mode: "draft-only",
    liveCapabilitiesVerified: false,
    liveLineBooks: false,
    gstBasis: "Quoted ex GST; M&U is GST registered, so 10% GST is added.",
    unsupportedSectors: UNSUPPORTED_SECTORS,
    packages: [...RECEPTIONIST_PACKAGES].sort((a, b) => a.tier - b.tier).map((pkg) => ({
      ...projectPackageProposal(pkg.id), kind: pkg.kind,
      configurationDraft: projectReceptionistConfiguration(pkg.id),
    })),
  }, null, 2) + "\n";
}
