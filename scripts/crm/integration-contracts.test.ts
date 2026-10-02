import { afterEach, expect, test } from "bun:test";
import { ActivityBus, reaches } from "../events/bus";
import { startActivitySources } from "../events/sources";
import { publishPageContext, readPageContext, resetPageContext } from "../../src/lib/page-context";
import { resolveCrmContext } from "../../src/lib/crm-ref";
afterEach(resetPageContext);
test("CRM invalidations use the existing shared event stream without leaking field values", () => {
  const bus = new ActivityBus({ epoch: "crmtest" });
  const sources = startActivitySources({
    bus,
    registry: () => ({ all: () => [], isOnline: () => false }),
    sampleMs: 100000,
  });
  try {
    sources.crmChanged({
      ref: { kind: "company", id: "company-7", name: "Sensitive title" } as never,
      change: "updated",
      at: "2026-10-02T00:00:00Z",
    });
    const entries = bus.since(0)!;
    const event = entries.find((e) => e.topic === "crm")!;
    expect(event.scope).toBe("shared");
    expect(reaches(event.scope, "usman")).toBe(true);
    expect(reaches(event.scope, "mehroz")).toBe(true);
    expect(event.frame).toContain('"ref":{"kind":"company","id":"company-7"}');
    expect(event.frame).not.toContain("Sensitive title");
    expect(event.frame).not.toContain("sessionId");
  } finally {
    sources.stop();
  }
});
test("an active CRM reference is withdrawn on unmount and never becomes business data", () => {
  publishPageContext("crm", { crm: { kind: "deal", id: "deal-7" } });
  expect(resolveCrmContext({ context: readPageContext() })).toEqual({
    ok: true,
    ref: { kind: "deal", id: "deal-7" },
    how: "active-record",
  });
  publishPageContext("crm", null);
  expect(resolveCrmContext({ context: readPageContext() }).ok).toBe(false);
});
