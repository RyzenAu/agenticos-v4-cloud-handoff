import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CrmStore } from "./store";
import { CrmWorkflows } from "./workflows";
import {
  defaultWorkflowDefinitions,
  workflowApplySchema,
  workflowTemplateDefinitionSchema,
  WORKFLOW_HISTORY_LIMIT,
  WORKFLOW_RUN_LIMIT,
  type WorkflowApplyInput,
  type WorkflowFounder,
} from "./workflow-templates";
import { WEBSITE_OFFER, WEBSITE_EX_GST_CENTS } from "../leads/sales-backoffice";

const usman: WorkflowFounder = { personId: "usman" },
  mehroz: WorkflowFounder = { personId: "mehroz" };
const databases: Database[] = [],
  directories: string[] = [];
const now = () => "2026-10-02T09:00:00.000Z";
function fixture(file = ":memory:") {
  const db = new Database(file);
  databases.push(db);
  const store = new CrmStore(db, { now }),
    workflows = new CrmWorkflows(store, { now });
  return { db, store, workflows };
}
function records(store: CrmStore) {
  const company = store.createCompany({ name: "Synthetic website client", owner: "mehroz" }, usman);
  const deal = store.createDeal(
    {
      companyId: company.id,
      title: "Synthetic website",
      scope: "Four pages confirmed in the fixture",
      service: "Website",
      catalogueId: "website",
      commercialBasis: "catalogue",
      oneOffCents: WEBSITE_EX_GST_CENTS,
      recurringCents: 0,
      gstTreatment: "exclusive",
    },
    usman,
  );
  const project = store.createProject(
    { companyId: company.id, dealId: deal.id, name: "Synthetic delivery", owner: "mehroz" },
    usman,
  );
  return { company, deal, project };
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("editable workflow templates", () => {
  test("full-length task text retains provenance without exceeding the materialised field limit", () => {
    const { store, workflows } = fixture();
    const { company, deal } = records(store);
    const original = workflows.listTemplates().find((entry) => entry.id === "follow-up")!;
    let template = workflows.updateTemplate(
      {
        id: original.id,
        expectedVersion: original.version,
        patch: { tasks: [{ ...original.tasks[0]!, description: "x".repeat(10000) }] },
      },
      usman,
    );
    const first = workflows.applyTemplate(
      {
        templateId: template.id,
        expectedVersion: template.version,
        ref: { kind: "company", id: company.id },
        requestId: "full-length",
      },
      usman,
    );
    expect(store.getTask(first.taskIds[0]!)?.description).toBe("x".repeat(10000));
    expect(store.snapshot().activities.find((a) => a.id === first.activityId)?.note).toContain(
      first.taskIds[0]!,
    );
    const longDeal = store.updateDeal(deal.id, { scope: "s".repeat(10000) }, deal.version, usman);
    template = workflows.updateTemplate(
      {
        id: template.id,
        expectedVersion: template.version,
        patch: { tasks: [{ ...template.tasks[0]!, description: "{{deal.scope}}" }] },
      },
      usman,
    );
    const expanded = workflows.applyTemplate(
      {
        templateId: template.id,
        expectedVersion: template.version,
        ref: { kind: "deal", id: longDeal.id },
        requestId: "full-placeholder",
      },
      usman,
    );
    expect(store.getTask(expanded.taskIds[0]!)?.description).toBe(longDeal.scope);
    template = workflows.updateTemplate(
      {
        id: template.id,
        expectedVersion: template.version,
        patch: { tasks: [{ ...template.tasks[0]!, description: "Extra {{deal.scope}}" }] },
      },
      usman,
    );
    const before = store.snapshot();
    expect(() =>
      workflows.applyTemplate(
        {
          templateId: template.id,
          expectedVersion: template.version,
          ref: { kind: "deal", id: longDeal.id },
          requestId: "oversized-placeholder",
        },
        usman,
      ),
    ).toThrow("expands this template");
    expect(store.snapshot()).toEqual(before);
  });
  test("nine validated defaults make independent copies and bundle for the browser", async () => {
    const defaults = defaultWorkflowDefinitions();
    expect(defaults).toHaveLength(9);
    expect(new Set(defaults.map((entry) => entry.id)).size).toBe(9);
    for (const entry of defaults)
      expect(workflowTemplateDefinitionSchema.safeParse(entry).success).toBe(true);
    defaults[0]!.tasks[0]!.title = "Local edit";
    expect(defaultWorkflowDefinitions()[0]!.tasks[0]!.title).not.toBe("Local edit");
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "workflow-templates.ts")],
      target: "browser",
    });
    expect(result.success).toBe(true);
    expect(result.logs).toHaveLength(0);
    expect(await result.outputs[0]!.text()).not.toContain("bun:sqlite");
  });
  test("custom copies survive service recreation, retain catalogue provenance and immutable founder history", () => {
    const { store, workflows } = fixture();
    const initial = workflows.listTemplates().find((entry) => entry.id === "discovery")!;
    const second = workflows.updateTemplate(
      { id: initial.id, expectedVersion: 1, patch: { title: "Our discovery checklist" } },
      usman,
    );
    expect(second.version).toBe(2);
    expect(second.provenance.catalogueId).toBe(initial.provenance.catalogueId);
    expect(second.history[0]?.title).toBe(initial.title);
    expect(second.history[0]?.by).toEqual({ catalogue: true });
    const third = new CrmWorkflows(store, { now }).updateTemplate(
      { id: initial.id, expectedVersion: 2, patch: { summary: "Our working copy" } },
      mehroz,
    );
    expect(third.version).toBe(3);
    expect(third.history[1]?.title).toBe("Our discovery checklist");
    expect(third.history[1]?.by).toEqual(usman);
    expect(third.provenance.updatedBy).toEqual(mehroz);
    third.history[0]!.title = "Mutated returned object";
    const reloaded = workflows.listTemplates().find((entry) => entry.id === initial.id)!;
    expect(reloaded.title).toBe("Our discovery checklist");
    expect(reloaded.history[0]?.title).toBe(initial.title);
    expect(() =>
      workflows.updateTemplate(
        { id: initial.id, expectedVersion: 2, patch: { title: "Stale" } },
        usman,
      ),
    ).toThrow("changed");
  });
  test("two independent database connections compare versions against the committed copy", () => {
    const directory = mkdtempSync(join(tmpdir(), "crm-workflow-concurrency-"));
    directories.push(directory);
    const file = join(directory, "crm.sqlite"),
      a = fixture(file),
      b = fixture(file);
    a.workflows.listTemplates();
    b.workflows.updateTemplate(
      { id: "follow-up", expectedVersion: 1, patch: { title: "Mehroz's follow-up" } },
      mehroz,
    );
    expect(() =>
      a.workflows.updateTemplate(
        { id: "follow-up", expectedVersion: 1, patch: { title: "Stale copy" } },
        usman,
      ),
    ).toThrow("changed");
    expect(a.workflows.listTemplates().find((entry) => entry.id === "follow-up")?.title).toBe(
      "Mehroz's follow-up",
    );
  });
  test("each template creates real linked open tasks and only draft documents with founder attribution", () => {
    const { db, store, workflows } = fixture();
    const { company, deal, project } = records(store);
    const templates = workflows.listTemplates();
    for (const template of templates) {
      const kind = template.appliesTo[0]!;
      const ref = {
        kind,
        id: kind === "company" ? company.id : kind === "deal" ? deal.id : project.id,
      };
      const receipt = workflows.applyTemplate(
        {
          templateId: template.id,
          expectedVersion: template.version,
          expectedDealVersion: deal.version,
          ref,
          requestId: `run-${template.id}`,
        },
        usman,
      );
      expect(receipt.duplicate).toBe(false);
      expect(receipt.taskIds).toHaveLength(template.tasks.length);
      expect(receipt.documentIds).toHaveLength(template.document ? 1 : 0);
      for (const id of receipt.taskIds) {
        const task = store.getTask(id)!;
        expect(task.status).toBe("open");
        expect(task.owner).toBe("mehroz");
        expect(task.companyId).toBe(company.id);
        expect(task.dealId).toBe(kind === "company" ? null : deal.id);
        expect(task.projectId).toBe(kind === "project" ? project.id : null);
        expect(task.dueAt).toBeNull();
        expect(task.description.length).toBeGreaterThan(0);
      }
      for (const id of receipt.documentIds) {
        const document = store.getDocument(id)!;
        expect(document.status).toBe("draft");
        expect(document.companyId).toBe(company.id);
        expect(document.versions[0]?.by).toEqual(usman);
        expect(document.versions[0]?.content).toContain("Setup and pilot terms remain unapproved");
        expect(document.versions[0]?.content).not.toContain("{{");
      }
      const activity = store
        .snapshot()
        .activities.find((entry) => entry.id === receipt.activityId)!;
      expect(activity.by).toEqual(usman);
      expect(activity.ref).toEqual(ref);
      expect(activity.communicationState).toBeNull();
      expect(activity.note).toContain(`template ${template.id} version 1`);
      for (const id of receipt.taskIds) expect(activity.note).toContain(id);
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.getProject(project.id)?.status).toBe("onboarding");
    expect(store.getDeal(deal.id)?.stageId).toBe("new");
  });
  test("retries persist across reopen and template edits; different input or founder cannot reuse a request ID", () => {
    const directory = mkdtempSync(join(tmpdir(), "crm-workflow-replay-"));
    directories.push(directory);
    const file = join(directory, "crm.sqlite"),
      first = fixture(file);
    const { company } = records(first.store);
    const input: WorkflowApplyInput = {
      templateId: "follow-up",
      expectedVersion: 1,
      ref: { kind: "company", id: company.id },
      requestId: "repeat-me",
      owner: "usman",
      dueAt: "2026-10-05",
    };
    const receipt = first.workflows.applyTemplate(input, usman);
    first.workflows.updateTemplate(
      { id: "follow-up", expectedVersion: 1, patch: { title: "Revised" } },
      mehroz,
    );
    const next = fixture(file);
    const retry = next.workflows.applyTemplate(input, usman);
    expect(retry).toEqual({ ...receipt, duplicate: true });
    expect(next.store.snapshot().tasks).toHaveLength(1);
    expect(next.store.getTask(receipt.taskIds[0]!)?.dueAt).toBe("2026-10-05T00:00:00.000Z");
    expect(() => next.workflows.applyTemplate({ ...input, owner: "mehroz" }, usman)).toThrow(
      "different details",
    );
    expect(() => next.workflows.applyTemplate(input, mehroz)).toThrow("different details");
    expect(() =>
      next.workflows.applyTemplate({ ...input, requestId: "stale-new-run" }, usman),
    ).toThrow("changed");
  });
  test("a failure after creating tasks rolls back the complete run and emits no phantom record changes", () => {
    const { store, workflows } = fixture();
    const { project } = records(store);
    workflows.listTemplates();
    const changes: unknown[] = [];
    store.subscribe((event) => changes.push(event));
    const createDocument = store.createDocument.bind(store);
    store.createDocument = () => {
      throw new Error("Synthetic document failure");
    };
    const input: WorkflowApplyInput = {
      templateId: "onboarding",
      expectedVersion: 1,
      ref: { kind: "project", id: project.id },
      requestId: "atomic-run",
    };
    try {
      expect(() => workflows.applyTemplate(input, usman)).toThrow("Synthetic document failure");
    } finally {
      store.createDocument = createDocument;
    }
    expect(store.snapshot().tasks).toHaveLength(0);
    expect(store.snapshot().documents).toHaveLength(0);
    expect(store.getSetting("crm.workflow.run.atomic-run", null)).toBeNull();
    expect(changes).toHaveLength(0);
    expect(workflows.applyTemplate(input, usman).taskIds).toHaveLength(2);
  });
  test("website proposal pricing comes from the catalogue and agrees with immutable document pricing", () => {
    const { store, workflows } = fixture();
    const { deal } = records(store);
    const receipt = workflows.applyTemplate(
      {
        templateId: "proposal",
        expectedVersion: 1,
        expectedDealVersion: deal.version,
        ref: { kind: "deal", id: deal.id },
        requestId: "website-price",
      },
      usman,
    );
    const version = store.getDocument(receipt.documentIds[0]!)!.versions[0]!;
    expect(version.pricing?.oneOffCents).toBe(WEBSITE_EX_GST_CENTS);
    expect(version.pricing?.dealVersion).toBe(deal.version);
    expect(version.content).toContain("$1,500.00 ex GST + $150.00 GST = $1,650.00 total");
    expect(version.content).toContain(deal.scope);
    const changed = store.updateDeal(
      deal.id,
      {
        commercialBasis: "agreed",
        oneOffCents: 222_000,
        recurringCents: 3_000,
        gstTreatment: "inclusive",
      },
      deal.version,
      mehroz,
    );
    const agreed = workflows.applyTemplate(
      {
        templateId: "proposal",
        expectedVersion: 1,
        expectedDealVersion: changed.version,
        ref: { kind: "deal", id: deal.id },
        requestId: "agreed-price",
      },
      mehroz,
    );
    expect(store.getDocument(agreed.documentIds[0]!)!.versions[0]!.pricing).toMatchObject({
      oneOffCents: 222_000,
      recurringCents: 3_000,
      gstTreatment: "inclusive",
      dealVersion: changed.version,
    });
    expect(store.getDocument(receipt.documentIds[0]!)!.versions[0]!.pricing?.oneOffCents).toBe(
      WEBSITE_EX_GST_CENTS,
    );
    expect(WEBSITE_OFFER.priceCents).toBe(165_000);
  });
  test("unconfirmed prices, changed catalogue amounts and company proposal guesses do not create work", () => {
    const { store, workflows } = fixture();
    const { company, deal } = records(store);
    let current = store.updateDeal(
      deal.id,
      { commercialBasis: "legacy-unconfirmed" },
      deal.version,
      usman,
    );
    const input: WorkflowApplyInput = {
      templateId: "proposal",
      expectedVersion: 1,
      expectedDealVersion: current.version,
      ref: { kind: "deal", id: deal.id },
      requestId: "blocked-price",
    };
    expect(() => workflows.applyTemplate(input, usman)).toThrow("agreed price");
    current = store.updateDeal(
      deal.id,
      { commercialBasis: "catalogue", oneOffCents: 1 },
      current.version,
      usman,
    );
    expect(() => workflows.applyTemplate(input, usman)).toThrow("deal changed");
    expect(() =>
      workflows.applyTemplate({ ...input, expectedDealVersion: undefined }, usman),
    ).toThrow("provide its current version");
    expect(() =>
      workflows.applyTemplate({ ...input, expectedDealVersion: current.version }, usman),
    ).toThrow("differ");
    workflows.updateTemplate(
      { id: "proposal", expectedVersion: 1, patch: { appliesTo: ["company", "deal"] } },
      usman,
    );
    expect(() =>
      workflows.applyTemplate(
        { ...input, expectedVersion: 2, ref: { kind: "company", id: company.id } },
        usman,
      ),
    ).toThrow("explicit deal");
    expect(store.snapshot().tasks).toHaveLength(0);
    expect(store.snapshot().documents).toHaveLength(0);
    expect(store.getDeal(deal.id)?.oneOffCents).toBe(1);
  });
  test("receptionist and combined offers remain on hold even when a custom template changes its name", () => {
    const { store, workflows } = fixture();
    const { company } = records(store);
    workflows.updateTemplate(
      { id: "onboarding", expectedVersion: 1, patch: { title: "Start the work" } },
      usman,
    );
    for (const [index, service] of ["AI receptionist", "Both"].entries()) {
      const deal = store.createDeal(
        { companyId: company.id, title: service, service, commercialBasis: "agreed" },
        usman,
      );
      expect(() =>
        workflows.applyTemplate(
          {
            templateId: "onboarding",
            expectedVersion: 2,
            ref: { kind: "deal", id: deal.id },
            requestId: `hold-${index}`,
          },
          usman,
        ),
      ).toThrow("on hold");
    }
    expect(store.snapshot().tasks).toHaveLength(0);
    expect(store.snapshot().documents).toHaveLength(0);
  });
  test("strict bounded requests reject unsupported effects, invalid dates, authors and placeholder expressions", () => {
    const { workflows } = fixture();
    expect(
      workflowApplySchema.safeParse({
        templateId: "follow-up",
        expectedVersion: 1,
        ref: { kind: "company", id: "c" },
        requestId: "safe",
        dueAt: "2026-02-30",
      }).success,
    ).toBe(false);
    expect(() =>
      workflows.updateTemplate(
        { id: "follow-up", expectedVersion: 1, patch: { send: true } } as never,
        usman,
      ),
    ).toThrow();
    expect(() =>
      workflows.updateTemplate(
        { id: "follow-up", expectedVersion: 1, patch: { summary: "Changed" } },
        { personId: "other" } as never,
      ),
    ).toThrow();
    const entry = defaultWorkflowDefinitions()[0]!;
    entry.tasks[0]!.description = "{{process.env.API_KEY}}";
    expect(workflowTemplateDefinitionSchema.safeParse(entry).success).toBe(false);
    expect(() =>
      workflows.updateTemplate(
        { id: "proposal", expectedVersion: 1, patch: { document: null } },
        usman,
      ),
    ).toThrow("proposal draft");
  });
  test("history and run caps fail closed without dropping earlier versions or retry protection", () => {
    const { store, workflows } = fixture();
    const { company } = records(store);
    for (let version = 1; version <= WORKFLOW_HISTORY_LIMIT; version++)
      workflows.updateTemplate(
        { id: "follow-up", expectedVersion: version, patch: { title: `Version ${version + 1}` } },
        usman,
      );
    expect(() =>
      workflows.updateTemplate(
        {
          id: "follow-up",
          expectedVersion: WORKFLOW_HISTORY_LIMIT + 1,
          patch: { title: "Too many" },
        },
        mehroz,
      ),
    ).toThrow("history is full");
    expect(
      workflows.listTemplates().find((entry) => entry.id === "follow-up")?.history,
    ).toHaveLength(WORKFLOW_HISTORY_LIMIT);
    store.setSetting(
      "crm.workflow.run-index",
      Array.from({ length: WORKFLOW_RUN_LIMIT }, (_, index) => `saved-${index}`),
    );
    expect(() =>
      workflows.applyTemplate(
        {
          templateId: "follow-up",
          expectedVersion: WORKFLOW_HISTORY_LIMIT + 1,
          ref: { kind: "company", id: company.id },
          requestId: "one-more",
        },
        usman,
      ),
    ).toThrow("history is full");
    expect(store.snapshot().tasks).toHaveLength(0);
  });
  test("invalid saved template is reported and never overwritten with defaults", () => {
    const { store, workflows } = fixture();
    store.setSetting("crm.workflow.template.follow-up", { title: "Existing custom data" });
    expect(() => workflows.listTemplates()).toThrow();
    expect(store.getSetting<unknown>("crm.workflow.template.follow-up", null)).toEqual({
      title: "Existing custom data",
    });
  });
});
