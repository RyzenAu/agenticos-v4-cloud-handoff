import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CrmStore } from "./store";
import { createCrmOperations, proposalPricing } from "./ops";
import type { Principal } from "../identity/principal";
import type { Company, Contact, Deal, Document, Task } from "./types";
const usman: Principal = {
  personId: "usman",
  via: "paired-session",
  actor: "human",
  displayName: "Usman",
};
const mehroz: Principal = {
  personId: "mehroz",
  via: "paired-session",
  actor: "human",
  displayName: "Mehroz",
};
const opened: Database[] = [];
function fixture() {
  const db = new Database(":memory:");
  opened.push(db);
  const store = new CrmStore(db, { now: () => "2026-10-02T08:00:00.000Z" });
  const ops = createCrmOperations({ store, now: () => "2026-10-02T08:00:00.000Z" });
  return { db, store, ops };
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function ok<T>(value: { ok: boolean; data?: unknown; text: string }): T {
  expect(value.ok, value.text).toBe(true);
  return value.data as T;
}
describe("typed CRM operations", () => {
  test("both founders have equal access and attribution cannot be supplied in body", () => {
    const { store, ops } = fixture();
    const c = ok<Company>(
      ops.run("crm.company.create", { name: "Synthetic Practice", owner: "usman" }, mehroz),
    );
    expect(c.owner).toBe("usman");
    const changed = ok<Company>(
      ops.run(
        "crm.company.update",
        { id: c.id, expectedVersion: c.version, patch: { name: "Edited by either founder" } },
        usman,
      ),
    );
    expect(changed.name).toBe("Edited by either founder");
    expect(
      ops.run("crm.company.create", { name: "Spoof", by: { personId: "usman" } }, mehroz).ok,
    ).toBe(false);
    expect(ops.run("crm.company.create", { name: "Spoof" }, null as unknown as Principal).ok).toBe(
      false,
    );
    expect(
      ops.run(
        "crm.activity.add",
        {
          ref: { kind: "company", id: c.id },
          eventId: "spoof",
          kind: "note",
          title: "Spoof",
          by: { personId: "usman" },
        },
        mehroz,
      ).ok,
    ).toBe(false);
    expect(store.snapshot().activities.every((a) => !("sessionId" in a.by))).toBe(true);
  });
  test("multiple contacts and opportunities, stage history and honest optimistic conflicts", () => {
    const { ops, store } = fixture();
    const c = ok<Company>(ops.run("crm.company.create", { name: "Synthetic Account" }, usman));
    for (const name of ["Sarah Example", "Alex Example"])
      ok<Contact>(
        ops.run("crm.contact.add", { companyId: c.id, name, role: "Practice manager" }, usman),
      );
    const a = ok<Deal>(
      ops.run(
        "crm.deal.create",
        {
          companyId: c.id,
          title: "Website",
          commercialBasis: "agreed",
          oneOffCents: 200000,
          service: "website",
        },
        usman,
      ),
    );
    const b = ok<Deal>(
      ops.run("crm.deal.create", { companyId: c.id, title: "Redesign next year" }, mehroz),
    );
    const moved = ok<Deal>(
      ops.run(
        "crm.deal.move",
        { id: a.id, expectedVersion: a.version, stageId: "proposal" },
        mehroz,
      ),
    );
    expect(moved.stageHistory.at(-1)?.stageId).toBe("proposal");
    expect(
      ops.run(
        "crm.deal.update",
        { id: a.id, expectedVersion: a.version, patch: { title: "stale" } },
        usman,
      ),
    ).toMatchObject({ ok: false, code: "conflict" });
    ok<Deal>(
      ops.run(
        "crm.deal.move",
        { id: b.id, expectedVersion: b.version, stageId: "lost", reason: "Timing" },
        usman,
      ),
    );
    expect(store.getCompany(c.id)?.status).toBe("prospect");
    expect(store.snapshot().contacts.length).toBe(2);
    expect(store.snapshot().deals.length).toBe(2);
  });
  test("tasks complete, reopen and reassign without changing founder access", () => {
    const { ops } = fixture();
    const c = ok<Company>(ops.run("crm.company.create", { name: "Task account" }, usman));
    const t = ok<Task>(
      ops.run(
        "crm.task.create",
        {
          companyId: c.id,
          title: "Call next Tuesday",
          kind: "promise",
          dueAt: "2026-10-01T00:00:00.000Z",
          owner: "usman",
        },
        usman,
      ),
    );
    expect(ok<Task[]>(ops.run("crm.followups.overdue", { mine: true }, usman))).toHaveLength(1);
    const done = ok<Task>(
      ops.run("crm.task.complete", { id: t.id, expectedVersion: t.version }, mehroz),
    );
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const open = ok<Task>(
      ops.run("crm.task.reopen", { id: t.id, expectedVersion: done.version }, usman),
    );
    expect(open.completedAt).toBeNull();
    const assigned = ok<Task>(
      ops.run(
        "crm.task.assign",
        { id: t.id, expectedVersion: open.version, owner: "mehroz" },
        usman,
      ),
    );
    expect(assigned.owner).toBe("mehroz");
    expect(ok<Task[]>(ops.run("crm.followups.overdue", { mine: true }, mehroz))).toHaveLength(1);
    expect(
      ops.run("crm.task.create", { companyId: c.id, title: "Bad date", dueAt: "tomorrow" }, usman)
        .ok,
    ).toBe(false);
  });
  test("stable activity IDs, gated artifacts and verified agent attribution", () => {
    const { ops, store } = fixture();
    const c = ok<Company>(ops.run("crm.company.create", { name: "Research account" }, usman));
    const input = {
      ref: { kind: "company" as const, id: c.id },
      eventId: "job-1:result",
      kind: "agent-result",
      title: "Research complete",
      artifact: "artifact:job-1/report.md",
    };
    const first = ops.run("crm.activity.add", input, usman),
      second = ops.run("crm.activity.add", input, usman);
    expect(first.ok).toBe(true);
    expect(second.activityId).toBe(first.activityId);
    expect(store.snapshot().activities.filter((a) => a.eventId === input.eventId)).toHaveLength(1);
    expect(
      ops.run(
        "crm.activity.add",
        { ...input, eventId: "bad-art", artifact: "artifact:job/../secret" },
        usman,
      ).ok,
    ).toBe(false);
    expect(
      ops.run(
        "crm.activity.add",
        { ...input, eventId: "bad-agent", by: { agent: "Research", jobId: "job-1" } },
        usman,
      ).ok,
    ).toBe(false);
    const trusted = createCrmOperations({
      store,
      verifyAgent: (by, p) => by.jobId === "job-1" && p.personId === "usman",
    });
    expect(
      trusted.run(
        "crm.activity.add",
        { ...input, eventId: "trusted-agent", by: { agent: "Research", jobId: "job-1" } },
        usman,
      ).ok,
    ).toBe(true);
  });
  test("unverified communication never becomes sent or received", () => {
    const { ops, store } = fixture();
    const c = ok<Company>(ops.run("crm.company.create", { name: "Comms account" }, usman));
    const input = {
      ref: { kind: "company" as const, id: c.id },
      eventId: "email-1",
      kind: "email",
      title: "Email note",
    };
    expect(ops.run("crm.activity.add", { ...input, communicationState: "sent" }, usman).ok).toBe(
      false,
    );
    expect(ops.run("crm.activity.add", { ...input, communicationState: "unknown" }, usman).ok).toBe(
      true,
    );
    const trusted = createCrmOperations({ store, verifyCommunicationEvidence: () => true });
    expect(
      trusted.run(
        "crm.activity.add",
        {
          ...input,
          eventId: "email-2",
          communicationState: "sent",
          providerEvidence: {
            provider: "synthetic",
            eventId: "provider-2",
            observedAt: "2026-10-02T08:00:00.000Z",
            state: "sent",
          },
        },
        usman,
      ).ok,
    ).toBe(true);
    expect(ops.get("crm.email.send")).toBeUndefined();
  });
  test("proposal uses agreed AUD/GST values and retains immutable versions", () => {
    const { ops, store } = fixture();
    const c = ok<Company>(ops.run("crm.company.create", { name: "Proposal account" }, usman));
    const d = ok<Deal>(
      ops.run(
        "crm.deal.create",
        {
          companyId: c.id,
          title: "Agreed website",
          service: "website",
          scope: "Three agreed pages",
          oneOffCents: 220000,
          recurringCents: 11000,
          gstTreatment: "inclusive",
          commercialBasis: "agreed",
        },
        usman,
      ),
    );
    const doc = ok<Document>(
      ops.run("crm.proposal.draft", { dealId: d.id, expectedVersion: d.version }, usman),
    );
    expect(doc.status).toBe("draft");
    expect(doc.versions[0].pricing?.oneOffCents).toBe(220000);
    expect(doc.versions[0].content).toContain("$2,000.00 ex GST + $200.00 GST = $2,200.00 total");
    const revised = ok<Deal>(
      ops.run(
        "crm.deal.update",
        { id: d.id, expectedVersion: d.version, patch: { scope: "Four agreed pages" } },
        mehroz,
      ),
    );
    const next = ok<Document>(
      ops.run(
        "crm.proposal.draft",
        {
          dealId: d.id,
          expectedVersion: revised.version,
          documentId: doc.id,
          expectedDocumentVersion: doc.version,
        },
        mehroz,
      ),
    );
    expect(next.versions).toHaveLength(2);
    expect(next.versions[0].content).toContain("Three agreed pages");
    expect(next.versions[1].content).toContain("Four agreed pages");
    expect(store.snapshot().documents.filter((x) => x.kind === "invoice-reference")).toHaveLength(
      0,
    );
    expect(() => proposalPricing({ ...d, commercialBasis: "legacy-unconfirmed" })).toThrow();
    expect(() => proposalPricing({ ...d, service: "receptionist" })).toThrow();
    expect(() =>
      proposalPricing({
        ...d,
        commercialBasis: "catalogue",
        catalogueId: "website",
        oneOffCents: 1,
      }),
    ).toThrow();
  });
  test("queries preserve phone order, exact IDs and shared saved restrictions", () => {
    const { ops } = fixture();
    const c = ok<Company>(
      ops.run(
        "crm.company.create",
        { name: "Café Example", phone: "+61 412 345 678", doNotContact: true },
        usman,
      ),
    );
    expect(
      ok<{ total: number }>(ops.run("crm.companies.query", { search: "0412345678" }, usman)).total,
    ).toBe(1);
    expect(
      ok<{ total: number }>(ops.run("crm.companies.query", { search: "Cafe Example" }, usman))
        .total,
    ).toBe(1);
    expect(
      ok<{ total: number }>(ops.run("crm.companies.query", { search: `#${c.id}` }, usman)).total,
    ).toBe(1);
    expect(
      ok<{ total: number }>(ops.run("crm.companies.query", { search: "8765432140" }, usman)).total,
    ).toBe(0);
    expect(
      ok<{ total: number }>(ops.run("crm.companies.query", { restriction: "contactable" }, usman))
        .total,
    ).toBe(0);
    const view = ok<{ id: string; version: number }>(
      ops.run(
        "crm.views.save",
        { name: "Restricted", kind: "companies", filters: { restriction: "restricted" } },
        mehroz,
      ),
    );
    expect(ok<unknown[]>(ops.run("crm.views.list", {}, usman))).toHaveLength(1);
    expect(
      ops.run(
        "crm.views.save",
        {
          id: view.id,
          name: "Stale",
          kind: "companies",
          filters: {},
          expectedVersion: view.version + 1,
        },
        usman,
      ).code,
    ).toBe("conflict");
    for (const dueAt of ["2026-02-30", "2026-02-30T10:00:00Z", "2026-10-02T10:00:00+99:00"])
      expect(
        ops.run("crm.task.create", { companyId: c.id, title: "Invalid date", dueAt }, usman).code,
      ).toBe("validation");
  });
  test("pipeline configuration creates explicitly and retains history on stage edits", () => {
    const { ops, store } = fixture();
    const stages = [
      { id: "open", name: "Open", category: "open", probability: 0.5, archived: false },
      { id: "won", name: "Won", category: "won", probability: 1, archived: false },
      { id: "lost", name: "Lost", category: "lost", probability: 0, archived: false },
    ];
    const p = ok<{ id: string; version: number }>(
      ops.run("crm.pipeline.create", { name: "Alternate sales", stages }, usman),
    );
    expect(p.id).not.toBe("sales");
    const company = ok<Company>(ops.run("crm.company.create", { name: "Pipeline client" }, usman));
    const d = ok<Deal>(
      ops.run(
        "crm.deal.create",
        {
          companyId: company.id,
          title: "Alternative opportunity",
          pipelineId: p.id,
          stageId: "open",
        },
        usman,
      ),
    );
    ok(
      ops.run(
        "crm.pipeline.update",
        {
          id: p.id,
          expectedVersion: p.version,
          patch: {
            name: "Renamed sales",
            stages: stages.map((s) => (s.id === "open" ? { ...s, name: "Qualified" } : s)),
          },
        },
        mehroz,
      ),
    );
    expect(store.getDeal(d.id)?.stageHistory[0].stageName).toBe("Open");
  });
  test("unexpected storage failures never leak filesystem or database details", () => {
    const { ops, store } = fixture();
    store.snapshot = () => {
      throw new Error(
        "SQLite failure at /private/synthetic/operator-data/crm.sqlite: SELECT secret",
      );
    };
    const result = ops.run("crm.snapshot", {}, usman);
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(result.text).not.toContain("/private");
    expect(result.text).not.toContain("SELECT");
  });
  test("active record ambiguity asks rather than choosing a business", () => {
    const { ops } = fixture();
    const a = ok<Company>(ops.run("crm.company.create", { name: "A" }, usman)),
      b = ok<Company>(ops.run("crm.company.create", { name: "B" }, usman));
    expect(
      ops.run(
        "crm.record.get",
        {
          context: {
            candidates: [
              { kind: "company", id: a.id },
              { kind: "company", id: b.id },
            ],
          },
        },
        usman,
      ),
    ).toMatchObject({ ok: false, code: "ambiguous" });
    expect(
      ok<Company>(
        ops.run("crm.record.get", { context: { crm: { kind: "company", id: b.id } } }, usman),
      ).id,
    ).toBe(b.id);
  });
});
