// Strict parser for the owner's own NAB CSV export (owner-initiated import only). This is the ONE
// NAB CSV reader in AgenticOS: the legacy finance.sqlite importer (csv-import.ts) and the ephemeral
// nab-manual-v1 JSON route were retired in its favour (docs/FINANCE-NAB-CSV.md).
//
// Accepted shapes (anything else is rejected as a whole):
//  - "nab-ib": the header NAB Internet Banking writes today
//      Date,Amount,Account Number,,Transaction Type,Transaction Details,Balance,Category,Merchant Name,Processed On
//    (the 4th column is blank in NAB's own export). An empty Processed On = a pending row.
//  - "nab-connect": the same header without Processed On (every row is posted).
//  - "nab-classic": the older headerless export, Date,Amount,[Account Number,]Details,Balance.
//
// Validation is per row: every problem is collected with its 1-based line and a code (never a cell
// value), and ANY error rejects the whole file, so a partial import can never happen. The running
// balance is checked per account; a break is a WARNING (a row may be missing or the export was
// edited) that blocks the import until the owner explicitly accepts it.
//
// Privacy boundary (enforced here, before anything reaches a store):
//  - The account number is only ever used as HMAC input. What leaves this module is a salted alias.
//  - Transaction Details text is used transiently to classify the row (vendor, transfer, refund,
//    FX fee) and to build a salted row identity; it is never returned. Only a vendor/merchant label
//    and a category survive.
//  - Balances are used only for the running-balance check and inside salted hashes (row identity and
//    the dedupe key); they are never returned.
//  - Errors carry a code and a line number, never cell values.
//
// Pure: no file, network or database access. Money is parsed from the decimal string with BigInt.
import { createHmac } from "node:crypto";
import { matchVendor } from "./manual-vendors";

export const NAB_CSV_HEADER = Object.freeze(["Date", "Amount", "Account Number", "", "Transaction Type", "Transaction Details", "Balance", "Category", "Merchant Name", "Processed On"]);
export const NAB_CONNECT_HEADER = Object.freeze(NAB_CSV_HEADER.slice(0, 9));
export const NAB_CSV_MAX_BYTES = 4 * 1024 * 1024;
export const NAB_CSV_MAX_ROWS = 20_000;
/** At most this many row issues are reported (the file is rejected either way). */
export const NAB_CSV_MAX_ISSUES = 100;
const MAX_CELL = 512;

export type NabCsvFormat = "nab-ib" | "nab-connect" | "nab-classic";
export type ManualKind = "ordinary" | "transfer" | "refund" | "fx-fee" | "bank-fee";
/**
 * How a row is recognised again in a later, overlapping export:
 *  - "strong": account + date + amount + running balance (survives NAB re-wording the details or
 *    re-categorising the merchant between exports; two identical coffees on one day differ by balance).
 *  - "loose": a posted row without a balance (older exports, rows migrated from the legacy store).
 *    A later strong row with the same account, date and amount replaces it.
 *  - "pending": not final yet; settled by the posted row NAB writes later.
 */
export type KeyStrength = "strong" | "loose" | "pending";
export type ManualRow = {
  /** Salted, stable identity. Re-importing the same (or an overlapping) export yields the same id. */
  id: string;
  /** Salted dedupe key (see KeyStrength); null for pending rows. */
  dedupeKey: string | null;
  keyStrength: KeyStrength;
  /**
   * Salted key of a posted row WITHOUT its balance: recognises the same transaction when NAB
   * re-orders same-day rows between exports (their running balances change, nothing else does).
   * Only used when the stored row isn't already accounted for by its strong key. null if pending.
   */
  textKey: string | null;
  accountAlias: string;
  /** Transaction date, YYYY-MM-DD. */
  date: string;
  /** Posting date, YYYY-MM-DD; null for a pending row. */
  processedOn: string | null;
  status: "posted" | "pending";
  /** Signed integer cents: negative = money out. */
  amountCents: number;
  kind: ManualKind;
  typeLabel: string;
  vendorId: string;
  vendorLabel: string;
  /** Matched an M&U vendor rule (manual-vendors.ts). */
  known: boolean;
  category: string;
  nabCategory: string;
  foreign: boolean;
  /** For an FX fee row: the vendor whose foreign transaction it was charged on, when attributable. */
  fxVendorId: string | null;
  fxVendorLabel: string | null;
};

export type NabCsvRejectCode =
  | "NOT_TEXT" | "TOO_LARGE" | "EMPTY" | "HEADER_MISMATCH" | "TOO_MANY_ROWS" | "BAD_QUOTING" | "COLUMN_COUNT"
  | "CELL_TOO_LONG" | "BAD_DATE" | "BAD_PROCESSED_ON" | "BAD_AMOUNT" | "BAD_BALANCE" | "MONEY_OVERFLOW" | "CONTROL_CHARACTER"
  | "BALANCE_MISMATCH" | "FUTURE_DATE" | "ENCODING" | "ACCOUNTLESS_MIX";

export type NabCsvIssue = {
  /** 1-based physical line in the file; null when the problem is the whole file. */
  line: number | null;
  code: NabCsvRejectCode;
  /** Which column the problem is in (a header name), never its value. */
  column: string | null;
  /** "error" rejects the file; "warning" blocks it until the owner explicitly accepts it. */
  severity: "error" | "warning";
};

/** Plain-English text for each code, for the preview and the rejection notice. Never a cell value. */
export const NAB_CSV_ISSUE_TEXT: Readonly<Record<NabCsvRejectCode, string>> = Object.freeze({
  NOT_TEXT: "The upload wasn't text.",
  TOO_LARGE: "The file is larger than 4 MB. Export a shorter date range.",
  EMPTY: "The file has no transactions.",
  HEADER_MISMATCH: "That isn't a NAB CSV export: the header row doesn't match.",
  TOO_MANY_ROWS: "The file has more than 20,000 rows. Export a shorter date range.",
  BAD_QUOTING: "A quoted cell isn't closed properly.",
  COLUMN_COUNT: "This row has the wrong number of columns.",
  CELL_TOO_LONG: "A cell in this row is longer than 512 characters.",
  BAD_DATE: "The date isn't a real Australian date (expected like 27 Sep 26 or 27/09/2026).",
  BAD_PROCESSED_ON: "The Processed On date isn't a real Australian date.",
  BAD_AMOUNT: "The amount isn't a plain number like -21.43.",
  BAD_BALANCE: "The balance isn't a plain number like 1,234.56.",
  MONEY_OVERFLOW: "An amount is too large to be real.",
  CONTROL_CHARACTER: "The file contains control characters a bank export wouldn't.",
  BALANCE_MISMATCH: "The running balance doesn't follow from the row before it: a row may be missing, or the export was edited.",
  FUTURE_DATE: "The date is more than a week in the future, so it can't be a real transaction (a two-digit year like 99 means 2099).",
  ENCODING: "The file isn't UTF-8 text, so some characters (like é) were unreadable and would show as �. Export it again, or import anyway.",
  ACCOUNTLESS_MIX: "This export has no account number, so its rows can't be matched against your other NAB exports and would be counted twice. Export it again from NAB Internet Banking (the current export includes the account), or clear the older import first.",
});

export class NabCsvRejected extends Error {
  /** The first issue's code (kept for callers that only need one). */
  readonly code: NabCsvRejectCode;
  /** The first issue's line, when it is on one line. Never a cell value. */
  readonly line: number | null;
  /** Every problem found (capped at NAB_CSV_MAX_ISSUES), errors first. */
  readonly issues: NabCsvIssue[];
  constructor(code: NabCsvRejectCode, line: number | null = null, issues?: NabCsvIssue[]) {
    const all = issues?.length ? issues : [{ line, code, column: null, severity: "error" as const }];
    const first = all[0];
    const warningsOnly = all.every((i) => i.severity === "warning");
    super(`NAB CSV rejected: ${first.code}${first.line ? ` (line ${first.line})` : ""}${all.length > 1 ? ` and ${all.length - 1} more` : ""}. ${warningsOnly ? "Nothing was imported: accept the warnings to import anyway." : "Nothing was imported."}`);
    this.name = "NabCsvRejected";
    this.code = first.code;
    this.line = first.line;
    this.issues = all;
  }
}

// ---- CSV tokenising (RFC 4180; strict) ------------------------------------------------------
type RawLine = { cells: string[]; line: number };
function tokenise(text: string): RawLine[] {
  const out: RawLine[] = [];
  let cells: string[] = [], field = "", quoted = false, fieldWasQuoted = false, line = 1, startLine = 1;
  const endField = () => { cells.push(fieldWasQuoted ? field : field.trim()); field = ""; fieldWasQuoted = false; };
  const endLine = () => {
    endField();
    if (cells.some((c) => c !== "")) out.push({ cells, line: startLine });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else {
          quoted = false;
          // After a closing quote only a separator, line end or spaces may follow.
          let j = i + 1;
          while (text[j] === " ") j++;
          if (j < text.length && text[j] !== "," && text[j] !== "\r" && text[j] !== "\n") throw new NabCsvRejected("BAD_QUOTING", line);
          i = j - 1;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.trim() !== "") throw new NabCsvRejected("BAD_QUOTING", line);
      field = ""; quoted = true; fieldWasQuoted = true;
    } else if (ch === ",") endField();
    else if (ch === "\r") { if (text[i + 1] !== "\n") { endLine(); line++; startLine = line; } }
    else if (ch === "\n") { endLine(); line++; startLine = line; }
    else field += ch;
  }
  if (quoted) throw new NabCsvRejected("BAD_QUOTING", startLine);
  if (field !== "" || cells.length) endLine();
  return out;
}

// ---- Field parsers --------------------------------------------------------------------------
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function isoOf(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === iso ? iso : null;
}
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
/**
 * Australian dates only, day first: "27 Sep 26", "27 Sep 2026", "27-Sep-26", "27/09/2026",
 * "27/09/26", and the unambiguous ISO "2026-09-27". Real calendar dates only: "09/27/2026"
 * (US order) and "31 Sep 26" are rejected rather than guessed.
 */
export function parseNabDate(raw: string): string | null {
  const named = /^(\d{1,2})[ -]([A-Za-z]{3})[ -](\d{2}|\d{4})$/.exec(raw);
  if (named) {
    const month = MONTHS.indexOf(named[2].toUpperCase()) + 1;
    return month ? isoOf(fullYear(named[3]), month, Number(named[1])) : null;
  }
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw);
  if (numeric) return isoOf(fullYear(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  return null;
}

/** "-21.43" / "825.00" / "1,234.50" / "+5" → signed integer cents via BigInt. null if malformed. */
export function parseCents(raw: string): number | null {
  const m = /^([+-]?)((?:0|[1-9]\d{0,14})|(?:[1-9]\d{0,2}(?:,\d{3}){1,4}))(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return null;
  const whole = BigInt(m[2].replace(/,/g, ""));
  const cents = whole * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new NabCsvRejected("MONEY_OVERFLOW");
  const value = Number(cents);
  return m[1] === "-" ? -value : value;
}

const upper = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();
/** Safe short label from NAB's Merchant Name / Category: no long digit runs, bounded, must hold a letter. */
export function sanitiseLabel(raw: string, max = 40): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\d{5,}/g, "").replace(/[*#]+/g, " ").replace(/\s+/g, " ").trim()
    // A label that looks like a spreadsheet formula (=, +, -, @, |) loses that lead, in case an export is ever added.
    .replace(/^[=+\-@|\s]+/, "").slice(0, max).trim();
  return /[A-Za-z]/.test(cleaned) ? cleaned : "";
}
export function sanitiseType(raw: string): string {
  const t = upper(raw);
  return /^[A-Z][A-Z &/-]{0,39}$/.test(t) ? t : t ? "OTHER" : "";
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "unlabelled";

// ---- Classification -------------------------------------------------------------------------
const FX_FEE = /NAB INTNL TRAN FEE|INTNL TRAN(?:SACTION)? FEE|INTERNATIONAL TRANSACTION FEE|FOREIGN (?:CURRENCY|TRANSACTION) FEE|O\/?SEAS TRAN FEE/;
const REFUND = /\bREFUND|\bREVERSAL\b|\bREVERSED\b|\bCHARGEBACK\b|\bRETURNED\b/;
const BANK_FEE = /\bFEE\b|\bFEES\b|\bCHARGE\b|\bCHARGES\b/;
const INTERNAL_TRANSFER = /TRANSFER (?:TO|FROM) (?:OWN|LINKED|SAVINGS|MY )|\bOWN ACCOUNT\b|\bTFR (?:TO|FROM) (?:OWN|SAVINGS|LINKED)\b|\bBETWEEN ACCOUNTS\b/;
const FOREIGN = /\b(?:USD|EUR|GBP|NZD|CAD|SGD|JPY|HKD|CHF|INR|CNY)\s?\d|\bFRGN\b|\bOVERSEAS\b|\bFOREIGN CURRENCY\b/;

type Staged = ManualRow & { _balance: number | null; _line: number };

/** Pure classification from the transaction type and text (details + merchant, upper case). */
export function classifyNabText(type: string, text: string, amountCents: number): ManualKind {
  const credit = amountCents > 0;
  if (FX_FEE.test(text)) return credit ? "refund" : "fx-fee";
  if (REFUND.test(text) || /REFUND|REVERSAL/.test(type)) return "refund";
  if (!credit && (type === "FEES" || type === "FEE" || (/MISCELLANEOUS DEBIT|ACCOUNT FEE/.test(type) && BANK_FEE.test(text) && !matchVendor(text, "debit")))) return "bank-fee";
  if (INTERNAL_TRANSFER.test(text)) return "transfer";
  // Outgoing transfers are moved money (to savings, drawings, another bank) — kept out of spending.
  // Incoming TRANSFER CREDITs are usually client payments (Osko/PayID), so they stay cash in; a
  // matched own-account pair is re-labelled as a transfer in the summary. Either can be corrected.
  if (!credit && /TRANSFER/.test(type)) return "transfer";
  return "ordinary";
}

/** Vendor id/label/category for a classified row. Never keeps a person's name. */
export function labelNabRow(kind: ManualKind, type: string, merchant: string, credit: boolean, text: string) {
  const vendor = kind === "fx-fee" || kind === "bank-fee" || kind === "transfer" ? null : matchVendor(text, credit ? "credit" : "debit");
  if (vendor) return { vendorId: vendor.id, vendorLabel: vendor.label, known: true, category: vendor.category as string, foreignBilled: vendor.foreignBilled };
  const byKind = (id: string, label: string, category: string) => ({ vendorId: id, vendorLabel: label, known: false, category, foreignBilled: false });
  if (kind === "fx-fee") return byKind("nab-fx-fees", "NAB international fees", "bank-fees");
  if (kind === "bank-fee") return byKind("nab-fees", "NAB fees", "bank-fees");
  if (kind === "transfer") return byKind(credit ? "transfer-in" : "transfer-out", credit ? "Transfer in" : "Transfer out", "transfers");
  // Transfers from people: never keep a payer/payee name.
  const personal = /TRANSFER|DIRECT CREDIT|DEPOSIT/.test(type);
  if (personal && credit) return byKind("incoming-payments", "Incoming payments", "income");
  const name = personal ? "" : sanitiseLabel(merchant);
  if (name) return { vendorId: `m-${slug(name)}`, vendorLabel: name, known: false, category: "", foreignBilled: false };
  return credit ? byKind("other-income", "Other money in", "") : byKind("other-spending", "Other spending", "");
}

// ---- Memory guard -----------------------------------------------------------------------------
/**
 * Does this text look like a raw bank transactions export? Raw transactions never enter memory
 * (Finance is authoritative; memory keeps sourced summaries only). Checks the first lines only:
 *  - the NAB internet banking header (NAB_CSV_HEADER), or any header naming a date, an amount (or
 *    debit/credit) and a balance, narrative or transaction description (NAB Connect and other banks);
 *  - a headerless classic export: 4-5 columns of date, signed amount, …, balance.
 */
export function looksLikeBankTransactions(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  const lines = tokenise(text.replace(/^﻿/, "").slice(0, 8192)).slice(0, 5);
  if (!lines.length) return false;
  const head = lines[0].cells.map((c) => c.trim().toLowerCase());
  const nab = NAB_CSV_HEADER.map((c) => c.toLowerCase());
  if (head.length >= 6 && nab.slice(0, 6).every((c, i) => head[i] === c)) return true;
  const connect = NAB_CONNECT_HEADER.map((c) => c.toLowerCase());
  if (head.length === connect.length && connect.every((c, i) => head[i] === c)) return true;
  const has = (re: RegExp) => head.some((c) => re.test(c));
  if (has(/\bdate\b/) && (has(/\bamount\b/) || (has(/\bdebit\b/) && has(/\bcredit\b/))) && has(/\b(balance|narrative|transaction (details|description|type)|description|particulars)\b/)) return true;
  const DATE = /^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})$/;
  const MONEY = /^[+-]?\$?\d[\d,]*(\.\d{1,2})?$/;
  const classic = (cells: string[]) =>
    (cells.length === 4 || cells.length === 5) &&
    (DATE.test(cells[0].trim()) || parseNabDate(cells[0].trim()) !== null) &&
    MONEY.test(cells[1].trim()) &&
    MONEY.test(cells[cells.length - 1].trim() || "0");
  const rows = lines.map((l) => l.cells);
  return rows.filter(classic).length >= Math.min(2, rows.length);
}

// ---- Shape detection ------------------------------------------------------------------------
type Columns = { date: number; amount: number; account: number | null; type: number | null; details: number; balance: number; category: number | null; merchant: number | null; processed: number | null; count: number };
const IB_COLUMNS: Columns = { date: 0, amount: 1, account: 2, type: 4, details: 5, balance: 6, category: 7, merchant: 8, processed: 9, count: 10 };
const CONNECT_COLUMNS: Columns = { ...IB_COLUMNS, processed: null, count: 9 };
const CLASSIC_5: Columns = { date: 0, amount: 1, account: 2, type: null, details: 3, balance: 4, category: null, merchant: null, processed: null, count: 5 };
const CLASSIC_4: Columns = { date: 0, amount: 1, account: null, type: null, details: 2, balance: 3, category: null, merchant: null, processed: null, count: 4 };
const COLUMN_NAMES = ["Date", "Amount", "Account Number", "", "Transaction Type", "Transaction Details", "Balance", "Category", "Merchant Name", "Processed On"];

function detect(first: RawLine): { format: NabCsvFormat; columns: Columns; headerRows: number } {
  const c = first.cells;
  const same = (h: readonly string[]) => c.length === h.length && c.every((v, i) => v === h[i]);
  if (same(NAB_CSV_HEADER)) return { format: "nab-ib", columns: IB_COLUMNS, headerRows: 1 };
  if (same(NAB_CONNECT_HEADER)) return { format: "nab-connect", columns: CONNECT_COLUMNS, headerRows: 1 };
  // Headerless classic export: the first row is already a transaction.
  if ((c.length === 5 || c.length === 4) && parseNabDate(c[0]) && parseCents(c[1]) !== null)
    return { format: "nab-classic", columns: c.length === 5 ? CLASSIC_5 : CLASSIC_4, headerRows: 0 };
  throw new NabCsvRejected("HEADER_MISMATCH", first.line);
}

export type NabCsvInspection = { format: NabCsvFormat; rows: ManualRow[]; issues: NabCsvIssue[]; errors: number; warnings: number };

/**
 * Parses and validates without throwing for row-level problems: returns the sanitised rows (empty
 * if there is any error) and every issue. Throws NabCsvRejected only for whole-file problems
 * (not text, too large, empty, header, quoting). Salt: per-store random secret, hex, ≥ 32 chars.
 */
export function inspectNabCsvExport(text: unknown, salt: string, options: { today?: string } = {}): NabCsvInspection {
  if (typeof salt !== "string" || !/^[0-9a-f]{32,}$/.test(salt)) throw new Error("INVALID_SALT");
  if (typeof text !== "string") throw new NabCsvRejected("NOT_TEXT");
  if (text.length > NAB_CSV_MAX_BYTES || new TextEncoder().encode(text).length > NAB_CSV_MAX_BYTES) throw new NabCsvRejected("TOO_LARGE");
  const source = text.replace(/^﻿/, "");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) throw new NabCsvRejected("CONTROL_CHARACTER");
  const lines = tokenise(source);
  if (!lines.length) throw new NabCsvRejected("EMPTY");
  const { format, columns, headerRows } = detect(lines[0]);
  const body = lines.slice(headerRows);
  if (!body.length) throw new NabCsvRejected("EMPTY");
  if (body.length > NAB_CSV_MAX_ROWS) throw new NabCsvRejected("TOO_MANY_ROWS");

  const hmac = (value: string) => createHmac("sha256", Buffer.from(salt, "hex")).update(value).digest("hex");
  const issues: NabCsvIssue[] = [];
  const issue = (line: number, code: NabCsvRejectCode, col: number | null, severity: NabCsvIssue["severity"] = "error") => {
    if (issues.length < NAB_CSV_MAX_ISSUES) issues.push({ line, code, column: col === null ? null : COLUMN_NAMES[format === "nab-classic" ? classicName(columns, col) : col] || null, severity });
  };
  const staged: Staged[] = [];
  const occurrences = new Map<string, number>();
  const looseOccurrences = new Map<string, number>();
  const strongOccurrences = new Map<string, number>();
  // A date more than a week past today can't be a real transaction ("15 Jan 99" is 2099, not 1999).
  const latest = options.today && /^\d{4}-\d{2}-\d{2}$/.test(options.today)
    ? new Date(Date.parse(`${options.today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10) : null;
  const textOccurrences = new Map<string, number>();
  for (const { cells, line } of body) {
    if (cells.length !== columns.count) { issue(line, "COLUMN_COUNT", null); continue; }
    const tooLong = cells.findIndex((c) => c.length > MAX_CELL);
    if (tooLong !== -1) { issue(line, "CELL_TOO_LONG", tooLong); continue; }
    const cell = (i: number | null) => (i === null ? "" : cells[i]);
    const rawProcessed = cell(columns.processed), rawBalance = cell(columns.balance);
    const date = parseNabDate(cell(columns.date));
    let processedOn = columns.processed === null ? date : rawProcessed === "" ? null : parseNabDate(rawProcessed);
    // Every problem in the row is reported, not just the first.
    const money = (raw: string, col: number, code: "BAD_AMOUNT" | "BAD_BALANCE"): { ok: boolean; cents: number | null } => {
      try {
        const cents = parseCents(raw);
        if (cents === null) { issue(line, code, col); return { ok: false, cents: null }; }
        return { ok: true, cents };
      } catch { issue(line, "MONEY_OVERFLOW", col); return { ok: false, cents: null }; }
    };
    let bad = false;
    if (!date) { issue(line, "BAD_DATE", columns.date); bad = true; }
    else if (latest && date > latest) { issue(line, "FUTURE_DATE", columns.date); bad = true; }
    if (columns.processed !== null && rawProcessed !== "" && !processedOn) { issue(line, "BAD_PROCESSED_ON", columns.processed); bad = true; }
    const amount = money(cell(columns.amount), columns.amount, "BAD_AMOUNT");
    const bal = rawBalance === "" ? { ok: true, cents: null } : money(rawBalance, columns.balance, "BAD_BALANCE");
    if (bad || !amount.ok || !bal.ok || !date || amount.cents === null) continue;
    const amountCents = amount.cents, balance = bal.cents;
    if (columns.processed === null) processedOn = date;

    const account = cell(columns.account).replace(/[^0-9A-Za-z]/g, "");
    const accountAlias = `acct-${hmac(`account:${account || "none"}`).slice(0, 10)}`;
    const typeLabel = sanitiseType(cell(columns.type));
    const details = upper(cell(columns.details)), merchant = cell(columns.merchant).trim();
    const text = `${details} ${upper(merchant)}`;
    const status = processedOn ? "posted" as const : "pending" as const;
    const kind = classifyNabText(typeLabel, text, amountCents);
    const label = labelNabRow(kind, typeLabel, merchant, amountCents > 0, text);
    const nabCategory = sanitiseLabel(cell(columns.category), 32);
    // Identity: a pending row's balance/posting date are not final, so they stay out of its key.
    const basis = JSON.stringify([accountAlias, date, amountCents, typeLabel, details, upper(merchant), status,
      status === "posted" ? processedOn : "", status === "posted" && balance !== null ? balance : ""]);
    const n = (occurrences.get(basis) ?? 0) + 1;
    occurrences.set(basis, n);
    let textKey: string | null = null;
    if (status === "posted") {
      const textBasis = JSON.stringify([accountAlias, date, amountCents, typeLabel, details, upper(merchant), processedOn]);
      const t = (textOccurrences.get(textBasis) ?? 0) + 1;
      textOccurrences.set(textBasis, t);
      textKey = `t-${hmac(`text:${textBasis}#${t}`).slice(0, 32)}`;
    }
    let dedupeKey: string | null = null, keyStrength: KeyStrength = "pending";
    if (status === "posted" && balance !== null) {
      // The occurrence index keeps charge → reversal → re-charge (same amount, same resulting balance,
      // same day) as three rows. NAB exports whole days, so the index is stable across overlapping files.
      const strongBasis = JSON.stringify([accountAlias, date, amountCents, balance]);
      const k = (strongOccurrences.get(strongBasis) ?? 0) + 1;
      strongOccurrences.set(strongBasis, k);
      dedupeKey = `k-${hmac(`strong:${strongBasis}#${k}`).slice(0, 32)}`;
      keyStrength = "strong";
    } else if (status === "posted") {
      const looseBasis = JSON.stringify([accountAlias, date, amountCents]);
      const m = (looseOccurrences.get(looseBasis) ?? 0) + 1;
      looseOccurrences.set(looseBasis, m);
      dedupeKey = `k-${hmac(`loose:${looseBasis}#${m}`).slice(0, 32)}`;
      keyStrength = "loose";
    }
    staged.push({
      id: `nab-${hmac(`row:${basis}#${n}`).slice(0, 32)}`, dedupeKey, keyStrength, textKey, accountAlias, date, processedOn, status, amountCents, kind, typeLabel,
      vendorId: label.vendorId, vendorLabel: label.vendorLabel, known: label.known,
      category: label.category || nabCategory || (amountCents > 0 ? "uncategorised-in" : "uncategorised-out"), nabCategory,
      foreign: kind !== "fx-fee" && (FOREIGN.test(text) || label.foreignBilled), fxVendorId: null, fxVendorLabel: null,
      _balance: balance, _line: line,
    });
  }
  // A Windows-1252 file read as UTF-8 carries U+FFFD replacement characters: labels would be garbled.
  if (source.includes("�") && issues.length < NAB_CSV_MAX_ISSUES) issues.push({ line: null, code: "ENCODING", column: null, severity: "warning" });
  if (!issues.some((i) => i.severity === "error")) checkRunningBalances(staged, (line) => issue(line, "BALANCE_MISMATCH", columns.balance, "warning"));
  attributeFxFees(staged);
  issues.sort((a, b) => (a.severity === b.severity ? (a.line ?? 0) - (b.line ?? 0) : a.severity === "error" ? -1 : 1));
  const errors = issues.filter((i) => i.severity === "error").length;
  // Strip transient fields: nothing below this line may carry text or balances out.
  const rows = errors ? [] : staged.map(({ _balance, _line, ...row }) => row);
  return { format, rows, issues, errors, warnings: issues.length - errors };
}

function classicName(columns: Columns, index: number): number {
  if (index === columns.date) return 0;
  if (index === columns.amount) return 1;
  if (index === columns.account) return 2;
  if (index === columns.details) return 5;
  if (index === columns.balance) return 6;
  return 3;
}

/** Strict entry point: returns the rows, or throws NabCsvRejected listing every problem. */
export function parseNabCsvExport(text: unknown, salt: string, options: { acceptWarnings?: boolean; today?: string } = {}): ManualRow[] {
  const result = inspectNabCsvExport(text, salt, { today: options.today });
  if (result.errors || (result.warnings && !options.acceptWarnings)) {
    const first = result.issues[0];
    throw new NabCsvRejected(first.code, first.line, result.issues);
  }
  return result.rows;
}

/**
 * Running balance, per account, over posted rows that carry a balance, in file order. NAB writes
 * newest first, but the direction is detected (whichever reading explains more links), so an
 * oldest-first file works too. A link that doesn't follow is reported on the later row in time.
 */
function checkRunningBalances(rows: Staged[], report: (line: number) => void) {
  const byAccount = new Map<string, Staged[]>();
  for (const r of rows) if (r.status === "posted" && r._balance !== null) (byAccount.get(r.accountAlias) ?? byAccount.set(r.accountAlias, []).get(r.accountAlias)!).push(r);
  for (const seq of byAccount.values()) {
    if (seq.length < 2) continue;
    let asc = 0, desc = 0;
    for (let i = 1; i < seq.length; i++) {
      const p = seq[i - 1], c = seq[i];
      if (c._balance === p._balance! + c.amountCents) asc++;
      if (p._balance === c._balance! + p.amountCents) desc++;
    }
    const ascending = asc >= desc;
    for (let i = 1; i < seq.length; i++) {
      const p = seq[i - 1], c = seq[i];
      const ok = ascending ? c._balance === p._balance! + c.amountCents : p._balance === c._balance! + p.amountCents;
      if (!ok) report(ascending ? c._line : p._line);
    }
  }
}

/** NAB charges its international fee as a separate row next to the foreign transaction (~3%). */
function attributeFxFees(rows: Staged[]) {
  const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
  rows.forEach((fee, i) => {
    if (fee.kind !== "fx-fee") return;
    const candidates = rows.filter((r, j) => j !== i && r.kind !== "fx-fee" && r.amountCents < 0 && r.accountAlias === fee.accountAlias && dayDiff(r.date, fee.date) <= 3 && (r.foreign || r.known));
    const threePercent = (r: Staged) => Math.abs(Math.round(Math.abs(r.amountCents) * 0.03) - Math.abs(fee.amountCents)) <= 2;
    const adjacent = [rows[i - 1], rows[i + 1]].filter((r) => r && candidates.includes(r));
    const pick = adjacent.find(threePercent) ?? candidates.find(threePercent) ?? adjacent[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (pick) { fee.fxVendorId = pick.vendorId; fee.fxVendorLabel = pick.vendorLabel; }
  });
}
