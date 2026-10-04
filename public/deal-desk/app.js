// src/lib/receptionist-packages.ts
var CATALOGUE_VERSION = "2026-09-27";
var date = CATALOGUE_VERSION;
var exGst = (cents) => ({ cents, currency: "AUD", gst: "exclusive" });
var RX = "D:/MU-Receptionist-wt-prompt (branch fix/prompt-truth-20260927)";
var EVIDENCE = {
  prompt: `${RX}: prompt v3 applied to the Retell draft 27 Sep (message-taking, AI + recording disclosure, 000 first); docs/sales/dental-call-pack-2026-09-28/receptionist-prompt/v3-live-2026-09-27.md`,
  booking: `${RX}: src/lib/calendar/* (Google Calendar, Cal.com adapters), src/app/api/retell/tools/route.ts, docs/BOOKING-DEMO-ENABLEMENT.md (commit 4b8f483; new booking paths not yet test-proven; deploy, migrations and Retell tools need owner yes)`,
  sms: `${RX}: src/lib/sms/* + docs/SMS-ENABLEMENT.md STATUS 27 Sep (built and tested: send functions, STOP webhook, reminder cron, 85 tests; dry-run by default, nothing sent, not deployed; Twilio messaging, live send and deploy need owner yes, docs/GO-LIVE-CHECKLIST.md steps 9-12)`,
  qa: `${RX}: docs/delivery/ADD-ONS.md (Call QA + weekly proof report built, synthetic data only, never run on a real call)`,
  transfer: `${RX}: TRANSFER_EXECUTION_ENABLED defaults false; audit 27 Sep found a branch that announced a transfer that never happened. Not offered.`,
  billing: `${RX}: docs/BILLING-POLICY.md (roundingMode PER_CALL default, PER_PERIOD supported; minimumBillableSeconds 5; demo calls excluded)`,
  niches: `${RX}: src/lib/buildmaster/client-profile.ts SUPPORTED_NICHES = REAL_ESTATE, DENTAL, LEGAL`
};
var GATES = [
  "Owner yes: deploy + migrations for booking and SMS (receptionist branch fix/prompt-truth-20260927)",
  "Owner yes: attach booking tools, booking prompt and inbound webhook to the Retell agent; 5 retest calls",
  "Owner yes: Twilio messaging on +61 485 011 208, STOP webhook and Vercel env; 5-text live test to the owner's own mobile",
  "Booking and SMS synthetic suites written and passing (DST, race, no slots, out of hours, opt-out)",
  "Client calendar connected and a test booking confirmed in the client's own calendar",
  "Signed service agreement after qualified legal review; client privacy policy names overseas processors (APP 1, 5, 8)"
];
var BILLING = {
  incrementSeconds: 1,
  periodRounding: "ceil-minute",
  minimumBillableSeconds: 5,
  rollover: false,
  receptionistRoundingMode: "PER_PERIOD",
  excluded: ["Calls under 5 seconds", "Calls that never reach the receptionist", "M&U demo and test calls"]
};
var SUPPORT_HOURS = "Mon–Fri 9:00am–5:00pm Sydney time, excluding NSW public holidays";
var common = {
  version: date,
  kind: "receptionist",
  sectors: ["dental", "property", "legal"],
  readiness: {
    state: "internal-testing",
    checkedAt: date,
    evidence: [EVIDENCE.prompt, EVIDENCE.booking, EVIDENCE.sms, EVIDENCE.niches],
    releaseGates: GATES
  },
  limitations: [
    "The live demo line does not book yet: it takes a message. Booking and SMS start at go-live after owner activation and acceptance tests.",
    "Not an emergency service. Anyone describing an emergency is told to hang up and call 000.",
    "No clinical, legal or financial advice. No live transfer to a person in any tier.",
    "Books only into a connected Google Calendar or Cal.com calendar. Practice-management software (Cliniko, Dentally, Core Practice) is not integrated.",
    "Call audio and transcripts are processed by overseas providers, including in the United States.",
    "No guaranteed number of bookings, patients or revenue."
  ]
};
var capability = (id, label, state, evidence) => ({ id, label, state, evidence });
var ANSWER_ALL_MODES = "Answers calls in business hours, after hours, alongside your team or as overflow, as configured for each business; says it is automated and the call is recorded";
var baseFunctions = (answerLabel = ANSWER_ALL_MODES) => [
  capability("answer", answerLabel, "available", EVIDENCE.prompt),
  capability("message", "Takes a structured message and callback request", "available", EVIDENCE.prompt),
  capability("safety", "Urgent or life-threatening wording gets the 000 line first", "available", EVIDENCE.prompt),
  capability("booking", "Checks availability and books into a connected Google Calendar or Cal.com calendar, with a reference (a booking request otherwise)", "at-go-live", EVIDENCE.booking),
  capability("staff-alert", "Email alert to the practice for each new booking or urgent message", "at-go-live", EVIDENCE.booking),
  capability("sms-confirmation", "SMS booking confirmation with STOP opt-out (caller consent asked on the call)", "at-go-live", EVIDENCE.sms),
  capability("transfer", "Live transfer to a person", "not-offered", EVIDENCE.transfer)
];
var integrations = (calendars) => [
  { name: "Retell AI voice agent + Twilio AU mobile number", state: "live", limitation: "Demo line +61 485 011 208 is live on prompt v3 (message-taking). Client numbers are set up per client." },
  { name: `Google Calendar or Cal.com (up to ${calendars})`, state: "local-code", limitation: "Adapters exist; not yet activated in production. Confirmed bookings need a connected calendar." },
  { name: "Twilio SMS (confirmations, reminders, STOP)", state: "local-code", limitation: "Built and tested (send functions, STOP webhook, reminder cron); dry-run by default, not deployed; nothing has been sent." },
  { name: "Practice-management software", state: "absent", limitation: "Cliniko, Dentally, Core Practice and similar are not integrated. Scoped separately if ever built." }
];
var essential = {
  ...structuredClone(common),
  id: "receptionist-essential",
  tier: 1,
  name: "Booking Receptionist · Essential",
  shortName: "Essential",
  audience: "One location that wants its calls answered and booked in business hours, after hours or as overflow.",
  pricing: {
    status: "approved",
    approvedAt: "2026-09-28",
    approvalReference: "Owner decision 28 Sep 2026: monthly price, launch allowance of included minutes and extra-minute rate approved, plus GST (M&U is GST registered). Review after 30 days or the first five paying clients. Setup fee NOT approved (setupStatus proposed).",
    setup: exGst(99000),
    setupStatus: "proposed",
    monthly: exGst(69900),
    includedMinutes: 400,
    overagePerMinute: exGst(80),
    includedSmsSegments: 200,
    extraSmsSegment: exGst(15),
    customerBilling: "per-second-aggregate-period",
    billing: structuredClone(BILLING),
    minimumTermMonths: 3,
    noticeDays: 30,
    rationale: "Owner-approved A$699/month and A$0.80 per extra minute (28 Sep). 400 minutes covers about 160 calls of 2.5 minutes at one location."
  },
  inclusions: {
    phoneNumbers: 1,
    locations: 1,
    calendars: 1,
    concurrentCallsFairUse: 3,
    coverModes: ["After hours", "When busy / no answer", "All calls"],
    sms: ["Booking confirmation (at go-live)"],
    reports: ["Monthly usage summary: minutes used, remaining and overage"]
  },
  support: { hours: SUPPORT_HOURS, firstResponse: "Next business day", channels: ["Email", "Phone"], reviews: "Setup review after the first 2 weeks" },
  fairUse: [
    "Inbound calls to the client's own business number(s) only; no outbound or marketing calls.",
    "Up to 3 simultaneous calls; more by arrangement.",
    "Included minutes and SMS reset each billing period and do not roll over."
  ],
  model: { onboardingMinutes: 480, scenarios: [
    { id: "low", label: "Low", calls: [{ count: 64, seconds: 150 }], smsSegments: 30, supportMinutes: 30 },
    { id: "base", label: "Base", calls: [{ count: 128, seconds: 150 }], smsSegments: 80, supportMinutes: 60 },
    { id: "high", label: "High", calls: [{ count: 240, seconds: 150 }], smsSegments: 150, supportMinutes: 120 }
  ] },
  functions: baseFunctions(),
  integrations: integrations(1),
  onboarding: [
    "45-minute kickoff: hours, services and appointment lengths, what may be booked by phone, urgent-call wording",
    "Connect one Google Calendar or Cal.com calendar (client grants access; no passwords shared)",
    "Configure prompt, knowledge summary and disclosures; set billing to per-period rounding",
    "Client switches on call forwarding in the agreed cover; until Acceptance the line only takes messages; rollback = switch it off",
    "5 scripted test calls with the client: a booking (or booking request), an urgent-wording call, and calls through the configured cover; a text too when SMS is configured"
  ]
};
var professional = {
  ...structuredClone(common),
  id: "receptionist-professional",
  tier: 2,
  name: "Booking Receptionist · Professional",
  shortName: "Professional",
  audience: "A busy practice with several practitioners that wants reminders and a weekly report.",
  pricing: {
    status: "approved",
    approvedAt: "2026-09-28",
    approvalReference: "Owner decision 28 Sep 2026: monthly price, launch allowance of included minutes and extra-minute rate approved, plus GST (M&U is GST registered). Review after 30 days or the first five paying clients. Setup fee NOT approved (setupStatus proposed).",
    setup: exGst(149000),
    setupStatus: "proposed",
    monthly: exGst(109900),
    includedMinutes: 1000,
    overagePerMinute: exGst(75),
    includedSmsSegments: 600,
    extraSmsSegment: exGst(15),
    customerBilling: "per-second-aggregate-period",
    billing: structuredClone(BILLING),
    minimumTermMonths: 3,
    noticeDays: 30,
    rationale: "Owner-approved A$1,099/month and A$0.75 per extra minute (28 Sep). 2.5x Essential's minutes for 1.57x the price; reminders and the weekly proof report add retention value, and support time doubles."
  },
  inclusions: {
    phoneNumbers: 1,
    locations: 1,
    calendars: 3,
    concurrentCallsFairUse: 5,
    coverModes: ["After hours", "When busy / no answer", "All calls"],
    sms: ["Booking confirmation (at go-live)", "Appointment reminder (at go-live)", "Callback confirmation (at go-live)"],
    reports: ["Monthly usage summary", "Weekly proof report: calls, bookings, urgent calls routed, issues flagged (at go-live)"]
  },
  support: { hours: SUPPORT_HOURS, firstResponse: "Same business day (within 4 business hours)", channels: ["Email", "Phone"], reviews: "Monthly 20-minute check-in" },
  fairUse: [
    "Inbound calls to the client's own business number(s) only; no outbound or marketing calls.",
    "Up to 5 simultaneous calls; more by arrangement.",
    "Included minutes and SMS reset each billing period and do not roll over."
  ],
  model: { onboardingMinutes: 720, scenarios: [
    { id: "low", label: "Low", calls: [{ count: 160, seconds: 150 }], smsSegments: 120, supportMinutes: 60 },
    { id: "base", label: "Base", calls: [{ count: 320, seconds: 150 }], smsSegments: 300, supportMinutes: 120 },
    { id: "high", label: "High", calls: [{ count: 560, seconds: 150 }], smsSegments: 520, supportMinutes: 240 }
  ] },
  functions: [
    ...baseFunctions().slice(0, 6),
    capability("sms-reminder", "SMS appointment reminders outside 8pm–9am quiet hours", "at-go-live", EVIDENCE.sms),
    capability("weekly-report", "Weekly proof report with automatic call-quality checks", "at-go-live", EVIDENCE.qa),
    baseFunctions()[6]
  ],
  integrations: integrations(3),
  onboarding: [
    ...essential.onboarding.slice(0, 1),
    "Connect up to 3 practitioner calendars (Google Calendar or Cal.com) and map services to each",
    ...essential.onboarding.slice(2),
    "SMS consent wording and reminder timing agreed; first weekly report date set"
  ]
};
var premium = {
  ...structuredClone(common),
  id: "receptionist-premium",
  tier: 3,
  name: "Booking Receptionist · Premium",
  shortName: "Premium",
  audience: "Multi-location or high-volume practices that want all calls covered and M&U reviewing call quality every week.",
  pricing: {
    status: "approved",
    approvedAt: "2026-09-28",
    approvalReference: "Owner decision 28 Sep 2026: monthly price, launch allowance of included minutes and extra-minute rate approved, plus GST (M&U is GST registered). Review after 30 days or the first five paying clients. Setup fee NOT approved (setupStatus proposed).",
    setup: exGst(249000),
    setupStatus: "proposed",
    monthly: exGst(199900),
    includedMinutes: 1800,
    overagePerMinute: exGst(70),
    includedSmsSegments: 1200,
    extraSmsSegment: exGst(15),
    customerBilling: "per-second-aggregate-period",
    billing: structuredClone(BILLING),
    minimumTermMonths: 6,
    noticeDays: 30,
    rationale: "Owner-approved A$1,999/month and A$0.70 per extra minute (28 Sep). Covers up to 3 numbers and 3 extra hours a month of M&U call review."
  },
  inclusions: {
    phoneNumbers: 3,
    locations: 3,
    calendars: 10,
    concurrentCallsFairUse: 8,
    coverModes: ["After hours", "When busy / no answer", "All calls"],
    sms: ["Booking confirmation (at go-live)", "Appointment reminder (at go-live)", "Callback confirmation (at go-live)"],
    reports: ["Monthly usage summary", "Weekly proof report (at go-live)", "M&U works the call-review queue weekly and writes fix notes (at go-live)"]
  },
  support: { hours: SUPPORT_HOURS, firstResponse: "Within 2 business hours", channels: ["Email", "Phone", "Named contact"], reviews: "Monthly 45-minute optimisation review" },
  fairUse: [
    "Inbound calls to the client's own business number(s) only; no outbound or marketing calls.",
    "Up to 8 simultaneous calls across locations; more by arrangement.",
    "Included minutes and SMS reset each billing period and do not roll over."
  ],
  model: { onboardingMinutes: 1200, scenarios: [
    { id: "low", label: "Low", calls: [{ count: 288, seconds: 150 }], smsSegments: 220, supportMinutes: 90 },
    { id: "base", label: "Base", calls: [{ count: 576, seconds: 150 }], smsSegments: 540, supportMinutes: 180 },
    { id: "high", label: "High", calls: [{ count: 1008, seconds: 150 }], smsSegments: 950, supportMinutes: 360 }
  ] },
  functions: [
    ...professional.functions.slice(0, 8),
    capability("assured-review", "M&U reviews flagged calls weekly and fixes prompt or knowledge gaps", "at-go-live", EVIDENCE.qa),
    baseFunctions()[6]
  ],
  integrations: integrations(10),
  onboarding: [
    ...essential.onboarding.slice(0, 1),
    "Connect up to 10 calendars across up to 3 locations; one number per location",
    ...essential.onboarding.slice(2),
    "SMS consent wording and reminder timing agreed; first weekly report date set",
    "30-day hypercare: daily call-review for the first 2 weeks, then weekly"
  ]
};
var RECEPTIONIST_PACKAGES = [essential, professional, premium];
var LEGACY_PACKAGE_ALIASES = {
  "dental-receptionist": "receptionist-essential",
  "property-receptionist": "receptionist-essential",
  "legal-receptionist": "receptionist-essential"
};
function getReceptionistPackage(id) {
  const resolved = LEGACY_PACKAGE_ALIASES[id] ?? id;
  const result = RECEPTIONIST_PACKAGES.find((entry) => entry.id === resolved);
  if (!result)
    throw new Error(`Unknown package: ${id}`);
  return result;
}
function formatAud(cents) {
  if (!Number.isSafeInteger(cents))
    throw new Error("cents must be a safe integer");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}A$${Math.floor(abs / 100).toLocaleString("en-AU")}.${String(abs % 100).padStart(2, "0")}`;
}
function priceDisplay(price) {
  const cents = BigInt(price.cents);
  const ex = price.gst === "inclusive" ? cents - (cents + 5n) / 11n : cents;
  const inc = price.gst === "exclusive" ? cents + (cents + 5n) / 10n : cents;
  return { exGstCents: Number(ex), inclGstCents: Number(inc) };
}
function projectPackageProposal(id) {
  const pkg = getReceptionistPackage(id);
  return structuredClone({
    catalogueId: pkg.id,
    catalogueVersion: pkg.version,
    title: pkg.name,
    tier: pkg.tier,
    shortName: pkg.shortName,
    audience: pkg.audience,
    sectors: pkg.sectors,
    pricing: pkg.pricing,
    display: {
      monthly: priceDisplay(pkg.pricing.monthly),
      setup: priceDisplay(pkg.pricing.setup),
      setupStatus: pkg.pricing.setupStatus,
      overagePerMinute: priceDisplay(pkg.pricing.overagePerMinute),
      extraSmsSegment: priceDisplay(pkg.pricing.extraSmsSegment),
      gstNote: "Prices are quoted excluding GST. M&U Ventures is registered for GST, so 10% GST is added to every invoice."
    },
    inclusions: pkg.inclusions,
    support: pkg.support,
    fairUse: pkg.fairUse,
    readiness: pkg.readiness,
    scope: pkg.functions,
    integrations: pkg.integrations,
    limitations: pkg.limitations,
    onboarding: pkg.onboarding,
    approvalRequired: pkg.pricing.status !== "approved",
    publishable: false
  });
}

// src/lib/business-economics.ts
var ECONOMICS_AS_OF = "2026-09-28";
var RATE_SOURCES = {
  retell: "https://www.retellai.com/pricing",
  twilioSip: "https://www.twilio.com/en-us/sip-trunking/pricing/au",
  twilioSms: "https://www.twilio.com/en-us/sms/pricing/au",
  twilio: "https://www.twilio.com/en-us/voice/pricing/au",
  rounding: "https://help.twilio.com/articles/223132307-How-do-you-round-minutes-for-billing-",
  twilioNumbersCsv: "https://assets.cdn.prod.twilio.com/pricing-csv/SiteNumbersPricing.csv",
  twilioTerminationCsv: "https://assets.cdn.prod.twilio.com/pricing-csv/OutboundSipTrunkPricing.csv",
  retellTransfer: "https://docs.retellai.com/build/single-multi-prompt/transfer-call",
  stripe: "https://stripe.com/au/pricing",
  vercel: "https://vercel.com/pricing",
  neon: "https://neon.com/pricing",
  rba: "https://www.rba.gov.au/statistics/frequency/exchange-rates.html",
  gst: "https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/claiming-gst-credits"
};
var rate = (item) => ({
  checkedAt: ECONOMICS_AS_OF,
  effectiveFrom: null,
  gst: "unknown",
  creditEligible: false,
  ...item
});
var TWILIO_CURRENCY = "Twilio's AU page shows '$' with no currency label; modelled as USD, the dearer reading. Confirm on the invoice.";
var DEFAULT_COST_RATES = [
  rate({ id: "retell", label: "Retell voice infra + Claude 4.5 Haiku + ElevenLabs voice tier", currency: "USD", micros: 120000, basis: "minute", incrementSeconds: 1, covers: ["voice-infra", "stt", "tts", "llm"], source: RATE_SOURCES.retell, evidence: "public-list", note: "Conservative base, kept from 27 Sep: US$0.055 infra + US$0.025 Claude 4.5 Haiku + US$0.040 ElevenLabs tier (all re-read 28 Sep). The receptionist generator (provision-plan.ts) provisions gpt-4.1-mini + retell-Cimo, a Retell platform voice = US$0.0828; the live demo agent was recorded on Claude 4.5 Haiku (27 Sep read) = US$0.095 if its voice is platform tier. See RETELL_CONFIGURATIONS. Per second, silence billed. BYO Twilio SIP: Retell charges no telephony." }),
  rate({ id: "carrier", label: "Twilio Elastic SIP origination, AU mobile", currency: "USD", micros: 6000, basis: "minute", incrementSeconds: 60, covers: ["carrier-inbound"], source: RATE_SOURCES.twilioSip, evidence: "public-list", effectiveFrom: "2026-08", note: `0.0060/min inbound to the SIP trunk (page and numbers CSV, 'pricing current as of August 2026'). Rounded up per call per minute (conservative). ${TWILIO_CURRENCY}` }),
  rate({ id: "number", label: "Twilio AU mobile number", currency: "USD", micros: 8250000, basis: "number-month", covers: ["number"], source: RATE_SOURCES.twilioSip, evidence: "public-list", effectiveFrom: "2026-08", note: `8.25/month per mobile number (the demo line +61 485 011 208 is a mobile); a local number is 2.50 on the SIP page. ${TWILIO_CURRENCY}` }),
  rate({ id: "sms", label: "Twilio AU outbound SMS", currency: "USD", micros: 51500, basis: "sms-segment", covers: ["sms-outbound"], source: RATE_SOURCES.twilioSms, evidence: "public-list", note: `0.0515 per outbound segment; inbound STOP replies 0.0075 are negligible and excluded; failed-message fee 0.001. Carrier fees 'may apply': see sms-carrier-fees (unknown). ${TWILIO_CURRENCY}` }),
  rate({ id: "transfer-termination", label: "Twilio Elastic SIP termination to AU mobile (cold-transfer leg)", currency: "USD", micros: 71000, basis: "transfer-minute", incrementSeconds: 60, covers: ["carrier-transfer-outbound"], source: RATE_SOURCES.twilioSip, evidence: "public-list", effectiveFrom: "2026-08", note: `0.0710/min to AU mobile (0.0212 to landlines), rounded up per leg. Only if transfer is ever offered: it is 'not-offered' in every tier today. Retell's AI fee stops once the caller is connected (Retell transfer docs); the carrier legs continue. ${TWILIO_CURRENCY}` }),
  rate({ id: "transfer-origination", label: "Twilio SIP origination continuing after a cold transfer", currency: "USD", micros: 6000, basis: "transfer-minute", incrementSeconds: 60, covers: ["carrier-inbound-after-transfer"], source: RATE_SOURCES.twilioSip, evidence: "public-list", effectiveFrom: "2026-08", note: `The caller's inbound leg keeps running for the transferred part of the call. Modelled as its own rounded leg (conservative). ${TWILIO_CURRENCY}` }),
  rate({ id: "webhook", label: "Vercel function invocations (webhooks, tool calls, retries, duplicates)", currency: "USD", micros: 600000, quantityPer: 1e6, basis: "webhook-event", covers: ["function-invocation"], source: RATE_SOURCES.vercel, evidence: "public-list", note: "US$0.60 per 1M invocations beyond Pro's 1M included; charged here from the first event (conservative). Active CPU per invocation is in hosting-excess (unknown)." }),
  rate({ id: "hosting", label: "Vercel Pro base (1 seat)", currency: "USD", micros: 20000000, basis: "shared-month", covers: ["hosting"], source: RATE_SOURCES.vercel, evidence: "public-list", note: "US$20/month incl. US$20 usage credit; Hobby is for personal projects, so Pro is required before billing a client. Extra seats (US$20 each) and excess usage are in hosting-excess (unknown)." }),
  rate({ id: "database", label: "Neon Postgres usage (Launch plan)", currency: "USD", micros: null, basis: "shared-month", covers: ["database"], source: RATE_SOURCES.neon, evidence: "unknown", note: "Launch: US$0.106/CU-hour + US$0.35/GB-month, no minimum, scale to zero after 5 min (re-read 28 Sep). Actual compute hours not measured; unknown, not free." }),
  rate({ id: "hosting-excess", label: "Vercel usage beyond the US$20 credit and extra seats", currency: "USD", micros: null, basis: "shared-month", covers: ["hosting-excess"], source: RATE_SOURCES.vercel, evidence: "unknown", note: "Fluid Active CPU from US$0.128/hour, data transfer US$0.15/GB beyond 1 TB, US$20 per extra seat. Usage and seat count not measured." }),
  rate({ id: "sms-carrier-fees", label: "AU carrier fees on SMS", currency: "USD", micros: null, basis: "sms-segment", covers: ["sms-carrier-fee"], source: RATE_SOURCES.twilioSms, evidence: "unknown", note: "Twilio: 'additional carrier fees may apply'. Amount not published on the AU page." }),
  rate({ id: "trunk-recording", label: "Twilio trunk call recording (if switched on)", currency: "USD", micros: null, basis: "minute", incrementSeconds: 60, covers: ["carrier-recording"], source: RATE_SOURCES.twilioSip, evidence: "unknown", note: "US$0.0025/min + US$0.0005/min-month storage if trunk recording is on. Retell records the call itself; whether trunk recording is on has not been checked (no live Twilio read allowed)." }),
  rate({ id: "notifications", label: "Staff alert email", currency: "AUD", micros: null, basis: "notification", covers: ["alert-email"], source: null, evidence: "unknown", note: "Alert channel not yet configured in production; provider and price unknown." }),
  rate({ id: "concurrency", label: "Retell concurrency above 20 free slots", currency: "USD", micros: null, basis: "shared-month", covers: ["concurrency"], source: RATE_SOURCES.retell, evidence: "unknown", note: "US$8/slot/month beyond 20 concurrent calls across ALL clients. Peak concurrency not measured." }),
  rate({ id: "subscriptions", label: "Other tools and subscriptions allocation", currency: "AUD", micros: null, basis: "shared-month", covers: ["subscriptions"], source: null, evidence: "unknown", note: "Unscoped allocation; excluded from the known-cost subtotal, not assumed free." })
];
var DEFAULT_FX = { usdPerAudMillionths: 701900, date: "2026-09-25", cardFeeBps: 300 };
var STRIPE_CARD_BPS = 170;
var STRIPE_BILLING_BPS = 70;
var DEFAULT_PAYMENT = { percentBps: STRIPE_CARD_BPS + STRIPE_BILLING_BPS, fixedCents: 30, gst: "inclusive", creditEligible: true };
var STRIPE_FROM_2026_10_01 = { percentBps: STRIPE_CARD_BPS, fixedCents: 30, source: RATE_SOURCES.stripe, verifiedOnOfficialPage: true, checkedAt: "2026-09-28" };
var DEFAULT_LABOUR_HOURLY_CENTS = 6000;
var DEFAULT_TARGET_MARGIN_BPS = 7000;
function scenariosFor(pkg) {
  return pkg.model.scenarios;
}
var SCENARIOS = scenariosFor(getReceptionistPackage("receptionist-essential"));
function integer(value, name, max = 1e9) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error(`${name} must be a non-negative safe integer ≤ ${max}`);
  return BigInt(value);
}
function safe(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new Error("Calculation exceeds safe money range");
  return n;
}
function moneyTotal(...values) {
  return safe(values.reduce((total, value) => {
    if (!Number.isSafeInteger(value))
      throw new Error("Calculation exceeds safe money range");
    return total + BigInt(value);
  }, 0n));
}
function round(n, d) {
  if (d <= 0n || n < 0n)
    throw new Error("Invalid ratio");
  return (n + d / 2n) / d;
}
function ceil(n, d) {
  if (d <= 0n || n < 0n)
    throw new Error("Invalid ratio");
  return (n + d - 1n) / d;
}
function splitGst(cents, treatment, taxable = true) {
  const value = integer(cents, "money", Number.MAX_SAFE_INTEGER);
  const gst = !taxable || treatment === "none" || treatment === "unknown" ? 0n : treatment === "inclusive" ? round(value, 11n) : round(value, 10n);
  const gross = treatment === "exclusive" ? value + gst : value;
  return { grossCents: safe(gross), netCents: safe(gross - gst), gstCents: safe(gst) };
}
function priceAmount(price, gstRegistered) {
  return splitGst(price.cents, price.gst, gstRegistered);
}
function billedSeconds(calls, increment) {
  const step = integer(increment, "billing increment", 3600);
  if (!step)
    throw new Error("Billing increment must be positive");
  return safe(calls.reduce((sum, call) => sum + integer(call.count, "call count", 1e6) * ceil(integer(call.seconds, "duration", 86400), step) * step, 0n));
}
function customerBillableSeconds(calls, minimumBillableSeconds) {
  const min = integer(minimumBillableSeconds, "minimum billable seconds", 600);
  return safe(calls.reduce((sum, call) => {
    const seconds = integer(call.seconds, "duration", 86400);
    return seconds < min ? sum : sum + integer(call.count, "call count", 1e6) * seconds;
  }, 0n));
}
function validateRates(rates) {
  const ids = new Set;
  const components = new Set;
  for (const r of rates) {
    if (ids.has(r.id))
      throw new Error(`Duplicate rate: ${r.id}`);
    ids.add(r.id);
    if (r.micros !== null)
      integer(r.micros, `${r.id} rate`, Number.MAX_SAFE_INTEGER);
    if (r.basis === "minute" || r.basis === "transfer-minute")
      billedSeconds([], r.incrementSeconds ?? 1);
    if (r.quantityPer !== undefined && (!Number.isSafeInteger(r.quantityPer) || r.quantityPer < 1))
      throw new Error(`${r.id} quantityPer must be a positive integer`);
    for (const component of r.covers) {
      if (components.has(component))
        throw new Error(`Double-counted component: ${component}`);
      components.add(component);
    }
  }
}
var PER_CLIENT = ["minute", "call", "notification", "sms-segment", "number-month", "client-month", "transfer-minute", "webhook-event"];
var PER_MINUTE_USAGE = ["minute", "call", "notification"];
function calculateEconomics(input) {
  const clients = integer(input.clients, "clients", 1e4);
  if (!clients)
    throw new Error("At least one client is required");
  const fxDate = new Date(`${input.fx.date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fx.date) || !Number.isFinite(fxDate.getTime()) || fxDate.toISOString().slice(0, 10) !== input.fx.date)
    throw new Error("FX date must be a real YYYY-MM-DD calendar date");
  const fx = integer(input.fx.usdPerAudMillionths, "USD per AUD", 1e8);
  if (!fx)
    throw new Error("FX must be positive");
  const card = integer(input.fx.cardFeeBps, "FX/card fee", 1e4);
  integer(input.supportMinutesPerClient, "support minutes");
  integer(input.supportHourlyCents, "support hourly rate");
  integer(input.onboardingMinutes, "onboarding minutes");
  integer(input.onboardingHourlyCents, "onboarding hourly rate");
  integer(input.notificationsPerClient, "notifications");
  const webhookEvents = integer(input.webhookEventsPerClient ?? 0, "webhook events");
  const transferLegs = input.transferLegs ?? [];
  billedSeconds(transferLegs, 1);
  integer(input.smsSegmentsPerClient, "SMS segments");
  integer(input.phoneNumbersPerClient, "phone numbers", 100);
  const paymentBps = integer(input.payment.percentBps, "payment percentage", 1e4);
  integer(input.payment.fixedCents, "payment fixed fee");
  integer(input.targetMarginBps, "target margin", 9999);
  const pricing = input.package.pricing;
  integer(pricing.includedMinutes, "included minutes");
  integer(pricing.includedSmsSegments, "included SMS segments");
  validateRates(input.rates);
  const actualSeconds = billedSeconds(input.calls, 1);
  const customerSeconds = customerBillableSeconds(input.calls, pricing.billing.minimumBillableSeconds);
  const callCount = safe(input.calls.reduce((n, c) => n + integer(c.count, "call count"), 0n));
  const overageMinutes = Math.max(0, Math.ceil((customerSeconds - pricing.includedMinutes * 60) / 60));
  const smsOverageSegments = Math.max(0, input.smsSegmentsPerClient - pricing.includedSmsSegments);
  const monthly = priceAmount(pricing.monthly, input.gstRegistered);
  priceAmount(pricing.overagePerMinute, input.gstRegistered);
  const overage = priceAmount({ ...pricing.overagePerMinute, cents: safe(BigInt(pricing.overagePerMinute.cents) * BigInt(overageMinutes)) }, input.gstRegistered);
  const smsOverage = priceAmount({ ...pricing.extraSmsSegment, cents: safe(BigInt(pricing.extraSmsSegment.cents) * BigInt(smsOverageSegments)) }, input.gstRegistered);
  const grossRevenue = safe((BigInt(monthly.grossCents) + BigInt(overage.grossCents) + BigInt(smsOverage.grossCents)) * clients);
  const revenue = safe((BigInt(monthly.netCents) + BigInt(overage.netCents) + BigInt(smsOverage.netCents)) * clients);
  const outputGst = grossRevenue - revenue;
  const warnings = ["Estimate only: no measured usage or invoice reconciliation supplied."];
  const lines = [];
  for (const r of input.rates) {
    if (r.micros === null) {
      warnings.push(`${r.label}: unknown, excluded from subtotal.`);
      continue;
    }
    if (r.gst === "unknown")
      warnings.push(`${r.label}: supplier GST unknown; no tax or credit assumed.`);
    let quantity = 1n;
    let divisor = 1n;
    let seconds = null;
    if (r.basis === "minute") {
      seconds = billedSeconds(input.calls, r.incrementSeconds ?? 1);
      quantity = BigInt(seconds);
      divisor = 60n;
    }
    if (r.basis === "call")
      quantity = BigInt(callCount);
    if (r.basis === "notification")
      quantity = BigInt(input.notificationsPerClient);
    if (r.basis === "sms-segment")
      quantity = BigInt(input.smsSegmentsPerClient);
    if (r.basis === "number-month")
      quantity = BigInt(input.phoneNumbersPerClient);
    if (r.basis === "transfer-minute") {
      seconds = billedSeconds(transferLegs, r.incrementSeconds ?? 1);
      quantity = BigInt(seconds);
      divisor = 60n;
    }
    if (r.basis === "webhook-event")
      quantity = webhookEvents;
    divisor *= BigInt(r.quantityPer ?? 1);
    let numerator = BigInt(r.micros) * quantity;
    let denominator = divisor * 10000n;
    if (r.currency === "USD") {
      numerator *= 1000000n * (10000n + card);
      denominator *= fx * 10000n;
    }
    const amount = safe(round(numerator, denominator));
    const tax = splitGst(amount, r.gst);
    const factor = PER_CLIENT.includes(r.basis) ? clients : 1n;
    const credit = input.gstRegistered && r.creditEligible ? tax.gstCents : 0;
    lines.push({ id: r.id, label: r.label, basis: r.basis, cashCents: safe(BigInt(tax.grossCents) * factor), inputGstCents: safe(BigInt(credit) * factor), operatingCents: safe(BigInt(tax.grossCents - credit) * factor), billedSeconds: seconds });
  }
  function payment(gross) {
    if (gross === 0)
      return { grossCents: 0, netCents: 0, gstCents: 0, operatingCents: 0, credit: 0 };
    const cents = safe(round(BigInt(gross) * paymentBps, 10000n) + BigInt(input.payment.fixedCents));
    const tax = splitGst(cents, input.payment.gst);
    const credit = input.gstRegistered && input.payment.creditEligible ? tax.gstCents : 0;
    return { ...tax, operatingCents: tax.grossCents - credit, credit };
  }
  const monthlyPayment = payment(moneyTotal(monthly.grossCents, overage.grossCents, smsOverage.grossCents));
  const paymentCost = safe(BigInt(monthlyPayment.operatingCents) * clients);
  const variable = lines.filter((l) => PER_CLIENT.includes(l.basis));
  const usageLines = variable.filter((l) => PER_MINUTE_USAGE.includes(l.basis));
  const smsLines = variable.filter((l) => l.basis === "sms-segment");
  const sum = (rows, key = "operatingCents") => safe(rows.reduce((n, row) => n + BigInt(row[key]), 0n));
  const variableCost = moneyTotal(sum(variable), paymentCost);
  const sharedCost = sum(lines.filter((l) => l.basis === "shared-month"));
  const supportPerClient = safe(round(BigInt(input.supportMinutesPerClient) * BigInt(input.supportHourlyCents), 60n));
  const support = safe(BigInt(supportPerClient) * clients);
  const contribution = moneyTotal(revenue, -variableCost);
  const operating = moneyTotal(contribution, -support, -sharedCost);
  const setupPrice = priceAmount(pricing.setup, input.gstRegistered);
  const setupPayment = payment(setupPrice.grossCents);
  const setupLabour = safe(round(BigInt(input.onboardingMinutes) * BigInt(input.onboardingHourlyCents), 60n));
  const setupCost = moneyTotal(setupLabour, setupPayment.operatingCents, sum(lines.filter((l) => l.basis === "setup")));
  const usageCost = sum(usageLines);
  const perMinute = actualSeconds > 0 ? safe(ceil(BigInt(usageCost) * 60n, clients * BigInt(actualSeconds))) : null;
  const perCall = callCount > 0 ? safe(round(BigInt(usageCost), clients * BigInt(callCount))) : null;
  const perSms = input.smsSegmentsPerClient > 0 && smsLines.length ? safe(ceil(BigInt(sum(smsLines)), clients * BigInt(input.smsSegmentsPerClient))) : null;
  const saleTaxFactor = input.gstRegistered && pricing.overagePerMinute.gst !== "none" ? 11000n : 10000n;
  const feeTaxNumerator = input.payment.gst === "exclusive" && !(input.gstRegistered && input.payment.creditEligible) ? 11000n : 10000n;
  const feeTaxDenominator = input.payment.gst === "inclusive" && input.gstRegistered && input.payment.creditEligible ? 11000n : 10000n;
  const marginDenominator = (10000n - BigInt(input.targetMarginBps)) * 10000n * feeTaxDenominator - paymentBps * saleTaxFactor * feeTaxNumerator;
  const floorFor = (cost) => cost === null || marginDenominator <= 0n ? null : safe(ceil(BigInt(cost) * 10000n * 10000n * feeTaxDenominator, marginDenominator));
  const quoted = (floor, price) => floor === null ? null : price.gst === "inclusive" && input.gstRegistered ? safe(ceil(BigInt(floor) * 11n, 10n)) : floor;
  const floorExGst = floorFor(perMinute);
  const floorQuoted = quoted(floorExGst, pricing.overagePerMinute);
  const smsFloorExGst = floorFor(perSms);
  const fixedDirect = sum(variable.filter((l) => l.basis === "client-month" || l.basis === "number-month")) / input.clients;
  const smsDirect = sum(smsLines) / input.clients;
  const basePayment = payment(monthly.grossCents).operatingCents;
  const includedHeadroom = moneyTotal(monthly.netCents, -basePayment, -Math.ceil(fixedDirect), -Math.ceil(smsDirect), -supportPerClient, -safe(ceil(BigInt(sharedCost), clients)));
  const beforeShared = moneyTotal(contribution, -support);
  const monthlyInputGst = safe(BigInt(sum(lines.filter((l) => l.basis !== "setup"), "inputGstCents")) + BigInt(monthlyPayment.credit) * clients);
  return {
    basis: "estimate",
    incomplete: input.rates.some((r) => r.micros === null || r.gst === "unknown"),
    warnings,
    clients: input.clients,
    actualSeconds,
    customerBillableSeconds: customerSeconds,
    callCount,
    overageMinutes,
    smsOverageSegments,
    includedUtilisationBps: pricing.includedMinutes > 0 ? Math.round(customerSeconds * 1e4 / (pricing.includedMinutes * 60)) : null,
    grossRevenueCents: grossRevenue,
    revenueExGstCents: revenue,
    outputGstCents: outputGst,
    variableCostCents: variableCost,
    paymentCostCents: paymentCost,
    contributionCents: contribution,
    sharedPlatformCents: sharedCost,
    supportCents: support,
    operatingContributionCents: operating,
    contributionMarginBps: revenue ? Math.round(contribution * 1e4 / revenue) : null,
    operatingMarginBps: revenue ? Math.round(operating * 1e4 / revenue) : null,
    monthlyInputGstCents: monthlyInputGst,
    estimatedNetGstCents: moneyTotal(outputGst, -monthlyInputGst),
    perMinuteCents: perMinute,
    perCallCents: perCall,
    perSmsSegmentCents: perSms,
    overageFloorExGstCents: floorExGst,
    overageFloorQuotedCents: floorQuoted,
    overageBelowFloor: floorQuoted !== null && pricing.overagePerMinute.cents < floorQuoted,
    smsFloorExGstCents: smsFloorExGst,
    smsBelowFloor: smsFloorExGst !== null && pricing.extraSmsSegment.cents < (quoted(smsFloorExGst, pricing.extraSmsSegment) ?? 0),
    breakEvenIncludedMinutes: perMinute === null || perMinute === 0 ? null : Math.max(0, Math.floor(includedHeadroom / perMinute)),
    breakEvenClients: beforeShared <= 0 ? null : Math.max(1, safe(ceil(BigInt(sharedCost) * clients, BigInt(beforeShared)))),
    setup: { revenueExGstCents: setupPrice.netCents, outputGstCents: setupPrice.gstCents, costCents: setupCost, labourCents: setupLabour, paymentCents: setupPayment.operatingCents, contributionCents: moneyTotal(setupPrice.netCents, -setupCost), paybackCovered: setupPrice.netCents >= setupCost },
    lines
  };
}
function defaultEconomicsInput(pkg, scenarioId = "base") {
  const scenario = pkg.model.scenarios.find((s) => s.id === scenarioId);
  if (!scenario)
    throw new Error(`Unknown scenario: ${scenarioId}`);
  return {
    package: pkg,
    clients: 5,
    calls: scenario.calls.map((c) => ({ ...c })),
    notificationsPerClient: 0,
    smsSegmentsPerClient: scenario.smsSegments,
    phoneNumbersPerClient: pkg.inclusions.phoneNumbers,
    rates: DEFAULT_COST_RATES,
    fx: { ...DEFAULT_FX },
    gstRegistered: true,
    supportMinutesPerClient: scenario.supportMinutes,
    supportHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    onboardingMinutes: pkg.model.onboardingMinutes,
    onboardingHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    payment: { ...DEFAULT_PAYMENT },
    targetMarginBps: DEFAULT_TARGET_MARGIN_BPS
  };
}
function costEvidenceTable(rates = DEFAULT_COST_RATES) {
  return rates.map((r) => ({
    id: r.id,
    label: r.label,
    basis: r.basis,
    currency: r.currency,
    estimatedMicros: r.micros,
    estimateEvidence: r.evidence,
    source: r.source,
    checkedAt: r.checkedAt,
    effectiveFrom: r.effectiveFrom,
    measuredMicros: null,
    measuredReason: r.id === "retell" ? "Not established. The dashboard showed about A$0.17/min over 2 calls (6 min) on 26 Sep: too small a sample, before booking/SMS, and a per-call estimate rather than a bill. Needs one month of duration metadata after go-live." : "Not established: no production usage for a paying receptionist client yet.",
    invoiceReconciledMicros: null,
    invoiceReason: "Not reconciled: no provider invoice has been matched to usage metadata. Requires owner-authorised access to the monthly invoice totals (no caller content)."
  }));
}
var pct = (bps) => bps === null ? "n/a" : `${Math.round(bps / 100)}%`;
var list = (items) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
function priceRecommendation() {
  const tiers = [...RECEPTIONIST_PACKAGES].sort((a, b) => a.tier - b.tier);
  const entry = tiers[0];
  const margin = (scenario) => list(tiers.map((pkg) => pct(calculateEconomics(defaultEconomicsInput(pkg, scenario)).operatingMarginBps)));
  const clients = defaultEconomicsInput(entry).clients;
  const approved = tiers.every((pkg) => pkg.pricing.status === "approved");
  return {
    status: approved ? "approved" : "proposed",
    asOf: ECONOMICS_AS_OF,
    packageId: entry.id,
    monthlyExGstCents: priceAmount(entry.pricing.monthly, false).netCents,
    setupExGstCents: priceAmount(entry.pricing.setup, false).netCents,
    setupStatus: entry.pricing.setupStatus ?? entry.pricing.status,
    ...(entry.pricing.setupStatus ?? entry.pricing.status) === "approved" ? {} : { setupNote: "Setup figures are a SCENARIO using a proposed setup fee, not approved revenue, until setupStatus is approved." },
    includedMinutes: entry.pricing.includedMinutes,
    overageExGstCents: priceAmount(entry.pricing.overagePerMinute, false).netCents,
    rationale: `${tiers.length} ${approved ? "approved" : "proposed"} tiers on the owner's anchors, quoted ex GST: ${list(tiers.map((pkg) => `${pkg.shortName} ${formatAud(priceAmount(pkg.pricing.monthly, false).netCents)}/month (${pkg.pricing.includedMinutes.toLocaleString("en-AU")} min, ${formatAud(priceAmount(pkg.pricing.overagePerMinute, false).netCents)}/min over, ${formatAud(priceAmount(pkg.pricing.setup, false).netCents)} setup ${(pkg.pricing.setupStatus ?? pkg.pricing.status) === "approved" ? "approved" : "proposed, not approved"})`))}. ` + `Base-case operating margins at ${clients} clients are about ${margin("base")} on known costs (high usage about ${margin("high")}); unknown database, alert and concurrency costs still reduce them. ` + `Estimates only: ${approved ? "monthly prices, allowances and extra-minute rates are approved in the catalogue; setup fees and pilot terms are not" : "no monthly price is approved"}, and the live line does not book yet.`
  };
}
var PRICE_RECOMMENDATION = priceRecommendation();
var REVIEW_TRIGGER = "Review allowances, rates and support time after the first 30 days of paid service or the first five paying clients, whichever comes first (owner decision 28 Sep 2026). Until then every figure is an estimate, not measured profit.";
var MEASURED_REASON = "No paying receptionist client and no provider invoice yet; fill from reconciled invoices after the review trigger.";
var RETELL_COMPONENTS = {
  infra: 55000,
  platformVoice: 15000,
  elevenlabsVoice: 40000,
  gpt41mini: 12800,
  claude45haiku: 25000,
  gpt6AstraFast: 640000,
  knowledgeBase: 5000,
  denoising: 5000,
  guardrails: 5000,
  piiRemoval: 1e4,
  aiQualityAssurance: 1e5,
  customTelephony: 0,
  retellTelephony: 15000
};
var retellConfig = (id, label, components, evidence) => ({ id, label, components, micros: components.reduce((n, c) => n + RETELL_COMPONENTS[c], 0), evidence });
var RETELL_PUBLISHED_RANGE = { lowMicros: 70000, highMicros: 310000, text: "$0.07-$0.31 / min for AI Voice Agents", source: RATE_SOURCES.retell, checkedAt: ECONOMICS_AS_OF };
var RETELL_CONFIGURATIONS = [
  retellConfig("generator-default", "Receptionist generator default: gpt-4.1-mini + retell-Cimo (Retell platform voice)", ["infra", "platformVoice", "gpt41mini", "customTelephony"], "D:/MU-Receptionist-wt-prompt @ 4debd33: src/lib/buildmaster/provision-plan.ts DEFAULT_MODEL 'gpt-4.1-mini' and DEFAULT_VOICE_ID 'retell-Cimo' ('placeholder platform voice', build-report.ts). Standard LLM tier; the generator sets no knowledge-base, denoising, guardrail or PII add-on."),
  retellConfig("live-demo-recorded", "Live demo agent as recorded 27 Sep: Claude 4.5 Haiku + a retell- voice (platform tier assumed from the prefix)", ["infra", "platformVoice", "claude45haiku", "customTelephony"], "27 Sep live-config read (MU-Workspace memory/master-v3/ENTITY-MAP.md rows 3 and 10). Not re-read on 28 Sep: no live Retell call is allowed in this task. Voice tier unconfirmed."),
  retellConfig("modelled-base", "Modelled base (conservative): Claude 4.5 Haiku + ElevenLabs voice tier", ["infra", "elevenlabsVoice", "claude45haiku", "customTelephony"], "DEFAULT_COST_RATES retell. Dearer than either configuration above, so the estimates err towards cost."),
  retellConfig("max-config", "Published maximum configuration: ElevenLabs + GPT 6 Astra fast tier + every per-minute add-on", ["infra", "elevenlabsVoice", "gpt6AstraFast", "knowledgeBase", "denoising", "guardrails", "piiRemoval", "aiQualityAssurance", "customTelephony"], "Every per-minute component on the official page at its maximum. Retell telephony (US$0.015) excluded because M&U brings its own Twilio SIP trunk; AI QA's first 100 free minutes ignored.")
];
var BASE_RETELL_MICROS = DEFAULT_COST_RATES.find((r) => r.id === "retell")?.micros ?? 0;
var usd = (micros) => `US$${(micros / 1e6).toFixed(micros % 1000 === 0 ? 3 : 4)}`;
var retellMax = RETELL_CONFIGURATIONS.find((c) => c.id === "max-config").micros;
var RETELL_STRESS = [
  { id: "base", label: `Base ${usd(BASE_RETELL_MICROS)}`, micros: BASE_RETELL_MICROS },
  { id: "plus25", label: `+25% ${usd(BASE_RETELL_MICROS * 125 / 100)}`, micros: BASE_RETELL_MICROS * 125 / 100 },
  { id: "plus50", label: `+50% ${usd(BASE_RETELL_MICROS * 150 / 100)}`, micros: BASE_RETELL_MICROS * 150 / 100 },
  { id: "range-top", label: `Published range top ${usd(RETELL_PUBLISHED_RANGE.highMicros)}`, micros: RETELL_PUBLISHED_RANGE.highMicros },
  { id: "max-config", label: `Published max config ${usd(retellMax)}`, micros: retellMax }
];
var STRESS_ASSUMPTIONS = {
  status: "assumption",
  callSeconds: 150,
  nonBillableCallShareBps: 500,
  nonBillableCallSeconds: 4,
  bookingShareBps: 5000,
  smsMessagesPerBooking: { "receptionist-essential": 1, "receptionist-professional": 2, "receptionist-premium": 2 },
  smsSegmentsPerMessageBase: 1,
  smsSegmentsPerMessageStress: 2,
  webhookEventsPerCall: 5,
  webhookDuplicateBps: 1000,
  webhookDuplicateStressBps: 30000,
  transferShareBps: 0,
  transferStressShareBps: 1000,
  transferSeconds: 180,
  labourHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
  supportScenarioByUsage: "≤50% low, ≤100% base, >100% high (catalogue model.scenarios)",
  firstMonthExtraSupportMinutes: { "receptionist-essential": 120, "receptionist-professional": 180, "receptionist-premium": 600 },
  clientsForGrid: 5
};
var STRESS_DEFAULTS = {
  usageBps: 1e4,
  retell: "base",
  clients: STRESS_ASSUMPTIONS.clientsForGrid,
  smsSegmentsPerMessage: STRESS_ASSUMPTIONS.smsSegmentsPerMessageBase,
  transferShareBps: STRESS_ASSUMPTIONS.transferShareBps,
  transferSeconds: STRESS_ASSUMPTIONS.transferSeconds,
  webhookDuplicateBps: STRESS_ASSUMPTIONS.webhookDuplicateBps,
  supportMultiplierBps: 1e4,
  chargeOverage: true
};
function unknownCostRegister() {
  const rates = DEFAULT_COST_RATES.filter((r) => r.micros === null).map((r) => ({
    id: r.id,
    label: r.label,
    amount: null,
    basis: r.basis,
    whyUnknown: r.note,
    source: r.source,
    illustrationNotInTotals: r.id === "database" ? "0.25 CU always on = 0.25 × 730 h × US$0.106 = US$19.35/month shared (about A$28.40 with the FX buffer), before storage" : null
  }));
  const other = [
    { id: "supplier-gst", label: "GST on Retell, Twilio, Vercel and Neon invoices, and whether it is creditable", whyUnknown: "Supplier tax invoices not seen. No GST added and no credit taken on any supplier line." },
    { id: "live-voice-tier", label: "Voice tier of the live Retell agent", whyUnknown: "Recorded 27 Sep as a retell- voice (platform tier by prefix). The base rate uses the dearer ElevenLabs tier until an owner-approved live read confirms it." },
    { id: "bad-debt", label: "Failed payments, disputes, refunds and service credits", whyUnknown: "No payment history. Stripe dispute fees and any service credit policy are not modelled." },
    { id: "business-overhead", label: "Accounting, insurance, legal review of the service agreement, M&U's own phones and domains", whyUnknown: "Business overhead, not allocated per client; not scoped." },
    { id: "fx-settlement", label: "Actual card FX spread on USD bills", whyUnknown: "Modelled as RBA 25 Sep + 3% buffer; the real spread depends on the card used." }
  ].map((x) => ({ ...x, amount: null, basis: "unallocated", source: null, illustrationNotInTotals: null }));
  return [...rates, ...other];
}
var STRESS_OVERLAYS = [
  { id: "baseline", label: "Baseline: 100% of allowance, base Retell", opts: {} },
  { id: "sms-2-segments", label: "Every SMS is 2 segments", opts: { smsSegmentsPerMessage: STRESS_ASSUMPTIONS.smsSegmentsPerMessageStress } },
  { id: "transfers-10pct", label: "10% of calls cold-transferred for 3 min", opts: { transferShareBps: STRESS_ASSUMPTIONS.transferStressShareBps } },
  { id: "duplicate-webhooks", label: "Every webhook delivered 4 times", opts: { webhookDuplicateBps: STRESS_ASSUMPTIONS.webhookDuplicateStressBps } },
  { id: "support-x2", label: "Support time doubled", opts: { supportMultiplierBps: 20000 } },
  { id: "combined-1-client", label: "Combined: 150% usage, Retell +50%, 2-segment SMS, 10% transfers, 4× webhooks, 2× support, 1 client", opts: { usageBps: 15000, retell: "plus50", smsSegmentsPerMessage: 2, transferShareBps: 1000, webhookDuplicateBps: 30000, supportMultiplierBps: 20000, clients: 1 } }
];
var CONSISTENCY_FIXTURE_USAGE = {
  packageId: "receptionist-professional",
  calls: [{ count: 480, seconds: 150 }],
  smsSegments: 40,
  transferLegs: [{ count: 2, seconds: 180 }]
};
function receptionistConsistencyFixture() {
  const pkg = getReceptionistPackage(CONSISTENCY_FIXTURE_USAGE.packageId);
  const input = {
    ...defaultEconomicsInput(pkg),
    clients: 1,
    calls: CONSISTENCY_FIXTURE_USAGE.calls.map((c) => ({ ...c })),
    smsSegmentsPerClient: CONSISTENCY_FIXTURE_USAGE.smsSegments,
    transferLegs: CONSISTENCY_FIXTURE_USAGE.transferLegs.map((c) => ({ ...c })),
    webhookEventsPerClient: 0
  };
  const r = calculateEconomics(input);
  const line = (id, description, quantity, unit) => {
    const amount = priceAmount({ ...unit, cents: unit.cents * quantity }, true);
    return { id, description, quantity, unitExGstCents: unit.cents, exGstCents: amount.netCents, gstCents: amount.gstCents, inclGstCents: amount.grossCents };
  };
  const lines = [
    line("monthly", `${pkg.name}, monthly fee`, 1, pkg.pricing.monthly),
    line("overage-minutes", `Extra AI minutes beyond ${pkg.pricing.includedMinutes.toLocaleString("en-AU")} included`, r.overageMinutes, pkg.pricing.overagePerMinute),
    line("sms-overage", `Extra SMS segments beyond ${pkg.pricing.includedSmsSegments} included`, r.smsOverageSegments, pkg.pricing.extraSmsSegment)
  ];
  const sum = (k) => lines.reduce((n, l) => n + l[k], 0);
  const totals = { exGstCents: sum("exGstCents"), gstCents: sum("gstCents"), totalInclGstCents: sum("inclGstCents") };
  if (totals.exGstCents !== r.revenueExGstCents || totals.gstCents !== r.outputGstCents)
    throw new Error("Fixture invoice lines disagree with calculateEconomics");
  const perCall = CONSISTENCY_FIXTURE_USAGE.calls.reduce((n, c) => n + c.count * Math.ceil(c.seconds / 60), 0);
  return {
    schemaVersion: 1,
    fixtureId: "rx-consistency-professional-1200min",
    synthetic: true,
    generatedBy: "AgenticOS-v4 src/lib/business-economics.ts receptionistConsistencyFixture()",
    catalogueVersion: CATALOGUE_VERSION,
    ratesAsOf: ECONOMICS_AS_OF,
    purpose: "The receptionist app, CRM proposal and Finance must reproduce expectedInvoice exactly from this usage. Synthetic data only.",
    customer: { packageId: pkg.id, name: "Synthetic Dental Pty Ltd (fixture)", gstRegistered: true, currency: "AUD", roundingMode: pkg.pricing.billing.receptionistRoundingMode, minimumBillableSeconds: pkg.pricing.billing.minimumBillableSeconds },
    usage: {
      calls: CONSISTENCY_FIXTURE_USAGE.calls,
      billableSeconds: r.customerBillableSeconds,
      billableMinutes: r.customerBillableSeconds / 60,
      smsSegments: CONSISTENCY_FIXTURE_USAGE.smsSegments,
      transfers: { legs: CONSISTENCY_FIXTURE_USAGE.transferLegs, customerBillable: false, note: "Transfer is not offered in any tier today. Post-transfer minutes are carrier cost only: Retell's AI fee stops at the handoff and the client is billed for AI minutes only." }
    },
    expectedInvoice: {
      includedMinutes: pkg.pricing.includedMinutes,
      overageMinutes: r.overageMinutes,
      overageRateExGstCents: pkg.pricing.overagePerMinute.cents,
      includedSmsSegments: pkg.pricing.includedSmsSegments,
      smsOverageSegments: r.smsOverageSegments,
      lines,
      totals,
      gstMethod: "GST per line = round-half-up(ex GST × 10%); totals are the sum of lines.",
      setupFee: { status: pkg.pricing.setupStatus, invoiced: false, note: "Setup fees are PROPOSED; no app may add a setup line." }
    },
    mustNotProduce: [
      { case: "PER_CALL rounding", billableMinutes: perCall, overageMinutes: perCall - pkg.pricing.includedMinutes, overageExGstCents: (perCall - pkg.pricing.includedMinutes) * pkg.pricing.overagePerMinute.cents, why: "The catalogue bills per second summed per period (PER_PERIOD). The receptionist's default PER_CALL mode would bill 480 × 3 min." },
      { case: "transfer minutes billed", billableMinutes: r.customerBillableSeconds / 60 + CONSISTENCY_FIXTURE_USAGE.transferLegs.reduce((n, l) => n + l.count * l.seconds, 0) / 60, why: "Post-transfer minutes are not AI minutes." },
      { case: "setup fee invoiced", why: "setupStatus is proposed." }
    ],
    financeEstimate: {
      basis: "estimate",
      measured: null,
      measuredReason: MEASURED_REASON,
      costLinesCents: Object.fromEntries(r.lines.filter((l) => l.basis !== "shared-month").map((l) => [l.id, l.operatingCents])),
      paymentFeeNetCents: r.paymentCostCents,
      directCostCents: r.variableCostCents,
      contributionCents: r.contributionCents,
      contributionMarginBps: r.contributionMarginBps,
      excluded: "Support labour, shared hosting and every unknown cost (see unknownCostRegister())."
    }
  };
}
// src/lib/deal-desk/money.ts
function int(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error(`${name} must be a whole number from 0 to ${max.toLocaleString("en-AU")}`);
  return value;
}
function mulDiv(a, b, d) {
  int(a, "value");
  int(b, "multiplier");
  int(d, "divisor");
  if (d === 0)
    throw new Error("divisor must be positive");
  const result = Number((BigInt(a) * BigInt(b) + BigInt(d) / 2n) / BigInt(d));
  if (!Number.isSafeInteger(result))
    throw new Error("Calculation exceeds safe money range");
  return result;
}
function ratioBps(part, whole) {
  return whole === 0 ? null : Math.round(part * 1e4 / whole);
}
function parseDecimal(text, places) {
  const t = text.trim();
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d*)?$/.test(t))
    throw new Error("Enter a plain number, for example 1,099.50");
  const [whole, fraction = ""] = t.replace(/,/g, "").split(".");
  if (fraction.length > places)
    throw new Error(places === 0 ? "Whole numbers only" : `At most ${places} decimal places`);
  const scaled = Number(BigInt(whole) * 10n ** BigInt(places) + BigInt((fraction + "0".repeat(places)).slice(0, places) || "0"));
  if (!Number.isSafeInteger(scaled))
    throw new Error("Number is too large");
  return scaled;
}
function allocate(totalCents, sharesBps) {
  int(totalCents, "total");
  if (!sharesBps.length)
    throw new Error("At least one share is required");
  if (sharesBps.reduce((n, s) => n + int(s, "share", 1e4), 0) !== 1e4)
    throw new Error("Shares must add up to 100%");
  const exact = sharesBps.map((s) => BigInt(totalCents) * BigInt(s));
  const parts = exact.map((e) => Number(e / 10000n));
  let left = totalCents - parts.reduce((n, p) => n + p, 0);
  const order = exact.map((e, i) => ({ i, rem: Number(e % 10000n) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0;left > 0; k++, left--)
    parts[order[k % order.length].i] += 1;
  return parts;
}
function toAudCents(cents, currency, fx) {
  int(cents, "amount");
  if (currency === "AUD")
    return cents;
  const rate = int(fx.usdPerAudMillionths, "USD per AUD", 1e8);
  if (!rate)
    throw new Error("FX rate must be positive");
  const buffer = int(fx.cardFeeBps, "FX buffer", 1e4);
  const n = BigInt(cents) * 1000000n * BigInt(1e4 + buffer);
  const d = BigInt(rate) * 10000n;
  return Number((n + d / 2n) / d);
}
function paymentFee(grossCents, fee) {
  int(grossCents, "charge");
  int(fee.percentBps, "payment percentage", 1e4);
  int(fee.fixedCents, "payment fixed fee");
  if (grossCents === 0)
    return { feeCents: 0, creditCents: 0, costCents: 0 };
  const feeCents = mulDiv(grossCents, fee.percentBps, 1e4) + (fee.percentBps === 0 && fee.fixedCents === 0 ? 0 : fee.fixedCents);
  const creditCents = fee.gstCreditable ? splitGst(feeCents, "inclusive").gstCents : 0;
  return { feeCents, creditCents, costCents: feeCents - creditCents };
}
var pctText = (bps, digits = 1) => bps === null ? "n/a" : `${(bps / 100).toFixed(digits)}%`;
var hoursText = (minutes) => `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} h`;

// src/lib/deal-desk/receptionist.ts
var RX_COLUMN_LABELS = {
  low: "Low usage",
  expected: "Expected usage",
  full: "Full allowance",
  extra: "Over allowance"
};
var RX_VOICE_PRESETS = [
  ...RETELL_CONFIGURATIONS.map((c) => ({ id: c.id, label: c.label, micros: c.micros })),
  ...RETELL_STRESS.filter((s) => s.id !== "base").map((s) => ({ id: `stress-${s.id}`, label: `Stress: ${s.label}`, micros: s.micros }))
];
function scenario(pkg, id) {
  const s = pkg.model.scenarios.find((x) => x.id === id);
  return { seconds: s.calls.reduce((n, c) => n + c.count * c.seconds, 0), sms: s.smsSegments, support: s.supportMinutes };
}
function defaultRxColumns(pkg) {
  const low = scenario(pkg, "low");
  const base = scenario(pkg, "base");
  const high = scenario(pkg, "high");
  const full = pkg.pricing.includedMinutes * 60;
  return {
    low: { billableSeconds: low.seconds, smsSegments: low.sms, supportMinutes: low.support },
    expected: { billableSeconds: base.seconds, smsSegments: base.sms, supportMinutes: base.support },
    full: { billableSeconds: full, smsSegments: base.seconds ? Math.round(base.sms * full / base.seconds) : base.sms, supportMinutes: base.support },
    extra: { billableSeconds: Math.max(high.seconds, full + 60), smsSegments: high.sms, supportMinutes: high.support }
  };
}
function defaultRxInput(packageId = "receptionist-professional") {
  const pkg = getReceptionistPackage(packageId);
  return {
    packageId,
    columns: defaultRxColumns(pkg),
    avgCallSeconds: 150,
    shortCallShareBps: 500,
    webhookEventsPerCall: 5,
    voiceMicros: DEFAULT_COST_RATES.find((r) => r.id === "retell").micros,
    rateOverrides: {},
    clientsSharingPlatform: 1,
    fx: { ...DEFAULT_FX },
    labourHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    onboardingMinutes: pkg.model.onboardingMinutes,
    payment: { percentBps: DEFAULT_PAYMENT.percentBps, fixedCents: DEFAULT_PAYMENT.fixedCents },
    monthlyDiscountBps: 0,
    setupFeeCents: null,
    termMonths: pkg.pricing.minimumTermMonths
  };
}
function pricedPackage(input) {
  const pkg = structuredClone(getReceptionistPackage(input.packageId));
  const discount = mulDiv(pkg.pricing.monthly.cents, int(input.monthlyDiscountBps, "discount", 1e4), 1e4);
  pkg.pricing.monthly.cents -= discount;
  pkg.pricing.setup.cents = input.setupFeeCents === null ? 0 : int(input.setupFeeCents, "setup fee");
  return pkg;
}
function callsForSeconds(billableSeconds, avgCallSeconds) {
  const total = int(billableSeconds, "billable seconds", 1e9);
  const avg = int(avgCallSeconds, "average call length", 86400);
  if (avg < 5)
    throw new Error("Average call length must be at least 5 seconds");
  const full = Math.floor(total / avg);
  const rest = total % avg;
  if (full === 0)
    return rest ? [{ count: 1, seconds: rest }] : [];
  if (rest === 0)
    return [{ count: full, seconds: avg }];
  if (avg + rest > 86400)
    return [{ count: full, seconds: avg }, { count: 1, seconds: rest }];
  return [...full > 1 ? [{ count: full - 1, seconds: avg }] : [], { count: 1, seconds: avg + rest }];
}
function ratesFor(input) {
  return DEFAULT_COST_RATES.map((r) => {
    if (r.id === "retell")
      return input.voiceMicros === r.micros ? r : { ...r, micros: int(input.voiceMicros, "voice rate"), evidence: "assumption", note: `Entered in the deal desk (catalogue base ${r.micros}). ${r.note}` };
    if (!(r.id in input.rateOverrides))
      return r;
    const v = input.rateOverrides[r.id];
    return { ...r, micros: v === null ? null : int(v, r.label), evidence: v === null ? "unknown" : "assumption", note: `Entered in the deal desk: an assumption, not a provider charge. ${r.note}` };
  });
}
function economicsInput(input, column, pkg) {
  const calls = callsForSeconds(column.billableSeconds, input.avgCallSeconds);
  const billableCalls = calls.reduce((n, c) => n + c.count, 0);
  const shortCalls = Math.round(billableCalls * int(input.shortCallShareBps, "short-call share", 1e4) / 1e4);
  const allCalls = shortCalls ? [...calls, { count: shortCalls, seconds: 4 }] : calls;
  return {
    package: pkg,
    clients: (() => {
      const n = int(input.clientsSharingPlatform, "clients sharing the platform", 1e4);
      if (n < 1)
        throw new Error("Clients sharing the platform must be at least 1");
      return n;
    })(),
    calls: allCalls,
    transferLegs: [],
    webhookEventsPerClient: (billableCalls + shortCalls) * int(input.webhookEventsPerCall, "webhook events per call", 100),
    notificationsPerClient: 0,
    smsSegmentsPerClient: int(column.smsSegments, "SMS segments"),
    phoneNumbersPerClient: pkg.inclusions.phoneNumbers,
    rates: ratesFor(input),
    fx: input.fx,
    gstRegistered: true,
    supportMinutesPerClient: int(column.supportMinutes, "support minutes"),
    supportHourlyCents: int(input.labourHourlyCents, "hourly rate"),
    onboardingMinutes: int(input.onboardingMinutes, "onboarding minutes"),
    onboardingHourlyCents: input.labourHourlyCents,
    payment: { ...DEFAULT_PAYMENT, percentBps: input.payment.percentBps, fixedCents: input.payment.fixedCents },
    targetMarginBps: DEFAULT_TARGET_MARGIN_BPS
  };
}
function rxInvoice(pkg, billableSeconds, smsSegments) {
  const p = pkg.pricing;
  int(billableSeconds, "billable seconds");
  int(smsSegments, "SMS segments");
  const includedSeconds = p.includedMinutes * 60;
  const overageMinutes = Math.max(0, Math.ceil((billableSeconds - includedSeconds) / 60));
  const smsOver = Math.max(0, smsSegments - p.includedSmsSegments);
  const line = (id, description, quantity, unitCents) => {
    const a = priceAmount({ cents: unitCents * quantity, currency: "AUD", gst: "exclusive" }, true);
    return { id, description, quantity, unitExGstCents: unitCents, exGstCents: a.netCents, gstCents: a.gstCents, inclGstCents: a.grossCents };
  };
  const lines = [
    line("monthly", `${pkg.name}, monthly fee`, 1, p.monthly.cents),
    line("overage-minutes", `Extra minutes beyond ${p.includedMinutes.toLocaleString("en-AU")} included`, overageMinutes, p.overagePerMinute.cents),
    line("sms-overage", `Extra SMS segments beyond ${p.includedSmsSegments.toLocaleString("en-AU")} included`, smsOver, p.extraSmsSegment.cents)
  ];
  const sum = (k) => lines.reduce((n, l) => n + l[k], 0);
  return { billableSeconds, includedSeconds, overageMinutes, smsOverageSegments: smsOver, lines, exGstCents: sum("exGstCents"), gstCents: sum("gstCents"), inclGstCents: sum("inclGstCents") };
}
function rxColumn(input, column, pkg = pricedPackage(input)) {
  const e = economicsInput(input, column, pkg);
  const r = calculateEconomics(e);
  const n = e.clients;
  const invoice = rxInvoice(pkg, column.billableSeconds, column.smsSegments);
  const revenue = r.revenueExGstCents / n;
  const variable = r.variableCostCents / n;
  const support = r.supportCents / n;
  const shared = Math.ceil(r.sharedPlatformCents / n);
  const operating = revenue - variable - support - shared;
  const supportMinutes = column.supportMinutes;
  return {
    billableSeconds: column.billableSeconds,
    smsSegments: column.smsSegments,
    supportMinutes,
    calls: r.callCount,
    overageMinutes: r.overageMinutes,
    invoice,
    revenueExGstCents: revenue,
    costLines: r.lines.map((l) => ({ id: l.id, label: l.label, basis: l.basis, cents: l.basis === "shared-month" ? Math.ceil(l.operatingCents / n) : l.operatingCents / n })),
    paymentCostCents: r.paymentCostCents / n,
    variableCostCents: variable,
    contributionCents: revenue - variable,
    supportCents: support,
    sharedPlatformCents: shared,
    operatingCents: operating,
    contributionMarginBps: ratioBps(revenue - variable, revenue),
    operatingMarginBps: ratioBps(operating, revenue),
    providerCostPerMinuteCents: r.perMinuteCents,
    effectiveHourlyCents: supportMinutes === 0 ? null : Math.round((operating + support) * 60 / supportMinutes),
    unknownCosts: e.rates.filter((x) => x.micros === null).map((x) => x.label),
    raw: r
  };
}
function syntheticColumn(input, pkg, minutes) {
  const seconds = minutes * 60;
  const exp = input.columns.expected;
  const sms = exp.billableSeconds ? Math.round(exp.smsSegments * seconds / exp.billableSeconds) : exp.smsSegments;
  const share = pkg.pricing.includedMinutes ? seconds / (pkg.pricing.includedMinutes * 60) : 2;
  const support = share <= 0.5 ? input.columns.low.supportMinutes : share <= 1 ? input.columns.expected.supportMinutes : input.columns.extra.supportMinutes;
  return { billableSeconds: seconds, smsSegments: sms, supportMinutes: support };
}
function searchFirst(lo, hi, bad) {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (bad(mid))
      hi = mid;
    else
      lo = mid;
  }
  return hi;
}
function rxBreakEven(input) {
  const pkg = pricedPackage(input);
  const allowance = pkg.pricing.includedMinutes;
  const ceiling = Math.max(allowance, 100) * 20;
  const op = (minutes, variant = {}, p = pkg) => {
    const i = { ...input, ...variant };
    return rxColumn(i, syntheticColumn(i, p, minutes), p).operatingCents;
  };
  const noOverage = structuredClone(pkg);
  noOverage.pricing.overagePerMinute.cents = 0;
  noOverage.pricing.extraSmsSegment.cents = 0;
  const half = Math.floor(allowance / 2);
  const bands = [[0, half], [half + 1, allowance], [allowance + 1, ceiling]].filter(([a, b]) => a <= b);
  const firstWhere = (test, from = 0) => {
    for (const [start, end] of bands) {
      const a = Math.max(start, from);
      if (a > end)
        continue;
      if (test(a))
        return a;
      if (test(end))
        return searchFirst(a, end, test);
    }
    return null;
  };
  const lossFrom = (p) => firstWhere((m) => op(m, {}, p) < 0);
  const unprofitableFromMinutes = lossFrom(pkg);
  const recoversAtMinutes = unprofitableFromMinutes === null ? null : firstWhere((m) => op(m) >= 0, unprofitableFromMinutes + 1);
  const full = input.columns.full;
  const fullOp = (variant) => rxColumn({ ...input, ...variant }, full, pricedPackage({ ...input, ...variant })).operatingCents;
  const maxVoice = (() => {
    const top = 5000000;
    if (fullOp({ voiceMicros: 0 }) < 0)
      return 0;
    if (fullOp({ voiceMicros: top }) >= 0)
      return null;
    return searchFirst(0, top, (v) => fullOp({ voiceMicros: v }) < 0) - 1;
  })();
  const maxDiscount = (col) => {
    const at = (bps) => rxColumn({ ...input, monthlyDiscountBps: bps }, col, pricedPackage({ ...input, monthlyDiscountBps: bps })).operatingCents;
    if (at(0) < 0)
      return 0;
    if (at(1e4) >= 0)
      return 1e4;
    return searchFirst(0, 1e4, (b) => at(b) < 0) - 1;
  };
  const expected = rxColumn(input, input.columns.expected, pkg);
  const hourly = input.labourHourlyCents;
  const extraCost = (() => {
    const base = { ...full, billableSeconds: allowance * 60 };
    const more = { ...base, billableSeconds: (allowance + 1000) * 60 };
    const a = rxColumn(input, base, pkg);
    const b = rxColumn(input, more, pkg);
    return { costPerMinuteCents: (b.variableCostCents - a.variableCostCents) / 1000, revenuePerMinuteCents: (b.revenueExGstCents - a.revenueExGstCents) / 1000 };
  })();
  return {
    allowanceMinutes: allowance,
    unprofitableFromMinutes,
    recoversAtMinutes,
    unprofitableFromMinutesWithoutOverage: lossFrom(noOverage),
    maxVoiceUsdMicrosAtFullAllowance: maxVoice,
    maxDiscountBpsAtExpected: maxDiscount(input.columns.expected),
    maxDiscountBpsAtFullAllowance: maxDiscount(full),
    maxSupportMinutesAtExpected: hourly === 0 ? null : Math.max(0, Math.floor((expected.operatingCents + expected.supportCents) * 60 / hourly)),
    overage: { priceExGstCents: pkg.pricing.overagePerMinute.cents, ...extraCost, profitable: extraCost.revenuePerMinuteCents > extraCost.costPerMinuteCents },
    searchedUpToMinutes: ceiling
  };
}
function calculateRxDeal(input) {
  const pkg = pricedPackage(input);
  const catalogue = getReceptionistPackage(input.packageId);
  const columns = Object.keys(RX_COLUMN_LABELS).map((id) => ({ id, label: RX_COLUMN_LABELS[id], ...rxColumn(input, input.columns[id], pkg) }));
  const expected = columns.find((c) => c.id === "expected");
  const onboardingLabour = mulDiv(int(input.onboardingMinutes, "onboarding minutes"), input.labourHourlyCents, 60);
  const setupRevenue = input.setupFeeCents ?? 0;
  const setupFee = paymentFee(splitGst(setupRevenue, "exclusive").grossCents, { label: "", percentBps: input.payment.percentBps, fixedCents: input.payment.fixedCents, gstCreditable: true });
  const setupNet = setupRevenue - onboardingLabour - setupFee.costCents;
  const months = int(input.termMonths, "term months", 120);
  const unknown = [...new Set([...expected.unknownCosts, ...unknownCostRegister().filter((u) => u.basis === "unallocated").map((u) => u.label)])];
  const unapproved = [];
  if (input.monthlyDiscountBps > 0)
    unapproved.push({ id: "rx-discount", text: `A ${input.monthlyDiscountBps / 100}% discount on the monthly fee is entered. Discounts are not an approved term.` });
  if (input.setupFeeCents !== null)
    unapproved.push({ id: "rx-setup", text: "A setup fee is entered. Setup fees are NOT approved; A$990 / A$1,490 / A$2,490 were proposals only." });
  if (input.termMonths !== catalogue.pricing.minimumTermMonths)
    unapproved.push({ id: "rx-term", text: `Term of ${input.termMonths} months differs from the catalogue's proposed ${catalogue.pricing.minimumTermMonths}-month minimum.` });
  return {
    basis: "estimate",
    packageId: input.packageId,
    packageName: catalogue.name,
    catalogueVersion: catalogue.version,
    approvedAt: catalogue.pricing.approvedAt,
    priceStatus: catalogue.pricing.status,
    columns,
    breakEven: rxBreakEven(input),
    setup: {
      feeExGstCents: input.setupFeeCents,
      feeStatus: input.setupFeeCents === null ? "quoted separately once approved" : "UNAPPROVED",
      onboardingLabourCents: onboardingLabour,
      paymentCostCents: setupFee.costCents,
      netCents: setupNet,
      monthsToRecover: setupNet >= 0 ? 0 : expected.operatingCents <= 0 ? null : Math.ceil(-setupNet / expected.operatingCents)
    },
    term: {
      months,
      revenueExGstCents: expected.revenueExGstCents * months,
      operatingCents: expected.operatingCents * months + setupNet,
      hours: (expected.supportMinutes * months + input.onboardingMinutes) / 60
    },
    unknownCosts: unknown,
    incomplete: unknown.length > 0,
    unapproved
  };
}

// src/lib/format.ts
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var NONE = "—";
function toDate(value) {
  if (value === null || value === undefined || value === "")
    return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m)
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function partsOf(date, timeZone) {
  if (!timeZone)
    return { y: date.getFullYear(), mo: date.getMonth(), d: date.getDate(), h: date.getHours(), mi: date.getMinutes(), s: date.getSeconds(), wd: date.getDay() };
  const f = new Intl.DateTimeFormat("en-AU", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23", weekday: "short" });
  const get = {};
  for (const p of f.formatToParts(date))
    get[p.type] = p.value;
  return { y: Number(get.year), mo: Number(get.month) - 1, d: Number(get.day), h: Number(get.hour) % 24, mi: Number(get.minute), s: Number(get.second), wd: Math.max(0, WEEKDAYS.indexOf(get.weekday)) };
}
function fmtTime(value, opts = {}) {
  const date = toDate(value);
  if (!date)
    return NONE;
  const p = partsOf(date, opts.timeZone);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const sec = opts.seconds ? `:${String(p.s).padStart(2, "0")}` : "";
  return `${h12}:${String(p.mi).padStart(2, "0")}${sec} ${p.h < 12 ? "am" : "pm"}`;
}
function fmtDay(value, opts = {}) {
  const date = toDate(value);
  if (!date)
    return NONE;
  const p = partsOf(date, opts.timeZone);
  const showYear = opts.year === "auto" ? p.y !== partsOf(new Date, opts.timeZone).y : Boolean(opts.year);
  const wd = opts.weekday === "long" ? `${WEEKDAYS_LONG[p.wd]} ` : opts.weekday ? `${WEEKDAYS[p.wd]} ` : "";
  return `${wd}${p.d} ${opts.longMonth ? MONTHS_LONG[p.mo] : MONTHS[p.mo]}${showYear ? ` ${p.y}` : ""}`;
}
function fmtDateTime(value, opts = {}) {
  const date = toDate(value);
  if (!date)
    return NONE;
  return `${fmtDay(date, opts)}, ${fmtTime(date, opts)}`;
}

// src/lib/deal-desk/website.ts
var EFFORT_LABELS = {
  discovery: "Discovery and planning",
  design: "Design",
  build: "Build",
  content: "Content preparation",
  cms: "CMS / editing setup",
  qa: "Testing and launch",
  pm: "Client communication"
};
var CMS_PRESETS = {
  none: { minutes: 0, label: "No CMS (we make the changes)" },
  simple: { minutes: 120, label: "Simple (a few editable pages)" },
  structured: { minutes: 360, label: "Structured (listings, team, blog)" },
  custom: { minutes: 900, label: "Custom (integrations or data feeds)" }
};
var WEBSITE_BASELINE = {
  priceCents: 165000,
  depositCents: 82500,
  carePlanMonthlyCents: 11000,
  gst: "inclusive",
  source: "scripts/leads/sales-backoffice.ts WEBSITE_OFFER (owner-confirmed; the signed first-client deal, 17 Sep 2026)"
};
var PAYMENT_PRESETS = [
  { label: "Bank transfer (no fee)", percentBps: 0, fixedCents: 0, gstCreditable: false },
  { label: `Stripe card ${STRIPE_CARD_BPS / 100}% + A$0.30`, percentBps: STRIPE_CARD_BPS, fixedCents: 30, gstCreditable: true },
  { label: `Stripe card + Billing ${(STRIPE_CARD_BPS + STRIPE_BILLING_BPS) / 100}% + A$0.30`, percentBps: STRIPE_CARD_BPS + STRIPE_BILLING_BPS, fixedCents: 30, gstCreditable: true }
];
var cost = (c) => ({ sharedAcross: 1, ...c });
function defaultWebsiteInput() {
  return {
    kind: "build",
    price: { cents: WEBSITE_BASELINE.priceCents, gst: WEBSITE_BASELINE.gst },
    discount: { type: "none" },
    labourHourlyCents: DEFAULT_LABOUR_HOURLY_CENTS,
    effortMinutes: { discovery: 120, design: 480, build: 840, content: 240, cms: CMS_PRESETS.simple.minutes, qa: 180, pm: 120 },
    cmsComplexity: "simple",
    revisions: { includedRounds: 2, minutesPerRound: 120, expectedExtraRounds: 0, extraRoundFeeCents: null },
    costs: [
      cost({ id: "domain", label: "Domain registration (if M&U registers it)", currency: "AUD", cents: null, frequency: "one-off", evidence: "unknown", source: null, checkedAt: null, note: "No domain cost is on record. Enter the registrar's price, or leave unknown." }),
      cost({ id: "assets", label: "Stock imagery, fonts or generated assets", currency: "AUD", cents: null, frequency: "one-off", evidence: "unknown", source: null, checkedAt: null, note: "Depends on the project; nothing recorded." }),
      cost({ id: "hosting", label: "Vercel Pro seat (shared across client sites)", currency: "USD", cents: 2000, frequency: "monthly", evidence: "public-list", source: RATE_SOURCES.vercel, checkedAt: "2026-09-28", note: "US$20/month list price, re-read 28 Sep 2026. Usage beyond the included credit is unknown. Shared: set how many client sites carry it." }),
      cost({ id: "domain-renewal", label: "Domain renewal (monthly share)", currency: "AUD", cents: null, frequency: "monthly", evidence: "unknown", source: null, checkedAt: null, note: "Unknown until the registrar and payer are agreed." })
    ],
    contingencyBps: 1000,
    targetMarginBps: 5000,
    stages: [
      { label: "Deposit to start", shareBps: 5000, trigger: "On acceptance, before work starts" },
      { label: "Balance", shareBps: 5000, trigger: "At approved launch" }
    ],
    payment: { ...PAYMENT_PRESETS[0] },
    care: { enabled: true, monthly: { cents: WEBSITE_BASELINE.carePlanMonthlyCents, gst: WEBSITE_BASELINE.gst }, maintenanceMinutes: 30, includedChangeMinutes: 30, expectedChangeMinutes: 30, termMonths: 12 },
    fx: { ...DEFAULT_FX }
  };
}
function knownCosts(items, frequency, fx) {
  const lines = items.filter((c) => c.frequency === frequency).map((c) => {
    int(c.sharedAcross, `${c.label}: shared across`, 1e5);
    if (c.sharedAcross < 1)
      throw new Error(`${c.label}: shared across must be at least 1`);
    if (c.cents === null)
      return { ...c, audCents: null };
    const full = toAudCents(int(c.cents, c.label), c.currency, fx);
    return { ...c, audCents: Math.ceil(full / c.sharedAcross) };
  });
  return {
    lines,
    knownCents: lines.reduce((n, l) => n + (l.audCents ?? 0), 0),
    unknown: lines.filter((l) => l.audCents === null).map((l) => l.label)
  };
}
function calculateWebsite(input) {
  const hourly = int(input.labourHourlyCents, "hourly rate");
  const list = splitGst(int(input.price.cents, "price"), input.price.gst);
  const discountCents = input.discount.type === "percent" ? mulDiv(list.netCents, int(input.discount.bps, "discount", 1e4), 1e4) : input.discount.type === "fixed" ? Math.min(int(input.discount.cents, "discount"), list.netCents) : 0;
  const net = discountCents === 0 ? list : splitGst(list.netCents - discountCents, "exclusive");
  const r = input.revisions;
  int(r.includedRounds, "included revision rounds", 100);
  int(r.minutesPerRound, "minutes per revision round");
  int(r.expectedExtraRounds, "extra revision rounds", 100);
  const extraRevisionRevenue = r.extraRoundFeeCents === null ? 0 : int(r.extraRoundFeeCents, "extra round fee") * r.expectedExtraRounds;
  const revenueExGst = net.netCents + extraRevisionRevenue;
  const effort = Object.keys(EFFORT_LABELS).map((key) => {
    const minutes = int(input.effortMinutes[key], EFFORT_LABELS[key]);
    return { key, label: EFFORT_LABELS[key], minutes, cents: mulDiv(minutes, hourly, 60) };
  });
  const includedRevisionMinutes = r.includedRounds * r.minutesPerRound;
  const extraRevisionMinutes = r.expectedExtraRounds * r.minutesPerRound;
  const minutes = effort.reduce((n, e) => n + e.minutes, 0) + includedRevisionMinutes + extraRevisionMinutes;
  const labourCents = mulDiv(minutes, hourly, 60);
  const thirdParty = knownCosts(input.costs, "one-off", input.fx);
  const contingency = int(input.contingencyBps, "contingency", 1e4);
  const labourContingencyCents = mulDiv(labourCents, contingency, 1e4);
  const thirdPartyContingencyCents = mulDiv(thirdParty.knownCents, contingency, 1e4);
  const stageIncl = allocate(net.grossCents, input.stages.map((s) => s.shareBps));
  const stageGst = allocate(net.gstCents, input.stages.map((s) => s.shareBps));
  const stages = input.stages.map((s, i) => {
    const fee = paymentFee(stageIncl[i], input.payment);
    return { ...s, inclGstCents: stageIncl[i], gstCents: stageGst[i], exGstCents: stageIncl[i] - stageGst[i], feeCostCents: fee.costCents };
  });
  const paymentCostCents = stages.reduce((n, s) => n + s.feeCostCents, 0);
  const nonLabourCents = thirdParty.knownCents + thirdPartyContingencyCents + paymentCostCents;
  const deliveryCostCents = labourCents + labourContingencyCents + nonLabourCents;
  const grossProfitCents = revenueExGst - deliveryCostCents;
  const contingencyMinutes = mulDiv(minutes, contingency, 1e4);
  const oneOff = {
    listExGstCents: list.netCents,
    listGstCents: list.gstCents,
    discountCents,
    priceExGstCents: net.netCents,
    gstCents: net.gstCents,
    totalInclGstCents: net.grossCents,
    extraRevisionRevenueCents: extraRevisionRevenue,
    revenueExGstCents: revenueExGst,
    effort,
    includedRevisionMinutes,
    extraRevisionMinutes,
    minutes,
    labourCents,
    thirdPartyLines: thirdParty.lines,
    thirdPartyCents: thirdParty.knownCents,
    contingencyCents: labourContingencyCents + thirdPartyContingencyCents,
    contingencyMinutes,
    paymentCostCents,
    deliveryCostCents,
    grossProfitCents,
    marginBps: ratioBps(grossProfitCents, revenueExGst),
    effectiveHourlyCents: minutes === 0 ? null : Math.round((revenueExGst - thirdParty.knownCents - paymentCostCents) * 60 / minutes),
    effectiveHourlyWithContingencyCents: minutes + contingencyMinutes === 0 ? null : Math.round((revenueExGst - nonLabourCents) * 60 / (minutes + contingencyMinutes)),
    stages,
    unknownCosts: thirdParty.unknown
  };
  const c = input.care;
  const careSplit = c.enabled ? splitGst(int(c.monthly.cents, "care plan price"), c.monthly.gst) : { grossCents: 0, netCents: 0, gstCents: 0 };
  const monthlyCosts = knownCosts(c.enabled ? input.costs : [], "monthly", input.fx);
  const careMinutes = c.enabled ? int(c.maintenanceMinutes, "maintenance minutes") + int(c.expectedChangeMinutes, "expected change minutes") : 0;
  const careLabour = mulDiv(careMinutes, hourly, 60);
  const careFee = paymentFee(careSplit.grossCents, input.payment).costCents;
  const careCost = careLabour + monthlyCosts.knownCents + careFee;
  const careProfit = careSplit.netCents - careCost;
  const term = int(c.termMonths, "care plan months", 120);
  const recurring = {
    enabled: c.enabled,
    revenueExGstCents: careSplit.netCents,
    gstCents: careSplit.gstCents,
    inclGstCents: careSplit.grossCents,
    minutes: careMinutes,
    labourCents: careLabour,
    costLines: monthlyCosts.lines,
    thirdPartyCents: monthlyCosts.knownCents,
    paymentCostCents: careFee,
    costCents: careCost,
    profitCents: careProfit,
    marginBps: ratioBps(careProfit, careSplit.netCents),
    effectiveHourlyCents: careMinutes === 0 ? null : Math.round((careSplit.netCents - monthlyCosts.knownCents - careFee) * 60 / careMinutes),
    changeMinutesOverIncluded: c.enabled ? Math.max(0, c.expectedChangeMinutes - c.includedChangeMinutes) : 0,
    unknownCosts: monthlyCosts.unknown
  };
  const target = int(input.targetMarginBps, "target margin", 9999);
  const loadedHourly = hourly * (1e4 + contingency) / 1e4;
  const feeShare = input.payment.percentBps * 1.1 * (input.payment.gstCreditable ? 10 / 11 : 1) / 1e4;
  const fixedFees = input.stages.filter((s) => s.shareBps > 0).length * input.payment.fixedCents * (input.payment.gstCreditable ? 10 / 11 : 1);
  const fixedCost = labourCents + labourContingencyCents + thirdParty.knownCents + thirdPartyContingencyCents + fixedFees;
  const denominator = 1 - target / 1e4 - feeShare;
  const pricing = {
    targetMarginBps: target,
    breakEvenMinutes: loadedHourly === 0 ? null : Math.max(0, Math.floor((revenueExGst - nonLabourCents) * 60 / loadedHourly)),
    priceForTargetExGstCents: denominator <= 0 ? null : Math.max(0, Math.ceil((fixedCost - extraRevisionRevenue * (1 - target / 1e4)) / denominator)),
    breakEvenPriceExGstCents: feeShare >= 1 ? null : Math.max(0, Math.ceil((fixedCost - extraRevisionRevenue) / (1 - feeShare)))
  };
  const unknownCosts = [...oneOff.unknownCosts, ...recurring.unknownCosts];
  return {
    basis: "estimate",
    incomplete: unknownCosts.length > 0,
    unknownCosts,
    oneOff: { ...oneOff, pricing },
    recurring,
    horizon: {
      months: term,
      oneOffProfitCents: grossProfitCents,
      recurringProfitCents: careProfit * term,
      recurringRevenueExGstCents: careSplit.netCents * term,
      totalProfitCents: grossProfitCents + careProfit * term,
      monthsToRecoverBuildLoss: grossProfitCents >= 0 ? 0 : careProfit <= 0 ? null : Math.ceil(-grossProfitCents / careProfit)
    },
    approval: websiteApproval(input)
  };
}
function websiteApproval(input) {
  const b = WEBSITE_BASELINE;
  const priceMatches = input.price.cents === b.priceCents && input.price.gst === b.gst && input.discount.type === "none";
  const stagesMatch = input.stages.length === 2 && input.stages[0].shareBps === 5000 && input.stages[1].shareBps === 5000 && /accept|start/i.test(input.stages[0].trigger) && /launch/i.test(input.stages[1].trigger) && !/after|later|days|weeks|months/i.test(input.stages[1].trigger);
  const careMatches = !input.care.enabled || input.care.monthly.cents === b.carePlanMonthlyCents && input.care.monthly.gst === b.gst;
  const unapproved = [];
  if (!priceMatches)
    unapproved.push(input.discount.type === "none" ? "Website price differs from the owner-confirmed offer (A$1,650 incl. GST). This is a scenario, not an approved price." : "A discount is applied to the website price. Discounts are not an approved term.");
  if (!stagesMatch)
    unapproved.push("Payment stages or their timing differ from the confirmed 50% deposit to start / 50% at approved launch.");
  if (!careMatches)
    unapproved.push("Care plan price differs from the owner-confirmed A$110/month incl. GST.");
  if (input.care.enabled)
    unapproved.push("Care plan inclusions (hosting, maintenance, included change time) and the 30-day notice period are draft terms awaiting confirmation; only the A$110/month price is confirmed.");
  if (input.revisions.extraRoundFeeCents !== null)
    unapproved.push("A fee for extra revision rounds is entered. No extra-revision price has been approved.");
  return { priceMatches, stagesMatch, careMatches, unapproved, source: b.source };
}

// src/lib/deal-desk/deal.ts
var STORAGE_KEY = "mu-deal-desk/v1";
function newId() {
  return `deal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function blankDeal(today, id = newId()) {
  return {
    schemaVersion: 1,
    id,
    name: "New deal",
    synthetic: false,
    updatedAt: today,
    client: { business: "", contact: "", email: "", phone: "", address: "", abn: "", sector: "other" },
    include: { website: true, receptionist: false },
    website: defaultWebsiteInput(),
    rx: defaultRxInput("receptionist-professional"),
    quote: {
      number: `Q-${today.replace(/-/g, "")}-${id.slice(-4).toUpperCase()}`,
      preparedOn: today,
      validDays: 14,
      preparedBy: "Usman and Mehroz, M&U Ventures",
      projectTitle: "",
      summary: "",
      scope: "",
      deliverables: "",
      exclusions: "",
      timeline: "",
      responsibilities: "",
      notes: "",
      usageIllustration: true,
      customText: false
    }
  };
}
function fillQuoteText(deal, force = false) {
  const t = defaultQuoteText(deal);
  const q = { ...deal.quote };
  for (const key of ["projectTitle", "summary", "scope", "deliverables", "exclusions", "timeline", "responsibilities"]) {
    if (force || !q[key].trim())
      q[key] = t[key];
  }
  if (force)
    q.customText = false;
  return { ...deal, quote: q };
}
function effectiveQuote(deal) {
  return deal.quote.customText ? deal.quote : { ...deal.quote, ...defaultQuoteText(deal) };
}
function defaultQuoteText(deal) {
  const web = deal.include.website;
  const rx = deal.include.receptionist;
  const pkg = getReceptionistPackage(deal.rx.packageId);
  const w = deal.website;
  const what = [web ? w.kind === "redesign" ? "website redesign" : "new business website" : "", rx ? `AI receptionist (${pkg.shortName})` : ""].filter(Boolean).join(" and ");
  const name = deal.client.business || "the client";
  const rxIncluded = pkg.functions.filter((f) => f.state !== "not-offered").map((f) => f.state === "at-go-live" ? `${f.label} (at go-live, after activation and acceptance tests)` : f.label);
  return {
    projectTitle: what ? what[0].toUpperCase() + what.slice(1) : "Proposal",
    summary: `A ${what || "project"} for ${name}, set up and tested before going live.`,
    scope: [
      ...web ? [
        `${w.kind === "redesign" ? "Redesign" : "Design and build"} of a responsive business website: discovery, agreed page list, design, build, basic search setup, testing and launch.`,
        `Editing: ${w.cmsComplexity === "none" ? "M&U makes content changes (no CMS)" : `${w.cmsComplexity} CMS setup so your team can edit agreed content`}.`,
        `${w.revisions.includedRounds} rounds of revisions on the design and build${w.revisions.extraRoundFeeCents === null ? "." : "; further rounds are charged at the rate below."}`
      ] : [],
      ...rx ? [
        `AI receptionist, ${pkg.name}: ${pkg.audience}`,
        "When a caller asks for a person, the receptionist takes their details and a callback request, and (once staff alerts are switched on at go-live) alerts your team by email. It does not transfer live calls.",
        ...rxIncluded.map((x) => `Receptionist: ${x}`),
        "Booking integrations vary by business and scheduling system. We confirm compatibility during setup; where direct booking is unavailable, we offer an agreed booking-request or lead-capture workflow."
      ] : []
    ].join(`
`),
    deliverables: [
      ...web ? ["Approved design for the agreed pages", "Live website on the agreed domain", "Basic on-page search setup (titles, descriptions, sitemap)", w.cmsComplexity === "none" ? "Handover notes" : "CMS access and a short editing guide"] : [],
      ...rx ? [`Configured receptionist on ${pkg.inclusions.phoneNumbers} number${pkg.inclusions.phoneNumbers === 1 ? "" : "s"} and up to ${pkg.inclusions.calendars} calendar${pkg.inclusions.calendars === 1 ? "" : "s"}`, ...pkg.inclusions.reports.map((r) => `Report: ${r}`), "Five scripted test calls with you before go-live"] : []
    ].join(`
`),
    exclusions: [
      ...web ? ["Copywriting beyond the agreed pages", "Paid advertising, ongoing SEO campaigns and photography", "Third-party subscriptions, plugins and licences unless listed", "Revision rounds beyond those included"] : [],
      ...rx ? [...pkg.functions.filter((f) => f.state === "not-offered").map((f) => `${f.label} (not offered)`), ...pkg.limitations] : []
    ].join(`
`),
    timeline: [
      ...web ? ["Week 1: kickoff, content and access gathered", "Weeks 2–3: design and first build; revision round 1", "Week 4: revision round 2, testing, launch on approval"] : [],
      ...rx ? pkg.onboarding.map((s, i) => `Receptionist step ${i + 1}: ${s}`) : [],
      "Exact dates are agreed after acceptance, deposit, content and access."
    ].join(`
`),
    responsibilities: [
      ...web ? ["Client: brand assets, approved copy and images, domain access, one person to approve work", "Domain renewal and payer: agree in writing", "Hosting under the care plan while it is active (draft care terms, awaiting confirmation)"] : [],
      ...rx ? ["Client: switch on call forwarding for the agreed cover; grant calendar access (no passwords shared)", "Client: privacy policy names overseas processors (call audio and transcripts are processed in the United States)", "M&U: provider costs (voice, telephony, SMS within the allowance) are included in the monthly fee"] : []
    ].join(`
`)
  };
}
var seed = (id, name, f) => {
  const d = blankDeal("2026-10-03", id);
  d.name = name;
  d.synthetic = true;
  f(d);
  return fillQuoteText(d);
};
function seedDeals() {
  return [
    seed("seed-dental-pro", "Example Dental Studio (synthetic): Professional receptionist", (d) => {
      d.client = { business: "Example Dental Studio (synthetic)", contact: "Practice manager (synthetic)", email: "", phone: "", address: "Western Sydney NSW", abn: "", sector: "dental" };
      d.include = { website: false, receptionist: true };
      d.rx = defaultRxInput("receptionist-professional");
    }),
    seed("seed-legal-web", "Example Conveyancing (synthetic): website build", (d) => {
      d.client = { business: "Example Conveyancing (synthetic)", contact: "Principal (synthetic)", email: "", phone: "", address: "Parramatta NSW", abn: "", sector: "legal" };
      d.include = { website: true, receptionist: false };
      d.website.cmsComplexity = "structured";
      d.website.effortMinutes.cms = 360;
    }),
    seed("seed-realty-both", "Example Realty (synthetic): website + Essential", (d) => {
      d.client = { business: "Example Realty (synthetic)", contact: "Director (synthetic)", email: "", phone: "", address: "Blue Mountains NSW", abn: "", sector: "property" };
      d.include = { website: true, receptionist: true };
      d.rx = defaultRxInput("receptionist-essential");
    }),
    seed("seed-edge-heavy", "Edge case (synthetic): heavy Essential with a discount", (d) => {
      d.client = { business: "Example Heavy-Use Clinic (synthetic)", contact: "", email: "", phone: "", address: "", abn: "", sector: "dental" };
      d.include = { website: false, receptionist: true };
      d.rx = defaultRxInput("receptionist-essential");
      d.rx.monthlyDiscountBps = 1000;
      d.rx.columns.expected = { billableSeconds: 54000, smsSegments: 260, supportMinutes: 120 };
      d.rx.columns.extra = { billableSeconds: 90030, smsSegments: 400, supportMinutes: 180 };
    })
  ];
}
var UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function mergeDefaults(defaults, value, openRecord = false) {
  if (Array.isArray(defaults))
    return Array.isArray(value) ? value : defaults;
  if (defaults === null || typeof defaults !== "object")
    return value === undefined ? defaults : value;
  const out = { ...defaults };
  if (value && typeof value === "object" && !Array.isArray(value))
    for (const k of Object.keys(value)) {
      if (UNSAFE_KEYS.has(k))
        continue;
      const v = value[k];
      if (k === "discount" && v && typeof v === "object" && !Array.isArray(v))
        out[k] = { ...v };
      else if (Object.prototype.hasOwnProperty.call(out, k))
        out[k] = mergeDefaults(out[k], v, k === "rateOverrides");
      else if (openRecord)
        out[k] = v;
    }
  return out;
}
function assertDeal(d, n) {
  const fail = (what) => {
    throw new Error(`${n}: ${what}`);
  };
  const str = (v, k, max = 20000) => {
    if (typeof v !== "string" || v.length > max)
      fail(`${k} must be text (up to ${max} characters)`);
  };
  const int = (v, k, max = 1000000000000, min = 0) => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
      fail(`${k} must be a whole number from ${min} to ${max}`);
  };
  const intOrNull = (v, k) => {
    if (v !== null)
      int(v, k);
  };
  const bool = (v, k) => {
    if (typeof v !== "boolean")
      fail(`${k} must be yes or no`);
  };
  const oneOf = (v, k, options) => {
    if (typeof v !== "string" || !options.includes(v))
      fail(`${k} must be one of ${options.join(", ")}`);
  };
  const date = (v, k) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v)
      fail(`${k} must be a real date (YYYY-MM-DD)`);
  };
  const fx = (f, k) => {
    int(f?.usdPerAudMillionths, `${k} rate`, 1e8, 1);
    date(f?.date, `${k} date`);
    int(f?.cardFeeBps, `${k} buffer`, 1e4);
  };
  const gst = ["inclusive", "exclusive"];
  str(d.id, "id", 200);
  str(d.name, "name", 300);
  bool(d.synthetic, "synthetic");
  str(d.updatedAt, "updatedAt", 40);
  for (const k of ["business", "contact", "email", "phone", "address", "abn"])
    str(d.client[k], `client ${k}`, 500);
  oneOf(d.client.sector, "sector", ["dental", "legal", "property", "other"]);
  bool(d.include.website, "include website");
  bool(d.include.receptionist, "include receptionist");
  const w = d.website;
  oneOf(w.kind, "website kind", ["build", "redesign"]);
  int(w.price.cents, "website price");
  oneOf(w.price.gst, "website price GST", gst);
  oneOf(w.discount?.type, "discount type", ["none", "percent", "fixed"]);
  if (w.discount.type === "percent")
    int(w.discount.bps, "discount percent", 1e4);
  if (w.discount.type === "fixed")
    int(w.discount.cents, "discount amount");
  int(w.labourHourlyCents, "hourly rate", 1e7);
  for (const k of ["discovery", "design", "build", "content", "cms", "qa", "pm"])
    int(w.effortMinutes[k], `effort ${k}`, 1e6);
  oneOf(w.cmsComplexity, "CMS complexity", ["none", "simple", "structured", "custom"]);
  int(w.revisions.includedRounds, "included rounds", 100);
  int(w.revisions.minutesPerRound, "minutes per round", 1e5);
  int(w.revisions.expectedExtraRounds, "extra rounds", 100);
  intOrNull(w.revisions.extraRoundFeeCents, "extra round fee");
  if (!Array.isArray(w.costs) || w.costs.length > 60)
    fail("costs must be a list of up to 60 items");
  w.costs.forEach((c, i) => {
    if (!c || typeof c !== "object")
      fail(`cost ${i + 1} is not an object`);
    str(c.id, `cost ${i + 1} id`, 200);
    str(c.label, `cost ${i + 1} label`, 300);
    oneOf(c.currency, `cost ${i + 1} currency`, ["AUD", "USD"]);
    intOrNull(c.cents, `cost ${i + 1} amount`);
    oneOf(c.frequency, `cost ${i + 1} frequency`, ["one-off", "monthly"]);
    int(c.sharedAcross, `cost ${i + 1} shared across`, 1e5, 1);
    oneOf(c.evidence, `cost ${i + 1} evidence`, ["owner-confirmed", "public-list", "assumption", "entered", "unknown"]);
    if (c.source !== null)
      str(c.source, `cost ${i + 1} source`, 500);
    if (c.checkedAt !== null)
      str(c.checkedAt, `cost ${i + 1} checked date`, 40);
    str(c.note, `cost ${i + 1} note`, 1000);
  });
  int(w.contingencyBps, "contingency", 1e4);
  int(w.targetMarginBps, "target margin", 9999);
  if (!Array.isArray(w.stages) || w.stages.length < 1 || w.stages.length > 12)
    fail("payment stages must be a list of 1 to 12");
  w.stages.forEach((s, i) => {
    if (!s || typeof s !== "object")
      fail(`stage ${i + 1} is not an object`);
    str(s.label, `stage ${i + 1} label`, 200);
    str(s.trigger, `stage ${i + 1} trigger`, 300);
    int(s.shareBps, `stage ${i + 1} share`, 1e4);
  });
  str(w.payment.label, "payment label", 200);
  int(w.payment.percentBps, "payment fee percent", 1e4);
  int(w.payment.fixedCents, "payment fixed fee", 1e6);
  bool(w.payment.gstCreditable, "payment fee GST");
  bool(w.care.enabled, "care plan");
  int(w.care.monthly.cents, "care plan fee");
  oneOf(w.care.monthly.gst, "care plan GST", gst);
  int(w.care.maintenanceMinutes, "maintenance minutes", 1e5);
  int(w.care.includedChangeMinutes, "included change minutes", 1e5);
  int(w.care.expectedChangeMinutes, "expected change minutes", 1e5);
  int(w.care.termMonths, "care months", 120);
  fx(w.fx, "website FX");
  const r = d.rx;
  for (const id of ["low", "expected", "full", "extra"]) {
    int(r.columns[id]?.billableSeconds, `${id} billable seconds`, 1e9);
    int(r.columns[id]?.smsSegments, `${id} SMS`, 1e7);
    int(r.columns[id]?.supportMinutes, `${id} support minutes`, 1e6);
  }
  int(r.avgCallSeconds, "average call length", 86400, 5);
  int(r.shortCallShareBps, "short-call share", 1e4);
  int(r.webhookEventsPerCall, "webhook events per call", 100);
  int(r.voiceMicros, "voice rate", 1e9);
  int(r.clientsSharingPlatform, "clients sharing hosting", 1e4, 1);
  fx(r.fx, "receptionist FX");
  int(r.labourHourlyCents, "receptionist hourly rate", 1e7);
  int(r.onboardingMinutes, "onboarding minutes", 1e6);
  int(r.payment.percentBps, "receptionist payment percent", 1e4);
  int(r.payment.fixedCents, "receptionist fixed fee", 1e6);
  int(r.monthlyDiscountBps, "monthly discount", 1e4);
  intOrNull(r.setupFeeCents, "setup fee");
  int(r.termMonths, "term months", 120);
  for (const [k, v] of Object.entries(r.rateOverrides)) {
    if (!/^[a-z0-9-]{1,40}$/.test(k))
      fail("a cost override has an unknown name");
    intOrNull(v, `cost override ${k}`);
  }
  const q = d.quote;
  str(q.number, "quote number", 80);
  date(q.preparedOn, "quote date");
  int(q.validDays, "quote validity days", 365, 1);
  str(q.preparedBy, "prepared by", 300);
  for (const k of ["projectTitle", "summary", "scope", "deliverables", "exclusions", "timeline", "responsibilities", "notes"])
    str(q[k], `quote ${k}`);
  bool(q.usageIllustration, "usage illustration");
  bool(q.customText, "custom text");
}
function parseDealShape(raw, label = "Deal") {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1)
    throw new Error(`${label}: unsupported or missing schemaVersion.`);
  const r = raw;
  const base = blankDeal(typeof r.updatedAt === "string" ? r.updatedAt.slice(0, 10) : "2026-10-03", typeof r.id === "string" ? r.id : newId());
  const pkgId = r.rx?.packageId ?? base.rx.packageId;
  getReceptionistPackage(pkgId);
  const merged = mergeDefaults(base, r);
  merged.rx = mergeDefaults(defaultRxInput(pkgId), r.rx);
  assertDeal(merged, label);
  return merged;
}
function parseDeals(json) {
  const data = JSON.parse(json);
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray(data.deals) ? data.deals : null;
  if (!list)
    throw new Error("Not a deal desk export: expected a list of deals.");
  return list.map((raw, i) => {
    const merged = parseDealShape(raw, `Deal ${i + 1}`);
    try {
      calculateWebsite(merged.website);
      calculateRxDeal(merged.rx);
    } catch (e) {
      throw new Error(`Deal ${i + 1}: ${e.message}`);
    }
    return merged;
  });
}
function serializeDeals(deals) {
  return JSON.stringify({ app: "M&U deal desk", schemaVersion: 1, mode: "draft-only", exportedFrom: "local browser storage", deals }, null, 2) + `
`;
}
var csvCell = (v) => v === null ? "unknown" : typeof v === "number" ? (v / 100).toFixed(2) : `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
function comparisonCsv(deal) {
  const rows = [["Deal", "Scenario", "Kind", "Revenue ex GST (A$)", "Delivery/operating cost (A$)", "Profit (A$)", "Margin %", "Effective hourly (A$)", "Unknown costs excluded"]];
  if (deal.include.website) {
    const w = calculateWebsite(deal.website);
    rows.push([deal.name, "Website build", "one-off", w.oneOff.revenueExGstCents, w.oneOff.deliveryCostCents, w.oneOff.grossProfitCents, w.oneOff.marginBps === null ? "n/a" : (w.oneOff.marginBps / 100).toFixed(1), w.oneOff.effectiveHourlyCents, w.oneOff.unknownCosts.join("; ") || "none"]);
    if (w.recurring.enabled)
      rows.push([deal.name, "Care plan", "monthly", w.recurring.revenueExGstCents, w.recurring.costCents, w.recurring.profitCents, w.recurring.marginBps === null ? "n/a" : (w.recurring.marginBps / 100).toFixed(1), w.recurring.effectiveHourlyCents, w.recurring.unknownCosts.join("; ") || "none"]);
  }
  if (deal.include.receptionist) {
    const r = calculateRxDeal(deal.rx);
    for (const c of r.columns)
      rows.push([deal.name, `Receptionist: ${RX_COLUMN_LABELS[c.id]} (${(c.billableSeconds / 60).toFixed(2)} min)`, "monthly", c.revenueExGstCents, c.revenueExGstCents - c.operatingCents, c.operatingCents, c.operatingMarginBps === null ? "n/a" : (c.operatingMarginBps / 100).toFixed(1), c.effectiveHourlyCents, c.unknownCosts.length ? `${c.unknownCosts.length} provider items` : "none"]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join(`
`) + `
`;
}

// src/lib/deal-desk/quote.ts
var OWNER_DECISION_B = "[OWNER DECISION (b) PENDING: is the monthly fee billed in advance from Acceptance, or in arrears after each billing period? Not decided.]";
var BOOKING_DISCLOSURE = "Booking integrations vary by business and scheduling system. We confirm compatibility during setup; where direct booking is unavailable, we offer an agreed booking-request or lead-capture workflow.";
var PRORATION_PENDING = "[OWNER DECISION PENDING: how the first month is charged when go-live falls mid-month. Not decided.]";
var SUPPLIER_ABN = "70 132 896 132";
var lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
var m = (exGstCents, gstCents) => ({ exGstCents, gstCents, inclGstCents: exGstCents + gstCents });
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function buildQuote(deal) {
  const q = effectiveQuote(deal);
  const unapproved = [];
  const openDecisions = [];
  const oneOff = [];
  const recurring = [];
  let stages = [];
  let usage = null;
  const billingRules = [];
  let oneOffTotal = null;
  if (deal.include.website) {
    const w = deal.website;
    const r = calculateWebsite(w);
    const o = r.oneOff;
    for (const [i, text] of r.approval.unapproved.entries())
      unapproved.push({ id: `web-${i}`, text });
    const priceFlag = r.approval.priceMatches ? undefined : "Price is a scenario, not the confirmed website offer";
    oneOff.push({ label: w.kind === "redesign" ? "Website redesign" : "Website design and build", detail: "Fixed price for the scope below", money: m(o.listExGstCents, o.discountCents ? o.listGstCents : o.gstCents), unapproved: o.discountCents ? undefined : priceFlag });
    if (o.discountCents) {
      const listGst = o.listGstCents;
      oneOff.push({ label: "Discount", detail: w.discount.type === "percent" ? `${w.discount.bps / 100}% of the ex-GST price` : "Fixed amount", money: m(-o.discountCents, -(listGst - o.gstCents)), unapproved: "Discounts are not an approved term" });
    }
    oneOffTotal = m(o.priceExGstCents, o.gstCents);
    if (w.revisions.extraRoundFeeCents !== null)
      oneOff.push({ label: "Each extra revision round (if requested)", detail: `Beyond the ${w.revisions.includedRounds} included`, money: m(w.revisions.extraRoundFeeCents, Math.round(w.revisions.extraRoundFeeCents / 10)), unapproved: "No extra-revision price has been approved" });
    const stageFlag = r.approval.stagesMatch ? undefined : "Payment stages differ from the confirmed 50/50";
    stages = o.stages.map((s) => ({ label: `${s.label} (${s.shareBps / 100}%)`, trigger: s.trigger, money: m(s.exGstCents, s.gstCents), unapproved: stageFlag }));
    if (w.care.enabled) {
      recurring.push({ label: "Website care plan, monthly from launch", detail: `Proposed inclusions: hosting, maintenance and up to ${w.care.includedChangeMinutes} minutes of changes a month; 30 days' notice to end.`, money: m(r.recurring.revenueExGstCents, r.recurring.gstCents), unapproved: r.approval.careMatches ? "Draft care terms: inclusions and notice await confirmation" : "Care plan price is a scenario; inclusions and notice await confirmation" });
    }
  }
  if (deal.include.receptionist) {
    const rx = calculateRxDeal(deal.rx);
    const pkg = pricedPackage(deal.rx);
    const cat = getReceptionistPackage(deal.rx.packageId);
    const p = projectPackageProposal(cat.id);
    for (const u of rx.unapproved)
      unapproved.push(u);
    const monthly = rxInvoice(pkg, 0, 0).lines[0];
    const approved = p.pricing.status !== "approved" ? "proposed, not approved" : deal.rx.monthlyDiscountBps > 0 ? `catalogue price approved ${p.pricing.approvedAt}; this discounted fee is not approved` : `catalogue ${p.catalogueVersion}, approved ${p.pricing.approvedAt}`;
    recurring.push({ label: `AI receptionist, ${cat.shortName}, monthly`, detail: `${cat.pricing.includedMinutes.toLocaleString("en-AU")} call minutes and ${cat.pricing.includedSmsSegments.toLocaleString("en-AU")} SMS segments included each month; no rollover (${approved})`, money: m(monthly.exGstCents, monthly.gstCents), unapproved: deal.rx.monthlyDiscountBps > 0 ? "Discounted monthly fee is not approved" : undefined });
    recurring.push({ label: "Extra call minutes", detail: "Per minute beyond the included minutes", money: m(p.display.overagePerMinute.exGstCents, p.display.overagePerMinute.inclGstCents - p.display.overagePerMinute.exGstCents) });
    recurring.push({ label: "Extra SMS segments", detail: "Per segment beyond the included segments", money: m(p.display.extraSmsSegment.exGstCents, p.display.extraSmsSegment.inclGstCents - p.display.extraSmsSegment.exGstCents) });
    if (deal.rx.setupFeeCents === null) {
      oneOff.push({ label: `AI receptionist setup (${cat.shortName})`, detail: "Quoted separately once approved", money: null });
    } else {
      const fee = deal.rx.setupFeeCents;
      oneOff.push({ label: `AI receptionist setup (${cat.shortName})`, detail: "One-off", money: m(fee, Math.round(fee / 10)), unapproved: "Setup fees are not approved" });
      oneOffTotal = oneOffTotal ? m(oneOffTotal.exGstCents + fee, oneOffTotal.gstCents + Math.round(fee / 10)) : m(fee, Math.round(fee / 10));
    }
    billingRules.push(`Connected call time is measured by the second, added up over the billing month and rounded up to the next whole minute once. Calls shorter than ${cat.pricing.billing.minimumBillableSeconds} seconds, calls that never reach the receptionist, and M&U's own test and demo calls are not counted.`, `Included minutes and SMS reset each billing month and do not roll over. Extra minutes and SMS are charged in arrears on the next invoice.`, `Proposed minimum term ${deal.rx.termMonths} months, then ${cat.pricing.noticeDays} days' written notice.`, "Prices are quoted excluding GST. M&U Ventures is registered for GST, so 10% GST is added to every invoice.", BOOKING_DISCLOSURE, "Still to be confirmed before this is issued: whether the monthly fee is billed in advance or in arrears, how a first part-month is charged, and that the receptionist is cleared for sale.");
    openDecisions.push(OWNER_DECISION_B, PRORATION_PENDING);
    if (q.usageIllustration) {
      const col = deal.rx.columns.expected;
      const inv = rxInvoice(pkg, col.billableSeconds, col.smsSegments);
      const mins = col.billableSeconds / 60;
      usage = {
        heading: `Illustration only: a month with ${Number.isInteger(mins) ? mins.toLocaleString("en-AU") : mins.toFixed(2)} billable minutes and ${col.smsSegments.toLocaleString("en-AU")} SMS segments`,
        rows: inv.lines.filter((l) => l.quantity > 0).map((l) => ({ label: l.description, detail: l.id === "monthly" ? "" : `${l.quantity.toLocaleString("en-AU")} × ${formatAud(l.unitExGstCents)} ex GST`, money: m(l.exGstCents, l.gstCents) })),
        total: m(inv.exGstCents, inv.gstCents)
      };
    }
    unapproved.push({ id: "rx-readiness", text: "Product readiness: the receptionist is in internal testing (booking and SMS start at go-live after activation and acceptance tests). Confirm it is cleared to sell before sending." });
  }
  const missing = [];
  if (!deal.client.business.trim())
    missing.push("Client business name");
  if (!deal.client.contact.trim())
    missing.push("Client contact");
  if (!deal.client.abn.trim())
    missing.push("Client ABN (if required on the agreement)");
  if (!deal.include.website && !deal.include.receptionist)
    missing.push("Nothing is selected to quote");
  return {
    draftBanner: "DRAFT QUOTE: NOT SENT, NOT AN INVOICE, NOT FOR SIGNATURE",
    number: q.number,
    preparedOn: q.preparedOn,
    validUntil: addDays(q.preparedOn, q.validDays),
    title: q.projectTitle || "Proposal",
    summary: q.summary,
    supplier: { name: "M KHAN & M.M KHAN trading as M&U Ventures", abn: SUPPLIER_ABN, contact: q.preparedBy },
    client: deal.client,
    scope: lines(q.scope),
    deliverables: lines(q.deliverables),
    exclusions: lines(q.exclusions),
    timeline: lines(q.timeline),
    responsibilities: lines(q.responsibilities),
    notes: lines(q.notes),
    oneOff,
    oneOffTotal,
    stages,
    recurring,
    usage,
    billingRules,
    unapproved,
    openDecisions,
    missing
  };
}
var day = (iso) => fmtDay(`${iso}T00:00:00Z`, { year: true, longMonth: true, timeZone: "UTC" });
var esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var cells = (x) => x ? `<td>${formatAud(x.exGstCents)}</td><td>${formatAud(x.gstCents)}</td><td>${formatAud(x.inclGstCents)}</td>` : `<td colspan="3" class="muted">To be confirmed</td>`;
var flag = (text) => text ? ` <span class="flag">Needs approval: ${esc(text)}</span>` : "";
var list2 = (items) => items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted">To be agreed.</p>`;
var rowsHtml = (rows) => rows.map((r) => `<tr><th scope="row">${esc(r.label)}${r.detail ? `<small>${esc(r.detail)}</small>` : ""}${flag(r.unapproved)}</th>${cells(r.money)}</tr>`).join("");
var head = `<thead><tr><th scope="col">Item</th><th scope="col">Ex GST</th><th scope="col">GST</th><th scope="col">Incl. GST</th></tr></thead>`;
function renderQuoteHtml(doc, internal = true) {
  const c = doc.client;
  const review = internal ? `<section class="review"><h2>Before this can be sent</h2>
${doc.unapproved.length ? `<h3>Needs owner approval</h3>${list2(doc.unapproved.map((u) => u.text))}` : ""}
${doc.openDecisions.length ? `<h3>Open owner decisions</h3>${list2(doc.openDecisions)}` : ""}
${doc.missing.length ? `<h3>Missing details</h3>${list2(doc.missing)}` : ""}
<p class="muted">This box is for M&amp;U only. Use the client copy to share once everything above is resolved.</p></section>` : "";
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DRAFT ${esc(doc.number)}: ${esc(doc.title)}</title>
<style>
:root{--ink:#17140f;--muted:#6b6457;--gold:#a8842f;--line:#e4ddcf;--paper:#fffdf8;--flag:#8a2b17}
*{box-sizing:border-box}body{margin:0;background:#efe9dc;color:var(--ink);font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.page{max-width:820px;margin:24px auto;background:var(--paper);padding:40px 44px;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.banner{background:#17140f;color:#e4c887;font-weight:700;letter-spacing:.04em;font-size:12px;padding:8px 12px;border-radius:8px;text-align:center}
header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin:28px 0 8px;flex-wrap:wrap}
.brand{font-family:Fraunces,Georgia,serif;font-size:30px;line-height:1;letter-spacing:-.01em}.brand b{color:var(--gold)}
.meta{text-align:right;font-size:13px;color:var(--muted)}.meta strong{color:var(--ink)}
h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:26px;margin:18px 0 4px}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:6px}
h3{font-size:14px;margin:14px 0 4px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:20px;font-size:14px}.parties p{margin:2px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px 6px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}
th[scope=row],thead th:first-child{text-align:left;font-weight:500}thead th{font-size:12px;color:var(--muted);font-weight:600}
th small{display:block;color:var(--muted);font-size:12.5px;font-weight:400}tfoot td,tfoot th{font-weight:700;border-bottom:2px solid var(--ink)}
.flag{display:inline-block;margin-top:4px;font-size:11.5px;font-weight:600;color:var(--flag);border:1px solid #d9a99b;background:#fbefe9;border-radius:6px;padding:1px 6px}
.muted{color:var(--muted)}ul{margin:6px 0;padding-left:20px}li{margin:3px 0}
@page{size:A4;margin:14mm}h2,h3{break-after:avoid}footer{break-before:avoid}th,td,li,p{overflow-wrap:anywhere}
.review{border:2px solid #d9a99b;background:#fdf6f2;border-radius:12px;padding:6px 18px 12px;margin-top:22px}.review h2{color:var(--flag);border:0}
.note{font-size:13px;color:var(--muted)}footer{margin-top:32px;font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:12px}
@media (max-width:640px){.page{margin:0;border-radius:0;padding:22px 16px}.parties{grid-template-columns:1fr}header{display:block}.meta{text-align:left;margin-top:10px}th,td{padding:8px 3px;font-size:13px}}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}.review{break-inside:avoid}h2{break-after:avoid}tr{break-inside:avoid}.banner{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><main class="page">
<div class="banner">${esc(doc.draftBanner)}</div>
<header><div class="brand">M<b>&amp;</b>U Ventures</div><div class="meta"><div><strong>Quote ${esc(doc.number)}</strong></div><div>Prepared ${esc(day(doc.preparedOn))} · Valid until ${esc(day(doc.validUntil))}</div></div></header>
<h1>${esc(doc.title)}</h1>${doc.summary ? `<p>${esc(doc.summary)}</p>` : ""}
${review}
<h2>Parties</h2><div class="parties"><div><h3>Prepared for</h3><p>${esc(c.business || "[Client business name]")}</p><p>${esc(c.contact || "[Contact]")}</p>${c.email ? `<p>${esc(c.email)}</p>` : ""}${c.phone ? `<p>${esc(c.phone)}</p>` : ""}${c.address ? `<p>${esc(c.address)}</p>` : ""}<p class="muted">ABN: ${esc(c.abn || "[if required]")}</p></div>
<div><h3>Prepared by</h3><p>${esc(doc.supplier.name)}</p><p>${esc(doc.supplier.contact)}</p><p class="muted">ABN: ${esc(doc.supplier.abn)}</p></div></div>
<h2>Scope</h2>${list2(doc.scope)}
<h2>Deliverables</h2>${list2(doc.deliverables)}
<h2>Not included</h2>${list2(doc.exclusions)}
<h2>Timeline</h2>${list2(doc.timeline)}
${doc.oneOff.length ? `<h2>One-off fees</h2><table>${head}<tbody>${rowsHtml(doc.oneOff)}</tbody>${doc.oneOffTotal ? `<tfoot><tr><th scope="row">Total one-off</th>${cells(doc.oneOffTotal)}</tr></tfoot>` : ""}</table>` : ""}
${doc.stages.length ? `<h3>Payment stages (website)</h3><table>${head}<tbody>${doc.stages.map((s) => `<tr><th scope="row">${esc(s.label)}<small>${esc(s.trigger)}</small>${flag(s.unapproved)}</th>${cells(s.money)}</tr>`).join("")}</tbody></table>` : ""}
${doc.recurring.length ? `<h2>Ongoing fees</h2><table>${head}<tbody>${rowsHtml(doc.recurring)}</tbody></table>` : ""}
${doc.billingRules.length ? `<h3>How receptionist usage is billed</h3>${list2(doc.billingRules)}` : ""}
${doc.usage ? `<h3>${esc(doc.usage.heading)}</h3><table>${head}<tbody>${rowsHtml(doc.usage.rows)}</tbody><tfoot><tr><th scope="row">Illustrative month</th>${cells(doc.usage.total)}</tr></tfoot></table><p class="note">An illustration of how the rules above apply, not a commitment or an invoice.</p>` : ""}
<h2>Ongoing costs and responsibilities</h2>${list2(doc.responsibilities)}
${doc.notes.length ? `<h2>Notes</h2>${list2(doc.notes)}` : ""}
<h2>Acceptance</h2><p>This draft is not an offer to accept. A final version is issued with the agreement once both founders have confirmed every item above.</p>
<footer>M&amp;U Ventures · Western Sydney, NSW · All amounts in Australian dollars. GST is 10%, shown per line and rounded to the cent.</footer>
</main></body></html>`;
}
function renderQuoteMarkdown(doc) {
  const money = (x) => x ? `${formatAud(x.exGstCents)} | ${formatAud(x.gstCents)} | ${formatAud(x.inclGstCents)}` : "To be confirmed | | ";
  const fl = (t) => t ? ` **[NEEDS APPROVAL: ${t}]**` : "";
  const md = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
  const table = (rows) => ["| Item | Ex GST | GST | Incl. GST |", "|---|---:|---:|---:|", ...rows.map((r) => `| ${md(r.label)}${r.detail ? ` (${md(r.detail)})` : ""}${fl(r.unapproved)} | ${money(r.money)} |`)].join(`
`);
  const bl = (items) => items.length ? items.map((i) => `- ${md(i)}`).join(`
`) : "- To be agreed.";
  const out = [
    `**${doc.draftBanner}**`,
    "",
    `# ${md(doc.title)}`,
    "",
    `Quote ${md(doc.number)} · Prepared ${day(doc.preparedOn)} · Valid until ${day(doc.validUntil)}`,
    "",
    md(doc.summary),
    "",
    "## Before this can be sent (M&U only)",
    bl([...doc.unapproved.map((u) => `Needs approval: ${u.text}`), ...doc.openDecisions, ...doc.missing.map((x) => `Missing: ${x}`)]),
    "",
    "## Parties",
    `- Prepared for: ${md(doc.client.business || "[Client]")}, ${md(doc.client.contact || "[Contact]")}`,
    `- Prepared by: ${md(doc.supplier.name)}, ${md(doc.supplier.contact)} · ABN ${doc.supplier.abn}`,
    "",
    "## Scope",
    bl(doc.scope),
    "",
    "## Deliverables",
    bl(doc.deliverables),
    "",
    "## Not included",
    bl(doc.exclusions),
    "",
    "## Timeline",
    bl(doc.timeline),
    ""
  ];
  if (doc.oneOff.length)
    out.push("## One-off fees", table(doc.oneOff), doc.oneOffTotal ? `
**Total one-off:** ${money(doc.oneOffTotal).replace(/ \| /g, " ex GST · ").replace(/ \| ?$/, "")} incl. GST` : "", "");
  if (doc.stages.length)
    out.push("### Payment stages (website)", table(doc.stages.map((s) => ({ label: s.label, detail: s.trigger, money: s.money, unapproved: s.unapproved }))), "");
  if (doc.recurring.length)
    out.push("## Ongoing fees", table(doc.recurring), "");
  if (doc.billingRules.length)
    out.push("### How receptionist usage is billed", bl(doc.billingRules), "");
  if (doc.usage)
    out.push(`### ${doc.usage.heading}`, table([...doc.usage.rows, { label: "**Illustrative month**", detail: "", money: doc.usage.total }]), "");
  out.push("## Ongoing costs and responsibilities", bl(doc.responsibilities), "");
  if (doc.notes.length)
    out.push("## Notes", bl(doc.notes), "");
  out.push("All amounts in Australian dollars. GST is 10%, shown per line and rounded to the cent.", "");
  return out.join(`
`);
}

// src/lib/deal-desk/checks.ts
var days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
function auditDeal(deal, today) {
  const f = [];
  const add = (id, severity, pass, area, check, detail) => f.push({ id, severity, pass, area, check, detail });
  const fixture = receptionistConsistencyFixture();
  add("regression-1200", "critical", fixture.expectedInvoice.totals.totalInclGstCents === 137390, "Receptionist", "Professional at 1,200 billable minutes = A$1,373.90 incl. GST", `Engine total ${(fixture.expectedInvoice.totals.totalInclGstCents / 100).toFixed(2)}; expected 1,373.90 (A$1,099 + A$150 overage + A$124.90 GST, no setup line).`);
  const cataloguePrices = RECEPTIONIST_PACKAGES.map((p) => `${p.pricing.monthly.cents}/${p.pricing.includedMinutes}/${p.pricing.overagePerMinute.cents}`).join(" ");
  add("catalogue-approved", "critical", cataloguePrices === "69900/400/80 109900/1000/75 199900/1800/70" && RECEPTIONIST_PACKAGES.every((p) => p.pricing.status === "approved" && p.pricing.setupStatus === "proposed"), "Receptionist", "Catalogue matches the approved prices and setup stays unapproved", `Catalogue: ${cataloguePrices}.`);
  if (deal.include.website) {
    const shares = deal.website.stages.reduce((n, s) => n + s.shareBps, 0);
    add("stages-100", "critical", shares === 1e4, "Website", "Payment stages add up to 100%", `Stages add up to ${shares / 100}%.`);
    add("fx-age", "warning", days(deal.website.fx.date, today) <= 30, "Website", "FX reference rate is recent", `RBA rate dated ${deal.website.fx.date} (${days(deal.website.fx.date, today)} days old).`);
    try {
      const w = calculateWebsite(deal.website);
      const o = w.oneOff;
      const stageTotal = o.stages.reduce((n, s) => n + s.inclGstCents, 0);
      const stageGst = o.stages.reduce((n, s) => n + s.gstCents, 0);
      add("stages-tie", "critical", stageTotal === o.totalInclGstCents && stageGst === o.gstCents, "Website", "Stage amounts tie to the project total and GST", `Stages ${stageTotal} c (GST ${stageGst} c) vs total ${o.totalInclGstCents} c (GST ${o.gstCents} c).`);
      const recomputed = o.revenueExGstCents - (o.labourCents + o.contingencyCents + o.thirdPartyCents + o.paymentCostCents);
      add("web-profit-tie", "critical", recomputed === o.grossProfitCents, "Website", "Revenue less cost lines equals gross profit", `Recomputed ${recomputed} c vs reported ${o.grossProfitCents} c.`);
      add("web-gst", "critical", o.totalInclGstCents === o.priceExGstCents + o.gstCents && (deal.website.price.gst === "inclusive" && o.discountCents === 0 || o.gstCents === Math.round(o.priceExGstCents / 10)), "Website", "GST is 10% and incl. = ex + GST", `${o.priceExGstCents} + ${o.gstCents} = ${o.totalInclGstCents}.`);
      add("web-unknown", "warning", w.unknownCosts.length === 0, "Website", "No unknown costs", w.unknownCosts.length ? `${w.unknownCosts.length} cost(s) unknown and excluded, not zero: ${w.unknownCosts.join("; ")}.` : "All entered costs have amounts.");
      add("web-loss", "warning", o.grossProfitCents >= 0, "Website", "Build is not loss-making at the entered hours", o.pricing.breakEvenMinutes === null ? "No labour rate entered." : `Break-even at ${(o.pricing.breakEvenMinutes / 60).toFixed(1)} h; planned ${(o.minutes / 60).toFixed(1)} h + ${(o.contingencyMinutes / 60).toFixed(1)} h contingency.`);
      add("web-margin-sanity", "info", o.marginBps === null || o.marginBps < 9000, "Website", "Margin is believable (under 90%)", "A margin above 90% usually means hours were left out.");
      add("web-zero-hours", "warning", o.minutes > 0, "Website", "Effort hours are entered", o.minutes ? `${(o.minutes / 60).toFixed(1)} h planned.` : "Zero hours: the margin ignores founder time.");
      add("web-approval", "info", w.approval.unapproved.length === 0, "Website", "Terms match the owner-confirmed website offer", w.approval.unapproved.join(" ") || "Price, stages and care plan match.");
    } catch (e) {
      add("web-calc", "critical", false, "Website", "Website scenario calculates", e.message);
    }
  }
  if (deal.include.receptionist) {
    try {
      const r = calculateRxDeal(deal.rx);
      const pkg = pricedPackage(deal.rx);
      for (const c of r.columns) {
        const inv = rxInvoice(pkg, c.billableSeconds, c.smsSegments);
        add(`rx-invoice-${c.id}`, "critical", inv.exGstCents === c.revenueExGstCents && inv.lines.reduce((n, l) => n + l.inclGstCents, 0) === inv.inclGstCents, "Receptionist", `${c.label}: invoice lines tie to modelled revenue`, `Invoice ${inv.exGstCents} c ex GST vs model ${c.revenueExGstCents} c.`);
        const tie = c.revenueExGstCents - c.variableCostCents - c.supportCents - c.sharedPlatformCents;
        add(`rx-op-${c.id}`, "critical", tie === c.operatingCents, "Receptionist", `${c.label}: revenue less costs equals operating result`, `Recomputed ${tie} c vs ${c.operatingCents} c.`);
      }
      const full = r.columns.find((c) => c.id === "full");
      add("rx-full-loss", "warning", full.operatingCents >= 0, "Receptionist", "Profitable at full allowance", `Operating ${(full.operatingCents / 100).toFixed(2)} per month at ${full.billableSeconds / 60} min.`);
      add("rx-overage", "warning", r.breakEven.overage.profitable, "Receptionist", "Extra-minute price covers its marginal cost", `Price ${r.breakEven.overage.priceExGstCents} c vs about ${r.breakEven.overage.costPerMinuteCents.toFixed(1)} c cost per extra minute.`);
      add("rx-unknown", "warning", r.unknownCosts.length === 0, "Receptionist", "No unknown provider costs", `${r.unknownCosts.length} item(s) unknown and excluded, never zero.`);
      add("rx-rates-age", "warning", days(ECONOMICS_AS_OF, today) <= 30, "Receptionist", "Provider list rates re-read within 30 days", `Rates re-read ${ECONOMICS_AS_OF} (${days(ECONOMICS_AS_OF, today)} days ago). None is a measured or invoiced charge.`);
      add("rx-fx-age", "warning", days(deal.rx.fx.date, today) <= 30, "Receptionist", "FX reference rate is recent", `RBA rate dated ${deal.rx.fx.date}.`);
      const cat = getReceptionistPackage(deal.rx.packageId);
      add("rx-columns-order", "info", deal.rx.columns.full.billableSeconds === cat.pricing.includedMinutes * 60, "Receptionist", "Full-allowance column equals the included minutes", `${deal.rx.columns.full.billableSeconds / 60} min vs ${cat.pricing.includedMinutes} included.`);
      add("rx-approval", "info", r.unapproved.length === 0, "Receptionist", "Only approved receptionist terms are used", r.unapproved.map((u) => u.text).join(" ") || "Catalogue price, allowance and rate; setup quoted separately.");
    } catch (e) {
      add("rx-calc", "critical", false, "Receptionist", "Receptionist scenario calculates", e.message);
    }
  }
  let q;
  try {
    q = buildQuote(deal);
  } catch (e) {
    add("quote-build", "critical", false, "Quote", "Quote can be prepared", e.message);
    return sortFindings(f);
  }
  add("quote-missing", "info", q.missing.length === 0, "Quote", "Client details are complete", `Missing: ${q.missing.join(", ")}.`);
  add("quote-flagged", "info", true, "Quote", "Unapproved terms are marked in the quote", `${q.unapproved.length} item(s) flagged inline and in the review box; ${q.openDecisions.length} open owner decision(s).`);
  return sortFindings(f);
}
var order = { critical: 0, warning: 1, info: 2 };
function sortFindings(f) {
  return f.sort((a, b) => Number(a.pass) - Number(b.pass) || order[a.severity] - order[b.severity]);
}

// src/lib/deal-desk/agreement.ts
var SUPPLIER = {
  legalName: "M KHAN & M.M KHAN trading as M&U Ventures",
  abn: "70 132 896 132",
  region: "Western Sydney, NSW",
  signatories: "Mehroz and Usman"
};
var esc2 = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var flag2 = (text) => ` <span class="flag">Needs approval: ${esc2(text)}</span>`;
var blank = (width = "14em") => `<span class="blank" style="min-width:${width}"></span>`;
var box = (label) => `<span class="opt">☐ ${esc2(label)}</span>`;
var longDate = (iso) => fmtDay(`${iso}T00:00:00Z`, { year: true, longMonth: true, timeZone: "UTC" });
var money = (ex, gst) => `${formatAud(ex + gst)} including GST<br><span class="sub">${formatAud(ex)} + ${formatAud(gst)} GST</span>`;
var textLines = (t) => t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
var MAX_INLINE_NOTES = 3;
var MAX_INLINE_STAGES = 3;
var AGREEMENT_PAGES_EXPRESSION = `(function(){var mm=96/25.4,h=270*mm;return [...document.querySelectorAll('.sheet,.appendix')].reduce(function(n,s){var cs=getComputedStyle(s);var inner=s.scrollHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);return n+Math.max(1,Math.ceil((inner-2)/h));},0);})()`;
function agreementPlan(deal) {
  const q = deal.quote;
  const notes = textLines(q.notes);
  const manyStages = deal.include.website && deal.website.stages.length > MAX_INLINE_STAGES;
  const reasons = [...q.customText ? ["scope text edited by hand"] : [], ...notes.length > MAX_INLINE_NOTES ? [`${notes.length} special terms`] : [], ...manyStages ? [`${deal.website.stages.length} payment stages`] : []];
  return { appendix: reasons.length > 0, reasons, notes, manyStages, customText: q.customText, longNotes: notes.length > MAX_INLINE_NOTES };
}
function renderAgreementHtml(deal) {
  const plan = agreementPlan(deal);
  const web = deal.include.website;
  const rx = deal.include.receptionist;
  const c = deal.client;
  const w = web ? calculateWebsite(deal.website) : null;
  const r = rx ? calculateRxDeal(deal.rx) : null;
  const cat = getReceptionistPackage(deal.rx.packageId);
  const p = projectPackageProposal(cat.id);
  const priced = pricedPackage(deal.rx);
  const monthly = rxInvoice(priced, 0, 0).lines[0];
  const title = web && rx ? "Your new website and AI receptionist" : rx ? "Your AI receptionist" : "Your new website";
  const who = [c.contact, c.business].filter(Boolean).map(esc2).join(" · ") || "[Client name · business]";
  const deliver = [];
  if (w) {
    const wi = deal.website;
    const cms = wi.cmsComplexity === "none" ? "We make content changes for you (no editing panel)." : `Includes a ${wi.cmsComplexity} editing setup so your team can update agreed content.`;
    deliver.push(`<p><b>Website.</b> A ${wi.kind === "redesign" ? "redesigned" : "new"} business website: discovery, the agreed pages, responsive layouts for mobile and desktop, contact enquiries, basic page titles and search descriptions, testing and launch handover. ${esc2(cms)}</p>`, `<p>We prepare the agreed design for review and include ${wi.revisions.includedRounds} round${wi.revisions.includedRounds === 1 ? "" : "s"} of consolidated in-scope feedback before written approval to launch. Changes beyond the agreed scope are re-scoped and priced in writing before any extra work begins.${wi.revisions.extraRoundFeeCents === null ? "" : ` Further revision rounds are ${formatAud(wi.revisions.extraRoundFeeCents)} + GST each.${flag2("extra-revision price")}`}</p>`);
  }
  if (r) {
    deliver.push(`<p><b>AI receptionist (${esc2(cat.shortName)}).</b> Answers calls on ${cat.inclusions.phoneNumbers} number${cat.inclusions.phoneNumbers === 1 ? "" : "s"} in business hours, after hours, alongside your team or as overflow, as you choose. It says it is automated and that calls are recorded, takes structured messages and callback requests, and gives urgent wording the 000 line first. When a caller asks for a person, the receptionist takes their details and a callback request, and (once staff alerts are switched on at go-live) alerts your team by email. It does not transfer live calls. Booking into a connected Google Calendar or Cal.com calendar (up to ${cat.inclusions.calendars}) and SMS confirmations start at go-live, after the acceptance tests; where direct booking isn't possible we agree a booking-request workflow. Reports: ${esc2(cat.inclusions.reports.join("; "))}.${flag2("product readiness: confirm the receptionist is cleared to sell")}</p>`);
  }
  const oneOff = [];
  const ongoing = [];
  const payment = [];
  if (w) {
    const o = w.oneOff;
    oneOff.push(`<div><b>Website build</b><br>${money(o.priceExGstCents, o.gstCents)}${w.approval.priceMatches ? "" : flag2("price differs from the confirmed offer")}</div>`);
    if (w.recurring.enabled)
      ongoing.push(`<div><b>Website care</b><br>${money(w.recurring.revenueExGstCents, w.recurring.gstCents).replace("including GST", "per month including GST")}${w.approval.careMatches ? "" : flag2("care plan price")}</div>`);
    if (plan.manyStages)
      payment.push(`<p>The build is paid in ${o.stages.length} instalments totalling ${formatAud(o.totalInclGstCents)} including GST; the schedule is in Appendix A.${w.approval.stagesMatch ? "" : flag2("payment stages")} Work starts after this agreement, the first payment and the content and access we need.</p>`);
    else
      payment.push(`<p>Build instalments: ${o.stages.map((s) => `${formatAud(s.inclGstCents)} ${esc2(s.trigger.toLowerCase())}`).join(" / ")}, totalling ${formatAud(o.totalInclGstCents)} including GST.${w.approval.stagesMatch ? "" : flag2("payment stages")} Work starts after this agreement, the first payment and the content and access we need.</p>`);
    if (w.recurring.enabled)
      payment.push(`<p>Website care begins at launch. Proposed inclusions: hosting, routine maintenance and up to ${deal.website.care.includedChangeMinutes} minutes of content changes a month, month-to-month with 30 days' written notice.${flag2(w.approval.careMatches ? "draft care terms: inclusions and notice period await confirmation (the A$110 price is confirmed)" : "draft care terms: price, inclusions and notice period await confirmation")}</p>`);
  }
  if (r) {
    oneOff.push(`<div><b>Receptionist setup</b><br>${deal.rx.setupFeeCents === null ? `Quoted separately once approved` : `${money(deal.rx.setupFeeCents, Math.round(deal.rx.setupFeeCents / 10))}${flag2("setup fees are not approved")}`}</div>`);
    ongoing.push(`<div><b>AI receptionist · ${esc2(cat.shortName)}</b><br>${money(monthly.exGstCents, monthly.gstCents).replace("including GST", "per month including GST")}${deal.rx.monthlyDiscountBps ? flag2("discounted monthly fee") : ""}<br><span class="sub">${cat.pricing.includedMinutes.toLocaleString("en-AU")} call minutes and ${cat.pricing.includedSmsSegments.toLocaleString("en-AU")} SMS included</span></div>`);
    payment.push(`<p>Extra call minutes ${formatAud(p.display.overagePerMinute.exGstCents)} + GST, counted by the second (see "Receptionist terms in brief"). Receptionist fees are invoiced monthly ${blank("8em")} (in advance / in arrears)${flag2("billing timing is an open owner decision")}. Minimum term ${deal.rx.termMonths} months, then ${cat.pricing.noticeDays} days' written notice.${deal.rx.termMonths !== cat.pricing.minimumTermMonths ? flag2("term differs from catalogue") : flag2("minimum term is proposed")} How a first part-month is charged is still to be agreed.${flag2("first-month charging is an open owner decision")}</p>`);
  }
  payment.push(`<p class="small">No direct debit is authorised by this document; the payment method is arranged separately. All prices in Australian dollars.</p>`);
  const both = web && rx;
  const workingSupply = `<p>You supply approved text, images, business details and permission to use them, plus the access we need${rx ? " (calendar access is granted by you; no passwords are shared)" : ""}. We agree a ${web ? "launch" : "go-live"} date once content and access are available, and discuss delays promptly. We correct in-scope defects; scope or timing changes need written agreement. No search-ranking, lead-volume, booking or revenue guarantees apply.</p>`;
  const workingOwnership = `<p>After full payment, you own the bespoke deliverables; pre-existing tools and third-party components keep their own licences. Both parties protect confidential information and use it only for this work. If cancelled early, payments are reconciled against authorised work completed and approved unavoidable costs; unearned amounts are refunded. NSW law applies; Australian Consumer Law rights are not excluded.</p>`;
  const working = both ? workingSupply : workingSupply + workingOwnership;
  const page1 = `<section class="sheet">
<header><div class="logo">M&amp;U Ventures</div><div class="meta">${esc2(longDate(deal.quote.preparedOn))}<br>Proposed agreement · ${esc2(deal.quote.number)}</div></header>
<h1>${title}</h1>
<p class="parties">Prepared for ${who}<br>Supplier: ${esc2(SUPPLIER.legalName)}<br>ABN ${SUPPLIER.abn} · ${esc2(SUPPLIER.region)}${flag2("supplier address")}<br>Client legal entity / ABN: ${c.abn ? esc2(c.abn) : blank("22em")}</p>
<h2>What we will deliver</h2>${deliver.join("")}${plan.appendix ? `<p class="small"><b>Appendix A</b> (${esc2(plan.reasons.join("; "))}) forms part of this agreement.</p>` : ""}
<h2>Investment &amp; payment</h2>
<table><thead><tr><th>One-off</th><th>Ongoing</th></tr></thead><tbody><tr><td>${oneOff.join("") || "—"}</td><td>${ongoing.join("") || "—"}</td></tr></tbody></table>
${payment.join("")}
<h2>Working together</h2>${working}
<div class="sign"><div><b>M&amp;U Ventures</b><span class="line"></span>Names: ${esc2(SUPPLIER.signatories)}<br>Date: ${blank("8em")}</div><div><b>Client authorised representative</b><span class="line"></span>Name / role: ${blank("10em")}<br>Date: ${blank("8em")}</div></div>
</section>`;
  const rxTerms = r ? `<h2>Receptionist terms in brief</h2>
<ul class="terms">
<li><b>Usage billing.</b> Connected call time is counted by the second, added up over the month and rounded up to a whole minute once. Calls under ${cat.pricing.billing.minimumBillableSeconds} seconds, calls that never reach the receptionist and our own test and demo calls don't count. Extra minutes ${formatAud(p.display.overagePerMinute.exGstCents)} + GST (${formatAud(p.display.overagePerMinute.inclGstCents)}); extra SMS segments ${formatAud(p.display.extraSmsSegment.exGstCents)} + GST. Allowances reset monthly and don't roll over.</li>
<li><b>Not included.</b> Live transfer to a person, emergency services, clinical, legal or financial advice, and practice-management software (Cliniko, Dentally and similar).</li>
<li><b>Acceptance.</b> Before go-live the line only takes messages. We run ${"five"} scripted test calls with you; go-live starts when you confirm in writing that they passed. You can switch call forwarding off at any time.</li>
<li><b>Not an emergency service.</b> Anyone describing an emergency is told to hang up and call 000.</li>
<li><b>Privacy.</b> We handle caller information only to provide the service and on your instructions. Call audio and transcripts are processed by our providers, including in the United States; your privacy policy must say so before go-live.</li>
<li><b>SMS.</b> Texts are sent only with the caller's consent given on the call, and every text can be stopped by replying STOP.</li>
<li><b>Support.</b> ${esc2(cat.support.hours)}; first response ${esc2(cat.support.firstResponse.toLowerCase())}. ${esc2(cat.support.reviews)}.</li>
<li><b>Summary only.</b> These points summarise M&amp;U's full receptionist service agreement, which is a draft still under legal review. They do not replace it.${flag2("full service agreement is not yet approved")}</li>
<li><b>Liability.</b> To the extent the law allows, each party's liability is limited to the fees paid in the 3 months before the claim, and neither is liable for indirect loss.${flag2("subject to legal review")}</li>
</ul>` : "";
  const webChecklist = web ? `<h3>Website</h3>
<p>${box("Home")} ${box("About")} ${box("Services")} ${box("Team")} ${box("Contact")} ${box("Other")} ${blank("8em")}</p>
<p>Content we'll receive: ${box("Logo")} ${box("Photos")} ${box("Team bios")} ${box("Existing text we may reuse")}</p>
<p>Domain is registered with ${blank("10em")} · Enquiries go to ${blank("14em")}</p>` : "";
  const rxChecklist = r ? `<h3>Receptionist</h3>
<p>Cover: ${box("Business hours")} ${box("After hours")} ${box("Overflow / busy")} ${box("All calls")} · Number(s) to forward: ${blank("9em")}</p>
<p>Calendar: ${box("Google Calendar")} ${box("Cal.com")} ${box("Other")} ${blank("8em")} · Bookable appointment types: ${blank("10em")}</p>
<p>Urgent wording for your business: ${blank("16em")} · Alerts go to: ${blank("12em")}</p>` : "";
  const notes = plan.longNotes ? [] : plan.notes;
  const page2 = `<section class="sheet">
<header><div class="logo">M&amp;U Ventures</div><div class="meta">${esc2(c.business || "Client")}<br>Terms in brief and setup checklist</div></header>
${both ? `<h2>Ownership, cancellation and law</h2>${workingOwnership}` : ""}
${rxTerms}
${notes.length ? `<h2>Special terms</h2><ul class="terms">${notes.map((n) => `<li>${esc2(n)}</li>`).join("")}</ul>` : ""}
<h1 class="h1-2">A few details to get started</h1>
<p class="small">Tick your preferences below, or reply by email with your selections.</p>
${webChecklist}${rxChecklist}
<h3>Approval and timing</h3>
<p>Person approving the work: ${blank("16em")} · Preferred ${web ? "launch" : "go-live"} date: ${blank("10em")}</p>
<h3>Anything essential we missed? (optional)</h3>
<div class="lines">${"<span></span>".repeat(notes.length ? 2 : 4)}</div>
</section>`;
  const q = effectiveQuote(deal);
  const section = (title, text) => textLines(text).length ? `<h2>${title}</h2><ul class="terms">${textLines(text).map((l) => `<li>${esc2(l)}</li>`).join("")}</ul>` : "";
  const appendix = plan.appendix ? `<section class="appendix">
<header><div class="logo">M&amp;U Ventures</div><div class="meta">${esc2(c.business || "Client")}<br>Appendix A · ${esc2(q.number)}</div></header>
<h1 class="h1-2">Appendix A</h1>
<p class="small">This appendix forms part of the proposed agreement dated ${esc2(longDate(q.preparedOn))}.</p>
${plan.manyStages && w ? `<h2>Payment schedule (website build)</h2><table><thead><tr><th>Stage</th><th>When it is due</th><th>Amount including GST</th></tr></thead><tbody>${w.oneOff.stages.map((st) => `<tr><td>${esc2(st.label)} (${st.shareBps / 100}%)</td><td>${esc2(st.trigger)}</td><td>${formatAud(st.inclGstCents)}<br><span class="sub">${formatAud(st.exGstCents)} + ${formatAud(st.gstCents)} GST</span></td></tr>`).join("")}</tbody></table>` : ""}
${plan.customText ? section("Scope", q.scope) : ""}${plan.customText ? section("Deliverables", q.deliverables) + section("Not included", q.exclusions) + section("Timeline", q.timeline) + section("Ongoing costs and responsibilities", q.responsibilities) : ""}${plan.longNotes ? section("Special terms", q.notes) : ""}
</section>` : "";
  const body = page1 + page2 + appendix;
  const flags = (body.match(/class="flag"/g) ?? []).length;
  const draftBar = flags ? `<div class="draftbar">Draft for review. ${flags} item${flags === 1 ? "" : "s"} marked “Needs approval” must be resolved before this is issued or signed.</div>` : "";
  const pages = body.replace('<section class="sheet">', `<section class="sheet">${draftBar}`);
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc2(title)}: proposed agreement</title>
<style>
@page{size:A4;margin:0}
:root{--ink:#1c1a16;--muted:#6f6656;--gold:#8f6f2e;--rule:#b8963f;--paper:#fdfbf4;--line:#e5ddc8;--flag:#8a2b17}
*{box-sizing:border-box}html,body{margin:0;background:#d9d3c4}
body{color:var(--ink);font:10.5pt/1.5 Inter,"Segoe UI",system-ui,sans-serif}
.sheet{width:210mm;min-height:297mm;margin:10mm auto;background:var(--paper);padding:13mm 15mm 14mm;position:relative;box-shadow:0 2px 10px rgba(0,0,0,.12)}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1.2pt solid var(--rule);padding-bottom:2.6mm;margin-bottom:3.4mm}
.logo{font-family:Fraunces,Georgia,serif;font-size:19pt;font-weight:500;letter-spacing:-.01em}
.meta{text-align:right;font-size:9pt;color:var(--muted);font-weight:600}
h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:22pt;line-height:1.1;margin:0 0 2mm}.h1-2{font-size:18pt;margin-top:4mm}
h2{font-size:9.4pt;letter-spacing:.09em;text-transform:uppercase;color:var(--gold);margin:3.6mm 0 1.4mm;font-weight:700}
h3{font-size:9.4pt;letter-spacing:.06em;text-transform:uppercase;color:var(--gold);margin:3mm 0 1mm}
p{margin:0 0 1.6mm}.small{font-size:9.6pt;color:#3d382f}.parties{font-weight:600;font-size:10pt}
table{width:100%;border-collapse:collapse;margin:1mm 0 2mm;table-layout:fixed}
th{background:#f0e9d8;text-align:left;font-weight:600;font-size:10pt;padding:1.6mm 2.4mm;border:.6pt solid var(--line)}
td{vertical-align:top;padding:2mm 2.4mm;border:.6pt solid var(--line)}td>div+div{margin-top:2mm}
.sub{color:var(--muted);font-size:9.6pt}
.flag{display:inline-block;font-size:8.5pt;font-weight:700;color:var(--flag);background:#f9e9e2;border:.6pt solid #dcab9c;border-radius:3pt;padding:0 3pt;margin-left:2pt;vertical-align:1pt}
.blank{display:inline-block;border-bottom:.7pt solid var(--ink);height:1em;vertical-align:-2pt}
.opt{white-space:nowrap;margin-right:3mm}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:8mm;margin-top:4mm;font-size:10pt}.sign .line{display:block;border-bottom:.7pt solid var(--ink);height:8mm;margin-bottom:1.2mm}
ul.terms{margin:0;padding-left:4.5mm}ul.terms li{margin:0 0 1.4mm}
.lines span{display:block;border-bottom:.6pt solid var(--line);height:8mm}

@media print{html,body{background:var(--paper)}.flag,.draftbar,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media screen and (max-width:820px){.sheet{transform-origin:top left;margin:0}}
.draftbar{background:#f9e9e2;border:.6pt solid #dcab9c;color:var(--flag);font-weight:700;font-size:9pt;padding:1.2mm 2.6mm;border-radius:3pt;margin:0 0 3mm}
.parties,td,.meta,li,p{overflow-wrap:anywhere}.meta{max-width:60%}
.appendix{width:210mm;min-height:297mm;margin:10mm auto;background:var(--paper);padding:13mm 15mm 14mm;box-shadow:0 2px 10px rgba(0,0,0,.12)}
/* Print: real A4 pages with margins; content flows onto extra pages instead of being clipped or shrunk.
   Each section starts on a new page; signature blocks, table rows and list items are never split. */
@page{size:A4;margin:13mm 15mm 14mm;@bottom-right{content:"Page " counter(page) " of " counter(pages);font:8.5pt Inter,"Segoe UI",sans-serif;color:#6f6656}}
@media print{.sheet,.appendix{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}.sheet+.sheet,.appendix{break-before:page}
  .sign,tr,li,.parties{break-inside:avoid}h2,h3{break-after:avoid}}
</style></head><body>${pages}</body></html>`;
}

// src/lib/deal-desk/validate.ts
function validateDeal(deal) {
  try {
    calculateWebsite(deal.website);
    calculateRxDeal(deal.rx);
    renderQuoteHtml(buildQuote(deal));
    renderAgreementHtml(deal);
    return null;
  } catch (e) {
    return e.message || "This deal cannot be calculated.";
  }
}

// tools/deal-desk/shared.ts
class ConflictError extends Error {
  current;
  constructor(current, message = "Someone else saved a newer version of this workbook.") {
    super(message);
    this.current = current;
  }
}

class RequestError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
var tokenRequest = null;
function pageToken() {
  tokenRequest ??= fetch("/__token", { credentials: "same-origin" }).then((r) => r.ok ? r.json() : null).then((j) => typeof j?.token === "string" ? j.token : "").catch(() => "");
  return tokenRequest;
}
async function call(path, body) {
  const send = async () => fetch(`/__operator/leads/deal-desk${path}`, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await pageToken() }, body: JSON.stringify(body) });
  let r = await send();
  if (r.status === 403 && body !== undefined) {
    tokenRequest = null;
    r = await send();
  }
  const json = await r.json().catch(() => null);
  if (!r.ok)
    throw classify(r.status, json, body?.baseRev);
  return json;
}
function classify(status, json, baseRev) {
  const message = typeof json?.error === "string" && json.error ? json.error : `Request failed (${status})`;
  if (status !== 409)
    return new RequestError(message, status);
  const cur = json?.current;
  if (cur === null && baseRev)
    return new ConflictError(null, message);
  if (cur && typeof cur.rev === "number" && cur.rev !== baseRev) {
    try {
      return new ConflictError(toRecord(cur), message);
    } catch {
      return new RequestError(message, status);
    }
  }
  return new RequestError(message, status);
}
function toRecord(raw) {
  return {
    id: String(raw.id),
    rev: Number(raw.rev) || 0,
    updatedAt: String(raw.updatedAt ?? ""),
    updatedBy: raw.updatedBy ?? "local",
    deal: raw.deal ? parseDealShape(raw.deal, "Saved workbook") : null,
    draft: raw.draft ? parseDealShape(raw.draft, "Unfinished changes") : null,
    problem: raw.problem ?? null,
    leadId: raw.leadId ?? null,
    crmDealRef: raw.crmDealRef ?? null,
    archived: Boolean(raw.archived)
  };
}
var shared = {
  async available() {
    try {
      const r = await fetch("/__operator/leads/deal-desk/list", { credentials: "same-origin" });
      return r.ok && (r.headers.get("content-type") ?? "").includes("json");
    } catch {
      return false;
    }
  },
  async list() {
    return (await call("/list")).deals;
  },
  async get(id) {
    const raw = await call(`/get?id=${encodeURIComponent(id)}`);
    if (raw?.status === "damaged")
      return { id, error: "This saved workbook could not be read.", raw: typeof raw.raw === "string" ? raw.raw : null };
    try {
      return toRecord(raw);
    } catch (e) {
      return { id, error: e.message, raw: JSON.stringify(raw) };
    }
  },
  async save(deal, baseRev) {
    return toRecord((await call("/save", { deal, baseRev })).record);
  },
  async archive(id, baseRev) {
    return toRecord((await call("/archive", { id, baseRev })).record);
  },
  async link(id, baseRev, crmDealRef) {
    return toRecord((await call("/link", { id, baseRev, crmDealRef })).record);
  },
  async attach(id, baseRev, lead) {
    const r = await call("/attach", { id, baseRev, lead });
    return { record: toRecord(r.record), files: r.files };
  }
};
function refreshDecision(x) {
  if (x.inFlight)
    return "skip";
  if (x.lastSent !== undefined && x.incoming === x.lastSent)
    return "ours";
  if (x.dirty || x.timerPending)
    return "conflict";
  return "replace";
}
async function sessionCanWrite() {
  try {
    const r = await fetch("/__devices/me", { credentials: "same-origin" });
    const me = r.ok ? await r.json() : null;
    return { canWrite: me?.principal?.actor === "human", who: me?.principal?.displayName ?? me?.person?.name ?? null };
  } catch {
    return { canWrite: false, who: null };
  }
}
var ownerName = (o) => o === "usman" ? "Usman" : o === "mehroz" ? "Mehroz" : "this PC";

// src/lib/price-status.ts
var MONTHS2 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day2(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${Number(m[3])} ${MONTHS2[Number(m[2]) - 1]} ${m[1]}` : null;
}
function priceStatusLines(pkg) {
  const p = pkg.pricing;
  const exGst = p.monthly.gst === "exclusive";
  const gst = exGst ? "ex GST, +10% GST on invoices (M&U is GST registered)" : p.monthly.gst === "inclusive" ? "incl. GST" : "no GST";
  const monthlyApproved = p.status === "approved";
  const setupApproved = (p.setupStatus ?? p.status) === "approved";
  const when = day2(p.approvedAt);
  return {
    monthly: {
      approved: monthlyApproved,
      text: monthlyApproved ? `Monthly price, included minutes, extra-minute rate: Approved${when ? ` ${when}` : ""} (${exGst ? "ex GST, +10% GST" : gst})` : "Monthly price, included minutes, extra-minute rate: Proposed, not approved"
    },
    setup: { approved: setupApproved, text: setupApproved ? "Setup fee: Approved" : "Setup fee: Proposed, not approved" },
    pilot: { approved: false, text: "Pilot terms: Not approved" },
    gst
  };
}

// tools/deal-desk/app.ts
var TABS = [
  { id: "deal", label: "Deal" },
  { id: "website", label: "Website" },
  { id: "receptionist", label: "Receptionist" },
  { id: "quote", label: "Quote" },
  { id: "agreement", label: "Agreement" },
  { id: "checks", label: "Checks & sources" }
];
var TAB_IDS = TABS.map((t) => t.id);
var today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date);
var store = {
  rev() {
    try {
      return Number(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").rev ?? 0);
    } catch {
      return 0;
    }
  },
  read() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!raw)
      return null;
    let s;
    try {
      s = JSON.parse(raw);
      if (!s || typeof s !== "object" || !Array.isArray(s.deals))
        throw new Error("shape");
    } catch {
      return { deals: [], drafts: new Map, quarantined: [], unreadable: true, currentId: "", tab: "deal", rev: 0 };
    }
    const deals = [];
    const quarantined = [];
    const drafts = new Map;
    for (const item of [...s.deals, ...Array.isArray(s.quarantined) ? s.quarantined : []]) {
      try {
        const d = parseDealShape(item);
        if (deals.some((x) => x.id === d.id))
          throw new Error("duplicate");
        deals.push(d);
        if (validateDeal(d))
          drafts.set(d.id, validateDeal(d));
        else
          lastValid.set(d.id, structuredClone(d));
      } catch {
        quarantined.push(item);
      }
    }
    for (const [id, raw] of Object.entries(s.drafts && typeof s.drafts === "object" ? s.drafts : {})) {
      try {
        const d = parseDealShape(raw, "Unfinished changes");
        const i = deals.findIndex((x) => x.id === id);
        if (i < 0)
          deals.push(d);
        else
          deals[i] = d;
        drafts.set(id, validateDeal(d) ?? "unfinished");
      } catch {
        quarantined.push(raw);
      }
    }
    return { deals, drafts, quarantined, unreadable: false, currentId: String(s.currentId ?? ""), tab: TAB_IDS.includes(s.tab) ? s.tab : "deal", rev: Number(s.rev ?? 0) || 0 };
  },
  write() {
    try {
      if (state.locked)
        return "locked";
      if (localStorage.getItem(STORAGE_KEY) !== null && store.rev() !== state.rev)
        return "conflict";
      const complete = state.deals.map((d) => invalid.has(d.id) ? lastValid.get(d.id) : d).filter((d) => Boolean(d));
      const drafts = Object.fromEntries(state.deals.filter((d) => invalid.has(d.id)).map((d) => [d.id, d]));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ rev: state.rev + 1, deals: complete, drafts, quarantined: state.quarantined, currentId: state.currentId, tab: state.tab }));
      state.rev += 1;
      return "ok";
    } catch {
      return "failed";
    }
  }
};
var lastValid = new Map;
var invalid = new Map;
var saved = store.read();
for (const [id, why] of saved?.drafts ?? [])
  invalid.set(id, why);
var state = {
  deals: saved && saved.deals.length ? saved.deals : seedDeals(),
  quarantined: saved?.quarantined ?? [],
  locked: saved?.unreadable ?? false,
  currentId: saved?.currentId || "seed-dental-pro",
  tab: saved?.tab ?? "deal",
  rev: saved ? saved.rev : store.rev(),
  savedAt: "",
  save: saved?.unreadable ? "locked" : "ok",
  invalidWhy: "",
  agreementOver: [],
  agreementChecked: false,
  mode: "local",
  revs: new Map,
  by: new Map,
  links: new Map,
  conflict: null,
  readOnly: false,
  withheld: false,
  localOffer: [],
  offerOpen: false,
  note: ""
};
var params = new URLSearchParams(location.search);
if (params.get("deal"))
  state.currentId = params.get("deal");
if (TABS.some((t) => t.id === params.get("tab")))
  state.tab = params.get("tab");
if (!state.deals.some((d) => d.id === state.currentId))
  state.currentId = state.deals[0].id;
var deal = () => state.deals.find((d) => d.id === state.currentId);
var esc3 = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var aud = (c) => c === null || c === undefined ? "Unknown" : formatAud(Math.round(c));
var cls = (n) => n === null || n === undefined ? "" : n < 0 ? "neg" : "pos";
var dur = (s) => {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m.toLocaleString("en-AU")}:${String(r).padStart(2, "0")}` : m.toLocaleString("en-AU");
};
var minsText = (s) => `${dur(s)} min`;
var money2 = (c) => c === null ? "" : (c / 100).toFixed(2);
var usd6 = (micros) => micros === null || micros === undefined ? "" : String(micros / 1e6);
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}
function parseValue(kind, raw, el) {
  switch (kind) {
    case "money":
      return parseDecimal(raw, 2);
    case "money?":
      return raw.trim() === "" ? null : parseDecimal(raw, 2);
    case "hours":
      return Math.round(parseDecimal(raw, 2) * 60 / 100);
    case "int":
      return parseDecimal(raw, 0);
    case "selectnum":
      return Number(raw);
    case "pct": {
      const v = parseDecimal(raw, 2);
      if (v > 1e4)
        throw new Error("At most 100%");
      return v;
    }
    case "rate6":
      return parseDecimal(raw, 6);
    case "rate6?":
      return raw.trim() === "" ? null : parseDecimal(raw, 6);
    case "dur": {
      const m = /^\s*(\d{1,3}(?:,\d{3})*|\d+)(?::(\d{1,2}))?\s*$/.exec(raw);
      if (!m)
        throw new Error("Minutes, or minutes:seconds (e.g. 1000:01)");
      const secs = Number(m[2] ?? 0);
      if (secs > 59)
        throw new Error("Seconds must be 0–59");
      return Number(m[1].replace(/,/g, "")) * 60 + secs;
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw))
        throw new Error("Use YYYY-MM-DD");
      return raw;
    case "bool":
      return el.checked;
    default:
      return raw;
  }
}
function display(kind, v) {
  switch (kind) {
    case "money":
    case "money?":
      return money2(v);
    case "hours":
      return String(Math.round(v / 60 * 100) / 100);
    case "pct":
      return String(v / 100);
    case "rate6":
    case "rate6?":
      return usd6(v);
    case "dur":
      return dur(v);
    default:
      return v ?? "";
  }
}
var GENERATED_QUOTE_KEYS = ["projectTitle", "summary", "scope", "deliverables", "exclusions", "timeline", "responsibilities"];
var viewPath = (path) => path.startsWith("quote.") ? getPath({ quote: effectiveQuote(deal()) }, path) : getPath(deal(), path);
function field(path, label, kind, opts = {}) {
  const v = viewPath(path);
  const id = `f-${path.replace(/\./g, "-")}`;
  if (kind === "bool")
    return `<label class="check${opts.wide ? " wide" : ""}" for="${id}"><input id="${id}" type="checkbox" data-bind="${path}" data-kind="bool" ${v ? "checked" : ""}><span>${esc3(label)}</span></label>`;
  const inputmode = kind === "text" ? "" : kind === "int" ? ` inputmode="numeric"` : kind === "date" ? "" : ` inputmode="decimal"`;
  return `<div class="field${opts.wide ? " wide" : ""}"><label for="${id}">${esc3(label)}</label><div class="inwrap">${opts.prefix ? `<span class="affix">${opts.prefix}</span>` : ""}<input id="${id}" data-bind="${path}" data-kind="${kind}" value="${esc3(display(kind, v))}"${inputmode} placeholder="${esc3(opts.placeholder ?? (kind.endsWith("?") ? "Unknown" : ""))}" autocomplete="off">${opts.suffix ? `<span class="affix">${opts.suffix}</span>` : ""}</div>${opts.hint ? `<small class="hint">${esc3(opts.hint)}</small>` : ""}<small class="err" data-err-for="${path}"></small></div>`;
}
function select(path, label, options, kind = "select", action = "") {
  const v = String(getPath(deal(), path));
  const id = `f-${path.replace(/\./g, "-")}`;
  return `<div class="field"><label for="${id}">${esc3(label)}</label><select id="${id}" data-bind="${path}" data-kind="${kind}"${action ? ` data-after="${action}"` : ""}>${options.map(([val, text]) => `<option value="${esc3(val)}" ${val === v ? "selected" : ""}>${esc3(text)}</option>`).join("")}</select></div>`;
}
var area = (path, label, hint = "") => {
  const id = `f-${path.replace(/\./g, "-")}`;
  return `<div class="field wide"><label for="${id}">${esc3(label)}</label><textarea id="${id}" rows="5" data-bind="${path}" data-kind="text">${esc3(viewPath(path))}</textarea>${hint ? `<small class="hint">${esc3(hint)}</small>` : ""}</div>`;
};
var card = (title, body, extra = "") => `<section class="card ${extra}"><h3>${title}</h3>${body}</section>`;
var stat = (label, value, tone = "", sub = "") => `<div class="stat ${tone}"><span>${esc3(label)}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
var flagList = (items, title = "Needs owner approval") => items.length ? `<div class="flags"><strong>${title}</strong><ul>${items.map((i) => `<li>${esc3(i)}</li>`).join("")}</ul></div>` : "";
var unknownList = (items) => items.length ? `<div class="unknowns"><strong>Unknown costs: excluded from totals, not zero</strong><ul>${items.map((i) => `<li>${esc3(i)}</li>`).join("")}</ul></div>` : "";
function offerPanel() {
  const shared2 = new Map(state.deals.map((d) => [d.id, d]));
  const rows = state.localOffer.map((d, i) => {
    const there = shared2.get(d.id);
    const same = there && JSON.stringify({ ...there, updatedAt: "" }) === JSON.stringify({ ...d, updatedAt: "" });
    const why = validateDeal(d);
    const outcome = same ? "Already in the shared workspace (identical): skipped" : there ? "A different shared workbook has this id: copied as a new workbook" : "New: copied as it is";
    return `<tr><td><input type="checkbox" id="offer-${i}" data-offer="${i}" ${same ? "disabled" : "checked"} aria-label="Copy ${esc3(d.name)}"></td><th scope="row"><label for="offer-${i}">${esc3(d.name)}</label><small>${esc3(d.client.business || "No client name")} · saved here ${esc3(d.updatedAt)}</small></th><td class="small">${esc3(outcome)}${why ? `<br><span class="warn">Unfinished: arrives as a draft (${esc3(why)})</span>` : ""}</td></tr>`;
  }).join("");
  return `<section class="card offer-panel" aria-label="Copy deals to the shared workspace"><h3>Copy deals from this browser to the shared workspace</h3>
<p class="small muted">Nothing is sent until you choose. Copies are saved for both founders; the originals stay in this browser.</p>
<div class="tablewrap"><table><thead><tr><th>Copy</th><th>Deal</th><th>What happens</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="actions"><button data-action="offer-copy">Copy selected</button><button class="ghost" data-action="offer-close">Not now</button></div></section>`;
}
function dealTab() {
  const d = deal();
  return `<div class="cols"><div class="form">
${card("Client", `<div class="grid">${field("client.business", "Business name", "text")}${field("client.contact", "Contact", "text")}${field("client.email", "Email", "text")}${field("client.phone", "Phone", "text")}${field("client.address", "Location", "text", { wide: true })}${field("client.abn", "Client ABN", "text")}${select("client.sector", "Sector", [["dental", "Dental"], ["legal", "Legal / conveyancing"], ["property", "Real estate"], ["other", "Other"]])}</div>`)}
${card("What is being quoted", `<div class="grid">${field("name", "Deal name (internal)", "text", { wide: true })}${field("include.website", "Website project", "bool")}${field("include.receptionist", "AI receptionist", "bool")}</div>
<p class="muted small">${d.synthetic ? "This is a <b>synthetic example</b>: invented business and usage, kept apart from production records." : state.mode === "shared" ? "Shared with both founders." : "Saved in this browser only."}</p>`)}
${state.mode === "shared" ? sharedLinksCard() : ""}
</div><div class="out" id="out">${safe2(dealOut)}</div></div>`;
}
function sharedLinksCard() {
  const d = deal();
  const link = state.links.get(d.id);
  const by = state.by.get(d.id);
  const unsaved = !state.revs.get(d.id);
  const draft = invalid.has(d.id);
  return card("Links", `<p class="small muted">${by ? `Last saved by ${esc3(ownerName(by.who))}, ${esc3(clock(by.at))}.` : "Not saved yet."} This workbook holds pricing and draft documents; the CRM deal stays the record of the sale.</p>
<div class="grid"><div class="field wide"><label for="crm-ref">CRM deal (crm:deal:…)</label><input id="crm-ref" value="${esc3(link?.crm ?? "")}" placeholder="crm:deal:" autocomplete="off"></div></div>
<div class="actions"><button class="ghost small" data-action="crm-link" ${unsaved ? "disabled" : ""}>Save CRM link</button></div>
<div class="grid"><div class="field"><label for="lead-id">Lead number</label><input id="lead-id" inputmode="numeric" value="${esc3(link?.leadId ?? "")}" autocomplete="off"></div></div>
<div class="actions"><button class="ghost small" data-action="lead-attach" ${unsaved || draft ? "disabled" : ""}>Add the quote and agreement to this lead's drafts</button></div>
${draft ? `<p class="small warn">Finish the unfinished changes before adding documents to a lead.</p>` : ""}${link?.leadId ? `<p class="small ok">Documents added to lead ${esc3(link.leadId)}.</p>` : ""}`);
}
function dealOut() {
  const d = deal();
  const parts = [];
  if (d.include.website) {
    const w = calculateWebsite(d.website);
    parts.push(card("Website (one-off)", `<div class="stats">${stat("Price incl. GST", aud(w.oneOff.totalInclGstCents))}${stat("Gross profit", aud(w.oneOff.grossProfitCents), cls(w.oneOff.grossProfitCents), pctText(w.oneOff.marginBps))}${stat("Per founder hour", aud(w.oneOff.effectiveHourlyCents))}</div>`));
    if (w.recurring.enabled)
      parts.push(card("Care plan (monthly)", `<div class="stats">${stat("Fee incl. GST", aud(w.recurring.inclGstCents))}${stat("Profit / month", aud(w.recurring.profitCents), cls(w.recurring.profitCents), pctText(w.recurring.marginBps))}${stat(`${w.horizon.months}-month total`, aud(w.horizon.recurringProfitCents), cls(w.horizon.recurringProfitCents))}</div>`));
  }
  if (d.include.receptionist) {
    const r = calculateRxDeal(d.rx);
    const e = r.columns.find((c) => c.id === "expected");
    parts.push(card(`Receptionist · ${esc3(getReceptionistPackage(d.rx.packageId).shortName)} (monthly, expected use)`, `<div class="stats">${stat("Invoice incl. GST", aud(e.invoice.inclGstCents))}${stat("Operating profit", aud(e.operatingCents), cls(e.operatingCents), pctText(e.operatingMarginBps))}${stat(`${r.term.months}-month term`, aud(r.term.operatingCents), cls(r.term.operatingCents), "after onboarding")}</div>`));
  }
  if (!parts.length)
    parts.push(card("Nothing selected", `<p class="muted">Tick a website project, an AI receptionist, or both.</p>`));
  return parts.join("") + compareTable();
}
function compareTable() {
  const rows = state.deals.map((d) => {
    let web = "—", care = "—", rx = "—";
    try {
      if (d.include.website) {
        const w = calculateWebsite(d.website);
        web = `${aud(w.oneOff.grossProfitCents)} <small>${pctText(w.oneOff.marginBps)}</small>`;
        if (w.recurring.enabled)
          care = `${aud(w.recurring.profitCents)} <small>/mo</small>`;
      }
      if (d.include.receptionist) {
        const r = calculateRxDeal(d.rx);
        const e = r.columns.find((c) => c.id === "expected");
        rx = `${aud(e.operatingCents)} <small>/mo · ${pctText(e.operatingMarginBps)}</small>`;
      }
    } catch {
      web = "Check inputs";
    }
    return `<tr class="${d.id === state.currentId ? "current" : ""}"><th scope="row"><button class="link" data-action="open" data-id="${esc3(d.id)}">${esc3(d.name)}</button></th><td>${web}</td><td>${care}</td><td>${rx}</td></tr>`;
  }).join("");
  return card("Compare saved deals", `<div class="tablewrap"><table><thead><tr><th>Deal</th><th>Build profit</th><th>Care plan</th><th>Receptionist (expected)</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}
function websiteTab() {
  const d = deal();
  const w = d.website;
  const effort = Object.keys(EFFORT_LABELS).map((k) => field(`website.effortMinutes.${k}`, EFFORT_LABELS[k], "hours", { suffix: "h" })).join("");
  const costs = w.costs.map((c, i) => `<div class="row-edit"><div class="grid">${field(`website.costs.${i}.label`, "Cost", "text", { wide: true })}${field(`website.costs.${i}.cents`, `Amount (${c.currency})`, "money?", { prefix: c.currency === "USD" ? "US$" : "A$" })}${select(`website.costs.${i}.currency`, "Currency", [["AUD", "AUD"], ["USD", "USD"]])}${select(`website.costs.${i}.frequency`, "When", [["one-off", "One-off (build)"], ["monthly", "Monthly (care plan)"]])}${field(`website.costs.${i}.sharedAcross`, "Shared across sites", "int")}</div><small class="hint">${esc3(c.evidence === "public-list" ? `Public list price, checked ${c.checkedAt}` : c.cents === null ? "Unknown: excluded from totals" : "Entered: an assumption")}${c.note ? ` · ${esc3(c.note)}` : ""}</small><button class="ghost small" data-action="remove-cost" data-i="${i}">Remove</button></div>`).join("");
  const stages = w.stages.map((s, i) => `<div class="row-edit"><div class="grid">${field(`website.stages.${i}.label`, "Stage", "text")}${field(`website.stages.${i}.shareBps`, "Share", "pct", { suffix: "%" })}${field(`website.stages.${i}.trigger`, "When it's due", "text", { wide: true })}</div>${w.stages.length > 1 ? `<button class="ghost small" data-action="remove-stage" data-i="${i}">Remove</button>` : ""}</div>`).join("");
  const presetIdx = PAYMENT_PRESETS.findIndex((p) => p.percentBps === w.payment.percentBps && p.fixedCents === w.payment.fixedCents);
  return `<div class="cols"><div class="form">
${card("Price", `<div class="grid">${select("website.kind", "Project", [["build", "New website"], ["redesign", "Redesign"]])}${field("website.price.cents", "Quoted price", "money", { prefix: "A$" })}${select("website.price.gst", "Price is", [["inclusive", "Incl. GST"], ["exclusive", "Ex GST"]])}
${select("website.discount.type", "Discount", [["none", "None"], ["percent", "Percent"], ["fixed", "Fixed amount"]], "select", "discount")}
${w.discount.type === "percent" ? field("website.discount.bps", "Discount", "pct", { suffix: "%" }) : w.discount.type === "fixed" ? field("website.discount.cents", "Discount (ex GST)", "money", { prefix: "A$" }) : ""}</div>
<p class="muted small">Owner-confirmed offer: A$1,650 incl. GST, 50% deposit, 50% at approved launch, A$110/month care. Any other figure is a scenario.</p>`)}
${card("Design, build and content effort", `<p class="muted small">Hours are placeholders, not measured. Replace them with your own estimate for this project.</p><div class="grid">${select("website.cmsComplexity", "CMS complexity", Object.keys(CMS_PRESETS).map((k) => [k, CMS_PRESETS[k].label]), "select", "cms")}${field("website.labourHourlyCents", "Founder hour valued at", "money", { prefix: "A$", hint: "Assumption (A$60 in the economics model)" })}${effort}</div>`)}
${card("Revisions", `<div class="grid">${field("website.revisions.includedRounds", "Included rounds", "int")}${field("website.revisions.minutesPerRound", "Hours per round", "hours", { suffix: "h" })}${field("website.revisions.expectedExtraRounds", "Extra rounds expected", "int")}${field("website.revisions.extraRoundFeeCents", "Fee per extra round (ex GST)", "money?", { prefix: "A$", placeholder: "Not charged" })}</div>`)}
${card("Hosting, software and third-party costs", `${costs}<button class="ghost" data-action="add-cost">Add a cost</button><div class="grid" style="margin-top:12px">${field("website.fx.usdPerAudMillionths", "US$ per A$1 (for USD costs)", "rate6", { hint: "RBA reference rate" })}${field("website.fx.date", "Rate date", "date")}${field("website.fx.cardFeeBps", "Card FX buffer", "pct", { suffix: "%" })}</div><p class="muted small">Leave an amount blank when it isn't known: it stays unknown and is listed, never counted as zero.</p>`)}
${card("Contingency and target", `<div class="grid">${field("website.contingencyBps", "Contingency on hours and costs", "pct", { suffix: "%" })}${field("website.targetMarginBps", "Target build margin", "pct", { suffix: "%", hint: "Planning target, not an approved policy" })}</div>`)}
${card("Payment stages", `${stages}<button class="ghost" data-action="add-stage">Add a stage</button><div class="grid">${`<div class="field"><label for="pay-preset">How the client pays</label><select id="pay-preset" data-action-change="payment-preset">${PAYMENT_PRESETS.map((p, i) => `<option value="${i}" ${i === presetIdx ? "selected" : ""}>${esc3(p.label)}</option>`).join("")}${presetIdx < 0 ? `<option selected>Custom</option>` : ""}</select></div>`}${field("website.payment.percentBps", "Fee %", "pct", { suffix: "%" })}${field("website.payment.fixedCents", "Fixed fee", "money", { prefix: "A$" })}</div>`)}
${card("Care plan (ongoing)", `<div class="grid">${field("website.care.enabled", "Include a monthly care plan", "bool")}${field("website.care.monthly.cents", "Monthly fee", "money", { prefix: "A$" })}${select("website.care.monthly.gst", "Fee is", [["inclusive", "Incl. GST"], ["exclusive", "Ex GST"]])}${field("website.care.maintenanceMinutes", "Maintenance per month", "hours", { suffix: "h" })}${field("website.care.includedChangeMinutes", "Changes included", "hours", { suffix: "h" })}${field("website.care.expectedChangeMinutes", "Changes expected", "hours", { suffix: "h" })}${field("website.care.termMonths", "Months to compare", "int")}</div>`)}
</div><div class="out" id="out">${safe2(websiteOut)}</div></div>`;
}
function bar(parts, total) {
  if (total <= 0)
    return "";
  return `<div class="bar" role="img" aria-label="${esc3(parts.map((p) => `${p.label} ${aud(p.cents)}`).join(", "))}">${parts.filter((p) => p.cents > 0).map((p) => `<span class="${p.tone}" style="width:${Math.max(1, p.cents / total * 100).toFixed(2)}%" title="${esc3(p.label)} ${esc3(aud(p.cents))}"></span>`).join("")}</div>
<ul class="legend">${parts.map((p) => `<li><i class="${p.tone}"></i>${esc3(p.label)} <b>${aud(p.cents)}</b></li>`).join("")}</ul>`;
}
function websiteOut() {
  const w = calculateWebsite(deal().website);
  const o = w.oneOff;
  const r = w.recurring;
  const p = o.pricing;
  const breakdown = bar([
    { label: "Labour", cents: o.labourCents, tone: "c1" },
    { label: "Contingency", cents: o.contingencyCents, tone: "c2" },
    { label: "Third-party", cents: o.thirdPartyCents, tone: "c3" },
    { label: "Payment fees", cents: o.paymentCostCents, tone: "c4" },
    { label: o.grossProfitCents >= 0 ? "Gross profit" : "Loss", cents: Math.abs(o.grossProfitCents), tone: o.grossProfitCents >= 0 ? "gold" : "loss" }
  ], Math.max(o.revenueExGstCents, o.deliveryCostCents));
  return `${card("One-off project", `<div class="stats">${stat("Price ex GST", aud(o.priceExGstCents), "", o.discountCents ? `after ${aud(o.discountCents)} discount` : "")}${stat("GST", aud(o.gstCents))}${stat("Total incl. GST", aud(o.totalInclGstCents))}</div>
<div class="stats">${stat("Delivery cost", aud(o.deliveryCostCents), "", `${hoursText(o.minutes)} + ${hoursText(o.contingencyMinutes)} contingency`)}${stat("Gross profit", aud(o.grossProfitCents), cls(o.grossProfitCents), `${pctText(o.marginBps)} margin`)}${stat("Effective hourly", aud(o.effectiveHourlyCents), cls((o.effectiveHourlyCents ?? 0) - deal().website.labourHourlyCents), `${aud(o.effectiveHourlyWithContingencyCents)} if contingency is used`)}</div>${breakdown}
<p class="callout">${p.breakEvenMinutes === null ? "Enter an hourly rate to see break-even hours." : `This price carries <b>${hoursText(p.breakEvenMinutes)}</b> of planned founder time (plus the ${pctText(deal().website.contingencyBps, 0)} contingency) before the build loses money. Planned now: <b>${hoursText(o.minutes)}</b>.`} ${p.priceForTargetExGstCents === null ? "" : `For a ${pctText(p.targetMarginBps, 0)} margin on these hours the price would be <b>${aud(p.priceForTargetExGstCents)}</b> ex GST.`}</p>`)}
${card("Payment stages", `<div class="tablewrap"><table><thead><tr><th>Stage</th><th>Ex GST</th><th>GST</th><th>Incl. GST</th></tr></thead><tbody>${o.stages.map((s) => `<tr><th scope="row">${esc3(s.label)} <small>${s.shareBps / 100}% · ${esc3(s.trigger)}</small></th><td>${aud(s.exGstCents)}</td><td>${aud(s.gstCents)}</td><td>${aud(s.inclGstCents)}</td></tr>`).join("")}</tbody><tfoot><tr><th>Total</th><td>${aud(o.priceExGstCents)}</td><td>${aud(o.gstCents)}</td><td>${aud(o.totalInclGstCents)}</td></tr></tfoot></table></div>`)}
${r.enabled ? card("Care plan (monthly, separate from the build)", `<div class="stats">${stat("Revenue ex GST", aud(r.revenueExGstCents))}${stat("Cost", aud(r.costCents), "", `${hoursText(r.minutes)} + hosting ${aud(r.thirdPartyCents)}`)}${stat("Profit / month", aud(r.profitCents), cls(r.profitCents), pctText(r.marginBps))}</div>
<p class="muted small">Over ${w.horizon.months} months: ${aud(w.horizon.recurringProfitCents)} care-plan profit. ${w.horizon.monthsToRecoverBuildLoss === 0 ? "" : w.horizon.monthsToRecoverBuildLoss === null ? "The care plan never recovers the build loss." : `It takes ${w.horizon.monthsToRecoverBuildLoss} months of care plan to recover the build loss.`}${r.changeMinutesOverIncluded ? ` Expected changes exceed the included time by ${hoursText(r.changeMinutesOverIncluded)}.` : ""}</p>`) : ""}
${unknownList(w.unknownCosts)}${flagList(w.approval.unapproved)}`;
}
function rxTab() {
  const d = deal();
  const rx = d.rx;
  const pkg = getReceptionistPackage(rx.packageId);
  const status = priceStatusLines(pkg);
  const pkgCards = RECEPTIONIST_PACKAGES.map((p) => `<button class="pkg ${p.id === rx.packageId ? "on" : ""}" data-action="package" data-id="${p.id}" aria-pressed="${p.id === rx.packageId}"><b>${esc3(p.shortName)}</b><span>${aud(p.pricing.monthly.cents)}/mo ex GST</span><small>${p.pricing.includedMinutes.toLocaleString("en-AU")} min · ${aud(p.pricing.overagePerMinute.cents)}/extra min</small></button>`).join("");
  const cols = Object.keys(RX_COLUMN_LABELS);
  const grid = `<div class="tablewrap"><table class="inputs"><thead><tr><th></th>${cols.map((c) => `<th>${RX_COLUMN_LABELS[c]}</th>`).join("")}</tr></thead><tbody>
<tr><th scope="row">Billable time <small>min or min:sec</small></th>${cols.map((c) => `<td>${miniInput(`rx.columns.${c}.billableSeconds`, "dur")}</td>`).join("")}</tr>
<tr><th scope="row">SMS segments</th>${cols.map((c) => `<td>${miniInput(`rx.columns.${c}.smsSegments`, "int")}</td>`).join("")}</tr>
<tr><th scope="row">Support time <small>min / month</small></th>${cols.map((c) => `<td>${miniInput(`rx.columns.${c}.supportMinutes`, "int")}</td>`).join("")}</tr></tbody></table></div>`;
  const unknownRates = DEFAULT_COST_RATES.filter((r) => r.micros === null);
  const voiceIdx = RX_VOICE_PRESETS.findIndex((v) => v.micros === rx.voiceMicros);
  return `<div class="cols"><div class="form">
${card("Package", `<div class="pkgs">${pkgCards}</div><p class="small ok">${esc3(status.monthly.text)}</p><p class="small warn">${esc3(status.setup.text)} · ${esc3(status.pilot.text)}</p><button class="ghost small" data-action="reset-usage">Reset usage to catalogue scenarios</button>`)}
${card("Monthly usage per scenario", `${grid}<p class="muted small">Billing counts connected seconds over the month, drops calls under ${pkg.pricing.billing.minimumBillableSeconds} s, and rounds up to a whole minute once. Enter 1000:01 for 1,000 minutes and 1 second.</p>`)}
${card("Voice, telephony and platform", `<div class="grid"><div class="field wide"><label for="voice-preset">Voice platform rate</label><select id="voice-preset" data-action-change="voice-preset">${RX_VOICE_PRESETS.map((v, i) => `<option value="${i}" ${i === voiceIdx ? "selected" : ""}>${esc3(v.label)} · US$${(v.micros / 1e6).toFixed(4)}/min</option>`).join("")}${voiceIdx < 0 ? `<option selected>Custom</option>` : ""}</select></div>
${field("rx.voiceMicros", "Voice US$ per minute", "rate6", { prefix: "US$", hint: "Retell list estimate; not a measured rate" })}${field("rx.avgCallSeconds", "Average call length", "int", { suffix: "s" })}${field("rx.shortCallShareBps", "Hang-ups / short calls", "pct", { suffix: "%", hint: "Cost to M&U, never billed" })}${field("rx.webhookEventsPerCall", "Webhook events per call", "int")}${field("rx.clientsSharingPlatform", "Clients sharing hosting", "int", { hint: "1 = this client carries all of it" })}</div>`)}
${card("Costs not yet known", `<div class="grid">${unknownRates.map((r) => field(`rx.rateOverrides.${r.id}`, `${r.label} (${r.currency} per ${r.basis.replace("-", " ")})`, "rate6?", { prefix: r.currency === "USD" ? "US$" : "A$", placeholder: "Unknown", wide: true })).join("")}</div><p class="muted small">Blank stays unknown and is listed, never zero. Anything entered here is an assumption, not a provider charge.</p>`)}
${card("Currency, labour and payments", `<div class="grid">${field("rx.fx.usdPerAudMillionths", "US$ per A$1", "rate6", { hint: "RBA reference rate" })}${field("rx.fx.date", "Rate date", "date")}${field("rx.fx.cardFeeBps", "Card FX buffer", "pct", { suffix: "%" })}${field("rx.labourHourlyCents", "Founder hour valued at", "money", { prefix: "A$" })}${field("rx.onboardingMinutes", "Onboarding effort", "hours", { suffix: "h" })}${field("rx.payment.percentBps", "Payment fee", "pct", { suffix: "%", hint: "Stripe card 1.7% + Billing 0.7%" })}${field("rx.payment.fixedCents", "Fixed fee per charge", "money", { prefix: "A$" })}</div>`)}
${card("Commercial terms", `<div class="grid">${field("rx.termMonths", "Term (months)", "int")}${field("rx.monthlyDiscountBps", "Monthly discount", "pct", { suffix: "%", hint: "Not an approved term" })}${field("rx.setupFeeCents", "Setup fee (ex GST)", "money?", { prefix: "A$", placeholder: "Quoted separately", hint: "Setup fees are NOT approved. Leave blank." })}</div>`)}
</div><div class="out" id="out">${safe2(rxOut)}</div></div>`;
}
function miniInput(path, kind) {
  const [, , col, key] = path.split(".");
  const what = key === "billableSeconds" ? "billable time" : key === "smsSegments" ? "SMS segments" : "support minutes";
  return `<input aria-label="${esc3(`${RX_COLUMN_LABELS[col]}: ${what}`)}" data-bind="${path}" data-kind="${kind}" value="${esc3(display(kind, getPath(deal(), path)))}" inputmode="decimal" autocomplete="off"><small class="err" data-err-for="${path}"></small>`;
}
function rxOut() {
  const d = deal();
  const r = calculateRxDeal(d.rx);
  const b = r.breakEven;
  const pkg = getReceptionistPackage(d.rx.packageId);
  const row = (label, f, strong = false) => `<tr${strong ? ` class="strong"` : ""}><th scope="row">${label}</th>${r.columns.map((c) => `<td>${f(c)}</td>`).join("")}</tr>`;
  const cost = (c, ids) => aud(c.costLines.filter((l) => ids.includes(l.id)).reduce((n, l) => n + l.cents, 0));
  const table = `<div class="tablewrap"><table><thead><tr><th>Per month</th>${r.columns.map((c) => `<th>${esc3(c.label)}</th>`).join("")}</tr></thead><tbody>
${row("Billable time", (c) => minsText(c.billableSeconds))}
${row("Extra minutes billed", (c) => c.overageMinutes.toLocaleString("en-AU"))}
${row("Invoice ex GST", (c) => aud(c.invoice.exGstCents))}
${row("GST", (c) => aud(c.invoice.gstCents))}
${row("Invoice incl. GST", (c) => aud(c.invoice.inclGstCents), true)}
${row("Voice platform", (c) => cost(c, ["retell"]))}
${row("Telephony + number", (c) => cost(c, ["carrier", "number"]))}
${row("SMS", (c) => cost(c, ["sms"]))}
${row("Webhooks", (c) => cost(c, ["webhook"]))}
${row("Payment fees", (c) => aud(c.paymentCostCents))}
${row("Support time", (c) => `${aud(c.supportCents)} <small>${c.supportMinutes} min</small>`)}
${row("Hosting share", (c) => aud(c.sharedPlatformCents))}
${row("Operating profit", (c) => `<span class="${cls(c.operatingCents)}">${aud(c.operatingCents)}</span>`, true)}
${row("Margin", (c) => pctText(c.operatingMarginBps))}
${row("Per support hour", (c) => aud(c.effectiveHourlyCents))}
</tbody></table></div>`;
  const usd = (m) => m === null ? "above US$5.00" : `US$${(m / 1e6).toFixed(4)}`;
  const be = `<ul class="plain">
<li>${b.unprofitableFromMinutes === null ? `<b>Stays profitable</b> up to ${b.searchedUpToMinutes.toLocaleString("en-AU")} minutes a month (overage charged).` : `<b>Loses money from ${b.unprofitableFromMinutes.toLocaleString("en-AU")} minutes</b> a month${b.recoversAtMinutes ? `, recovering at ${b.recoversAtMinutes.toLocaleString("en-AU")} minutes as overage builds` : ""}.`}</li>
<li>If extra minutes were <i>not</i> charged, it would lose money from ${b.unprofitableFromMinutesWithoutOverage === null ? "beyond the searched range" : `<b>${b.unprofitableFromMinutesWithoutOverage.toLocaleString("en-AU")} minutes</b>`}.</li>
<li>At full allowance it stays profitable while voice costs at most <b>${usd(b.maxVoiceUsdMicrosAtFullAllowance)}</b>/min (entered: US$${(d.rx.voiceMicros / 1e6).toFixed(4)}).</li>
<li>Each extra minute earns ${aud(b.overage.priceExGstCents)} ex GST and costs about A$${(b.overage.costPerMinuteCents / 100).toFixed(3)}${b.overage.profitable ? "" : ": <b>below cost</b>"}.</li>
<li>Support could rise to <b>${b.maxSupportMinutesAtExpected === null ? "n/a" : hoursText(b.maxSupportMinutesAtExpected)}</b> a month at expected use before it loses money.</li>
<li>Largest monthly discount before a loss: ${Math.floor(b.maxDiscountBpsAtExpected / 100)}% at expected use, ${Math.floor(b.maxDiscountBpsAtFullAllowance / 100)}% at full allowance (rounded down).</li></ul>`;
  const s = r.setup;
  return `${card(`${esc3(pkg.name)}: low, expected, full and over`, table)}
${card("Where it stops being profitable", be)}
${card("Setup and term", `<div class="stats">${stat("Onboarding cost", aud(s.onboardingLabourCents), "", `${hoursText(d.rx.onboardingMinutes)} at ${aud(d.rx.labourHourlyCents)}/h`)}${stat("Setup fee", s.feeExGstCents === null ? "Quoted separately" : aud(s.feeExGstCents), s.feeExGstCents === null ? "" : "warnbox", s.feeStatus)}${stat(`${r.term.months}-month operating`, aud(r.term.operatingCents), cls(r.term.operatingCents), s.monthsToRecover === null ? "never recovers onboarding" : `onboarding recovered in ${s.monthsToRecover} month${s.monthsToRecover === 1 ? "" : "s"}`)}</div>`)}
${unknownList(r.unknownCosts)}${flagList(r.unapproved.map((u) => u.text))}
<p class="muted small">Estimates from public list rates re-read ${ECONOMICS_AS_OF}. Nothing here is a measured or invoiced cost. ${esc3(REVIEW_TRIGGER)}</p>`;
}
function quoteTab() {
  return `<div class="cols quote"><div class="form">
${card("Quote details", `<div class="grid">${field("quote.number", "Quote number", "text")}${field("quote.preparedOn", "Prepared on", "date")}${field("quote.validDays", "Valid for (days)", "int")}${field("quote.preparedBy", "Prepared by", "text", { wide: true })}${field("quote.projectTitle", "Title", "text", { wide: true })}${field("quote.summary", "Summary", "text", { wide: true })}${field("quote.usageIllustration", "Show an illustrative receptionist month (expected usage)", "bool", { wide: true })}</div>`)}
${card("Scope and terms", `${area("quote.scope", "Scope", "One item per line")}${area("quote.deliverables", "Deliverables")}${area("quote.exclusions", "Not included")}${area("quote.timeline", "Timeline")}${area("quote.responsibilities", "Ongoing costs and responsibilities")}${area("quote.notes", "Notes")}
<p class="small ${deal().quote.customText ? "warn" : "muted"}" id="text-mode">${deal().quote.customText ? "Edited by hand: this text is kept as written, and the agreement carries it in Appendix A." : "Generated from the scenario and kept up to date automatically. Editing any box keeps your wording."}</p>
<button class="ghost" data-action="refill">Rewrite text from the scenario</button>`)}
</div><div class="out" id="out">${safe2(quoteOut)}</div></div>`;
}
function quoteOut() {
  const doc = buildQuote(deal());
  return `${card("Draft quote", `<div class="actions"><button data-action="print">Print or save as PDF</button><button class="ghost" data-action="dl-html-internal">HTML (with review box)</button><button class="ghost" data-action="dl-html-client">HTML (client copy)</button><button class="ghost" data-action="dl-md">Markdown</button></div>
${flagList(doc.unapproved.map((u) => u.text))}${doc.openDecisions.length ? flagList(doc.openDecisions, "Open owner decisions") : ""}
<p class="muted small">Draft only: nothing is sent, and no invoice or payment link is created.</p>`)}
<iframe class="preview" title="Quote preview" id="quote-frame"></iframe>`;
}
function agreementTab() {
  return `<div class="single wide">${card("Proposal and agreement (two pages)", `<p class="muted small">Same layout as your signed website agreement: the agreement first, then the terms in brief and the setup checklist on a new page, and Appendix A when there is long scope or many special terms. Edit client details on the Deal tab and special terms in Quote → Notes (up to three lines).</p>
<div class="actions"><button data-action="print-agreement" data-export disabled>Print or save as PDF</button><button class="ghost" data-action="dl-agreement" data-export disabled>Download HTML</button></div><p id="fit" class="small muted">Preparing the preview…</p>${agreementPlan(deal()).appendix ? `<p class="small muted">Appendix A is added because of: ${esc3(agreementPlan(deal()).reasons.join("; "))}. Nothing is shortened to make it fit.</p>` : ""}`)}
<iframe class="preview agreement" title="Agreement preview" id="agreement-frame"></iframe></div>`;
}
function refreshAgreementFrame() {
  const frame = document.getElementById("agreement-frame");
  if (!frame)
    return;
  state.agreementChecked = false;
  frame.onload = () => {
    state.agreementChecked = true;
    let pages = 0;
    try {
      pages = Number(frame.contentWindow.eval(AGREEMENT_PAGES_EXPRESSION)) || 0;
    } catch {
      pages = 0;
    }
    state.agreementOver = [];
    const fit = document.getElementById("fit");
    const appendix = agreementPlan(deal()).appendix;
    if (fit) {
      fit.className = "small ok";
      fit.textContent = `About ${pages} A4 page${pages === 1 ? "" : "s"}${appendix ? ", including Appendix A" : ""}. Longer content flows onto extra pages; nothing is cut or shrunk.`;
    }
    document.querySelectorAll("[data-export]").forEach((b) => {
      b.disabled = false;
    });
  };
  try {
    frame.srcdoc = renderAgreementHtml(deal());
  } catch (e) {
    state.agreementOver = [1];
    frame.onload = null;
    frame.srcdoc = `<p style="font:16px system-ui;padding:24px">Can't prepare the agreement yet: ${esc3(e.message)}</p>`;
    const fit = document.getElementById("fit");
    if (fit) {
      fit.className = "small neg";
      fit.textContent = `Export is blocked: ${e.message}`;
    }
  }
}
function checksTab() {
  const d = deal();
  const findings = auditDeal(d, today());
  const failed = findings.filter((f) => !f.pass);
  const summary = `${findings.length} checks · ${failed.filter((f) => f.severity === "critical").length} critical · ${failed.filter((f) => f.severity === "warning").length} warnings · ${failed.filter((f) => f.severity === "info").length} notes`;
  const rates = costEvidenceTable();
  return `<div class="single">
${card("Model checks", `<p><b>${summary}</b></p><div class="tablewrap"><table><thead><tr><th>Result</th><th>Area</th><th>Check</th><th>Detail</th></tr></thead><tbody>${findings.map((f) => `<tr><td><span class="badge ${f.pass ? "pass" : f.severity}">${f.pass ? "Pass" : f.severity === "critical" ? "Critical" : f.severity === "warning" ? "Warning" : "Note"}</span></td><td>${esc3(f.area)}</td><td>${esc3(f.check)}</td><td class="small">${esc3(f.detail)}</td></tr>`).join("")}</tbody></table></div>`)}
${card("Cost sources (receptionist)", `<div class="tablewrap"><table><thead><tr><th>Cost</th><th>Estimate</th><th>Evidence</th><th>Checked</th><th>Measured</th><th>Invoice</th></tr></thead><tbody>${rates.map((r) => `<tr><th scope="row">${esc3(r.label)}${r.source ? `<small><a href="${esc3(r.source)}" target="_blank" rel="noopener">${esc3(r.source.replace(/^https:\/\/(www\.)?/, ""))}</a></small>` : ""}</th><td>${r.estimatedMicros === null ? "<b>Unknown</b>" : `${r.currency === "USD" ? "US$" : "A$"}${(r.estimatedMicros / 1e6).toFixed(4)} / ${esc3(r.basis)}`}</td><td>${esc3(r.estimateEvidence)}</td><td>${esc3(r.checkedAt)}</td><td class="small">Not measured</td><td class="small">Not reconciled</td></tr>`).join("")}
<tr><th scope="row">Stripe card + Billing<small><a href="${RATE_SOURCES.stripe}" target="_blank" rel="noopener">stripe.com/au/pricing</a></small></th><td>1.7% + 0.7% + A$0.30</td><td>public-list (card verified on Stripe's page)</td><td>2026-09-28</td><td class="small">Not measured</td><td class="small">Not reconciled</td></tr>
<tr><th scope="row">USD conversion<small><a href="${RATE_SOURCES.rba}" target="_blank" rel="noopener">RBA</a></small></th><td>US$${(d.rx.fx.usdPerAudMillionths / 1e6).toFixed(4)} per A$1 + ${d.rx.fx.cardFeeBps / 100}% buffer</td><td>reference rate</td><td>${esc3(d.rx.fx.date)}</td><td class="small">—</td><td class="small">—</td></tr>
</tbody></table></div><p class="muted small">Every provider figure is a public list price or an assumption. The one dashboard reading (about A$0.17/min over two calls, 26 Sep) is too small to count as measured.</p>`)}
${card("Approved figures used", `<ul class="plain"><li>Receptionist: Essential A$699 / 400 min / A$0.80; Professional A$1,099 / 1,000 min / A$0.75; Premium A$1,999 / 1,800 min / A$0.70, ex GST, approved 28 Sep 2026 (package catalogue 2026-09-27).</li><li>Billing: per second, summed per month, rounded up once; calls under 5 s, demo calls and transfer minutes not billed; 10% GST added per line.</li><li>Website: A$1,650 incl. GST, 50% deposit, 50% at approved launch, A$110/month care (owner-confirmed offer and first signed client).</li><li>Not approved: setup fees (A$990 / A$1,490 / A$2,490 were proposals), pilot terms, discounts, billing in advance vs arrears, mid-month proration.</li></ul>`)}
</div>`;
}
var app = document.getElementById("app");
function focusKey(el) {
  if (!(el instanceof HTMLElement) || !app.contains(el))
    return null;
  if (el.id)
    return `#${CSS.escape(el.id)}`;
  const d = el.dataset;
  if (d.action)
    return `[data-action="${d.action}"]${d.tab ? `[data-tab="${d.tab}"]` : ""}${d.id ? `[data-id="${CSS.escape(d.id)}"]` : ""}${d.i ? `[data-i="${d.i}"]` : ""}`;
  if (d.bind)
    return `[data-bind="${CSS.escape(d.bind)}"]`;
  return null;
}
function render() {
  const keep = focusKey(document.activeElement);
  renderNow();
  if (keep)
    app.querySelector(keep)?.focus();
}
function renderNow() {
  const d = deal();
  const body = state.tab === "deal" ? dealTab() : state.tab === "website" ? websiteTab() : state.tab === "receptionist" ? rxTab() : state.tab === "quote" ? quoteTab() : state.tab === "agreement" ? agreementTab() : checksTab();
  app.innerHTML = `<header class="top">${location.pathname.startsWith("/deal-desk") ? `<a class="back" href="/operations">← Operations</a>` : ""}<div class="brand">M<b>&amp;</b>U <span>Deal desk</span></div>
<div class="dealbar"><label class="sr" for="deal-select">Open a saved deal</label><select id="deal-select" data-action-change="open">${state.deals.map((x) => `<option value="${esc3(x.id)}" ${x.id === d.id ? "selected" : ""}>${esc3(x.name)}</option>`).join("")}</select>
<button class="ghost small" data-action="new">New</button><button class="ghost small" data-action="duplicate">Duplicate</button><button class="ghost small" data-action="delete">Delete</button>
<details class="menu"><summary class="ghost small">Export / import</summary><div><button data-action="export-json">Export all deals (JSON)</button><button data-action="export-csv">Scenario comparison (CSV)</button><label class="filebtn">Import deals (JSON)<input type="file" accept="application/json,.json" data-action-change="import"></label><button data-action="reset-seeds">Restore synthetic examples</button></div></details></div>
<div class="status" id="status">${d.synthetic ? `<span class="tag">Synthetic example</span>` : ""}<span class="${state.save === "ok" ? "" : "neg"}">${esc3(saveText())}</span></div></header>
${state.locked ? `<div class="conflict"><span>The deals saved in this browser could not be read. They are left exactly as they are and saving is off; the examples below are not saved.</span><button class="small" data-action="export-raw">Download the saved data</button></div>` : ""}
${state.quarantined.length ? `<div class="conflict"><span>${state.quarantined.length} saved deal${state.quarantined.length === 1 ? "" : "s"} could not be opened. ${state.quarantined.length === 1 ? "It is" : "They are"} kept untouched and still saved.</span><button class="ghost small" data-action="export-quarantine">Download ${state.quarantined.length === 1 ? "it" : "them"}</button></div>` : ""}
${state.mode === "shared" && state.conflict ? `<div class="conflict"><span>${state.conflict.current ? `${esc3(ownerName(state.conflict.current.updatedBy))} saved a newer version of this workbook (${esc3(clock(state.conflict.current.updatedAt))}). Your edit was not saved and theirs was not overwritten.` : "Someone else saved a newer version of this workbook."}</span><button class="small" data-action="shared-theirs">Load their version</button><button class="ghost small" data-action="shared-mine-copy">Keep mine as a separate copy</button></div>` : ""}
${state.mode === "shared" && state.withheld ? `<div class="conflict"><span>Confirm this browser in System › Devices and people to read quotes. Changes here aren't saved until then.</span></div>` : state.mode === "shared" && state.readOnly ? `<div class="conflict"><span>You can look at the shared deals, but this browser isn't confirmed yet, so nothing you change here is saved. Confirm it in System › Devices and people, then reload this page.</span></div>` : ""}
${state.mode === "shared" && !state.readOnly && state.localOffer.length ? `<div class="conflict offer"><span>${state.localOffer.length} deal${state.localOffer.length === 1 ? " is" : "s are"} saved only in this browser.</span><button class="small" data-action="offer-open">Review and copy to the shared workspace</button></div>` : ""}
${state.mode === "shared" && state.offerOpen ? offerPanel() : ""}
<div class="conflict" id="conflict" ${state.save === "conflict" && state.mode === "local" ? "" : "hidden"}><span>These deals were changed in another tab, so this tab has stopped saving.</span><button class="small" data-action="conflict-latest">Load the latest</button><button class="ghost small" data-action="conflict-copy">Keep this deal as a copy, then load the latest</button></div>
<nav class="tabs" role="tablist">${TABS.map((t) => `<button role="tab" aria-selected="${t.id === state.tab}" data-action="tab" data-tab="${t.id}">${t.label}</button>`).join("")}</nav>
<main>${body}</main>`;
  if (state.tab === "quote")
    refreshQuoteFrame();
  if (state.tab === "agreement")
    refreshAgreementFrame();
}
var cantCalc = (e) => card("Can't calculate yet", `<p class="warn">${esc3(e.message)}</p><p class="muted small">Your unfinished changes are kept as a draft and the last complete version is unchanged. Nothing can be exported until this calculates (for example, until the stages add up to 100%).</p>`);
var safe2 = (panel) => {
  try {
    return panel();
  } catch (e) {
    return cantCalc(e);
  }
};
function refreshOut() {
  const out = document.getElementById("out");
  if (!out)
    return;
  try {
    out.innerHTML = state.tab === "deal" ? dealOut() : state.tab === "website" ? websiteOut() : state.tab === "receptionist" ? rxOut() : state.tab === "quote" ? quoteOut() : "";
    if (state.tab === "quote")
      refreshQuoteFrame();
  } catch (e) {
    out.innerHTML = cantCalc(e);
  }
}
function refreshQuoteFrame() {
  const frame = document.getElementById("quote-frame");
  if (frame) {
    try {
      frame.srcdoc = renderQuoteHtml(buildQuote(deal()), true);
    } catch (e) {
      frame.srcdoc = `<p style="font:16px system-ui;padding:24px">Can't prepare the quote yet: ${esc3(e.message)}</p>`;
    }
  }
}
var saveTimer = 0;
var contentOf = (d) => JSON.stringify({ ...d, updatedAt: "" });
var savedContent = new Map;
function persistView() {
  if (state.mode === "shared")
    return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    state.save = store.write();
    if (state.save === "ok" && invalid.size)
      state.save = "invalid";
    showSaveState();
  }, 250);
}
function persist() {
  if (state.readOnly) {
    state.save = "readonly";
    showSaveState();
    return;
  }
  if (state.mode === "shared" && savedContent.get(deal().id) === contentOf(deal()))
    return;
  deal().updatedAt = today();
  clearTimeout(saveTimer);
  const why = validateDeal(deal());
  if (why)
    invalid.set(deal().id, why);
  else {
    invalid.delete(deal().id);
    lastValid.set(deal().id, structuredClone(deal()));
  }
  for (const id of [...invalid.keys()])
    if (!state.deals.some((d) => d.id === id))
      invalid.delete(id);
  state.invalidWhy = why ? `${deal().name}: ${why}` : "";
  dirty.add(deal().id);
  if (state.mode === "shared") {
    queueSharedSave(deal().id);
    return;
  }
  saveTimer = window.setTimeout(() => {
    state.save = store.write();
    if (state.save === "ok")
      dirty.clear();
    if (state.save === "ok" && invalid.size)
      state.save = "invalid";
    state.savedAt = fmtTime(new Date);
    showSaveState();
  }, 250);
}
var clock = (iso) => Number.isNaN(new Date(iso).getTime()) ? "" : fmtDateTime(iso);
var inFlight = new Set;
var again = new Set;
var sharedTimers = new Map;
var dirty = new Set;
var lastSent = new Map;
function remember(rec) {
  const w = rec.draft ?? rec.deal;
  if (w)
    savedContent.set(rec.id, contentOf(w));
  state.revs.set(rec.id, rec.rev);
  state.by.set(rec.id, { who: rec.updatedBy, at: rec.updatedAt });
  state.links.set(rec.id, { leadId: rec.leadId, crm: rec.crmDealRef });
}
function queueSharedSave(id) {
  clearTimeout(sharedTimers.get(id));
  sharedTimers.set(id, window.setTimeout(() => {
    sharedTimers.delete(id);
    saveShared(id);
  }, 600));
  state.save = "saving";
  showSaveState();
}
async function saveShared(id) {
  if (inFlight.has(id)) {
    again.add(id);
    return;
  }
  const d = state.deals.find((x) => x.id === id);
  if (!d)
    return;
  inFlight.add(id);
  try {
    const sent = contentOf(d);
    lastSent.set(id, sent);
    const rec = await shared.save(d, state.revs.get(id) ?? 0);
    remember(rec);
    savedContent.set(id, sent);
    if (!again.has(id))
      dirty.delete(id);
    state.save = rec.draft ? "invalid" : "ok";
    if (rec.draft)
      state.invalidWhy = `${d.name}: ${rec.problem ?? "unfinished"}`;
    state.savedAt = fmtTime(new Date);
  } catch (e) {
    if (e instanceof ConflictError) {
      state.save = "conflict";
      state.conflict = { id, current: e.current };
      render();
    } else {
      state.save = "failed";
      state.note = e.message;
    }
  } finally {
    inFlight.delete(id);
    showSaveState();
    if (again.delete(id) && state.save !== "conflict")
      saveShared(id);
  }
}
async function loadShared() {
  const all = await shared.list();
  state.withheld = all.some((x) => x.withheld);
  const list = state.withheld ? [] : all.filter((x) => !x.archived);
  const deals = [];
  const damaged = [];
  for (const item of list) {
    const r = await shared.get(item.id);
    if ("raw" in r) {
      damaged.push({ id: r.id, error: r.error, raw: r.raw });
      continue;
    }
    const working = r.draft ?? r.deal;
    if (!working)
      continue;
    remember(r);
    deals.push(working);
    if (r.draft)
      invalid.set(r.id, r.problem ?? "unfinished");
    if (r.deal)
      lastValid.set(r.id, r.deal);
  }
  if (!deals.length) {
    const blank = blankDeal(today());
    savedContent.set(blank.id, contentOf(blank));
    deals.push(blank);
  }
  state.deals = deals;
  state.quarantined = damaged;
  state.locked = false;
  state.save = state.readOnly ? "readonly" : "ok";
  const local = store.read();
  const done = transferred();
  state.localOffer = (local?.deals ?? []).filter((d) => !d.synthetic && !done.has(d.id));
}
async function refreshShared() {
  if (state.mode !== "shared" || state.conflict || state.withheld)
    return;
  let list;
  try {
    list = await shared.list();
  } catch {
    return;
  }
  let changed = false;
  for (const item of list) {
    if (item.status === "damaged")
      continue;
    const known = state.revs.get(item.id) ?? 0;
    if (item.archived) {
      if (state.deals.some((d) => d.id === item.id) && state.deals.length > 1) {
        state.deals = state.deals.filter((d) => d.id !== item.id);
        changed = true;
      }
      continue;
    }
    if ((item.rev ?? 0) > known) {
      const r = await shared.get(item.id);
      if ("raw" in r)
        continue;
      const incoming = contentOf(r.draft ?? r.deal);
      const decision = refreshDecision({ inFlight: inFlight.has(item.id), dirty: dirty.has(item.id), timerPending: sharedTimers.has(item.id), incoming, lastSent: lastSent.get(item.id) });
      if (decision === "skip")
        continue;
      if (decision === "conflict") {
        clearTimeout(sharedTimers.get(item.id));
        sharedTimers.delete(item.id);
        state.save = "conflict";
        state.conflict = { id: item.id, current: r };
        state.currentId = item.id;
        render();
        return;
      }
      if (decision === "ours") {
        remember(r);
        if (!sharedTimers.has(item.id))
          dirty.delete(item.id);
        continue;
      }
      const working = r.draft ?? r.deal;
      if (!working)
        continue;
      remember(r);
      const i = state.deals.findIndex((d) => d.id === r.id);
      if (i < 0)
        state.deals.push(working);
      else
        state.deals[i] = working;
      if (r.draft)
        invalid.set(r.id, r.problem ?? "unfinished");
      else
        invalid.delete(r.id);
      changed = true;
    }
  }
  if (!state.deals.some((d) => d.id === state.currentId))
    state.currentId = state.deals[0].id;
  if (changed)
    render();
}
var TRANSFERRED_KEY = `${STORAGE_KEY}-copied-to-shared`;
function transferred() {
  try {
    return new Set(JSON.parse(localStorage.getItem(TRANSFERRED_KEY) ?? "[]"));
  } catch {
    return new Set;
  }
}
function markTransferred(ids) {
  try {
    localStorage.setItem(TRANSFERRED_KEY, JSON.stringify([...new Set([...transferred(), ...ids])]));
  } catch {}
}
var where = () => state.mode === "shared" ? "for both founders" : "in this browser";
var saveText = () => state.save === "ok" ? state.savedAt ? `Saved ${where()} ${state.savedAt}` : state.mode === "shared" ? "Shared with both founders" : "Saves in this browser" : state.save === "saving" ? "Saving…" : state.save === "readonly" ? "Read only: this browser isn't confirmed yet, so changes here are not saved." : state.save === "failed" ? state.mode === "shared" ? `NOT SAVED: ${state.note || "the OS did not accept the save"}. Your edits are still on screen; try again or export (JSON).` : "NOT SAVED: browser storage is full or unavailable. Export your deals (JSON) now." : state.save === "invalid" ? `Unfinished changes kept as a draft ${where()}; the last complete version is unchanged and nothing can be exported until this is fixed. ${state.invalidWhy}` : state.save === "locked" ? "NOT SAVING: the saved deals could not be read, so they are left untouched." : state.mode === "shared" ? "NOT SAVED: someone else saved a newer version of this workbook." : "NOT SAVED: these deals were changed in another tab.";
function showSaveState() {
  const s = document.querySelector("#status span:last-child");
  if (s) {
    s.textContent = saveText();
    s.className = state.save === "ok" || state.save === "saving" ? "" : state.save === "invalid" ? "warn" : "neg";
  }
  const bar = document.getElementById("conflict");
  if (bar)
    bar.hidden = state.save !== "conflict";
}
window.addEventListener("storage", (e) => {
  if (state.mode === "local" && e.key === STORAGE_KEY && store.rev() !== state.rev) {
    state.save = "conflict";
    showSaveState();
  }
});
window.addEventListener("focus", () => void refreshShared());
window.addEventListener("beforeunload", (e) => {
  const pending = sharedTimers.size > 0 || inFlight.size > 0 || state.save === "failed" || state.save === "conflict" || state.save === "saving";
  if (pending && dirty.size) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden)
    refreshShared();
});
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function printHtml(html) {
  document.getElementById("print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.id = "print-frame";
  frame.title = "Print";
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  };
  frame.srcdoc = html;
  document.body.appendChild(frame);
}
var slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "deal";
app.addEventListener("input", (ev) => {
  const el = ev.target;
  const path = el.dataset.bind;
  if (!path || el.tagName === "SELECT" || el.type === "checkbox")
    return;
  const err = app.querySelector(`[data-err-for="${CSS.escape(path)}"]`);
  try {
    const value = parseValue(el.dataset.kind, el.value, el);
    const quoteKey = path.startsWith("quote.") ? path.slice(6) : "";
    if (GENERATED_QUOTE_KEYS.includes(quoteKey) && !deal().quote.customText) {
      Object.assign(deal().quote, defaultQuoteText(deal()), { customText: true });
      const mode = document.getElementById("text-mode");
      if (mode) {
        mode.className = "small warn";
        mode.textContent = "Edited by hand: this text is kept as written, and the agreement carries it in Appendix A.";
      }
    }
    const before = getPath(deal(), path);
    setPath(deal(), path, value);
    try {
      refreshOut();
    } catch (e) {
      setPath(deal(), path, before);
      throw e;
    }
    el.removeAttribute("aria-invalid");
    if (err)
      err.textContent = "";
    if (path === "name") {
      const o = document.querySelector(`#deal-select option[value="${CSS.escape(deal().id)}"]`);
      if (o)
        o.textContent = String(value);
    }
    persist();
  } catch (e) {
    el.setAttribute("aria-invalid", "true");
    if (err)
      err.textContent = e.message;
  }
});
app.addEventListener("change", (ev) => {
  const el = ev.target;
  const action = el.dataset.actionChange;
  if (action === "open") {
    state.currentId = el.value;
    persistView();
    render();
    return;
  }
  if (action === "payment-preset") {
    const p = PAYMENT_PRESETS[Number(el.value)];
    if (p) {
      deal().website.payment = { ...p };
      persist();
      render();
    }
    return;
  }
  if (action === "voice-preset") {
    const v = RX_VOICE_PRESETS[Number(el.value)];
    if (v) {
      deal().rx.voiceMicros = v.micros;
      persist();
      render();
    }
    return;
  }
  if (action === "import") {
    const file = el.files?.[0];
    if (!file)
      return;
    file.text().then((text) => {
      try {
        const incoming = parseDeals(text);
        const ids = new Set(state.deals.map((d) => d.id));
        const key = (d) => JSON.stringify({ ...d, id: "", updatedAt: "" });
        const have = new Set(state.deals.map(key));
        let added = 0;
        let skipped = 0;
        const problems = incoming.map((d, i) => [i + 1, validateDeal(d)]).filter(([, why]) => why);
        if (problems.length)
          throw new Error(`deal ${problems[0][0]} cannot be opened (${problems[0][1]}). Nothing was imported.`);
        for (const d of incoming) {
          if (have.has(key(d))) {
            skipped++;
            continue;
          }
          if (ids.has(d.id))
            d.id = newId();
          ids.add(d.id);
          have.add(key(d));
          state.deals.push(d);
          state.currentId = d.id;
          added++;
        }
        persist();
        render();
        alert(`Imported ${added} deal(s).${skipped ? ` Skipped ${skipped} identical to a deal already here.` : ""}`);
      } catch (e) {
        alert(`Import failed: ${e.message}`);
      }
    });
    return;
  }
  const path = el.dataset.bind;
  if (!path)
    return;
  if (el.tagName === "SELECT" || el.type === "checkbox") {
    setPath(deal(), path, parseValue(el.dataset.kind, el.value, el));
    const after = el.dataset.after;
    if (after === "cms") {
      const k = deal().website.cmsComplexity;
      deal().website.effortMinutes.cms = CMS_PRESETS[k].minutes;
    }
    if (after === "discount") {
      const t = deal().website.discount.type;
      deal().website.discount = t === "percent" ? { type: "percent", bps: 1000 } : t === "fixed" ? { type: "fixed", cents: 0 } : { type: "none" };
    }
    persist();
    if (after || path.startsWith("include.") || path.endsWith(".currency") || path.endsWith(".frequency") || path === "website.care.enabled")
      render();
    else
      refreshOut();
  }
});
var lastCreate = 0;
app.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el || el.tagName === "SELECT")
    return;
  const d = deal();
  const a = el.dataset.action;
  if (a === "new" || a === "duplicate" || a === "reset-seeds") {
    const now = Date.now();
    if (now - lastCreate < 800)
      return;
    lastCreate = now;
  }
  if (a === "conflict-latest") {
    location.reload();
    return;
  }
  if (a === "shared-theirs" && state.conflict) {
    const cur = state.conflict.current;
    const id = state.conflict.id;
    state.conflict = null;
    state.save = "ok";
    dirty.delete(id);
    clearTimeout(sharedTimers.get(id));
    sharedTimers.delete(id);
    lastSent.delete(id);
    if (cur) {
      remember(cur);
      const w = cur.draft ?? cur.deal;
      const i = state.deals.findIndex((x) => x.id === cur.id);
      if (w && i >= 0)
        state.deals[i] = w;
      if (cur.draft)
        invalid.set(cur.id, cur.problem ?? "unfinished");
      else
        invalid.delete(cur.id);
    } else
      loadShared().then(render);
    render();
    return;
  }
  if (a === "shared-mine-copy" && state.conflict) {
    const cur = state.conflict.current;
    state.conflict = null;
    const copies = state.deals.filter((x) => dirty.has(x.id) || x.id === cur?.id).map((x) => {
      const c = structuredClone(x);
      c.id = newId();
      c.name = `${x.name} (my copy)`;
      return c;
    });
    if (cur) {
      remember(cur);
      const w = cur.draft ?? cur.deal;
      const i = state.deals.findIndex((x) => x.id === cur.id);
      if (w && i >= 0)
        state.deals[i] = w;
    }
    dirty.clear();
    for (const c of copies) {
      state.deals.push(c);
      state.revs.set(c.id, 0);
      state.currentId = c.id;
      persist();
    }
    render();
    return;
  }
  if (a === "offer-open") {
    state.offerOpen = true;
    render();
    return;
  }
  if (a === "offer-close") {
    state.offerOpen = false;
    render();
    return;
  }
  if (a === "offer-copy") {
    const picks = [...document.querySelectorAll("[data-offer]")].filter((c) => c.checked && !c.disabled).map((c) => state.localOffer[Number(c.dataset.offer)]);
    (async () => {
      const done = [];
      const failed = [];
      for (const local of picks) {
        const copy = structuredClone(local);
        if (state.deals.some((x) => x.id === copy.id))
          copy.id = newId();
        try {
          const rec = await shared.save(copy, 0);
          remember(rec);
          state.deals.push(rec.draft ?? rec.deal ?? copy);
          if (rec.draft)
            invalid.set(rec.id, rec.problem ?? "unfinished");
          done.push(local.id);
        } catch (e) {
          failed.push(`${local.name}: ${e.message}`);
        }
      }
      markTransferred(done);
      state.localOffer = state.localOffer.filter((x) => !done.includes(x.id));
      state.offerOpen = state.localOffer.length > 0 && failed.length > 0;
      render();
      alert(`Copied ${done.length} deal(s) to the shared workspace.${failed.length ? ` Not copied: ${failed.join("; ")}` : ""} The originals are still in this browser.`);
    })();
    return;
  }
  if (a === "crm-link") {
    const v = document.getElementById("crm-ref").value.trim();
    if (v && !/^crm:deal:[A-Za-z0-9_-]{1,80}$/.test(v)) {
      alert("Use the CRM deal reference, for example crm:deal:abc123.");
      return;
    }
    shared.link(d.id, state.revs.get(d.id) ?? 0, v || null).then((rec) => {
      remember(rec);
      render();
    }).catch((e) => {
      if (e instanceof ConflictError) {
        state.save = "conflict";
        state.conflict = { id: d.id, current: e.current };
        render();
      } else
        alert(`Not linked: ${e.message}`);
    });
    return;
  }
  if (a === "lead-attach") {
    const n = Number(document.getElementById("lead-id").value.trim());
    if (!Number.isSafeInteger(n) || n < 1) {
      alert("Enter the lead's number.");
      return;
    }
    shared.attach(d.id, state.revs.get(d.id) ?? 0, n).then((r) => {
      remember(r.record);
      render();
      alert(`Added to lead ${n}: ${r.files.join(", ")}. Nothing was sent.`);
    }).catch((e) => alert(`Not added: ${e.message}`));
    return;
  }
  if (a === "conflict-copy") {
    const latest = store.read();
    if (!latest) {
      location.reload();
      return;
    }
    const mine = state.deals.filter((x) => dirty.has(x.id) || x.id === d.id).map((x) => {
      const c = structuredClone(x);
      c.id = newId();
      c.name = `${x.name} (my copy)`;
      return c;
    });
    state.deals = [...latest.deals, ...mine];
    state.currentId = mine[mine.length - 1]?.id ?? state.currentId;
    state.rev = latest.rev;
    dirty.clear();
    state.save = store.write();
    render();
    return;
  }
  if ((a === "print-agreement" || a === "dl-agreement") && !state.agreementChecked)
    return;
  if (a === "export-raw") {
    let raw = "";
    try {
      raw = localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {}
    download(`mu-deal-desk-saved-data-${today()}.txt`, raw, "text/plain");
    return;
  }
  if (a === "export-quarantine") {
    download(`mu-deal-desk-unopened-deals-${today()}.json`, JSON.stringify({ note: "Deals the desk could not open. Kept exactly as saved.", deals: state.quarantined }, null, 2), "application/json");
    return;
  }
  if ((a === "print-agreement" || a === "dl-agreement") && state.agreementOver.length) {
    alert("This agreement would run past its page, so it can't be exported yet. See the note above the preview.");
    return;
  }
  if (a === "tab") {
    state.tab = el.dataset.tab;
    persistView();
    render();
    return;
  }
  if (a === "open") {
    state.currentId = el.dataset.id;
    persistView();
    render();
    return;
  }
  if (a === "new") {
    const n = blankDeal(today());
    state.deals.push(n);
    state.currentId = n.id;
    state.tab = "deal";
    persist();
    render();
    return;
  }
  if (a === "duplicate") {
    const c = structuredClone(d);
    c.id = newId();
    c.name = `${d.name} (copy)`;
    c.synthetic = d.synthetic;
    state.deals.push(c);
    state.currentId = c.id;
    persist();
    render();
    return;
  }
  if (a === "delete" && state.mode === "shared") {
    if (state.deals.length < 2) {
      alert("Keep at least one deal.");
      return;
    }
    if (!confirm(`Archive "${d.name}" for both founders? It leaves the list and its file is kept on the server.`))
      return;
    const rev = state.revs.get(d.id) ?? 0;
    const drop = () => {
      state.deals = state.deals.filter((x) => x.id !== d.id);
      state.currentId = state.deals[0].id;
      render();
    };
    if (!rev) {
      drop();
      return;
    }
    shared.archive(d.id, rev).then(drop).catch((e) => {
      if (e instanceof ConflictError) {
        state.save = "conflict";
        state.conflict = { id: d.id, current: e.current };
        render();
      } else
        alert(`Not archived: ${e.message}`);
    });
    return;
  }
  if (a === "delete") {
    if (state.deals.length < 2) {
      alert("Keep at least one deal.");
      return;
    }
    if (!confirm(`Delete "${d.name}" from this browser?`))
      return;
    state.deals = state.deals.filter((x) => x.id !== d.id);
    state.currentId = state.deals[0].id;
    persist();
    render();
    return;
  }
  if (a === "reset-seeds" && state.mode === "shared") {
    alert("The shared workspace does not take the synthetic examples. Use the standalone preview to try them.");
    return;
  }
  if (a === "reset-seeds") {
    if (!confirm("Add fresh copies of the synthetic examples? Your own deals are kept."))
      return;
    for (const s of seedDeals()) {
      s.id = newId();
      state.deals.push(s);
    }
    persist();
    render();
    return;
  }
  if (a === "export-json") {
    const complete = state.deals.map((x) => invalid.has(x.id) ? lastValid.get(x.id) : x).filter((x) => Boolean(x));
    download(`mu-deal-desk-${today()}.json`, serializeDeals(complete), "application/json");
    if (invalid.size)
      alert(`${invalid.size} unfinished deal(s) were exported as their last complete version${state.deals.length - complete.length ? `, and ${state.deals.length - complete.length} with no complete version yet were left out` : ""}. Their unfinished changes stay saved here.`);
    return;
  }
  if (a === "export-csv") {
    download(`${slug(d.name)}-comparison.csv`, comparisonCsv(d), "text/csv");
    return;
  }
  if (a === "add-cost") {
    d.website.costs.push({ id: newId(), label: "New cost", currency: "AUD", cents: null, frequency: "one-off", sharedAcross: 1, evidence: "entered", source: null, checkedAt: null, note: "" });
    persist();
    render();
    return;
  }
  if (a === "remove-cost") {
    d.website.costs.splice(Number(el.dataset.i), 1);
    persist();
    render();
    return;
  }
  if (a === "add-stage") {
    d.website.stages.push({ label: "Milestone", shareBps: 0, trigger: "On approval of …" });
    persist();
    render();
    return;
  }
  if (a === "remove-stage") {
    d.website.stages.splice(Number(el.dataset.i), 1);
    persist();
    render();
    return;
  }
  if (a === "package") {
    const id = el.dataset.id;
    const p = getReceptionistPackage(id);
    if (id === d.rx.packageId)
      return;
    const edited = JSON.stringify(d.rx.columns) !== JSON.stringify(defaultRxColumns(getReceptionistPackage(d.rx.packageId)));
    if (edited && !confirm(`Switch to ${p.shortName}? The usage you entered, the onboarding hours and the term are reset to that package's defaults. Discount and setup fee are kept.`))
      return;
    d.rx.packageId = id;
    d.rx.columns = defaultRxColumns(p);
    d.rx.onboardingMinutes = p.model.onboardingMinutes;
    d.rx.termMonths = p.pricing.minimumTermMonths;
    persist();
    render();
    return;
  }
  if (a === "reset-usage") {
    d.rx.columns = defaultRxColumns(getReceptionistPackage(d.rx.packageId));
    persist();
    render();
    return;
  }
  if (a === "refill") {
    if (!confirm("Replace the scope, deliverables, exclusions, timeline and responsibilities with text generated from the scenario?"))
      return;
    Object.assign(d, fillQuoteText(d, true));
    persist();
    render();
    return;
  }
  if (a === "print") {
    printHtml(renderQuoteHtml(buildQuote(d), false));
    return;
  }
  if (a === "dl-html-internal") {
    download(`${slug(d.quote.number)}-review.html`, renderQuoteHtml(buildQuote(d), true), "text/html");
    return;
  }
  if (a === "dl-html-client") {
    download(`${slug(d.quote.number)}-draft.html`, renderQuoteHtml(buildQuote(d), false), "text/html");
    return;
  }
  if (a === "print-agreement") {
    printHtml(renderAgreementHtml(d));
    return;
  }
  if (a === "dl-agreement") {
    download(`${slug(d.quote.number)}-agreement.html`, renderAgreementHtml(d), "text/html");
    return;
  }
  if (a === "dl-md") {
    download(`${slug(d.quote.number)}.md`, renderQuoteMarkdown(buildQuote(d)), "text/markdown");
    return;
  }
});
async function boot() {
  if (location.pathname.startsWith("/deal-desk") && await shared.available()) {
    state.mode = "shared";
    const s = await sessionCanWrite();
    state.readOnly = !s.canWrite;
    if (state.readOnly)
      state.save = "readonly";
    try {
      await loadShared();
    } catch (e) {
      state.mode = "local";
      state.note = e.message;
    }
    const p = new URLSearchParams(location.search);
    state.currentId = p.get("deal") && state.deals.some((d) => d.id === p.get("deal")) ? p.get("deal") : state.deals[0].id;
  }
  render();
}
boot();
window.__dealDesk = { state, buildQuote, calculateRxDeal, calculateWebsite };
