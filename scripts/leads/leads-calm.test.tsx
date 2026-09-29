// W-B (29 Sep 2026): Leads calm pass. Same structure (call queue, morning overview, pipeline); less
// alarm colour and less at once. Nothing true is removed: every tile, filter and card field remains.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CallQueue, LeadCards } from "../../src/components/operator/call-queue";
import type { BoardLead } from "../../src/lib/leads";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const CLOSED = Date.parse("2026-09-28T07:00:00+10:00");
function lead(id: number, patch: Partial<BoardLead> = {}): BoardLead {
  return { id, name: "Fixture practice", area: "Parramatta NSW", phone: "0299990000", website: "", address: "", mapsUrl: "", emails: [], emailOk: false,
    vertical: "dental", score: 50, pitch: "website", reasons: [], status: "to_call", owner: "usman",
    nextAt: "2026-09-28T06:00:00+10:00", lastContactAt: null, createdAt: "2026-09-01T00:00:00Z",
    deal: { closed: false, stage: "found", nextAction: "Call", evidence: "CRM", owner: "agent", stageSince: null, daysInStage: null, daysInferred: false, stuck: null,
      economics: {} as BoardLead["deal"]["economics"], contactPref: "", issues: [] }, ...patch };
}

describe("Leads: calmer, nothing removed", () => {
  test("'Website not verified' is still said on the card, as a neutral fact rather than an amber alarm", () => {
    const src = read("src/components/operator/call-queue.tsx");
    expect(src).toContain('<Badge tone={verification === "Website verified" ? "success" : "neutral"}>{verification}</Badge>');
    expect(renderToStaticMarkup(<LeadCards leads={[lead(1)]} now={CLOSED} onOpen={() => {}} />)).toContain("Website not verified");
  });
  test("closed calling hours: the same words, as a calm line (not a warning box)", () => {
    const html = renderToStaticMarkup(<CallQueue leads={[lead(1)]} now={CLOSED} loading={false} error={null} onOpen={() => {}} />);
    expect(html).toContain("Calling hours closed");
    expect(html).toContain("Mon–Fri 9am–8pm · Sat 9am–5pm.");
    expect(html).not.toContain('role="alert"');
  });
  test("overview: four numbers up front, the other tiles folded under 'More numbers'; overdue is warn, not red", () => {
    const src = read("src/components/operator/crm-overview.tsx");
    const up = src.indexOf('label="Overdue"');
    const fold = src.indexOf('summary={<span className="font-medium">More numbers</span>}');
    expect(up).toBeGreaterThan(0);
    expect(fold).toBeGreaterThan(up);
    for (const label of ['label="Proposals out"', 'label="Builds"', 'label="Owed to us"', 'label="Net cash (NAB CSV), not margin"']) expect(src.indexOf(label)).toBeGreaterThan(fold);
    expect(src).toContain('tone={t.followUps.overdue ? "warn" : "default"}');
    // A tile filter that lives in the fold opens it.
    expect(src).toContain('defaultOpen={active === "proposal" || active === "builds" || active === "clients"}');
  });
  test("pipeline: 10 cards first (then 20 more at a time); search up front, the other filters folded and open when set", () => {
    const src = read("src/components/operator/leads-crm.tsx");
    expect(src).toContain("const LIST_PAGE = 10;");
    expect(src).toContain("setLimit((n) => n + LIST_PAGE * 2)");
    expect(src).toContain('<Disclosure summary={<span className="font-medium">Filters</span>}');
    expect(src).toContain("defaultOpen={more > 0}");
    for (const f of ['id="verified-only"', 'id="show-excluded"', 'all="All verticals"', 'all="All pitches"', 'all="All statuses"']) expect(src).toContain(f);
  });
});
