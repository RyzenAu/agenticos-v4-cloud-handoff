// Runs in an isolated process. These are non-browser DOM checks; the modal portal is replaced
// with a plain wrapper, so this does not claim a rendered layout or browser focus-trap pass.
import { makeHarness, type Harness } from "../../../scripts/r6-behaviour/dom";
// @ts-ignore: bun supplies test types at runtime.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Tabs } from "@/components/ds";
const controls = await import("./controls");
mock.module("./controls", () => ({
  ...controls,
  Modal: ({
    title,
    description,
    children,
  }: {
    title: string;
    description: string;
    children: ReactNode;
  }) => (
    <section aria-label={title}>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </section>
  ),
}));
const { RecordEditor, DocumentVersionEditor } = await import("./record-editor");
const { TemplateEditor, ApplyWorkflow, WorkflowTemplates } = await import("./workflow-templates");
const { DocumentVersions } = await import("./company-workspace");
const { WorkflowJourney, nextBusinessActions, companyJourney } = await import("./workflow-journey");
import {
  defaultWorkflowDefinitions,
  type WorkflowTemplate,
} from "../../../scripts/crm/workflow-templates";
import type { Document, Project } from "../../../scripts/crm/types";
const { DirectoryView, CsvImport } = await import("./directory");
const { PipelineView, TaskRows } = await import("./workspace-views");
import { resetCrmToken } from "@/lib/crm-client";
import { company, deal, snapshot, task } from "./test-fixtures";
import type { WorkspaceActions } from "./workspace-views";
let h: Harness;
const clients: QueryClient[] = [];
afterEach(async () => {
  await h?.unmount().catch(() => {});
  h?.cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  resetCrmToken();
});
const actionCalls: { name: string; input: unknown }[] = [];
const actions: WorkspaceActions = {
  busy: false,
  edit: () => {},
  open: () => {},
  run: async (name, input) => {
    actionCalls.push({ name, input });
  },
};
function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}
function input(label: string) {
  const node = h.qa("label").find((el) => el.textContent?.startsWith(label));
  return node?.querySelector("input,textarea,select")!;
}
const posts = () => h.fetchCalls.filter((c) => c.url === "/__crm/ops");
describe("CRM forms under interruption", () => {
  test("two submit events in one turn dispatch one company write", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { ok: true, text: "Company saved" } }));
    await h.render(
      <RecordEditor
        target={{ kind: "company" }}
        snapshot={snapshot()}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await h.type(input("Business name"), "Synthetic double-submit company");
    await act(async () => {
      h.q("form")!.dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
      h.q("form")!.dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(posts()).toHaveLength(1);
  });
  test("keeps the draft and original revision after a conflict; patches only edited fields", async () => {
    h = makeHarness();
    h.onFetch(() => ({
      status: 409,
      json: { ok: false, code: "conflict", text: "This record changed." },
    }));
    const target = {
      kind: "company" as const,
      record: company("a", { fieldSources: { phone: "legacy" } }),
    };
    await h.render(
      <RecordEditor target={target} snapshot={snapshot()} onClose={() => {}} onSaved={() => {}} />,
    );
    await h.type(input("Internal notes"), "Keep this draft after failure");
    await h.submit(h.q("form")!);
    expect(h.text()).toContain("Your draft has been kept");
    expect((input("Internal notes") as HTMLTextAreaElement).value).toBe(
      "Keep this draft after failure",
    );
    expect(posts()[0].body.input).toEqual({
      id: "a",
      expectedVersion: 1,
      patch: { notes: "Keep this draft after failure" },
    });
    await h.render(
      <RecordEditor
        target={{
          kind: "company",
          record: company("a", { version: 2, notes: "Other founder's note" }),
        }}
        snapshot={snapshot()}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await h.submit(h.q("form")!);
    expect(posts()[1].body.input.expectedVersion).toBe(1);
    expect((input("Internal notes") as HTMLTextAreaElement).value).toBe(
      "Keep this draft after failure",
    );
  });
  test("does not turn an existing opt-out off", async () => {
    h = makeHarness();
    await h.render(
      <RecordEditor
        target={{ kind: "company", record: company("a", { doNotContact: true }) }}
        snapshot={snapshot()}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const checkbox = input("Do not contact this company");
    expect(checkbox.hasAttribute("disabled")).toBe(true);
    expect(h.text()).toContain("Existing opt-out retained");
  });
  test("new deal keeps catalogue defaults on server when price inputs are untouched", async () => {
    h = makeHarness();
    let saved = false;
    h.onFetch(() => ({ json: { ok: true, text: "Deal saved" } }));
    await h.render(
      <RecordEditor
        target={{ kind: "deal", companyId: "a" }}
        snapshot={snapshot()}
        onClose={() => {}}
        onSaved={() => {
          saved = true;
        }}
      />,
    );
    await h.type(input("Title"), "Website refresh");
    await h.submit(h.q("form")!);
    expect(saved).toBe(true);
    const payload = posts()[0].body;
    expect(payload.name).toBe("crm.deal.create");
    expect(payload.input.service).toBe("website");
    expect(payload.input.commercialBasis).toBe("catalogue");
    expect(payload.input.oneOffCents).toBeUndefined();
    expect(payload.input.recurringCents).toBeUndefined();
  });
  test("editing AUD cents marks an explicit agreed deal value", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { ok: true, text: "Saved" } }));
    await h.render(
      <RecordEditor
        target={{ kind: "deal", record: deal("new", 120000) }}
        snapshot={snapshot()}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await h.type(input("One-off value"), "1234.56");
    expect(input("One-off value").getAttribute("step")).toBe("0.01");
    await h.submit(h.q("form")!);
    expect(posts()[0].body.input.patch.oneOffCents).toBe(123456);
    expect(posts()[0].body.input.patch.title).toBeUndefined();
  });
});
describe("CRM list and keyboard behaviour", () => {
  test("directory filters by search without changing records", async () => {
    h = makeHarness();
    h.onFetch(() => ({ json: { ok: true, text: "Views", data: [] } }));
    await h.render(
      wrap(
        <DirectoryView
          kind="companies"
          snapshot={snapshot()}
          actions={actions}
          onSaved={() => {}}
        />,
      ),
    );
    await h.type(h.q('input[placeholder="Name, phone, email or company ID"]')!, "muller");
    expect(h.text()).toContain("Müller Clinic");
    expect(Boolean(h.byText("button", "Company a"))).toBe(false);
    expect(posts().every((p) => p.body.name === "crm.views.list")).toBe(true);
  });
  test("task completion and reopening use the exact current version", async () => {
    h = makeHarness();
    actionCalls.length = 0;
    const t = task(null);
    await h.render(<TaskRows tasks={[t]} snapshot={snapshot()} actions={actions} />);
    await h.click(h.q('button[aria-label="Complete Call"]'));
    expect(actionCalls[0]).toEqual({
      name: "crm.task.complete",
      input: { id: "t", expectedVersion: 1 },
    });
    await h.render(
      <TaskRows
        tasks={[{ ...t, status: "done", version: 2 }]}
        snapshot={snapshot()}
        actions={actions}
      />,
    );
    await h.click(h.q('button[aria-label="Reopen Call"]'));
    expect(actionCalls[1]).toEqual({
      name: "crm.task.reopen",
      input: { id: "t", expectedVersion: 2 },
    });
  });
  test("pipeline layout switches to a labelled table using existing keyboard-capable controls", async () => {
    h = makeHarness();
    const s = snapshot();
    s.deals = [deal("proposal", 123456)];
    await h.render(<PipelineView snapshot={s} actions={actions} configure={() => {}} />);
    await h.click(h.byText("button", "Table"));
    expect(h.q("table")).not.toBeNull();
    expect(h.text()).toContain("A$1,234.56");
    expect(h.q('select[aria-label="Stage for proposal"]')).not.toBeNull();
    expect(h.text()).toContain("not payment confirmation");
  });
  test("tabs select the next tab with ArrowRight and preserve accessible state", async () => {
    h = makeHarness();
    function Probe() {
      const [value, setValue] = useState("overview");
      return (
        <Tabs
          idBase="test"
          label="Record tabs"
          value={value}
          onChange={setValue}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "timeline", label: "Timeline" },
          ]}
        />
      );
    }
    await h.render(<Probe />);
    const event = new h.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: "ArrowRight" });
    await act(async () => h.q('[role="tab"]')!.dispatchEvent(event));
    await h.wait(0);
    expect(h.q('[aria-selected="true"]')?.textContent).toBe("Timeline");
    expect(h.q('[aria-selected="true"]')?.getAttribute("tabindex")).toBe("0");
  });
  test("CSV preview requires a conflict decision and keeps text for correction", async () => {
    h = makeHarness();
    h.onFetch((_url, body) => ({
      json: {
        ok: true,
        text: "Preview",
        data:
          body.name === "crm.csv.preview"
            ? {
                id: "preview-1",
                kind: "companies",
                rows: [
                  {
                    row: 2,
                    values: { name: "Duplicate" },
                    errors: [],
                    conflicts: [{ id: "a", version: 2, label: "Company a", reason: "same phone" }],
                  },
                ],
                valid: 1,
                invalid: 0,
                conflicts: 1,
                headers: ["name"],
              }
            : {},
      },
    }));
    await h.render(<CsvImport kind="companies" onClose={() => {}} onSaved={() => {}} />);
    await h.type(input("CSV content"), "name\nDuplicate");
    await h.click(h.byText("button", "Preview and validate"));
    expect(h.byText("button", "Import reviewed rows")?.hasAttribute("disabled")).toBe(true);
    await h.click(h.byText("button", "Edit CSV"));
    await h.click(h.byText("button", "Preview and validate"));
    expect(posts()[1].body.input.csv).toBe("name\nDuplicate");
    expect(posts().every((p) => p.body.name === "crm.csv.preview")).toBe(true);
  });
});

const templateFixture = (id = "discovery"): WorkflowTemplate => ({
  ...defaultWorkflowDefinitions().find((definition) => definition.id === id)!,
  version: 1,
  provenance: {
    catalogueId: id,
    catalogueVersion: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    updatedBy: { catalogue: true },
  },
  history: [],
});
const projectFixture = (): Project => ({
  id: "project-a",
  companyId: "a",
  dealId: "won",
  name: "Client website",
  version: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  owner: "usman",
  status: "onboarding",
  scope: "Website",
  contentRequests: [],
  accessRequests: [],
  milestones: [],
  previewUrls: [],
  revisionRequests: [],
  deliverables: [],
  launchAt: null,
  renewalAt: null,
  legacyLeadId: null,
});
const documentFixture = (deferred = false): Document => ({
  id: "doc-a",
  companyId: "a",
  dealId: "won",
  projectId: "project-a",
  title: "Delivery evidence",
  kind: "deliverable",
  status: "draft",
  version: 1,
  currentVersion: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  externalUrl: null,
  versions: [
    {
      id: "version-a",
      documentId: "doc-a",
      number: 1,
      createdAt: "2026-10-01T00:00:00Z",
      by: { personId: "usman" },
      content: deferred ? "" : "Actual recorded review",
      artifact: null,
      pricing: null,
      ...(deferred ? { contentDeferred: true } : {}),
    },
  ],
});
describe("Workflow templates and ordered client work", () => {
  test("template catalogue is searchable and never falls back to guessed saved records", async () => {
    h = makeHarness();
    h.onFetch(() => ({
      json: { ok: true, text: "Templates", data: [templateFixture(), templateFixture("proposal")] },
    }));
    await h.render(wrap(<WorkflowTemplates snapshot={snapshot()} onSaved={() => {}} />));
    await h.wait(0);
    expect(h.text()).toContain("Discovery meeting notes");
    await h.type(h.q('input[aria-label="Search workflow templates"]')!, "proposal");
    expect(h.text()).toContain("Proposal draft");
    expect(h.text()).not.toContain("Discovery meeting notes");
    expect(posts().every((post) => post.body.name === "crm.workflow.templates")).toBe(true);
  });
  test("template conflict retains edited text and the original version after refresh", async () => {
    h = makeHarness();
    h.onFetch(() => ({
      status: 409,
      json: { ok: false, code: "conflict", text: "Template changed." },
    }));
    const template = templateFixture();
    await h.render(<TemplateEditor template={template} onClose={() => {}} onSaved={() => {}} />);
    await h.type(input("Summary"), "My retained template draft");
    await h.submit(h.q("form")!);
    expect(h.text()).toContain("Your draft has been kept");
    await h.render(
      <TemplateEditor
        template={{ ...template, version: 2, summary: "Other founder's version" }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await h.submit(h.q("form")!);
    expect(posts()[1].body.input.expectedVersion).toBe(1);
    expect(posts()[1].body.input.patch.summary).toBe("My retained template draft");
  });
  test("applying proposal uses an explicit deal and its price revision, keeping the request ID for an uncertain retry", async () => {
    h = makeHarness();
    const state = snapshot();
    state.deals = [{ ...deal("proposal", 123456), version: 7 }];
    let attempts = 0;
    h.onFetch(() => {
      attempts++;
      if (attempts === 1) throw new Error("Connection interrupted");
      return { json: { ok: true, text: "Reused saved records" } };
    });
    await h.render(
      wrap(
        <ApplyWorkflow
          template={templateFixture("proposal")}
          snapshot={state}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
    expect(posts()).toHaveLength(0);
    expect(h.byText("button", "Create tasks and draft")?.hasAttribute("disabled")).toBe(true);
    await h.type(input("Apply to record"), "proposal");
    await h.submit(h.q("form")!);
    expect(posts()).toHaveLength(1);
    expect(h.text()).toContain("may have saved");
    await h.submit(h.q("form")!);
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body.input.requestId).toBe(posts()[0].body.input.requestId);
    expect(posts()[1].body.input.expectedDealVersion).toBe(7);
    expect(posts()[1].body.input.ref).toEqual({ kind: "deal", id: "proposal" });
  });
  test("delivery-result form preserves exact project, deal and artifact relationships", async () => {
    h = makeHarness();
    const state = snapshot();
    state.projects = [projectFixture()];
    state.deals = [deal("won", 100000)];
    h.onFetch(() => ({ json: { ok: true, text: "Saved" } }));
    await h.render(
      <RecordEditor
        target={{
          kind: "document",
          companyId: "a",
          dealId: "won",
          projectId: "project-a",
          documentKind: "deliverable",
        }}
        snapshot={state}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await h.type(input("Title"), "Website review result");
    await h.type(input("Saved result reference"), "artifact:job-a/review.html");
    await h.submit(h.q("form")!);
    expect(posts()[0].body.input).toMatchObject({
      companyId: "a",
      dealId: "won",
      projectId: "project-a",
      kind: "deliverable",
      artifact: "artifact:job-a/review.html",
      status: "draft",
    });
  });
  test("delivery task defaults to delivery and keeps its linked project and deal", async () => {
    h = makeHarness();
    const state = snapshot();
    state.projects = [projectFixture()];
    state.deals = [deal("won", 100000)];
    h.onFetch(() => ({ json: { ok: true, text: "Saved" } }));
    await h.render(
      <RecordEditor
        target={{ kind: "task", companyId: "a", dealId: "won", projectId: "project-a" }}
        snapshot={state}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await h.type(input("Title"), "Review responsive layout");
    await h.submit(h.q("form")!);
    expect(posts()[0].body.input).toMatchObject({
      kind: "delivery",
      status: "open",
      companyId: "a",
      dealId: "won",
      projectId: "project-a",
    });
  });
  test("document versions fetch only when expanded, retry a failed read, and edit full saved content", async () => {
    h = makeHarness();
    let reads = 0;
    let selected: Document | undefined;
    h.onFetch(() => {
      reads++;
      return reads === 1
        ? { status: 503, json: { error: "Temporary read failure" } }
        : { json: { ok: true, text: "Opened", data: documentFixture() } };
    });
    await h.render(
      wrap(
        <DocumentVersions
          document={documentFixture(true)}
          newVersion={(document) => {
            selected = document;
          }}
        />,
      ),
    );
    expect(posts()).toHaveLength(0);
    await h.click(
      h.qa("button").find((button) => button.textContent?.includes("Versions and content"))!,
    );
    await h.wait(0);
    expect(h.text()).toContain("Document content could not load");
    expect(h.byText("button", "Add version")).toBeNull();
    await h.click(h.byText("button", "Retry content"));
    await h.wait(0);
    expect(h.text()).toContain("Actual recorded review");
    await h.click(h.byText("button", "Add version"));
    expect(selected?.versions[0].content).toBe("Actual recorded review");
    expect(h.fetchCalls.filter((call) => call.url.startsWith("/__crm/record"))).toHaveLength(2);
    expect(h.fetchCalls.at(-1)?.url).toBe("/__crm/record?ref=crm%3Adocument%3Adoc-a");
    expect(posts()).toHaveLength(0);
  });
  test("document-version editor keeps original optimistic version during a background refresh", async () => {
    h = makeHarness();
    h.onFetch(() => ({
      status: 409,
      json: { ok: false, text: "Document changed", code: "conflict" },
    }));
    await h.render(
      <DocumentVersionEditor document={documentFixture()} onClose={() => {}} onSaved={() => {}} />,
    );
    await h.type(input("Content"), "My review draft");
    await h.render(
      <DocumentVersionEditor
        document={{ ...documentFixture(), version: 2 }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await h.submit(h.q("form")!);
    expect(posts()[0].body.input).toMatchObject({
      id: "doc-a",
      expectedVersion: 1,
      content: "My review draft",
    });
  });
  test("journey does not treat a completed task or a draft deliverable as a linked result", async () => {
    h = makeHarness();
    const state = snapshot();
    state.projects = [projectFixture()];
    state.deals = [deal("won", 100000)];
    state.documents = [documentFixture()];
    state.tasks = [{ ...task(null), projectId: "project-a", status: "done" }];
    const journey = companyJourney(state, state.companies[0], "project-a");
    expect(journey.steps.find((step) => step.id === "task")?.recorded).toBe(true);
    expect(journey.steps.find((step) => step.id === "result")?.recorded).toBe(false);
    await h.render(
      <WorkflowJourney
        company={state.companies[0]}
        snapshot={state}
        selectedId="project-a"
        actions={actions}
      />,
    );
    expect(h.text()).toContain("do not confirm payment or agent completion");
    state.documents[0].versions[0].artifact = "artifact:job-a/review.html";
    expect(
      companyJourney(state, state.companies[0], "project-a").steps.find(
        (step) => step.id === "result",
      )?.recorded,
    ).toBe(true);
    expect(nextBusinessActions(state).every((action) => action.company.id !== "b")).toBe(false); // Opt-out does not prevent internal record preparation.
  });
});
