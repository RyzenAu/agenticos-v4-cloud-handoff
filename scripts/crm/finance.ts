/** Read-only links to the existing Finance Stripe snapshot. No provider calls or CRM writes. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { financeDbPath } from "../finance/store";
import type { Document } from "./types";

export type CrmFinanceStatus = "draft" | "open" | "paid" | "uncollectible" | "void" | "unknown";
export type CrmFinanceLink = {
  documentId: string;
  documentTitle: string;
  companyId: string;
  dealId: string | null;
  externalUrl: string | null;
  source: "finance-stripe-snapshot";
  state: "linked" | "unknown";
  requirement: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: CrmFinanceStatus;
  amountPaidCents: number | null;
  amountRemainingCents: number | null;
  currency: string | null;
  asOf: string | null;
  stale: boolean;
};
/** Browser consumers must use a type-only import: this module uses server-only SQLite. */
export type CrmFinanceLinks = {
  source: "finance-stripe-snapshot";
  state: "empty" | "unknown" | "partial" | "linked";
  requirement: string | null;
  links: CrmFinanceLink[];
};

const SOURCE = "finance-stripe-snapshot" as const;
export const CRM_FINANCE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const ADD_REFERENCE =
  "Add an invoice-reference document for this company using the exact hosted invoice URL from existing Finance. Link its deal where applicable.";
const NO_SNAPSHOT =
  "Open Finance and connect Stripe if needed, then use its existing sync to import this invoice. CRM requires a saved Finance Stripe invoice snapshot and the exact hosted invoice URL.";
const NO_MATCH =
  "No saved Finance Stripe invoice matches this exact URL. Open Finance, connect Stripe if needed and sync/import this invoice, then copy its hosted invoice URL into this invoice-reference document.";
const UNREADABLE =
  "The existing Finance Stripe invoice snapshot could not be read. Open Finance to check its connection and refresh its invoice import, then retry here.";

/** Validate without normalising: a URL's exact saved bytes are its identity. */
function invoiceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 4096 || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.hash
      ? value
      : null;
  } catch {
    return null;
  }
}

function unknownLink(document: Document, requirement: string): CrmFinanceLink {
  return {
    documentId: document.id,
    documentTitle: document.title,
    companyId: document.companyId,
    dealId: document.dealId,
    externalUrl: invoiceUrl(document.externalUrl),
    source: SOURCE,
    state: "unknown",
    requirement,
    invoiceId: null,
    invoiceNumber: null,
    status: "unknown",
    amountPaidCents: null,
    amountRemainingCents: null,
    currency: null,
    asOf: null,
    stale: true,
  };
}

type InvoiceRow = {
  id: unknown;
  number: unknown;
  status: unknown;
  amount_paid: unknown;
  amount_remaining: unknown;
  currency: unknown;
  synced_at: unknown;
};

/** Finance stores dollars already. Never interpret its REAL amounts as Stripe's raw cents. */
function dollarsToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function snapshotTime(value: unknown, now: Date): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime()) || date > now)
    return null;
  // Date.parse normalises impossible dates (e.g. 30 February); reject those too.
  if (date.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return date.toISOString();
}

function linkRow(document: Document, row: InvoiceRow, now: Date): CrmFinanceLink {
  const unknown = unknownLink(
    document,
    "The matched Finance invoice snapshot has incomplete or malformed evidence. Open Finance and refresh its Stripe invoice import before relying on payment status.",
  );
  const asOf = snapshotTime(row.synced_at, now);
  if (!asOf)
    return {
      ...unknown,
      requirement:
        "The matched Finance invoice has no valid snapshot time. Open Finance and refresh its Stripe invoice import to establish when payment status was recorded.",
    };
  const amountPaidCents = dollarsToCents(row.amount_paid);
  const amountRemainingCents = dollarsToCents(row.amount_remaining);
  const statuses: readonly string[] = ["draft", "open", "paid", "uncollectible", "void"];
  if (
    typeof row.id !== "string" ||
    !row.id.trim() ||
    typeof row.number !== "string" ||
    typeof row.status !== "string" ||
    !statuses.includes(row.status) ||
    amountPaidCents === null ||
    amountRemainingCents === null ||
    typeof row.currency !== "string" ||
    !/^[a-zA-Z]{3}$/.test(row.currency)
  )
    return unknown;
  const stale = now.getTime() - Date.parse(asOf) > CRM_FINANCE_STALE_AFTER_MS;
  return {
    ...unknown,
    state: "linked",
    requirement: stale
      ? "This Finance snapshot is over 24 hours old. Refresh the Stripe invoice import in Finance to check current payment status."
      : null,
    invoiceId: row.id,
    invoiceNumber: row.number || null,
    status: row.status as CrmFinanceStatus,
    amountPaidCents,
    amountRemainingCents,
    currency: row.currency.toUpperCase(),
    asOf,
    stale,
  };
}

function result(links: CrmFinanceLink[]): CrmFinanceLinks {
  const linked = links.filter((link) => link.state === "linked").length;
  return {
    source: SOURCE,
    state: !links.length
      ? "empty"
      : !linked
        ? "unknown"
        : linked === links.length
          ? "linked"
          : "partial",
    requirement: !links.length
      ? ADD_REFERENCE
      : (links.find((link) => link.requirement)?.requirement ?? null),
    links,
  };
}

/** The caller scopes documents to an authorised company; no CRM or Finance data is mutated. */
export function readCrmFinanceLinks(
  root: string,
  documents: Document[],
  now = new Date(),
): CrmFinanceLinks {
  const references = documents.filter((document) => document.kind === "invoice-reference");
  if (!references.length) return result([]);
  const links = references.map((document) =>
    unknownLink(
      document,
      invoiceUrl(document.externalUrl)
        ? NO_SNAPSHOT
        : "This invoice reference needs a valid HTTPS hosted invoice URL. Copy the exact URL from existing Finance into the document; names and amounts cannot establish a link.",
    ),
  );
  if (!links.some((link) => link.externalUrl)) return result(links);

  // Do not use openFinanceDb/openStripeDb: those initialise schemas and can create a ledger.
  const file = financeDbPath(root);
  if (!existsSync(file)) return result(links);
  let db: Database | undefined;
  try {
    // Read-only prevents ledger/schema/main-DB/WAL content writes. SQLite may still
    // maintain WAL/SHM coordination metadata. Do not use an immutable URI to avoid
    // those sidecars: it would hide committed payments still in the live WAL.
    db = new Database(file, { readonly: true });
    const query =
      db.query(`SELECT id, number, status, amount_paid, amount_remaining, currency, synced_at
      FROM stripe_invoices WHERE hosted_invoice_url = ? COLLATE BINARY LIMIT 2`);
    const rowsByUrl = new Map<string, InvoiceRow[]>();
    for (const [index, document] of references.entries()) {
      const url = links[index].externalUrl;
      if (!url) continue;
      let rows = rowsByUrl.get(url);
      if (!rows) {
        rows = query.all(url) as InvoiceRow[];
        rowsByUrl.set(url, rows);
      }
      links[index] =
        rows.length === 1
          ? linkRow(document, rows[0], now)
          : unknownLink(
              document,
              rows.length > 1
                ? "More than one Finance invoice has this exact hosted URL. Resolve the duplicate invoice snapshot in Finance and confirm the document URL before relying on payment status."
                : NO_MATCH,
            );
    }
  } catch {
    return result(
      links.map((link, index) =>
        link.externalUrl ? unknownLink(references[index], UNREADABLE) : link,
      ),
    );
  } finally {
    db?.close();
  }
  return result(links);
}
