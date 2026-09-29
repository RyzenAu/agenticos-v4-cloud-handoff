// Lead drawer and Leads page reliability (audit F1-17, F1-18, F1-19, F1-25).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CallBlock, RealSite, SeoAuditBlock } from "../../src/components/operator/lead-drawer";
import { OperatorRequestError, operatorRequest, retryUnlessClientError } from "../../src/lib/operator";
import { Route as LeadsRoute } from "../../src/routes/leads";
import type { Lead } from "../../src/lib/leads";

const ROOT = join(import.meta.dir, "..", "..");
function lead(patch: Partial<Lead> = {}): Lead {
  return {
    id: 7, vertical: "dental", area: "Testville NSW", name: "Harbour Test Dental", phone: "0491 570 006", address: "",
    website: "https://harbour-dental.example.com", mapsUrl: "", emails: [], emailOk: false, score: 80, pitch: "website",
    reasons: [], status: "to_call", owner: "", nextAt: null, lastContactAt: null, createdAt: "2026-09-01T00:00:00Z", ...patch,
  };
}
function render(el: ReactElement, seed: (qc: QueryClient) => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
}
const openHours = (qc: QueryClient) => qc.setQueryData(["leads-summary"], { callWindow: { open: true, why: "Friday 10:00" } });

describe("F1-18: the drawer asks for a screenshot only once one exists", () => {
  test("no screenshot taken: no <img>, so no 404 for /__lead-sites/thumb", () => {
    const html = render(<RealSite lead={lead()} thumbAt={null} onChanged={() => {}} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/__lead-sites/thumb");
    expect(html).toContain("No screenshot yet");
    expect(html).toContain("Capture");
  });
  test("a screenshot on file renders with its cache-busting stamp", () => {
    const html = render(<RealSite lead={lead()} thumbAt="2026-09-27T01:00:00.000Z" onChanged={() => {}} />);
    expect(html).toContain(`/__lead-sites/thumb?id=7&amp;t=${encodeURIComponent("2026-09-27T01:00:00.000Z")}`);
    expect(html).toContain("Refresh");
  });
});

describe("F1-25: excluded leads aren't offered paid or calling actions", () => {
  const excluded = lead({ excluded: true, excludedReason: "national chain" });
  test("no Capture screenshot", () => {
    const html = render(<RealSite lead={excluded} thumbAt={null} onChanged={() => {}} />);
    expect(html).not.toMatch(/Capture|Refresh/);
    expect(html).toContain("excluded leads aren&#x27;t captured");
  });
  test("no SEO audit block (a paid crawl): the drawer gates it on the lead", () => {
    // Live (T5) gates at the call site rather than inside the block.
    const src = readFileSync(join(ROOT, "src/components/operator/lead-drawer.tsx"), "utf8");
    expect(src).toContain("{!lead.excluded && <SeoAuditBlock lead={lead} />}");
    expect(render(<SeoAuditBlock lead={lead()} />)).toContain("SEO audit");
  });
  test("no 'Calling hours open' or DNC-check badge; an open lead still gets them", () => {
    const html = render(<CallBlock lead={excluded} contactPref="" />, openHours);
    expect(html).not.toContain("Calling hours");
    expect(html).not.toContain("Check the DNC Register");
    expect(html).toContain("Excluded leads never get a call script.");
    const dnc = render(<CallBlock lead={lead({ status: "do_not_contact" })} contactPref="" />, openHours);
    expect(dnc).not.toContain("Calling hours");
    const open = render(<CallBlock lead={lead()} contactPref="" />, openHours);
    expect(open).toContain("Calling hours open");
    expect(open).toContain("Check the DNC Register");
  });
});

describe("F1-17: bad lead ids", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("a 4xx (\"Lead not found.\") is never retried; transient failures are, up to 3 times", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Lead not found." }), { status: 400, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const error = await operatorRequest("/leads/detail?id=999", undefined, "GET").catch((e) => e);
    expect(error).toBeInstanceOf(OperatorRequestError);
    expect(error.message).toBe("Lead not found.");
    expect(error.status).toBe(400);
    expect(retryUnlessClientError(0, error)).toBe(false);
    expect(retryUnlessClientError(0, new OperatorRequestError("gone", 404))).toBe(false);
    expect(retryUnlessClientError(0, new OperatorRequestError("boom", 500))).toBe(true);
    expect(retryUnlessClientError(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(retryUnlessClientError(3, new OperatorRequestError("boom", 500))).toBe(false);
  });

  test("the drawer's detail query uses that retry rule", () => {
    const src = readFileSync(join(ROOT, "src/components/operator/lead-drawer.tsx"), "utf8");
    expect(src).toMatch(/queryKey: \["leads-detail", id\][^\n]*retry: retryUnlessClientError/);
  });

  test("?lead= is validated, and the page reads the validated value", () => {
    const validate = LeadsRoute.options.validateSearch as (s: Record<string, unknown>) => { lead?: number };
    for (const raw of ["abc", -1, 0, 1.5, "", undefined]) expect(validate({ lead: raw })).toEqual({});
    expect(validate({ lead: 999 })).toEqual({ lead: 999 });
    const src = readFileSync(join(ROOT, "src/components/operator/leads-crm.tsx"), "utf8");
    // `strict: false` merged the raw query string in, so ?lead=abc reached the drawer.
    expect(src).not.toMatch(/useSearch\(\{\s*strict:\s*false/);
    expect(src).toContain('useSearch({ from: "/leads" })');
  });
});

describe("F1-19: the Leads page clock", () => {
  test("ticks every 30 s, not every second (a 1 s clock re-rendered the whole CRM)", () => {
    const src = readFileSync(join(ROOT, "src/components/operator/leads-crm.tsx"), "utf8");
    const intervals = [...src.matchAll(/setInterval\([^,]+,\s*([\d_]+)\)/g)].map((m) => Number(m[1].replace(/_/g, "")));
    expect(intervals.length).toBeGreaterThan(0);
    for (const ms of intervals) expect(ms).toBeGreaterThanOrEqual(30_000);
  });
});
