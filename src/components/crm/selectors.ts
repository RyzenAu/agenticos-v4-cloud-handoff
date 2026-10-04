import { timeZoneNames } from "../../../scripts/crm/validation";
import type {
  Company,
  CrmRef,
  CrmSnapshot,
  Deal,
  PipelineStage,
  Task,
} from "../../../scripts/crm/types";
import { splitGst } from "@/lib/business-economics";
import { SALES_STAGES } from "../../../scripts/crm/types";
import { parseCrmRef } from "@/lib/crm-ref";
export type CrmView = "today" | "pipeline" | "companies" | "contacts" | "templates";
export type CrmTab = "overview" | "timeline" | "deals" | "delivery";
/** `q` is the pipeline search, kept in the address so a reload or Back keeps it. */
export type CrmSearch = { ref?: string; view?: CrmView; tab?: CrmTab; q?: string };
export type DirectoryFilters = {
  search: string;
  owner: string;
  status: string;
  restriction: string;
};
export const EMPTY_FILTERS: DirectoryFilters = {
  search: "",
  owner: "",
  status: "",
  restriction: "",
};
export function validateCrmSearch(search: Record<string, unknown>): CrmSearch {
  const ref = typeof search.ref === "string" && parseCrmRef(search.ref) ? search.ref : undefined;
  const view = ["today", "pipeline", "companies", "contacts", "templates"].includes(
    String(search.view),
  )
    ? (search.view as CrmView)
    : undefined;
  const tab = ["overview", "timeline", "deals", "delivery"].includes(String(search.tab))
    ? (search.tab as CrmTab)
    : undefined;
  const q = typeof search.q === "string" && search.q.trim() ? search.q.slice(0, 100) : undefined;
  return {
    ...(ref ? { ref } : {}),
    ...(view ? { view } : {}),
    ...(tab ? { tab } : {}),
    ...(q ? { q } : {}),
  };
}
export function companyForRef(snapshot: CrmSnapshot, ref: CrmRef | null): Company | undefined {
  if (!ref) return undefined;
  const companyId =
    ref.kind === "company"
      ? ref.id
      : ref.kind === "lead"
        ? snapshot.companies.find((c) => String(c.legacyLeadId) === ref.id)?.id
        : ref.kind === "contact"
          ? snapshot.contacts.find((c) => c.id === ref.id)?.companyId
          : ref.kind === "deal"
            ? snapshot.deals.find((d) => d.id === ref.id)?.companyId
            : ref.kind === "project"
              ? snapshot.projects.find((p) => p.id === ref.id)?.companyId
              : snapshot.documents.find((d) => d.id === ref.id)?.companyId;
  let company = snapshot.companies.find((c) => c.id === companyId);
  const visited = new Set<string>();
  while (company?.mergedInto) {
    if (visited.has(company.id)) return undefined;
    visited.add(company.id);
    company = snapshot.companies.find((c) => c.id === company!.mergedInto);
  }
  return company;
}
export function stageForDeal(snapshot: CrmSnapshot, deal: Deal): PipelineStage | undefined {
  return (snapshot.pipelines.find((p) => p.id === deal.pipelineId)?.stages ?? SALES_STAGES).find(
    (s) => s.id === deal.stageId,
  );
}
export function isOpenTask(task: Task) {
  return task.status === "open" || task.status === "in-progress";
}
export function dateKey(value: string | number, timezone = "Australia/Sydney"): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
}
export function taskUrgency(
  task: Task,
  now = Date.now(),
  timezone = "Australia/Sydney",
): "overdue" | "today" | "upcoming" | "unscheduled" {
  if (!task.dueAt) return "unscheduled";
  const due = dateKey(task.dueAt, timezone),
    today = dateKey(now, timezone);
  return !due ? "unscheduled" : due < today ? "overdue" : due === today ? "today" : "upcoming";
}
export function taskOrder(a: Task, b: Task) {
  return (
    (a.dueAt || "9999").localeCompare(b.dueAt || "9999") || a.title.localeCompare(b.title, "en-AU")
  );
}
export function normaliseSearch(value: string) {
  return value
    .toLocaleLowerCase("en-AU")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}
export function matchesSearch(values: unknown[], query: string): boolean {
  const all = values
    .flat()
    .filter((v) => v !== null && v !== undefined)
    .map(String);
  const text = normaliseSearch(all.join(" "));
  const normalPhone = (value: string) =>
    value.replace(/\D/g, "").replace(/^0061/, "0").replace(/^61/, "0");
  const q = normaliseSearch(query);
  if (/^[+()\d\s-]+$/.test(q) && q.replace(/\D/g, "").length >= 6) {
    const digits = normalPhone(q);
    return all.some((value) => normalPhone(value).includes(digits));
  }
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word.replace(/^#/, "")));
}
export function filterCompanies(snapshot: CrmSnapshot, filters: DirectoryFilters): Company[] {
  // Build once per search instead of scanning every contact for every company.
  const contactText = new Map<string, string[]>();
  for (const contact of snapshot.contacts) {
    const values = contactText.get(contact.companyId) ?? [];
    values.push(contact.name, contact.email, contact.phone);
    contactText.set(contact.companyId, values);
  }
  return snapshot.companies
    .filter(
      (company) =>
        !company.mergedInto &&
        (!filters.owner || company.owner === filters.owner) &&
        (!filters.status || company.status === filters.status) &&
        (!filters.restriction ||
          (filters.restriction === "restricted"
            ? company.doNotContact || company.excluded
            : !company.doNotContact && !company.excluded)) &&
        matchesSearch(
          [
            company.name,
            company.id,
            company.legacyLeadId,
            company.industry,
            company.locality,
            company.phone,
            company.emails,
            company.tags,
            ...(contactText.get(company.id) ?? []),
          ],
          filters.search,
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
}
export function pipelineTotals(snapshot: CrmSnapshot, deals = snapshot.deals) {
  const totals = {
    estimatedOneOff: 0,
    estimatedRecurring: 0,
    wonOneOff: 0,
    wonRecurring: 0,
    openCount: 0,
    wonCount: 0,
    /** Open deals with no approved price: left out of every amount and counted here instead. */
    pricingPendingCount: 0,
  };
  for (const deal of deals) {
    const category = stageForDeal(snapshot, deal)?.category;
    if (pricingPending(deal)) {
      if (category === "open") totals.pricingPendingCount++;
      continue;
    }
    const treatment = deal.gstTreatment === "not-applicable" ? "none" : deal.gstTreatment;
    const oneOffNet = splitGst(deal.oneOffCents, treatment).netCents;
    const recurringNet = splitGst(deal.recurringCents, treatment).netCents;
    if (category === "open") {
      totals.estimatedOneOff += oneOffNet;
      totals.estimatedRecurring += recurringNet;
      totals.openCount++;
    }
    if (category === "won") {
      totals.wonOneOff += oneOffNet;
      totals.wonRecurring += recurringNet;
      totals.wonCount++;
    }
  }
  return totals;
}
export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}
export function localDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
export function dateTimeValue(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}
export function moneyCents(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new Error("Values must be zero or a positive AUD amount.");
  return Math.round(number * 100);
}

/**
 * The name to print for a company. Google display content is not stored permanently, so a migrated lead can have no name until a founder confirms one in
 * Leads: it reads "Unnamed company · dental, Parramatta (lead #12)" (the suburb and industry when stored), never a blank. `short` leaves out the
 * industry and locality for a row that prints them on the next line.
 */
export function companyLabel(
  company:
    | {
        name?: string | null;
        industry?: string | null;
        locality?: string | null;
        legacyLeadId?: number | null;
      }
    | null
    | undefined,
  options: { short?: boolean } = {},
): string {
  const name = company?.name?.trim();
  if (name) return name;
  const where = options.short
    ? ""
    : [company?.industry, company?.locality]
        .map((v) => v?.trim())
        .filter(Boolean)
        .join(", ");
  return `Unnamed company${where ? ` · ${where}` : ""}${company?.legacyLeadId ? ` (lead #${company.legacyLeadId})` : ""}`;
}

/** No approved price exists yet: show "Pricing pending", never a figure (0 cents here means unknown, not free). */
export function pricingPending(deal: { commercialBasis: string }): boolean {
  return deal.commercialBasis === "pending";
}

/** "follow-up" becomes "Follow up": a stored word as a sentence-case label. */
export function sentence(value: string | null | undefined): string {
  const words = (value ?? "").replaceAll("-", " ").replaceAll("_", " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** Time zones for a select: Australia first (Sydney at the top). A zone already on the record that is not in the list stays selectable. */
export function timeZoneChoices(current?: string): { value: string; label: string }[] {
  const names = timeZoneNames();
  if (current && !names.includes(current)) names.unshift(current);
  return names.map((value) => ({ value, label: value.replaceAll("_", " ") }));
}

/** A template's `{{company.name}}` placeholder, as the person will see it once applied: "[Company name]". */
export function templateText(text: string): string {
  return text
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, key: string) => {
      const words = key.split(/[._]/).join(" ").trim();
      return `[${words ? words[0].toUpperCase() + words.slice(1) : "To confirm"}]`;
    })
    .replace(/\*\*(.+?)\*\*/g, "$1");
}
export type TemplateBlock = { type: "heading" | "item" | "text"; text: string };
/** A template's markdown as plain blocks to render: headings, list items and paragraphs, with no `##`, `-` or `{{ }}` showing. */
export function templateBlocks(content: string): TemplateBlock[] {
  const blocks: TemplateBlock[] = [];
  for (const line of content.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s+(.*\S)\s*$/.exec(line);
    const item = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (heading) blocks.push({ type: "heading", text: templateText(heading[1]) });
    else if (item) blocks.push({ type: "item", text: templateText(item[1]) });
    else if (line.trim()) blocks.push({ type: "text", text: templateText(line.trim()) });
  }
  return blocks;
}
