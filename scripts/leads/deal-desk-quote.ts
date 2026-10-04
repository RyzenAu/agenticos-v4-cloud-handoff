// A quote workbook for a CRM deal, built from the approved receptionist package prices (the catalogue in src/lib/receptionist-packages.ts) through the
// existing deal desk: same calculator, same quote text, same flags for anything not approved. The CRM stays the owner of the deal; the workbook only
// stores a crm:deal reference back to it. Draft-only: nothing here sends, invoices or contacts anyone, and nothing is invented (an unapproved setup
// fee stays "to be confirmed", a discount is never applied).
import { getReceptionistPackage, type PackageId } from "../../src/lib/receptionist-packages";
import { blankDeal, fillQuoteText } from "../../src/lib/deal-desk/deal";
import { defaultRxInput } from "../../src/lib/deal-desk/receptionist";
import { buildQuote, type Money } from "../../src/lib/deal-desk/quote";
import { DealDeskError, getDeal, linkDeal, saveDeal, type DealRecord } from "./deal-desk-store";

export type PackageQuoteInput = {
  dealId: string;
  dealTitle: string;
  company: { name: string; phone: string; address: string; emails: string[] };
  contact: { name: string; email: string; phone: string } | null;
  packageId: PackageId;
  by: "usman" | "mehroz";
  today: string;
};
export type PackageQuoteResult = {
  workbookId: string;
  created: boolean;
  rev: number;
  packageName: string;
  /** The approved monthly fee, exact. Null only if the calculator produced none. */
  monthly: Money | null;
  setupPending: boolean;
  /** Everything the quote itself says is not approved or not decided, so the caller can repeat it. */
  unapproved: string[];
  openDecisions: string[];
  missing: string[];
  /** True when the workbook now carries its crm:deal link. */
  linked: boolean;
};

const workbookIdFor = (dealId: string, packageId: PackageId) =>
  `crm-${dealId}-${packageId.replace(/^receptionist-/, "")}`.replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 80).replace(/-+$/, "");

function summarise(record: DealRecord, created: boolean, packageName: string): PackageQuoteResult {
  const deal = record.deal ?? record.draft;
  let quote: ReturnType<typeof buildQuote> | null = null;
  try {
    quote = deal ? buildQuote(deal) : null;
  } catch {
    quote = null; // a workbook the desk could not calculate is reported with no price, never a guessed one
  }
  const monthly = quote?.recurring.find((r) => /monthly/i.test(r.label))?.money ?? null;
  return {
    workbookId: record.id,
    created,
    rev: record.rev,
    packageName,
    monthly,
    setupPending: !!quote?.oneOff.some((r) => /setup/i.test(r.label) && r.money === null),
    unapproved: quote?.unapproved.map((u) => u.text) ?? [],
    openDecisions: quote?.openDecisions ?? [],
    missing: quote?.missing ?? [],
    linked: !!record.crmDealRef,
  };
}

/** Create (once) the quote workbook for this deal and package, or report the one already there. Never overwrites a founder's saved workbook. */
export function draftPackageQuote(root: string, input: PackageQuoteInput): PackageQuoteResult {
  const pkg = getReceptionistPackage(input.packageId);
  const id = workbookIdFor(input.dealId, input.packageId);
  try {
    const existing = getDeal(root, id);
    if (!("raw" in existing)) return summarise(existing, false, pkg.name);
    throw new DealDeskError(409, "That quote workbook's file is damaged and was left untouched. It needs repair before a new one can be drafted.");
  } catch (error) {
    if (!(error instanceof DealDeskError) || error.status !== 404) throw error;
  }
  const base = blankDeal(input.today, id);
  const draft = fillQuoteText({
    ...base,
    name: `${input.company.name}: ${pkg.shortName}`,
    client: {
      business: input.company.name,
      contact: input.contact?.name ?? "",
      email: input.contact?.email || input.company.emails[0] || "",
      phone: input.contact?.phone || input.company.phone || "",
      address: input.company.address,
      abn: "",
      sector: "other",
    },
    include: { website: false, receptionist: true },
    rx: defaultRxInput(input.packageId),
  });
  const saved = saveDeal(root, { deal: draft, baseRev: 0, by: input.by }).record;
  const ref = `crm:deal:${input.dealId}`;
  // The desk accepts only a plain id in a reference; a deal id with a dot is left unlinked and the caller says so.
  const linkable = /^crm:deal:[A-Za-z0-9_-]{1,80}$/.test(ref);
  const record = linkable ? linkDeal(root, { id, baseRev: saved.rev, crmDealRef: ref, by: input.by }).record : saved;
  return summarise(record, true, pkg.name);
}
