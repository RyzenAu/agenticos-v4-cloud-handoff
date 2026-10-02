// Round 5 UI pass (2 Oct 2026): the defects fixed on the pages stay fixed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fmtProse } from "../src/lib/format";
import { leadsListQuery } from "../src/lib/leads-queries";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("Finance source notes use the en-AU date helper", () => {
  test("an ISO day inside a source note reads as a date, whatever the host timezone", () => {
    expect(fmtProse("Package model (base usage), business-economics.ts, rates checked 2026-09-28")).toContain("rates checked 28 Sept 2026");
    expect(fmtProse("rates checked 2026-09-28")).not.toContain("2026-09-28");
  });
  test("the economics blocks pass their source strings through it", () => {
    expect(read("src/components/receptionist/dashboard/economics-by-basis.tsx")).toContain("{fmtProse(f.source)}");
    expect(read("src/components/receptionist/dashboard/shared.tsx")).toContain("Source: {fmtProse(block.source)}");
    expect(read("src/components/receptionist/dashboard/usage-economics.tsx")).toContain("${fmtProse(b.source)}");
  });
});

describe("controls that repeated another control are gone", () => {
  test("Models: the filter lives in the segmented control, not also as three tile buttons", () => {
    const src = read("src/components/shell/pages/models-page.tsx");
    for (const t of ["Show free", "Show plan models", "Show metered"]) expect(src).not.toContain(t);
    expect(src).toContain('label: "Needing attention"');
  });
  test("Memory: 'Browse all' only when something is saved", () => {
    expect(read("src/components/operator/memory-workspace.tsx")).toContain("savedCount > 0 ? (");
  });
  test("Finance: the tiles don't repeat the import and connect steps listed under What needs you", () => {
    const src = read("src/components/shell/pages/finance-page.tsx");
    expect(src).toContain("!bankNeedsImport && csv.state === \"ok\"");
    expect(src).toContain("stripe.link === \"connected\" ? { to: FINANCES.to");
  });
  test("Calendar and Studio: one Import .ics, one New event, one way into Design", () => {
    const cal = read("src/components/operator/calendar-workspace.tsx");
    expect(cal).not.toContain("<Plus size={13} /> Add an event");
    expect(cal).not.toContain("onImport={() => upload.current?.click()}");
    expect(read("src/components/shell/pages/studio-page.tsx")).not.toContain("Open Design</OpenLink>");
  });
  test("Receptionist: on a phone the next step comes before the four tiles", () => {
    expect(read("src/components/receptionist/dashboard/index.tsx")).not.toContain("order-first");
  });
});

describe("review fixes (2 Oct 2026)", () => {
  test("Finance keeps an on-page way to connect Stripe and leads with What needs you", async () => {
    const { financeNextSteps } = await import("../src/components/finance/signals");
    const tile = { id: "x", value: null, state: "unknown", loading: false } as never;
    const steps = financeNextSteps({ csv: tile, unpriced: tile, aiSpend: tile, stripe: "not-connected" });
    expect(steps.find((s) => s.id === "stripe-connect")?.action).toEqual({ label: "Connect Stripe", kind: "stripe" });
    const src = read("src/components/shell/pages/finance-page.tsx");
    expect(src.indexOf('aria-label="What needs you"')).toBeLessThan(src.indexOf('data-testid="finance-signals"'));
  });
  test("Receptionist: the next step is first in the page order, not moved with CSS", () => {
    const src = read("src/components/receptionist/dashboard/index.tsx");
    expect(src.indexOf("<NextStepBar")).toBeLessThan(src.indexOf("<SummaryTiles"));
  });
  test("Leads: the main list refreshes itself (behaviour is tested in r6-ui-behaviour.test.tsx)", () => {
    expect(leadsListQuery(false).refetchInterval).toBeLessThanOrEqual(60_000);
    expect(leadsListQuery(false).refetchIntervalInBackground).toBe(false);
    expect(read("src/components/operator/leads-crm.tsx")).toContain("useQuery(leadsListQuery(filters.showExcluded))");
  });
  test("Calendar keeps exactly one Import .ics control in the workspace", () => {
    const src = read("src/components/operator/calendar-workspace.tsx");
    expect(src.match(/Import \.ics\n/g)?.length ?? 0).toBe(1);
  });
  test("Coding cards say one thing: no second 'nothing was replayed' and no amber line", () => {
    const list = read("src/components/coding/coding-list.tsx");
    expect(list).toContain("quiet={!!waiting}");
    expect(list).not.toContain("text-sm font-medium text-warn");
    expect(read("src/components/coding/needs-you.ts")).not.toContain("nothing was replayed. Resume");
  });
});
