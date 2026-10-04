// Finance review: a raw bank transactions export (e.g. NAB's Transactions.csv from Downloads) must never
// enter memory; Finance is authoritative and memory keeps summaries only. Synthetic rows only.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAB_CSV_HEADER, looksLikeBankTransactions } from "./finance/manual-nab-csv";
import { BANK_EXPORT_REFUSAL, bankExportFile } from "./local-memory-search";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NAB = `${NAB_CSV_HEADER.join(",")}\n03 Sep 26,-45.20,083-004 12-345-6789,,EFTPOS DEBIT,SYNTHETIC CAFE SYDNEY,1234.56,Dining,Synthetic Cafe,04 Sep 26\n`;
const CONNECT = `Transaction Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial\n03/09/2026,SYNTHETIC SUPPLIER,120.00,,5000.00,,\n`;
const HEADERLESS_4 = `03/09/2026,-45.20,"EFTPOS SYNTHETIC CAFE",+1234.56\n04/09/2026,+900.00,"SYNTHETIC CLIENT PAYMENT",+2134.56\n`;
const HEADERLESS_5 = `03 Sep 26,-45.20,,"EFTPOS SYNTHETIC CAFE",1234.56\n04 Sep 26,900.00,,"SYNTHETIC CLIENT PAYMENT",2134.56\n`;
const NOT_BANK = [
  `Name,Email,Phone\nJane Synthetic,jane@example.com,0412 345 678\n`,
  `Date,Topic,Notes\n03/09/2026,Kickoff,Synthetic notes about the call\n`,
  `Package,Price,Minutes\nEssential,699,400\nProfessional,1099,1000\n`,
];

describe("raw bank transactions never enter memory", () => {
  test("the NAB header, NAB Connect-style headers and the classic headerless 4/5-column shape are recognised", () => {
    for (const t of [NAB, CONNECT, HEADERLESS_4, HEADERLESS_5, `﻿${NAB}`]) expect(looksLikeBankTransactions(t)).toBe(true);
    for (const t of NOT_BANK) expect(looksLikeBankTransactions(t)).toBe(false);
  });

  test("a Transactions.csv file is refused for memory import, with a pointer to Finance", () => {
    const dir = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "mu-bank-export-"));
    dirs.push(dir);
    for (const [name, text, bank] of [
      ["Transactions.csv", NAB, true],
      ["export.csv", HEADERLESS_4, true],
      ["connect.txt", CONNECT, true],
      ["contacts.csv", NOT_BANK[0], false],
      ["notes.md", NAB, false], // only CSV/TXT are sniffed; a markdown note isn't an export
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, text);
      expect([name, bankExportFile(file)]).toEqual([name, bank]);
    }
    expect(BANK_EXPORT_REFUSAL).toContain("Finance");
  });
});
