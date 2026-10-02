// Deal economics, stage history, stuck-too-long rules and the morning overview for the M&U CRM.
//
// The pipeline stage itself stays derived from evidence (lead-pipeline.ts) — nothing here stores
// a stage. What is stored (additively, in `lead_deals` / `crm_settings`, created by openCrm) is
// only what a founder types: a custom value, a probability override, an expected close date and
// a "how they like to be contacted" note, plus rule overrides. Stage dates come from the same
// evidence the stage does (activities, milestones, audit/preview records), so the history can't
// drift from the stage. Nothing here sends, calls, charges or deploys anything; a board move only
// writes an activity, exactly like logging a call by hand.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPreview } from "../lead-sites/registry";
import { LOCAL_RECEIVABLES, receivablesSummary, type LocalReceivable } from "../finance/receivables";
import { callList, dayReport, findLead, getKickoff, goal, logActivity, recordWin, sydneyDate, type Activity, type Lead } from "./crm";
import { readTrustedIssues } from "./issues";
import { callWindow } from "./outreach";
import { leadPipeline, STAGES, type PipelineView, type Stage } from "./lead-pipeline";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES, type PackageId } from "../../src/lib/receptionist-packages";
import { DEFAULT_RECEPTIONIST_PACKAGE, draftDir, offerForPitch, WEBSITE_EX_GST_CENTS, type Offer } from "./sales-backoffice";
import { readSeoAudit } from "./seo-audit";
import { isCallDue } from "../../src/lib/call-queue";
import { SHARED_LEDGER, manualFinanceDbPath, sharedManualStore, type ManualFinanceStore } from "../finance/manual-store";
import { summary } from "../finance/manual-summary";

// ── the rules, in one place ──────────────────────────────────────────────────────────────────
// Defaults live here; a founder's edits (crm_settings rows "probability" and "stuck_days") are
// merged over them by readRules. Website prices come from sales-backoffice.ts's WEBSITE_OFFER;
// every receptionist price comes from the package catalogue (src/lib/receptionist-packages.ts),
// so a deal value, a proposal draft and an invoice draft can never quote different numbers.

export type OfferDefault = {
  label: string; setupCents: number; monthlyCents: number; packageId: PackageId | null; priceStatus: "proposed" | "approved" | null;
  /** Website build, ex GST (0 for receptionist-only). */
  websiteCents: number;
  /** The receptionist setup fee and its own approval; counted in setupCents only when approved. */
  receptionistSetup: { cents: number; status: "proposed" | "approved" } | null;
};
const hasReceptionist = (offer: Offer) => offer === "receptionist" || offer === "both";

/** Default price for an offer. Receptionist offers use the given catalogue package (the entry tier when none). */
export function offerDefaults(offer: Offer, packageId: string | null = null): OfferDefault {
  // Every deal value is ex GST (owner, 28 Sep): the GST-inclusive website price is converted, not mixed in.
  const website = offer !== "receptionist" ? WEBSITE_EX_GST_CENTS : 0;
  if (!hasReceptionist(offer)) return { label: offer === "redesign" ? "Website redesign" : "Website", setupCents: website, monthlyCents: 0, packageId: null, priceStatus: null, websiteCents: website, receptionistSetup: null };
  const pkg = getReceptionistPackage(packageId ?? DEFAULT_RECEPTIONIST_PACKAGE);
  const tag = `AI receptionist · ${pkg.shortName} (${pkg.pricing.status}, ex GST)`;
  // A proposed setup fee is not counted as deal value: only approved catalogue prices are (28 Sep 2026).
  const setupApproved = (pkg.pricing.setupStatus ?? pkg.pricing.status) === "approved";
  return {
    label: offer === "both" ? `Website + ${tag}` : tag,
    setupCents: website + (setupApproved ? pkg.pricing.setup.cents : 0), monthlyCents: pkg.pricing.monthly.cents,
    packageId: pkg.id, priceStatus: pkg.pricing.status,
    websiteCents: website, receptionistSetup: { cents: pkg.pricing.setup.cents, status: setupApproved ? "approved" : "proposed" },
  };
}
export const OFFER_DEFAULTS: Record<Offer, OfferDefault> = {
  website: offerDefaults("website"), redesign: offerDefaults("redesign"),
  receptionist: offerDefaults("receptionist"), both: offerDefaults("both"),
};
export const OFFERS = Object.keys(OFFER_DEFAULTS) as Offer[];

/**
 * The lead as a draft sees it, and the receptionist package the draft is priced from.
 *  - excluded and closed leads get no drafts (the drawer disables them; the server holds the rule);
 *  - the deal's chosen offer (e.g. "both") wins over the scored pitch;
 *  - a receptionist draft is priced ONLY from the package saved on the deal. A request that names
 *    a package must name that same one: a draft priced differently from the deal would let the
 *    proposal, the deposit invoice and the deal value disagree (audit F1-02, where the drawer sent
 *    the estimate's assumed Essential for a deal with no package). Choosing a package saves it on
 *    the deal first, so the drawer's requests always match;
 *  - no saved package: refused, even when the request names one (never silently Essential);
 *  - a saved id that isn't in the catalogue: refused.
 * Website-only drafts need no package.
 */
export function draftTarget(db: Database, lead: Lead, requested?: unknown): { lead: Lead; packageId: PackageId | undefined } {
  if (lead.excluded) throw new Error("Excluded leads don't get proposals or invoices.");
  if (CLOSED_STATUSES.includes(lead.status)) throw new Error(`This lead is closed (${lead.status.replace(/_/g, " ")}). Log a new outcome first if it's back in play.`);
  const deal = readDeal(db, lead.id);
  const target = deal.offer ? { ...lead, pitch: deal.offer } : lead;
  const asked = requested !== undefined && requested !== null && requested !== "";
  // A price document: an unknown package is refused even on a website-only draft, where it used
  // to be ignored with a 200 (Audit F5 P2-3).
  if (asked && (typeof requested !== "string" || !(PACKAGE_IDS as string[]).includes(requested))) throw new Error(`packageId must be one of ${PACKAGE_IDS.join(", ")}.`);
  if (!hasReceptionist(offerForPitch(target.pitch))) return { lead: target, packageId: undefined };
  if (deal.packageUnknown) throw new Error(`The package saved on this deal ("${deal.packageUnknown}") isn't in the catalogue. Choose Essential, Professional or Premium first.`);
  if (!deal.packageId) throw new Error("Choose the receptionist package (Essential, Professional or Premium) before drafting.");
  // T5 × S3: the saved package is authoritative; a request must name that same package (F1-02).
  if (asked && requested !== deal.packageId)
    throw new Error(`This deal is saved as ${getReceptionistPackage(deal.packageId).shortName}, not ${getReceptionistPackage(requested as PackageId).shortName}. Change the deal's package first so the deal, proposal and invoice agree.`);
  return { lead: target, packageId: deal.packageId };
}
/** Outcomes that end outreach: no drafts for these (the drawer's "closed" pipeline state). */
const CLOSED_STATUSES: string[] = ["lost", "not_interested", "do_not_contact"];
export const PACKAGE_IDS = RECEPTIONIST_PACKAGES.map((p) => p.id);

/** Monthly fees count this many months towards a deal's value ("first-year value"). */
export const MONTHS_COUNTED = 12;

export const DEFAULT_PROBABILITY: Record<Stage, number> = {
  found: 0.02, verified: 0.03, scored: 0.05, audited: 0.07, preview: 0.08,
  contacted: 0.1, replied: 0.25, meeting: 0.4, proposal: 0.6,
  won: 1, building: 1, QA: 1, launched: 1, "care plan": 1,
};

/** Days a lead may sit in a stage before it's flagged "stuck". Stages not listed never go stuck
 *  (the pre-contact backlog is worked by score, not by age). */
export const DEFAULT_STUCK_DAYS: Partial<Record<Stage, number>> = {
  contacted: 5, replied: 3, meeting: 7, proposal: 7, won: 5, building: 21, QA: 7,
};

/** What to do about a stuck lead, per stage. */
export const STUCK_ACTIONS: Partial<Record<Stage, string>> = {
  contacted: "Second touch: call again, or send the follow-up email if they asked for one",
  replied: "Book the discovery meeting while they're warm",
  meeting: "Send the proposal — draft it from the lead",
  proposal: "Chase the proposal: ask what's holding it up",
  won: "Start the build: chase content and access",
  building: "Review build progress and send it for client review",
  QA: "Close the revisions and schedule launch",
};

/** Sales stages the board can move a lead into (forward only), plus "lost". Delivery stages move
 *  with kickoff milestones, never by drag. */
export const MOVE_TARGETS = ["contacted", "replied", "meeting", "proposal", "won", "lost"] as const;
export type MoveTarget = (typeof MOVE_TARGETS)[number];

export type Rules = { probability: Record<Stage, number>; stuckDays: Partial<Record<Stage, number>>; monthsCounted: number };

function readSetting(db: Database, key: string): unknown {
  const row = db.query("SELECT value FROM crm_settings WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function readRules(db: Database): Rules {
  const probability = { ...DEFAULT_PROBABILITY };
  const stuckDays = { ...DEFAULT_STUCK_DAYS };
  const p = readSetting(db, "probability");
  if (p && typeof p === "object") for (const [s, v] of Object.entries(p)) if (isStage(s) && validProbability(v)) probability[s] = v as number;
  const d = readSetting(db, "stuck_days");
  if (d && typeof d === "object") for (const [s, v] of Object.entries(d)) {
    if (!isStage(s)) continue;
    if (v === null) delete stuckDays[s];
    else if (validDays(v)) stuckDays[s] = v as number;
  }
  return { probability, stuckDays, monthsCounted: MONTHS_COUNTED };
}

const isStage = (s: unknown): s is Stage => typeof s === "string" && (STAGES as readonly string[]).includes(s);
const validProbability = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const validDays = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 180;

/** Saves rule overrides. `probability` values are 0..1; `stuckDays` values are whole days 1..180,
 *  or null to switch the stuck check off for that stage. Anything invalid throws, nothing saved. */
export function saveRules(db: Database, patch: { probability?: Record<string, unknown>; stuckDays?: Record<string, unknown> }): Rules {
  const current = readRules(db);
  const probability: Record<string, number> = {};
  const stuck: Record<string, number | null> = {};
  for (const [s, v] of Object.entries(patch.probability ?? {})) {
    if (!isStage(s)) throw new Error(`Unknown stage "${s}".`);
    if (!validProbability(v)) throw new Error(`Probability for ${s} must be between 0 and 1.`);
    probability[s] = v as number;
  }
  for (const [s, v] of Object.entries(patch.stuckDays ?? {})) {
    if (!isStage(s)) throw new Error(`Unknown stage "${s}".`);
    if (v !== null && !validDays(v)) throw new Error(`Stuck threshold for ${s} must be a whole number of days from 1 to 180, or off.`);
    stuck[s] = v as number | null;
  }
  const upsert = db.query(`INSERT INTO crm_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  db.transaction(() => {
    if (Object.keys(probability).length) upsert.run("probability", JSON.stringify({ ...current.probability, ...probability }));
    if (Object.keys(stuck).length) {
      const merged: Record<string, number | null> = { ...current.stuckDays };
      for (const s of STAGES) if (!(s in merged)) merged[s] = null;
      upsert.run("stuck_days", JSON.stringify({ ...merged, ...stuck }));
    }
  })();
  return readRules(db);
}

// ── per-lead deal record ─────────────────────────────────────────────────────────────────────

export type DealRecord = {
  offer: Offer | null;
  /** Catalogue package for a receptionist offer; null = not chosen yet. Stored in lead_deals.package_id. */
  packageId: PackageId | null;
  /** A stored package_id that is not in the catalogue. Never priced as another package. */
  packageUnknown?: string | null;
  setupCents: number | null;
  monthlyCents: number | null;
  probability: number | null;
  expectedClose: string | null;
  contactPref: string;
  updatedBy: string;
  updatedAt: string | null;
};
const EMPTY_DEAL: DealRecord = { offer: null, packageId: null, setupCents: null, monthlyCents: null, probability: null, expectedClose: null, contactPref: "", updatedBy: "", updatedAt: null };

type Row = Record<string, any>;
function toDeal(r: Row | null | undefined): DealRecord {
  if (!r) return { ...EMPTY_DEAL };
  return {
    offer: OFFERS.includes(r.offer) ? r.offer : null,
    packageId: (PACKAGE_IDS as string[]).includes(r.package_id) ? r.package_id : null,
    packageUnknown: r.package_id && !(PACKAGE_IDS as string[]).includes(r.package_id) ? String(r.package_id).slice(0, 80) : null,
    setupCents: r.setup_cents ?? null, monthlyCents: r.monthly_cents ?? null,
    probability: r.probability ?? null, expectedClose: r.expected_close ?? null, contactPref: r.contact_pref ?? "",
    updatedBy: r.updated_by ?? "", updatedAt: r.updated_at ?? null,
  };
}

export function readDeal(db: Database, leadId: number): DealRecord {
  return toDeal(db.query("SELECT * FROM lead_deals WHERE lead_id = ?").get(leadId) as Row | null);
}

function readAllDeals(db: Database): Map<number, DealRecord> {
  return new Map((db.query("SELECT * FROM lead_deals").all() as Row[]).map((r) => [r.lead_id as number, toDeal(r)]));
}

export type DealPatch = {
  offer?: Offer | null;
  packageId?: string | null;
  setupCents?: number | null;
  monthlyCents?: number | null;
  probability?: number | null;
  expectedClose?: string | null;
  contactPref?: string;
};

/** "2026-10-15" names a real calendar day: it must round-trip, so "2026-02-30" is refused rather
 *  than rolled over to 2 March by Date.parse (audit F1-15). */
export function isCalendarDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

const cents = (v: unknown, what: string) => {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100_000_000) throw new Error(`${what} must be a whole number of cents from 0 to A$1,000,000.`);
  return v;
};

/** Adds lead_deals.package_id to a CRM file created before it existed. Additive and idempotent;
 *  runs only when a founder saves a package, so reads never change the file. */
function ensurePackageColumn(db: Database) {
  const cols = db.query("PRAGMA table_info(lead_deals)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "package_id")) db.query("ALTER TABLE lead_deals ADD COLUMN package_id TEXT").run();
}

/** Validates and saves a partial edit. A key that's absent is left alone; `null` clears an
 *  override back to the default. Only the fields given are written. */
export function saveDeal(db: Database, leadId: number, patch: DealPatch, by = ""): DealRecord {
  if (!findLead(db, leadId)) throw new Error("Lead not found.");
  const next = readDeal(db, leadId);
  if ("offer" in patch) {
    if (patch.offer !== null && !OFFERS.includes(patch.offer as Offer)) throw new Error(`Offer must be one of ${OFFERS.join(", ")}.`);
    next.offer = patch.offer ?? null;
  }
  if ("packageId" in patch) {
    const id = patch.packageId;
    if (id !== null && id !== undefined && !(PACKAGE_IDS as string[]).includes(id)) throw new Error(`Package must be one of ${PACKAGE_IDS.join(", ")}.`);
    next.packageId = (id ?? null) as PackageId | null;
  }
  if ("setupCents" in patch) next.setupCents = cents(patch.setupCents, "Setup value");
  if ("monthlyCents" in patch) next.monthlyCents = cents(patch.monthlyCents, "Monthly value");
  if ("probability" in patch) {
    if (patch.probability !== null && !validProbability(patch.probability)) throw new Error("Probability must be between 0 and 1.");
    next.probability = patch.probability ?? null;
  }
  if ("expectedClose" in patch) {
    const d = patch.expectedClose;
    if (d !== null && (typeof d !== "string" || !isCalendarDate(d))) throw new Error("Expected close must be a date like 2026-10-15.");
    next.expectedClose = d ?? null;
  }
  if ("contactPref" in patch) next.contactPref = String(patch.contactPref ?? "").trim().slice(0, 500);
  db.query(`INSERT INTO lead_deals (lead_id, offer, setup_cents, monthly_cents, probability, expected_close, contact_pref, updated_by)
    VALUES ($id, $offer, $setup, $monthly, $p, $close, $pref, $by)
    ON CONFLICT(lead_id) DO UPDATE SET offer = excluded.offer, setup_cents = excluded.setup_cents, monthly_cents = excluded.monthly_cents,
      probability = excluded.probability, expected_close = excluded.expected_close, contact_pref = excluded.contact_pref,
      updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run({
    $id: leadId, $offer: next.offer, $setup: next.setupCents, $monthly: next.monthlyCents, $p: next.probability,
    $close: next.expectedClose, $pref: next.contactPref, $by: by,
  });
  if ("packageId" in patch) {
    ensurePackageColumn(db);
    db.query("UPDATE lead_deals SET package_id = ? WHERE lead_id = ?").run(next.packageId, leadId);
  }
  return readDeal(db, leadId);
}

// ── economics ────────────────────────────────────────────────────────────────────────────────

export type DealEconomics = {
  offer: Offer;
  offerLabel: string;
  /** Catalogue package priced (receptionist offers only) and its price status; null for website-only. */
  packageId: PackageId | null;
  priceStatus: "proposed" | "approved" | null;
  setupCents: number;
  monthlyCents: number;
  /** setup + monthly × monthsCounted, ex GST (every figure in a deal is ex GST). */
  valueCents: number;
  /** valueCents with 10% GST added (M&U is GST registered). */
  valueInclGstCents: number;
  gstBasis: "ex GST";
  valueSource: "offer default" | "custom" | "unknown package";
  /** Website build ex GST, and the receptionist setup fee with its approval (never counted while proposed). */
  websiteCents: number;
  receptionistSetup: { cents: number; status: "proposed" | "approved" } | null;
  /**
   * Receptionist package state: "chosen" on the deal; "assumed" = none chosen, the entry tier is
   * used for the estimate only; "unknown" = a stored id not in the catalogue (not priced). null for website-only.
   */
  packageState: { state: "chosen" | "assumed" | "unknown"; note: string } | null;
  probability: number;
  probabilitySource: "stage default" | "custom" | "closed";
  weightedCents: number;
  expectedClose: string | null;
};

export function dealEconomics(lead: Pick<Lead, "pitch">, view: Pick<PipelineView, "stage" | "closed">, deal: DealRecord, rules: Rules): DealEconomics {
  const offer = deal.offer ?? offerForPitch(lead.pitch);
  const rx = hasReceptionist(offer);
  const unknown = rx && !deal.packageId && deal.packageUnknown ? deal.packageUnknown : null;
  const base: OfferDefault = unknown
    // An unknown stored package is never priced as another tier: the receptionist part is left out.
    ? (() => {
        const website = offer === "both" ? WEBSITE_EX_GST_CENTS : 0;
        return { label: `${offer === "both" ? "Website + " : ""}AI receptionist · unknown package "${unknown}"`, setupCents: website, monthlyCents: 0, packageId: null, priceStatus: null, websiteCents: website, receptionistSetup: null };
      })()
    : offerDefaults(offer, deal.packageId);
  const packageState: DealEconomics["packageState"] = !rx ? null
    : unknown ? { state: "unknown", note: `Unknown package "${unknown}" is saved on this deal; choose Essential, Professional or Premium. The receptionist is not priced until then.` }
    : deal.packageId ? { state: "chosen", note: `Package chosen: ${getReceptionistPackage(deal.packageId).shortName}` }
    : { state: "assumed", note: `Package not chosen (${getReceptionistPackage(DEFAULT_RECEPTIONIST_PACKAGE).shortName} assumed for the estimate)` };
  const setupCents = deal.setupCents ?? base.setupCents;
  const monthlyCents = deal.monthlyCents ?? base.monthlyCents;
  const valueCents = setupCents + monthlyCents * rules.monthsCounted;
  const custom = deal.setupCents !== null || deal.monthlyCents !== null;
  const valueSource: DealEconomics["valueSource"] = custom ? "custom" : unknown ? "unknown package" : "offer default";
  let probability = rules.probability[view.stage];
  let probabilitySource: DealEconomics["probabilitySource"] = "stage default";
  if (view.closed) { probability = 0; probabilitySource = "closed"; }
  else if (deal.probability !== null) { probability = deal.probability; probabilitySource = "custom"; }
  return {
    offer, offerLabel: base.label, packageId: base.packageId, priceStatus: base.priceStatus, setupCents, monthlyCents, valueCents,
    valueInclGstCents: valueCents + Math.round(valueCents / 10), gstBasis: "ex GST", valueSource,
    websiteCents: base.websiteCents, receptionistSetup: unknown ? null : base.receptionistSetup, packageState,
    probability, probabilitySource, weightedCents: Math.round(valueCents * probability), expectedClose: deal.expectedClose,
  };
}

// ── stage history ────────────────────────────────────────────────────────────────────────────

export type StageEntry = { stage: Stage; at: string | null; evidence: string; inferred: boolean };

const REPLIED = new Set(["interested", "meeting", "proposal", "won"]);

function fileTime(path: string): string | null {
  try { return statSync(path).mtime.toISOString(); } catch { return null; }
}

/** When the lead entered each stage it has reached, from the same evidence the stage comes from.
 *  `acts` must be this lead's activities, oldest first. Stages with no dated evidence show
 *  `at: null` (the current stage always appears). */
export function stageTimeline(root: string, db: Database, lead: Lead, view: PipelineView, acts: Activity[]): StageEntry[] {
  const first = (pred: (a: Activity) => boolean) => acts.find(pred)?.at ?? null;
  const kickoff = getKickoff(db, lead.id);
  const doneAt = (name: string) => kickoff?.milestones.find((m) => m.name === name && m.state === "done")?.completedAt ?? null;
  const latest = (...xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
  const issues = readTrustedIssues(db, lead);
  const audit = readSeoAudit(root, lead.id);
  const preview = getPreview(root, lead.id);
  const proposalFile = fileTime(join(draftDir(root, lead.id), "proposal.md"));
  const dated: Record<Stage, [string | null, string]> = {
    found: [lead.createdAt, "Added to the CRM"],
    verified: [lead.websiteCheckedAt, "Website last checked"],
    scored: [issues?.checkedAt ?? null, "Issues last scored"],
    audited: [audit?.ok ? audit.finishedAt : null, "Site audit finished"],
    preview: [preview?.generatedAt ?? null, "Preview drafted"],
    contacted: [first((a) => a.kind === "call" || a.kind === "email" || a.kind === "meeting") ?? lead.lastContactAt, "First call or email logged"],
    replied: [first((a) => REPLIED.has(a.outcome)), "Interested/reply outcome logged"],
    meeting: [first((a) => a.outcome === "meeting" || a.outcome === "proposal" || a.outcome === "won" || a.kind === "meeting"), "Meeting logged"],
    proposal: [first((a) => a.outcome === "proposal") ?? proposalFile, "Proposal logged or drafted"],
    won: [first((a) => a.outcome === "won"), "Win recorded"],
    building: [doneAt("Build started"), "Build-start milestone done"],
    QA: [latest(doneAt("Review sent"), doneAt("Revisions closed")), "Review and revisions done"],
    launched: [latest(doneAt("Deployed"), doneAt("Handover sent")), "Deployed and handed over"],
    "care plan": [first((a) => /care plan (active|started)/i.test(a.note)), "Care plan started"],
  };
  const upTo = STAGES.indexOf(view.stage);
  const out: StageEntry[] = [];
  for (const stage of STAGES.slice(0, upTo + 1)) {
    const [at, evidence] = dated[stage];
    if (!at && stage !== view.stage && stage !== "found") continue;
    out.push({ stage, at, evidence: stage === view.stage && !at ? view.evidence : evidence, inferred: !at });
  }
  return out;
}

/** Whole days since the lead entered its current stage. Falls back to the latest earlier dated
 *  stage when the current one has no date (marked inferred). */
export function daysInStage(timeline: StageEntry[], now = new Date()): { days: number | null; since: string | null; inferred: boolean } {
  const current = timeline.at(-1);
  if (!current) return { days: null, since: null, inferred: true };
  const since = current.at ?? [...timeline].reverse().find((e) => e.at)?.at ?? null;
  if (!since) return { days: null, since: null, inferred: true };
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 86_400_000));
  return { days, since, inferred: !current.at };
}

export type Stuck = { thresholdDays: number; days: number; action: string };

/** Stuck = over the stage's threshold with no future follow-up booked. A booked follow-up means
 *  someone already owns the next step; it goes stuck again once that date passes. */
export function stuckCheck(view: Pick<PipelineView, "stage" | "closed">, days: number | null, nextAt: string | null, rules: Rules, now = new Date()): Stuck | null {
  if (view.closed || days === null) return null;
  const threshold = rules.stuckDays[view.stage];
  if (!threshold || days <= threshold) return null;
  if (nextAt && Date.parse(nextAt) > now.getTime()) return null;
  return { thresholdDays: threshold, days, action: STUCK_ACTIONS[view.stage] ?? "Review this lead's next step" };
}

// ── one row per lead (table, board, overview) ────────────────────────────────────────────────

export type DealIssue = { code: string; finding: string; severity: number; url: string };
export type DealRowView = {
  stage: Stage;
  closed: boolean;
  evidence: string;
  nextAction: string;
  owner: "agent" | "founder approval";
  stageSince: string | null;
  daysInStage: number | null;
  daysInferred: boolean;
  stuck: Stuck | null;
  economics: DealEconomics;
  contactPref: string;
  websiteStatus?: string;
  issues: DealIssue[];
};

function activitiesByLead(db: Database): Map<number, Activity[]> {
  const map = new Map<number, Activity[]>();
  for (const r of db.query("SELECT * FROM activities ORDER BY at ASC, id ASC").all() as Row[]) {
    const a: Activity = { id: r.id, leadId: r.lead_id, at: r.at, kind: r.kind, outcome: r.outcome, note: r.note, by: r.by };
    const list = map.get(a.leadId);
    if (list) list.push(a); else map.set(a.leadId, [a]);
  }
  return map;
}

function leadActivitiesAsc(db: Database, leadId: number): Activity[] {
  return (db.query("SELECT * FROM activities WHERE lead_id = ? ORDER BY at ASC, id ASC").all(leadId) as Row[])
    .map((r) => ({ id: r.id, leadId: r.lead_id, at: r.at, kind: r.kind, outcome: r.outcome, note: r.note, by: r.by }));
}

type Ctx = { rules: Rules; deals?: Map<number, DealRecord>; acts?: Map<number, Activity[]>; now: Date };

export function dealRow(root: string, db: Database, lead: Lead, ctx: Ctx): DealRowView & { timeline: StageEntry[] } {
  const view = leadPipeline(root, db, lead);
  const acts = ctx.acts ? ctx.acts.get(lead.id) ?? [] : leadActivitiesAsc(db, lead.id);
  const deal = ctx.deals ? ctx.deals.get(lead.id) ?? { ...EMPTY_DEAL } : readDeal(db, lead.id);
  const timeline = stageTimeline(root, db, lead, view, acts);
  const age = daysInStage(timeline, ctx.now);
  const report = readTrustedIssues(db, lead);
  const issues = (report?.issues ?? []).slice(0, 3).map((i) => ({ code: i.code, finding: i.finding, severity: i.severity, url: i.evidence.url }));
  return {
    // A saved report only counts as a verified absence while the lead itself says none-verified: older reports were built from a bare check date.
    websiteStatus: report?.website === lead.website ? report.status : undefined,
    stage: view.stage, closed: view.closed, evidence: view.evidence, nextAction: view.nextAction, owner: view.owner,
    stageSince: age.since, daysInStage: age.days, daysInferred: age.inferred,
    stuck: stuckCheck(view, age.days, lead.nextAt, ctx.rules, ctx.now),
    economics: dealEconomics(lead, view, deal, ctx.rules), contactPref: deal.contactPref, issues, timeline,
  };
}

/** The drawer's deal block: economics, history, stuck flag and the rules it was judged by. */
export function leadDeal(root: string, db: Database, lead: Lead, now = new Date()) {
  const rules = readRules(db);
  const row = dealRow(root, db, lead, { rules, now });
  return { ...row, record: readDeal(db, lead.id), stageProbability: rules.probability[row.stage], stuckDays: rules.stuckDays[row.stage] ?? null, monthsCounted: rules.monthsCounted };
}

/** Deal rows for many leads at once (one activities/deals query, not one per lead). */
export function dealRows(root: string, db: Database, leads: Lead[], now = new Date()): Map<number, DealRowView> {
  const ctx: Ctx = { rules: readRules(db), deals: readAllDeals(db), acts: activitiesByLead(db), now };
  const out = new Map<number, DealRowView>();
  for (const lead of leads) {
    const { timeline: _t, ...row } = dealRow(root, db, lead, ctx);
    out.set(lead.id, row);
  }
  return out;
}

// ── board moves (write an activity, never a stage) ───────────────────────────────────────────

export type MoveInput = { to: string; by?: string; note?: string; kind?: "call" | "email"; scope?: string };

export function moveStage(root: string, db: Database, lead: Lead, input: MoveInput) {
  const to = input.to as MoveTarget;
  if (!(MOVE_TARGETS as readonly string[]).includes(to)) throw new Error(`Leads can be moved to ${MOVE_TARGETS.join(", ")} — delivery stages follow kickoff milestones.`);
  if (lead.excluded) throw new Error("Excluded leads don't move through the pipeline.");
  if (lead.status === "do_not_contact") throw new Error("This lead asked not to be contacted.");
  const view = leadPipeline(root, db, lead);
  if (view.closed) throw new Error("This lead is closed. Log a new outcome from the drawer if it's back in play.");
  if (to !== "lost" && STAGES.indexOf(to) <= STAGES.indexOf(view.stage))
    throw new Error(`Already at ${view.stage}. Stages only move forward from evidence — log an activity to record something new.`);
  if (to === "lost" && STAGES.indexOf(view.stage) >= STAGES.indexOf("won")) throw new Error("A won client can't be marked lost from the board.");
  const extra = input.note?.trim() ? ` — ${input.note.trim()}` : "";
  const by = input.by ?? "";
  const label = to.charAt(0).toUpperCase() + to.slice(1);
  if (to === "won") {
    const scope = (input.scope ?? "").trim();
    if (!scope) throw new Error("Say what was won (the scope) to record a win.");
    recordWin(db, lead, { scope, by });
  } else {
    const kind = to === "contacted" ? (input.kind === "email" ? "email" : "call") : "note";
    const outcome = to === "contacted" ? (kind === "email" ? "emailed" : "") : to === "replied" ? "interested" : to;
    // Keep the lead's follow-up date: logActivity sets next_at to what it's given.
    logActivity(db, lead, { kind, outcome: outcome as any, note: `Moved to ${label} on the board${to === "contacted" ? ` (${kind})` : ""}${extra}`.slice(0, 2000), by, nextAt: lead.nextAt });
  }
  const updated = findLead(db, lead.id)!;
  return { lead: updated, pipeline: leadPipeline(root, db, updated) };
}

// ── morning overview ─────────────────────────────────────────────────────────────────────────

/**
 * Month-to-date net operating cash from the ONE finance ledger: the NAB CSV import
 * (finance-manual.sqlite; scripts/finance/manual-summary.ts). It is cash flow, not margin: own-account
 * transfers and Stripe payouts are left out, and coverage says whether the month is fully imported
 * (review T5 R2 B1: the old tile read the retired finance.sqlite and called transfers "margin").
 */
export type NetCash = {
  month: string; inCents: number | null; outCents: number | null; netCents: number | null;
  coverage: "full" | "partial" | "none"; coverageNote: string | null; statement: string; asOf: string | null;
};

/** null when nothing has been imported (the tile then hides); never opens or creates a store otherwise. */
export function monthNetCash(root: string, now = new Date(), deps: { store?: ManualFinanceStore } = {}): NetCash | null {
  let store = deps.store;
  if (!store) {
    if (!existsSync(manualFinanceDbPath(root))) return null;
    try { store = sharedManualStore(root); } catch { return null; }
  }
  try {
    if (!store.count(SHARED_LEDGER)) return null;
    const s = summary(SHARED_LEDGER, "this-month", { store, today: sydneyDate(now) });
    const none = s.periodCoverage === "none";
    return {
      month: sydneyDate(now).slice(0, 7),
      inCents: none ? null : s.cashInCents, outCents: none ? null : s.cashOutCents, netCents: none ? null : s.netOperatingCents,
      coverage: s.periodCoverage, coverageNote: s.coverageNote, statement: s.sourceLabel, asOf: s.asOf,
    };
  } catch {
    return null;
  }
}

export type TodoItem = { kind: "call" | "follow-up" | "build task"; leadId: number; name: string; detail: string; dueAt: string | null; overdue: boolean; phone: string; contactPref: string };
export type UpcomingItem = { kind: "meeting" | "call back" | "follow-up" | "milestone"; leadId: number; name: string; at: string; detail: string };

const OPEN_PIPELINE: Stage[] = ["contacted", "replied", "meeting", "proposal"];

export function crmOverview(root: string, db: Database, opts: { now?: Date; ledgerStore?: ManualFinanceStore; receivables?: LocalReceivable[] } = {}) {
  const now = opts.now ?? new Date();
  const today = sydneyDate(now);
  const leads = (db.query("SELECT id FROM leads WHERE excluded = 0 ORDER BY id").all() as { id: number }[]).map(({ id }) => findLead(db, id)!).filter(Boolean);
  const rows = dealRows(root, db, leads, now);
  const byId = new Map(leads.map((l) => [l.id, l]));
  const weekAgo = now.getTime() - 7 * 86_400_000;

  // "New this week" is only a measurement when the CRM has history to compare with. If the oldest
  // record itself was added inside the window (a first bulk load), every lead is "new" and the number
  // says nothing about real inflow, so it is unknown until the CRM is older than the window.
  const firstAt = (db.query("SELECT MIN(created_at) AS at FROM leads").get() as { at: string | null } | null)?.at ?? null;
  const hasHistory = firstAt === null || Date.parse(firstAt) < weekAgo;
  const newLeads = hasHistory ? leads.filter((l) => Date.parse(l.createdAt) >= weekAgo).length : null;
  const newLeadsNote = hasHistory ? null : `CRM began ${sydneyDate(new Date(firstAt!))}: its first load isn't "new".`;
  const open = leads.filter((l) => { const r = rows.get(l.id)!; return !r.closed && OPEN_PIPELINE.includes(r.stage); });
  const openValue = open.reduce((s, l) => s + rows.get(l.id)!.economics.valueCents, 0);
  const openWeighted = open.reduce((s, l) => s + rows.get(l.id)!.economics.weightedCents, 0);
  const stuck = leads.filter((l) => rows.get(l.id)!.stuck)
    .map((l) => ({ leadId: l.id, name: l.name, stage: rows.get(l.id)!.stage, ...rows.get(l.id)!.stuck! }))
    .sort((a, b) => b.days - b.thresholdDays - (a.days - a.thresholdDays));
  const proposals = leads.filter((l) => { const r = rows.get(l.id)!; return !r.closed && r.stage === "proposal"; });
  const proposalValue = proposals.reduce((s, l) => s + rows.get(l.id)!.economics.valueCents, 0);

  // Follow-ups: the same query `today` and the follow-up desk use, so they never disagree.
  const due = dayReport(db, null, now).followUpsDue;
  const overdue = due.filter((l) => l.nextAt && sydneyDate(l.nextAt) < today);

  // Builds: won leads with a kickoff that still has milestones open.
  const builds: { lead: Lead; open: number; due: { name: string; due: string }[] }[] = [];
  const upcomingMilestones: UpcomingItem[] = [];
  for (const { lead_id } of db.query("SELECT lead_id FROM kickoffs").all() as { lead_id: number }[]) {
    const lead = findLead(db, lead_id);
    const k = getKickoff(db, lead_id);
    if (!lead || !k) continue;
    const openMs = k.milestones.filter((m) => m.state !== "done");
    if (!openMs.length) continue;
    builds.push({ lead, open: openMs.length, due: openMs.filter((m) => m.due && m.due <= today).map((m) => ({ name: m.name, due: m.due! })) });
    for (const m of openMs) if (m.due && m.due > today) upcomingMilestones.push({ kind: "milestone", leadId: lead.id, name: lead.name, at: m.due, detail: m.name });
  }
  const tasksDue = builds.reduce((s, b) => s + b.due.length, 0);

  const receivables = receivablesSummary(opts.receivables ?? LOCAL_RECEIVABLES);
  const netCash = monthNetCash(root, now, { store: opts.ledgerStore });

  // Today's call queue: the founders' combined daily call targets (goals table), or 10 when
  // neither has set one — the full "never called" backlog isn't a to-do for one day.
  const queueSize = Math.min(50, goal(db, "usman") + goal(db, "mehroz") || 10);
  const calls = callList(db, queueSize, now);
  const pref = (id: number) => rows.get(id)?.contactPref ?? "";
  const dueIds = new Set(due.map((l) => l.id));
  const todo: TodoItem[] = [
    ...due.map((l) => ({
      kind: "follow-up" as const, leadId: l.id, name: l.name, dueAt: l.nextAt,
      overdue: !!l.nextAt && sydneyDate(l.nextAt) < today, phone: l.phone, contactPref: pref(l.id),
      detail: `${l.status === "call_back" ? "Call back" : "Follow up"} · ${rows.get(l.id)?.nextAction ?? ""}`,
    })),
    ...builds.flatMap((b) => b.due.map((m) => ({
      kind: "build task" as const, leadId: b.lead.id, name: b.lead.name, dueAt: m.due, overdue: m.due < today, phone: "", contactPref: "", detail: m.name,
    }))),
    ...calls.filter((l) => !dueIds.has(l.id)).map((l) => ({
      kind: "call" as const, leadId: l.id, name: l.name, dueAt: null, overdue: false, phone: l.phone, contactPref: pref(l.id),
      detail: l.lastContactAt ? "Call again" : "First call",
    })),
  ];
  todo.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.kind === "call" ? 1 : 0) - (b.kind === "call" ? 1 : 0) || (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));

  const horizon = now.getTime() + 14 * 86_400_000;
  const upcoming: UpcomingItem[] = [
    ...leads.filter((l) => {
      if (!l.nextAt || rows.get(l.id)!.closed) return false;
      const t = Date.parse(l.nextAt);
      return sydneyDate(l.nextAt) > today && t <= horizon;
    }).map((l) => ({
      kind: (l.status === "meeting" ? "meeting" : l.status === "call_back" ? "call back" : "follow-up") as UpcomingItem["kind"],
      leadId: l.id, name: l.name, at: l.nextAt!, detail: rows.get(l.id)!.nextAction,
    })),
    ...upcomingMilestones.filter((m) => Date.parse(`${m.at}T00:00:00+10:00`) <= horizon),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  // Calls today = the queue plus follow-ups that are phone calls (call-backs, or a lead with a phone).
  const callsToday = todo.filter((t) => t.kind === "call" || (t.kind === "follow-up" && !!t.phone)).length;
  // The same rule as Today's "Calls to make", Work's queue and /leads/calls (src/lib/call-queue.ts).
  const callsDue = due.filter((l) => isCallDue(l, now.getTime())).length;
  // Outside calling hours the queue can't be worked now, so the sentence says so rather than
  // implying calls are due this minute.
  const window = callWindow(now);
  const parts = [
    // Review T5 R2: the call sheet is wider than Today's "Calls to make" (it adds first calls and
    // other follow-ups), so it says both numbers instead of reusing the same words for a different count.
    window.open ? `${callsToday} on today's call sheet (${callsDue} due)` : `${callsToday} on the call sheet for the next calling window (${callsDue} due)`,
    `${plural(overdue.length, "follow-up")} overdue`,
    `${plural(stuck.length, "deal")} stuck`,
  ];
  if (tasksDue) parts.push(`${plural(tasksDue, "build task")} due`);
  const sentence = `${window.open ? "" : "Calling hours are closed: "}${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;

  return {
    generatedAt: now.toISOString(),
    date: today,
    sentence,
    tiles: {
      newLeads: { count: newLeads, days: 7, note: newLeadsNote },
      pipeline: { count: open.length, valueCents: openValue, weightedCents: openWeighted, stages: OPEN_PIPELINE },
      stuck: { count: stuck.length },
      followUps: { overdue: overdue.length, dueToday: due.length - overdue.length },
      proposals: { count: proposals.length, valueCents: proposalValue },
      builds: { active: builds.length, tasksDue },
      // Money owed from the hand-kept client record (audit F1-24): labelled for what it is, e.g.
      // "1 payment due at launch (agreed, not yet invoiced)"; only `invoicedCount` are real invoices.
      invoices: { count: receivables.count, cents: receivables.cents, invoicedCount: receivables.invoicedCount, label: receivables.label, source: receivables.source },
      netCash,
    },
    callsToday,
    callWindow: window,
    todo,
    upcoming,
    stuck: stuck.slice(0, 10),
    names: Object.fromEntries([...new Set([...todo, ...upcoming].map((t) => t.leadId))].map((id) => [id, byId.get(id)?.name ?? ""])),
  };
}
export type CrmOverview = ReturnType<typeof crmOverview>;
