import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openFinanceDb, readAccounts, readCreditsSince, readTransactionsSince, recordInvoiceMatches, readInvoiceMatches, upsertAccounts, upsertTransactions } from "./store";
import type { BasiqAccount, BasiqTransaction } from "./basiq";

function freshDb(): Database {
  return openFinanceDb(":memory:");
}

const account = (over: Partial<BasiqAccount> = {}): BasiqAccount => ({ id: "a1", name: "Business account", accountNo: "083-123 456789", balance: 1000, availableFunds: 950, currency: "AUD", institutionId: "AU00NAB", connectionId: "c1", status: "available", lastUpdated: "2026-09-24T00:00:00Z", ...over });
const tx = (over: Partial<BasiqTransaction> = {}): BasiqTransaction => ({ id: "t1", accountId: "a1", connectionId: "c1", amount: 100, direction: "credit", description: "Invoice payment", postDate: "2026-09-20T00:00:00Z", transactionDate: "2026-09-19T00:00:00Z", status: "posted", class: "payment", ...over });

test("upserting the same account twice leaves exactly one row, updated to the latest balance", () => {
  const db = freshDb();
  upsertAccounts(db, [account({ balance: 1000 })]);
  upsertAccounts(db, [account({ balance: 1234.56, name: "Business account (renamed)" })]);
  const rows = readAccounts(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ id: "a1", name: "Business account (renamed)", balance: 1234.56, currency: "AUD", status: "available" });
});

test("upserting the same transaction twice never duplicates it, and re-running a whole page changes nothing", () => {
  const db = freshDb();
  upsertTransactions(db, [tx(), tx({ id: "t2", amount: 50 })]);
  upsertTransactions(db, [tx(), tx({ id: "t2", amount: 50 })]);
  const rows = readTransactionsSince(db, "2026-01-01T00:00:00Z");
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.id).sort()).toEqual(["t1", "t2"]);
});

test("readCreditsSince only returns posted credits within the window", () => {
  const db = freshDb();
  upsertTransactions(db, [
    tx({ id: "credit-in", direction: "credit", postDate: "2026-09-20T00:00:00Z" }),
    tx({ id: "credit-old", direction: "credit", postDate: "2026-01-01T00:00:00Z" }),
    tx({ id: "debit", direction: "debit", postDate: "2026-09-20T00:00:00Z" }),
    tx({ id: "pending", direction: "credit", postDate: null, status: "pending" }),
  ]);
  const rows = readCreditsSince(db, "2026-09-01T00:00:00Z");
  expect(rows.map((r) => r.id)).toEqual(["credit-in"]);
});

test("accounts and transactions default to source 'basiq', and a CSV import can tag them 'nab-csv' instead", () => {
  const db = freshDb();
  upsertAccounts(db, [account()]);
  upsertTransactions(db, [tx()]);
  upsertAccounts(db, [account({ id: "a2" })], "nab-csv");
  upsertTransactions(db, [tx({ id: "t2" })], "nab-csv");
  const sources = (db.query("SELECT id, source FROM accounts ORDER BY id").all() as Array<{ id: string; source: string }>);
  expect(sources).toEqual([{ id: "a1", source: "basiq" }, { id: "a2", source: "nab-csv" }]);
  const txSources = (db.query("SELECT id, source FROM transactions ORDER BY id").all() as Array<{ id: string; source: string }>);
  expect(txSources).toEqual([{ id: "t1", source: "basiq" }, { id: "t2", source: "nab-csv" }]);
});

test("invoice matches are idempotent by (invoice, transaction) and confidence can be revised", () => {
  const db = freshDb();
  recordInvoiceMatches(db, [{ invoiceId: "inv-1", transactionId: "t1", confidence: 0.55, reason: "amount only" }]);
  recordInvoiceMatches(db, [{ invoiceId: "inv-1", transactionId: "t1", confidence: 0.97, reason: "amount, reference and date" }]);
  const rows = readInvoiceMatches(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ invoiceId: "inv-1", transactionId: "t1", confidence: 0.97 });
});
