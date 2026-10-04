import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrmStore } from "./store";
import { JobService } from "../jobs/service";
import { CrmAutomations } from "./automation";
import { createCrmOperations, type CrmReceipt } from "./ops";
import type { Company, Contact, Deal, Document, Project, Task } from "./types";
import type { Principal } from "../identity/principal";
const founder: Principal = {
  personId: "mehroz",
  via: "paired-session",
  actor: "human",
  displayName: "Mehroz",
};
const at = "2026-10-02T09:00:00.000Z";
const result = <T>(r: CrmReceipt) => {
  expect(r.ok, r.text).toBe(true);
  expect(r.href).toStartWith("/crm");
  return r.data as T;
};
test("synthetic enquiry to sales, versioned proposal, onboarding, delivery, follow-up and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-operation-journey-"));
  let db = new Database(join(dir, "crm.sqlite"));
  let jobs = new JobService({ path: join(dir, "jobs.sqlite") });
  try {
    let store = new CrmStore(db, { now: () => at });
    let automations = new CrmAutomations({ store, jobs, now: () => at });
    let ops = createCrmOperations({ store, automations, now: () => at });
    const enquiry = {
      eventId: "synthetic:enquiry:1",
      trigger: "enquiry.received" as const,
      at,
      payload: {
        companyName: "Example Dental (synthetic)",
        contactName: "Sarah Example",
        email: "sarah@example.test",
        provider: "synthetic-form",
        providerEventId: "form-journey-1",
        owner: "mehroz" as const,
      },
    };
    expect(automations.accept(enquiry, founder).ok).toBe(true);
    const company = store.snapshot().companies[0];
    expect(company.name).toBe("Example Dental (synthetic)");
    const extra = result<Contact>(
      ops.run(
        "crm.contact.add",
        { companyId: company.id, name: "Alex Example", role: "Owner" },
        founder,
      ),
    );
    let deal = result<Deal>(
      ops.run(
        "crm.deal.create",
        {
          companyId: company.id,
          title: "Website delivery",
          service: "website",
          scope: "Five approved pages",
          contactIds: [extra.id],
          owner: "usman",
          oneOffCents: 165000,
          recurringCents: 11000,
          gstTreatment: "inclusive",
          commercialBasis: "agreed",
        },
        founder,
      ),
    );
    result<Deal>(
      ops.run(
        "crm.deal.create",
        { companyId: company.id, title: "Future redesign", service: "redesign" },
        founder,
      ),
    );
    for (const stageId of ["qualified", "contacted", "meeting"])
      deal = result<Deal>(
        ops.run("crm.deal.move", { id: deal.id, stageId, expectedVersion: deal.version }, founder),
      );
    expect(
      automations.accept(
        {
          eventId: "synthetic:meeting:1",
          trigger: "meeting.completed",
          at,
          ref: { kind: "deal", id: deal.id },
          payload: {
            nextAction: "Confirm the agreed five-page sitemap",
            dueAt: "2026-10-05T00:00:00.000Z",
          },
        },
        founder,
      ).ok,
    ).toBe(true);
    deal = result<Deal>(
      ops.run(
        "crm.deal.move",
        { id: deal.id, stageId: "proposal", expectedVersion: deal.version },
        founder,
      ),
    );
    const document = result<Document>(
      ops.run("crm.proposal.draft", { dealId: deal.id, expectedVersion: deal.version }, founder),
    );
    expect(document.versions[0].pricing?.oneOffCents).toBe(165000);
    deal = result<Deal>(
      ops.run(
        "crm.deal.move",
        { id: deal.id, stageId: "won", expectedVersion: deal.version },
        founder,
      ),
    );
    expect(store.snapshot().projects).toHaveLength(1);
    let project = store.snapshot().projects[0];
    project = result<Project>(
      ops.run(
        "crm.project.update",
        {
          id: project.id,
          expectedVersion: project.version,
          patch: {
            status: "launched",
            scope: deal.scope,
            previewUrls: ["https://example.test/preview"],
            deliverables: ["Approved website"],
            launchAt: at,
            renewalAt: "2027-10-02T00:00:00.000Z",
          },
        },
        founder,
      ),
    );
    let promise = result<Task>(
      ops.run(
        "crm.task.create",
        {
          companyId: company.id,
          dealId: deal.id,
          projectId: project.id,
          title: "Check the launch with Sarah",
          kind: "promise",
          owner: "mehroz",
          dueAt: "2026-10-05T00:00:00.000Z",
        },
        founder,
      ),
    );
    promise = result<Task>(
      ops.run("crm.task.complete", { id: promise.id, expectedVersion: promise.version }, founder),
    );
    promise = result<Task>(
      ops.run("crm.task.reopen", { id: promise.id, expectedVersion: promise.version }, founder),
    );
    expect(promise.status).toBe("open");
    const counts = {
      companies: store.snapshot().companies.length,
      contacts: store.snapshot().contacts.length,
      deals: store.snapshot().deals.length,
      tasks: store.snapshot().tasks.length,
    };
    jobs.close();
    db.close();
    db = new Database(join(dir, "crm.sqlite"));
    jobs = new JobService({ path: join(dir, "jobs.sqlite") });
    store = new CrmStore(db, { now: () => at });
    automations = new CrmAutomations({ store, jobs, now: () => at });
    ops = createCrmOperations({ store, automations, now: () => at });
    expect(automations.accept(enquiry, founder).duplicate).toBe(true);
    expect({
      companies: store.snapshot().companies.length,
      contacts: store.snapshot().contacts.length,
      deals: store.snapshot().deals.length,
      tasks: store.snapshot().tasks.length,
    }).toEqual(counts);
    expect(store.getDeal(deal.id)?.stageHistory.map((s) => s.stageId)).toEqual([
      "new",
      "qualified",
      "contacted",
      "meeting",
      "proposal",
      "won",
    ]);
    expect(store.getProject(project.id)?.status).toBe("launched");
    expect(store.getDocument(document.id)?.status).toBe("draft");
    expect(store.snapshot().documents.filter((d) => d.kind === "invoice-reference")).toHaveLength(
      0,
    );
  } finally {
    jobs.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
