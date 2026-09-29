// Orchestrates the legacy NAB (via Basiq) sync: create/track the Basiq user, hand back a
// consent link, pull accounts and 90 days of transactions into local SQLite, and answer the
// dashboard's status/summary questions from what's stored. It never calls a payment-initiation
// endpoint or sees a bank credential, but it is NOT side-effect free: it creates a Basiq user,
// writes .operator-data/finance.json and finance.sqlite. NAB CSV import is NOT here any more: it
// moved to the one authoritative importer (manual-*.ts, finance-manual.sqlite), and nothing scans
// the Downloads folder.
//
// FAIL CLOSED: every operation, the store open and the background schedule require the
// code-owned reviewed live authorisation in ./legacy-admission.ts (null by default). Construction
// is lazy and touches nothing; a key existing in config is never enough.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createBasiqClient, type BasiqClient, type BasiqConnection } from "./basiq";
import { financeDbPath, openFinanceDb, readAccounts, readCreditsSince, readTransactionsSince, recordInvoiceMatches, readInvoiceMatches, upsertAccounts, upsertTransactions, type StoredAccount } from "./store";
import { loadOpenInvoices, matchInvoices } from "./invoice-matching";
import { computeCategorySpend, type CategorySpend } from "./categories";
import { assertLegacyNabAdmitted, LEGACY_NAB_LIVE_AUTHORISATION, legacyNabAdmission, type LegacyNabCapability, type LegacyNabLiveAuthorisation } from "./legacy-admission";

export const SYNC_WINDOW_DAYS = 90;
const SYDNEY_TZ = "Australia/Sydney";

export type FinanceState = { userId?: string; connectionIds?: string[]; lastSyncAt?: string; lastSyncError?: string; lastConsentAt?: string; lastCsvImportAt?: string };

function stateFile(root: string): string {
  return join(root, ".operator-data", "finance.json");
}
function readState(root: string): FinanceState {
  try { return JSON.parse(readFileSync(stateFile(root), "utf8")); } catch { return {}; }
}
function writeState(root: string, state: FinanceState): void {
  const dir = join(root, ".operator-data");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = stateFile(root), temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

// --- Sydney (Australia/Eastern) day-boundary helpers -----------------------------------
// Basiq/NAB timestamps are UTC ISO strings; "today"/"this week" must mean the calendar day
// in Sydney, not UTC, so the split doesn't drift at AEST/AEDT boundaries or around midnight.
function sydneyOffsetMinutes(date: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: SYDNEY_TZ, timeZoneName: "shortOffset" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "GMT+10";
  const match = part.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!match) return 600;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (parseInt(match[2], 10) * 60 + (match[3] ? parseInt(match[3], 10) : 0));
}
function sydneyDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SYDNEY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
/** The UTC instant of local midnight in Sydney, for the Sydney calendar day that `date` falls in. */
export function sydneyMidnightUtc(date: Date): Date {
  const key = sydneyDateKey(date);
  const offsetMinutes = sydneyOffsetMinutes(date);
  return new Date(Date.parse(`${key}T00:00:00.000Z`) - offsetMinutes * 60000);
}

export type FinanceSummary = {
  currency: "AUD";
  balance: number;
  accounts: number;
  incomeToday: { amount: number; count: number };
  incomeWeek: { amount: number; count: number };
  incomeMonth: { amount: number; count: number };
  spendMonth: number;
  spendWeek: { amount: number; count: number };
  /** Days of cash left at the trailing-30-day average net outflow rate, or null when there is
   *  no net outflow (or not enough history) to divide by. A simple estimate, not advice. */
  runwayDays: number | null;
  recordedAt: string;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Internal-transfer-shaped rows are excluded from income, the same way the Mercury adapter
 *  excludes them: a transfer between the owner's own accounts is not income. */
const isTransferClass = (cls: string) => /transfer/i.test(cls);

export function computeSummary(accounts: StoredAccount[], transactions: ReturnType<typeof readTransactionsSince>, now = new Date()): FinanceSummary {
  const balance = round2(accounts.reduce((sum, a) => sum + a.balance, 0));
  const midnight = sydneyMidnightUtc(now).getTime();
  const weekStart = midnight - 6 * 86400000; // Today plus the six days before it.
  const monthStart = midnight - 29 * 86400000;
  let incomeToday = 0, incomeTodayCount = 0, incomeWeek = 0, incomeWeekCount = 0, incomeMonth = 0, incomeMonthCount = 0, spendMonth = 0, spendWeek = 0, spendWeekCount = 0;
  for (const tx of transactions) {
    if (!tx.postDate) continue;
    const at = Date.parse(tx.postDate);
    if (!Number.isFinite(at) || at < monthStart) continue;
    if (tx.direction === "credit" && !isTransferClass(tx.class || "")) {
      incomeMonth += tx.amount; incomeMonthCount++;
      if (at >= weekStart) { incomeWeek += tx.amount; incomeWeekCount++; }
      if (at >= midnight) { incomeToday += tx.amount; incomeTodayCount++; }
    } else if (tx.direction === "debit") {
      spendMonth += Math.abs(tx.amount);
      if (at >= weekStart) { spendWeek += Math.abs(tx.amount); spendWeekCount++; }
    }
  }
  const avgDailySpend = spendMonth / 30;
  const runwayDays = avgDailySpend > 0 ? Math.max(0, Math.round(balance / avgDailySpend)) : null;
  return {
    currency: "AUD",
    balance,
    accounts: accounts.length,
    incomeToday: { amount: round2(incomeToday), count: incomeTodayCount },
    incomeWeek: { amount: round2(incomeWeek), count: incomeWeekCount },
    incomeMonth: { amount: round2(incomeMonth), count: incomeMonthCount },
    spendMonth: round2(spendMonth),
    spendWeek: { amount: round2(spendWeek), count: spendWeekCount },
    runwayDays,
    recordedAt: now.toISOString(),
  };
}

/** Shape compatible with native-business-sync.ts's MonthlyIncome, so the existing "Income
 *  today" tile and finance overview cards (which already read generically off
 *  business.finances.monthlyIncome / .accounts / .sourceLabel) light up unchanged. */
export type ImportableMonthlyIncome = { amount: number; currency: string; days: number; recordedAt: string; transactions: number; windowStart: string; windowEnd: string; today?: { amount: number; transactions: number }; week?: { amount: number; transactions: number } };
export type ImportableFinanceSnapshot = { accounts: Array<{ name: string; balance: number; currency: string; sourceId: string }>; recordedAt: string; sourceLabel: string; sourceUrl: string; monthlyIncome?: ImportableMonthlyIncome };

export function buildImportSnapshot(accounts: StoredAccount[], transactions: ReturnType<typeof readTransactionsSince>, now = new Date()): ImportableFinanceSnapshot {
  const summary = computeSummary(accounts, transactions, now);
  const windowStart = new Date(now.getTime() - 30 * 86400000);
  const monthlyIncome: ImportableMonthlyIncome = {
    amount: summary.incomeMonth.amount, currency: "AUD", days: 30, recordedAt: now.toISOString(), transactions: summary.incomeMonth.count,
    windowStart: windowStart.toISOString(), windowEnd: now.toISOString(),
    today: { amount: summary.incomeToday.amount, transactions: summary.incomeToday.count },
    week: { amount: summary.incomeWeek.amount, transactions: summary.incomeWeek.count },
  };
  return {
    accounts: accounts.map((a) => ({ name: a.name, balance: a.balance, currency: a.currency, sourceId: a.id.slice(-12) })),
    recordedAt: now.toISOString(),
    sourceLabel: "NAB via Basiq · current balances",
    sourceUrl: "https://www.nab.com.au/business",
    monthlyIncome,
  };
}

export type FinanceStatus = {
  configured: boolean;
  connected: boolean;
  accounts: StoredAccount[];
  lastSyncAt?: string;
  lastSyncError?: string;
  connections: Array<{ id: string; status: string; expiryDate: string | null; lastUsed: string | null }>;
};

export type FinanceSyncOptions = {
  client?: BasiqClient;
  db?: Database;
  now?: () => Date;
  /** Code-level injection only (tests). Defaults to the code-owned LEGACY_NAB_LIVE_AUTHORISATION;
   *  never sourced from env, config or request input. */
  authorisation?: LegacyNabLiveAuthorisation | null;
};

export function createFinanceSync(root: string, options: FinanceSyncOptions = {}) {
  const authorisation = options.authorisation === undefined ? LEGACY_NAB_LIVE_AUTHORISATION : options.authorisation;
  const clock = () => options.now?.() ?? new Date();
  const admitted = (capability: LegacyNabCapability) => legacyNabAdmission(capability, authorisation, clock()).admitted;
  const admit = (capability: LegacyNabCapability) => assertLegacyNabAdmitted(capability, authorisation, clock());
  // Lazy: nothing is created, opened or read until an admitted operation needs it.
  let clientHandle = options.client, dbHandle = options.db, ownsDb = false;
  const client = () => (clientHandle ??= createBasiqClient({ root }));
  const db = () => { if (!dbHandle) { dbHandle = openFinanceDb(financeDbPath(root)); ownsDb = true; } return dbHandle; };
  let timer: ReturnType<typeof setInterval> | undefined;

  async function ensureUser(contact?: { email?: string; mobile?: string }): Promise<string> {
    const state = readState(root);
    if (state.userId) return state.userId;
    const user = await client().createUser(contact ?? {});
    writeState(root, { ...state, userId: user.id });
    return user.id;
  }

  /** Shared tail of the Basiq sync: re-reads what's now stored,
   *  matches invoices against the trailing SYNC_WINDOW_DAYS, and builds the import-ready
   *  snapshot for business.importFinances(). */
  function matchAndSnapshot(now: Date): { snapshot: ImportableFinanceSnapshot; accounts: number; matches: number } {
    const since = new Date(now.getTime() - SYNC_WINDOW_DAYS * 86400000).toISOString();
    const accounts = readAccounts(db());
    const transactions = readTransactionsSince(db(), since);
    const invoices = loadOpenInvoices(root);
    const credits = readCreditsSince(db(), since);
    const matches = matchInvoices(invoices, credits);
    if (matches.length) recordInvoiceMatches(db(), matches.map((m) => ({ invoiceId: m.invoiceId, transactionId: m.transactionId, confidence: m.confidence, reason: m.reason })));
    return { snapshot: buildImportSnapshot(accounts, transactions, now), accounts: accounts.length, matches: matches.length };
  }

  return {
    /** Releases a store handle this instance opened itself (a caller-supplied db is the caller's). */
    close(): void {
      if (ownsDb) dbHandle?.close();
      dbHandle = undefined; ownsDb = false;
    },
    /** Pure admission decision for a legacy capability; reads nothing. */
    admission(capability: LegacyNabCapability) {
      return legacyNabAdmission(capability, authorisation, clock());
    },
    /** False (without consulting config or the provider) unless legacy status is admitted. */
    configured(): boolean {
      if (!admitted("status")) return false;
      return client().configured();
    },
    async status(): Promise<FinanceStatus> {
      admit("status");
      const state = readState(root);
      const accounts = readAccounts(db());
      let connections: BasiqConnection[] = [];
      if (state.userId && client().configured()) {
        try { connections = await client().listConnections(state.userId); } catch { /* Status still reports what's stored locally. */ }
      }
      return {
        configured: client().configured(),
        connected: accounts.length > 0 || connections.some((c) => c.status === "active"),
        accounts,
        lastSyncAt: state.lastSyncAt,
        lastSyncError: state.lastSyncError,
        connections: connections.map((c) => ({ id: c.id, status: c.status, expiryDate: c.expiryDate, lastUsed: c.lastUsed })),
      };
    },
    /** Creates the Basiq user if one doesn't exist yet, and returns the consent link to open
     *  in the owner's normal browser. Never opens anything itself. */
    async connect(contact?: { email?: string; mobile?: string }): Promise<{ consentUrl: string }> {
      admit("connect");
      const userId = await ensureUser(contact);
      const consentUrl = await client().consentUrl(userId);
      writeState(root, { ...readState(root), userId, lastConsentAt: clock().toISOString() });
      return { consentUrl };
    },
    /** Pulls current accounts and the trailing SYNC_WINDOW_DAYS of transactions, upserts them
     *  idempotently, matches invoices, and returns an import-ready snapshot for
     *  business.importFinances(). Throws (without touching saved state) if not yet connected. */
    async sync(): Promise<{ snapshot: ImportableFinanceSnapshot; accounts: number; transactionsSeen: number; matches: number }> {
      admit("sync");
      const state = readState(root);
      if (!state.userId) throw new Error("NAB is not connected yet. Connect it first.");
      const now = clock();
      try {
        const [remoteAccounts, remoteTransactions] = await Promise.all([
          client().listAccounts(state.userId),
          client().listTransactionsSince(state.userId, new Date(now.getTime() - SYNC_WINDOW_DAYS * 86400000).toISOString()),
        ]);
        upsertAccounts(db(), remoteAccounts);
        upsertTransactions(db(), remoteTransactions);
        const result = matchAndSnapshot(now);
        writeState(root, { ...state, lastSyncAt: now.toISOString(), lastSyncError: undefined });
        return { snapshot: result.snapshot, accounts: result.accounts, transactionsSeen: remoteTransactions.length, matches: result.matches };
      } catch (error) {
        writeState(root, { ...state, lastSyncError: (error as Error).message });
        throw error;
      }
    },
    /** Reads only what's already stored — fast, no Basiq call. */
    summary(): FinanceSummary {
      admit("summary");
      const now = clock();
      const accounts = readAccounts(db());
      const transactions = readTransactionsSince(db(), new Date(now.getTime() - 30 * 86400000).toISOString());
      return computeSummary(accounts, transactions, now);
    },
    invoiceMatches() {
      admit("summary");
      return readInvoiceMatches(db());
    },
    /** Spend by category over the trailing `days` (default 30 — "this month"), matched against
     *  categories.ts's vendor lists. Reads only what's already stored — no Basiq call. */
    categorySpend(category: string, days = 30): CategorySpend {
      admit("summary");
      const now = clock();
      const transactions = readTransactionsSince(db(), new Date(now.getTime() - days * 86400000).toISOString());
      return computeCategorySpend(transactions, category);
    },
    /** Background refresh every `intervalMs` while the process runs, ONLY when the reviewed
     *  live authorisation covers "schedule". Otherwise no timer is created and nothing is read;
     *  the returned stop function is a no-op. Each tick re-checks admission (expiry), and the
     *  Basiq pull additionally needs "sync". A failed background run never throws. */
    schedule(intervalMs = 4 * 60 * 60 * 1000): () => void {
      const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
      stop();
      if (!admitted("schedule")) return stop;
      timer = setInterval(() => {
        if (!admitted("schedule")) return stop();
        if (admitted("sync") && client().configured()) {
          const state = readState(root);
          if (state.userId) void this.sync().catch(() => { /* Already recorded in finance.json's lastSyncError. */ });
        }
      }, intervalMs);
      if (typeof (timer as any)?.unref === "function") (timer as any).unref();
      return stop;
    },
  };
}

export type FinanceSync = ReturnType<typeof createFinanceSync>;
