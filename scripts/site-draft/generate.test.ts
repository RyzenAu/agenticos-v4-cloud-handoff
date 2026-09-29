import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead } from "../leads/crm";
import { draftSite, slugify, telHref, renderDraftHtml } from "./generate";
import { VERTICAL_COPY } from "./vertical-copy";
import type { Lead } from "../leads/crm";

describe("slugify", () => {
  test("lowercases, strips punctuation, hyphenates", () => {
    expect(slugify("St Clair Dental", 1)).toBe("st-clair-dental");
    expect(slugify("O'Brien & Co.", 2)).toBe("o-brien-co");
  });
  test("falls back to the lead id when the name is unusable", () => {
    expect(slugify("", 7)).toBe("lead-7");
    expect(slugify("***", 8)).toBe("lead-8");
  });
});

describe("telHref", () => {
  test("keeps only digits and a leading +", () => {
    expect(telHref("+61 2 9670 3195")).toBe("+61296703195");
    expect(telHref("")).toBe("");
  });
});

const baseLead: Lead = {
  id: 1, placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "St Clair Dental",
  phone: "+61 2 9670 3195", address: "162 Bennett Road, St Clair NSW 2759", website: "", mapsUrl: "",
  rating: null, reviews: null, emails: [], emailOk: false, score: 45, pitch: "website", reasons: [],
  status: "new", owner: "", nextAt: null, lastContactAt: null, googleAt: null, createdAt: "2026-01-01T00:00:00Z",
  source: "google", attribution: "",
};

describe("renderDraftHtml", () => {
  const template = readFileSync(join(import.meta.dir, "templates", "base.html"), "utf8");
  const html = renderDraftHtml(baseLead, template, new Date("2026-09-24"));

  test("fills only real lead facts and generic vertical copy", () => {
    expect(html).toContain("St Clair Dental");
    expect(html).toContain("Mount Druitt");
    expect(html).toContain("+61 2 9670 3195");
    expect(html).toContain("162 Bennett Road, St Clair NSW 2759");
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
    for (const service of VERTICAL_COPY.dental.services) expect(html).toContain(escape(service));
  });

  test("never invents staff, reviews, awards or photos of people", () => {
    const lower = html.toLowerCase();
    for (const word of ["our team includes", "voted best", "5 star", "★★★★★", "award-winning", "<img"]) {
      expect(lower).not.toContain(word.toLowerCase());
    }
  });

  test("leaves no unresolved {{TOKEN}} placeholders", () => {
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });

  test("an unlisted address is disclosed as such, not invented", () => {
    const noAddress = renderDraftHtml({ ...baseLead, address: "" }, template);
    expect(noAddress).toContain("exact address not on file");
  });
});

describe("draftSite", () => {
  let dir: string;
  let dbFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-site-draft-test-"));
    dbFile = join(dir, "crm.sqlite");
  });

  test("writes index.html and README, and logs a CRM note", async () => {
    const db = openCrm(dbFile);
    upsertLead(db, {
      placeId: "p1", vertical: "dental", area: "Mount Druitt NSW", name: "St Clair Dental",
      phone: "+61 2 9670 3195", address: "162 Bennett Road, St Clair NSW 2759", website: "", mapsUrl: "",
      rating: null, reviews: null, emails: [], emailOk: false, score: 45, pitch: "website", reasons: [],
      googleAt: null, source: "google", attribution: "",
    });
    const draftsRoot = join(dir, "drafts");
    const result = await draftSite(db, "St Clair Dental", { draftsRoot, by: "test" });
    expect(result.slug).toBe("st-clair-dental");
    expect(existsSync(result.indexPath)).toBe(true);
    expect(existsSync(join(result.dir, "README.md"))).toBe(true);
    const note = db.query("SELECT note FROM activities WHERE lead_id = ?").get(result.lead.id) as { note: string };
    expect(note.note).toContain("draft site ready");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws a clear error for an unknown lead", async () => {
    const db = openCrm(dbFile);
    await expect(draftSite(db, "Nonexistent Business", { draftsRoot: dir })).rejects.toThrow(/No CRM lead matches/);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
