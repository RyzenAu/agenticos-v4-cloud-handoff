// Per-field approval status for a receptionist package, read only from the catalogue
// (src/lib/receptionist-packages.ts). Monthly price, included minutes and the extra-minute rate share
// `pricing.status`; the setup fee has its own `setupStatus`; pilot terms are not catalogued, so they
// are never approved. Every UI and draft that states an approval uses these lines.
import { RECEPTIONIST_PACKAGES, type ReceptionistPackage } from "./receptionist-packages";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

export type PriceStatusLines = {
  /** Monthly price, included minutes and extra-minute rate. */
  monthly: { approved: boolean; text: string };
  setup: { approved: boolean; text: string };
  pilot: { approved: false; text: string };
  gst: string;
};

export function priceStatusLines(pkg: Pick<ReceptionistPackage, "pricing">): PriceStatusLines {
  const p = pkg.pricing as ReceptionistPackage["pricing"] & { setupStatus?: "proposed" | "approved" };
  const exGst = p.monthly.gst === "exclusive";
  const gst = exGst ? "ex GST, +10% GST on invoices (M&U is GST registered)" : p.monthly.gst === "inclusive" ? "incl. GST" : "no GST";
  const monthlyApproved = p.status === "approved";
  const setupApproved = (p.setupStatus ?? p.status) === "approved";
  const when = day(p.approvedAt);
  return {
    monthly: {
      approved: monthlyApproved,
      text: monthlyApproved
        ? `Monthly price, included minutes, extra-minute rate: Approved${when ? ` ${when}` : ""} (${exGst ? "ex GST, +10% GST" : gst})`
        : "Monthly price, included minutes, extra-minute rate: Proposed, not approved",
    },
    setup: { approved: setupApproved, text: setupApproved ? "Setup fee: Approved" : "Setup fee: Proposed, not approved" },
    pilot: { approved: false, text: "Pilot terms: Not approved" },
    gst,
  };
}

/**
 * Short labels for totals across the whole catalogue (dashboard MRR / setup tiles and sources),
 * derived from each tier's status so no component types "approved" or "proposed" itself.
 */
export function catalogueLabels(packages: readonly Pick<ReceptionistPackage, "pricing">[] = RECEPTIONIST_PACKAGES) {
  const monthly = packages.every((p) => p.pricing.status === "approved") ? "approved" : packages.some((p) => p.pricing.status === "approved") ? "partly approved" : "proposed";
  const setupOf = (p: Pick<ReceptionistPackage, "pricing">) => (p.pricing as ReceptionistPackage["pricing"] & { setupStatus?: string }).setupStatus ?? p.pricing.status;
  const setup = packages.every((p) => setupOf(p) === "approved") ? "approved" : "proposed";
  return {
    monthly: `Catalogue price (${monthly}), ex GST`,
    setup: setup === "approved" ? "Catalogue setup fee (approved), ex GST" : "Proposed setup fee, not approved; ex GST; not a billed record",
    source: `monthly price ${monthly}, ex GST; setup fee ${setup === "approved" ? "approved" : "proposed, not approved"}`,
  };
}
