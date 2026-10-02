import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LeadFilterBar } from "../../src/components/operator/lead-filters";
import { LeadRows } from "../../src/components/operator/lead-list";
import { LeadsTable } from "../../src/components/operator/leads-table";
import { DEFAULT_LEAD_FILTERS, selectLeadResults } from "../../src/lib/lead-search";
import type { BoardLead } from "../../src/lib/leads";

function lead(id: number, name: string, websiteStatus?: string): BoardLead {
  return {
    id,
    name,
    area: "Sample NSW",
    phone: "",
    address: "",
    website: "",
    mapsUrl: "",
    emails: [],
    emailOk: false,
    vertical: "dental",
    score: id * 10,
    pitch: "audit_pending",
    reasons: [],
    status: "new",
    owner: "",
    nextAt: null,
    lastContactAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    source: "osm",
    deal: {
      stage: "found",
      closed: false,
      evidence: "Synthetic fixture",
      nextAction: "Review",
      owner: "agent",
      stageSince: null,
      daysInStage: null,
      daysInferred: false,
      stuck: null,
      contactPref: "",
      issues: [],
      websiteStatus,
      economics: {
        valueCents: 0,
        weightedCents: 0,
        probability: 0,
        valueSource: "Synthetic",
        expectedClose: null,
      } as BoardLead["deal"]["economics"],
    },
  };
}

describe("Leads workspace presentation contracts", () => {
  test("search is labelled, filters fold, and all practical filters remain reachable", () => {
    const html = renderToStaticMarkup(
      <LeadFilterBar
        filters={{ ...DEFAULT_LEAD_FILTERS }}
        setFilters={() => {}}
        leads={[lead(1, "Example")]}
      />,
    );
    expect(html).toContain('for="lead-workspace-search"');
    expect(html).toContain('aria-describedby="lead-search-help"');
    expect(html).toContain('aria-expanded="false"');
    for (const label of [
      "Website presence",
      "Industry",
      "Area",
      "Pipeline stage",
      "Contact status",
      "Assigned to",
      "Contact details",
      "Source",
      "Added",
      "Follow-up",
    ])
      expect(html).toContain(label);
    expect(html).toContain("Missing URLs and social");
    expect(html).toContain("Email on file does not mean permission");
  });
  test("active filters have named remove controls, an honest website label and a clear-all action", () => {
    const html = renderToStaticMarkup(
      <LeadFilterBar
        filters={{
          ...DEFAULT_LEAD_FILTERS,
          q: "smile blacktown",
          website: "verified_none",
          contact: "phone",
        }}
        setFilters={() => {}}
        leads={[]}
      />,
    );
    expect(html).toContain('aria-label="Clear search"');
    expect(html).toContain('aria-label="Remove filter: Search: smile blacktown"');
    expect(html).toContain('aria-label="Remove filter: Website presence: No website · verified"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Clear all");
  });
  test("table preserves shared search ranking until a column is deliberately sorted", () => {
    const rows = selectLeadResults([lead(3, "Other Smile"), lead(1, "Smile")], { q: "smile" });
    const html = renderToStaticMarkup(<LeadsTable leads={rows} ordered onOpen={() => {}} />);
    expect(html.indexOf('aria-label="Open Smile"')).toBeLessThan(
      html.indexOf('aria-label="Open Other Smile"'),
    );
    expect(html).toContain('aria-label="Leads table"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain("Website not verified");
    expect(html).not.toContain("No website · verified");
  });
  test("default list is one quiet list with one drawer entry per lead, without repeated missing-data boilerplate", () => {
    const html = renderToStaticMarkup(
      <LeadRows
        leads={[lead(1, "Cedar Dental"), lead(2, "Oak Dental")]}
        now={Date.now()}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Lead results"');
    expect((html.match(/<button/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="Open Cedar Dental"');
    expect(html).toContain("Website not verified");
    expect(html).not.toContain("Issue evidence not recorded");
    expect(html).not.toContain("Last touch");
    expect(html).not.toContain("Not generated");
    expect(html).not.toContain("<details");
  });
  test("compact rows preserve live attribution, focus visibility and fixed grid columns", () => {
    const google = {
      ...lead(4, "Example"),
      source: "google",
      attribution: "Old attribution",
      placesLive: {
        attribution: "Current Google attribution",
        fetchedAt: null,
        fields: [],
        hours: [],
        businessStatus: "",
      },
    };
    const html = renderToStaticMarkup(
      <LeadRows leads={[google]} now={Date.now()} onOpen={() => {}} />,
    );
    expect(html).toContain("Current Google attribution");
    expect(html).not.toContain("Old attribution");
    expect(html).toContain("focus-visible:-outline-offset-2");
    expect(html).toContain("sm:col-start-3");
    const drawer = readFileSync(
      join(import.meta.dir, "../../src/components/operator/lead-drawer.tsx"),
      "utf8",
    );
    for (const label of ["Lead source", "Website source", "Website checked"])
      expect(drawer).toContain(label);
  });
  test("advanced filters are grouped and the page has no duplicate search or empty descriptions", () => {
    const html = renderToStaticMarkup(
      <LeadFilterBar filters={{ ...DEFAULT_LEAD_FILTERS }} setFilters={() => {}} leads={[]} />,
    );
    expect((html.match(/<fieldset/g) ?? []).length).toBe(3);
    expect(html).toContain("Website &amp; contact");
    expect(html).toContain("Pipeline &amp; timing");
    const src = readFileSync(
      join(import.meta.dir, "../../src/components/operator/leads-crm.tsx"),
      "utf8",
    );
    expect(src).not.toContain("openCrmPalette");
    expect(src).not.toContain("Use filters to narrow the list");
    expect(src).toContain("<LeadRows");
  });
  test("refreshes do not collapse expanded cards and Back can close a deep-linked drawer", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/components/operator/leads-crm.tsx"),
      "utf8",
    );
    expect(src).toContain("useEffect(() => setLimit(LIST_PAGE), [resetKey])");
    // Round 6: Back closing the drawer is tested by rendering it (r6-ui-behaviour.test.tsx, useLeadsRoute).
    expect(src).toContain("useLeadsRoute()");
    expect(src).toContain("if (inFlight.current || !area.trim() || !maxOk) return;");
    expect(src).toContain('source: "osm", websitePresence');
  });
});
