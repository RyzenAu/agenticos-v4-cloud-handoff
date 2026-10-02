import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCrm, findLead, upsertLead, logActivity } from "../leads/crm";
import { editLead, leadEditVersion } from "../leads/edit";
import { CrmStore, type CrmChange } from "./store";
import { SALES_STAGES, type Attribution, type Company, type Task } from "./types";
const by: Attribution = { personId: "usman" },
  other: Attribution = { personId: "mehroz" };
const opened: Database[] = [],
  dirs: string[] = [];
const open = (legacy = false) => {
  const db = legacy ? openCrm(":memory:") : new Database(":memory:");
  opened.push(db);
  return db;
};
function legacy(db: Database, id = 1, overrides: Record<string, unknown> = {}) {
  const values = {
    id,
    place_id: `osm:node/${id}`,
    vertical: "dental",
    source: "osm",
    name: `Synthetic ${id}`,
    phone: "0299990000",
    website: "https://synthetic.example",
    field_sources: '{"name":"osm","phone":"osm","website":"osm"}',
    owner: "usman",
    ...overrides,
  };
  db.query(
    `INSERT INTO leads(${Object.keys(values).join(",")}) VALUES(${Object.keys(values)
      .map(() => "?")
      .join(",")})`,
  ).run(...(Object.values(values) as any[]));
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("CRM authoritative store", () => {
  test("both founders persist manual companies without source identifiers and contacts stay relational", () => {
    const db = open(),
      s = new CrmStore(db);
    const c = s.createCompany({ name: "Synthetic", owner: "usman" }, by);
    const one = s.createContact({ companyId: c.id, name: "One", primary: true }, by);
    const two = s.createContact({ companyId: c.id, name: "Two", primary: true }, other);
    expect(s.getContact(one.id)?.primary).toBe(false);
    expect(two.primary).toBe(true);
    expect(s.getCompany(c.id)?.legacyLeadId).toBeNull();
    expect(() => s.updateContact(one.id, { role: "Stale" }, one.version, by)).toThrow("changed");
    expect(s.updateCompany(c.id, { name: "Either founder" }, c.version, other).name).toBe(
      "Either founder",
    );
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  test("multi-connection optimistic concurrency survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-concurrency-"));
    dirs.push(dir);
    const file = join(dir, "crm.sqlite");
    const a = new Database(file),
      b = new Database(file);
    opened.push(a, b);
    const first = new CrmStore(a),
      second = new CrmStore(b);
    const c = first.createCompany({ name: "Original" }, by);
    const view = second.getCompany(c.id)!;
    first.updateCompany(c.id, { notes: "Saved" }, c.version, by);
    expect(() => second.updateCompany(c.id, { notes: "Stale" }, view.version, other)).toThrow(
      "changed",
    );
    const third = new Database(file);
    opened.push(third);
    expect(new CrmStore(third).getCompany(c.id)?.notes).toBe("Saved");
  });
  test("commit notifications are delayed, no ghost notifications after rollback or replay", () => {
    const s = new CrmStore(open()),
      changes: CrmChange[] = [];
    s.subscribe((c) => changes.push(c));
    let company: Company | undefined;
    s.transaction(() => {
      company = s.createCompany({ name: "Atomic" }, by);
      expect(changes).toHaveLength(0);
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].ref.id).toBe(company!.id);
    expect(() =>
      s.transaction(() => {
        s.createCompany({ name: "Rolled back" }, by);
        throw new Error("Rollback");
      }),
    ).toThrow("Rollback");
    expect(changes).toHaveLength(1);
    expect(s.snapshot().companies).toHaveLength(1);
    const input = {
      ref: { kind: "company" as const, id: company!.id },
      eventId: "event-1",
      kind: "note",
      title: "Done",
    };
    const a = s.addActivity(input, by);
    expect(s.addActivity(input, by).id).toBe(a.id);
    expect(changes).toHaveLength(2);
    const task = s.createTask({ companyId: company!.id, title: "Do it" }, by);
    s.updateTask(task.id, { status: "done" }, task.version, other);
    expect(changes.at(-1)?.ref).toEqual({ kind: "company", id: company!.id });
  });
  test("lost opportunities leave company and other deals open; edited pipeline retains history", () => {
    const s = new CrmStore(open()),
      c = s.createCompany({ name: "Sales" }, by);
    const a = s.createDeal({ companyId: c.id, title: "First" }, by);
    const b = s.createDeal({ companyId: c.id, title: "Second" }, by);
    const lost = s.updateDeal(a.id, { stageId: "lost", closeReason: "Timing" }, a.version, by);
    expect(lost.stageHistory.at(-1)?.reason).toBe("Timing");
    expect(s.getCompany(c.id)?.status).toBe("prospect");
    expect(s.getDeal(b.id)?.stageId).toBe("new");
    const p = s.getPipeline("sales")!;
    s.savePipeline(
      {
        id: p.id,
        name: "Custom sales",
        stages: p.stages
          .filter((x) => x.id !== "proposal")
          .map((x) => (x.id === "new" ? { ...x, name: "Fresh" } : x)),
      },
      p.version,
      by,
    );
    expect(s.getPipeline("sales")?.stages.find((x) => x.id === "proposal")?.archived).toBe(true);
    expect(s.getDeal(b.id)?.stageHistory[0].stageName).toBe("New");
    expect(() => s.moveDeal(b.id, "proposal", b.version, by)).toThrow("active");
  });
  test("task complete/reopen/reassignment remain distinct from activity history", () => {
    const s = new CrmStore(open()),
      c = s.createCompany({ name: "Promises" }, by);
    const t = s.createTask(
      {
        companyId: c.id,
        title: "Call Tuesday",
        kind: "promise",
        dueAt: "2026-10-06T09:00:00+11:00",
      },
      by,
    );
    const done = s.updateTask(t.id, { status: "done" }, t.version, by);
    expect(done.completedAt).toBeTruthy();
    const reopened = s.updateTask(t.id, { status: "open", owner: "mehroz" }, done.version, other);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.owner).toBe("mehroz");
    expect(s.snapshot().activities).toHaveLength(0);
  });
  test("shared optouts cannot be cleared or bypassed through corrected details", () => {
    const s = new CrmStore(open()),
      c = s.createCompany({ name: "Suppressed", phone: "0299991234", doNotContact: true }, by);
    expect(() => s.updateCompany(c.id, { doNotContact: false }, c.version, other)).toThrow(
      "opt-out",
    );
    const changed = s.updateCompany(
      c.id,
      { phone: "0299995678", emailAllowed: true },
      c.version,
      other,
    );
    expect(changed.emailAllowed).toBe(false);
    const second = s.createCompany({ name: "Same phone", phone: "0299995678" }, by);
    expect(second.doNotContact).toBe(true);
    const person = s.createContact(
      { companyId: c.id, name: "Person", email: "person@example.test" },
      by,
    );
    expect(person.doNotContact).toBe(true);
  });
  test("cross-company deal contacts and task links are rejected atomically", () => {
    const s = new CrmStore(open()),
      a = s.createCompany({ name: "A" }, by),
      b = s.createCompany({ name: "B" }, by);
    const contact = s.createContact({ companyId: b.id, name: "B contact" }, by);
    const deal = s.createDeal({ companyId: a.id, title: "A" }, by);
    expect(() => s.updateDeal(deal.id, { contactIds: [contact.id] }, deal.version, by)).toThrow(
      "same company",
    );
    expect(() =>
      s.createTask({ companyId: a.id, title: "Cross", contactId: contact.id }, by),
    ).toThrow("same company");
    expect(s.getDeal(deal.id)?.version).toBe(1);
  });
  test("document versions preserve agreed price and accepted prior content", () => {
    const s = new CrmStore(open()),
      c = s.createCompany({ name: "Documents" }, by);
    const d = s.createDocument(
      {
        companyId: c.id,
        title: "Agreed proposal",
        kind: "proposal",
        content: "Version one",
        pricing: {
          oneOffCents: 180000,
          recurringCents: 10000,
          currency: "AUD",
          gstTreatment: "exclusive",
          catalogueId: "website",
          dealVersion: 1,
        },
      },
      by,
    );
    const accepted = s.updateDocument(d.id, { status: "accepted" }, d.version, by);
    const revised = s.addDocumentVersion(d.id, { content: "Version two" }, accepted.version, other);
    expect(revised.status).toBe("draft");
    expect(revised.versions).toHaveLength(2);
    expect(revised.versions[0].content).toBe("Version one");
    expect(revised.versions[1].pricing).toEqual(revised.versions[0].pricing);
    expect(() => s.addDocumentVersion(d.id, { content: "stale" }, d.version, by)).toThrow(
      "changed",
    );
  });
  test("real delivery states cannot activate receptionist work", () => {
    const s = new CrmStore(open()),
      c = s.createCompany({ name: "Hold" }, by);
    const d = s.createDeal(
      {
        companyId: c.id,
        title: "Historic",
        service: "receptionist",
        oneOffCents: 0,
        catalogueId: null,
        commercialBasis: "legacy-unconfirmed",
      },
      by,
    );
    expect(() =>
      s.createProject({ companyId: c.id, dealId: d.id, name: "Receptionist" }, by),
    ).toThrow("on hold");
    expect(
      s.createProject(
        { companyId: c.id, dealId: d.id, name: "Historical hold", status: "on-hold" },
        by,
      ).status,
    ).toBe("on-hold");
  });
  test("safe legacy bridge respects founder corrections and explicit negotiation across repeated reads", () => {
    const db = open(true);
    legacy(db);
    const s = new CrmStore(db);
    let c = s.getCompany("legacy-company-1")!;
    c = s.updateCompany(
      c.id,
      { name: "Founder correction", website: "https://correct.example" },
      c.version,
      by,
    );
    expect(findLead(db, 1)?.fieldSources?.name).toBe("manual");
    expect(findLead(db, 1)?.name).toBe("Founder correction");
    let deal = s.getDeal("legacy-deal-1")!;
    deal = s.moveDeal(deal.id, "negotiation", deal.version, by);
    for (let i = 0; i < 3; i++) expect(s.snapshot().deals[0].stageId).toBe("negotiation");
    const old = findLead(db, 1)!;
    editLead(db, 1, { version: leadEditVersion(old), by: "mehroz", phone: "0298881234" });
    expect(s.getCompany(c.id)?.phone).toBe("0298881234");
    expect(s.getCompany(c.id)?.name).toBe("Founder correction");
    expect(s.getDeal(deal.id)?.stageId).toBe("negotiation");
    expect(() =>
      s.updateCompany(c.id, { notes: "stale after old UI edit" }, c.version, by),
    ).toThrow("changed");
  });
  test("legacy tasks write due/completion back and old events remain idempotent", () => {
    const db = open(true);
    legacy(db, 1, { next_at: "2026-10-06T00:00:00Z" });
    const s = new CrmStore(db);
    const t = s.getTask("legacy-followup-1")!;
    const done = s.updateTask(t.id, { status: "done" }, t.version, by);
    expect(findLead(db, 1)?.nextAt).toBeNull();
    expect(s.getTask(done.id)?.status).toBe("done");
    const activity = s.addActivity(
      {
        ref: { kind: "company", id: "legacy-company-1" },
        eventId: "legacy-compatible",
        kind: "note",
        title: "One event",
      },
      by,
    );
    logActivity(db, findLead(db, 1)!, {
      kind: "note",
      note: "Retried",
      eventId: "legacy-compatible",
    });
    expect(s.snapshot().activities.filter((a) => a.eventId === "legacy-compatible")).toHaveLength(
      1,
    );
    expect(s.snapshot().activities.find((a) => a.eventId === "legacy-compatible")?.id).toBe(
      activity.id,
    );
  });
  test("Google fields are not copied without independent provenance, including internal agent imports", () => {
    const db = open(true);
    legacy(db, 1, {
      source: "google",
      place_id: "places-id",
      name: "Transient name",
      phone: "0299990000",
      website: "https://transient.example",
      address: "Transient address",
      field_sources: '{"phone":"manual"}',
    });
    const s = new CrmStore(db),
      c = s.getCompany("legacy-company-1")!;
    expect(c.name).toBe("");
    expect(c.phone).toBe("0299990000");
    expect(c.website).toBe("");
    expect(c.address).toBe("");
    expect(() =>
      s.createCompany(
        {
          name: "Provider cache",
          source: { kind: "google", reference: "places2", attribution: "Google" },
        },
        { agent: "research", jobId: "job1" },
      ),
    ).toThrow("provenance");
    expect(db.query("SELECT name FROM leads WHERE id=1").get()).toEqual({ name: "Transient name" });
  });
  test("duplicate merge retains originals, restrictions, source links, children and history", () => {
    const s = new CrmStore(open()),
      keep = s.createCompany({ name: "Keep" }, by),
      dup = s.createCompany(
        { name: "Dup", phone: "0299991234", doNotContact: true, notes: "Original notes" },
        by,
      );
    const contact = s.createContact({ companyId: dup.id, name: "Person" }, by);
    const deal = s.createDeal({ companyId: dup.id, title: "Deal" }, by);
    const task = s.createTask({ companyId: dup.id, title: "Promise" }, by);
    s.addActivity(
      {
        ref: { kind: "company", id: dup.id },
        eventId: "before-merge",
        kind: "note",
        title: "Original event",
      },
      by,
    );
    const merged = s.mergeCompanies(keep.id, dup.id, keep.version, dup.version, other);
    expect(merged.doNotContact).toBe(true);
    expect(merged.notes).toContain("Original notes");
    expect(s.getCompany(dup.id)?.mergedInto).toBe(keep.id);
    expect(s.getContact(contact.id)?.companyId).toBe(keep.id);
    expect(s.getDeal(deal.id)?.companyId).toBe(keep.id);
    expect(s.getTask(task.id)?.companyId).toBe(keep.id);
    expect(s.snapshot().activities.find((a) => a.eventId === "before-merge")?.companyId).toBe(
      keep.id,
    );
  });
});

describe("legacy bridge regression boundaries", () => {
  test("late legacy activity, task, kickoff and deep link resolve to the kept company after merge", () => {
    const db = open(true);
    legacy(db, 1);
    legacy(db, 2, { phone: "0299990002" });
    const s = new CrmStore(db);
    const keep = s.getCompany("legacy-company-1")!,
      duplicate = s.getCompany("legacy-company-2")!;
    s.mergeCompanies(keep.id, duplicate.id, keep.version, duplicate.version, by);
    logActivity(db, findLead(db, 2)!, {
      kind: "note",
      note: "Legacy event after merge",
      nextAt: "2026-10-10T00:00:00Z",
    });
    db.query(
      "INSERT INTO kickoffs(lead_id,scope,checklist,by) VALUES(2,'Scope','{\"milestones\":[]}','usman')",
    ).run();
    const snapshot = s.snapshot();
    expect(s.resolveLegacyLead(2)?.id).toBe(keep.id);
    expect(snapshot.activities.find((a) => a.note === "Legacy event after merge")?.companyId).toBe(
      keep.id,
    );
    expect(s.getTask("legacy-followup-2")?.companyId).toBe(keep.id);
    expect(s.getProject("legacy-project-2")?.companyId).toBe(keep.id);
    expect(s.getCompany(duplicate.id)?.mergedInto).toBe(keep.id);
  });
  test("legacy economics changes do not churn company versions, contact preference stays visible", () => {
    const db = open(true);
    legacy(db);
    db.query(
      "INSERT INTO lead_deals(lead_id,setup_cents,contact_pref) VALUES(1,180000,'Email preferred')",
    ).run();
    const s = new CrmStore(db),
      c = s.getCompany("legacy-company-1")!;
    expect(c.notes).toContain("Email preferred");
    db.query("UPDATE lead_deals SET setup_cents=190000 WHERE lead_id=1").run();
    expect(s.getDeal("legacy-deal-1")?.oneOffCents).toBe(190000);
    expect(s.getCompany(c.id)?.version).toBe(c.version);
    db.query("UPDATE lead_deals SET contact_pref='Call only on Tuesday' WHERE lead_id=1").run();
    expect(s.getCompany(c.id)?.notes).toContain("Call only on Tuesday");
    expect(s.getCompany(c.id)?.notes).toContain("Email preferred");
  });
});

describe("event collision integrity", () => {
  test("same-event identical retry is a no-op; meaningful changed payload is a conflict", () => {
    const s = new CrmStore(open()),
      c = s.createCompany({ name: "Events" }, by),
      changes: CrmChange[] = [];
    s.subscribe((change) => changes.push(change));
    const input = {
      ref: { kind: "company" as const, id: c.id },
      eventId: "stable-event",
      kind: "note",
      title: "Original",
      note: "Saved once",
    };
    const a = s.addActivity(input, by);
    expect(s.addActivity({ ...input }, by).id).toBe(a.id);
    for (const patch of [
      { title: "Different" },
      { note: "Different" },
      { kind: "email" },
      { artifact: "artifact:job1" },
      { communicationState: "unknown" as const },
      { at: "2026-01-01T00:00:00Z" },
    ])
      expect(() => s.addActivity({ ...input, ...patch }, by)).toThrow("different activity details");
    expect(() => s.addActivity(input, other)).toThrow("different activity details");
    expect(s.snapshot().activities).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });
});

describe("effective restrictions", () => {
  test("shared optout updates existing matching company and all existing child contacts with version conflicts", () => {
    const s = new CrmStore(open()),
      a = s.createCompany({ name: "A", emails: ["same@example.test"], emailAllowed: true }, by),
      b = s.createCompany({ name: "B", emails: ["same@example.test"], emailAllowed: true }, by);
    const existing = s.createContact(
      { companyId: a.id, name: "Existing contact", email: "other@example.test" },
      by,
    );
    const chain = s.createCompany(
      { name: "Contact-matched", emails: ["other@example.test"], emailAllowed: true },
      by,
    );
    s.updateCompany(a.id, { doNotContact: true }, a.version, by);
    const snapshot = s.snapshot();
    expect(snapshot.companies.find((c) => c.id === b.id)).toMatchObject({
      doNotContact: true,
      emailAllowed: false,
    });
    expect(snapshot.contacts.find((c) => c.id === existing.id)?.doNotContact).toBe(true);
    expect(s.getCompany(chain.id)?.doNotContact).toBe(true);
    expect(() => s.updateCompany(b.id, { notes: "Stale" }, b.version, other)).toThrow("changed");
    const after = s.getCompany(b.id)!;
    expect(s.getCompany(b.id)?.version).toBe(after.version);
  });
  test("catalogue-only and combined service cannot activate receptionist delivery", () => {
    const s = new CrmStore(open()),
      c = s.createCompany({ name: "Hold variants" }, by);
    for (const values of [
      { service: "website", catalogueId: "receptionist-starter" },
      { service: "both", catalogueId: "website" },
    ]) {
      const deal = s.createDeal({ companyId: c.id, title: "Historic on hold", ...values }, by);
      expect(() =>
        s.createProject({ companyId: c.id, dealId: deal.id, name: "Must stay held" }, by),
      ).toThrow("on hold");
    }
  });
});

describe("legacy GST preservation", () => {
  test("inclusive CRM pricing round-trips old ex-GST changes without losing tax", () => {
    const db = open(true);
    legacy(db);
    const s = new CrmStore(db);
    let d = s.getDeal("legacy-deal-1")!;
    d = s.updateDeal(
      d.id,
      { gstTreatment: "inclusive", oneOffCents: 220000, recurringCents: 11000 },
      d.version,
      by,
    );
    expect(
      db.query("SELECT setup_cents,monthly_cents FROM lead_deals WHERE lead_id=1").get(),
    ).toEqual({ setup_cents: 200000, monthly_cents: 10000 });
    db.query("UPDATE lead_deals SET setup_cents=250000,monthly_cents=20000 WHERE lead_id=1").run();
    const updated = s.getDeal(d.id)!;
    expect(updated).toMatchObject({
      oneOffCents: 275000,
      recurringCents: 22000,
      gstTreatment: "inclusive",
    });
    expect(() =>
      s.updateDeal(d.id, { gstTreatment: "not-applicable" }, updated.version, by),
    ).toThrow("GST-taxable");
  });
});

describe("provider event identity", () => {
  test("one provider event cannot become two communications under different caller IDs", () => {
    const s = new CrmStore(open()),
      a = s.createCompany({ name: "Provider A" }, by),
      b = s.createCompany({ name: "Provider B" }, by);
    const input = {
      ref: { kind: "company" as const, id: a.id },
      eventId: "caller-1",
      kind: "email",
      title: "Verified email",
      communicationState: "sent" as const,
      providerEvidence: {
        provider: "mailbox",
        eventId: "message-1",
        observedAt: "2026-10-02T09:00:00Z",
        state: "sent" as const,
      },
    };
    const saved = s.addActivity(input, by);
    expect(s.addActivity({ ...input, eventId: "caller-2" }, by).id).toBe(saved.id);
    expect(() =>
      s.addActivity({ ...input, eventId: "caller-3", ref: { kind: "company", id: b.id } }, by),
    ).toThrow("different activity details");
    expect(() => s.addActivity({ ...input, eventId: "caller-4", note: "Changed" }, by)).toThrow(
      "different activity details",
    );
    expect(s.snapshot().activities).toHaveLength(1);
  });
});

describe("legacy outreach restrictions", () => {
  test("a later global optout cancels legacy outreach while preserving delivery promises", () => {
    const db = open(true);
    legacy(db, 1, { emails: '["same@example.test"]', next_at: "2026-10-06T00:00:00Z" });
    const s = new CrmStore(db);
    const delivery = s.createTask(
      { companyId: "legacy-company-1", title: "Deliver agreed files", kind: "delivery" },
      by,
    );
    expect(s.getTask("legacy-followup-1")?.status).toBe("open");
    db.query("INSERT INTO optouts(value) VALUES('same@example.test')").run();
    const snapshot = s.snapshot();
    expect(snapshot.tasks.find((t) => t.id === "legacy-followup-1")?.status).toBe("cancelled");
    expect(s.getTask(delivery.id)?.status).toBe("open");
  });
});
