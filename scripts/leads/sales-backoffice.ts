// Local, founder-review-only sales documents. Never posts to Stripe or contacts a lead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatAud, getReceptionistPackage, projectPackageProposal, type PackageId } from "../../src/lib/receptionist-packages";
import { splitGst } from "../../src/lib/business-economics";
import type { Lead } from "./crm";
import { dataDirFor } from "../cloud/data-dir";

export type Offer = "website" | "redesign" | "receptionist" | "both";
export function offerForPitch(pitch: string): Offer {
  return pitch === "receptionist" || pitch === "both" || pitch === "redesign" ? pitch : "website";
}
export function draftDir(root: string, id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid lead id.");
  return join(dataDirFor(root), "drafts", String(id));
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (cents: number) => formatAud(cents);
const hasWeb = (o: Offer) => o !== "receptionist";
const hasReception = (o: Offer) => o === "receptionist" || o === "both";

/** The website offer: confirmed with the owner, separate from the receptionist catalogue, incl. GST. */
export const WEBSITE_OFFER = { priceCents: 165_000, depositCents: 82_500, carePlanMonthlyCents: 11_000, gst: "inclusive" as const };
/** Ex-GST value of a GST-inclusive amount (10% GST, M&U is GST registered): 165,000 -> 150,000. */
export const exGstOfInclusive = (cents: number) => cents - Math.round(cents / 11);
/** The website price on the same ex-GST basis as the receptionist catalogue (deal values, pipeline). */
export const WEBSITE_EX_GST_CENTS = exGstOfInclusive(WEBSITE_OFFER.priceCents);
/** The package a deal's pipeline *estimate* assumes when none is chosen (deals.ts, labelled "assumed").
 *  Never a draft default: proposals and invoices need an explicit package (review T5 R6). */
export const DEFAULT_RECEPTIONIST_PACKAGE: PackageId = "receptionist-essential";
/** Open owner decision (b), verbatim as in the sales pack (docs/sales/receptionist-pack-2026-09-28/build/common.py
 *  DECISION_B; check_catalogue.py fails if the two drift). Drafts never decide billing timing. */
export const OWNER_DECISION_B = "[OWNER DECISION (b) PENDING: is the monthly fee billed in advance from Acceptance, or in arrears after each billing period? Not decided.]";
export const BILLING_TERMS = "Billing terms are confirmed in your agreement.";
export const BILLING_PENDING = `${OWNER_DECISION_B} ${BILLING_TERMS}`;
/** A receptionist draft must name its package: no caller can price as Essential by omission. */
function requirePackage(packageId: string | undefined): string {
  if (!packageId) throw new Error("Choose the receptionist package (Essential, Professional or Premium) before drafting: receptionist drafts have no default package.");
  return packageId;
}
/** Owner's booking disclosure (V3 rules), used wherever a draft describes bookings. */
export const BOOKING_DISCLOSURE = "Booking integrations vary by business and scheduling system. We confirm compatibility during setup; where direct booking is unavailable, we offer an agreed booking-request or lead-capture workflow.";

/** Every receptionist figure in a draft comes from src/lib/receptionist-packages.ts. */
export function receptionistTerms(packageId: string) {
  const p = projectPackageProposal(getReceptionistPackage(requirePackage(packageId)).id);
  const status = p.pricing.status === "approved" ? "approved" : "proposed, not yet approved";
  // Setup fees have their own approval (catalogue setupStatus); a proposed one is never invoiced.
  const setupStatus = p.pricing.setupStatus ?? p.pricing.status;
  // A customer-facing draft never quotes an unapproved setup figure (matches the sales pack).
  const setupText = setupStatus === "approved" ? `${money(p.display.setup.exGstCents)} setup and ` : "";
  const setupLine = setupStatus === "approved" ? "" : " Setup: quoted separately once approved.";
  const exGst = (d: { exGstCents: number }) => money(d.exGstCents);
  const minutes = p.pricing.includedMinutes.toLocaleString("en-AU");
  return {
    packageId: p.catalogueId, title: p.title, shortName: p.shortName, status: p.pricing.status, setupStatus,
    setupExGstCents: p.display.setup.exGstCents, monthlyExGstCents: p.display.monthly.exGstCents,
    fees: `AI receptionist, ${p.title} (catalogue ${p.catalogueVersion}, ${status}): ${setupText}${exGst(p.display.monthly)}/month, ex GST, including ${minutes} call minutes per month; additional minutes ${exGst(p.display.overagePerMinute)}/min ex GST, counted per second, summed over the billing period and rounded up once to the next whole minute. ${p.pricing.includedSmsSegments.toLocaleString("en-AU")} SMS segments included per month; extra segments ${exGst(p.display.extraSmsSegment)} each ex GST. Included minutes and SMS do not roll over. Proposed minimum term ${p.pricing.minimumTermMonths} months, then ${p.pricing.noticeDays} days' written notice. ${p.display.gstNote} Pilot terms: not approved; no pilot is offered.${setupLine}`,
    scope: `AI receptionist, ${p.title}: ${p.audience} Included: ${p.scope.filter(f => f.state !== "not-offered").map(f => f.state === "at-go-live" ? `${f.label} (at go-live, after owner activation and acceptance tests)` : f.label).join("; ")}. Not included: ${p.scope.filter(f => f.state === "not-offered").map(f => f.label.toLowerCase()).join("; ") || "nothing listed"}. ${BOOKING_DISCLOSURE} Limits: ${p.limitations.join(" ")} Call routing, disclosure wording and retention: [agree in writing].`,
    ongoing: `Receptionist ongoing ${exGst(p.display.monthly)}/month ex GST (${status}), including ${minutes} call minutes; additional minutes ${exGst(p.display.overagePerMinute)}/min ex GST.`,
  };
}
const price = (o: Offer, packageId?: string) => [hasWeb(o) ? `Website: ${money(WEBSITE_EX_GST_CENTS)} ex GST + ${money(WEBSITE_OFFER.priceCents - WEBSITE_EX_GST_CENTS)} GST = ${money(WEBSITE_OFFER.priceCents)} incl. GST; ${money(WEBSITE_OFFER.depositCents)} incl. GST deposit to start and ${money(WEBSITE_OFFER.priceCents - WEBSITE_OFFER.depositCents)} incl. GST at approved launch; ${money(exGstOfInclusive(WEBSITE_OFFER.carePlanMonthlyCents))}/month ex GST (${money(WEBSITE_OFFER.carePlanMonthlyCents)} incl. GST) care plan after launch.` : "", hasReception(o) ? receptionistTerms(requirePackage(packageId)).fees : ""].filter(Boolean).join(" ");
function html(title: string, markdown: string): string {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DRAFT — ${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui;max-width:740px;margin:2rem auto;padding:0 1rem;color:#17212b}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.3rem}p{margin:.5rem 0}.draft{color:#9a251a;font-weight:700} @media print{body{font-size:11pt;margin:1cm}h2{break-after:avoid}}</style></head><body><strong class="draft">DRAFT — NOT FOR ISSUE OR SIGNATURE</strong>${markdown.split("\n").filter(Boolean).map(line => line.startsWith("# ") ? `<h1>${escapeHtml(line.slice(2))}</h1>` : line.startsWith("## ") ? `<h2>${escapeHtml(line.slice(3))}</h2>` : `<p>${escapeHtml(line)}</p>`).join("\n")}</body></html>`;
}
/** packageId is required for a receptionist or "both" offer (throws otherwise); ignored for a website-only one. */
export function proposalText(lead: Lead, packageId?: string): string {
  const o = offerForPitch(lead.pitch);
  const rx = hasReception(o) ? receptionistTerms(requirePackage(packageId)) : null;
  return `DRAFT — NOT FOR ISSUE OR SIGNATURE\n# Proposal and simple agreement — ${lead.name || `Lead #${lead.id}`}\nM&U Ventures · Usman and Mehroz · Western Sydney · Prepared for founder review. No work is authorised by this draft.\n## Scope\n${hasWeb(o) ? `${o === "redesign" ? "Redesign" : "Build"} a business website: discovery, agreed pages, responsive build, basic search setup, review and handover. Exact pages, integrations and revision allowance: [agree in writing].` : ""}\n${rx ? rx.scope : ""}\n## Timing and what we need\nStart and target dates: [agree after deposit, access and content]. Client to provide brand assets, approved copy/FAQs, site/domain access where needed, call-flow and escalation contacts, and a person authorised to approve the work. No client passwords in this draft.\n## Fees and payment\n${price(o, packageId)} ${rx ? `${BILLING_PENDING} ` : ""}Invoice dates and billing cycle: [founder to confirm]. No payment is requested by this draft.\n## Care and changes\n${hasWeb(o) ? `Website care plan ${money(WEBSITE_OFFER.carePlanMonthlyCents)}/month after launch for agreed routine updates, backups and maintenance; exact inclusions and hosting charges to be confirmed in writing. Additional work is quoted separately.` : ""} ${rx ? rx.ongoing : ""} Proposed cancellation: either party may end the ongoing monthly service on 30 days' written notice. Work completed and fees accrued before cancellation remain payable; any advance payment for undelivered work is refunded after reasonable committed costs are agreed. Confirm this proposed term with both parties before signature.\n## Ownership and hosting\nOn full payment, client owns approved bespoke copy, design and site deliverables to the extent M&U can assign them. M&U retains pre-existing tools, templates and licensed third-party components; third-party licences remain subject to their own terms. Domain, hosting account, data export, transfer costs and ongoing hosting payer: [agree in writing].\n## Approval\nThis is an unsigned working draft, not an offer to accept. Founders to confirm scope, dates, ABN, hosting and cancellation terms before presenting to client. Client representative: [name/title]. M&U representative: [name/title]. Signature and date: [only on approved final version].\n`;
}
export type DraftKind = "proposal" | "deposit-invoice";
export function draftProposal(root: string, lead: Lead, packageId?: string) {
  const markdown = proposalText(lead, packageId);
  const dir = draftDir(root, lead.id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), markdown);
  writeFileSync(join(dir, "proposal.html"), html("Proposal and agreement", markdown));
  return { leadId: lead.id, files: ["proposal.md", "proposal.html"], draft: true };
}
type InvoiceLine = { description: string; cents: number; gst: "inclusive" | "exclusive"; exGstCents: number; gstCents: number; totalCents: number };
/** M&U is GST registered: 10% GST, split with the economics model's splitGst (half-up, BigInt). */
const line = (description: string, cents: number, gst: InvoiceLine["gst"]): InvoiceLine => {
  const split = splitGst(cents, gst);
  return { description, cents, gst, exGstCents: split.netCents, gstCents: split.gstCents, totalCents: split.grossCents };
};
const sums = (lines: InvoiceLine[]) => {
  const total = lines.reduce((sum, l) => sum + l.totalCents, 0);
  const gst = lines.reduce((sum, l) => sum + l.gstCents, 0);
  return { total, gst, subtotal: total - gst };
};
/**
 * The deposit invoice draft. Only the website deposit is due on issue. The AI receptionist is never
 * invoiced by this draft: when its monthly fee is billed is open owner decision (b), so the draft
 * carries that placeholder and shows one month's approved catalogue fee as an illustration of the
 * amount only (no due date, no timing, outside TOTAL DUE, never a line item). A proposed setup fee
 * is never invoiced.
 */
export function invoiceData(lead: Lead, issued = new Date(), packageId?: string) {
  const o = offerForPitch(lead.pitch);
  const rx = hasReception(o) ? receptionistTerms(requirePackage(packageId)) : null;
  const lines = [
    hasWeb(o) ? line(`Website commencement deposit (50% of ${money(WEBSITE_OFFER.priceCents)} incl. GST)`, WEBSITE_OFFER.depositCents, WEBSITE_OFFER.gst) : null,
  ].filter((x): x is InvoiceLine => x !== null);
  const illustrationLines = [
    rx && rx.status === "approved" ? line(`AI receptionist, ${rx.title}: one month's fee (approved catalogue price, ex GST)`, rx.monthlyExGstCents, "exclusive") : null,
    rx && rx.setupStatus === "approved" ? line(`AI receptionist setup, ${rx.title} (approved catalogue price, ex GST)`, rx.setupExGstCents, "exclusive") : null,
  ].filter((x): x is InvoiceLine => x !== null);
  const notInvoiced = rx && rx.setupStatus !== "approved" ? [`AI receptionist setup, ${rx.title}: not invoiced; the setup fee is proposed, not yet approved.`] : [];
  const date = issued.toISOString().slice(0, 10);
  const due = new Date(issued); due.setUTCDate(due.getUTCDate() + 14);
  return {
    date, due: lines.length ? due.toISOString().slice(0, 10) : null, number: `DRAFT-${lead.id}-${date}`,
    lines, ...sums(lines),
    // Not part of the invoice: no due date and no issue timing until the owner decides (b).
    receptionistIllustration: rx ? { billing: BILLING_PENDING, issue: false as const, lines: illustrationLines, ...sums(illustrationLines) } : null,
    notInvoiced,
  };
}
const lineText = (l: InvoiceLine) => `${l.description}: ${money(l.exGstCents)} ex GST + ${money(l.gstCents)} GST = ${money(l.totalCents)}`;
export function draftInvoice(root: string, lead: Lead, issued = new Date(), packageId?: string) {
  const data = invoiceData(lead, issued, packageId);
  const dir = draftDir(root, lead.id); mkdirSync(dir, { recursive: true });
  const rx = data.receptionistIllustration;
  const dueNow = data.lines.length
    ? `${data.lines.map(lineText).join("\n")}\nSubtotal ex GST: ${money(data.subtotal)}\nGST (10%): ${money(data.gst)}\nTOTAL DUE: ${money(data.total)}`
    : "Nothing is due on issue.";
  // The receptionist part: the (b) placeholder and an amount illustration, never an item to issue.
  const later = rx
    ? `\n## AI receptionist monthly fee: not invoiced by this draft\n${rx.billing}\n${rx.lines.length ? `Illustration of the amount only (not an invoice line, not due, not for issue):\n${rx.lines.map(lineText).join("\n")}\nIllustration only: ${money(rx.subtotal)} ex GST + ${money(rx.gst)} GST = ${money(rx.total)}` : "No approved receptionist price to illustrate."}`
    : "";
  const content = `DRAFT — NOT A VALID TAX INVOICE UNTIL THE ABN IS ADDED\n# TAX INVOICE — DRAFT ${data.number}\nSupplier: M&U Ventures · ABN: [REQUIRED — founder to provide before issue]\nCustomer: ${lead.name || `[Lead #${lead.id} — confirm legal name]`} · Address / ABN: [confirm if required]\nInvoice date: ${data.date} · ${data.due ? `Due date: ${data.due}` : "Due date: none (nothing is due from this draft)"}\n## Items due on issue\n${dueNow}${later}${data.notInvoiced.length ? `\n${data.notInvoiced.join("\n")}` : ""}\n## Payment\nBank details: [founder-approved BSB / account placeholder] · Stripe payment link: [founder-approved link placeholder]. Do not pay against this draft.\nNo invoice or payment request has been sent. Confirm the ABN, customer identity and agreed payment terms before issuing.\n`;
  writeFileSync(join(dir, "deposit-invoice.md"), content);
  writeFileSync(join(dir, "deposit-invoice.html"), html("Deposit tax invoice", content));
  // Structured preview only. No customer ID, Stripe SDK, API key or network call. Only the lines due
  // on issue are line items; the receptionist amount is an illustration with the (b) placeholder.
  const item = (l: InvoiceLine) => ({ description: l.description, quantity: 1, price_data: { currency: "aud", unit_amount: l.cents, tax_behavior: l.gst, product_data: { name: l.description } } });
  const payload = { draft: true, create: { collection_method: "send_invoice", ...(data.due ? { days_until_due: 14 } : {}), auto_advance: false, description: `DRAFT ${data.number} — ${lead.name}`, metadata: { lead_id: String(lead.id), draft: "true", requires_founder_approval: "true" } }, line_items: data.lines.map(item), ...(rx ? { receptionist_fee_illustration: { issue: false, note: `Illustration only: not a line item and not for issue. ${rx.billing}`, amounts: rx.lines.map((l) => ({ description: l.description, ex_gst_cents: l.exGstCents, gst_cents: l.gstCents, total_cents: l.totalCents })), total_cents: rx.total, gst_cents: rx.gst } } : {}), tax: { rate_percent: 10, gst_registered: true }, customer: { name: lead.name || "[confirm legal name]", address: "[confirm if required]" }, total_cents: data.total, gst_cents: data.gst };
  writeFileSync(join(dir, "deposit-invoice.stripe-draft.json"), JSON.stringify(payload, null, 2) + "\n");
  return { leadId: lead.id, files: ["deposit-invoice.md", "deposit-invoice.html", "deposit-invoice.stripe-draft.json"], draft: true };
}
export function draftFiles(root: string, id: number) {
  const dir = draftDir(root, id);
  return ["proposal.md", "proposal.html", "deposit-invoice.md", "deposit-invoice.html", "deposit-invoice.stripe-draft.json", "deal-desk-quote.html", "deal-desk-agreement.html", "deal-desk-deal.json"].filter(f => existsSync(join(dir, f)));
}
export function readDraft(root: string, id: number, file: string): string {
  if (!draftFiles(root, id).includes(file)) throw new Error("Draft file not found.");
  return readFileSync(join(draftDir(root, id), file), "utf8");
}
