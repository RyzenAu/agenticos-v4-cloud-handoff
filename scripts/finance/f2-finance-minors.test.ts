// AUDIT-F2 FIN-2, FIN-3, FIN-5. SYNTHETIC data only.
import { describe, expect, test } from "bun:test";
import { ApiError, rejectionMessage } from "../../src/components/finance/manual-finance";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { buildNabCsv } from "./manual-fixtures";
import { summary } from "./manual-summary";

describe("FIN-2: a server refusal isn't blamed on the file", () => {
  test("403 / 409 / 500 show the server's reason; CSV problems still name the file", () => {
    expect(rejectionMessage(new ApiError("This is a quiet read-only copy")).text).toBe("The server refused the request: This is a quiet read-only copy. Nothing was imported.");
    expect(rejectionMessage(new ApiError("Forbidden")).text).not.toContain("file");
    expect(rejectionMessage(new ApiError("bad", "HEADER_MISMATCH")).text).toContain("isn't a NAB CSV export");
    expect(rejectionMessage(new ApiError("bad", "BAD_DATE", 3, [{ line: 3, code: "BAD_DATE", column: "Date", severity: "error", text: "x" } as any])).text).toBe("1 problem found. Nothing was imported.");
    expect(rejectionMessage(new ApiError("bad", "SOMETHING_NEW")).text).toBe("The file was rejected. Nothing was imported.");
  });
});

describe("FIN-3: an export starting on the 2nd names the missing day instead of calling the month incomplete", () => {
  const store = () => {
    const s = openManualFinanceStore(":memory:");
    s.importCsv(SHARED_LEDGER, buildNabCsv([
      { date: "02 Aug 26", amount: "100.00", type: "TRANSFER CREDIT", details: "SYNTH A" },
      { date: "30 Aug 26", amount: "-10.00", type: "EFTPOS DEBIT", details: "SYNTH B", merchant: "Synth B" },
    ]), "test");
    return s;
  };
  test("edge days are named; still 'partial', never assumed quiet", () => {
    const r = summary(SHARED_LEDGER, { month: "2026-08" }, { store: store(), today: "2026-09-28" });
    expect(r.periodCoverage).toBe("partial");
    expect(r.coverageNote).toBe("Imported NAB data covers 2 Aug 2026 – 30 Aug 2026. 1 Aug 2026 and 31 Aug 2026 aren't in any export yet (no transactions, or outside the range exported), so figures cover the imported days only.");
  });
  test("a real gap keeps the 'may be incomplete' wording", () => {
    const r = summary(SHARED_LEDGER, { from: "2026-07-20", to: "2026-08-10" }, { store: store(), today: "2026-09-28" });
    expect(r.coverageNote).toContain("may be incomplete");
  });
});

describe("FIN-4: an unreadable metered source makes metered spend unknown, not A$0.00", () => {
  test("the tile says which sources couldn't be read and shows a floor", async () => {
    const { aiSpendTiles } = await import("../../src/components/finance/signals");
    const base = { generatedAt: "2026-09-28T00:00:00.000Z", month: { label: "September 2026", daysInMonth: 30 }, totals: { fixedAud: 0, meteredAud: 0, monthAud: 0, projectedAud: 0, unknown: [] } };
    const unread = aiSpendTiles({ data: { ...base, apiKeys: [{ id: "twilio", provider: "Twilio", spend: null, status: "unavailable" }, { id: "router:x", spend: null, status: "unavailable" }] }, loading: false, failed: false })[0];
    expect(unread).toMatchObject({ value: "≥ A$0.00", state: "ok" });
    expect(unread.hint).toBe("Subscriptions A$0.00 + metered A$0.00 known, 1 source unreadable (Twilio)");
    const allRead = aiSpendTiles({ data: { ...base, apiKeys: [{ id: "openai", spend: { aud: 0 }, status: "ok" }] }, loading: false, failed: false })[0];
    expect(allRead).toMatchObject({ value: "A$0.00", state: "zero", hint: "Subscriptions A$0.00 + metered A$0.00" });
    // Review T5: status "ok" with no spend is unknown too; an unconfigured provider isn't.
    const okNoSpend = aiSpendTiles({ data: { ...base, apiKeys: [{ id: "retell", provider: "Retell AI", spend: null, status: "ok" }, { id: "openrouter:none", provider: "OpenRouter", spend: null, status: "info", note: "No OpenRouter key configured" }] }, loading: false, failed: false })[0];
    expect(okNoSpend.hint).toBe("Subscriptions A$0.00 + metered A$0.00 known, 1 source unreadable (Retell AI)");
  });
});
