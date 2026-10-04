// Finance dates (1 Oct 2026, job 4465ff87): recorded and synced timestamps are shown as readable Australian dates in
// Sydney time, never raw ISO, never "Invalid Date". Rendered through the real components (server render, no DOM).
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { BusinessWorkspace } from "@/lib/business-workspace";
import { FinanceSnapshotState, recordedLine } from "./finance-snapshot-state";
import { StripeFinancePanel, type StripeSummary } from "./stripe-finance-panel";

type Finances = NonNullable<BusinessWorkspace["finances"]>;
const finances = (over: Partial<Finances> = {}): Finances => ({
  accounts: [{ name: "Everyday", balance: 1234.5, currency: "AUD" }],
  recordedAt: "2026-10-01T03:04:05.000Z",
  sourceLabel: "NAB CSV",
  ...over,
});
const snapshot = (f: Finances) => renderToStaticMarkup(<FinanceSnapshotState finances={f} />);
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("recordedLine: readable en-AU dates in Sydney time", () => {
  test("a recorded instant reads as 'D Mon YYYY' (house style: Sept)", () => {
    expect(recordedLine("Recorded", "2026-10-01T03:04:05.000Z")).toBe("Recorded 1 Oct 2026");
    expect(recordedLine("Recorded", "2026-09-29T05:00:00Z")).toBe("Recorded 29 Sept 2026");
  });
  test("a UTC instant late on 30 Sep is 1 Oct in Sydney (AEST +10 and AEDT +11), whatever this machine's zone", () => {
    // 2026-09-30T14:30Z: Sydney is AEST until 4 Oct 2026, so 00:30 on 1 Oct. UTC would say 30 Sep.
    expect(recordedLine("Recorded", "2026-09-30T14:30:00Z")).toBe("Recorded 1 Oct 2026");
    expect(recordedLine("Recorded", "2026-09-30T13:59:59Z")).toBe("Recorded 30 Sept 2026");
    // Daylight saving: AEDT +11 from 4 Oct 2026, so 13:00Z on 31 Oct is already 1 Nov.
    expect(recordedLine("Recorded", "2026-10-31T13:00:00Z")).toBe("Recorded 1 Nov 2026");
    // The old behaviour (first ten characters of the ISO string) would have said 2026-09-30.
    expect("2026-09-30T14:30:00Z".slice(0, 10)).toBe("2026-09-30");
  });
  test("a bare calendar day stays that day", () => {
    expect(recordedLine("Recorded", "2026-10-01")).toBe("Recorded 1 Oct 2026");
  });
  test("a missing date says 'not recorded'", () => {
    for (const v of [undefined, null, ""]) expect(recordedLine("Recorded", v)).toBe("Recorded: not recorded");
  });
  test("an invalid string says 'not recorded', never 'Invalid Date' or 'NaN'", () => {
    for (const v of ["banana", "2026-13-45T99:99:99Z", "not a date", "NaN", "0000-00-00"]) {
      const out = recordedLine("Recorded", v);
      expect(out).toBe("Recorded: not recorded");
      expect(out).not.toMatch(/Invalid|NaN/);
    }
  });
});

describe("FinanceSnapshotState shows readable dates", () => {
  test("recorded and income-read dates are en-AU, not ISO", () => {
    const html = text(snapshot(finances({ monthlyIncome: { amount: 900, currency: "AUD", days: 30, recordedAt: "2026-09-30T14:30:00Z", transactions: 3 } })));
    expect(html).toContain("NAB CSV · Recorded 1 Oct 2026");
    expect(html).toContain("3 settled payments · read 1 Oct 2026");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).not.toContain("T03:04");
  });
  test("a missing recordedAt renders 'not recorded' (the old code printed nothing)", () => {
    const html = text(snapshot(finances({ recordedAt: undefined as unknown as string })));
    expect(html).toContain("NAB CSV · Recorded: not recorded");
    expect(html).not.toMatch(/Invalid Date|undefined|NaN/);
  });
  test("an invalid recordedAt or income date never prints 'Invalid Date'", () => {
    const html = text(snapshot(finances({ recordedAt: "garbage", monthlyIncome: { amount: 1, currency: "AUD", days: 30, recordedAt: "also garbage", transactions: 1 } })));
    expect(html).toContain("Recorded: not recorded");
    expect(html).toContain("read: not recorded");
    expect(html).not.toMatch(/Invalid Date|NaN|garbage/);
  });
});

describe("StripeFinancePanel shows 'Last synced' as a readable date", () => {
  function panel(over: Partial<StripeSummary> = {}) {
    const qc = new QueryClient();
    qc.setQueryData(["business-finance-stripe-status"], { configured: true, keyStatus: { present: true, ok: true, message: null } });
    const summary: StripeSummary = { configured: true, revenueThisMonthAud: 1000, invoices: { paidCount: 1, paidAud: 1000, outstandingCount: 0, outstandingAud: 0 }, overdueInvoices: [], nextPayout: null, mrrAud: null, lastSyncedAt: "2026-09-30T14:30:00Z", ...over };
    qc.setQueryData(["business-finance-stripe-summary"], summary);
    return text(renderToStaticMarkup(<QueryClientProvider client={qc}><StripeFinancePanel /></QueryClientProvider>));
  }
  test("a UTC instant late on 30 Sep reads 1 Oct 2026", () => {
    const html = panel();
    expect(html).toContain("Last synced 1 Oct 2026");
    expect(html).not.toMatch(/2026-09-30/);
  });
  test("an unreadable lastSyncedAt says not recorded; no lastSyncedAt makes no claim", () => {
    expect(panel({ lastSyncedAt: "garbage" })).toContain("Last synced: not recorded");
    expect(panel({ lastSyncedAt: "garbage" })).not.toMatch(/Invalid Date/);
    expect(panel({ lastSyncedAt: null })).not.toContain("Last synced");
  });
});
