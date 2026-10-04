import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAB_CONNECT_HEADER, NAB_CSV_HEADER, NAB_CSV_ISSUE_TEXT, NAB_CSV_MAX_ROWS, NabCsvRejected, inspectNabCsvExport, parseCents, parseNabCsvExport, parseNabDate } from "./manual-nab-csv";
import { buildNabCsv, SYNTHETIC_ACCOUNT, SYNTHETIC_SEPTEMBER, syntheticSeptemberCsv } from "./manual-fixtures";

const SALT = "ab".repeat(32);
const HEADER = "Date,Amount,Account Number,,Transaction Type,Transaction Details,Balance,Category,Merchant Name,Processed On";
const rejectCode = (fn: () => unknown) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(NabCsvRejected); return (e as NabCsvRejected).code; } throw new Error("expected rejection"); };

describe("NAB CSV field parsing", () => {
  test("exact header constant, including the empty 4th column", () => {
    expect(NAB_CSV_HEADER.join(",")).toBe(HEADER);
    expect(NAB_CSV_HEADER[3]).toBe("");
  });
  test("AU dates, day first, become real ISO dates; US order and impossible dates are rejected", () => {
    expect(parseNabDate("27 Sep 26")).toBe("2026-09-27");
    expect(parseNabDate("1 Jan 2027")).toBe("2027-01-01");
    expect(parseNabDate("29 Feb 24")).toBe("2024-02-29");
    expect(parseNabDate("27-Sep-26")).toBe("2026-09-27");
    expect(parseNabDate("27/09/2026")).toBe("2026-09-27");
    expect(parseNabDate("03/09/26")).toBe("2026-09-03"); // 3 September, never 9 March
    expect(parseNabDate("2026-09-27")).toBe("2026-09-27");
    for (const bad of ["29 Feb 26", "31 Sep 26", "09/27/2026", "31/04/2026", "27 Sept 26", "0 Sep 26", "27.09.2026", ""]) expect(parseNabDate(bad)).toBeNull();
  });
  test("signed decimal strings become exact integer cents via BigInt", () => {
    expect(parseCents("-21.43")).toBe(-2143);
    expect(parseCents("825.00")).toBe(82500);
    expect(parseCents("0.1")).toBe(10);
    expect(parseCents("+5")).toBe(500);
    expect(parseCents("1,234.56")).toBe(123456);
    expect(parseCents("-90071992547409.91")).toBe(-9007199254740991);
    for (const bad of ["", "1.234", "1e3", "$5.00", "12,34.00", "01.00", "--1", "1.", "NaN"]) expect(parseCents(bad)).toBeNull();
    expect(() => parseCents("90071992547409.92")).toThrow(NabCsvRejected);
  });
});

describe("parseNabCsvExport", () => {
  const rows = parseNabCsvExport(syntheticSeptemberCsv(), SALT);

  test("parses every synthetic row with CRLF, LF and a BOM", () => {
    expect(rows).toHaveLength(SYNTHETIC_SEPTEMBER.length);
    expect(parseNabCsvExport(buildNabCsv(SYNTHETIC_SEPTEMBER, { eol: "\n", bom: true }), SALT)).toEqual(rows);
  });

  test("never returns the account number, description text or balances", () => {
    const json = JSON.stringify(rows);
    expect(json).not.toContain(SYNTHETIC_ACCOUNT);
    expect(json).not.toContain("0000000");
    for (const line of SYNTHETIC_SEPTEMBER) expect(json).not.toContain(line.details);
    expect(json).not.toMatch(/balance/i);
    for (const r of rows) {
      expect(r.accountAlias).toMatch(/^acct-[0-9a-f]{10}$/);
      expect(Object.keys(r).sort()).toEqual(["accountAlias", "amountCents", "category", "date", "dedupeKey", "foreign", "fxVendorId", "fxVendorLabel", "id", "keyStrength", "kind", "known", "nabCategory", "processedOn", "status", "textKey", "typeLabel", "vendorId", "vendorLabel"]);
      if (r.status === "posted") expect(r).toMatchObject({ keyStrength: "strong", dedupeKey: expect.stringMatching(/^k-[0-9a-f]{32}$/), textKey: expect.stringMatching(/^t-[0-9a-f]{32}$/) });
      else expect(r).toMatchObject({ keyStrength: "pending", dedupeKey: null, textKey: null });
    }
  });

  test("identity is stable for the same salt and different for another salt", () => {
    expect(parseNabCsvExport(syntheticSeptemberCsv(), SALT).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    const other = parseNabCsvExport(syntheticSeptemberCsv(), "cd".repeat(32));
    expect(other.map((r) => r.id)).not.toEqual(rows.map((r) => r.id));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test("pending rows come from an empty Processed On", () => {
    const pending = rows.filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ processedOn: null, amountCents: -2143, vendorId: "twilio" });
  });

  test("NAB international fee rows are FX fees attributed to the adjacent foreign charge", () => {
    const fees = rows.filter((r) => r.kind === "fx-fee");
    expect(fees).toHaveLength(8);
    expect(fees.map((f) => f.fxVendorId)).toEqual(["vercel", "retell", "twilio", "openai", "anthropic", "elevenlabs", "neon", "higgsfield"]);
    expect(fees.every((f) => f.vendorId === "nab-fx-fees" && f.category === "bank-fees")).toBe(true);
    expect(rows.find((r) => r.vendorId === "retell" && r.amountCents < 0)?.foreign).toBe(true);
  });

  test("refunds, transfers, bank fees, Stripe payouts and M&U vendors are classified", () => {
    const by = (details: string) => rows[SYNTHETIC_SEPTEMBER.findIndex((l) => l.details === details)];
    expect(by("V0000 13/09 RETELL AI REFUND")).toMatchObject({ kind: "refund", vendorId: "retell", amountCents: 1240 });
    expect(by("TRANSFER TO OWN SAVINGS SYNTHETIC")).toMatchObject({ kind: "transfer", vendorId: "transfer-out" });
    expect(by("MONTHLY ACCOUNT FEE")).toMatchObject({ kind: "bank-fee", vendorId: "nab-fees" });
    expect(by("STRIPE PAYMENTS AUST SYNTH PAYOUT")).toMatchObject({ kind: "ordinary", vendorId: "stripe-payouts", known: true });
    expect(by("SYNTHETIC CLIENT DEPOSIT INV-0001")).toMatchObject({ kind: "ordinary", vendorId: "incoming-payments", vendorLabel: "Incoming payments" });
    expect(by("V0000 19/09 OFFICEWORKS 0000 SYNTHVILLE")).toMatchObject({ vendorId: "m-officeworks", vendorLabel: "Officeworks", known: false, category: "Office supplies" });
    for (const id of ["retell", "twilio", "vercel", "neon", "higgsfield", "elevenlabs", "openai", "anthropic"]) expect(rows.some((r) => r.vendorId === id && r.known)).toBe(true);
  });

  test("person names on transfers are never kept as labels", () => {
    const csv = buildNabCsv([{ date: "02 Sep 26", amount: "-40.00", type: "TRANSFER DEBIT", details: "SYNTH PERSON NAME", merchant: "Synth Person" },
      { date: "02 Sep 26", amount: "40.00", type: "TRANSFER CREDIT", details: "FROM SYNTH PERSON", merchant: "Synth Person" }]);
    expect(JSON.stringify(parseNabCsvExport(csv, SALT))).not.toMatch(/Synth Person|SYNTH PERSON/);
  });

  test("identical rows in one file get distinct, stable ids", () => {
    const dup = { date: "02 Sep 26", amount: "-5.00", type: "EFTPOS DEBIT", details: "SYNTH CAFE", merchant: "Synth Cafe", processedOn: null } as const;
    const a = parseNabCsvExport(buildNabCsv([dup, dup]), SALT);
    expect(a[0].id).not.toBe(a[1].id);
    expect(parseNabCsvExport(buildNabCsv([dup, dup]), SALT).map((r) => r.id)).toEqual(a.map((r) => r.id));
  });

  test("quoted cells with commas and escaped quotes are read", () => {
    const csv = `${HEADER}\r\n27 Sep 26,-10.00,00-000-0000,,EFTPOS DEBIT,"SYNTH, ""QUOTED"" SHOP",100.00,Shopping,"Synth, Shop",27 Sep 26\r\n`;
    expect(parseNabCsvExport(csv, SALT)[0]).toMatchObject({ amountCents: -1000, vendorLabel: "Synth, Shop" });
  });

  test("malformed input rejects the whole file with a code and line, never a value", () => {
    const good = syntheticSeptemberCsv().split("\r\n");
    const withLine = (i: number, line: string) => [...good.slice(0, i), line, ...good.slice(i + 1)].join("\r\n");
    expect(rejectCode(() => parseNabCsvExport(good.join("\r\n").replace("Account Number,,", "Account Number,"), SALT))).toBe("HEADER_MISMATCH");
    expect(rejectCode(() => parseNabCsvExport(HEADER.replace("Processed On", "Processed"), SALT))).toBe("HEADER_MISMATCH");
    expect(rejectCode(() => parseNabCsvExport(`${HEADER}\r\n`, SALT))).toBe("EMPTY");
    expect(rejectCode(() => parseNabCsvExport("", SALT))).toBe("EMPTY");
    expect(rejectCode(() => parseNabCsvExport(123, SALT))).toBe("NOT_TEXT");
    expect(rejectCode(() => parseNabCsvExport(withLine(5, "31 Sep 26,-1.00,00-000-0000,,FEES,SECRET-DETAIL,1.00,,,31 Sep 26"), SALT))).toBe("BAD_DATE");
    expect(rejectCode(() => parseNabCsvExport(withLine(5, "27 Sep 26,-1.0.0,00-000-0000,,FEES,X,1.00,,,27 Sep 26"), SALT))).toBe("BAD_AMOUNT");
    expect(rejectCode(() => parseNabCsvExport(withLine(5, "27 Sep 26,-1.00,00-000-0000,,FEES,X,abc,,,27 Sep 26"), SALT))).toBe("BAD_BALANCE");
    expect(rejectCode(() => parseNabCsvExport(withLine(5, "27 Sep 26,-1.00,00-000-0000,,FEES,X,1.00,,,soon"), SALT))).toBe("BAD_PROCESSED_ON");
    expect(rejectCode(() => parseNabCsvExport(withLine(5, "27 Sep 26,-1.00,00-000-0000,FEES,X,1.00,,,27 Sep 26"), SALT))).toBe("COLUMN_COUNT");
    expect(rejectCode(() => parseNabCsvExport(withLine(5, '27 Sep 26,-1.00,00-000-0000,,FEES,"UNTERMINATED,1.00,,,27 Sep 26'), SALT))).toBe("BAD_QUOTING");
    expect(rejectCode(() => parseNabCsvExport(withLine(5, `27 Sep 26,-1.00,00-000-0000,,FEES,${"X".repeat(600)},1.00,,,27 Sep 26`), SALT))).toBe("CELL_TOO_LONG");
    expect(rejectCode(() => parseNabCsvExport(`${HEADER}\r\n27 Sep 26,-1.00,0,,FEES,\u0001,1.00,,,27 Sep 26`, SALT))).toBe("CONTROL_CHARACTER");
    try { parseNabCsvExport(withLine(5, "31 Sep 26,-1.00,00-000-0000,,FEES,SECRET-DETAIL,1.00,,,31 Sep 26"), SALT); }
    catch (e) { expect((e as NabCsvRejected).line).toBe(6); expect((e as Error).message).not.toContain("SECRET"); expect((e as Error).message).not.toContain("00-000"); }
  });

  test("size and row bounds", () => {
    expect(rejectCode(() => parseNabCsvExport(`${HEADER}\r\n${"x".repeat(4 * 1024 * 1024)}`, SALT))).toBe("TOO_LARGE");
    const line = "27 Sep 26,-1.00,0,,FEES,X,1.00,,,27 Sep 26";
    expect(rejectCode(() => parseNabCsvExport([HEADER, ...Array(NAB_CSV_MAX_ROWS + 1).fill(line)].join("\n"), SALT))).toBe("TOO_MANY_ROWS");
    expect(() => parseNabCsvExport(syntheticSeptemberCsv(), "short")).toThrow("INVALID_SALT");
  });
});

test("owner-initiated modules never scan folders, watch files or read paths", () => {
  for (const file of ["manual-nab-csv.ts", "manual-store.ts", "manual-summary.ts", "manual-plugin.ts", "manual-jarvis.ts", "manual-vendors.ts"]) {
    const src = readFileSync(join(import.meta.dir, file), "utf8");
    expect(src).not.toMatch(/readdirSync|readFileSync|\bwatch\(|chokidar|Downloads|finance\.sqlite"|setInterval/);
  }
});

describe("validation: every problem, per row, with a line and a plain-English reason", () => {
  const issuesOf = (csv: string) => { try { parseNabCsvExport(csv, SALT); } catch (e) { return (e as NabCsvRejected).issues; } throw new Error("expected rejection"); };

  test("all bad rows are reported at once, and every problem in one row", () => {
    const csv = [HEADER,
      "27 Sep 26,-1.00,0,,FEES,X,1.00,,,27 Sep 26",
      "31 Sep 26,-1.00,0,,FEES,SECRET-A,1.00,,,31 Sep 26",
      "27 Sep 26,abc,0,,FEES,SECRET-B,xyz,,,27 Sep 26",
      "27 Sep 26,-1.00,0,,FEES",
      "09/27/2026,-2.00,0,,FEES,X,2.00,,,27 Sep 26"].join("\r\n");
    const issues = issuesOf(csv);
    expect(issues.map((i) => [i.line, i.code, i.column, i.severity])).toEqual([
      [3, "BAD_DATE", "Date", "error"], [3, "BAD_PROCESSED_ON", "Processed On", "error"],
      [4, "BAD_AMOUNT", "Amount", "error"], [4, "BAD_BALANCE", "Balance", "error"],
      [5, "COLUMN_COUNT", null, "error"],
      [6, "BAD_DATE", "Date", "error"],
    ]);
    expect(JSON.stringify(issues)).not.toMatch(/SECRET|abc|xyz/);
    for (const i of issues) expect(NAB_CSV_ISSUE_TEXT[i.code]).toBeString();
  });

  test("inspect returns the issues without throwing, and no rows when anything is wrong", () => {
    const bad = inspectNabCsvExport([HEADER, "27 Sep 26,-1.00,0,,FEES,X,1.00,,,27 Sep 26", "27 Sep 26,-1.0.0,0,,FEES,X,1.00,,,27 Sep 26"].join("\n"), SALT);
    expect(bad).toMatchObject({ format: "nab-ib", errors: 1, warnings: 0, rows: [] });
    const good = inspectNabCsvExport(syntheticSeptemberCsv(), SALT);
    expect(good).toMatchObject({ errors: 0, warnings: 0, issues: [] });
    expect(good.rows).toHaveLength(SYNTHETIC_SEPTEMBER.length);
  });
});

describe("running balance", () => {
  test("holds per account whether NAB wrote the file newest first or oldest first", () => {
    const newest = parseNabCsvExport(buildNabCsv(SYNTHETIC_SEPTEMBER, { newestFirst: true }), SALT);
    const oldest = parseNabCsvExport(syntheticSeptemberCsv(), SALT);
    expect(newest.map((r) => r.id).sort()).toEqual(oldest.map((r) => r.id).sort());
  });

  test("a missing or edited row is a warning on the row that doesn't follow; it blocks until accepted", () => {
    const lines = SYNTHETIC_SEPTEMBER.slice(0, 8);
    const gap = buildNabCsv([...lines.slice(0, 3), ...lines.slice(4)]); // row 4 exists in the bank but not in this file
    // Re-balance as if the row were there: build with it, then drop its line.
    const full = buildNabCsv(lines).split("\r\n");
    const missing = [...full.slice(0, 4), ...full.slice(5)].join("\r\n");
    expect(() => parseNabCsvExport(gap, SALT)).not.toThrow(); // consistent on its own
    const r = inspectNabCsvExport(missing, SALT);
    expect(r).toMatchObject({ errors: 0, warnings: 1 });
    expect(r.issues[0]).toMatchObject({ code: "BALANCE_MISMATCH", severity: "warning", line: 5, column: "Balance" });
    try { parseNabCsvExport(missing, SALT); throw new Error("expected rejection"); }
    catch (e) { expect((e as NabCsvRejected).code).toBe("BALANCE_MISMATCH"); expect((e as Error).message).toContain("accept the warnings"); }
    expect(parseNabCsvExport(missing, SALT, { acceptWarnings: true })).toHaveLength(lines.length - 1);
  });

  test("two identical charges on one day stay two rows: their balances differ", () => {
    const coffee = { date: "02 Sep 26", amount: "-5.00", type: "EFTPOS DEBIT", details: "SYNTH CAFE", merchant: "Synth Cafe" } as const;
    const rows = parseNabCsvExport(buildNabCsv([coffee, coffee]), SALT);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2);
    expect(new Set(rows.map((r) => r.textKey)).size).toBe(2);
  });
});

describe("other NAB shapes go through the same importer", () => {
  test("NAB Connect (no Processed On): every row posted", () => {
    const csv = [NAB_CONNECT_HEADER.join(","), "27 Sep 26,-10.00,00-000-0000,,EFTPOS DEBIT,SYNTH SHOP,90.00,Shopping,Synth Shop", "28 Sep 26,-5.00,00-000-0000,,EFTPOS DEBIT,SYNTH SHOP,85.00,Shopping,Synth Shop"].join("\r\n");
    const r = inspectNabCsvExport(csv, SALT);
    expect(r).toMatchObject({ format: "nab-connect", errors: 0, warnings: 0 });
    expect(r.rows.map((x) => [x.status, x.processedOn, x.keyStrength])).toEqual([["posted", "2026-09-27", "strong"], ["posted", "2026-09-28", "strong"]]);
  });
  test("classic headerless export (Date, Amount, Account, Details, Balance) with numeric AU dates", () => {
    const csv = ["27/09/2026,-10.00,00-000-0000,SYNTH SHOP,90.00", "28/09/2026,-5.00,00-000-0000,VERCEL INC USD 3.00,85.00"].join("\n");
    const r = inspectNabCsvExport(csv, SALT);
    expect(r).toMatchObject({ format: "nab-classic", errors: 0, warnings: 0 });
    expect(r.rows[1]).toMatchObject({ date: "2026-09-28", vendorId: "vercel", known: true, amountCents: -500 });
  });
});
