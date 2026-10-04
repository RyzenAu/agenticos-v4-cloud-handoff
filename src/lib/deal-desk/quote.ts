/**
 * Quote preparation (deal desk, 3 Oct 2026). Turns a deal into an unsent DRAFT quote document, then renders
 * it as printable HTML or Markdown. Nothing here sends, posts, creates an invoice or a payment session.
 *
 * Every receptionist price comes from the catalogue (projectPackageProposal). Terms that are not approved are
 * carried as `unapproved` items and marked inline wherever they appear in the document.
 */
import { fmtDay } from "../format";
import { formatAud, getReceptionistPackage, projectPackageProposal } from "../receptionist-packages";
import { effectiveQuote, type Deal } from "./deal";
import { pricedPackage, rxInvoice, calculateRxDeal } from "./receptionist";
import { calculateWebsite } from "./website";

/** Verbatim from scripts/leads/sales-backoffice.ts; scripts/deal-desk/quote.test.ts fails if they drift. */
export const OWNER_DECISION_B = "[OWNER DECISION (b) PENDING: is the monthly fee billed in advance from Acceptance, or in arrears after each billing period? Not decided.]";
export const BOOKING_DISCLOSURE = "Booking integrations vary by business and scheduling system. We confirm compatibility during setup; where direct booking is unavailable, we offer an agreed booking-request or lead-capture workflow.";
export const PRORATION_PENDING = "[OWNER DECISION PENDING: how the first month is charged when go-live falls mid-month. Not decided.]";
/** M&U's ABN (checked on the public ABN register, 3 Oct 2026). */
export const SUPPLIER_ABN = "70 132 896 132";

export type Money = { exGstCents: number; gstCents: number; inclGstCents: number };
export type PriceRow = { label: string; detail: string; money: Money | null; unapproved?: string };
export type QuoteDoc = {
  draftBanner: string; number: string; preparedOn: string; validUntil: string; title: string; summary: string;
  supplier: { name: string; abn: string; contact: string };
  client: Deal["client"];
  scope: string[]; deliverables: string[]; exclusions: string[]; timeline: string[]; responsibilities: string[]; notes: string[];
  oneOff: PriceRow[]; oneOffTotal: Money | null;
  stages: { label: string; trigger: string; money: Money; unapproved?: string }[];
  recurring: PriceRow[];
  usage: { heading: string; rows: PriceRow[]; total: Money } | null;
  billingRules: string[];
  unapproved: { id: string; text: string }[];
  openDecisions: string[];
  missing: string[];
};

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const m = (exGstCents: number, gstCents: number): Money => ({ exGstCents, gstCents, inclGstCents: exGstCents + gstCents });
function addDays(iso: string, days: number) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

export function buildQuote(deal: Deal): QuoteDoc {
  const q = effectiveQuote(deal); const unapproved: QuoteDoc["unapproved"] = []; const openDecisions: string[] = [];
  const oneOff: PriceRow[] = []; const recurring: PriceRow[] = []; let stages: QuoteDoc["stages"] = []; let usage: QuoteDoc["usage"] = null;
  const billingRules: string[] = [];
  let oneOffTotal: Money | null = null;

  if (deal.include.website) {
    const w = deal.website; const r = calculateWebsite(w); const o = r.oneOff;
    for (const [i, text] of r.approval.unapproved.entries()) unapproved.push({ id: `web-${i}`, text });
    const priceFlag = r.approval.priceMatches ? undefined : "Price is a scenario, not the confirmed website offer";
    oneOff.push({ label: w.kind === "redesign" ? "Website redesign" : "Website design and build", detail: "Fixed price for the scope below", money: m(o.listExGstCents, o.discountCents ? o.listGstCents : o.gstCents), unapproved: o.discountCents ? undefined : priceFlag });
    if (o.discountCents) { const listGst = o.listGstCents; oneOff.push({ label: "Discount", detail: w.discount.type === "percent" ? `${w.discount.bps / 100}% of the ex-GST price` : "Fixed amount", money: m(-o.discountCents, -(listGst - o.gstCents)), unapproved: "Discounts are not an approved term" }); }
    oneOffTotal = m(o.priceExGstCents, o.gstCents);
    if (w.revisions.extraRoundFeeCents !== null) oneOff.push({ label: "Each extra revision round (if requested)", detail: `Beyond the ${w.revisions.includedRounds} included`, money: m(w.revisions.extraRoundFeeCents, Math.round(w.revisions.extraRoundFeeCents / 10)), unapproved: "No extra-revision price has been approved" });
    const stageFlag = r.approval.stagesMatch ? undefined : "Payment stages differ from the confirmed 50/50";
    stages = o.stages.map((s) => ({ label: `${s.label} (${s.shareBps / 100}%)`, trigger: s.trigger, money: m(s.exGstCents, s.gstCents), unapproved: stageFlag }));
    if (w.care.enabled) {
      recurring.push({ label: "Website care plan, monthly from launch", detail: `Proposed inclusions: hosting, maintenance and up to ${w.care.includedChangeMinutes} minutes of changes a month; 30 days' notice to end.`, money: m(r.recurring.revenueExGstCents, r.recurring.gstCents), unapproved: r.approval.careMatches ? "Draft care terms: inclusions and notice await confirmation" : "Care plan price is a scenario; inclusions and notice await confirmation" });
    }
  }

  if (deal.include.receptionist) {
    const rx = calculateRxDeal(deal.rx); const pkg = pricedPackage(deal.rx); const cat = getReceptionistPackage(deal.rx.packageId);
    const p = projectPackageProposal(cat.id);
    for (const u of rx.unapproved) unapproved.push(u);
    const monthly = rxInvoice(pkg, 0, 0).lines[0];
    const approved = p.pricing.status !== "approved" ? "proposed, not approved"
      : deal.rx.monthlyDiscountBps > 0 ? `catalogue price approved ${p.pricing.approvedAt}; this discounted fee is not approved` : `catalogue ${p.catalogueVersion}, approved ${p.pricing.approvedAt}`;
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
    billingRules.push(
      `Connected call time is measured by the second, added up over the billing month and rounded up to the next whole minute once. Calls shorter than ${cat.pricing.billing.minimumBillableSeconds} seconds, calls that never reach the receptionist, and M&U's own test and demo calls are not counted.`,
      `Included minutes and SMS reset each billing month and do not roll over. Extra minutes and SMS are charged in arrears on the next invoice.`,
      `Proposed minimum term ${deal.rx.termMonths} months, then ${cat.pricing.noticeDays} days' written notice.`,
      "Prices are quoted excluding GST. M&U Ventures is registered for GST, so 10% GST is added to every invoice.",
      BOOKING_DISCLOSURE,
      "Still to be confirmed before this is issued: whether the monthly fee is billed in advance or in arrears, how a first part-month is charged, and that the receptionist is cleared for sale.",
    );
    openDecisions.push(OWNER_DECISION_B, PRORATION_PENDING);
    if (q.usageIllustration) {
      const col = deal.rx.columns.expected;
      const inv = rxInvoice(pkg, col.billableSeconds, col.smsSegments);
      const mins = col.billableSeconds / 60;
      usage = {
        heading: `Illustration only: a month with ${Number.isInteger(mins) ? mins.toLocaleString("en-AU") : mins.toFixed(2)} billable minutes and ${col.smsSegments.toLocaleString("en-AU")} SMS segments`,
        rows: inv.lines.filter((l) => l.quantity > 0).map((l) => ({ label: l.description, detail: l.id === "monthly" ? "" : `${l.quantity.toLocaleString("en-AU")} × ${formatAud(l.unitExGstCents)} ex GST`, money: m(l.exGstCents, l.gstCents) })),
        total: m(inv.exGstCents, inv.gstCents),
      };
    }
    unapproved.push({ id: "rx-readiness", text: "Product readiness: the receptionist is in internal testing (booking and SMS start at go-live after activation and acceptance tests). Confirm it is cleared to sell before sending." });
  }

  const missing: string[] = [];
  if (!deal.client.business.trim()) missing.push("Client business name");
  if (!deal.client.contact.trim()) missing.push("Client contact");
  if (!deal.client.abn.trim()) missing.push("Client ABN (if required on the agreement)");
  if (!deal.include.website && !deal.include.receptionist) missing.push("Nothing is selected to quote");

  return {
    draftBanner: "DRAFT QUOTE: NOT SENT, NOT AN INVOICE, NOT FOR SIGNATURE",
    number: q.number, preparedOn: q.preparedOn, validUntil: addDays(q.preparedOn, q.validDays),
    title: q.projectTitle || "Proposal", summary: q.summary,
    supplier: { name: "M KHAN & M.M KHAN trading as M&U Ventures", abn: SUPPLIER_ABN, contact: q.preparedBy },
    client: deal.client,
    scope: lines(q.scope), deliverables: lines(q.deliverables), exclusions: lines(q.exclusions), timeline: lines(q.timeline),
    responsibilities: lines(q.responsibilities), notes: lines(q.notes),
    oneOff, oneOffTotal, stages, recurring, usage, billingRules, unapproved, openDecisions, missing,
  };
}

/** "3 October 2026" for a YYYY-MM-DD date. */
const day = (iso: string) => fmtDay(`${iso}T00:00:00Z`, { year: true, longMonth: true, timeZone: "UTC" });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const cells = (x: Money | null) => x ? `<td>${formatAud(x.exGstCents)}</td><td>${formatAud(x.gstCents)}</td><td>${formatAud(x.inclGstCents)}</td>` : `<td colspan="3" class="muted">To be confirmed</td>`;
const flag = (text?: string) => text ? ` <span class="flag">Needs approval: ${esc(text)}</span>` : "";
const list = (items: string[]) => items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted">To be agreed.</p>`;
const rowsHtml = (rows: PriceRow[]) => rows.map((r) => `<tr><th scope="row">${esc(r.label)}${r.detail ? `<small>${esc(r.detail)}</small>` : ""}${flag(r.unapproved)}</th>${cells(r.money)}</tr>`).join("");
const head = `<thead><tr><th scope="col">Item</th><th scope="col">Ex GST</th><th scope="col">GST</th><th scope="col">Incl. GST</th></tr></thead>`;

/** Self-contained printable HTML. `internal` adds the founder review box (approvals, decisions, missing fields). */
export function renderQuoteHtml(doc: QuoteDoc, internal = true): string {
  const c = doc.client;
  const review = internal ? `<section class="review"><h2>Before this can be sent</h2>
${doc.unapproved.length ? `<h3>Needs owner approval</h3>${list(doc.unapproved.map((u) => u.text))}` : ""}
${doc.openDecisions.length ? `<h3>Open owner decisions</h3>${list(doc.openDecisions)}` : ""}
${doc.missing.length ? `<h3>Missing details</h3>${list(doc.missing)}` : ""}
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
<h2>Scope</h2>${list(doc.scope)}
<h2>Deliverables</h2>${list(doc.deliverables)}
<h2>Not included</h2>${list(doc.exclusions)}
<h2>Timeline</h2>${list(doc.timeline)}
${doc.oneOff.length ? `<h2>One-off fees</h2><table>${head}<tbody>${rowsHtml(doc.oneOff)}</tbody>${doc.oneOffTotal ? `<tfoot><tr><th scope="row">Total one-off</th>${cells(doc.oneOffTotal)}</tr></tfoot>` : ""}</table>` : ""}
${doc.stages.length ? `<h3>Payment stages (website)</h3><table>${head}<tbody>${doc.stages.map((s) => `<tr><th scope="row">${esc(s.label)}<small>${esc(s.trigger)}</small>${flag(s.unapproved)}</th>${cells(s.money)}</tr>`).join("")}</tbody></table>` : ""}
${doc.recurring.length ? `<h2>Ongoing fees</h2><table>${head}<tbody>${rowsHtml(doc.recurring)}</tbody></table>` : ""}
${doc.billingRules.length ? `<h3>How receptionist usage is billed</h3>${list(doc.billingRules)}` : ""}
${doc.usage ? `<h3>${esc(doc.usage.heading)}</h3><table>${head}<tbody>${rowsHtml(doc.usage.rows)}</tbody><tfoot><tr><th scope="row">Illustrative month</th>${cells(doc.usage.total)}</tr></tfoot></table><p class="note">An illustration of how the rules above apply, not a commitment or an invoice.</p>` : ""}
<h2>Ongoing costs and responsibilities</h2>${list(doc.responsibilities)}
${doc.notes.length ? `<h2>Notes</h2>${list(doc.notes)}` : ""}
<h2>Acceptance</h2><p>This draft is not an offer to accept. A final version is issued with the agreement once both founders have confirmed every item above.</p>
<footer>M&amp;U Ventures · Western Sydney, NSW · All amounts in Australian dollars. GST is 10%, shown per line and rounded to the cent.</footer>
</main></body></html>`;
}

export function renderQuoteMarkdown(doc: QuoteDoc): string {
  const money = (x: Money | null) => x ? `${formatAud(x.exGstCents)} | ${formatAud(x.gstCents)} | ${formatAud(x.inclGstCents)}` : "To be confirmed | | ";
  const fl = (t?: string) => t ? ` **[NEEDS APPROVAL: ${t}]**` : "";
  /** Markdown renders raw HTML and treats | as a column break: neutralise both in user-entered text. */
  const md = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
  const table = (rows: PriceRow[]) => ["| Item | Ex GST | GST | Incl. GST |", "|---|---:|---:|---:|", ...rows.map((r) => `| ${md(r.label)}${r.detail ? ` (${md(r.detail)})` : ""}${fl(r.unapproved)} | ${money(r.money)} |`)].join("\n");
  const bl = (items: string[]) => items.length ? items.map((i) => `- ${md(i)}`).join("\n") : "- To be agreed.";
  const out = [
    `**${doc.draftBanner}**`, "", `# ${md(doc.title)}`, "", `Quote ${md(doc.number)} · Prepared ${day(doc.preparedOn)} · Valid until ${day(doc.validUntil)}`, "", md(doc.summary), "",
    "## Before this can be sent (M&U only)", bl([...doc.unapproved.map((u) => `Needs approval: ${u.text}`), ...doc.openDecisions, ...doc.missing.map((x) => `Missing: ${x}`)]), "",
    "## Parties", `- Prepared for: ${md(doc.client.business || "[Client]")}, ${md(doc.client.contact || "[Contact]")}`, `- Prepared by: ${md(doc.supplier.name)}, ${md(doc.supplier.contact)} · ABN ${doc.supplier.abn}`, "",
    "## Scope", bl(doc.scope), "", "## Deliverables", bl(doc.deliverables), "", "## Not included", bl(doc.exclusions), "", "## Timeline", bl(doc.timeline), "",
  ];
  if (doc.oneOff.length) out.push("## One-off fees", table(doc.oneOff), doc.oneOffTotal ? `\n**Total one-off:** ${money(doc.oneOffTotal).replace(/ \| /g, " ex GST · ").replace(/ \| ?$/, "")} incl. GST` : "", "");
  if (doc.stages.length) out.push("### Payment stages (website)", table(doc.stages.map((s) => ({ label: s.label, detail: s.trigger, money: s.money, unapproved: s.unapproved }))), "");
  if (doc.recurring.length) out.push("## Ongoing fees", table(doc.recurring), "");
  if (doc.billingRules.length) out.push("### How receptionist usage is billed", bl(doc.billingRules), "");
  if (doc.usage) out.push(`### ${doc.usage.heading}`, table([...doc.usage.rows, { label: "**Illustrative month**", detail: "", money: doc.usage.total }]), "");
  out.push("## Ongoing costs and responsibilities", bl(doc.responsibilities), "");
  if (doc.notes.length) out.push("## Notes", bl(doc.notes), "");
  out.push("All amounts in Australian dollars. GST is 10%, shown per line and rounded to the cent.", "");
  return out.join("\n");
}
