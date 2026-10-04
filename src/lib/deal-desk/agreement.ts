/**
 * Two-page proposal and agreement (deal desk, 3 Oct 2026), in the house style of M&U's signed website
 * agreement (bianca-brown-realty/meeting-pack-20260914, 17 Sep 2026): page 1 is the agreement (deliverables,
 * investment and payment, working together, signatures); page 2 is the receptionist terms in brief plus the
 * "few details to get started" checklist. Never more than two A4 pages: the UI measures each sheet and warns.
 *
 * Draft only: nothing is sent or signed. Terms that are not approved are marked inline.
 */
import { fmtDay } from "../format";
import { formatAud, getReceptionistPackage, projectPackageProposal } from "../receptionist-packages";
import { effectiveQuote, type Deal } from "./deal";
import { pricedPackage, rxInvoice, calculateRxDeal } from "./receptionist";
import { calculateWebsite } from "./website";

/**
 * Supplier details as on M&U's own signed website agreement (17 Sep 2026). Legal name, ABN, GST registration and
 * business name checked on the public ABN register on 3 Oct 2026.
 */
export const SUPPLIER = {
  legalName: "M KHAN & M.M KHAN trading as M&U Ventures",
  abn: "70 132 896 132",
  /** Region only. Whether a street or postal address appears on client documents is an open owner decision. */
  region: "Western Sydney, NSW",
  signatories: "Mehroz and Usman",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const flag = (text: string) => ` <span class="flag">Needs approval: ${esc(text)}</span>`;
const blank = (width = "14em") => `<span class="blank" style="min-width:${width}"></span>`;
const box = (label: string) => `<span class="opt">☐ ${esc(label)}</span>`;
/** "3 October 2026" for a YYYY-MM-DD date, via the OS's shared formatter. */
const longDate = (iso: string) => fmtDay(`${iso}T00:00:00Z`, { year: true, longMonth: true, timeZone: "UTC" });
const money = (ex: number, gst: number) => `${formatAud(ex + gst)} including GST<br><span class="sub">${formatAud(ex)} + ${formatAud(gst)} GST</span>`;

const textLines = (t: string) => t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
/** Special-term lines that fit on page 2 before an appendix is needed. */
export const MAX_INLINE_NOTES = 3;
/** Payment stages that fit in the page-1 sentence before the schedule moves to the appendix. */
export const MAX_INLINE_STAGES = 3;
/**
 * Runs inside the rendered document: returns, per fixed sheet, how many CSS px the content runs past the
 * printable area (0 = fits). Used by the UI and tests to block an export that would not fit its page.
 */
/**
 * Runs inside the rendered document and estimates how many A4 pages it prints to (printable height 270 mm).
 * Content now flows onto further pages instead of being clipped, so this is information, not a block.
 */
export const AGREEMENT_PAGES_EXPRESSION = `(function(){var mm=96/25.4,h=270*mm;return [...document.querySelectorAll('.sheet,.appendix')].reduce(function(n,s){var cs=getComputedStyle(s);var inner=s.scrollHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);return n+Math.max(1,Math.ceil((inner-2)/h));},0);})()`;

/**
 * Whether this deal needs Appendix A. The standard document is two pages; an appendix is added (content is never
 * dropped or shrunk) when the founder has written their own scope text or more special terms than page 2 holds.
 */
export function agreementPlan(deal: Deal) {
  const q = deal.quote;
  const notes = textLines(q.notes);
  const manyStages = deal.include.website && deal.website.stages.length > MAX_INLINE_STAGES;
  const reasons = [...(q.customText ? ["scope text edited by hand"] : []), ...(notes.length > MAX_INLINE_NOTES ? [`${notes.length} special terms`] : []), ...(manyStages ? [`${deal.website.stages.length} payment stages`] : [])];
  return { appendix: reasons.length > 0, reasons, notes, manyStages, customText: q.customText, longNotes: notes.length > MAX_INLINE_NOTES };
}

export function renderAgreementHtml(deal: Deal): string {
  const plan = agreementPlan(deal);
  const web = deal.include.website; const rx = deal.include.receptionist; const c = deal.client;
  const w = web ? calculateWebsite(deal.website) : null;
  const r = rx ? calculateRxDeal(deal.rx) : null;
  const cat = getReceptionistPackage(deal.rx.packageId);
  const p = projectPackageProposal(cat.id);
  const priced = pricedPackage(deal.rx);
  const monthly = rxInvoice(priced, 0, 0).lines[0];
  const title = web && rx ? "Your new website and AI receptionist" : rx ? "Your AI receptionist" : "Your new website";
  const who = [c.contact, c.business].filter(Boolean).map(esc).join(" · ") || "[Client name · business]";

  // ── What we will deliver ──
  const deliver: string[] = [];
  if (w) {
    const wi = deal.website;
    const cms = wi.cmsComplexity === "none" ? "We make content changes for you (no editing panel)." : `Includes a ${wi.cmsComplexity} editing setup so your team can update agreed content.`;
    deliver.push(`<p><b>Website.</b> A ${wi.kind === "redesign" ? "redesigned" : "new"} business website: discovery, the agreed pages, responsive layouts for mobile and desktop, contact enquiries, basic page titles and search descriptions, testing and launch handover. ${esc(cms)}</p>`,
      `<p>We prepare the agreed design for review and include ${wi.revisions.includedRounds} round${wi.revisions.includedRounds === 1 ? "" : "s"} of consolidated in-scope feedback before written approval to launch. Changes beyond the agreed scope are re-scoped and priced in writing before any extra work begins.${wi.revisions.extraRoundFeeCents === null ? "" : ` Further revision rounds are ${formatAud(wi.revisions.extraRoundFeeCents)} + GST each.${flag("extra-revision price")}`}</p>`);
  }
  if (r) {
    deliver.push(`<p><b>AI receptionist (${esc(cat.shortName)}).</b> Answers calls on ${cat.inclusions.phoneNumbers} number${cat.inclusions.phoneNumbers === 1 ? "" : "s"} in business hours, after hours, alongside your team or as overflow, as you choose. It says it is automated and that calls are recorded, takes structured messages and callback requests, and gives urgent wording the 000 line first. When a caller asks for a person, the receptionist takes their details and a callback request, and (once staff alerts are switched on at go-live) alerts your team by email. It does not transfer live calls. Booking into a connected Google Calendar or Cal.com calendar (up to ${cat.inclusions.calendars}) and SMS confirmations start at go-live, after the acceptance tests; where direct booking isn't possible we agree a booking-request workflow. Reports: ${esc(cat.inclusions.reports.join("; "))}.${flag("product readiness: confirm the receptionist is cleared to sell")}</p>`);
  }

  // ── Investment and payment ──
  const oneOff: string[] = []; const ongoing: string[] = []; const payment: string[] = [];
  if (w) {
    const o = w.oneOff;
    oneOff.push(`<div><b>Website build</b><br>${money(o.priceExGstCents, o.gstCents)}${w.approval.priceMatches ? "" : flag("price differs from the confirmed offer")}</div>`);
    if (w.recurring.enabled) ongoing.push(`<div><b>Website care</b><br>${money(w.recurring.revenueExGstCents, w.recurring.gstCents).replace("including GST", "per month including GST")}${w.approval.careMatches ? "" : flag("care plan price")}</div>`);
    if (plan.manyStages) payment.push(`<p>The build is paid in ${o.stages.length} instalments totalling ${formatAud(o.totalInclGstCents)} including GST; the schedule is in Appendix A.${w.approval.stagesMatch ? "" : flag("payment stages")} Work starts after this agreement, the first payment and the content and access we need.</p>`);
    else payment.push(`<p>Build instalments: ${o.stages.map((s) => `${formatAud(s.inclGstCents)} ${esc(s.trigger.toLowerCase())}`).join(" / ")}, totalling ${formatAud(o.totalInclGstCents)} including GST.${w.approval.stagesMatch ? "" : flag("payment stages")} Work starts after this agreement, the first payment and the content and access we need.</p>`);
    if (w.recurring.enabled) payment.push(`<p>Website care begins at launch. Proposed inclusions: hosting, routine maintenance and up to ${deal.website.care.includedChangeMinutes} minutes of content changes a month, month-to-month with 30 days' written notice.${flag(w.approval.careMatches ? "draft care terms: inclusions and notice period await confirmation (the A$110 price is confirmed)" : "draft care terms: price, inclusions and notice period await confirmation")}</p>`);
  }
  if (r) {
    oneOff.push(`<div><b>Receptionist setup</b><br>${deal.rx.setupFeeCents === null ? `Quoted separately once approved` : `${money(deal.rx.setupFeeCents, Math.round(deal.rx.setupFeeCents / 10))}${flag("setup fees are not approved")}`}</div>`);
    ongoing.push(`<div><b>AI receptionist · ${esc(cat.shortName)}</b><br>${money(monthly.exGstCents, monthly.gstCents).replace("including GST", "per month including GST")}${deal.rx.monthlyDiscountBps ? flag("discounted monthly fee") : ""}<br><span class="sub">${cat.pricing.includedMinutes.toLocaleString("en-AU")} call minutes and ${cat.pricing.includedSmsSegments.toLocaleString("en-AU")} SMS included</span></div>`);
    payment.push(`<p>Extra call minutes ${formatAud(p.display.overagePerMinute.exGstCents)} + GST, counted by the second (see "Receptionist terms in brief"). Receptionist fees are invoiced monthly ${blank("8em")} (in advance / in arrears)${flag("billing timing is an open owner decision")}. Minimum term ${deal.rx.termMonths} months, then ${cat.pricing.noticeDays} days' written notice.${deal.rx.termMonths !== cat.pricing.minimumTermMonths ? flag("term differs from catalogue") : flag("minimum term is proposed")} How a first part-month is charged is still to be agreed.${flag("first-month charging is an open owner decision")}</p>`);
  }
  payment.push(`<p class="small">No direct debit is authorised by this document; the payment method is arranged separately. All prices in Australian dollars.</p>`);

  const both = web && rx;
  const workingSupply = `<p>You supply approved text, images, business details and permission to use them, plus the access we need${rx ? " (calendar access is granted by you; no passwords are shared)" : ""}. We agree a ${web ? "launch" : "go-live"} date once content and access are available, and discuss delays promptly. We correct in-scope defects; scope or timing changes need written agreement. No search-ranking, lead-volume, booking or revenue guarantees apply.</p>`;
  const workingOwnership = `<p>After full payment, you own the bespoke deliverables; pre-existing tools and third-party components keep their own licences. Both parties protect confidential information and use it only for this work. If cancelled early, payments are reconciled against authorised work completed and approved unavoidable costs; unearned amounts are refunded. NSW law applies; Australian Consumer Law rights are not excluded.</p>`;
  // A combined website + receptionist agreement moves the ownership/cancellation paragraph to page 2 to stay on two pages.
  const working = both ? workingSupply : workingSupply + workingOwnership;

  const page1 = `<section class="sheet">
<header><div class="logo">M&amp;U Ventures</div><div class="meta">${esc(longDate(deal.quote.preparedOn))}<br>Proposed agreement · ${esc(deal.quote.number)}</div></header>
<h1>${title}</h1>
<p class="parties">Prepared for ${who}<br>Supplier: ${esc(SUPPLIER.legalName)}<br>ABN ${SUPPLIER.abn} · ${esc(SUPPLIER.region)}${flag("supplier address")}<br>Client legal entity / ABN: ${c.abn ? esc(c.abn) : blank("22em")}</p>
<h2>What we will deliver</h2>${deliver.join("")}${plan.appendix ? `<p class="small"><b>Appendix A</b> (${esc(plan.reasons.join("; "))}) forms part of this agreement.</p>` : ""}
<h2>Investment &amp; payment</h2>
<table><thead><tr><th>One-off</th><th>Ongoing</th></tr></thead><tbody><tr><td>${oneOff.join("") || "—"}</td><td>${ongoing.join("") || "—"}</td></tr></tbody></table>
${payment.join("")}
<h2>Working together</h2>${working}
<div class="sign"><div><b>M&amp;U Ventures</b><span class="line"></span>Names: ${esc(SUPPLIER.signatories)}<br>Date: ${blank("8em")}</div><div><b>Client authorised representative</b><span class="line"></span>Name / role: ${blank("10em")}<br>Date: ${blank("8em")}</div></div>
</section>`;

  // ── Page 2 ──
  const rxTerms = r ? `<h2>Receptionist terms in brief</h2>
<ul class="terms">
<li><b>Usage billing.</b> Connected call time is counted by the second, added up over the month and rounded up to a whole minute once. Calls under ${cat.pricing.billing.minimumBillableSeconds} seconds, calls that never reach the receptionist and our own test and demo calls don't count. Extra minutes ${formatAud(p.display.overagePerMinute.exGstCents)} + GST (${formatAud(p.display.overagePerMinute.inclGstCents)}); extra SMS segments ${formatAud(p.display.extraSmsSegment.exGstCents)} + GST. Allowances reset monthly and don't roll over.</li>
<li><b>Not included.</b> Live transfer to a person, emergency services, clinical, legal or financial advice, and practice-management software (Cliniko, Dentally and similar).</li>
<li><b>Acceptance.</b> Before go-live the line only takes messages. We run ${"five"} scripted test calls with you; go-live starts when you confirm in writing that they passed. You can switch call forwarding off at any time.</li>
<li><b>Not an emergency service.</b> Anyone describing an emergency is told to hang up and call 000.</li>
<li><b>Privacy.</b> We handle caller information only to provide the service and on your instructions. Call audio and transcripts are processed by our providers, including in the United States; your privacy policy must say so before go-live.</li>
<li><b>SMS.</b> Texts are sent only with the caller's consent given on the call, and every text can be stopped by replying STOP.</li>
<li><b>Support.</b> ${esc(cat.support.hours)}; first response ${esc(cat.support.firstResponse.toLowerCase())}. ${esc(cat.support.reviews)}.</li>
<li><b>Summary only.</b> These points summarise M&amp;U's full receptionist service agreement, which is a draft still under legal review. They do not replace it.${flag("full service agreement is not yet approved")}</li>
<li><b>Liability.</b> To the extent the law allows, each party's liability is limited to the fees paid in the 3 months before the claim, and neither is liable for indirect loss.${flag("subject to legal review")}</li>
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
<header><div class="logo">M&amp;U Ventures</div><div class="meta">${esc(c.business || "Client")}<br>Terms in brief and setup checklist</div></header>
${both ? `<h2>Ownership, cancellation and law</h2>${workingOwnership}` : ""}
${rxTerms}
${notes.length ? `<h2>Special terms</h2><ul class="terms">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
<h1 class="h1-2">A few details to get started</h1>
<p class="small">Tick your preferences below, or reply by email with your selections.</p>
${webChecklist}${rxChecklist}
<h3>Approval and timing</h3>
<p>Person approving the work: ${blank("16em")} · Preferred ${web ? "launch" : "go-live"} date: ${blank("10em")}</p>
<h3>Anything essential we missed? (optional)</h3>
<div class="lines">${"<span></span>".repeat(notes.length ? 2 : 4)}</div>
</section>`;

  const q = effectiveQuote(deal);
  const section = (title: string, text: string) => textLines(text).length ? `<h2>${title}</h2><ul class="terms">${textLines(text).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
  const appendix = plan.appendix ? `<section class="appendix">
<header><div class="logo">M&amp;U Ventures</div><div class="meta">${esc(c.business || "Client")}<br>Appendix A · ${esc(q.number)}</div></header>
<h1 class="h1-2">Appendix A</h1>
<p class="small">This appendix forms part of the proposed agreement dated ${esc(longDate(q.preparedOn))}.</p>
${plan.manyStages && w ? `<h2>Payment schedule (website build)</h2><table><thead><tr><th>Stage</th><th>When it is due</th><th>Amount including GST</th></tr></thead><tbody>${w.oneOff.stages.map((st) => `<tr><td>${esc(st.label)} (${st.shareBps / 100}%)</td><td>${esc(st.trigger)}</td><td>${formatAud(st.inclGstCents)}<br><span class="sub">${formatAud(st.exGstCents)} + ${formatAud(st.gstCents)} GST</span></td></tr>`).join("")}</tbody></table>` : ""}
${plan.customText ? section("Scope", q.scope) : ""}${plan.customText ? section("Deliverables", q.deliverables) + section("Not included", q.exclusions) + section("Timeline", q.timeline) + section("Ongoing costs and responsibilities", q.responsibilities) : ""}${plan.longNotes ? section("Special terms", q.notes) : ""}
</section>` : "";
  const body = page1 + page2 + appendix;
  const flags = (body.match(/class="flag"/g) ?? []).length;
  const draftBar = flags ? `<div class="draftbar">Draft for review. ${flags} item${flags === 1 ? "" : "s"} marked “Needs approval” must be resolved before this is issued or signed.</div>` : "";
  const pages = body.replace('<section class="sheet">', `<section class="sheet">${draftBar}`);

  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}: proposed agreement</title>
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
