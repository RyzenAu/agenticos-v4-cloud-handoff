/**
 * M&U deal desk: local, draft-only interface over src/lib/deal-desk. Framework-free DOM code so it runs as a
 * static page with no install; the OS can mount the same pure modules in its own React shell later.
 * Saves to this browser's localStorage only. Sends nothing, creates no invoice or payment session.
 */
import { costEvidenceTable, DEFAULT_COST_RATES, ECONOMICS_AS_OF, RATE_SOURCES, REVIEW_TRIGGER } from "../../src/lib/business-economics";
import { auditDeal } from "../../src/lib/deal-desk/checks";
import { blankDeal, comparisonCsv, defaultQuoteText, effectiveQuote, fillQuoteText, newId, parseDealShape, parseDeals, seedDeals, serializeDeals, STORAGE_KEY, type Deal } from "../../src/lib/deal-desk/deal";
import { formatAud, hoursText, parseDecimal, pctText } from "../../src/lib/deal-desk/money";
import { buildQuote, renderQuoteHtml, renderQuoteMarkdown } from "../../src/lib/deal-desk/quote";
import { AGREEMENT_PAGES_EXPRESSION, agreementPlan, renderAgreementHtml } from "../../src/lib/deal-desk/agreement";
import { calculateRxDeal, defaultRxColumns, RX_COLUMN_LABELS, RX_VOICE_PRESETS, type RxColumnId } from "../../src/lib/deal-desk/receptionist";
import { CMS_PRESETS, calculateWebsite, EFFORT_LABELS, PAYMENT_PRESETS, type CmsComplexity, type EffortKey } from "../../src/lib/deal-desk/website";
import { validateDeal } from "../../src/lib/deal-desk/validate";
import { fmtDateTime, fmtTime } from "../../src/lib/format";
import { ConflictError, ownerName, refreshDecision, sessionCanWrite, shared, type Owner, type WorkbookRecord } from "./shared";
import { priceStatusLines } from "../../src/lib/price-status";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES, type PackageId } from "../../src/lib/receptionist-packages";

type Tab = "deal" | "website" | "receptionist" | "quote" | "agreement" | "checks";
const TABS: { id: Tab; label: string }[] = [
  { id: "deal", label: "Deal" }, { id: "website", label: "Website" }, { id: "receptionist", label: "Receptionist" },
  { id: "quote", label: "Quote" }, { id: "agreement", label: "Agreement" }, { id: "checks", label: "Checks & sources" },
];
const TAB_IDS = TABS.map((t) => t.id) as string[];
/** Today in Sydney as a YYYY-MM-DD key (a machine key, not prose). */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

type SaveState = "ok" | "failed" | "conflict" | "invalid" | "locked" | "saving" | "readonly";
const store = {
  rev(): number { try { return Number(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").rev ?? 0); } catch { return 0; } },
  /**
   * Reads each saved deal on its own. A deal that no longer opens is kept untouched in `quarantined` and written
   * back on every save; saved data that cannot be read at all locks saving so nothing overwrites it.
   */
  read(): { deals: Deal[]; drafts: Map<string, string>; quarantined: unknown[]; unreadable: boolean; currentId: string; tab: Tab; rev: number } | null {
    let raw: string | null = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
    if (!raw) return null;
    let s: any;
    try { s = JSON.parse(raw); if (!s || typeof s !== "object" || !Array.isArray(s.deals)) throw new Error("shape"); }
    catch { return { deals: [], drafts: new Map(), quarantined: [], unreadable: true, currentId: "", tab: "deal", rev: 0 }; }
    const deals: Deal[] = []; const quarantined: unknown[] = []; const drafts = new Map<string, string>();
    for (const item of [...s.deals, ...(Array.isArray(s.quarantined) ? s.quarantined : [])]) {
      try { const d = parseDealShape(item); if (deals.some((x) => x.id === d.id)) throw new Error("duplicate"); deals.push(d); if (validateDeal(d)) drafts.set(d.id, validateDeal(d)!); else lastValid.set(d.id, structuredClone(d)); }
      catch { quarantined.push(item); }
    }
    // An unfinished working copy is kept beside the last complete version and reopened in its place.
    for (const [id, raw] of Object.entries(s.drafts && typeof s.drafts === "object" ? s.drafts : {})) {
      try { const d = parseDealShape(raw, "Unfinished changes"); const i = deals.findIndex((x) => x.id === id); if (i < 0) deals.push(d); else deals[i] = d; drafts.set(id, validateDeal(d) ?? "unfinished"); }
      catch { quarantined.push(raw); }
    }
    return { deals, drafts, quarantined, unreadable: false, currentId: String(s.currentId ?? ""), tab: TAB_IDS.includes(s.tab) ? s.tab : "deal", rev: Number(s.rev ?? 0) || 0 };
  },
  /** Never overwrites a newer save made in another tab: that is reported as a conflict instead. */
  write(): SaveState {
    try {
      if (state.locked) return "locked";
      if (localStorage.getItem(STORAGE_KEY) !== null && store.rev() !== state.rev) return "conflict";
      // Complete versions go in `deals`; an unfinished working copy goes in `drafts` and never replaces the last complete one.
      const complete = state.deals.map((d) => (invalid.has(d.id) ? lastValid.get(d.id) : d)).filter((d): d is Deal => Boolean(d));
      const drafts = Object.fromEntries(state.deals.filter((d) => invalid.has(d.id)).map((d) => [d.id, d]));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ rev: state.rev + 1, deals: complete, drafts, quarantined: state.quarantined, currentId: state.currentId, tab: state.tab }));
      state.rev += 1; return "ok";
    } catch { return "failed"; }
  },
};
/** Last complete (calculable) version of each deal, so an unfinished edit never replaces it. */
const lastValid = new Map<string, Deal>();
/** Deals that currently cannot be calculated (id → reason): kept as drafts, never exported. */
const invalid = new Map<string, string>();
const saved = store.read();
for (const [id, why] of saved?.drafts ?? []) invalid.set(id, why);
const state = {
  deals: saved && saved.deals.length ? saved.deals : seedDeals(),
  quarantined: saved?.quarantined ?? [] as unknown[],
  /** Saved data exists but could not be read: saving is off so it is never overwritten. */
  locked: saved?.unreadable ?? false,
  currentId: saved?.currentId || "seed-dental-pro", tab: (saved?.tab ?? "deal") as Tab, rev: saved ? saved.rev : store.rev(),
  savedAt: "", save: (saved?.unreadable ? "locked" : "ok") as SaveState, invalidWhy: "", agreementOver: [] as number[], agreementChecked: false,
  /** "shared" when the OS serves this page with the shared workbook routes; otherwise this browser only. */
  mode: "local" as "local" | "shared",
  /** Shared mode: the server revision each open workbook was loaded or saved at, and who saved it last. */
  revs: new Map<string, number>(), by: new Map<string, { who: Owner; at: string }>(), links: new Map<string, { leadId: number | null; crm: string | null }>(),
  conflict: null as null | { id: string; current: WorkbookRecord | null },
  /** Shared mode in a browser that is not a confirmed session: it may look, not change. */
  readOnly: false,
  /** Shared mode: the server withheld the quote bodies (this browser is not confirmed), so none are shown. */
  withheld: false,
  /** Local deals offered for copying into the shared workspace (never deleted from this browser). */
  localOffer: [] as Deal[], offerOpen: false, note: "",
};
// Deep links (?deal=<id>&tab=<tab>) so the OS or a test can open a specific view.
const params = new URLSearchParams(location.search);
if (params.get("deal")) state.currentId = params.get("deal")!;
if (TABS.some((t) => t.id === params.get("tab"))) state.tab = params.get("tab") as Tab;
if (!state.deals.some((d) => d.id === state.currentId)) state.currentId = state.deals[0].id;
const deal = () => state.deals.find((d) => d.id === state.currentId)!;

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const aud = (c: number | null | undefined) => c === null || c === undefined ? "Unknown" : formatAud(Math.round(c));
const cls = (n: number | null | undefined) => n === null || n === undefined ? "" : n < 0 ? "neg" : "pos";
const dur = (s: number) => { const m = Math.floor(s / 60); const r = s % 60; return r ? `${m.toLocaleString("en-AU")}:${String(r).padStart(2, "0")}` : m.toLocaleString("en-AU"); };
const minsText = (s: number) => `${dur(s)} min`;
const money2 = (c: number | null) => c === null ? "" : (c / 100).toFixed(2);
const usd6 = (micros: number | null | undefined) => micros === null || micros === undefined ? "" : String(micros / 1_000_000);

// ── bindings: data-bind="path" data-kind="…" ────────────────────────────────────────────────────────────
type Kind = "money" | "money?" | "hours" | "int" | "pct" | "rate6" | "rate6?" | "dur" | "text" | "date" | "select" | "bool" | "selectnum";
function getPath(obj: any, path: string) { return path.split(".").reduce((o, k) => o?.[k], obj); }
function setPath(obj: any, path: string, value: unknown) {
  const keys = path.split("."); const last = keys.pop()!;
  const target = keys.reduce((o, k) => o[k], obj); target[last] = value;
}
function parseValue(kind: Kind, raw: string, el: HTMLInputElement | HTMLSelectElement): unknown {
  switch (kind) {
    case "money": return parseDecimal(raw, 2);
    case "money?": return raw.trim() === "" ? null : parseDecimal(raw, 2);
    case "hours": return Math.round(parseDecimal(raw, 2) * 60 / 100);
    case "int": return parseDecimal(raw, 0);
    case "selectnum": return Number(raw);
    case "pct": { const v = parseDecimal(raw, 2); if (v > 10000) throw new Error("At most 100%"); return v; }
    case "rate6": return parseDecimal(raw, 6);
    case "rate6?": return raw.trim() === "" ? null : parseDecimal(raw, 6);
    case "dur": {
      const m = /^\s*(\d{1,3}(?:,\d{3})*|\d+)(?::(\d{1,2}))?\s*$/.exec(raw);
      if (!m) throw new Error("Minutes, or minutes:seconds (e.g. 1000:01)");
      const secs = Number(m[2] ?? 0); if (secs > 59) throw new Error("Seconds must be 0–59");
      return Number(m[1].replace(/,/g, "")) * 60 + secs;
    }
    case "date": if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Use YYYY-MM-DD"); return raw;
    case "bool": return (el as HTMLInputElement).checked;
    default: return raw;
  }
}
function display(kind: Kind, v: any): string {
  switch (kind) {
    case "money": case "money?": return money2(v);
    case "hours": return String(Math.round(v / 60 * 100) / 100);
    case "pct": return String(v / 100);
    case "rate6": case "rate6?": return usd6(v);
    case "dur": return dur(v);
    default: return v ?? "";
  }
}

/** A labelled input bound to the current deal. */
const GENERATED_QUOTE_KEYS = ["projectTitle", "summary", "scope", "deliverables", "exclusions", "timeline", "responsibilities"];
/** Quote text shows the generated wording until the founder edits it. */
const viewPath = (path: string) => path.startsWith("quote.") ? getPath({ quote: effectiveQuote(deal()) }, path) : getPath(deal(), path);
function field(path: string, label: string, kind: Kind, opts: { hint?: string; suffix?: string; prefix?: string; wide?: boolean; placeholder?: string } = {}) {
  const v = viewPath(path); const id = `f-${path.replace(/\./g, "-")}`;
  if (kind === "bool") return `<label class="check${opts.wide ? " wide" : ""}" for="${id}"><input id="${id}" type="checkbox" data-bind="${path}" data-kind="bool" ${v ? "checked" : ""}><span>${esc(label)}</span></label>`;
  const inputmode = kind === "text" ? "" : kind === "int" ? ` inputmode="numeric"` : kind === "date" ? "" : ` inputmode="decimal"`;
  return `<div class="field${opts.wide ? " wide" : ""}"><label for="${id}">${esc(label)}</label><div class="inwrap">${opts.prefix ? `<span class="affix">${opts.prefix}</span>` : ""}<input id="${id}" data-bind="${path}" data-kind="${kind}" value="${esc(display(kind, v))}"${inputmode} placeholder="${esc(opts.placeholder ?? (kind.endsWith("?") ? "Unknown" : ""))}" autocomplete="off">${opts.suffix ? `<span class="affix">${opts.suffix}</span>` : ""}</div>${opts.hint ? `<small class="hint">${esc(opts.hint)}</small>` : ""}<small class="err" data-err-for="${path}"></small></div>`;
}
function select(path: string, label: string, options: [string, string][], kind: Kind = "select", action = "") {
  const v = String(getPath(deal(), path)); const id = `f-${path.replace(/\./g, "-")}`;
  return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" data-bind="${path}" data-kind="${kind}"${action ? ` data-after="${action}"` : ""}>${options.map(([val, text]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></div>`;
}
const area = (path: string, label: string, hint = "") => {
  const id = `f-${path.replace(/\./g, "-")}`;
  return `<div class="field wide"><label for="${id}">${esc(label)}</label><textarea id="${id}" rows="5" data-bind="${path}" data-kind="text">${esc(viewPath(path))}</textarea>${hint ? `<small class="hint">${esc(hint)}</small>` : ""}</div>`;
};
const card = (title: string, body: string, extra = "") => `<section class="card ${extra}"><h3>${title}</h3>${body}</section>`;
const stat = (label: string, value: string, tone = "", sub = "") => `<div class="stat ${tone}"><span>${esc(label)}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
const flagList = (items: string[], title = "Needs owner approval") => items.length ? `<div class="flags"><strong>${title}</strong><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>` : "";
const unknownList = (items: string[]) => items.length ? `<div class="unknowns"><strong>Unknown costs: excluded from totals, not zero</strong><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>` : "";

// ── tabs ────────────────────────────────────────────────────────────────────────────────────────────────
/** Import preview: what copying this browser's deals into the shared workspace would do, before anything is sent. */
function offerPanel() {
  const shared = new Map(state.deals.map((d) => [d.id, d]));
  const rows = state.localOffer.map((d, i) => {
    const there = shared.get(d.id); const same = there && JSON.stringify({ ...there, updatedAt: "" }) === JSON.stringify({ ...d, updatedAt: "" });
    const why = validateDeal(d);
    const outcome = same ? "Already in the shared workspace (identical): skipped" : there ? "A different shared workbook has this id: copied as a new workbook" : "New: copied as it is";
    return `<tr><td><input type="checkbox" id="offer-${i}" data-offer="${i}" ${same ? "disabled" : "checked"} aria-label="Copy ${esc(d.name)}"></td><th scope="row"><label for="offer-${i}">${esc(d.name)}</label><small>${esc(d.client.business || "No client name")} · saved here ${esc(d.updatedAt)}</small></th><td class="small">${esc(outcome)}${why ? `<br><span class="warn">Unfinished: arrives as a draft (${esc(why)})</span>` : ""}</td></tr>`;
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
</div><div class="out" id="out">${safe(dealOut)}</div></div>`;
}
function sharedLinksCard() {
  const d = deal(); const link = state.links.get(d.id); const by = state.by.get(d.id);
  const unsaved = !state.revs.get(d.id); const draft = invalid.has(d.id);
  return card("Links", `<p class="small muted">${by ? `Last saved by ${esc(ownerName(by.who))}, ${esc(clock(by.at))}.` : "Not saved yet."} This workbook holds pricing and draft documents; the CRM deal stays the record of the sale.</p>
<div class="grid"><div class="field wide"><label for="crm-ref">CRM deal (crm:deal:…)</label><input id="crm-ref" value="${esc(link?.crm ?? "")}" placeholder="crm:deal:" autocomplete="off"></div></div>
<div class="actions"><button class="ghost small" data-action="crm-link" ${unsaved ? "disabled" : ""}>Save CRM link</button></div>
<div class="grid"><div class="field"><label for="lead-id">Lead number</label><input id="lead-id" inputmode="numeric" value="${esc(link?.leadId ?? "")}" autocomplete="off"></div></div>
<div class="actions"><button class="ghost small" data-action="lead-attach" ${unsaved || draft ? "disabled" : ""}>Add the quote and agreement to this lead's drafts</button></div>
${draft ? `<p class="small warn">Finish the unfinished changes before adding documents to a lead.</p>` : ""}${link?.leadId ? `<p class="small ok">Documents added to lead ${esc(link.leadId)}.</p>` : ""}`);
}
function dealOut() {
  const d = deal(); const parts: string[] = [];
  if (d.include.website) {
    const w = calculateWebsite(d.website);
    parts.push(card("Website (one-off)", `<div class="stats">${stat("Price incl. GST", aud(w.oneOff.totalInclGstCents))}${stat("Gross profit", aud(w.oneOff.grossProfitCents), cls(w.oneOff.grossProfitCents), pctText(w.oneOff.marginBps))}${stat("Per founder hour", aud(w.oneOff.effectiveHourlyCents))}</div>`));
    if (w.recurring.enabled) parts.push(card("Care plan (monthly)", `<div class="stats">${stat("Fee incl. GST", aud(w.recurring.inclGstCents))}${stat("Profit / month", aud(w.recurring.profitCents), cls(w.recurring.profitCents), pctText(w.recurring.marginBps))}${stat(`${w.horizon.months}-month total`, aud(w.horizon.recurringProfitCents), cls(w.horizon.recurringProfitCents))}</div>`));
  }
  if (d.include.receptionist) {
    const r = calculateRxDeal(d.rx); const e = r.columns.find((c) => c.id === "expected")!;
    parts.push(card(`Receptionist · ${esc(getReceptionistPackage(d.rx.packageId).shortName)} (monthly, expected use)`, `<div class="stats">${stat("Invoice incl. GST", aud(e.invoice.inclGstCents))}${stat("Operating profit", aud(e.operatingCents), cls(e.operatingCents), pctText(e.operatingMarginBps))}${stat(`${r.term.months}-month term`, aud(r.term.operatingCents), cls(r.term.operatingCents), "after onboarding")}</div>`));
  }
  if (!parts.length) parts.push(card("Nothing selected", `<p class="muted">Tick a website project, an AI receptionist, or both.</p>`));
  return parts.join("") + compareTable();
}
function compareTable() {
  const rows = state.deals.map((d) => {
    let web = "—", care = "—", rx = "—";
    try {
      if (d.include.website) { const w = calculateWebsite(d.website); web = `${aud(w.oneOff.grossProfitCents)} <small>${pctText(w.oneOff.marginBps)}</small>`; if (w.recurring.enabled) care = `${aud(w.recurring.profitCents)} <small>/mo</small>`; }
      if (d.include.receptionist) { const r = calculateRxDeal(d.rx); const e = r.columns.find((c) => c.id === "expected")!; rx = `${aud(e.operatingCents)} <small>/mo · ${pctText(e.operatingMarginBps)}</small>`; }
    } catch { web = "Check inputs"; }
    return `<tr class="${d.id === state.currentId ? "current" : ""}"><th scope="row"><button class="link" data-action="open" data-id="${esc(d.id)}">${esc(d.name)}</button></th><td>${web}</td><td>${care}</td><td>${rx}</td></tr>`;
  }).join("");
  return card("Compare saved deals", `<div class="tablewrap"><table><thead><tr><th>Deal</th><th>Build profit</th><th>Care plan</th><th>Receptionist (expected)</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function websiteTab() {
  const d = deal(); const w = d.website;
  const effort = (Object.keys(EFFORT_LABELS) as EffortKey[]).map((k) => field(`website.effortMinutes.${k}`, EFFORT_LABELS[k], "hours", { suffix: "h" })).join("");
  const costs = w.costs.map((c, i) => `<div class="row-edit"><div class="grid">${field(`website.costs.${i}.label`, "Cost", "text", { wide: true })}${field(`website.costs.${i}.cents`, `Amount (${c.currency})`, "money?", { prefix: c.currency === "USD" ? "US$" : "A$" })}${select(`website.costs.${i}.currency`, "Currency", [["AUD", "AUD"], ["USD", "USD"]])}${select(`website.costs.${i}.frequency`, "When", [["one-off", "One-off (build)"], ["monthly", "Monthly (care plan)"]])}${field(`website.costs.${i}.sharedAcross`, "Shared across sites", "int")}</div><small class="hint">${esc(c.evidence === "public-list" ? `Public list price, checked ${c.checkedAt}` : c.cents === null ? "Unknown: excluded from totals" : "Entered: an assumption")}${c.note ? ` · ${esc(c.note)}` : ""}</small><button class="ghost small" data-action="remove-cost" data-i="${i}">Remove</button></div>`).join("");
  const stages = w.stages.map((s, i) => `<div class="row-edit"><div class="grid">${field(`website.stages.${i}.label`, "Stage", "text")}${field(`website.stages.${i}.shareBps`, "Share", "pct", { suffix: "%" })}${field(`website.stages.${i}.trigger`, "When it's due", "text", { wide: true })}</div>${w.stages.length > 1 ? `<button class="ghost small" data-action="remove-stage" data-i="${i}">Remove</button>` : ""}</div>`).join("");
  const presetIdx = PAYMENT_PRESETS.findIndex((p) => p.percentBps === w.payment.percentBps && p.fixedCents === w.payment.fixedCents);
  return `<div class="cols"><div class="form">
${card("Price", `<div class="grid">${select("website.kind", "Project", [["build", "New website"], ["redesign", "Redesign"]])}${field("website.price.cents", "Quoted price", "money", { prefix: "A$" })}${select("website.price.gst", "Price is", [["inclusive", "Incl. GST"], ["exclusive", "Ex GST"]])}
${select("website.discount.type", "Discount", [["none", "None"], ["percent", "Percent"], ["fixed", "Fixed amount"]], "select", "discount")}
${w.discount.type === "percent" ? field("website.discount.bps", "Discount", "pct", { suffix: "%" }) : w.discount.type === "fixed" ? field("website.discount.cents", "Discount (ex GST)", "money", { prefix: "A$" }) : ""}</div>
<p class="muted small">Owner-confirmed offer: A$1,650 incl. GST, 50% deposit, 50% at approved launch, A$110/month care. Any other figure is a scenario.</p>`)}
${card("Design, build and content effort", `<p class="muted small">Hours are placeholders, not measured. Replace them with your own estimate for this project.</p><div class="grid">${select("website.cmsComplexity", "CMS complexity", (Object.keys(CMS_PRESETS) as CmsComplexity[]).map((k) => [k, CMS_PRESETS[k].label]), "select", "cms")}${field("website.labourHourlyCents", "Founder hour valued at", "money", { prefix: "A$", hint: "Assumption (A$60 in the economics model)" })}${effort}</div>`)}
${card("Revisions", `<div class="grid">${field("website.revisions.includedRounds", "Included rounds", "int")}${field("website.revisions.minutesPerRound", "Hours per round", "hours", { suffix: "h" })}${field("website.revisions.expectedExtraRounds", "Extra rounds expected", "int")}${field("website.revisions.extraRoundFeeCents", "Fee per extra round (ex GST)", "money?", { prefix: "A$", placeholder: "Not charged" })}</div>`)}
${card("Hosting, software and third-party costs", `${costs}<button class="ghost" data-action="add-cost">Add a cost</button><div class="grid" style="margin-top:12px">${field("website.fx.usdPerAudMillionths", "US$ per A$1 (for USD costs)", "rate6", { hint: "RBA reference rate" })}${field("website.fx.date", "Rate date", "date")}${field("website.fx.cardFeeBps", "Card FX buffer", "pct", { suffix: "%" })}</div><p class="muted small">Leave an amount blank when it isn't known: it stays unknown and is listed, never counted as zero.</p>`)}
${card("Contingency and target", `<div class="grid">${field("website.contingencyBps", "Contingency on hours and costs", "pct", { suffix: "%" })}${field("website.targetMarginBps", "Target build margin", "pct", { suffix: "%", hint: "Planning target, not an approved policy" })}</div>`)}
${card("Payment stages", `${stages}<button class="ghost" data-action="add-stage">Add a stage</button><div class="grid">${`<div class="field"><label for="pay-preset">How the client pays</label><select id="pay-preset" data-action-change="payment-preset">${PAYMENT_PRESETS.map((p, i) => `<option value="${i}" ${i === presetIdx ? "selected" : ""}>${esc(p.label)}</option>`).join("")}${presetIdx < 0 ? `<option selected>Custom</option>` : ""}</select></div>`}${field("website.payment.percentBps", "Fee %", "pct", { suffix: "%" })}${field("website.payment.fixedCents", "Fixed fee", "money", { prefix: "A$" })}</div>`)}
${card("Care plan (ongoing)", `<div class="grid">${field("website.care.enabled", "Include a monthly care plan", "bool")}${field("website.care.monthly.cents", "Monthly fee", "money", { prefix: "A$" })}${select("website.care.monthly.gst", "Fee is", [["inclusive", "Incl. GST"], ["exclusive", "Ex GST"]])}${field("website.care.maintenanceMinutes", "Maintenance per month", "hours", { suffix: "h" })}${field("website.care.includedChangeMinutes", "Changes included", "hours", { suffix: "h" })}${field("website.care.expectedChangeMinutes", "Changes expected", "hours", { suffix: "h" })}${field("website.care.termMonths", "Months to compare", "int")}</div>`)}
</div><div class="out" id="out">${safe(websiteOut)}</div></div>`;
}
function bar(parts: { label: string; cents: number; tone: string }[], total: number) {
  if (total <= 0) return "";
  return `<div class="bar" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${aud(p.cents)}`).join(", "))}">${parts.filter((p) => p.cents > 0).map((p) => `<span class="${p.tone}" style="width:${Math.max(1, p.cents / total * 100).toFixed(2)}%" title="${esc(p.label)} ${esc(aud(p.cents))}"></span>`).join("")}</div>
<ul class="legend">${parts.map((p) => `<li><i class="${p.tone}"></i>${esc(p.label)} <b>${aud(p.cents)}</b></li>`).join("")}</ul>`;
}
function websiteOut() {
  const w = calculateWebsite(deal().website); const o = w.oneOff; const r = w.recurring; const p = o.pricing;
  const breakdown = bar([
    { label: "Labour", cents: o.labourCents, tone: "c1" }, { label: "Contingency", cents: o.contingencyCents, tone: "c2" },
    { label: "Third-party", cents: o.thirdPartyCents, tone: "c3" }, { label: "Payment fees", cents: o.paymentCostCents, tone: "c4" },
    { label: o.grossProfitCents >= 0 ? "Gross profit" : "Loss", cents: Math.abs(o.grossProfitCents), tone: o.grossProfitCents >= 0 ? "gold" : "loss" },
  ], Math.max(o.revenueExGstCents, o.deliveryCostCents));
  return `${card("One-off project", `<div class="stats">${stat("Price ex GST", aud(o.priceExGstCents), "", o.discountCents ? `after ${aud(o.discountCents)} discount` : "")}${stat("GST", aud(o.gstCents))}${stat("Total incl. GST", aud(o.totalInclGstCents))}</div>
<div class="stats">${stat("Delivery cost", aud(o.deliveryCostCents), "", `${hoursText(o.minutes)} + ${hoursText(o.contingencyMinutes)} contingency`)}${stat("Gross profit", aud(o.grossProfitCents), cls(o.grossProfitCents), `${pctText(o.marginBps)} margin`)}${stat("Effective hourly", aud(o.effectiveHourlyCents), cls((o.effectiveHourlyCents ?? 0) - deal().website.labourHourlyCents), `${aud(o.effectiveHourlyWithContingencyCents)} if contingency is used`)}</div>${breakdown}
<p class="callout">${p.breakEvenMinutes === null ? "Enter an hourly rate to see break-even hours." : `This price carries <b>${hoursText(p.breakEvenMinutes)}</b> of planned founder time (plus the ${pctText(deal().website.contingencyBps, 0)} contingency) before the build loses money. Planned now: <b>${hoursText(o.minutes)}</b>.`} ${p.priceForTargetExGstCents === null ? "" : `For a ${pctText(p.targetMarginBps, 0)} margin on these hours the price would be <b>${aud(p.priceForTargetExGstCents)}</b> ex GST.`}</p>`)}
${card("Payment stages", `<div class="tablewrap"><table><thead><tr><th>Stage</th><th>Ex GST</th><th>GST</th><th>Incl. GST</th></tr></thead><tbody>${o.stages.map((s) => `<tr><th scope="row">${esc(s.label)} <small>${s.shareBps / 100}% · ${esc(s.trigger)}</small></th><td>${aud(s.exGstCents)}</td><td>${aud(s.gstCents)}</td><td>${aud(s.inclGstCents)}</td></tr>`).join("")}</tbody><tfoot><tr><th>Total</th><td>${aud(o.priceExGstCents)}</td><td>${aud(o.gstCents)}</td><td>${aud(o.totalInclGstCents)}</td></tr></tfoot></table></div>`)}
${r.enabled ? card("Care plan (monthly, separate from the build)", `<div class="stats">${stat("Revenue ex GST", aud(r.revenueExGstCents))}${stat("Cost", aud(r.costCents), "", `${hoursText(r.minutes)} + hosting ${aud(r.thirdPartyCents)}`)}${stat("Profit / month", aud(r.profitCents), cls(r.profitCents), pctText(r.marginBps))}</div>
<p class="muted small">Over ${w.horizon.months} months: ${aud(w.horizon.recurringProfitCents)} care-plan profit. ${w.horizon.monthsToRecoverBuildLoss === 0 ? "" : w.horizon.monthsToRecoverBuildLoss === null ? "The care plan never recovers the build loss." : `It takes ${w.horizon.monthsToRecoverBuildLoss} months of care plan to recover the build loss.`}${r.changeMinutesOverIncluded ? ` Expected changes exceed the included time by ${hoursText(r.changeMinutesOverIncluded)}.` : ""}</p>`) : ""}
${unknownList(w.unknownCosts)}${flagList(w.approval.unapproved)}`;
}

function rxTab() {
  const d = deal(); const rx = d.rx; const pkg = getReceptionistPackage(rx.packageId);
  const status = priceStatusLines(pkg);
  const pkgCards = RECEPTIONIST_PACKAGES.map((p) => `<button class="pkg ${p.id === rx.packageId ? "on" : ""}" data-action="package" data-id="${p.id}" aria-pressed="${p.id === rx.packageId}"><b>${esc(p.shortName)}</b><span>${aud(p.pricing.monthly.cents)}/mo ex GST</span><small>${p.pricing.includedMinutes.toLocaleString("en-AU")} min · ${aud(p.pricing.overagePerMinute.cents)}/extra min</small></button>`).join("");
  const cols = (Object.keys(RX_COLUMN_LABELS) as RxColumnId[]);
  const grid = `<div class="tablewrap"><table class="inputs"><thead><tr><th></th>${cols.map((c) => `<th>${RX_COLUMN_LABELS[c]}</th>`).join("")}</tr></thead><tbody>
<tr><th scope="row">Billable time <small>min or min:sec</small></th>${cols.map((c) => `<td>${miniInput(`rx.columns.${c}.billableSeconds`, "dur")}</td>`).join("")}</tr>
<tr><th scope="row">SMS segments</th>${cols.map((c) => `<td>${miniInput(`rx.columns.${c}.smsSegments`, "int")}</td>`).join("")}</tr>
<tr><th scope="row">Support time <small>min / month</small></th>${cols.map((c) => `<td>${miniInput(`rx.columns.${c}.supportMinutes`, "int")}</td>`).join("")}</tr></tbody></table></div>`;
  const unknownRates = DEFAULT_COST_RATES.filter((r) => r.micros === null);
  const voiceIdx = RX_VOICE_PRESETS.findIndex((v) => v.micros === rx.voiceMicros);
  return `<div class="cols"><div class="form">
${card("Package", `<div class="pkgs">${pkgCards}</div><p class="small ok">${esc(status.monthly.text)}</p><p class="small warn">${esc(status.setup.text)} · ${esc(status.pilot.text)}</p><button class="ghost small" data-action="reset-usage">Reset usage to catalogue scenarios</button>`)}
${card("Monthly usage per scenario", `${grid}<p class="muted small">Billing counts connected seconds over the month, drops calls under ${pkg.pricing.billing.minimumBillableSeconds} s, and rounds up to a whole minute once. Enter 1000:01 for 1,000 minutes and 1 second.</p>`)}
${card("Voice, telephony and platform", `<div class="grid"><div class="field wide"><label for="voice-preset">Voice platform rate</label><select id="voice-preset" data-action-change="voice-preset">${RX_VOICE_PRESETS.map((v, i) => `<option value="${i}" ${i === voiceIdx ? "selected" : ""}>${esc(v.label)} · US$${(v.micros / 1e6).toFixed(4)}/min</option>`).join("")}${voiceIdx < 0 ? `<option selected>Custom</option>` : ""}</select></div>
${field("rx.voiceMicros", "Voice US$ per minute", "rate6", { prefix: "US$", hint: "Retell list estimate; not a measured rate" })}${field("rx.avgCallSeconds", "Average call length", "int", { suffix: "s" })}${field("rx.shortCallShareBps", "Hang-ups / short calls", "pct", { suffix: "%", hint: "Cost to M&U, never billed" })}${field("rx.webhookEventsPerCall", "Webhook events per call", "int")}${field("rx.clientsSharingPlatform", "Clients sharing hosting", "int", { hint: "1 = this client carries all of it" })}</div>`)}
${card("Costs not yet known", `<div class="grid">${unknownRates.map((r) => field(`rx.rateOverrides.${r.id}`, `${r.label} (${r.currency} per ${r.basis.replace("-", " ")})`, "rate6?", { prefix: r.currency === "USD" ? "US$" : "A$", placeholder: "Unknown", wide: true })).join("")}</div><p class="muted small">Blank stays unknown and is listed, never zero. Anything entered here is an assumption, not a provider charge.</p>`)}
${card("Currency, labour and payments", `<div class="grid">${field("rx.fx.usdPerAudMillionths", "US$ per A$1", "rate6", { hint: "RBA reference rate" })}${field("rx.fx.date", "Rate date", "date")}${field("rx.fx.cardFeeBps", "Card FX buffer", "pct", { suffix: "%" })}${field("rx.labourHourlyCents", "Founder hour valued at", "money", { prefix: "A$" })}${field("rx.onboardingMinutes", "Onboarding effort", "hours", { suffix: "h" })}${field("rx.payment.percentBps", "Payment fee", "pct", { suffix: "%", hint: "Stripe card 1.7% + Billing 0.7%" })}${field("rx.payment.fixedCents", "Fixed fee per charge", "money", { prefix: "A$" })}</div>`)}
${card("Commercial terms", `<div class="grid">${field("rx.termMonths", "Term (months)", "int")}${field("rx.monthlyDiscountBps", "Monthly discount", "pct", { suffix: "%", hint: "Not an approved term" })}${field("rx.setupFeeCents", "Setup fee (ex GST)", "money?", { prefix: "A$", placeholder: "Quoted separately", hint: "Setup fees are NOT approved. Leave blank." })}</div>`)}
</div><div class="out" id="out">${safe(rxOut)}</div></div>`;
}
function miniInput(path: string, kind: Kind) {
  const [, , col, key] = path.split(".");
  const what = key === "billableSeconds" ? "billable time" : key === "smsSegments" ? "SMS segments" : "support minutes";
  return `<input aria-label="${esc(`${RX_COLUMN_LABELS[col as RxColumnId]}: ${what}`)}" data-bind="${path}" data-kind="${kind}" value="${esc(display(kind, getPath(deal(), path)))}" inputmode="decimal" autocomplete="off"><small class="err" data-err-for="${path}"></small>`;
}
function rxOut() {
  const d = deal(); const r = calculateRxDeal(d.rx); const b = r.breakEven; const pkg = getReceptionistPackage(d.rx.packageId);
  const row = (label: string, f: (c: typeof r.columns[number]) => string, strong = false) => `<tr${strong ? ` class="strong"` : ""}><th scope="row">${label}</th>${r.columns.map((c) => `<td>${f(c)}</td>`).join("")}</tr>`;
  const cost = (c: typeof r.columns[number], ids: string[]) => aud(c.costLines.filter((l) => ids.includes(l.id)).reduce((n, l) => n + l.cents, 0));
  const table = `<div class="tablewrap"><table><thead><tr><th>Per month</th>${r.columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>
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
  const usd = (m: number | null) => m === null ? "above US$5.00" : `US$${(m / 1e6).toFixed(4)}`;
  const be = `<ul class="plain">
<li>${b.unprofitableFromMinutes === null ? `<b>Stays profitable</b> up to ${b.searchedUpToMinutes.toLocaleString("en-AU")} minutes a month (overage charged).` : `<b>Loses money from ${b.unprofitableFromMinutes.toLocaleString("en-AU")} minutes</b> a month${b.recoversAtMinutes ? `, recovering at ${b.recoversAtMinutes.toLocaleString("en-AU")} minutes as overage builds` : ""}.`}</li>
<li>If extra minutes were <i>not</i> charged, it would lose money from ${b.unprofitableFromMinutesWithoutOverage === null ? "beyond the searched range" : `<b>${b.unprofitableFromMinutesWithoutOverage.toLocaleString("en-AU")} minutes</b>`}.</li>
<li>At full allowance it stays profitable while voice costs at most <b>${usd(b.maxVoiceUsdMicrosAtFullAllowance)}</b>/min (entered: US$${(d.rx.voiceMicros / 1e6).toFixed(4)}).</li>
<li>Each extra minute earns ${aud(b.overage.priceExGstCents)} ex GST and costs about A$${(b.overage.costPerMinuteCents / 100).toFixed(3)}${b.overage.profitable ? "" : ": <b>below cost</b>"}.</li>
<li>Support could rise to <b>${b.maxSupportMinutesAtExpected === null ? "n/a" : hoursText(b.maxSupportMinutesAtExpected)}</b> a month at expected use before it loses money.</li>
<li>Largest monthly discount before a loss: ${Math.floor(b.maxDiscountBpsAtExpected / 100)}% at expected use, ${Math.floor(b.maxDiscountBpsAtFullAllowance / 100)}% at full allowance (rounded down).</li></ul>`;
  const s = r.setup;
  return `${card(`${esc(pkg.name)}: low, expected, full and over`, table)}
${card("Where it stops being profitable", be)}
${card("Setup and term", `<div class="stats">${stat("Onboarding cost", aud(s.onboardingLabourCents), "", `${hoursText(d.rx.onboardingMinutes)} at ${aud(d.rx.labourHourlyCents)}/h`)}${stat("Setup fee", s.feeExGstCents === null ? "Quoted separately" : aud(s.feeExGstCents), s.feeExGstCents === null ? "" : "warnbox", s.feeStatus)}${stat(`${r.term.months}-month operating`, aud(r.term.operatingCents), cls(r.term.operatingCents), s.monthsToRecover === null ? "never recovers onboarding" : `onboarding recovered in ${s.monthsToRecover} month${s.monthsToRecover === 1 ? "" : "s"}`)}</div>`)}
${unknownList(r.unknownCosts)}${flagList(r.unapproved.map((u) => u.text))}
<p class="muted small">Estimates from public list rates re-read ${ECONOMICS_AS_OF}. Nothing here is a measured or invoiced cost. ${esc(REVIEW_TRIGGER)}</p>`;
}

function quoteTab() {
  return `<div class="cols quote"><div class="form">
${card("Quote details", `<div class="grid">${field("quote.number", "Quote number", "text")}${field("quote.preparedOn", "Prepared on", "date")}${field("quote.validDays", "Valid for (days)", "int")}${field("quote.preparedBy", "Prepared by", "text", { wide: true })}${field("quote.projectTitle", "Title", "text", { wide: true })}${field("quote.summary", "Summary", "text", { wide: true })}${field("quote.usageIllustration", "Show an illustrative receptionist month (expected usage)", "bool", { wide: true })}</div>`)}
${card("Scope and terms", `${area("quote.scope", "Scope", "One item per line")}${area("quote.deliverables", "Deliverables")}${area("quote.exclusions", "Not included")}${area("quote.timeline", "Timeline")}${area("quote.responsibilities", "Ongoing costs and responsibilities")}${area("quote.notes", "Notes")}
<p class="small ${deal().quote.customText ? "warn" : "muted"}" id="text-mode">${deal().quote.customText ? "Edited by hand: this text is kept as written, and the agreement carries it in Appendix A." : "Generated from the scenario and kept up to date automatically. Editing any box keeps your wording."}</p>
<button class="ghost" data-action="refill">Rewrite text from the scenario</button>`)}
</div><div class="out" id="out">${safe(quoteOut)}</div></div>`;
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
<div class="actions"><button data-action="print-agreement" data-export disabled>Print or save as PDF</button><button class="ghost" data-action="dl-agreement" data-export disabled>Download HTML</button></div><p id="fit" class="small muted">Preparing the preview…</p>${agreementPlan(deal()).appendix ? `<p class="small muted">Appendix A is added because of: ${esc(agreementPlan(deal()).reasons.join("; "))}. Nothing is shortened to make it fit.</p>` : ""}`)}
<iframe class="preview agreement" title="Agreement preview" id="agreement-frame"></iframe></div>`;
}
function refreshAgreementFrame() {
  const frame = document.getElementById("agreement-frame") as HTMLIFrameElement | null; if (!frame) return;
  state.agreementChecked = false;
  frame.onload = () => {
    state.agreementChecked = true;
    let pages = 0;
    try { pages = Number((frame.contentWindow as any).eval(AGREEMENT_PAGES_EXPRESSION)) || 0; } catch { pages = 0; }
    state.agreementOver = [];
    const fit = document.getElementById("fit");
    const appendix = agreementPlan(deal()).appendix;
    if (fit) { fit.className = "small ok"; fit.textContent = `About ${pages} A4 page${pages === 1 ? "" : "s"}${appendix ? ", including Appendix A" : ""}. Longer content flows onto extra pages; nothing is cut or shrunk.`; }
    document.querySelectorAll<HTMLButtonElement>("[data-export]").forEach((b) => { b.disabled = false; });
  };
  try { frame.srcdoc = renderAgreementHtml(deal()); }
  catch (e) { state.agreementOver = [1]; frame.onload = null; frame.srcdoc = `<p style="font:16px system-ui;padding:24px">Can't prepare the agreement yet: ${esc((e as Error).message)}</p>`; const fit = document.getElementById("fit"); if (fit) { fit.className = "small neg"; fit.textContent = `Export is blocked: ${(e as Error).message}`; } }
}
function checksTab() {
  const d = deal(); const findings = auditDeal(d, today());
  const failed = findings.filter((f) => !f.pass);
  const summary = `${findings.length} checks · ${failed.filter((f) => f.severity === "critical").length} critical · ${failed.filter((f) => f.severity === "warning").length} warnings · ${failed.filter((f) => f.severity === "info").length} notes`;
  const rates = costEvidenceTable();
  return `<div class="single">
${card("Model checks", `<p><b>${summary}</b></p><div class="tablewrap"><table><thead><tr><th>Result</th><th>Area</th><th>Check</th><th>Detail</th></tr></thead><tbody>${findings.map((f) => `<tr><td><span class="badge ${f.pass ? "pass" : f.severity}">${f.pass ? "Pass" : f.severity === "critical" ? "Critical" : f.severity === "warning" ? "Warning" : "Note"}</span></td><td>${esc(f.area)}</td><td>${esc(f.check)}</td><td class="small">${esc(f.detail)}</td></tr>`).join("")}</tbody></table></div>`)}
${card("Cost sources (receptionist)", `<div class="tablewrap"><table><thead><tr><th>Cost</th><th>Estimate</th><th>Evidence</th><th>Checked</th><th>Measured</th><th>Invoice</th></tr></thead><tbody>${rates.map((r) => `<tr><th scope="row">${esc(r.label)}${r.source ? `<small><a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(r.source.replace(/^https:\/\/(www\.)?/, ""))}</a></small>` : ""}</th><td>${r.estimatedMicros === null ? "<b>Unknown</b>" : `${r.currency === "USD" ? "US$" : "A$"}${(r.estimatedMicros / 1e6).toFixed(4)} / ${esc(r.basis)}`}</td><td>${esc(r.estimateEvidence)}</td><td>${esc(r.checkedAt)}</td><td class="small">Not measured</td><td class="small">Not reconciled</td></tr>`).join("")}
<tr><th scope="row">Stripe card + Billing<small><a href="${RATE_SOURCES.stripe}" target="_blank" rel="noopener">stripe.com/au/pricing</a></small></th><td>1.7% + 0.7% + A$0.30</td><td>public-list (card verified on Stripe's page)</td><td>2026-09-28</td><td class="small">Not measured</td><td class="small">Not reconciled</td></tr>
<tr><th scope="row">USD conversion<small><a href="${RATE_SOURCES.rba}" target="_blank" rel="noopener">RBA</a></small></th><td>US$${(d.rx.fx.usdPerAudMillionths / 1e6).toFixed(4)} per A$1 + ${d.rx.fx.cardFeeBps / 100}% buffer</td><td>reference rate</td><td>${esc(d.rx.fx.date)}</td><td class="small">—</td><td class="small">—</td></tr>
</tbody></table></div><p class="muted small">Every provider figure is a public list price or an assumption. The one dashboard reading (about A$0.17/min over two calls, 26 Sep) is too small to count as measured.</p>`)}
${card("Approved figures used", `<ul class="plain"><li>Receptionist: Essential A$699 / 400 min / A$0.80; Professional A$1,099 / 1,000 min / A$0.75; Premium A$1,999 / 1,800 min / A$0.70, ex GST, approved 28 Sep 2026 (package catalogue 2026-09-27).</li><li>Billing: per second, summed per month, rounded up once; calls under 5 s, demo calls and transfer minutes not billed; 10% GST added per line.</li><li>Website: A$1,650 incl. GST, 50% deposit, 50% at approved launch, A$110/month care (owner-confirmed offer and first signed client).</li><li>Not approved: setup fees (A$990 / A$1,490 / A$2,490 were proposals), pilot terms, discounts, billing in advance vs arrears, mid-month proration.</li></ul>`)}
</div>`;
}

// ── render and events ───────────────────────────────────────────────────────────────────────────────────
const app = document.getElementById("app")!;
/** A stable key for the focused control, so a re-render does not drop keyboard focus to the page. */
function focusKey(el: Element | null): string | null {
  if (!(el instanceof HTMLElement) || !app.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const d = el.dataset;
  if (d.action) return `[data-action="${d.action}"]${d.tab ? `[data-tab="${d.tab}"]` : ""}${d.id ? `[data-id="${CSS.escape(d.id)}"]` : ""}${d.i ? `[data-i="${d.i}"]` : ""}`;
  if (d.bind) return `[data-bind="${CSS.escape(d.bind)}"]`;
  return null;
}
function render() {
  const keep = focusKey(document.activeElement);
  renderNow();
  if (keep) (app.querySelector(keep) as HTMLElement | null)?.focus();
}
function renderNow() {
  const d = deal();
  const body = state.tab === "deal" ? dealTab() : state.tab === "website" ? websiteTab() : state.tab === "receptionist" ? rxTab() : state.tab === "quote" ? quoteTab() : state.tab === "agreement" ? agreementTab() : checksTab();
  app.innerHTML = `<header class="top">${location.pathname.startsWith("/deal-desk") ? `<a class="back" href="/operations">← Operations</a>` : ""}<div class="brand">M<b>&amp;</b>U <span>Deal desk</span></div>
<div class="dealbar"><label class="sr" for="deal-select">Open a saved deal</label><select id="deal-select" data-action-change="open">${state.deals.map((x) => `<option value="${esc(x.id)}" ${x.id === d.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
<button class="ghost small" data-action="new">New</button><button class="ghost small" data-action="duplicate">Duplicate</button><button class="ghost small" data-action="delete">Delete</button>
<details class="menu"><summary class="ghost small">Export / import</summary><div><button data-action="export-json">Export all deals (JSON)</button><button data-action="export-csv">Scenario comparison (CSV)</button><label class="filebtn">Import deals (JSON)<input type="file" accept="application/json,.json" data-action-change="import"></label><button data-action="reset-seeds">Restore synthetic examples</button></div></details></div>
<div class="status" id="status">${d.synthetic ? `<span class="tag">Synthetic example</span>` : ""}<span class="${state.save === "ok" ? "" : "neg"}">${esc(saveText())}</span></div></header>
${state.locked ? `<div class="conflict"><span>The deals saved in this browser could not be read. They are left exactly as they are and saving is off; the examples below are not saved.</span><button class="small" data-action="export-raw">Download the saved data</button></div>` : ""}
${state.quarantined.length ? `<div class="conflict"><span>${state.quarantined.length} saved deal${state.quarantined.length === 1 ? "" : "s"} could not be opened. ${state.quarantined.length === 1 ? "It is" : "They are"} kept untouched and still saved.</span><button class="ghost small" data-action="export-quarantine">Download ${state.quarantined.length === 1 ? "it" : "them"}</button></div>` : ""}
${state.mode === "shared" && state.conflict ? `<div class="conflict"><span>${state.conflict.current ? `${esc(ownerName(state.conflict.current.updatedBy))} saved a newer version of this workbook (${esc(clock(state.conflict.current.updatedAt))}). Your edit was not saved and theirs was not overwritten.` : "Someone else saved a newer version of this workbook."}</span><button class="small" data-action="shared-theirs">Load their version</button><button class="ghost small" data-action="shared-mine-copy">Keep mine as a separate copy</button></div>` : ""}
${state.mode === "shared" && state.withheld ? `<div class="conflict"><span>Confirm this browser in System › Devices and people to read quotes. Changes here aren't saved until then.</span></div>` : state.mode === "shared" && state.readOnly ? `<div class="conflict"><span>You can look at the shared deals, but this browser isn't confirmed yet, so nothing you change here is saved. Confirm it in System › Devices and people, then reload this page.</span></div>` : ""}
${state.mode === "shared" && !state.readOnly && state.localOffer.length ? `<div class="conflict offer"><span>${state.localOffer.length} deal${state.localOffer.length === 1 ? " is" : "s are"} saved only in this browser.</span><button class="small" data-action="offer-open">Review and copy to the shared workspace</button></div>` : ""}
${state.mode === "shared" && state.offerOpen ? offerPanel() : ""}
<div class="conflict" id="conflict" ${state.save === "conflict" && state.mode === "local" ? "" : "hidden"}><span>These deals were changed in another tab, so this tab has stopped saving.</span><button class="small" data-action="conflict-latest">Load the latest</button><button class="ghost small" data-action="conflict-copy">Keep this deal as a copy, then load the latest</button></div>
<nav class="tabs" role="tablist">${TABS.map((t) => `<button role="tab" aria-selected="${t.id === state.tab}" data-action="tab" data-tab="${t.id}">${t.label}</button>`).join("")}</nav>
<main>${body}</main>`;
  if (state.tab === "quote") refreshQuoteFrame();
  if (state.tab === "agreement") refreshAgreementFrame();
}
const cantCalc = (e: unknown) => card("Can't calculate yet", `<p class="warn">${esc((e as Error).message)}</p><p class="muted small">Your unfinished changes are kept as a draft and the last complete version is unchanged. Nothing can be exported until this calculates (for example, until the stages add up to 100%).</p>`);
/** A panel that cannot be calculated shows why instead of breaking the page. */
const safe = (panel: () => string) => { try { return panel(); } catch (e) { return cantCalc(e); } };
function refreshOut() {
  const out = document.getElementById("out"); if (!out) return;
  try {
    out.innerHTML = state.tab === "deal" ? dealOut() : state.tab === "website" ? websiteOut() : state.tab === "receptionist" ? rxOut() : state.tab === "quote" ? quoteOut() : "";
    if (state.tab === "quote") refreshQuoteFrame();
  } catch (e) { out.innerHTML = cantCalc(e); }
}
function refreshQuoteFrame() {
  const frame = document.getElementById("quote-frame") as HTMLIFrameElement | null;
  if (frame) { try { frame.srcdoc = renderQuoteHtml(buildQuote(deal()), true); } catch (e) { frame.srcdoc = `<p style="font:16px system-ui;padding:24px">Can't prepare the quote yet: ${esc((e as Error).message)}</p>`; } }
}
let saveTimer = 0;
/** The content of a deal, ignoring the date stamp: used to tell an edit from a look. */
const contentOf = (d: Deal) => JSON.stringify({ ...d, updatedAt: "" });
/** What the server (or this browser's storage) last held for each deal. */
const savedContent = new Map<string, string>();
/** Opening a deal or switching tab is a view, not an edit: it never writes a shared workbook. */
function persistView() {
  if (state.mode === "shared") return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { state.save = store.write(); if (state.save === "ok" && invalid.size) state.save = "invalid"; showSaveState(); }, 250);
}
function persist() {
  if (state.readOnly) { state.save = "readonly"; showSaveState(); return; }
  // Nothing changed in this deal: nothing to save (no new revision, no change of "last saved by").
  if (state.mode === "shared" && savedContent.get(deal().id) === contentOf(deal())) return;
  deal().updatedAt = today();
  clearTimeout(saveTimer);
  // An unfinished edit (say, a payment schedule that does not add to 100% yet) is kept as a draft beside the last
  // complete version; it is never exported and never replaces that version.
  const why = validateDeal(deal());
  if (why) invalid.set(deal().id, why); else { invalid.delete(deal().id); lastValid.set(deal().id, structuredClone(deal())); }
  for (const id of [...invalid.keys()]) if (!state.deals.some((d) => d.id === id)) invalid.delete(id);
  state.invalidWhy = why ? `${deal().name}: ${why}` : "";
  dirty.add(deal().id);
  if (state.mode === "shared") { queueSharedSave(deal().id); return; }
  saveTimer = window.setTimeout(() => {
    state.save = store.write();
    if (state.save === "ok") dirty.clear();
    if (state.save === "ok" && invalid.size) state.save = "invalid";
    state.savedAt = fmtTime(new Date());
    showSaveState();
  }, 250);
}

// ── shared workbooks (only when served by the OS) ──
const clock = (iso: string) => (Number.isNaN(new Date(iso).getTime()) ? "" : fmtDateTime(iso));
const inFlight = new Set<string>(); const again = new Set<string>(); const sharedTimers = new Map<string, number>();
/** Deals edited in this tab since their last successful save (kept as copies if another founder's save wins). */
const dirty = new Set<string>();
/** The content of each workbook as this tab last sent it: a newer server copy equal to it is this tab's own save. */
const lastSent = new Map<string, string>();
function remember(rec: WorkbookRecord) { const w = rec.draft ?? rec.deal; if (w) savedContent.set(rec.id, contentOf(w)); state.revs.set(rec.id, rec.rev); state.by.set(rec.id, { who: rec.updatedBy, at: rec.updatedAt }); state.links.set(rec.id, { leadId: rec.leadId, crm: rec.crmDealRef }); }
function queueSharedSave(id: string) {
  clearTimeout(sharedTimers.get(id)); sharedTimers.set(id, window.setTimeout(() => { sharedTimers.delete(id); void saveShared(id); }, 600));
  state.save = "saving"; showSaveState();
}
/** One save per workbook at a time, each carrying the revision it was based on, so nothing is overwritten blind. */
async function saveShared(id: string) {
  if (inFlight.has(id)) { again.add(id); return; }
  const d = state.deals.find((x) => x.id === id); if (!d) return;
  inFlight.add(id);
  try {
    const sent = contentOf(d); lastSent.set(id, sent);
    const rec = await shared.save(d, state.revs.get(id) ?? 0);
    remember(rec); savedContent.set(id, sent); if (!again.has(id)) dirty.delete(id);
    state.save = rec.draft ? "invalid" : "ok"; if (rec.draft) state.invalidWhy = `${d.name}: ${rec.problem ?? "unfinished"}`;
    state.savedAt = fmtTime(new Date());
  } catch (e) {
    if (e instanceof ConflictError) { state.save = "conflict"; state.conflict = { id, current: e.current }; render(); }
    else { state.save = "failed"; state.note = (e as Error).message; } // the server's own reason, shown as it is
  } finally {
    inFlight.delete(id); showSaveState();
    if (again.delete(id) && state.save !== "conflict") void saveShared(id);
  }
}
async function loadShared() {
  const all = await shared.list();
  state.withheld = all.some((x) => x.withheld);
  // A browser that is not confirmed is told the quotes exist but is never sent their contents.
  const list = state.withheld ? [] : all.filter((x) => !x.archived);
  const deals: Deal[] = []; const damaged: unknown[] = [];
  for (const item of list) {
    const r = await shared.get(item.id);
    if ("raw" in r) { damaged.push({ id: r.id, error: r.error, raw: r.raw }); continue; }
    const working = r.draft ?? r.deal; if (!working) continue;
    remember(r); deals.push(working);
    if (r.draft) invalid.set(r.id, r.problem ?? "unfinished"); if (r.deal) lastValid.set(r.id, r.deal);
  }
  if (!deals.length) { const blank = blankDeal(today()); savedContent.set(blank.id, contentOf(blank)); deals.push(blank); }
  state.deals = deals; state.quarantined = damaged;
  state.locked = false; state.save = state.readOnly ? "readonly" : "ok";
  // Deals saved only in this browser are offered for copying, never moved or deleted.
  const local = store.read(); const done = transferred();
  state.localOffer = (local?.deals ?? []).filter((d) => !d.synthetic && !done.has(d.id));
}
/** Another founder's newer saves arrive when this tab is focused again (unless this tab has its own edit in flight). */
async function refreshShared() {
  if (state.mode !== "shared" || state.conflict || state.withheld) return;
  let list; try { list = await shared.list(); } catch { return; }
  let changed = false;
  for (const item of list) {
    if (item.status === "damaged") continue;
    const known = state.revs.get(item.id) ?? 0;
    if (item.archived) { if (state.deals.some((d) => d.id === item.id) && state.deals.length > 1) { state.deals = state.deals.filter((d) => d.id !== item.id); changed = true; } continue; }
    if ((item.rev ?? 0) > known) {
      const r = await shared.get(item.id); if ("raw" in r) continue;
      const incoming = contentOf((r.draft ?? r.deal)!);
      const decision = refreshDecision({ inFlight: inFlight.has(item.id), dirty: dirty.has(item.id), timerPending: sharedTimers.has(item.id), incoming, lastSent: lastSent.get(item.id) });
      if (decision === "skip") continue;
      if (decision === "conflict") {
        // This tab has edits to the same workbook that are not saved yet: keep them on screen and ask, never overwrite.
        clearTimeout(sharedTimers.get(item.id)); sharedTimers.delete(item.id);
        state.save = "conflict"; state.conflict = { id: item.id, current: r }; state.currentId = item.id; render(); return;
      }
      if (decision === "ours") { remember(r); if (!sharedTimers.has(item.id)) dirty.delete(item.id); continue; }
      const working = r.draft ?? r.deal; if (!working) continue;
      remember(r); const i = state.deals.findIndex((d) => d.id === r.id);
      if (i < 0) state.deals.push(working); else state.deals[i] = working;
      if (r.draft) invalid.set(r.id, r.problem ?? "unfinished"); else invalid.delete(r.id);
      changed = true;
    }
  }
  if (!state.deals.some((d) => d.id === state.currentId)) state.currentId = state.deals[0].id;
  if (changed) render();
}
const TRANSFERRED_KEY = `${STORAGE_KEY}-copied-to-shared`;
function transferred(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(TRANSFERRED_KEY) ?? "[]")); } catch { return new Set(); } }
function markTransferred(ids: string[]) { try { localStorage.setItem(TRANSFERRED_KEY, JSON.stringify([...new Set([...transferred(), ...ids])])); } catch { /* the offer simply reappears */ } }
const where = () => (state.mode === "shared" ? "for both founders" : "in this browser");
const saveText = () => state.save === "ok" ? (state.savedAt ? `Saved ${where()} ${state.savedAt}` : state.mode === "shared" ? "Shared with both founders" : "Saves in this browser")
  : state.save === "saving" ? "Saving…"
  : state.save === "readonly" ? "Read only: this browser isn't confirmed yet, so changes here are not saved."
  : state.save === "failed" ? (state.mode === "shared" ? `NOT SAVED: ${state.note || "the OS did not accept the save"}. Your edits are still on screen; try again or export (JSON).` : "NOT SAVED: browser storage is full or unavailable. Export your deals (JSON) now.")
  : state.save === "invalid" ? `Unfinished changes kept as a draft ${where()}; the last complete version is unchanged and nothing can be exported until this is fixed. ${state.invalidWhy}`
  : state.save === "locked" ? "NOT SAVING: the saved deals could not be read, so they are left untouched."
  : state.mode === "shared" ? "NOT SAVED: someone else saved a newer version of this workbook." : "NOT SAVED: these deals were changed in another tab.";
function showSaveState() {
  const s = document.querySelector("#status span:last-child"); if (s) { s.textContent = saveText(); s.className = state.save === "ok" || state.save === "saving" ? "" : state.save === "invalid" ? "warn" : "neg"; }
  const bar = document.getElementById("conflict"); if (bar) bar.hidden = state.save !== "conflict";
}
// Another tab saved: stop this tab from overwriting it, and let the founder choose.
window.addEventListener("storage", (e) => { if (state.mode === "local" && e.key === STORAGE_KEY && store.rev() !== state.rev) { state.save = "conflict"; showSaveState(); } });
window.addEventListener("focus", () => void refreshShared());
// Warn before leaving while something has not been saved (a save waiting, failed or refused).
window.addEventListener("beforeunload", (e) => {
  const pending = sharedTimers.size > 0 || inFlight.size > 0 || state.save === "failed" || state.save === "conflict" || state.save === "saving";
  if (pending && dirty.size) { e.preventDefault(); e.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshShared(); });
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Print through a hidden same-document frame: no pop-up, so it also works in the desktop (WebView2) client. */
function printHtml(html: string) {
  document.getElementById("print-frame")?.remove();
  const frame = document.createElement("iframe"); frame.id = "print-frame"; frame.title = "Print";
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); };
  frame.srcdoc = html; document.body.appendChild(frame);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "deal";

app.addEventListener("input", (ev) => {
  const el = ev.target as HTMLInputElement; const path = el.dataset.bind; if (!path || el.tagName === "SELECT" || el.type === "checkbox") return;
  const err = app.querySelector(`[data-err-for="${CSS.escape(path)}"]`);
  try {
    const value = parseValue(el.dataset.kind as Kind, el.value, el);
    const quoteKey = path.startsWith("quote.") ? path.slice(6) : "";
    if (GENERATED_QUOTE_KEYS.includes(quoteKey) && !deal().quote.customText) {
      Object.assign(deal().quote, defaultQuoteText(deal()), { customText: true });
      const mode = document.getElementById("text-mode"); if (mode) { mode.className = "small warn"; mode.textContent = "Edited by hand: this text is kept as written, and the agreement carries it in Appendix A."; }
    }
    const before = getPath(deal(), path); setPath(deal(), path, value);
    try { refreshOut(); } catch (e) { setPath(deal(), path, before); throw e; }
    el.removeAttribute("aria-invalid"); if (err) err.textContent = "";
    if (path === "name") { const o = document.querySelector(`#deal-select option[value="${CSS.escape(deal().id)}"]`); if (o) o.textContent = String(value); }
    persist();
  } catch (e) { el.setAttribute("aria-invalid", "true"); if (err) err.textContent = (e as Error).message; }
});
app.addEventListener("change", (ev) => {
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  const action = (el as HTMLElement).dataset.actionChange;
  if (action === "open") { state.currentId = el.value; persistView(); render(); return; }
  if (action === "payment-preset") { const p = PAYMENT_PRESETS[Number(el.value)]; if (p) { deal().website.payment = { ...p }; persist(); render(); } return; }
  if (action === "voice-preset") { const v = RX_VOICE_PRESETS[Number(el.value)]; if (v) { deal().rx.voiceMicros = v.micros; persist(); render(); } return; }
  if (action === "import") {
    const file = (el as HTMLInputElement).files?.[0]; if (!file) return;
    file.text().then((text) => {
      try {
        const incoming = parseDeals(text); const ids = new Set(state.deals.map((d) => d.id));
        const key = (d: Deal) => JSON.stringify({ ...d, id: "", updatedAt: "" });
        const have = new Set(state.deals.map(key)); let added = 0; let skipped = 0;
        const problems = incoming.map((d, i) => [i + 1, validateDeal(d)] as const).filter(([, why]) => why);
        if (problems.length) throw new Error(`deal ${problems[0][0]} cannot be opened (${problems[0][1]}). Nothing was imported.`);
        for (const d of incoming) { if (have.has(key(d))) { skipped++; continue; } if (ids.has(d.id)) d.id = newId(); ids.add(d.id); have.add(key(d)); state.deals.push(d); state.currentId = d.id; added++; }
        persist(); render(); alert(`Imported ${added} deal(s).${skipped ? ` Skipped ${skipped} identical to a deal already here.` : ""}`);
      } catch (e) { alert(`Import failed: ${(e as Error).message}`); }
    });
    return;
  }
  const path = el.dataset.bind; if (!path) return;
  if (el.tagName === "SELECT" || (el as HTMLInputElement).type === "checkbox") {
    setPath(deal(), path, parseValue(el.dataset.kind as Kind, el.value, el));
    const after = el.dataset.after;
    if (after === "cms") { const k = deal().website.cmsComplexity; deal().website.effortMinutes.cms = CMS_PRESETS[k].minutes; }
    if (after === "discount") { const t = deal().website.discount.type; deal().website.discount = t === "percent" ? { type: "percent", bps: 1000 } : t === "fixed" ? { type: "fixed", cents: 0 } : { type: "none" }; }
    persist();
    if (after || path.startsWith("include.") || path.endsWith(".currency") || path.endsWith(".frequency") || path === "website.care.enabled") render(); else refreshOut();
  }
});
let lastCreate = 0;
app.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]"); if (!el || el.tagName === "SELECT") return;
  const d = deal(); const a = el.dataset.action;
  // A double click must not create two deals.
  if (a === "new" || a === "duplicate" || a === "reset-seeds") { const now = Date.now(); if (now - lastCreate < 800) return; lastCreate = now; }
  if (a === "conflict-latest") { location.reload(); return; }
  if (a === "shared-theirs" && state.conflict) {
    const cur = state.conflict.current; const id = state.conflict.id; state.conflict = null; state.save = "ok";
    dirty.delete(id); clearTimeout(sharedTimers.get(id)); sharedTimers.delete(id); lastSent.delete(id);
    if (cur) { remember(cur); const w = cur.draft ?? cur.deal; const i = state.deals.findIndex((x) => x.id === cur.id); if (w && i >= 0) state.deals[i] = w; if (cur.draft) invalid.set(cur.id, cur.problem ?? "unfinished"); else invalid.delete(cur.id); }
    else void loadShared().then(render);
    render(); return;
  }
  if (a === "shared-mine-copy" && state.conflict) {
    // Every deal this tab changed and did not manage to save is kept as its own new copy; the newer saves stay as they are.
    const cur = state.conflict.current; state.conflict = null;
    const copies = state.deals.filter((x) => dirty.has(x.id) || x.id === cur?.id).map((x) => { const c = structuredClone(x); c.id = newId(); c.name = `${x.name} (my copy)`; return c; });
    if (cur) { remember(cur); const w = cur.draft ?? cur.deal; const i = state.deals.findIndex((x) => x.id === cur.id); if (w && i >= 0) state.deals[i] = w; }
    dirty.clear();
    for (const c of copies) { state.deals.push(c); state.revs.set(c.id, 0); state.currentId = c.id; persist(); }
    render(); return;
  }
  if (a === "offer-open") { state.offerOpen = true; render(); return; }
  if (a === "offer-close") { state.offerOpen = false; render(); return; }
  if (a === "offer-copy") {
    const picks = [...document.querySelectorAll<HTMLInputElement>("[data-offer]")].filter((c) => c.checked && !c.disabled).map((c) => state.localOffer[Number(c.dataset.offer)]);
    void (async () => {
      const done: string[] = []; const failed: string[] = [];
      for (const local of picks) {
        const copy = structuredClone(local);
        if (state.deals.some((x) => x.id === copy.id)) copy.id = newId();
        try { const rec = await shared.save(copy, 0); remember(rec); state.deals.push(rec.draft ?? rec.deal ?? copy); if (rec.draft) invalid.set(rec.id, rec.problem ?? "unfinished"); done.push(local.id); }
        catch (e) { failed.push(`${local.name}: ${(e as Error).message}`); }
      }
      markTransferred(done); state.localOffer = state.localOffer.filter((x) => !done.includes(x.id)); state.offerOpen = state.localOffer.length > 0 && failed.length > 0;
      render(); alert(`Copied ${done.length} deal(s) to the shared workspace.${failed.length ? ` Not copied: ${failed.join("; ")}` : ""} The originals are still in this browser.`);
    })();
    return;
  }
  if (a === "crm-link") {
    const v = (document.getElementById("crm-ref") as HTMLInputElement).value.trim();
    if (v && !/^crm:deal:[A-Za-z0-9_-]{1,80}$/.test(v)) { alert("Use the CRM deal reference, for example crm:deal:abc123."); return; }
    void shared.link(d.id, state.revs.get(d.id) ?? 0, v || null).then((rec) => { remember(rec); render(); }).catch((e) => { if (e instanceof ConflictError) { state.save = "conflict"; state.conflict = { id: d.id, current: e.current }; render(); } else alert(`Not linked: ${(e as Error).message}`); });
    return;
  }
  if (a === "lead-attach") {
    const n = Number((document.getElementById("lead-id") as HTMLInputElement).value.trim());
    if (!Number.isSafeInteger(n) || n < 1) { alert("Enter the lead's number."); return; }
    void shared.attach(d.id, state.revs.get(d.id) ?? 0, n).then((r) => { remember(r.record); render(); alert(`Added to lead ${n}: ${r.files.join(", ")}. Nothing was sent.`); }).catch((e) => alert(`Not added: ${(e as Error).message}`));
    return;
  }
  if (a === "conflict-copy") {
    // Keep every deal this tab changed as a copy beside the other tab's newer save.
    const latest = store.read(); if (!latest) { location.reload(); return; }
    const mine = state.deals.filter((x) => dirty.has(x.id) || x.id === d.id).map((x) => { const c = structuredClone(x); c.id = newId(); c.name = `${x.name} (my copy)`; return c; });
    state.deals = [...latest.deals, ...mine]; state.currentId = mine[mine.length - 1]?.id ?? state.currentId; state.rev = latest.rev; dirty.clear(); state.save = store.write(); render(); return;
  }
  if ((a === "print-agreement" || a === "dl-agreement") && !state.agreementChecked) return;
  if (a === "export-raw") { let raw = ""; try { raw = localStorage.getItem(STORAGE_KEY) ?? ""; } catch { /* unreadable */ } download(`mu-deal-desk-saved-data-${today()}.txt`, raw, "text/plain"); return; }
  if (a === "export-quarantine") { download(`mu-deal-desk-unopened-deals-${today()}.json`, JSON.stringify({ note: "Deals the desk could not open. Kept exactly as saved.", deals: state.quarantined }, null, 2), "application/json"); return; }
  if ((a === "print-agreement" || a === "dl-agreement") && state.agreementOver.length) { alert("This agreement would run past its page, so it can't be exported yet. See the note above the preview."); return; }
  if (a === "tab") { state.tab = el.dataset.tab as Tab; persistView(); render(); return; }
  if (a === "open") { state.currentId = el.dataset.id!; persistView(); render(); return; }
  if (a === "new") { const n = blankDeal(today()); state.deals.push(n); state.currentId = n.id; state.tab = "deal"; persist(); render(); return; }
  if (a === "duplicate") { const c = structuredClone(d); c.id = newId(); c.name = `${d.name} (copy)`; c.synthetic = d.synthetic; state.deals.push(c); state.currentId = c.id; persist(); render(); return; }
  if (a === "delete" && state.mode === "shared") {
    if (state.deals.length < 2) { alert("Keep at least one deal."); return; }
    if (!confirm(`Archive "${d.name}" for both founders? It leaves the list and its file is kept on the server.`)) return;
    const rev = state.revs.get(d.id) ?? 0;
    const drop = () => { state.deals = state.deals.filter((x) => x.id !== d.id); state.currentId = state.deals[0].id; render(); };
    if (!rev) { drop(); return; }
    void shared.archive(d.id, rev).then(drop).catch((e) => { if (e instanceof ConflictError) { state.save = "conflict"; state.conflict = { id: d.id, current: e.current }; render(); } else alert(`Not archived: ${(e as Error).message}`); });
    return;
  }
  if (a === "delete") { if (state.deals.length < 2) { alert("Keep at least one deal."); return; } if (!confirm(`Delete "${d.name}" from this browser?`)) return; state.deals = state.deals.filter((x) => x.id !== d.id); state.currentId = state.deals[0].id; persist(); render(); return; }
  if (a === "reset-seeds" && state.mode === "shared") { alert("The shared workspace does not take the synthetic examples. Use the standalone preview to try them."); return; }
  if (a === "reset-seeds") { if (!confirm("Add fresh copies of the synthetic examples? Your own deals are kept.")) return; for (const s of seedDeals()) { s.id = newId(); state.deals.push(s); } persist(); render(); return; }
  if (a === "export-json") {
    // An export holds complete versions only (an import would refuse an unfinished one); unfinished drafts are counted, not lost.
    const complete = state.deals.map((x) => (invalid.has(x.id) ? lastValid.get(x.id) : x)).filter((x): x is Deal => Boolean(x));
    download(`mu-deal-desk-${today()}.json`, serializeDeals(complete), "application/json");
    if (invalid.size) alert(`${invalid.size} unfinished deal(s) were exported as their last complete version${state.deals.length - complete.length ? `, and ${state.deals.length - complete.length} with no complete version yet were left out` : ""}. Their unfinished changes stay saved here.`);
    return;
  }
  if (a === "export-csv") { download(`${slug(d.name)}-comparison.csv`, comparisonCsv(d), "text/csv"); return; }
  if (a === "add-cost") { d.website.costs.push({ id: newId(), label: "New cost", currency: "AUD", cents: null, frequency: "one-off", sharedAcross: 1, evidence: "entered", source: null, checkedAt: null, note: "" }); persist(); render(); return; }
  if (a === "remove-cost") { d.website.costs.splice(Number(el.dataset.i), 1); persist(); render(); return; }
  if (a === "add-stage") { d.website.stages.push({ label: "Milestone", shareBps: 0, trigger: "On approval of …" }); persist(); render(); return; }
  if (a === "remove-stage") { d.website.stages.splice(Number(el.dataset.i), 1); persist(); render(); return; }
  if (a === "package") {
    const id = el.dataset.id as PackageId; const p = getReceptionistPackage(id);
    if (id === d.rx.packageId) return;
    const edited = JSON.stringify(d.rx.columns) !== JSON.stringify(defaultRxColumns(getReceptionistPackage(d.rx.packageId)));
    if (edited && !confirm(`Switch to ${p.shortName}? The usage you entered, the onboarding hours and the term are reset to that package's defaults. Discount and setup fee are kept.`)) return;
    d.rx.packageId = id; d.rx.columns = defaultRxColumns(p); d.rx.onboardingMinutes = p.model.onboardingMinutes; d.rx.termMonths = p.pricing.minimumTermMonths;
    persist(); render(); return;
  }
  if (a === "reset-usage") { d.rx.columns = defaultRxColumns(getReceptionistPackage(d.rx.packageId)); persist(); render(); return; }
  if (a === "refill") { if (!confirm("Replace the scope, deliverables, exclusions, timeline and responsibilities with text generated from the scenario?")) return; Object.assign(d, fillQuoteText(d, true)); persist(); render(); return; }
  if (a === "print") { printHtml(renderQuoteHtml(buildQuote(d), false)); return; }
  if (a === "dl-html-internal") { download(`${slug(d.quote.number)}-review.html`, renderQuoteHtml(buildQuote(d), true), "text/html"); return; }
  if (a === "dl-html-client") { download(`${slug(d.quote.number)}-draft.html`, renderQuoteHtml(buildQuote(d), false), "text/html"); return; }
  if (a === "print-agreement") { printHtml(renderAgreementHtml(d)); return; }
  if (a === "dl-agreement") { download(`${slug(d.quote.number)}-agreement.html`, renderAgreementHtml(d), "text/html"); return; }
  if (a === "dl-md") { download(`${slug(d.quote.number)}.md`, renderQuoteMarkdown(buildQuote(d)), "text/markdown"); return; }
});

async function boot() {
  if (location.pathname.startsWith("/deal-desk") && await shared.available()) {
    state.mode = "shared";
    // Say up front whether this browser may change shared workbooks, rather than failing on the first edit.
    const s = await sessionCanWrite(); state.readOnly = !s.canWrite; if (state.readOnly) state.save = "readonly";
    try { await loadShared(); } catch (e) { state.mode = "local"; state.note = (e as Error).message; }
    const p = new URLSearchParams(location.search);
    state.currentId = p.get("deal") && state.deals.some((d) => d.id === p.get("deal")) ? p.get("deal")! : state.deals[0].id;
  }
  render();
}
void boot();
// Exposed for the browser test harness only (read-only helpers).
(window as any).__dealDesk = { state, buildQuote, calculateRxDeal, calculateWebsite };
