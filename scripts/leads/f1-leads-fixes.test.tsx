// Audit F1 (28 Sep 2026) fixes in Leads, the lead drawer and the call queue, through the real
// /leads API on a temp CRM (synthetic, fictional leads; nothing is sent, dialled or charged).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { findLead, logActivity, openCrm, upsertLead, type Lead } from "./crm";
import { createLeadsApi, validateLogBody } from "./api";
import { crmOverview, saveDeal } from "./deals";
import { readDraft } from "./sales-backoffice";
import { selectCallQueue } from "../../src/lib/call-queue";
import { projectCallQueue } from "../workspace/projections";
import { LOCAL_RECEIVABLES, receivablesSummary } from "../finance/receivables";
import { pitchFilterOptions, taggedReasons, type BoardLead, type Lead as ClientLead } from "../../src/lib/leads";
import { SalesBackofficePanel } from "../../src/components/operator/sales-backoffice-panel";
import { chosenPackage, retryUnlessClientError, sydneyToday } from "../../src/components/operator/lead-drawer";
import { parseDealAmount } from "../../src/components/operator/deal-block";
import { LeadsTable } from "../../src/components/operator/leads-table";

const P = new URLSearchParams();
let seq = 0;
function add(db: Database, patch: Partial<Parameters<typeof upsertLead>[1]> = {}): Lead {
  seq += 1;
  return upsertLead(db, {
    placeId: `osm:node/f1-${seq}-${Math.random()}`, source: "osm", attribution: "© OpenStreetMap contributors", vertical: "dental",
    area: "Blacktown NSW", name: `Synthetic Dental ${seq} (fictional)`, phone: "02 9000 0000", address: "", website: "", mapsUrl: "",
    rating: null, reviews: null, emails: [], emailOk: false, score: 50, pitch: "receptionist", reasons: [], googleAt: null, ...patch,
  });
}
async function withApi(run: (api: ReturnType<typeof createLeadsApi>, db: Database, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "f1-leads-"));
  const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
  try {
    const api = createLeadsApi(root, { db, hunt: () => ({ status: "never", ranAt: null, area: null, added: 0, errors: [], overdue: false }) as never });
    await run(api, db, root);
  } finally {
    db.close();
    Bun.gc(true);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

describe("F1-01: one call queue everywhere", () => {
  test("Today, Work, the Leads call queue and /leads/calls give the same count from real leadPipeline output", () => withApi(async (api, db) => {
    const now = Date.now();
    const due = [
      logActivity(db, add(db, { name: "Callback due (fictional)" }), { kind: "call", outcome: "call_back", by: "usman", nextAt: iso(now - HOUR) }),
      logActivity(db, add(db, { name: "Overdue retry (fictional)", score: 80 }), { kind: "call", outcome: "no_answer", by: "usman", nextAt: iso(now - 48 * HOUR) }),
    ];
    // Not due: never scheduled, tomorrow, warm (not a call status), no phone, excluded, do-not-contact.
    add(db, { name: "Never scheduled (fictional)" });
    logActivity(db, add(db), { kind: "call", outcome: "call_back", by: "usman", nextAt: iso(now + 36 * HOUR) });
    logActivity(db, add(db), { kind: "call", outcome: "interested", by: "usman", nextAt: iso(now - HOUR) });
    logActivity(db, add(db, { phone: "" }), { kind: "email", outcome: "call_back", by: "usman", nextAt: iso(now - HOUR) });
    logActivity(db, add(db, { excluded: true, excludedReason: "government (fictional)" }), { kind: "note", outcome: "call_back", by: "usman", nextAt: iso(now - HOUR) });
    logActivity(db, add(db), { kind: "call", outcome: "do_not_contact", by: "usman", nextAt: iso(now - HOUR) });

    // The Leads page, Today and Work all read /__operator/leads/list?deals=1 (dealRows → leadPipeline).
    const list = await api.handle("/leads/list", "GET", {}, new URLSearchParams("deals=1"), false) as { leads: BoardLead[] };
    expect(list.leads.every((l) => typeof l.deal?.nextAction === "string")).toBe(true);
    // Real stage actions never start with "call" — the old text test emptied the queue.
    expect(list.leads.some((l) => /^call/i.test(l.deal.nextAction))).toBe(false);

    const leadsQueue = selectCallQueue(list.leads, now);
    const today = projectCallQueue(list.leads, now);                    // Today's tile and Work's panel
    const calls = await api.handle("/leads/calls", "GET", {}, P, false) as { due: number }; // Business "Today's calls"
    expect(leadsQueue.map((l) => l.id).sort()).toEqual(due.map((l) => l.id).sort());
    expect(today.total).toBe(2);
    expect(leadsQueue).toHaveLength(2);
    expect(calls.due).toBe(2);
    expect(leadsQueue[0].status).toBe("call_back"); // callbacks first
  }));
});

describe("F1-02: drafts are priced only from a chosen package", () => {
  const assumed = { record: { packageId: null }, economics: { packageId: "receptionist-essential", packageState: { state: "assumed" } } };
  const chosen = { record: { packageId: "receptionist-professional" }, economics: { packageId: "receptionist-professional", packageState: { state: "chosen" } } };
  const draftButton = (html: string, label: string) => new RegExp(`<button[^>]*>[^<]*${label}`).exec(html)?.[0] ?? "";

  test("the drawer passes no package when Essential is only assumed: selector unset, warning shown, drafts disabled", () => {
    expect(chosenPackage(assumed)).toBeNull();
    expect(chosenPackage(undefined)).toBeNull();
    expect(chosenPackage(chosen)).toBe("receptionist-professional");
    const html = renderToStaticMarkup(<SalesBackofficePanel id={3} offer="both" packageId={chosenPackage(assumed)} refresh={() => {}} />);
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose a package/);
    expect(html).not.toMatch(/<option[^>]*value="receptionist-essential"[^>]*selected/);
    expect(html).toContain("Package not chosen");
    expect(draftButton(html, "Draft proposal")).toContain("disabled=\"\"");
    expect(draftButton(html, "Draft deposit invoice")).toContain("disabled=\"\"");
  });

  test("with a chosen package the selector shows it and the drafts are enabled", () => {
    const html = renderToStaticMarkup(<SalesBackofficePanel id={3} offer="both" packageId={chosenPackage(chosen)} refresh={() => {}} />);
    expect(html).toMatch(/<option value="receptionist-professional" selected="">/);
    expect(html).not.toContain("Package not chosen");
    expect(draftButton(html, "Draft proposal")).not.toContain("disabled=\"\"");
  });

  test("server: the drawer's old request ({packageId: essential} with nothing saved) is refused; nothing is written", () => withApi(async (api, db, root) => {
    const l = add(db, { pitch: "both" });
    await expect(api.handle("/leads/proposal", "POST", { lead: l.id, packageId: "receptionist-essential" }, P, false)).rejects.toThrow("Choose the receptionist package");
    await expect(api.handle("/leads/deposit-invoice", "POST", { lead: l.id, packageId: "receptionist-essential" }, P, false)).rejects.toThrow("Choose the receptionist package");
    expect(() => readDraft(root, l.id, "proposal.md")).toThrow();
    saveDeal(db, l.id, { packageId: "receptionist-premium" });
    await expect(api.handle("/leads/proposal", "POST", { lead: l.id, packageId: "receptionist-essential" }, P, false)).rejects.toThrow("saved as Premium, not Essential");
    await api.handle("/leads/proposal", "POST", { lead: l.id, packageId: "receptionist-premium" }, P, false);
    expect(readDraft(root, l.id, "proposal.md")).toContain("A$1,999.00/month");
  }));
});

describe("F1-14 / F1-15 / F1-16: the deal block and the server check what they're given", () => {
  test("deal amounts: negative and malformed are refused, never flipped or cleared", () => {
    expect(() => parseDealAmount("-50", "Setup")).toThrow("Setup can't be negative.");
    expect(() => parseDealAmount("−50", "Setup")).toThrow("can't be negative");
    for (const bad of ["1.2.3", "abc", "12.345", "1,2"]) expect(() => parseDealAmount(bad, "Monthly")).toThrow("Monthly must be an amount");
    expect(() => parseDealAmount("20000000", "Setup")).toThrow("A$1,000,000 or less");
    expect(parseDealAmount("", "Setup")).toBeNull();
    expect(parseDealAmount("1,099", "Monthly")).toBe(109_900);
    expect(parseDealAmount("A$1,500.50", "Setup")).toBe(150_050);
  });

  test("expected close and follow-up dates must be real calendar days", () => withApi(async (api, db) => {
    const l = add(db);
    await expect(api.handle("/leads/deal", "POST", { lead: l.id, expectedClose: "2026-02-30", by: "usman" }, P, false)).rejects.toThrow("Expected close must be a date");
    const ok = await api.handle("/leads/deal", "POST", { lead: l.id, expectedClose: "2026-10-15", by: "usman" }, P, false) as any;
    expect(ok.deal.record.expectedClose).toBe("2026-10-15");
    expect(() => validateLogBody({ lead: 1, outcome: "no_answer", next: "2026-02-30" })).toThrow("That follow-up date isn't valid.");
    expect(validateLogBody({ lead: 1, outcome: "call_back", next: "2026-10-01" }, new Date("2026-09-30T00:00:00Z")).next).toBe(new Date("2026-10-01").toISOString());
  }));

  test("call back needs a date; excluded and closed leads get no proposal or invoice", () => withApi(async (api, db, root) => {
    expect(() => validateLogBody({ lead: 1, outcome: "call_back" })).toThrow("A call back needs a date.");
    const excluded = add(db, { pitch: "redesign", excluded: true, excludedReason: "chain (fictional)" });
    for (const path of ["/leads/proposal", "/leads/deposit-invoice"])
      await expect(api.handle(path, "POST", { lead: excluded.id }, P, false)).rejects.toThrow("Excluded leads don't get proposals or invoices.");
    const lost = logActivity(db, add(db, { pitch: "redesign" }), { kind: "call", outcome: "not_interested", by: "usman" });
    await expect(api.handle("/leads/proposal", "POST", { lead: lost.id }, P, false)).rejects.toThrow("This lead is closed (not interested)");
    expect(() => readDraft(root, excluded.id, "proposal.md")).toThrow();
    expect(findLead(db, excluded.id)!.excluded).toBe(true);
  }));

  test("the Call back date can't be before today (Sydney)", () => {
    expect(sydneyToday(Date.parse("2026-09-28T15:00:00Z"))).toBe("2026-09-29"); // 1 am Tue in Sydney
  });
});

describe("F1-17: a bad lead id shows at once", () => {
  test("4xx is never retried; network and 5xx still are", () => {
    expect(retryUnlessClientError(0, Object.assign(new Error("Lead not found."), { status: 400 }))).toBe(false);
    expect(retryUnlessClientError(0, Object.assign(new Error("gone"), { status: 404 }))).toBe(false);
    expect(retryUnlessClientError(0, Object.assign(new Error("busy"), { status: 503 }))).toBe(true);
    expect(retryUnlessClientError(0, new Error("offline"))).toBe(true);
    expect(retryUnlessClientError(3, new Error("offline"))).toBe(false);
  });
});

describe("F1-24: money owed says what it is", () => {
  test("the client record's A$825 is due at launch, not an issued invoice", () => {
    const s = receivablesSummary(LOCAL_RECEIVABLES);
    expect(s.cents).toBe(82_500);
    expect(s.invoicedCount).toBe(0);
    expect(s.label).toBe("1 payment due at launch (agreed, not yet invoiced)");
    expect(s.label).not.toMatch(/outstanding invoice/i);
    expect(s.source).toContain("client record");
    expect(receivablesSummary([{ client: "Test Co (fictional)", amountAud: 100, note: "final", invoiced: true }]).label).toBe("1 issued invoice unpaid");
    expect(receivablesSummary([]).label).toBe("Nothing owed on the client record");
  });

  test("the overview tile carries the label and its source", () => withApi(async (_api, db, root) => {
    const o = crmOverview(root, db, { receivables: LOCAL_RECEIVABLES });
    expect(o.tiles.invoices).toMatchObject({ count: 1, cents: 82_500, invoicedCount: 0, label: "1 payment due at launch (agreed, not yet invoiced)" });
  }));
});

describe("F1-26 / F1-29 / F1-30: honest chips, filters and keyboard rows", () => {
  const base: ClientLead = {
    id: 2, vertical: "dental", area: "Parramatta NSW", name: "Fixture practice (fictional)", phone: "0299990000", address: "", website: "", mapsUrl: "",
    emails: [], emailOk: false, score: 50, pitch: "website", reasons: [], status: "new", owner: "", nextAt: null, lastContactAt: null, createdAt: "2026-09-01T00:00:00Z",
  };
  test("a reason rewritten to 'Website not verified' loses its [verified] flag", () => {
    const tagged = taggedReasons({ ...base, reasons: ["No website found (checked)", "No online booking"], verified: [true, true] });
    expect(tagged).toEqual([{ text: "Website not verified (checked)", verified: false }, { text: "No online booking", verified: true }]);
  });

  test("the pitch filter separates offers from the no-pitch-yet states", () => {
    const labels = pitchFilterOptions().map((o) => o.label);
    expect(labels).toEqual(["Redesign", "Receptionist", "Site + receptionist", "No pitch yet · Website not verified", "No pitch yet · Audit pending"]);
  });

  test("table rows aren't role-less tab stops; the company name is a real button", () => {
    const lead: BoardLead = { ...base, deal: {
      stage: "found", closed: false, evidence: "CRM", nextAction: "Verify", owner: "agent", stageSince: null, daysInStage: null, daysInferred: false, stuck: null,
      economics: { valueCents: 0, weightedCents: 0, probability: 0.02 } as BoardLead["deal"]["economics"], contactPref: "", issues: [],
    } };
    const html = renderToStaticMarkup(<LeadsTable leads={[lead]} onOpen={() => {}} />);
    expect(html).not.toMatch(/<tr[^>]*tabindex/i);
    expect(html).toMatch(/<button[^>]*aria-label="Open Fixture practice \(fictional\)"/);
  });
});
