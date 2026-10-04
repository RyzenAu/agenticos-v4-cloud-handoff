// Audit A-M2 (docs/AUDIT-20260927.md): without the code-owned reviewed legacy NAB authorisation,
// booting Jarvis skills and running a Stripe sync must neither create nor read the NAB tables
// in .operator-data/finance.sqlite. Temporary root, synthetic Stripe transport, no env.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJarvisSkills } from "../jarvis-skills/index";
import type { PsHost } from "../jarvis-skills/ps-host";
import { BANK_MATCHING_DISABLED, createStripeClient, createStripeSync, openStripeTables, reconcilePayoutsWithBank } from "./stripe";
import { financeDbPath, openFinanceDb, upsertTransactions } from "./store";

const idlePs: PsHost = { run: async () => "OK", close: () => undefined, warm: () => undefined };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const syntheticStripe = () => createStripeClient({
  root: "/synthetic",
  env: { STRIPE_RESTRICTED_KEY: "rk_live_synthetic" },
  fetchFn: (async (url: string) => {
    const u = String(url);
    if (u.includes("/payouts")) return json({ data: [{ id: "po_1", amount: 55000, currency: "aud", status: "paid", arrival_date: 1789862400, created: 1789776000, method: "standard" }], has_more: false });
    if (/\/(balance_transactions|invoices|charges|customers|subscriptions)/.test(u)) return json({ data: [], has_more: false });
    if (u.includes("/balance")) return json({ available: [], pending: [] });
    throw new Error(`unexpected url ${u}`);
  }) as any,
});
const tables = (file: string) => {
  const db = new Database(file, { readonly: true });
  try { return (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name).sort(); }
  finally { db.close(); }
};

test("booting skills and a Stripe sync on a temp root neither create nor read the NAB tables", async () => {
  const root = mkdtempSync(join(tmpdir(), "nab-lockout-"));
  try {
    const skills = createJarvisSkills(root, { events: { submit: () => undefined }, now: () => Date.parse("2026-09-27T00:00:00Z"), ps: idlePs, vault: () => null });
    skills.close();
    expect(existsSync(financeDbPath(root))).toBe(false); // booting opened nothing

    const sync = createStripeSync(root, { client: syntheticStripe(), now: () => new Date("2026-09-24T00:00:00Z") });
    expect(existsSync(financeDbPath(root))).toBe(false); // construction is lazy too
    const result = await sync.sync();
    sync.close();
    expect(result).toMatchObject({ matched: 0, bankMatching: BANK_MATCHING_DISABLED });
    const names = tables(financeDbPath(root));
    expect(names.some((n) => n.startsWith("stripe_"))).toBe(true);
    for (const nab of ["accounts", "transactions", "invoice_matches"]) expect(names).not.toContain(nab);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("with NAB rows already stored, a refused matcher reads none of them and links nothing", () => {
  const db = openFinanceDb(":memory:");
  openStripeTables(db);
  upsertTransactions(db, [{ id: "bank-1", accountId: "a1", connectionId: "c1", amount: 550, direction: "credit", description: "Stripe payout",
    postDate: "2026-09-22T00:00:00Z", transactionDate: "2026-09-22T00:00:00Z", status: "posted", class: "transfer" }]);
  db.query("INSERT INTO stripe_payouts (id, amount, currency, status, arrival_date, created, method) VALUES ('po_1', 550, 'aud', 'paid', '2026-09-22T00:00:00Z', '2026-09-21T00:00:00Z', 'standard')").run();
  let bankReads = 0;
  const query = db.query.bind(db);
  (db as any).query = (sql: string) => { if (/\bFROM transactions\b/i.test(sql)) bankReads++; return query(sql); };
  expect(reconcilePayoutsWithBank(db, "2026-01-01T00:00:00Z")).toEqual({ matched: 0, bankMatching: BANK_MATCHING_DISABLED });
  expect(bankReads).toBe(0);
  const row = query("SELECT matched_bank_transaction_id AS m FROM stripe_payouts WHERE id = 'po_1'").get() as { m: string | null };
  expect(row.m).toBeNull();
  db.close();
});
