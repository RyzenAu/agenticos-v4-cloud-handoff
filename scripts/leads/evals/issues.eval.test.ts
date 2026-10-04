// Fixed regression fixtures for scripts/leads/issues.ts (scoreIssues, detectIssues), protecting the
// real lead-classification failure cases found on 25-26 Sep 2026 (see ./README.md). Offline: every
// HTML page detectIssues would fetch is served from a recorded fixture via an injected `fetch`.
// Run with: bun test scripts/leads/evals
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Lead } from "../crm";
import { detectIssues, scoreIssues } from "../issues";

const FIXTURES = join(import.meta.dir, "fixtures");
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: 900, placeId: "osm:node/900", vertical: "dental", area: "Parramatta", name: "Smile Dental", phone: "02 9999 0000",
    address: "1 Church St, Parramatta NSW 2150", website: "https://smiledental.com.au/", mapsUrl: "https://osm.org/node/900",
    rating: null, reviews: null, emails: [], emailOk: false, score: 0, pitch: "audit_pending", reasons: [],
    status: "new", owner: "", nextAt: null, lastContactAt: null, googleAt: null, createdAt: "2026-09-20T00:00:00Z",
    source: "osm", attribution: "", excluded: false, excludedReason: "", websiteSource: "osm_tag", websiteConfidence: null,
    websiteCheckedAt: null, websiteCheck: "not-checked", mergedInto: null, phoneSource: "", phoneConfidence: null, phoneCheckedAt: null, suggestedPhone: "",
    ...over,
  };
}

/** Serves one fixed page for the lead's own site; anything else 404s — detectIssues should never
 *  need more than the home page (and, when the page links to one, the contact page) for these
 *  fixtures. */
function fakeFetch(html: string) {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const r = new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    Object.defineProperty(r, "url", { value: url });
    return r;
  }) as typeof fetch;
}

const NOW = new Date("2026-09-26T02:00:00Z");

describe("eval: a phone-only home page trips phone_only with evidence, a form-contact one doesn't", () => {
  test("no booking widget, no <form>, only a tel: link -> phone_only, with evidence quoting the phone", async () => {
    const request = fakeFetch(fixture("phone-only-home.html"));
    const report = await detectIssues(lead(), { request, crawl4ai: false, checkLinks: false, now: NOW });
    const phoneOnly = report.issues.find((i) => i.code === "phone_only");
    expect(phoneOnly).toBeDefined();
    expect(phoneOnly?.evidence.seen).toContain("no booking widget/link and no enquiry <form> found");
    expect(phoneOnly?.evidence.seen).toContain("phone shown: 0299990000"); // the phone shown, as evidence
  });

  test("a real enquiry <form> on the home page -> not phone_only (falls through to the weaker no_booking issue instead)", async () => {
    const request = fakeFetch(fixture("form-contact-home.html"));
    const report = await detectIssues(lead(), { request, crawl4ai: false, checkLinks: false, now: NOW });
    expect(report.issues.some((i) => i.code === "phone_only")).toBe(false);
    expect(report.issues.some((i) => i.code === "no_booking")).toBe(true);
  });
});

describe("eval: an automatic 'no website' finding is never sent out as a confirmed pitch", () => {
  test("no website on file, checked by discovery -> status no_website_verified, pitch audit_pending (never 'website')", async () => {
    const report = await detectIssues(
      lead({ website: "", websiteCheckedAt: "2026-09-25T10:00:00Z", websiteCheck: "none-verified" }),
      { now: NOW },
    );
    expect(report.status).toBe("no_website_verified");
    expect(report.pitch).toBe("audit_pending");
    expect(report.pitch).not.toBe("website");
    expect(report.verdict).toMatch(/confirm before pitching/i); // the human-check-first wording
  });

  test("a lead with no suburb/address on file (e.g. Maven Dental Group) gets exactly the same audit_pending guard, never a confirmed pitch either way", async () => {
    const noAddressLead = lead({
      name: "Maven Dental Group", address: "", area: "", website: "", websiteCheckedAt: "2026-09-25T10:00:00Z", websiteCheck: "none-verified",
    });
    const report = await detectIssues(noAddressLead, { now: NOW });
    expect(report.status).toBe("no_website_verified");
    expect(report.pitch).toBe("audit_pending");
    expect(report.pitch).not.toBe("website");
  });

  test("scoreIssues alone: no_website_verified can never resolve to 'website', 'none', 'redesign' or 'receptionist'", () => {
    const { pitch } = scoreIssues({ status: "no_website_verified", issues: [], strengths: [] }, { vertical: "dental", reviews: 12 });
    expect(pitch).toBe("audit_pending");
  });
});
