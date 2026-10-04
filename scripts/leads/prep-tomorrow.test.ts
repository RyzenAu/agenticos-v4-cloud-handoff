import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, openCrm, upsertLead } from "./crm";
import { buildMorningPack, prepDir, renderMorningPack, tomorrow, writeMorningPack } from "./prep-tomorrow";
import type { SeoAuditRecord } from "./seo-audit";

const GOOD_REPLY = {
  opener: "Hi, it's Usman from M&U Ventures — quick one about your site?",
  discovery: ["How are new patients finding you?", "What happens when the front desk is busy?"],
  valuePitch: "A modern site means bookings don't drop off.",
  objections: {
    price: "It pays for itself.", already_have_website: "This is a fix, not a rebuild.",
    send_email: "Happy to, can I also text a time?", not_now: "When's better?", ask_partner: "Want a one-pager?",
  },
  close: "Can I grab 15 minutes to show you a free preview?",
  followupEmail: { subject: "A quick idea", body: "Hi team… Reply STOP to opt out." },
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "prep-tomorrow-"));
  const db = openCrm(join(dir, "crm.sqlite"));
  upsertLead(db, {
    placeId: "osm:node/1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "(02) 9621 1234",
    address: "1 Main St", website: "http://smiledental.com.au", mapsUrl: "", rating: 4.5, reviews: 10,
    emails: ["reception@smiledental.com.au"], emailOk: true, score: 90, pitch: "website",
    reasons: ["site has no online booking"], googleAt: null, source: "osm", attribution: "© OpenStreetMap contributors",
  });
  const lead = findLead(db, "osm:node/1")!;
  return { root: dir, db, lead };
}

const okSeo: SeoAuditRecord = {
  ok: true, leadId: 1, domain: "smiledental.com.au", startedAt: "", finishedAt: "", error: null, overall: null, grade: null,
  topFindings: [{ id: "a", severity: "medium", priority: "p2", category: "seo", title: "No online booking link", evidence: "" }],
  costUsd: null, files: { pdf: false, xlsx: true, md: true, json: true },
};

const complete = async () => ({ choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] });

describe("tomorrow", () => {
  test("is exactly 24h after now", () => {
    const now = new Date("2026-09-23T10:00:00+10:00");
    expect(tomorrow(now).getTime() - now.getTime()).toBe(24 * 3_600_000);
  });
});

describe("buildMorningPack", () => {
  test("produces an empty, explained pack when tomorrow is Sunday", async () => {
    const { root, db } = setup();
    const pack = await buildMorningPack(db, { root, draftsRoot: root, now: new Date("2026-09-26T20:00:00+10:00") });
    expect(pack.callWindow.open).toBe(false);
    expect(pack.items).toEqual([]);
    expect(pack.date).toBe("2026-09-27");
    const md = renderMorningPack(pack);
    expect(md).toContain("No calls tomorrow");
  });

  test("preps a weekday call list with SEO, preview and script results, all best-effort", async () => {
    const { root, db } = setup();
    const pack = await buildMorningPack(db, {
      root, draftsRoot: root, now: new Date("2026-09-23T10:00:00+10:00"),
      runSeoAuditFn: async () => okSeo,
      generatePreviewFn: async () => { throw new Error("no flagship template built in this test"); },
      complete,
    });
    expect(pack.callWindow.open).toBe(true);
    expect(pack.items.length).toBe(1);
    const item = pack.items[0];
    expect(item.opener).toContain("Usman");
    expect(item.seo.ok).toBe(true);
    expect(item.seo.note).toContain("No online booking link");
    expect(item.preview.ok).toBe(false);
    expect(item.preview.note).toContain("Skipped");
    expect(item.script.ok).toBe(true);
    expect(item.script.script?.close).toContain("15 minutes");
  });

  test("a failing SEO audit and script generation degrade to notes, never throw", async () => {
    const { root, db } = setup();
    const pack = await buildMorningPack(db, {
      root, draftsRoot: root, now: new Date("2026-09-23T10:00:00+10:00"),
      runSeoAuditFn: async () => { throw new Error("no TYPESAFE_API_KEY configured"); },
      generatePreviewFn: async () => { throw new Error("no template"); },
      complete: async () => { throw new Error("no Claude subscription bridge in test"); },
    });
    expect(pack.items.length).toBe(1);
    expect(pack.items[0].seo.ok).toBe(false);
    expect(pack.items[0].seo.note).toContain("Skipped");
    expect(pack.items[0].script.ok).toBe(false);
  });
});

describe("writeMorningPack", () => {
  test("writes index.md under .operator-data/prep/<date>/", async () => {
    const { root, db } = setup();
    const pack = await buildMorningPack(db, {
      root, draftsRoot: root, now: new Date("2026-09-23T10:00:00+10:00"),
      runSeoAuditFn: async () => okSeo,
      generatePreviewFn: async () => { throw new Error("no template"); },
      complete,
    });
    const file = writeMorningPack(root, pack);
    expect(file).toBe(join(prepDir(root, pack.date), "index.md"));
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("Morning pack -- 2026-09-24");
    expect(text).toContain("Smile Dental");
  });
});
