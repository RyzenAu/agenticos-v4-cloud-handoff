// Read-only Stripe integration. This file is intentionally self-contained: it owns its own
// SQLite tables (all named `stripe_*`) inside the shared .operator-data/finance.sqlite file
// instead of touching the `accounts` / `transactions` tables that scripts/finance/store.ts and
// scripts/finance/sync.ts own — those are mid-edit by another engineer adding a NAB CSV
// importer (the since-retired scripts/finance/csv-import.ts) when this file was written, so nothing here
// edits store.ts, sync.ts, invoice-matching.ts or any finance UI component. It only *reads*
// the bank-side `transactions` table (via store.ts's already-exported readTransactionsSince)
// to dedupe Stripe payouts against bank deposits — see matchPayoutsToBankDeposits below.
//
// Every request this module makes is a plain GET against api.stripe.com — see the `stripeGet`
// helper, which is the ONLY function in this file that calls fetch, and which hardcodes
// `method: "GET"` with no way for a caller to override it. There is no create/update/delete/
// refund method anywhere in createStripeClient's return value. scripts/finance/stripe.test.ts
// asserts both of those things directly.
//
// Auth: Stripe accepts the key as a Bearer token (`Authorization: Bearer <key>`), which is
// simpler than the legacy HTTP Basic form and works the same for a restricted key (rk_...).
// A full secret key (sk_...) is refused before any request is made — restricted, read-only
// keys are the only kind this integration will use (see validateStripeKey).
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { providerKey } from "../provider-config";
import { financeDbPath, readTransactionsSince } from "./store";
import { LEGACY_NAB_LIVE_AUTHORISATION, legacyNabAdmission, type LegacyNabLiveAuthorisation } from "./legacy-admission";
import { dataDirFor } from "../cloud/data-dir";

export const STRIPE_SOURCE = "stripe";
const API_BASE = "https://api.stripe.com/v1";
/** Hard ceiling on list pages walked per resource in one sync — mirrors basiq.ts's
 *  MAX_TRANSACTION_PAGES so a misbehaving `has_more`/cursor can never loop forever. */
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

export class StripeConfigError extends Error {}
export class StripeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------------------

export function stripeApiKey(root: string, options: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  return providerKey(root, "STRIPE_RESTRICTED_KEY", options);
}

/** A full secret key (sk_...) can read AND write; this integration must never hold one. A
 *  restricted key's own permissions (configured in the Stripe dashboard when it's created)
 *  are what actually keep it read-only on Stripe's side — this check just refuses to use the
 *  wrong *kind* of key at all, before any request is attempted. */
export function validateStripeKey(key: string): { ok: true } | { ok: false; message: string } {
  if (!key) return { ok: false, message: "No Stripe key configured." };
  if (/^sk_/.test(key)) return { ok: false, message: "Use a restricted read-only key (rk_…)" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// Mapped shapes — Stripe amounts arrive as integer minor units (cents); `amount` below is
// always the major-unit float (e.g. 1999 cents -> 19.99), alongside the untouched `currency`.
// ---------------------------------------------------------------------------------------

const str = (value: unknown, max = 300): string => (typeof value === "string" ? value.slice(0, max) : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const cents = (value: unknown): number => { const n = num(value); return n === null ? 0 : Math.round(n) / 100; };
/** Stripe timestamps are Unix seconds or null; this project's other finance code (Basiq) uses
 *  ISO strings throughout, so every Stripe timestamp is normalised to ISO (or null) at the
 *  mapping boundary and nothing downstream has to know Stripe's convention. */
const iso = (unixSeconds: unknown): string | null => (typeof unixSeconds === "number" && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null);

export type StripeBalance = { availableAud: number; pendingAud: number; currency: string; checkedAt: string };

export type StripeBalanceTransaction = {
  id: string;
  type: string; // "charge" | "payout" | "refund" | "adjustment" | "payment" | …
  amount: number;
  currency: string;
  description: string;
  created: string | null;
  availableOn: string | null;
  status: string;
};

export type StripePayout = {
  id: string;
  amount: number;
  currency: string;
  status: string; // "paid" | "pending" | "in_transit" | "canceled" | "failed"
  arrivalDate: string | null;
  created: string | null;
  method: string;
  description: string;
};

export type StripeInvoice = {
  id: string;
  customerId: string;
  customerName: string;
  number: string;
  status: string; // "draft" | "open" | "paid" | "uncollectible" | "void"
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  currency: string;
  dueDate: string | null;
  created: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string;
};

export type StripeCharge = {
  id: string;
  amount: number;
  currency: string;
  status: string; // "succeeded" | "pending" | "failed"
  customerId: string;
  description: string;
  created: string | null;
  refunded: boolean;
};

export type StripeCustomer = { id: string; name: string; email: string; created: string | null };

export type StripeSubscription = {
  id: string;
  customerId: string;
  status: string; // "active" | "trialing" | "past_due" | "canceled" | "unpaid" | "incomplete"
  monthlyAmount: number; // normalised to a monthly figure regardless of billing interval
  currency: string;
  currentPeriodEnd: string | null;
  created: string | null;
};

function mapBalance(raw: any): StripeBalance {
  const available = Array.isArray(raw?.available) ? raw.available : [];
  const pending = Array.isArray(raw?.pending) ? raw.pending : [];
  const aud = (rows: any[]) => rows.filter((r) => str(r?.currency).toLowerCase() === "aud").reduce((sum, r) => sum + cents(r?.amount), 0);
  const currency = str(available[0]?.currency || pending[0]?.currency, 10).toLowerCase() || "aud";
  return { availableAud: aud(available), pendingAud: aud(pending), currency, checkedAt: new Date().toISOString() };
}

function mapBalanceTransaction(raw: any): StripeBalanceTransaction {
  return {
    id: str(raw?.id, 100),
    type: str(raw?.type, 40),
    amount: cents(raw?.amount),
    currency: str(raw?.currency, 10).toLowerCase() || "aud",
    description: str(raw?.description, 300),
    created: iso(raw?.created),
    availableOn: iso(raw?.available_on),
    status: str(raw?.status, 40),
  };
}

function mapPayout(raw: any): StripePayout {
  return {
    id: str(raw?.id, 100),
    amount: cents(raw?.amount),
    currency: str(raw?.currency, 10).toLowerCase() || "aud",
    status: str(raw?.status, 40) || "unknown",
    arrivalDate: iso(raw?.arrival_date),
    created: iso(raw?.created),
    method: str(raw?.method, 40),
    description: str(raw?.description, 300),
  };
}

function mapInvoice(raw: any): StripeInvoice {
  return {
    id: str(raw?.id, 100),
    customerId: str(raw?.customer, 100),
    customerName: str(raw?.customer_name, 200),
    number: str(raw?.number, 60),
    status: str(raw?.status, 40) || "unknown",
    amountDue: cents(raw?.amount_due),
    amountPaid: cents(raw?.amount_paid),
    amountRemaining: cents(raw?.amount_remaining),
    currency: str(raw?.currency, 10).toLowerCase() || "aud",
    dueDate: iso(raw?.due_date),
    created: iso(raw?.created),
    paidAt: iso(raw?.status_transitions?.paid_at),
    hostedInvoiceUrl: str(raw?.hosted_invoice_url, 500),
  };
}

function mapCharge(raw: any): StripeCharge {
  return {
    id: str(raw?.id, 100),
    amount: cents(raw?.amount),
    currency: str(raw?.currency, 10).toLowerCase() || "aud",
    status: str(raw?.status, 40) || "unknown",
    customerId: str(raw?.customer, 100),
    description: str(raw?.description, 300),
    created: iso(raw?.created),
    refunded: raw?.refunded === true,
  };
}

function mapCustomer(raw: any): StripeCustomer {
  return { id: str(raw?.id, 100), name: str(raw?.name, 200), email: str(raw?.email, 200), created: iso(raw?.created) };
}

/** Normalises every subscription item's price to a monthly amount (interval "day"/"week"
 *  scaled up, "year" scaled down) so subscriptions on different cadences can be summed into
 *  one MRR figure. `interval_count` (e.g. billed every 3 months) is honoured. */
function monthlyEquivalent(items: any[]): number {
  let total = 0;
  for (const item of items) {
    const price = item?.price;
    const unit = cents(price?.unit_amount) * (num(item?.quantity) ?? 1);
    const interval = str(price?.recurring?.interval, 10);
    const count = Math.max(1, num(price?.recurring?.interval_count) ?? 1);
    const perMonth =
      interval === "year" ? (unit / count) / 12 :
      interval === "week" ? (unit / count) * (52 / 12) :
      interval === "day" ? (unit / count) * (365.25 / 12) :
      unit / count; // "month" (the common case) or an unrecognised interval — default to as-is
    total += perMonth;
  }
  return Math.round(total * 100) / 100;
}

function mapSubscription(raw: any): StripeSubscription {
  const items = Array.isArray(raw?.items?.data) ? raw.items.data : [];
  return {
    id: str(raw?.id, 100),
    customerId: str(raw?.customer, 100),
    status: str(raw?.status, 40) || "unknown",
    monthlyAmount: monthlyEquivalent(items),
    currency: str(items[0]?.price?.currency, 10).toLowerCase() || "aud",
    currentPeriodEnd: iso(raw?.current_period_end),
    created: iso(raw?.created),
  };
}

// ---------------------------------------------------------------------------------------
// Read-only client — the only place fetch is called from. Every method here issues exactly
// one Stripe verb: GET. There is no method on the returned object that could issue a write.
// ---------------------------------------------------------------------------------------

export type StripeClientOptions = { root: string; env?: NodeJS.ProcessEnv; home?: string; fetchFn?: typeof fetch };

export function createStripeClient(options: StripeClientOptions) {
  const fetchFn = options.fetchFn ?? fetch;

  function rawKey(): string {
    return stripeApiKey(options.root, options);
  }

  function apiKey(): string {
    const key = rawKey();
    const check = validateStripeKey(key);
    if (!check.ok) {
      if (!key) throw new StripeConfigError("No Stripe key configured. Add STRIPE_RESTRICTED_KEY (rk_…) to ~/.config/agentic-os.env.");
      throw new StripeConfigError(check.message);
    }
    return key;
  }

  async function readError(res: Response): Promise<string> {
    try {
      const json: any = await res.json();
      const message = json?.error?.message;
      if (typeof message === "string" && message) return message;
    } catch { /* Body was not JSON; fall through to a generic message. */ }
    return `Stripe request failed (${res.status}).`;
  }

  /** The one and only place a network request is made from. `method` is a literal "GET" —
   *  there is no parameter that could turn this into a write. */
  async function stripeGet<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const res = await fetchFn(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${apiKey()}` } });
    if (!res.ok) throw new StripeApiError(await readError(res), res.status);
    return (await res.json().catch(() => ({}))) as T;
  }

  /** Walks Stripe's `has_more` / `starting_after` cursor pagination, bounded by MAX_PAGES. */
  async function listAll<T>(path: string, query: Record<string, string | number | undefined>, map: (raw: any) => T): Promise<T[]> {
    const results: T[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await stripeGet<any>(path, { ...query, limit: PAGE_SIZE, starting_after: startingAfter });
      const rows: any[] = Array.isArray(body?.data) ? body.data : [];
      for (const row of rows) results.push(map(row));
      if (!body?.has_more || rows.length === 0) break;
      startingAfter = str(rows[rows.length - 1]?.id, 100);
      if (!startingAfter) break;
    }
    return results;
  }

  return {
    configured(): boolean {
      return validateStripeKey(rawKey()).ok;
    },
    /** Present even when a key exists but is the wrong kind, so the UI can show *why* Stripe
     *  isn't connecting instead of a generic "not configured". Never throws. */
    keyStatus(): { present: boolean; ok: boolean; message: string | null } {
      const key = rawKey();
      const check = validateStripeKey(key);
      return { present: !!key, ok: check.ok, message: check.ok ? null : check.message };
    },
    async balance(): Promise<StripeBalance> {
      return mapBalance(await stripeGet<any>("/balance"));
    },
    async listBalanceTransactions(sinceUnixSeconds?: number): Promise<StripeBalanceTransaction[]> {
      return listAll("/balance_transactions", { "created[gte]": sinceUnixSeconds }, mapBalanceTransaction);
    },
    async listPayouts(sinceUnixSeconds?: number): Promise<StripePayout[]> {
      return listAll("/payouts", { "created[gte]": sinceUnixSeconds }, mapPayout);
    },
    /** All statuses (draft/open/paid/uncollectible/void) since `sinceUnixSeconds` — open vs
     *  paid vs overdue is classified locally in computeStripeSummary, not filtered here, so a
     *  single sync sees an invoice's full lifecycle. */
    async listInvoices(sinceUnixSeconds?: number): Promise<StripeInvoice[]> {
      return listAll("/invoices", { "created[gte]": sinceUnixSeconds }, mapInvoice);
    },
    async listCharges(sinceUnixSeconds?: number): Promise<StripeCharge[]> {
      return listAll("/charges", { "created[gte]": sinceUnixSeconds }, mapCharge);
    },
    async listCustomers(): Promise<StripeCustomer[]> {
      return listAll("/customers", {}, mapCustomer);
    },
    async listSubscriptions(): Promise<StripeSubscription[]> {
      return listAll("/subscriptions", { status: "all" }, mapSubscription);
    },
  };
}

export type StripeClient = ReturnType<typeof createStripeClient>;

// ---------------------------------------------------------------------------------------
// Local storage — own tables, namespaced `stripe_*`, inside the shared finance.sqlite file.
// Opened by openStripeDb below (same file path as store.ts; the NAB tables are never created here).
// ---------------------------------------------------------------------------------------

export function openStripeTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_balance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      available_aud REAL NOT NULL,
      pending_aud REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'aud',
      checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stripe_balance_transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'aud',
      description TEXT NOT NULL DEFAULT '',
      created TEXT,
      available_on TEXT,
      status TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    -- is_internal_transfer is always 1: a payout is money leaving Stripe for the owner's own
    -- bank account, never third-party income, so it must never be summed as revenue.
    -- matched_bank_transaction_id links it to the bank-side deposit once found (see
    -- matchPayoutsToBankDeposits) purely to avoid counting the same money twice; nothing here
    -- writes back to the bank-side transactions table.
    CREATE TABLE IF NOT EXISTS stripe_payouts (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'aud',
      status TEXT NOT NULL DEFAULT '',
      arrival_date TEXT,
      created TEXT,
      method TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      is_internal_transfer INTEGER NOT NULL DEFAULT 1,
      matched_bank_transaction_id TEXT,
      matched_at TEXT,
      synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS stripe_invoices (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '',
      number TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      amount_due REAL NOT NULL DEFAULT 0,
      amount_paid REAL NOT NULL DEFAULT 0,
      amount_remaining REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'aud',
      due_date TEXT,
      created TEXT,
      paid_at TEXT,
      hosted_invoice_url TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS stripe_charges (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'aud',
      status TEXT NOT NULL DEFAULT '',
      customer_id TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      created TEXT,
      refunded INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS stripe_customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      created TEXT,
      synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS stripe_subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      monthly_amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'aud',
      current_period_end TEXT,
      created TEXT,
      synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS stripe_invoices_status ON stripe_invoices(status);
    CREATE INDEX IF NOT EXISTS stripe_payouts_status ON stripe_payouts(status);
  `);
}

/** Opens the shared finance.sqlite file and ensures this module's own stripe_* tables exist on
 *  it. It never creates or migrates the NAB tables in that file (audit A-M2): those belong to
 *  the legacy NAB path, which is refused without the code-owned reviewed authorisation.
 *  Safe to call every time — every CREATE is IF NOT EXISTS. */
export function openStripeDb(root: string): Database {
  const file = financeDbPath(root);
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;");
  openStripeTables(db);
  return db;
}

function upsertBalance(db: Database, balance: StripeBalance): void {
  db.query(`
    INSERT INTO stripe_balance (id, available_aud, pending_aud, currency, checked_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET available_aud = excluded.available_aud, pending_aud = excluded.pending_aud, currency = excluded.currency, checked_at = excluded.checked_at
  `).run(balance.availableAud, balance.pendingAud, balance.currency, balance.checkedAt);
}

function upsertBalanceTransactions(db: Database, rows: StripeBalanceTransaction[]): void {
  const stmt = db.query(`
    INSERT INTO stripe_balance_transactions (id, type, amount, currency, description, created, available_on, status, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, amount = excluded.amount, currency = excluded.currency, description = excluded.description, created = excluded.created, available_on = excluded.available_on, status = excluded.status, synced_at = excluded.synced_at
  `);
  const run = db.transaction((items: StripeBalanceTransaction[]) => { for (const r of items) stmt.run(r.id, r.type, r.amount, r.currency, r.description, r.created, r.availableOn, r.status); });
  run(rows);
}

function upsertPayouts(db: Database, rows: StripePayout[]): void {
  const stmt = db.query(`
    INSERT INTO stripe_payouts (id, amount, currency, status, arrival_date, created, method, description, is_internal_transfer, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, status = excluded.status, arrival_date = excluded.arrival_date, created = excluded.created, method = excluded.method, description = excluded.description, synced_at = excluded.synced_at
  `);
  const run = db.transaction((items: StripePayout[]) => { for (const r of items) stmt.run(r.id, r.amount, r.currency, r.status, r.arrivalDate, r.created, r.method, r.description); });
  run(rows);
}

function upsertInvoices(db: Database, rows: StripeInvoice[]): void {
  const stmt = db.query(`
    INSERT INTO stripe_invoices (id, customer_id, customer_name, number, status, amount_due, amount_paid, amount_remaining, currency, due_date, created, paid_at, hosted_invoice_url, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET customer_id = excluded.customer_id, customer_name = excluded.customer_name, number = excluded.number, status = excluded.status, amount_due = excluded.amount_due, amount_paid = excluded.amount_paid, amount_remaining = excluded.amount_remaining, currency = excluded.currency, due_date = excluded.due_date, created = excluded.created, paid_at = excluded.paid_at, hosted_invoice_url = excluded.hosted_invoice_url, synced_at = excluded.synced_at
  `);
  const run = db.transaction((items: StripeInvoice[]) => { for (const r of items) stmt.run(r.id, r.customerId, r.customerName, r.number, r.status, r.amountDue, r.amountPaid, r.amountRemaining, r.currency, r.dueDate, r.created, r.paidAt, r.hostedInvoiceUrl); });
  run(rows);
}

function upsertCharges(db: Database, rows: StripeCharge[]): void {
  const stmt = db.query(`
    INSERT INTO stripe_charges (id, amount, currency, status, customer_id, description, created, refunded, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, status = excluded.status, customer_id = excluded.customer_id, description = excluded.description, created = excluded.created, refunded = excluded.refunded, synced_at = excluded.synced_at
  `);
  const run = db.transaction((items: StripeCharge[]) => { for (const r of items) stmt.run(r.id, r.amount, r.currency, r.status, r.customerId, r.description, r.created, r.refunded ? 1 : 0); });
  run(rows);
}

function upsertCustomers(db: Database, rows: StripeCustomer[]): void {
  const stmt = db.query(`
    INSERT INTO stripe_customers (id, name, email, created, synced_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, created = excluded.created, synced_at = excluded.synced_at
  `);
  const run = db.transaction((items: StripeCustomer[]) => { for (const r of items) stmt.run(r.id, r.name, r.email, r.created); });
  run(rows);
}

function upsertSubscriptions(db: Database, rows: StripeSubscription[]): void {
  const stmt = db.query(`
    INSERT INTO stripe_subscriptions (id, customer_id, status, monthly_amount, currency, current_period_end, created, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET customer_id = excluded.customer_id, status = excluded.status, monthly_amount = excluded.monthly_amount, currency = excluded.currency, current_period_end = excluded.current_period_end, created = excluded.created, synced_at = excluded.synced_at
  `);
  const run = db.transaction((items: StripeSubscription[]) => { for (const r of items) stmt.run(r.id, r.customerId, r.status, r.monthlyAmount, r.currency, r.currentPeriodEnd, r.created); });
  run(rows);
}

// ---------------------------------------------------------------------------------------
// Payout <-> bank deposit dedupe. A Stripe payout is the same money the bank later shows as
// a deposit; without this link, summing "Stripe revenue" and "bank income" would double-count
// every payout. This only ever links two already-stored rows — it never sums both.
// ---------------------------------------------------------------------------------------

export type StoredStripePayout = { id: string; amount: number; currency: string; status: string; arrivalDate: string | null; matchedBankTransactionId: string | null };

export function readStoredPayouts(db: Database): StoredStripePayout[] {
  return (db.query("SELECT id, amount, currency, status, arrival_date as arrivalDate, matched_bank_transaction_id as matchedBankTransactionId FROM stripe_payouts ORDER BY arrival_date DESC").all() as any[])
    .map((r) => ({ id: r.id, amount: r.amount, currency: r.currency, status: r.status, arrivalDate: r.arrivalDate, matchedBankTransactionId: r.matchedBankTransactionId }));
}

/** Amount must match to the cent; the bank deposit's post date must fall within `windowDays`
 *  of the payout's arrival date (payout timing and bank posting can be a business day or two
 *  apart). Each bank transaction is used for at most one payout. Pure function — takes the
 *  candidate rows and returns { payoutId, transactionId } links; the caller persists them. */
export function matchPayoutsToBank(
  payouts: Array<{ id: string; amount: number; arrivalDate: string | null; matchedBankTransactionId: string | null }>,
  bankCredits: Array<{ id: string; amount: number; postDate: string | null }>,
  options: { windowDays?: number } = {},
): Array<{ payoutId: string; transactionId: string }> {
  const windowDays = options.windowDays ?? 5;
  const usedTransactions = new Set<string>();
  const links: Array<{ payoutId: string; transactionId: string }> = [];
  for (const payout of payouts) {
    if (payout.matchedBankTransactionId || !payout.arrivalDate) continue;
    const arrivalMs = Date.parse(payout.arrivalDate);
    if (!Number.isFinite(arrivalMs)) continue;
    let best: { id: string; deltaMs: number } | undefined;
    for (const credit of bankCredits) {
      if (usedTransactions.has(credit.id) || !credit.postDate) continue;
      if (Math.round(credit.amount * 100) !== Math.round(payout.amount * 100)) continue;
      const postMs = Date.parse(credit.postDate);
      if (!Number.isFinite(postMs)) continue;
      const deltaMs = Math.abs(postMs - arrivalMs);
      if (deltaMs > windowDays * 86400000) continue;
      if (!best || deltaMs < best.deltaMs) best = { id: credit.id, deltaMs };
    }
    if (best) { links.push({ payoutId: payout.id, transactionId: best.id }); usedTransactions.add(best.id); }
  }
  return links;
}

function recordPayoutMatches(db: Database, links: Array<{ payoutId: string; transactionId: string }>): void {
  const stmt = db.query(`UPDATE stripe_payouts SET matched_bank_transaction_id = ?, matched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`);
  const run = db.transaction((rows: typeof links) => { for (const l of rows) stmt.run(l.transactionId, l.payoutId); });
  run(links);
}

export const BANK_MATCHING_DISABLED = "bank matching disabled" as const;
export type BankMatching = { matched: number; bankMatching: "enabled" | typeof BANK_MATCHING_DISABLED };

/** Reads bank credits from store.ts's own NAB `transactions` table (read-only) and Stripe payouts
 *  from this file's own table, links what it can, and persists the links on the Stripe side.
 *  The bank read is NAB store access, so it needs the legacy NAB "summary" admission (audit
 *  A-M2); refused, nothing is read and the result says "bank matching disabled". Already-linked
 *  payouts are skipped (see matchPayoutsToBank's `matchedBankTransactionId` guard). */
export function reconcilePayoutsWithBank(db: Database, sinceIso: string,
  authorisation: LegacyNabLiveAuthorisation | null = LEGACY_NAB_LIVE_AUTHORISATION, now: Date = new Date()): BankMatching {
  if (!legacyNabAdmission("summary", authorisation, now).admitted) return { matched: 0, bankMatching: BANK_MATCHING_DISABLED };
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get()) return { matched: 0, bankMatching: "enabled" };
  const payouts = readStoredPayouts(db).filter((p) => p.status === "paid");
  const bankCredits = readTransactionsSince(db, sinceIso).filter((t) => t.direction === "credit").map((t) => ({ id: t.id, amount: t.amount, postDate: t.postDate }));
  const links = matchPayoutsToBank(payouts, bankCredits);
  if (links.length) recordPayoutMatches(db, links);
  return { matched: links.length, bankMatching: "enabled" };
}

// ---------------------------------------------------------------------------------------
// Summary — everything the (currently gated) UI will read once the shared finance files are
// safe to touch. Pure reads against the tables above; never calls Stripe.
// ---------------------------------------------------------------------------------------

export type StripeSummary = {
  configured: boolean;
  revenueThisMonthAud: number;
  invoices: { paidCount: number; paidAud: number; outstandingCount: number; outstandingAud: number };
  overdueInvoices: Array<{ id: string; number: string; customerName: string; amountDue: number; daysOverdue: number }>;
  nextPayout: { amount: number; arrivalDate: string } | null;
  mrrAud: number | null; // null when there are no active/trialing subscriptions
  lastSyncedAt: string | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeStripeSummary(db: Database, configured: boolean, now = new Date()): StripeSummary {
  // UTC month boundary, not the host machine's local timezone — deterministic wherever this
  // runs. (sync.ts uses an Australia/Sydney day boundary for its own "today"/"this week"
  // splits; a UTC month boundary is close enough for a summary card and doesn't require
  // importing a Basiq-specific helper into this self-contained module.)
  const monthStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const charges = (db.query("SELECT amount FROM stripe_charges WHERE status = 'succeeded' AND refunded = 0 AND created >= ?").all(monthStartIso) as Array<{ amount: number }>);
  const revenueThisMonthAud = round2(charges.reduce((sum, c) => sum + c.amount, 0));

  const invoiceRows = db.query("SELECT id, number, customer_name as customerName, status, amount_due as amountDue, due_date as dueDate FROM stripe_invoices").all() as Array<{ id: string; number: string; customerName: string; status: string; amountDue: number; dueDate: string | null }>;
  const paid = invoiceRows.filter((r) => r.status === "paid");
  const outstanding = invoiceRows.filter((r) => r.status === "open");
  const nowMs = now.getTime();
  const overdueInvoices = outstanding
    .filter((r) => r.dueDate && Date.parse(r.dueDate) < nowMs)
    .map((r) => ({ id: r.id, number: r.number, customerName: r.customerName, amountDue: r.amountDue, daysOverdue: Math.floor((nowMs - Date.parse(r.dueDate!)) / 86400000) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const nextPayoutRow = db.query("SELECT amount, arrival_date as arrivalDate FROM stripe_payouts WHERE status IN ('pending','in_transit') AND arrival_date IS NOT NULL ORDER BY arrival_date ASC LIMIT 1").get() as { amount: number; arrivalDate: string } | null;

  const subscriptionRows = db.query("SELECT monthly_amount as monthlyAmount FROM stripe_subscriptions WHERE status IN ('active','trialing')").all() as Array<{ monthlyAmount: number }>;
  const mrrAud = subscriptionRows.length ? round2(subscriptionRows.reduce((sum, s) => sum + s.monthlyAmount, 0)) : null;

  const lastSynced = db.query("SELECT MAX(synced_at) as at FROM stripe_charges").get() as { at: string | null } | null;

  return {
    configured,
    revenueThisMonthAud,
    invoices: {
      paidCount: paid.length,
      paidAud: round2(paid.reduce((sum, r) => sum + r.amountDue, 0)),
      outstandingCount: outstanding.length,
      outstandingAud: round2(outstanding.reduce((sum, r) => sum + r.amountDue, 0)),
    },
    overdueInvoices,
    nextPayout: nextPayoutRow ? { amount: nextPayoutRow.amount, arrivalDate: nextPayoutRow.arrivalDate } : null,
    mrrAud,
    lastSyncedAt: lastSynced?.at ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// Orchestration — mirrors sync.ts's createFinanceSync shape so a future UI wiring (once the
// CSV-importer coordination gate clears) can follow the exact same pattern Basiq/NAB uses.
// ---------------------------------------------------------------------------------------

const SYNC_WINDOW_DAYS = 365; // A year of history is enough for MRR/overdue/monthly-revenue maths without an unbounded pull.

export function createStripeSync(root: string, options: { client?: StripeClient; db?: Database; now?: () => Date;
  /** Code-level injection only (tests): the legacy NAB authorisation for payout-to-bank matching. */
  authorisation?: LegacyNabLiveAuthorisation | null } = {}) {
  const client = options.client ?? createStripeClient({ root });
  // Lazy (audit A-M2): constructing this at boot opens nothing; the first sync or summary does.
  let dbHandle = options.db, owned = false;
  const db = () => { if (!dbHandle) { dbHandle = openStripeDb(root); owned = true; } return dbHandle; };
  const clock = () => options.now?.() ?? new Date();
  const authorisation = options.authorisation === undefined ? LEGACY_NAB_LIVE_AUTHORISATION : options.authorisation;

  return {
    configured(): boolean {
      return client.configured();
    },
    keyStatus() {
      return client.keyStatus();
    },
    async sync(): Promise<{ summary: StripeSummary } & BankMatching> {
      const now = clock();
      const sinceUnixSeconds = Math.floor((now.getTime() - SYNC_WINDOW_DAYS * 86400000) / 1000);
      const [balance, balanceTransactions, payouts, invoices, charges, customers, subscriptions] = await Promise.all([
        client.balance(),
        client.listBalanceTransactions(sinceUnixSeconds),
        client.listPayouts(sinceUnixSeconds),
        client.listInvoices(sinceUnixSeconds),
        client.listCharges(sinceUnixSeconds),
        client.listCustomers(),
        client.listSubscriptions(),
      ]);
      const store = db();
      upsertBalance(store, balance);
      upsertBalanceTransactions(store, balanceTransactions);
      upsertPayouts(store, payouts);
      upsertInvoices(store, invoices);
      upsertCharges(store, charges);
      upsertCustomers(store, customers);
      upsertSubscriptions(store, subscriptions);
      const bank = reconcilePayoutsWithBank(store, new Date(now.getTime() - SYNC_WINDOW_DAYS * 86400000).toISOString(), authorisation, now);
      return { summary: computeStripeSummary(store, true, now), ...bank };
    },
    /** Reads only what's already stored — no Stripe call. */
    summary(): StripeSummary {
      return computeStripeSummary(db(), client.configured(), clock());
    },
    /** Releases a handle this instance opened itself (a caller-supplied db is the caller's). */
    close(): void {
      if (owned) dbHandle?.close();
      dbHandle = undefined; owned = false;
    },
  };
}

export type StripeSync = ReturnType<typeof createStripeSync>;

// Re-export so callers (e.g. a future UI hook, or Jarvis) don't need to import from node:fs /
// node:path themselves just to check whether .operator-data exists yet.
export function ensureOperatorDataDir(root: string): void {
  const dir = join(dataDirFor(root));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** True when a readable STRIPE_RESTRICTED_KEY-shaped line exists in the keys file at all
 *  (used only for a friendlier "you have a key but it's the wrong kind" message upstream —
 *  never used to decide whether to make a request). */
export function hasAnyStripeKeyLine(root: string, home: string): boolean {
  try {
    return /^\s*(?:export\s+)?STRIPE_RESTRICTED_KEY\s*=/m.test(readFileSync(join(home, ".config/agentic-os.env"), "utf8"));
  } catch {
    return false;
  }
}
