import { describe, expect, test } from "bun:test";
import { extractServiceCandidates, gatherEvidence } from "./evidence";
import type { Lead } from "../leads/crm";

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 1,
    placeId: "place-1",
    vertical: "dental",
    area: "Mount Druitt NSW",
    name: "St Clair Dental",
    phone: "+61 2 9670 0000",
    address: "1 Example St, Mount Druitt NSW",
    website: "",
    mapsUrl: "https://maps.google.com/?cid=123",
    rating: null,
    reviews: null,
    emails: [],
    emailOk: false,
    score: 0,
    pitch: "",
    reasons: [],
    status: "new",
    owner: "",
    nextAt: null,
    lastContactAt: null,
    googleAt: null,
    createdAt: new Date().toISOString(),
    source: "google",
    attribution: "",
    ...overrides,
  };
}

describe("extractServiceCandidates", () => {
  test("pulls literal list items from a services section", () => {
    const html = `<section class="our-services"><h2>Services</h2><ul><li>General check-ups</li><li>Fillings</li></ul></section>`;
    expect(extractServiceCandidates(html)).toEqual(["General check-ups", "Fillings"]);
  });

  test("ignores unrelated sections", () => {
    const html = `<section class="hero"><ul><li>Book now</li></ul></section>`;
    expect(extractServiceCandidates(html)).toEqual([]);
  });

  test("never keeps a price, review or guarantee as a 'service'", () => {
    const html = `<section id="services"><ul><li>Cheap fillings $99</li><li>5 star rated</li><li>Guaranteed results</li></ul></section>`;
    expect(extractServiceCandidates(html)).toEqual([]);
  });
});

describe("gatherEvidence", () => {
  test("a lead with no website has only CRM-sourced facts and no services", async () => {
    const evidence = await gatherEvidence(lead({ website: "" }));
    expect(evidence.hasOwnWebsite).toBe(false);
    expect(evidence.services).toEqual([]);
    expect(evidence.facts.find((f) => f.field === "name")?.value).toBe("St Clair Dental");
    expect(evidence.facts.every((f) => f.sourceUrl)).toBe(true);
  });

  test("a lead with a website gets its literal services, cited to that site", async () => {
    const html = `<!doctype html><html><body><section id="services"><h2>Our services</h2><ul><li>Conveyancing</li><li>Wills &amp; estates</li></ul></section></body></html>`;
    const request = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("robots.txt")) return new Response("User-agent: *\n", { status: 200 });
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }) as unknown as typeof fetch;
    const evidence = await gatherEvidence(lead({ website: "https://example-law.com.au", vertical: "legal" }), { request });
    expect(evidence.hasOwnWebsite).toBe(true);
    expect(evidence.services.map((s) => s.value)).toContain("Conveyancing");
    expect(evidence.services.every((s) => s.sourceUrl.startsWith("https://example-law.com.au"))).toBe(true);
  });

  test("robots.txt disallow blocks the services fetch entirely", async () => {
    const request = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("robots.txt")) return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      return new Response("<html></html>", { status: 200 });
    }) as unknown as typeof fetch;
    const evidence = await gatherEvidence(lead({ website: "https://blocked.example.com" }), { request });
    expect(evidence.robotsBlocked).toBe(true);
    expect(evidence.services).toEqual([]);
  });

  test("dental leads carry the AHPRA compliance note", async () => {
    const evidence = await gatherEvidence(lead());
    expect(evidence.complianceNotes.join(" ")).toMatch(/AHPRA/);
  });
});
