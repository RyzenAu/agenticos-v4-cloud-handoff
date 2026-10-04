// Operations and Finance agree with the catalogue, the economics constants and the NAB ledger
// (Track 5). Synthetic data only; no network.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_COUNTS, DEFAULT_COST_RATES, DEFAULT_FX, DEFAULT_LABOUR_HOURLY_CENTS, DEFAULT_PAYMENT, DEFAULT_TARGET_MARGIN_BPS, STRIPE_BILLING_BPS, STRIPE_CARD_BPS } from "../src/lib/business-economics";
import { RECEPTIONIST_PACKAGES } from "../src/lib/receptionist-packages";
import { assumptionText, EconomicsWorkbench, longDate, scenarioFields, WORKBENCH_BASE_CLIENTS, workbenchDefaults } from "../src/components/business/economics-workbench";
import { LIVE_FEED_LINE, NabLedgerStatusView, readNabLedgerStatus } from "../src/components/finance/nab-ledger-status";

describe("economics workbench: defaults and assumption text come from the constants", () => {
  test("first-load fields equal the constants (not typed copies)", () => {
    expect(workbenchDefaults()).toEqual({
      clients: String(CLIENT_COUNTS[1]),
      hourly: String(DEFAULT_LABOUR_HOURLY_CENTS / 100),
      fx: String(DEFAULT_FX.usdPerAudMillionths / 1_000_000),
      card: String(DEFAULT_FX.cardFeeBps / 100),
      target: String(DEFAULT_TARGET_MARGIN_BPS / 100),
      payment: String(DEFAULT_PAYMENT.percentBps / 100),
      paymentFixed: (DEFAULT_PAYMENT.fixedCents / 100).toFixed(2),
    });
    expect(WORKBENCH_BASE_CLIENTS).toBe(5);
    const src = readFileSync(join(import.meta.dir, "../src/components/business/economics-workbench.tsx"), "utf8");
    expect(src).not.toMatch(/"2026-09-25"|"0\.7019"|hourly: "60"|0\.4% Invoicing|checked 27 September|a local number/);
  });
  test("RBA, Stripe and telephony sentences derive from the constants", () => {
    const t = assumptionText();
    expect(t.fx).toContain(`US$${(DEFAULT_FX.usdPerAudMillionths / 1_000_000).toFixed(4)} per A$1 (RBA reference rate, ${longDate(DEFAULT_FX.date)})`);
    expect(longDate("2026-09-25")).toBe("25 Sept 2026"); // L10: one date style, "Sept"
    expect(t.stripe).toContain(`${STRIPE_CARD_BPS / 100}% + A$0.30`);
    expect(t.stripe).toContain(`Stripe Billing ${STRIPE_BILLING_BPS / 100}%`);
    expect(t.stripe).toContain(`${DEFAULT_PAYMENT.percentBps / 100}% + A$0.30`);
    const number = DEFAULT_COST_RATES.find((r) => r.id === "number")!;
    expect(t.telephony).toContain(number.label);
    expect(t.telephony).toContain(`US$${(number.micros! / 1_000_000).toFixed(2)}/month`);
  });
  test("a scenario's calls are summed and its seconds weighted, with its SMS", () => {
    expect(scenarioFields({ id: "base", label: "Base", calls: [{ count: 10, seconds: 100 }, { count: 30, seconds: 200 }], smsSegments: 7, supportMinutes: 9 }))
      .toEqual({ calls: "40", seconds: "175", sms: "7", support: "9" });
    const base = RECEPTIONIST_PACKAGES[0].model.scenarios.find((s) => s.id === "base")!;
    expect(scenarioFields(base).sms).toBe(String(base.smsSegments));
  });
  test("the rendered workbench shows the derived text and A$ only", () => {
    const html = renderToStaticMarkup(<EconomicsWorkbench />);
    expect(html).toContain("RBA reference rate, 25 Sept 2026");
    expect(html).toContain("Stripe Billing 0.7%");
    expect(html).toContain("SMS segments sent");
    expect(html).not.toMatch(/(?<![A-Z])\$\d/); // A$ or US$, never a bare $
  });
});

describe("Operations NAB ledger: three honest states", () => {
  const render = (state: Parameters<typeof NabLedgerStatusView>[0]["state"]) => renderToStaticMarkup(<NabLedgerStatusView state={state} />);
  test("loaded: the CSV source and its as-of date, rows, last import, stale flag, and the live feed not connected", () => {
    const html = render({ kind: "loaded", data: { sourceLabel: "NAB CSV imported, as of 26 Sep 2026", liveFeedLabel: "Live bank feed: not connected", rowCount: 23, lastImportAt: "2026-09-27T09:00:00.000Z", stale: true, daysSinceAsOf: 9 } });
    expect(html).toContain("NAB CSV imported, as of 26 Sep 2026 · Stale (9 days old)");
    expect(html).toContain(">23<");
    expect(html).toContain("not connected");
    expect(html).toContain("Review the ledger in Finance");
    expect(html).toContain('data-state="loaded"');
  });
  test("empty: nothing imported is unknown, not zero", () => {
    const html = render({ kind: "loaded", data: { sourceLabel: "No NAB CSV imported", rowCount: 0, lastImportAt: null } });
    expect(html).toContain("No NAB CSV imported");
    expect(html).toContain("None: figures are unknown, not zero");
    expect(html).toContain("Import a NAB CSV in Finance");
    expect(html).toContain(LIVE_FEED_LINE.replace("Live bank feed: ", ""));
  });
  test("failed: a failed read says so and never looks like no data", () => {
    const html = render({ kind: "failed", reason: "Finance status unavailable (HTTP 500)" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("This is a failed read, not &quot;no data&quot;");
    expect(html).not.toContain("No NAB CSV imported");
    expect(render({ kind: "loading" })).toContain("Reading the ledger status");
  });
  test("the reader accepts only a real status and surfaces the error", async () => {
    const ok = (async () => new Response(JSON.stringify({ rowCount: 3, lastImportAt: null }), { status: 200 })) as unknown as typeof fetch;
    expect(await readNabLedgerStatus(ok)).toMatchObject({ rowCount: 3 });
    const bad = (async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })) as unknown as typeof fetch;
    await expect(readNabLedgerStatus(bad)).rejects.toThrow("Forbidden");
    const junk = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(readNabLedgerStatus(junk)).rejects.toThrow("HTTP 200");
  });
  test("Operations leads with the ledger; the synthetic demo is labelled and secondary", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/business/mu-operations.tsx"), "utf8");
    expect(src).toContain('"NAB ledger"');
    expect(src).toContain("Sample permissions demo (synthetic, not your bank)");
    expect(src.indexOf("<NabLedgerStatus />")).toBeLessThan(src.indexOf("<NabConnection />"));
    expect(src).not.toContain("The development adapter uses synthetic records");
  });
});

describe("currency: A$ everywhere money is shown", () => {
  test("the Finance ledger, the NAB demo and the Stripe panel format through formatAud", () => {
    for (const f of ["src/components/finance/manual-finance.tsx", "src/components/finance/nab-connection.tsx", "src/components/business/stripe-finance-panel.tsx"]) {
      const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
      expect(src).toContain("formatAud(");
      expect(src).not.toMatch(/style: "currency", currency: "AUD"/);
    }
  });
});

describe("F1 Operations fixes", () => {
  test("F1-13: thousands separators are accepted; bad values name their field; 100% target is plain English", async () => {
    const { parseEconomicsDecimal } = await import("../src/components/business/economics-workbench");
    expect(parseEconomicsDecimal("1,099", 2)).toBe(109_900);
    expect(parseEconomicsDecimal("12,500.50", 2)).toBe(1_250_050);
    expect(() => parseEconomicsDecimal("1,09", 2)).toThrow();
    const src = readFileSync(join(import.meta.dir, "../src/components/business/economics-workbench.tsx"), "utf8");
    expect(src).toContain('throw new Error(`${FIELD_LABEL[key] ?? key}:');
    expect(src).toContain('"Target margin must be below 100%."');
  });
  test("F1-09: the package select is read on mount, so a pre-hydration choice drives the numbers", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/business/economics-workbench.tsx"), "utf8");
    expect(src).toContain("ref={packageSelect}");
    expect(src).toMatch(/if \(shown && shown !== packageId\) selectPackage\(shown\)/);
  });
  test("F1-10, F1-11, F1-28: tabs are a tablist with the section in the URL; delivery notes are dated; links are live", async () => {
    const { MuOperations, OPERATIONS_SECTIONS, DELIVERY_CHECKS_AS_OF } = await import("../src/components/business/mu-operations");
    const html = renderToStaticMarkup(<MuOperations section="delivery" />);
    expect(html).toContain('role="tablist"');
    expect((html.match(/role="tab"/g) ?? []).length).toBe(OPERATIONS_SECTIONS.length);
    expect(html).toMatch(/aria-selected="true"[^>]*>Delivery checks</);
    expect(html).toContain(`last reviewed ${DELIVERY_CHECKS_AS_OF}`);
    expect(html).toContain('href="/jarvis"');
    expect(html).not.toContain("127.0.0.1:3417\"");
    expect(html).toContain('href="/receptionist">Back to Receptionist');
    const route = readFileSync(join(import.meta.dir, "../src/routes/operations.tsx"), "utf8");
    expect(route).toContain("validateSearch");
  });
  test("F1-12: the draft's billing words match the maths (summed per period, rounded up once)", () => {
    const src = readFileSync(join(import.meta.dir, "leads/sales-backoffice.ts"), "utf8");
    expect(src).toContain("counted per second, summed over the billing period and rounded up once to the next whole minute");
    expect(src).not.toContain("billed per second and summed per billing period");
  });
});
