import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Database } from "bun:sqlite";
import type { CallRow, CommercialBlock, OfferTier } from "./types";
import {
  CATALOGUE_VERSION,
  getReceptionistPackage,
  RECEPTIONIST_PACKAGES,
  type PackageId,
  type ReceptionistPackage,
} from "../../src/lib/receptionist-packages";

// Every price, allowance and tier name here comes from the ONE package catalogue
// (src/lib/receptionist-packages.ts). Nothing in scripts/receptionist/ may carry its own price or
// minute literal; commercial.test.ts fails the build if one reappears.

/** The tier the margin panel is measured against when no client package is chosen: tier 1. */
export const DEFAULT_OFFER_PACKAGE_ID: PackageId = RECEPTIONIST_PACKAGES.reduce((a, b) => (b.tier < a.tier ? b : a)).id;

/** No pilot is offered; pilot terms are not approved (owner decision 28 Sep 2026). */
export const PILOT_TERMS = "Pilot terms: not approved";

const GST_LABEL = { exclusive: "ex GST", inclusive: "incl. GST", none: "no GST" } as const;

function tierOf(pkg: ReceptionistPackage): OfferTier {
  return {
    id: pkg.id,
    name: pkg.name,
    shortName: pkg.shortName,
    tier: pkg.tier,
    status: pkg.pricing.status,
    setupStatus: pkg.pricing.setupStatus ?? pkg.pricing.status,
    setupCents: pkg.pricing.setup.cents,
    monthlyCents: pkg.pricing.monthly.cents,
    includedMinutes: pkg.pricing.includedMinutes,
    overagePerMinuteCents: pkg.pricing.overagePerMinute.cents,
    gst: GST_LABEL[pkg.pricing.monthly.gst],
  };
}

/** The offer block, derived entirely from the catalogue: every tier, labelled proposed/approved and GST basis. */
export function catalogueOffer(defaultId: PackageId = DEFAULT_OFFER_PACKAGE_ID): CommercialBlock["offer"] {
  return {
    source: `src/lib/receptionist-packages.ts (catalogue ${CATALOGUE_VERSION})`,
    catalogueVersion: CATALOGUE_VERSION,
    defaultPackageId: getReceptionistPackage(defaultId).id,
    tiers: [...RECEPTIONIST_PACKAGES].sort((a, b) => a.tier - b.tier).map(tierOf),
    pilotTerms: PILOT_TERMS,
  };
}
const buckets = [
  ["to-contact", "To contact", ["new", "to_call"]],
  ["contacted", "Contacted", ["no_answer", "voicemail", "call_back", "emailed"]],
  ["interested", "Interested", ["interested"]],
  ["meeting", "Meeting", ["meeting"]],
  ["proposal", "Proposal", ["proposal"]],
  ["won", "Won", ["won"]],
  ["closed", "Closed", ["lost", "not_interested", "do_not_contact"]],
] as const;
export function readLeads(file: string): CommercialBlock["leads"] {
  if (!existsSync(file)) return { ok: false, reason: "CRM not found" };
  let db: Database | undefined;
  try {
    // Load the native driver only at the I/O boundary; economics and aggregation remain pure.
    const { Database } = createRequire(import.meta.url)("bun:sqlite") as typeof import("bun:sqlite");
    db = new Database(file, { readonly: true });
    const rows = db
      .query(
        "SELECT status, COUNT(*) AS count FROM leads WHERE pitch IN ('receptionist','both') AND excluded = 0 AND merged_into IS NULL GROUP BY status",
      )
      .all() as { status: string; count: number }[];
    const byStage = buckets.map(([stage, label, statuses]) => ({
      stage,
      label,
      count: rows
        .filter((r) => (statuses as readonly string[]).includes(r.status))
        .reduce((s, r) => s + r.count, 0),
    }));
    return { ok: true, total: byStage.reduce((s, r) => s + r.count, 0), byStage };
  } catch {
    return { ok: false, reason: "CRM unreadable" };
  } finally {
    db?.close();
  }
}
/** Measured Retell cost per minute (AUD) from real connected calls, or null when not measurable. */
function measuredRate(rows: CallRow[], fx: number | null) {
  const connected = rows.filter(
    (r) => (r.durationSec ?? 0) > 0 && !["error", "not_connected"].includes(r.status),
  );
  const phone = connected.filter((r) => r.kind === "phone");
  const measured = (phone.length ? phone : connected).filter((r) => r.usdCents !== null);
  const minutes = measured.reduce((s, r) => s + r.durationSec! / 60, 0);
  const rate =
    minutes > 0 && fx !== null && fx > 0
      ? ((measured.reduce((s, r) => s + r.usdCents!, 0) / 100) * fx) / minutes
      : null;
  return { rate, minutes, calls: measured.length, allCalls: !phone.length && measured.length > 0 };
}

function marginAt(tier: OfferTier, rate: number | null) {
  const monthlyAud = tier.monthlyCents / 100;
  const cost = rate === null ? null : rate * tier.includedMinutes;
  const margin = cost === null ? null : monthlyAud - cost;
  return {
    packageId: tier.id,
    shortName: tier.shortName,
    status: tier.status,
    gst: tier.gst,
    monthlyAud,
    includedMinutes: tier.includedMinutes,
    costAtIncludedAud: cost,
    marginAtIncludedAud: margin,
    marginPct: margin === null ? null : (margin / monthlyAud) * 100,
    breakEvenMinutes: rate !== null && rate > 0 ? monthlyAud / rate : null,
  };
}

/**
 * Retell-only unit economics against the catalogue. The top-level cost/margin fields are for the
 * default tier (`offer.defaultPackageId`); `perTier` repeats them for every catalogued tier.
 */
export function economics(
  rows: CallRow[],
  fx: number | null,
  offer: CommercialBlock["offer"] = catalogueOffer(),
): CommercialBlock["economics"] {
  const m = measuredRate(rows, fx);
  const perTier = offer.tiers.map((t) => marginAt(t, m.rate));
  const base = perTier.find((t) => t.packageId === offer.defaultPackageId) ?? perTier[0];
  return {
    measuredMinutes: m.minutes,
    measuredCalls: m.calls,
    retellAudPerMinute: m.rate,
    packageId: base.packageId,
    costAtIncludedAud: base.costAtIncludedAud,
    marginAtIncludedAud: base.marginAtIncludedAud,
    marginPct: base.marginPct,
    breakEvenMinutes: base.breakEvenMinutes,
    perTier,
    caveat: `Retell only · from ${m.calls} call${m.calls === 1 ? "" : "s"} / ${Number(m.minutes.toFixed(1))} min · prices ${base.status} and ${base.gst} · Twilio per-minute and GST not included yet${m.allCalls ? " · all calls (no connected phone calls)" : ""}`,
  };
}
