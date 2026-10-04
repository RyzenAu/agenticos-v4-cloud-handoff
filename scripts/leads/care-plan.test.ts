import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, openCrm, upsertLead } from "./crm";
import { buildCarePlanDraft, carePlanClientSlug, carePlanDir, gatherCarePlanData, monthChanges, renderCarePlanSummary } from "./care-plan";
import type { SeoAuditRecord } from "./seo-audit";
import type { SiteAudit } from "./site-audit";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "care-plan-"));
  const database = openCrm(join(dir, "crm.sqlite"));
  upsertLead(database, {
    placeId: "osm:node/1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "(02) 9621 1234",
    address: "1 Main St", website: "http://smiledental.com.au", mapsUrl: "", rating: 4.5, reviews: 10,
    emails: ["reception@smiledental.com.au"], emailOk: true, score: 90, pitch: "website",
    reasons: [], googleAt: null, source: "osm", attribution: "© OpenStreetMap contributors",
  });
  const lead = findLead(database, "osm:node/1")!;
  return { root: dir, db: database, lead };
}

const okSeo: SeoAuditRecord = {
  ok: true, leadId: 1, at: "2026-09-25T00:00:00Z", domain: "smiledental.com.au",
  topFindings: [{ id: "a", severity: "medium", priority: "p2", category: "seo", title: "Missing meta description on /contact", evidence: "…" }],
  files: { pdf: false, xlsx: true, md: true, json: true },
} as unknown as SeoAuditRecord;

const okAudit: SiteAudit = {
  reachable: true, finalUrl: "http://smiledental.com.au", https: false, mobileViewport: true, onlineBooking: false,
  chatWidget: false, contactForm: true, responseMs: 340, copyrightYear: 2026, platform: "custom", emails: [], phones: [],
  noUnsolicited: false, statusCode: 200, broken: false, sslError: false, overflowAt390: null, outdatedTechSignals: [], challengePage: false,
} as unknown as SiteAudit;

describe("carePlanClientSlug", () => {
  test("slugifies the business name", () => {
    const { lead } = setup();
    expect(carePlanClientSlug(lead)).toBe("smile-dental");
  });
});

describe("monthChanges", () => {
  test("none when neither a CHANGES.md nor a repo path exists", () => {
    const { root } = setup();
    const r = monthChanges(root, "smile-dental", "2026-09");
    expect(r.source).toBe("none");
    expect(r.items).toEqual([]);
  });
  test("reads a CHANGES.md file when present", () => {
    const { root } = setup();
    mkdirSync(join(root, ".operator-data", "care-plan", "smile-dental"), { recursive: true });
    writeFileSync(join(root, ".operator-data", "care-plan", "smile-dental", "CHANGES.md"), "- Fixed the booking form\n- Added a new gallery page\n");
    const r = monthChanges(root, "smile-dental", "2026-09");
    expect(r.source).toBe("changes-file");
    expect(r.items).toEqual(["Fixed the booking form", "Added a new gallery page"]);
  });
});

describe("gatherCarePlanData", () => {
  test("uses injected SEO/uptime checks and never calls the network in a test", async () => {
    const { root, db, lead } = setup();
    const data = await gatherCarePlanData(db, lead, {
      root, month: "2026-09", now: new Date("2026-09-25T00:00:00Z"),
      runSeoAuditFn: async () => okSeo,
      auditSiteFn: async () => okAudit,
    });
    expect(data.seo.ok).toBe(true);
    expect(data.seo.topFindings).toEqual(["Missing meta description on /contact"]);
    expect(data.uptime.ok).toBe(true);
    expect(data.uptime.responseMs).toBe(340);
    expect(data.slug).toBe("smile-dental");
  });

  test("a failing SEO audit degrades to a note, never throws", async () => {
    const { root, db, lead } = setup();
    const data = await gatherCarePlanData(db, lead, {
      root, runSeoAuditFn: async () => { throw new Error("no TYPESAFE_API_KEY configured"); },
      auditSiteFn: async () => okAudit,
    });
    expect(data.seo.ok).toBe(false);
    expect(data.seo.note).toContain("SEO audit skipped");
  });

  test("no website on file skips both checks cleanly", async () => {
    const { root, db, lead } = setup();
    lead.website = "";
    const data = await gatherCarePlanData(db, lead, { root });
    expect(data.seo.note).toBe("No website on file.");
    expect(data.uptime.note).toBe("No website on file.");
  });
});

describe("buildCarePlanDraft", () => {
  test("writes email.md and report.html, draft only", async () => {
    const { root, db, lead } = setup();
    const draft = await buildCarePlanDraft(db, lead, {
      root, month: "2026-09", now: new Date("2026-09-25T00:00:00Z"),
      runSeoAuditFn: async () => okSeo, auditSiteFn: async () => okAudit,
    });
    const dir = carePlanDir(root, "smile-dental", "2026-09");
    expect(draft.paths.emailPath).toBe(join(dir, "email.md"));
    expect(existsSync(draft.paths.emailPath)).toBe(true);
    expect(existsSync(draft.paths.reportPath)).toBe(true);
    const email = readFileSync(draft.paths.emailPath, "utf8");
    expect(email).toContain("Subject: Smile Dental — monthly care plan (2026-09)");
    expect(email).toContain("Missing meta description on /contact");
    const html = readFileSync(draft.paths.reportPath, "utf8");
    expect(html).toContain("Draft only");
    expect(draft.email.model).toContain("template"); // MIMO_BULK isn't set in tests
  });

  test("renderCarePlanSummary reports draft-only status", async () => {
    const { root, db, lead } = setup();
    const draft = await buildCarePlanDraft(db, lead, {
      root, month: "2026-09", runSeoAuditFn: async () => okSeo, auditSiteFn: async () => okAudit,
    });
    const summary = renderCarePlanSummary(draft);
    expect(summary).toContain("Draft only -- nothing sent.");
    expect(summary).toContain("Smile Dental");
  });
});
