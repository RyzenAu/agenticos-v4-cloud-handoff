import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFinanceDb, upsertTransactions } from "./store";
import { buildImportSnapshot, computeSummary, createFinanceSync, sydneyMidnightUtc } from "./sync";
import type { BasiqAccount, BasiqTransaction } from "./basiq";
import type { LegacyNabLiveAuthorisation } from "./legacy-admission";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "finance-sync-"));
}

/** Legacy NAB is fail-closed (see legacy-admission.ts). These tests exercise the admitted
 *  behaviour, so they inject a synthetic code-level record; production reads only the
 *  code-owned constant, which is null. */
const syntheticAuthorisation = (at = new Date()): LegacyNabLiveAuthorisation => ({
  kind: "legacy-nab-live-authorisation/v1", reviewRef: "synthetic-test-only", reviewedBy: "sync.test",
  reviewedAt: new Date(at.getTime() - 86400000).toISOString(), expiresAt: new Date(at.getTime() + 30 * 86400000).toISOString(),
  provider: "basiq", capabilities: ["status", "connect", "sync", "summary", "import-csv", "schedule"],
});

const account = (over: Partial<BasiqAccount> = {}): BasiqAccount => ({ id: "a1", name: "Business account", accountNo: "", balance: 5000, availableFunds: 4900, currency: "AUD", institutionId: "AU00NAB", connectionId: "c1", status: "available", lastUpdated: "", ...over });
const tx = (over: Partial<BasiqTransaction> = {}): BasiqTransaction => ({ id: "t1", accountId: "a1", connectionId: "c1", amount: 100, direction: "credit", description: "Payment", postDate: "2026-09-24T01:00:00Z", transactionDate: null, status: "posted", class: "payment", ...over });

// 2026-09-24 is AEST (UTC+10, daylight saving starts 4 Oct 2026), so Sydney midnight on that
// day is 2026-09-23T14:00:00.000Z.
test("Sydney midnight is computed at the correct UTC offset for the season (AEST, UTC+10)", () => {
  const midnight = sydneyMidnightUtc(new Date("2026-09-24T05:00:00Z"));
  expect(midnight.toISOString()).toBe("2026-09-23T14:00:00.000Z");
});

test("Sydney midnight shifts for daylight saving (AEDT, UTC+11)", () => {
  const midnight = sydneyMidnightUtc(new Date("2026-01-15T05:00:00Z"));
  expect(midnight.toISOString()).toBe("2026-01-14T13:00:00.000Z");
});

test("computeSummary buckets income into today/week/month using Sydney day boundaries and AUD", () => {
  // "Now" is 2026-09-24T05:00:00Z = 2026-09-24T15:00 Sydney. Sydney midnight = 2026-09-23T14:00:00Z.
  const now = new Date("2026-09-24T05:00:00Z");
  const rows = [
    tx({ id: "today", amount: 200, postDate: "2026-09-24T00:30:00Z" }), // after Sydney midnight
    tx({ id: "yesterday-late", amount: 300, postDate: "2026-09-23T13:00:00Z" }), // before Sydney midnight, still this week
    tx({ id: "last-week", amount: 400, postDate: "2026-09-10T00:00:00Z" }), // within the month, not the week
    tx({ id: "transfer", amount: 900, postDate: "2026-09-24T00:30:00Z", class: "transfer" }), // excluded
    tx({ id: "spend", amount: -150, direction: "debit", postDate: "2026-09-20T00:00:00Z", class: "payment" }),
  ];
  const summary = computeSummary([{ id: "a1", name: "Business account", balance: 5000, currency: "AUD", status: "available" }], rows, now);
  expect(summary.currency).toBe("AUD");
  expect(summary.balance).toBe(5000);
  expect(summary.incomeToday).toEqual({ amount: 200, count: 1 });
  expect(summary.incomeWeek.amount).toBe(500); // today + yesterday-late
  expect(summary.incomeMonth.amount).toBe(900); // today + yesterday-late + last-week
  expect(summary.spendMonth).toBe(150);
  expect(summary.spendWeek).toEqual({ amount: 150, count: 1 }); // "spend" (20 Sep) falls within the trailing 7 Sydney days
  expect(summary.runwayDays).toBe(1000); // 5000 / (150/30)
});

test("computeSummary excludes spend older than the trailing week from spendWeek but keeps it in spendMonth", () => {
  const now = new Date("2026-09-24T05:00:00Z");
  const rows = [
    tx({ id: "old-spend", amount: -80, direction: "debit", postDate: "2026-09-05T00:00:00Z", class: "payment" }), // within month, before the week window
  ];
  const summary = computeSummary([], rows, now);
  expect(summary.spendMonth).toBe(80);
  expect(summary.spendWeek).toEqual({ amount: 0, count: 0 });
});

test("computeSummary reports a null runway when there is no net outflow to divide by", () => {
  const summary = computeSummary([{ id: "a1", name: "Acc", balance: 1000, currency: "AUD", status: "available" }], [], new Date("2026-09-24T00:00:00Z"));
  expect(summary.runwayDays).toBeNull();
});

test("buildImportSnapshot is shaped for business.importFinances(): accounts, sourceLabel and a Mercury-compatible monthlyIncome", () => {
  const now = new Date("2026-09-24T05:00:00Z");
  const accounts = [{ id: "nab-account-id-123", name: "NAB Business", balance: 12345.67, currency: "AUD", status: "available" }];
  const rows = [tx({ id: "t1", amount: 500, postDate: "2026-09-24T00:00:00Z" })];
  const snapshot = buildImportSnapshot(accounts, rows, now);
  expect(snapshot.sourceLabel).toBe("NAB via Basiq · current balances");
  expect(snapshot.accounts).toEqual([{ name: "NAB Business", balance: 12345.67, currency: "AUD", sourceId: "count-id-123" }]);
  expect(snapshot.monthlyIncome?.today).toEqual({ amount: 500, transactions: 1 });
  expect(snapshot.monthlyIncome?.currency).toBe("AUD");
});

function fakeClient(overrides: Partial<{ accounts: BasiqAccount[]; transactions: BasiqTransaction[] }> = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      configured: () => true,
      createUser: async (_: any) => { calls.push("createUser"); return { id: "user-1" }; },
      consentUrl: async (userId: string) => { calls.push(`consentUrl:${userId}`); return `https://consent.basiq.io/home?token=fake-for-${userId}`; },
      listConnections: async () => { calls.push("listConnections"); return []; },
      refreshConnection: async () => { throw new Error("not used in this test"); },
      job: async () => { throw new Error("not used in this test"); },
      listAccounts: async () => { calls.push("listAccounts"); return overrides.accounts ?? [account()]; },
      listTransactionsSince: async () => { calls.push("listTransactionsSince"); return overrides.transactions ?? [tx()]; },
    } as any,
  };
}

test("connect() creates a Basiq user exactly once and returns a consent URL bound to it", async () => {
  const root = freshRoot();
  try {
    const { client, calls } = fakeClient();
    const finance = createFinanceSync(root, { client, db: openFinanceDb(":memory:"), authorisation: syntheticAuthorisation() });
    const first = await finance.connect({ email: "owner@example.com" });
    const second = await finance.connect({ email: "owner@example.com" });
    expect(first.consentUrl).toBe("https://consent.basiq.io/home?token=fake-for-user-1");
    expect(second.consentUrl).toBe(first.consentUrl);
    expect(calls.filter((c) => c === "createUser")).toHaveLength(1); // the second connect() reuses the saved user id
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10000);

test("sync() refuses to run before connect() and never touches saved state on that refusal", async () => {
  const root = freshRoot();
  try {
    const { client } = fakeClient();
    const finance = createFinanceSync(root, { client, db: openFinanceDb(":memory:"), authorisation: syntheticAuthorisation() });
    await expect(finance.sync()).rejects.toThrow("not connected");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the legacy sync has no NAB CSV import or Downloads scan any more (one importer: manual-*.ts)", () => {
  const finance = createFinanceSync(freshRoot(), { client: { configured: () => false } as any, db: openFinanceDb(":memory:"), authorisation: syntheticAuthorisation() }) as any;
  expect(finance.importCsv).toBeUndefined();
  expect(finance.importCsvFromDownloads).toBeUndefined();
});

test("categorySpend() totals software-vendor debits from imported transactions over the trailing window", async () => {
  const root = freshRoot();
  try {
    const now = new Date("2026-09-24T05:00:00Z");
    const db = openFinanceDb(":memory:");
    const finance = createFinanceSync(root, { client: { configured: () => false } as any, db, now: () => now, authorisation: syntheticAuthorisation(now) });
    // Rows as a (legacy, admitted) Basiq sync would have stored them.
    const tx = (id: string, amount: number, description: string, day: string) => ({ id, accountId: "syn-acct", connectionId: "syn", amount, direction: "debit" as const,
      description, postDate: `2026-09-${day}T00:00:00Z`, transactionDate: `2026-09-${day}T00:00:00Z`, status: "posted", class: "" });
    upsertTransactions(db, [tx("a", -49, "ANTHROPIC CLAUDE SUBSCRIPTION", "20"), tx("b", -9.99, "VERCEL INC", "18"), tx("c", -85, "WOOLWORTHS LEURA", "15")] as any);
    expect(finance.categorySpend("software")).toEqual({ supported: true, amount: 58.99, count: 2 });
    expect(finance.categorySpend("groceries")).toEqual({ supported: false, amount: 0, count: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
