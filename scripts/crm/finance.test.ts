import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { financeDbPath } from "../finance/store";
import { CRM_FINANCE_STALE_AFTER_MS, readCrmFinanceLinks } from "./finance";
import type { Document } from "./types";

const NOW = new Date("2026-10-02T08:00:00.000Z");
const URL = "https://invoice.stripe.com/i/synthetic_001";
let root: string;
let priorDataDir: string | undefined;
const opened: Database[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crm-finance-synthetic-"));
  priorDataDir = process.env.MU_DATA_DIR;
  // Never resolve this fixture through a configured operator directory.
  process.env.MU_DATA_DIR = join(root, ".operator-data");
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  if (priorDataDir === undefined) delete process.env.MU_DATA_DIR;
  else process.env.MU_DATA_DIR = priorDataDir;
  rmSync(root, { recursive: true, force: true });
});
function document(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc-1",
    version: 1,
    companyId: "company-1",
    dealId: "deal-1",
    projectId: null,
    title: "Synthetic invoice reference",
    kind: "invoice-reference",
    status: "issued",
    currentVersion: 1,
    versions: [],
    externalUrl: URL,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}
function database(withTable = true): Database {
  const file = financeDbPath(root);
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  opened.push(db);
  if (withTable)
    db.exec(`CREATE TABLE stripe_invoices (
    id TEXT PRIMARY KEY, number TEXT, status TEXT, amount_due REAL, amount_paid REAL,
    amount_remaining REAL, currency TEXT, due_date TEXT, paid_at TEXT,
    hosted_invoice_url TEXT, synced_at TEXT
  )`);
  return db;
}
function invoice(db: Database, overrides: Record<string, string | number | null> = {}) {
  const row = {
    id: "in_synthetic_1",
    number: "SYN-001",
    status: "open",
    amount_due: 123.45,
    amount_paid: 23.45,
    amount_remaining: 100,
    currency: "aud",
    due_date: null,
    paid_at: null,
    hosted_invoice_url: URL,
    synced_at: "2026-10-02T07:50:00.000Z",
    ...overrides,
  };
  db.query(
    `INSERT INTO stripe_invoices (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(row));
}

describe("CRM's read-only existing Finance linkage", () => {
  test("missing Finance file stays missing and payment status stays unknown", () => {
    const result = readCrmFinanceLinks(root, [document()], NOW);
    expect(result.state).toBe("unknown");
    expect(result.requirement).toContain("connect Stripe");
    expect(result.links[0]).toMatchObject({
      status: "unknown",
      amountPaidCents: null,
      amountRemainingCents: null,
      asOf: null,
      stale: true,
    });
    expect(existsSync(financeDbPath(root))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("no invoice references is an empty link state, not zero paid or an empty ledger", () => {
    const result = readCrmFinanceLinks(root, [document({ kind: "agreement" })], NOW);
    expect(result).toMatchObject({ source: "finance-stripe-snapshot", state: "empty", links: [] });
    expect(result.requirement).toContain("invoice-reference");
    expect(readdirSync(root)).toEqual([]);
  });

  test("missing invoice table does not initialise or migrate existing Finance", () => {
    const db = database(false);
    db.exec(
      "CREATE TABLE synthetic_sentinel (value TEXT); INSERT INTO synthetic_sentinel VALUES ('unchanged')",
    );
    const before = readFileSync(financeDbPath(root));
    const result = readCrmFinanceLinks(root, [document()], NOW);
    expect(result.state).toBe("unknown");
    expect(result.requirement).toContain("invoice import");
    expect(readFileSync(financeDbPath(root))).toEqual(before);
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
      { name: "synthetic_sentinel" },
    ]);
  });

  test("an empty configured cache is not proof of payment", () => {
    database();
    const result = readCrmFinanceLinks(root, [document()], NOW);
    expect(result.state).toBe("unknown");
    expect(result.links[0]).toMatchObject({
      status: "unknown",
      invoiceId: null,
      amountPaidCents: null,
      amountRemainingCents: null,
    });
    expect(result.requirement).toContain("No saved Finance Stripe invoice matches this exact URL");
  });

  test("exact URL match preserves document and deal references, snapshot source and dollar conversion", () => {
    const db = database();
    invoice(db);
    // An unrelated row is neither disclosed nor used to guess a company's payment state.
    invoice(db, {
      id: "in_other",
      number: "UNRELATED",
      amount_paid: 99999,
      hosted_invoice_url: `${URL}_other`,
    });
    const result = readCrmFinanceLinks(root, [document()], NOW);
    expect(result.state).toBe("linked");
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toEqual({
      documentId: "doc-1",
      documentTitle: "Synthetic invoice reference",
      companyId: "company-1",
      dealId: "deal-1",
      externalUrl: URL,
      source: "finance-stripe-snapshot",
      state: "linked",
      requirement: null,
      invoiceId: "in_synthetic_1",
      invoiceNumber: "SYN-001",
      status: "open",
      amountPaidCents: 2345,
      amountRemainingCents: 10000,
      currency: "AUD",
      asOf: "2026-10-02T07:50:00.000Z",
      stale: false,
    });
    expect(JSON.stringify(result)).not.toContain("UNRELATED");
  });

  test("similar URLs, different case and equal amounts never establish invoice identity", () => {
    const db = database();
    invoice(db);
    for (const externalUrl of [
      `${URL}/`,
      `${URL}?query=1`,
      URL.replace("synthetic", "SYNTHETIC"),
    ]) {
      const result = readCrmFinanceLinks(root, [document({ externalUrl })], NOW);
      expect(result.links[0].status).toBe("unknown");
      expect(result.links[0].amountPaidCents).toBeNull();
    }
  });

  test("missing and malformed URL references remain unknown without opening Finance", () => {
    for (const externalUrl of [
      null,
      "",
      "invoice 123",
      "javascript:alert(1)",
      "http://invoice.example/i/1",
      "https://user:pass@invoice.example/i/1",
      `${URL}#receipt`,
      ` ${URL}`,
    ]) {
      const result = readCrmFinanceLinks(root, [document({ externalUrl })], NOW);
      expect(result.links[0]).toMatchObject({ externalUrl: null, status: "unknown", stale: true });
      expect(result.requirement).toContain("valid HTTPS hosted invoice URL");
    }
    expect(readdirSync(root)).toEqual([]);
  });

  test("duplicate exact URLs fail closed, even when one invoice says paid", () => {
    const db = database();
    invoice(db);
    invoice(db, { id: "in_duplicate", status: "paid", amount_paid: 123.45, amount_remaining: 0 });
    const result = readCrmFinanceLinks(root, [document()], NOW);
    expect(result.state).toBe("unknown");
    expect(result.links[0]).toMatchObject({
      invoiceId: null,
      status: "unknown",
      amountPaidCents: null,
      asOf: null,
    });
    expect(result.requirement).toContain("More than one Finance invoice");
  });

  test("a Finance payment change is read dynamically without copying it into CRM", () => {
    const db = database();
    invoice(db);
    const doc = document();
    const beforeDoc = JSON.stringify(doc);
    expect(readCrmFinanceLinks(root, [doc], NOW).links[0].status).toBe("open");
    db.query(
      "UPDATE stripe_invoices SET status = 'paid', amount_paid = 123.45, amount_remaining = 0, synced_at = ? WHERE id = ?",
    ).run(NOW.toISOString(), "in_synthetic_1");
    expect(readCrmFinanceLinks(root, [doc], NOW).links[0]).toMatchObject({
      status: "paid",
      amountPaidCents: 12345,
      amountRemainingCents: 0,
      asOf: NOW.toISOString(),
    });
    expect(JSON.stringify(doc)).toBe(beforeDoc);
    expect(readdirSync(dirname(financeDbPath(root)))).toEqual(["finance.sqlite"]);
  });

  test("zero remaining never infers paid from amounts or marks a deal won", () => {
    const db = database();
    invoice(db, { status: "void", amount_paid: 0, amount_remaining: 0 });
    const result = readCrmFinanceLinks(root, [document()], NOW);
    expect(result.links[0]).toMatchObject({
      status: "void",
      amountPaidCents: 0,
      amountRemainingCents: 0,
    });
    expect(result.links[0]).not.toHaveProperty("stageId");
    expect(result.links[0]).not.toHaveProperty("bankReceipt");
  });

  test("snapshots older than 24 hours retain only explicitly stale recorded evidence", () => {
    const db = database();
    const asOf = new Date(NOW.getTime() - CRM_FINANCE_STALE_AFTER_MS - 1).toISOString();
    invoice(db, { status: "paid", amount_paid: 123.45, amount_remaining: 0, synced_at: asOf });
    const result = readCrmFinanceLinks(root, [document()], NOW);
    expect(result.links[0]).toMatchObject({ status: "paid", asOf, stale: true });
    expect(result.requirement).toContain("over 24 hours old");
  });

  test("missing, malformed, impossible and future timestamps leave payment status unknown", () => {
    const db = database();
    invoice(db, { status: "paid" });
    for (const timestamp of [
      null,
      "",
      "yesterday",
      "2026-10-02",
      "2026-02-30T00:00:00Z",
      "2026-10-03T00:00:00.000Z",
    ]) {
      db.query("UPDATE stripe_invoices SET synced_at = ?").run(timestamp);
      const result = readCrmFinanceLinks(root, [document()], NOW);
      expect(result.links[0]).toMatchObject({
        status: "unknown",
        amountPaidCents: null,
        amountRemainingCents: null,
        asOf: null,
        stale: true,
      });
      expect(result.requirement).toContain("no valid snapshot time");
    }
  });

  test("malformed invoice amounts, currency and status cannot become payment facts", () => {
    const db = database();
    invoice(db);
    for (const [column, value] of [
      ["amount_paid", -1],
      ["amount_remaining", "invalid"],
      ["amount_paid", Number.MAX_SAFE_INTEGER],
      ["currency", ""],
      ["status", "settled-ish"],
    ] as const) {
      db.query(
        "UPDATE stripe_invoices SET amount_paid = 23.45, amount_remaining = 100, currency = 'aud', status = 'open'",
      ).run();
      db.query(`UPDATE stripe_invoices SET ${column} = ?`).run(value);
      const result = readCrmFinanceLinks(root, [document()], NOW);
      expect(result.links[0]).toMatchObject({
        status: "unknown",
        amountPaidCents: null,
        amountRemainingCents: null,
        stale: true,
      });
    }
  });

  test("mixed matched and missing documents report partial evidence without hiding unknowns", () => {
    const db = database();
    invoice(db);
    const result = readCrmFinanceLinks(
      root,
      [document(), document({ id: "doc-2", dealId: null, externalUrl: `${URL}_missing` })],
      NOW,
    );
    expect(result.state).toBe("partial");
    expect(result.links.map((link) => link.state)).toEqual(["linked", "unknown"]);
    expect(result.links[1].dealId).toBeNull();
  });

  test("repeated reads leave all synthetic Finance bytes, schema and unrelated rows unchanged", () => {
    const db = database();
    invoice(db);
    db.exec(
      "CREATE TABLE unrelated_bank_data (marker TEXT); INSERT INTO unrelated_bank_data VALUES ('synthetic untouched')",
    );
    const file = financeDbPath(root);
    const before = readFileSync(file);
    const beforeSchema = db.query("SELECT sql FROM sqlite_master ORDER BY name").all();
    for (let index = 0; index < 3; index++) readCrmFinanceLinks(root, [document()], NOW);
    expect(readFileSync(file)).toEqual(before);
    expect(db.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(beforeSchema);
    expect(db.query("SELECT * FROM unrelated_bank_data").all()).toEqual([
      { marker: "synthetic untouched" },
    ]);
    expect(readdirSync(dirname(file))).toEqual(["finance.sqlite"]);
  });

  test("WAL-mode Finance exposes committed uncheckpointed payment changes without ledger writes", () => {
    const db = database();
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    invoice(db);
    const file = financeDbPath(root);
    const before = readFileSync(file);
    const beforeWal = readFileSync(`${file}-wal`);
    expect(readCrmFinanceLinks(root, [document()], NOW).links[0].status).toBe("open");
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(`${file}-wal`)).toEqual(beforeWal);
    db.query(
      "UPDATE stripe_invoices SET status = 'paid', amount_paid = 123.45, amount_remaining = 0",
    ).run();
    const paidWal = readFileSync(`${file}-wal`);
    expect(readCrmFinanceLinks(root, [document()], NOW).links[0]).toMatchObject({
      status: "paid",
      amountPaidCents: 12345,
      amountRemainingCents: 0,
    });
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(`${file}-wal`)).toEqual(paidWal);
  });

  test("unreadable non-database content fails closed without modifying it or leaking paths", () => {
    const file = financeDbPath(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "synthetic invalid database");
    const result = readCrmFinanceLinks(root, [document()], NOW);
    expect(result.state).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain(root);
    expect(readFileSync(file, "utf8")).toBe("synthetic invalid database");
  });
});
