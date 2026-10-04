// Local SQLite storage for NAB (via Basiq) accounts and transactions. Everything here stays
// on this computer — .operator-data/finance.sqlite is never committed and never leaves the
// machine. Upserts key on Basiq's own ids, so a repeated sync is always idempotent: replaying
// the same page of accounts or transactions changes nothing.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BasiqAccount, BasiqTransaction } from "./basiq";
import { dataDirFor } from "../cloud/data-dir";

export function financeDbPath(root: string): string {
  return join(dataDirFor(root), "finance.sqlite");
}

export function openFinanceDb(file: string): Database {
  // Skip for ":memory:" (used by tests) and when the directory is already there: on Windows,
  // mkdirSync(..., { recursive: true }) can still throw EEXIST for an existing single-segment
  // relative directory, which "." resolves to for an in-memory path.
  const dir = dirname(file);
  if (file !== ":memory:" && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      account_no TEXT NOT NULL DEFAULT '',
      balance REAL NOT NULL,
      available_funds REAL,
      currency TEXT NOT NULL DEFAULT 'AUD',
      institution_id TEXT NOT NULL DEFAULT '',
      connection_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      last_updated TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'basiq',
      synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL DEFAULT '',
      connection_id TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL,
      direction TEXT NOT NULL DEFAULT 'credit',
      description TEXT NOT NULL DEFAULT '',
      post_date TEXT,
      transaction_date TEXT,
      status TEXT NOT NULL DEFAULT 'posted',
      class TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'basiq',
      synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS transactions_post_date ON transactions(post_date);
    CREATE INDEX IF NOT EXISTS transactions_account ON transactions(account_id);
    -- A matched incoming credit against a locally-known open invoice. confidence is 0..1;
    -- nothing here ever writes back to an external invoicing system.
    CREATE TABLE IF NOT EXISTS invoice_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      matched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(invoice_id, transaction_id)
    );
  `);
  // Migration for a finance.sqlite created before "source" existed (distinguishes Basiq's own
  // sync from a locally-imported NAB CSV — see the retired csv-import.ts; NAB CSV now goes to finance-manual.sqlite). CREATE TABLE IF NOT EXISTS above
  // only adds the column to a brand-new file, so an existing one needs it added by hand.
  for (const table of ["accounts", "transactions"]) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "source")) db.exec(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT 'basiq'`);
  }
  return db;
}

/** `source` tags where a row came from — Basiq's own sync ("basiq", the default) or a locally
 *  imported NAB CSV ("nab-csv", see the retired csv-import.ts; NAB CSV now goes to finance-manual.sqlite). Re-upserting an id from a different source
 *  (e.g. Basiq eventually connecting to an account first seen via CSV) simply relabels it. */
export function upsertAccounts(db: Database, accounts: BasiqAccount[], source = "basiq"): void {
  const stmt = db.query(`
    INSERT INTO accounts (id, name, account_no, balance, available_funds, currency, institution_id, connection_id, status, last_updated, source, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, account_no = excluded.account_no, balance = excluded.balance,
      available_funds = excluded.available_funds, currency = excluded.currency,
      institution_id = excluded.institution_id, connection_id = excluded.connection_id,
      status = excluded.status, last_updated = excluded.last_updated, source = excluded.source, synced_at = excluded.synced_at
  `);
  const run = db.transaction((rows: BasiqAccount[]) => {
    for (const account of rows) stmt.run(account.id, account.name, account.accountNo, account.balance, account.availableFunds, account.currency, account.institutionId, account.connectionId, account.status, account.lastUpdated, source);
  });
  run(accounts);
}

export function upsertTransactions(db: Database, transactions: BasiqTransaction[], source = "basiq"): number {
  const stmt = db.query(`
    INSERT INTO transactions (id, account_id, connection_id, amount, direction, description, post_date, transaction_date, status, class, source, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      account_id = excluded.account_id, connection_id = excluded.connection_id, amount = excluded.amount,
      direction = excluded.direction, description = excluded.description, post_date = excluded.post_date,
      transaction_date = excluded.transaction_date, status = excluded.status, class = excluded.class, source = excluded.source, synced_at = excluded.synced_at
  `);
  let changed = 0;
  const run = db.transaction((rows: BasiqTransaction[]) => {
    for (const tx of rows) { stmt.run(tx.id, tx.accountId, tx.connectionId, tx.amount, tx.direction, tx.description, tx.postDate, tx.transactionDate, tx.status, tx.class, source); changed++; }
  });
  run(transactions);
  return changed;
}

export type StoredAccount = { id: string; name: string; balance: number; currency: string; status: string };
export function readAccounts(db: Database): StoredAccount[] {
  return (db.query("SELECT id, name, balance, currency, status FROM accounts ORDER BY name").all() as any[]).map((r) => ({ id: r.id, name: r.name, balance: r.balance, currency: r.currency, status: r.status }));
}

export type StoredTransaction = { id: string; accountId: string; amount: number; direction: "debit" | "credit"; description: string; postDate: string | null; status: string; class: string };
/** Posted credits (money in) with a post date on or after `sinceIso`, oldest first. */
export function readCreditsSince(db: Database, sinceIso: string): StoredTransaction[] {
  return (db.query("SELECT id, account_id as accountId, amount, direction, description, post_date as postDate, status, class FROM transactions WHERE direction = 'credit' AND status = 'posted' AND post_date IS NOT NULL AND post_date >= ? ORDER BY post_date ASC").all(sinceIso) as any[])
    .map((r) => ({ id: r.id, accountId: r.accountId, amount: r.amount, direction: "credit" as const, description: r.description, postDate: r.postDate, status: r.status, class: r.class }));
}
/** All posted transactions (both directions) with a post date on or after `sinceIso`, oldest first — the input to the income/spend/runway maths. */
export function readTransactionsSince(db: Database, sinceIso: string): StoredTransaction[] {
  return (db.query("SELECT id, account_id as accountId, amount, direction, description, post_date as postDate, status, class FROM transactions WHERE status = 'posted' AND post_date IS NOT NULL AND post_date >= ? ORDER BY post_date ASC").all(sinceIso) as any[])
    .map((r) => ({ id: r.id, accountId: r.accountId, amount: r.amount, direction: r.direction === "debit" ? "debit" as const : "credit" as const, description: r.description, postDate: r.postDate, status: r.status, class: r.class }));
}

export function recordInvoiceMatches(db: Database, matches: Array<{ invoiceId: string; transactionId: string; confidence: number; reason: string }>): void {
  const stmt = db.query(`
    INSERT INTO invoice_matches (invoice_id, transaction_id, confidence, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(invoice_id, transaction_id) DO UPDATE SET confidence = excluded.confidence, reason = excluded.reason
  `);
  const run = db.transaction((rows: typeof matches) => { for (const m of rows) stmt.run(m.invoiceId, m.transactionId, m.confidence, m.reason); });
  run(matches);
}

export type StoredInvoiceMatch = { invoiceId: string; transactionId: string; confidence: number; reason: string; matchedAt: string };
export function readInvoiceMatches(db: Database): StoredInvoiceMatch[] {
  return (db.query("SELECT invoice_id as invoiceId, transaction_id as transactionId, confidence, reason, matched_at as matchedAt FROM invoice_matches ORDER BY matched_at DESC").all() as any[]);
}
