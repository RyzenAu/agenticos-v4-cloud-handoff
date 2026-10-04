import { expect, test } from "bun:test";
import { openFinanceDb, upsertTransactions } from "./store";
import type { BasiqTransaction } from "./basiq";
import {
  StripeApiError,
  StripeConfigError,
  createStripeClient,
  createStripeSync,
  matchPayoutsToBank,
  openStripeTables,
  reconcilePayoutsWithBank,
  validateStripeKey,
} from "./stripe";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function freshDb() {
  const db = openFinanceDb(":memory:");
  openStripeTables(db);
  return db;
}

const tx = (over: Partial<BasiqTransaction> = {}): BasiqTransaction => ({
  id: "bank-1", accountId: "a1", connectionId: "c1", amount: 550, direction: "credit",
  description: "Stripe payout", postDate: "2026-09-20T00:00:00Z", transactionDate: "2026-09-20T00:00:00Z",
  status: "posted", class: "transfer", ...over,
});

// --- Key handling: sk_ rejection ---------------------------------------------------------

test("validateStripeKey refuses a full secret key and accepts a restricted one", () => {
  expect(validateStripeKey("sk_live_abc123")).toEqual({ ok: false, message: "Use a restricted read-only key (rk_…)" });
  expect(validateStripeKey("sk_test_abc123")).toEqual({ ok: false, message: "Use a restricted read-only key (rk_…)" });
  expect(validateStripeKey("")).toEqual({ ok: false, message: "No Stripe key configured." });
  expect(validateStripeKey("rk_live_readonly123")).toEqual({ ok: true });
});

test("a client configured with a full secret key refuses to make any request", async () => {
  const calls: string[] = [];
  const client = createStripeClient({
    root: "/synthetic",
    env: { STRIPE_RESTRICTED_KEY: "sk_live_full_access" },
    fetchFn: (async (url: string) => { calls.push(String(url)); throw new Error("should not fetch"); }) as any,
  });
  expect(client.configured()).toBe(false);
  expect(client.keyStatus()).toEqual({ present: true, ok: false, message: "Use a restricted read-only key (rk_…)" });
  await expect(client.balance()).rejects.toBeInstanceOf(StripeConfigError);
  await expect(client.balance()).rejects.toThrow("Use a restricted read-only key (rk_…)");
  expect(calls).toEqual([]);
});

test("without any key every call fails with a clear configuration error, never a network call", async () => {
  const calls: string[] = [];
  const client = createStripeClient({
    root: "/synthetic",
    env: {},
    home: "/nowhere",
    fetchFn: (async (url: string) => { calls.push(String(url)); throw new Error("should not fetch"); }) as any,
  });
  expect(client.configured()).toBe(false);
  await expect(client.listPayouts()).rejects.toBeInstanceOf(StripeConfigError);
  expect(calls).toEqual([]);
});

// --- GET-only enforcement -----------------------------------------------------------------

test("the client exposes no write-capable method at all", () => {
  const client = createStripeClient({ root: "/synthetic", env: { STRIPE_RESTRICTED_KEY: "rk_live_x" } });
  const methodNames = Object.keys(client);
  expect(methodNames).toEqual(["configured", "keyStatus", "balance", "listBalanceTransactions", "listPayouts", "listInvoices", "listCharges", "listCustomers", "listSubscriptions"]);
  const writeShaped = /create|update|delete|remove|refund|cancel|post|put|patch|write|charge$|capture|void/i;
  for (const name of methodNames) expect(name).not.toMatch(writeShaped);
});

test("every request the client makes is a GET, whatever method a caller might have hoped for", async () => {
  const methodsSeen: string[] = [];
  const fetchFn = (async (_url: string, init: any) => {
    methodsSeen.push(init?.method ?? "GET");
    if (String(_url).includes("/balance")) return jsonResponse({ available: [{ amount: 1000, currency: "aud" }], pending: [] });
    return jsonResponse({ data: [], has_more: false });
  }) as any;
  const client = createStripeClient({ root: "/synthetic", env: { STRIPE_RESTRICTED_KEY: "rk_live_x" }, fetchFn });
  await client.balance();
  await client.listBalanceTransactions();
  await client.listPayouts();
  await client.listInvoices();
  await client.listCharges();
  await client.listCustomers();
  await client.listSubscriptions();
  expect(methodsSeen.length).toBeGreaterThan(0);
  expect(methodsSeen.every((m) => m === "GET")).toBe(true);
});

test("a failed request surfaces Stripe's own error message and status, and never retries as a write", async () => {
  const fetchFn = (async () => jsonResponse({ error: { message: "Invalid API Key provided." } }, 401)) as any;
  const client = createStripeClient({ root: "/synthetic", env: { STRIPE_RESTRICTED_KEY: "rk_live_x" }, fetchFn });
  await expect(client.balance()).rejects.toBeInstanceOf(StripeApiError);
  try { await client.balance(); } catch (error) { expect((error as StripeApiError).status).toBe(401); }
});

// --- Successful sync into SQLite -----------------------------------------------------------

function mockFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/balance_transactions")) return jsonResponse({ data: [{ id: "btxn_1", type: "charge", amount: 5000, currency: "aud", description: "Payment", created: 1789430400 }], has_more: false });
    if (u.includes("/balance")) return jsonResponse({ available: [{ amount: 12000, currency: "aud" }], pending: [{ amount: 3000, currency: "aud" }] });
    if (u.includes("/payouts")) return jsonResponse({ data: [{ id: "po_1", amount: 550000, currency: "aud", status: "paid", arrival_date: 1789862400, created: 1789776000, method: "standard" }], has_more: false });
    if (u.includes("/invoices")) return jsonResponse({
      data: [
        { id: "in_paid", customer: "cus_1", customer_name: "Acme Pty Ltd", number: "INV-001", status: "paid", amount_due: 100000, amount_paid: 100000, amount_remaining: 0, currency: "aud", due_date: 1789430400, created: 1786752000, status_transitions: { paid_at: 1787961600 }, hosted_invoice_url: "https://invoice.stripe.com/i/1" },
        { id: "in_overdue", customer: "cus_2", customer_name: "Beta Co", number: "INV-002", status: "open", amount_due: 50000, amount_paid: 0, amount_remaining: 50000, currency: "aud", due_date: 1735689600, created: 1735084800, hosted_invoice_url: "https://invoice.stripe.com/i/2" },
      ],
      has_more: false,
    });
    if (u.includes("/charges")) return jsonResponse({ data: [{ id: "ch_1", amount: 100000, currency: "aud", status: "succeeded", customer: "cus_1", description: "Invoice payment", created: 1789430400, refunded: false }], has_more: false });
    if (u.includes("/customers")) return jsonResponse({ data: [{ id: "cus_1", name: "Acme Pty Ltd", email: "billing@acme.example", created: 1750000000 }], has_more: false });
    if (u.includes("/subscriptions")) return jsonResponse({ data: [{ id: "sub_1", customer: "cus_1", status: "active", current_period_end: 1760000000, created: 1750000000, items: { data: [{ price: { unit_amount: 9900, currency: "aud", recurring: { interval: "month", interval_count: 1 } }, quantity: 1 }] } }], has_more: false });
    throw new Error(`unexpected url ${u}`);
  }) as any;
}

test("sync() writes every resource into its own stripe_* table and computes a summary from what's stored", async () => {
  const db = freshDb();
  const client = createStripeClient({ root: "/synthetic", env: { STRIPE_RESTRICTED_KEY: "rk_live_x" }, fetchFn: mockFetch() });
  const sync = createStripeSync("/synthetic", { client, db, now: () => new Date("2026-09-24T00:00:00Z") });
  expect(sync.configured()).toBe(true);
  const { summary } = await sync.sync();

  expect((db.query("SELECT COUNT(*) as n FROM stripe_balance_transactions").get() as any).n).toBe(1);
  expect((db.query("SELECT COUNT(*) as n FROM stripe_payouts").get() as any).n).toBe(1);
  expect((db.query("SELECT COUNT(*) as n FROM stripe_invoices").get() as any).n).toBe(2);
  expect((db.query("SELECT COUNT(*) as n FROM stripe_charges").get() as any).n).toBe(1);
  expect((db.query("SELECT COUNT(*) as n FROM stripe_customers").get() as any).n).toBe(1);
  expect((db.query("SELECT COUNT(*) as n FROM stripe_subscriptions").get() as any).n).toBe(1);

  expect(summary.revenueThisMonthAud).toBe(1000); // the one succeeded, non-refunded charge this month
  expect(summary.invoices).toEqual({ paidCount: 1, paidAud: 1000, outstandingCount: 1, outstandingAud: 500 });
  expect(summary.overdueInvoices).toHaveLength(1);
  expect(summary.overdueInvoices[0]).toMatchObject({ id: "in_overdue", customerName: "Beta Co" });
  expect(summary.overdueInvoices[0].daysOverdue).toBeGreaterThan(0);
  expect(summary.mrrAud).toBe(99);
  expect(summary.nextPayout).toBeNull(); // the one payout is already "paid", not upcoming

  // Re-running the sync must not duplicate rows (idempotent upsert, same as Basiq's).
  await sync.sync();
  expect((db.query("SELECT COUNT(*) as n FROM stripe_invoices").get() as any).n).toBe(2);
});

test("summary() reads only what is already stored and never touches the network", () => {
  const db = freshDb();
  const sync = createStripeSync("/synthetic", { client: createStripeClient({ root: "/synthetic", env: {} }), db, now: () => new Date("2026-09-24T00:00:00Z") });
  const summary = sync.summary();
  expect(summary).toEqual({
    configured: false,
    revenueThisMonthAud: 0,
    invoices: { paidCount: 0, paidAud: 0, outstandingCount: 0, outstandingAud: 0 },
    overdueInvoices: [],
    nextPayout: null,
    mrrAud: null,
    lastSyncedAt: null,
  });
});

// --- Payout / bank-transaction dedupe -------------------------------------------------------

test("matchPayoutsToBank links a payout to the one bank deposit with the same amount inside the date window", () => {
  const links = matchPayoutsToBank(
    [{ id: "po_1", amount: 550, arrivalDate: "2026-09-20T00:00:00Z", matchedBankTransactionId: null }],
    [
      { id: "bank-wrong-amount", amount: 999, postDate: "2026-09-20T00:00:00Z" },
      { id: "bank-too-late", amount: 550, postDate: "2026-10-05T00:00:00Z" },
      { id: "bank-match", amount: 550, postDate: "2026-09-22T00:00:00Z" },
    ],
  );
  expect(links).toEqual([{ payoutId: "po_1", transactionId: "bank-match" }]);
});

test("matchPayoutsToBank never reuses a bank transaction for two payouts, and skips already-matched payouts", () => {
  const links = matchPayoutsToBank(
    [
      { id: "po_1", amount: 200, arrivalDate: "2026-09-20T00:00:00Z", matchedBankTransactionId: null },
      { id: "po_2", amount: 200, arrivalDate: "2026-09-21T00:00:00Z", matchedBankTransactionId: null },
      { id: "po_already", amount: 200, arrivalDate: "2026-09-20T00:00:00Z", matchedBankTransactionId: "some-old-link" },
    ],
    [{ id: "bank-1", amount: 200, postDate: "2026-09-20T00:00:00Z" }],
  );
  expect(links).toEqual([{ payoutId: "po_1", transactionId: "bank-1" }]);
});

// A synthetic reviewed authorisation, injected in code only (never env/config/request input).
const SYNTHETIC_SUMMARY_AUTHORISATION = {
  kind: "legacy-nab-live-authorisation/v1", reviewRef: "synthetic-test", reviewedBy: "synthetic-test",
  reviewedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z", provider: "basiq", capabilities: ["summary"],
} as const;

test("reconcilePayoutsWithBank reads the bank's own transactions table read-only and records the link on the Stripe side only", async () => {
  const db = freshDb();
  upsertTransactions(db, [tx({ id: "bank-1", amount: 550, direction: "credit", postDate: "2026-09-22T00:00:00Z" })]);
  const client = createStripeClient({
    root: "/synthetic",
    env: { STRIPE_RESTRICTED_KEY: "rk_live_x" },
    fetchFn: (async (url: string) => {
      const u = String(url);
      if (u.includes("/payouts")) return jsonResponse({ data: [{ id: "po_1", amount: 55000, currency: "aud", status: "paid", arrival_date: 1789862400, created: 1789776000, method: "standard" }], has_more: false });
      if (u.includes("/balance_transactions") || u.includes("/invoices") || u.includes("/charges") || u.includes("/customers") || u.includes("/subscriptions")) return jsonResponse({ data: [], has_more: false });
      if (u.includes("/balance")) return jsonResponse({ available: [], pending: [] });
      throw new Error(`unexpected url ${u}`);
    }) as any,
  });
  const sync = createStripeSync("/synthetic", { client, db, now: () => new Date("2026-09-24T00:00:00Z"), authorisation: SYNTHETIC_SUMMARY_AUTHORISATION });
  const { matched, bankMatching } = await sync.sync();
  expect(matched).toBe(1);
  expect(bankMatching).toBe("enabled");

  const bankRowUnchanged = db.query("SELECT direction, amount FROM transactions WHERE id = 'bank-1'").get() as any;
  expect(bankRowUnchanged).toEqual({ direction: "credit", amount: 550 });

  const payoutRow = db.query("SELECT matched_bank_transaction_id as m, is_internal_transfer as t FROM stripe_payouts WHERE id = 'po_1'").get() as any;
  expect(payoutRow).toEqual({ m: "bank-1", t: 1 });
});
