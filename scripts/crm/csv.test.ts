import { describe, expect, test } from "bun:test";
import { parseCsv, serialiseCsv, csvCell, CSV_MAX_BYTES } from "./csv";
describe("CRM CSV transport", () => {
  test("RFC 4180 quoted commas, quotes, newlines and BOM", () => {
    expect(
      parseCsv('\uFEFFname,notes\r\n"Example, Pty Ltd","said ""hello""\nsecond line"\r\n'),
    ).toEqual([
      ["name", "notes"],
      ["Example, Pty Ltd", 'said "hello"\nsecond line'],
    ]);
    expect(parseCsv("name,phone\nExample,")).toEqual([
      ["name", "phone"],
      ["Example", ""],
    ]);
  });
  test("rejects malformed, oversized and unbounded input", () => {
    for (const input of ['name\n"unfinished', 'a\n"ok"oops', 'a\ninvalid"quote', "a\n\0"])
      expect(() => parseCsv(input)).toThrow();
    expect(() => parseCsv("a".repeat(CSV_MAX_BYTES + 1))).toThrow();
    expect(() => parseCsv(Array(66).fill("x").join(","))).toThrow();
    expect(() => parseCsv("a\n".repeat(5003))).toThrow();
  });
  test("export quotes fields and neutralises spreadsheet formulas", () => {
    for (const input of ['=HYPERLINK("evil")', "  +cmd", "@SUM(1)", "-1+2", "\tcmd", "\rfoo"])
      expect(csvCell(input).startsWith("\"'")).toBe(true);
    expect(serialiseCsv(["name", "notes"], [["A, B", 'said "ok"']])).toBe(
      '"name","notes"\r\n"A, B","said ""ok"""\r\n',
    );
    expect(parseCsv(serialiseCsv(["name"], [["Normal company"]]))).toEqual([
      ["name"],
      ["Normal company"],
    ]);
  });
});
