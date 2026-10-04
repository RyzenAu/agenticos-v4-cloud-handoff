/**
 * Business lookups over the CRM's own records: one search across companies, contacts, deals, projects, tasks, quotes, invoices, documents and
 * linked files (plus the saved quote workbooks, which the deal desk owns), a name resolver that never guesses, the next real action, the
 * existing draft outreach and meeting packs, and the exact-arithmetic text of an invoice DRAFT. Pure over a snapshot: nothing here reads a
 * second database, writes a record, sends a message or invents a price. The typed operations in ops.ts and Jarvis both call this.
 *
 * Private text stays private. Free text on the PRIVATE_TEXT_FIELDS list, document bodies and attachment names are searched and shown only
 * when `includePrivate` is true (a confirmed person); an unconfirmed caller sees names, stages, dates and statuses, as on the CRM page.
 */
import { crmHref } from "../../src/lib/crm-links";
import type { CrmRef } from "../../src/lib/crm-ref";
import { splitGst } from "../../src/lib/business-economics";
import { WEBSITE_OFFER } from "../leads/sales-backoffice";
import type {
  Company,
  Deal,
  Document,
  DocumentPricing,
  CrmSnapshot,
  Task,
} from "./types";

export const BUSINESS_KINDS = [
  "company",
  "contact",
  "deal",
  "project",
  "task",
  "quote",
  "invoice",
  "document",
  "file",
  "workbook",
] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];

export type BusinessHit = {
  kind: BusinessKind;
  id: string;
  /** The CRM record to open (a task opens its deal or company; a workbook has none). */
  ref: CrmRef | null;
  title: string;
  /** Names, stages, statuses and dates only: never private free text. */
  detail: string;
  href: string | null;
  companyId: string | null;
  score: number;
};

/** A quote workbook row from the deal desk, as much of it as an unconfirmed caller may see. */
export type WorkbookRow = { id: string; name: string; status: string; archived?: boolean; crmDealRef?: string | null };

type Directory = Pick<CrmSnapshot, "companies" | "contacts" | "deals" | "tasks" | "projects" | "documents" | "pipelines">;

/** Case, accent and punctuation folded, so "Café Nero's", "cafe nero" and "CAFE-NERO" are the same words. */
export const foldWords = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-AU")
    .replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N}@.#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const termsOf = (query: string) => foldWords(query).split(" ").filter(Boolean);
const matches = (haystack: string, terms: string[]) => {
  const hay = foldWords(haystack);
  return terms.every((t) => hay.includes(t));
};
const tidy = (...parts: (string | null | undefined | false)[]) =>
  parts.filter((p): p is string => !!p).join(" · ");

function score(title: string, terms: string[], query: string): number {
  const t = foldWords(title);
  const q = foldWords(query);
  if (t === q) return 100;
  if (t.startsWith(q)) return 60;
  if (terms.every((x) => t.includes(x))) return 40;
  return 10;
}

const isInvoice = (d: Document) => d.kind === "invoice-reference" || /^invoice draft\b/i.test(d.title);
const isQuote = (d: Document) => d.kind === "proposal" || /^quote\b/i.test(d.title);

/** One search across every business record kind. At most `limit` hits per kind. */
export function searchBusiness(
  data: Directory,
  query: string,
  options: {
    includePrivate: boolean;
    kinds?: readonly BusinessKind[];
    limit?: number;
    workbooks?: readonly WorkbookRow[];
  },
): { total: number; hits: BusinessHit[] } {
  const terms = termsOf(query);
  if (!terms.length) return { total: 0, hits: [] };
  const want = (k: BusinessKind) => !options.kinds?.length || options.kinds.includes(k);
  const per = options.limit ?? 5;
  const companies = new Map(data.companies.map((c) => [c.id, c]));
  const stageName = new Map<string, string>();
  for (const p of data.pipelines) for (const s of p.stages) stageName.set(s.id, s.name);
  const cname = (id: string) => companies.get(id)?.name ?? "";
  const live = (c: Company) => !c.mergedInto;
  const out: BusinessHit[] = [];
  const add = (hit: Omit<BusinessHit, "score"> & { text: string }) => {
    if (!matches(hit.text, terms)) return;
    const { text: _text, ...rest } = hit;
    out.push({ ...rest, score: score(hit.title, terms, query) });
  };

  if (want("company"))
    for (const c of data.companies.filter(live))
      add({
        kind: "company",
        id: c.id,
        ref: { kind: "company", id: c.id },
        title: c.name,
        detail: tidy(c.status, c.locality, c.excluded && "excluded", c.doNotContact && "do not contact"),
        href: crmHref({ kind: "company", id: c.id }),
        companyId: c.id,
        text: [c.id, c.name, c.industry, c.website, c.locality, c.address, c.phone, ...c.emails, ...c.tags, c.status,
          options.includePrivate ? c.notes : ""].join(" "),
      });
  if (want("contact"))
    for (const c of data.contacts) {
      if (companies.get(c.companyId)?.mergedInto) continue;
      add({
        kind: "contact",
        id: c.id,
        ref: { kind: "contact", id: c.id },
        title: c.name,
        detail: tidy(c.role, cname(c.companyId), c.doNotContact && "do not contact"),
        href: crmHref({ kind: "contact", id: c.id }),
        companyId: c.companyId,
        text: [c.id, c.name, c.role, c.email, c.phone, cname(c.companyId), options.includePrivate ? c.preferences : ""].join(" "),
      });
    }
  if (want("deal"))
    for (const d of data.deals) {
      if (companies.get(d.companyId)?.mergedInto) continue;
      add({
        kind: "deal",
        id: d.id,
        ref: { kind: "deal", id: d.id },
        title: d.title,
        detail: tidy(cname(d.companyId), stageName.get(d.stageId) ?? d.stageId, d.commercialBasis === "pending" && "pricing pending"),
        href: crmHref({ kind: "deal", id: d.id }),
        companyId: d.companyId,
        text: [d.id, d.title, d.service, stageName.get(d.stageId) ?? "", cname(d.companyId), options.includePrivate ? `${d.scope} ${d.nextAction}` : ""].join(" "),
      });
    }
  if (want("project"))
    for (const p of data.projects) {
      add({
        kind: "project",
        id: p.id,
        ref: { kind: "project", id: p.id },
        title: p.name,
        detail: tidy(cname(p.companyId), p.status),
        href: crmHref({ kind: "project", id: p.id }, "delivery"),
        companyId: p.companyId,
        text: [p.id, p.name, p.status, cname(p.companyId), options.includePrivate ? p.scope : ""].join(" "),
      });
    }
  if (want("task"))
    for (const t of data.tasks) {
      const ref: CrmRef = t.dealId ? { kind: "deal", id: t.dealId } : { kind: "company", id: t.companyId };
      add({
        kind: "task",
        id: t.id,
        ref,
        title: t.title,
        detail: tidy(cname(t.companyId), t.status, t.owner && `owner ${t.owner}`, t.dueAt && `due ${t.dueAt.slice(0, 10)}`),
        href: crmHref(ref),
        companyId: t.companyId,
        text: [t.id, t.title, t.kind, t.status, t.owner, cname(t.companyId), options.includePrivate ? t.description : ""].join(" "),
      });
    }
  for (const d of data.documents) {
    const quote = isQuote(d);
    const invoice = isInvoice(d);
    const kind: BusinessKind = invoice ? "invoice" : quote ? "quote" : "document";
    const ref: CrmRef = { kind: "document", id: d.id };
    if (want(kind))
      add({
        kind,
        id: d.id,
        ref,
        title: d.title,
        detail: tidy(cname(d.companyId), d.kind, d.status, `version ${d.currentVersion}`),
        href: crmHref(ref, "deals"),
        companyId: d.companyId,
        text: [d.id, d.title, d.kind, d.status, cname(d.companyId), d.externalUrl ?? "",
          options.includePrivate ? d.versions.map((v) => v.content).join(" ") : ""].join(" "),
      });
    // Linked files: the name says who the client is, so only a confirmed person finds or sees one.
    if (want("file") && options.includePrivate)
      for (const a of d.attachments ?? [])
        add({
          kind: "file",
          id: a.id,
          ref,
          title: a.name,
          detail: tidy(cname(d.companyId), `on ${d.title}`),
          href: crmHref(ref, "deals"),
          companyId: d.companyId,
          text: [a.name, d.title, cname(d.companyId)].join(" "),
        });
  }
  if (want("workbook"))
    for (const w of options.workbooks ?? []) {
      if (w.archived) continue;
      const ref = w.crmDealRef && /^crm:deal:/.test(w.crmDealRef) ? w.crmDealRef.slice(9) : "";
      const deal = ref ? data.deals.find((x) => x.id === ref) : undefined;
      add({
        kind: "workbook",
        id: w.id,
        ref: deal ? { kind: "deal", id: deal.id } : null,
        title: w.name,
        detail: tidy("quote workbook", w.status),
        href: deal ? crmHref({ kind: "deal", id: deal.id }) : "/deal-desk/index.html",
        companyId: deal?.companyId ?? null,
        text: [w.id, w.name].join(" "),
      });
    }

  const byKind = new Map<BusinessKind, BusinessHit[]>();
  for (const h of out) byKind.set(h.kind, [...(byKind.get(h.kind) ?? []), h]);
  const hits = BUSINESS_KINDS.flatMap((k) =>
    (byKind.get(k) ?? []).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, per),
  );
  return { total: out.length, hits };
}

export type Resolution =
  | { status: "one"; hit: BusinessHit }
  | { status: "many"; hits: BusinessHit[] }
  | { status: "none" };

/** The one hit a name means among already-found hits: an exact (folded) title that is unique, else a lone hit, else a question. */
export function pickFromHits(hits: readonly BusinessHit[], name: string): Resolution {
  if (!hits.length) return { status: "none" };
  const exact = hits.filter((h) => foldWords(h.title) === foldWords(name));
  if (exact.length === 1) return { status: "one", hit: exact[0] };
  if (hits.length === 1) return { status: "one", hit: hits[0] };
  return { status: "many", hits: exact.length > 1 ? [...exact] : [...hits] };
}

/** A spoken or typed name to ONE record. Never guesses: several candidates is "many" and the caller asks which. */
export function resolveBusinessRef(
  data: Directory,
  name: string,
  options: { includePrivate: boolean; kinds: readonly BusinessKind[]; workbooks?: readonly WorkbookRow[] },
): Resolution {
  return pickFromHits(searchBusiness(data, name, { ...options, limit: 25 }).hits, name);
}

export type NextAction = {
  taskId: string;
  title: string;
  company: string;
  dealId: string | null;
  deal: string | null;
  owner: string;
  dueAt: string | null;
  overdue: boolean;
  /** An open task with something it must wait for is not the next action; it is listed as waiting. */
  waiting: boolean;
  dependsOnCount: number;
  href: string;
};

/** Open work in order: overdue first, then the soonest due, undated last. Scoped to a company or a deal when given. */
export function nextActions(
  data: Directory,
  options: { companyId?: string; dealId?: string; now?: string; limit?: number },
): { next: NextAction | null; waiting: NextAction[]; actions: NextAction[] } {
  const now = options.now ?? new Date().toISOString();
  const companies = new Map(data.companies.map((c) => [c.id, c.name]));
  const deals = new Map(data.deals.map((d) => [d.id, d.title]));
  const open = (t: Task) => t.status === "open" || t.status === "in-progress";
  const rows: NextAction[] = data.tasks
    .filter((t) => open(t) && (!options.companyId || t.companyId === options.companyId) && (!options.dealId || t.dealId === options.dealId))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      company: companies.get(t.companyId) ?? "",
      dealId: t.dealId,
      deal: t.dealId ? (deals.get(t.dealId) ?? null) : null,
      owner: t.owner,
      dueAt: t.dueAt,
      overdue: !!t.dueAt && t.dueAt.slice(0, 10) < now.slice(0, 10),
      waiting: (t.dependsOn?.length ?? 0) > 0,
      dependsOnCount: t.dependsOn?.length ?? 0,
      href: crmHref(t.dealId ? { kind: "deal", id: t.dealId } : { kind: "company", id: t.companyId }),
    }))
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
      if (a.dueAt || b.dueAt) return a.dueAt ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
  const ready = rows.filter((r) => !r.waiting);
  return {
    next: ready[0] ?? null,
    waiting: rows.filter((r) => r.waiting),
    actions: rows.slice(0, options.limit ?? 20),
  };
}

export type DraftItem = {
  kind: "outreach" | "meeting-pack" | "reply-draft";
  id: string;
  title: string;
  company: string;
  companyId: string;
  /** Always "not sent": nothing here is a sent or queued message. */
  state: string;
  /** Recipient and identity gaps, from what the CRM actually holds. Empty only when there is nothing to flag. */
  gaps: string[];
  href: string;
};

/** The existing drafts: outreach packs, meeting packs and unsent reply drafts, each with the gaps still open. Never sends or changes anything. */
export function draftsView(
  data: Pick<CrmSnapshot, "companies" | "contacts" | "deals" | "documents"> & { activities: CrmSnapshot["activities"] },
  options: { companyId?: string; includePrivate: boolean },
): DraftItem[] {
  const companies = new Map(data.companies.map((c) => [c.id, c]));
  const gapsFor = (companyId: string): string[] => {
    const company = companies.get(companyId);
    const contacts = data.contacts.filter((c) => c.companyId === companyId);
    const gaps: string[] = [];
    const recipients = contacts.filter((c) => c.email).length + (company?.emails.length ?? 0);
    if (!recipients) gaps.push("No recipient email on file: the recipient is unconfirmed.");
    if (company?.doNotContact || contacts.some((c) => c.doNotContact)) gaps.push("Marked do not contact.");
    if (company && !company.emailAllowed) gaps.push("Email is not allowed for this company.");
    if (company?.excluded) gaps.push("Company is excluded from outreach.");
    const restricted = contacts.reduce((n, c) => n + c.restrictions.length, 0);
    if (restricted)
      gaps.push(
        options.includePrivate
          ? `Restrictions on file: ${contacts.flatMap((c) => c.restrictions).slice(0, 3).join("; ")}.`
          : `${restricted} contact restriction${restricted === 1 ? "" : "s"} on file (confirm this browser to read them).`,
      );
    const pending = data.deals.some((d) => d.companyId === companyId && d.commercialBasis === "pending");
    if (pending) gaps.push("Pricing is pending on this company's deal: no price is confirmed.");
    gaps.push("Sending is not authorised: nothing has been sent.");
    return gaps;
  };
  const items: DraftItem[] = [];
  const inScope = (companyId: string) => !options.companyId || options.companyId === companyId;
  for (const d of data.documents) {
    if (!inScope(d.companyId)) continue;
    const outreach = /outreach pack/i.test(d.title);
    const meeting = /meeting pack/i.test(d.title);
    if (!outreach && !meeting) continue;
    items.push({
      kind: outreach ? "outreach" : "meeting-pack",
      id: d.id,
      title: d.title,
      company: companies.get(d.companyId)?.name ?? "",
      companyId: d.companyId,
      state: `${d.status}, not sent`,
      gaps: gapsFor(d.companyId),
      href: crmHref({ kind: "document", id: d.id }, "deals"),
    });
  }
  for (const a of data.activities) {
    if (a.kind !== "draft-reply" || a.communicationState !== "drafted" || !inScope(a.companyId)) continue;
    items.push({
      kind: "reply-draft",
      id: a.id,
      title: a.title,
      company: companies.get(a.companyId)?.name ?? "",
      companyId: a.companyId,
      state: "drafted, not sent",
      gaps: gapsFor(a.companyId),
      href: crmHref(a.ref, "timeline"),
    });
  }
  return items;
}

const aud = (cents: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

export type InvoiceLine = { description: string; exGstCents: number; gstCents: number; totalCents: number };
export type InvoiceDraft = {
  lines: InvoiceLine[];
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
  /** The recurring fee, shown for the amount only: it is never an invoice line here. */
  recurring: { exGstCents: number; gstCents: number; totalCents: number } | null;
  content: string;
};

/**
 * The invoice DRAFT for a deal's agreed price, in exact integer cents, GST from the one shared splitGst (10%, half up). `deposit` is only the
 * approved website deposit (the catalogue's 50%); there is no other portion and no discount, so a missing price never becomes a number.
 */
export function buildInvoiceDraft(
  company: Pick<Company, "name">,
  deal: Pick<Deal, "title" | "id" | "version" | "scope">,
  pricing: DocumentPricing,
  portion: "full" | "deposit",
  options: { today: string },
): InvoiceDraft {
  const treatment = pricing.gstTreatment === "not-applicable" ? "none" : pricing.gstTreatment;
  const lines: InvoiceLine[] = [];
  if (portion === "deposit") {
    if (pricing.catalogueId !== "website" || pricing.gstTreatment === "not-applicable")
      throw new Error("A deposit invoice is only drafted for the approved website offer. Draft the full amount, or confirm the deposit terms first.");
    const s = splitGst(WEBSITE_OFFER.depositCents, "inclusive");
    lines.push({ description: `${deal.title}: website commencement deposit (50%)`, exGstCents: s.netCents, gstCents: s.gstCents, totalCents: s.grossCents });
  } else if (pricing.oneOffCents > 0) {
    const s = splitGst(pricing.oneOffCents, treatment);
    lines.push({ description: `${deal.title}: one-off fee`, exGstCents: s.netCents, gstCents: s.gstCents, totalCents: s.grossCents });
  }
  if (!lines.length)
    throw new Error("There is no one-off amount to invoice on this deal, so I haven't drafted one.");
  const subtotalCents = lines.reduce((n, l) => n + l.exGstCents, 0);
  const gstCents = lines.reduce((n, l) => n + l.gstCents, 0);
  const totalCents = lines.reduce((n, l) => n + l.totalCents, 0);
  const rec = pricing.recurringCents > 0 ? splitGst(pricing.recurringCents, treatment) : null;
  const recurring = rec ? { exGstCents: rec.netCents, gstCents: rec.gstCents, totalCents: rec.grossCents } : null;
  const lineText = (l: InvoiceLine) => `${l.description}: ${aud(l.exGstCents)} ex GST + ${aud(l.gstCents)} GST = ${aud(l.totalCents)}`;
  const content = [
    "DRAFT — NOT A VALID TAX INVOICE UNTIL THE ABN IS ADDED",
    `# TAX INVOICE — DRAFT ${deal.id}-v${deal.version}-${portion}`,
    "Supplier: M&U Ventures · ABN: [REQUIRED — founder to provide before issue]",
    `Customer: ${company.name} · Address / ABN: [confirm if required]`,
    `Draft prepared: ${options.today} · Due date: [founder to confirm payment terms]`,
    "## Items",
    ...lines.map(lineText),
    `Subtotal ex GST: ${aud(subtotalCents)}`,
    `GST (10%): ${aud(gstCents)}`,
    `TOTAL: ${aud(totalCents)}`,
    ...(recurring
      ? ["## Recurring fee: not invoiced by this draft", `Per month: ${aud(recurring.exGstCents)} ex GST + ${aud(recurring.gstCents)} GST = ${aud(recurring.totalCents)}. Amount shown for reference only; when it is billed is not decided.`]
      : []),
    "## Payment",
    "Bank details and payment link: [founder-approved placeholder]. Do not pay against this draft.",
    "No invoice or payment request has been sent. Confirm the ABN, customer identity and agreed payment terms before issuing; existing Finance is the source for invoices and payment status.",
    "",
  ].join("\n");
  return { lines, subtotalCents, gstCents, totalCents, recurring, content };
}
