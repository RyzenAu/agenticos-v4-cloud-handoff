import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Disclosure, EmptyState, Notice, Section, Surface } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CRM_QUERY_KEY, crmErrorMessage, crmOperation, type CrmReceipt } from "@/lib/crm-client";
import { fmtDateTime } from "@/lib/format";
import type { CrmSnapshot } from "../../../scripts/crm/types";
import {
  WORKFLOW_PLACEHOLDERS,
  workflowTemplateUpdateSchema,
  type WorkflowTemplate,
  type WorkflowTemplateDefinition,
  type WorkflowApplyInput,
  type WorkflowRunReceipt,
} from "../../../scripts/crm/workflow-templates";
import { Field, Modal, NativeSelect, ownerName, ownerOptions, SaveActions } from "./controls";
import { dateTimeValue, matchesSearch } from "./selectors";
const TEMPLATES_KEY = ["crm", "workflow-templates"] as const;
const taskKinds = [
  "follow-up",
  "call",
  "email",
  "meeting",
  "promise",
  "delivery",
  "renewal",
  "other",
] as const;
const documentKinds = ["proposal", "brief", "deliverable", "other"] as const;
export function WorkflowTemplates({
  snapshot,
  onSaved,
}: {
  snapshot: CrmSnapshot;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const query = useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: () => crmOperation<WorkflowTemplate[]>("crm.workflow.templates", {}),
    staleTime: 15_000,
    retry: false,
  });
  const [search, setSearch] = useState(""),
    [kind, setKind] = useState(""),
    [editing, setEditing] = useState<WorkflowTemplate | null>(null),
    [applying, setApplying] = useState<WorkflowTemplate | null>(null);
  const templates = query.data?.data ?? [];
  const filtered = templates.filter(
    (t) =>
      (!kind || t.appliesTo.some((k) => k === kind)) &&
      matchesSearch([t.title, t.summary, t.id], search),
  );
  return (
    <Section
      title="Workflow templates"
      description="Reusable checklists and draft content for each step of client work"
    >
      <p className="mb-5 max-w-[75ch] text-sm text-muted-foreground">
        Edit a version, then apply it to a specific company, deal or project. Applying creates
        internal tasks and draft documents with a timeline entry. Review and complete the work
        before recording an outcome.
      </p>
      <div className="mb-6 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)_auto]">
        <Input
          type="text"
          aria-label="Search workflow templates"
          placeholder="Search templates"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <NativeSelect
          aria-label="Filter template target"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All record types</option>
          <option value="company">Company</option>
          <option value="deal">Deal</option>
          <option value="project">Project</option>
        </NativeSelect>
        <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? "Refreshing…" : "Refresh templates"}
        </Button>
      </div>
      {query.isError && (
        <Notice
          className="mb-5"
          tone="warn"
          title={
            templates.length ? "Showing previously loaded templates" : "Templates could not load"
          }
        >
          {crmErrorMessage(query.error)} Use Refresh templates to try again. Open drafts are kept.
        </Notice>
      )}
      {query.isPending ? (
        <p role="status">Loading workflow templates…</p>
      ) : filtered.length ? (
        <div className="grid min-w-0 gap-5 lg:grid-cols-2">
          {filtered.map((template) => (
            <Surface key={template.id} className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="min-w-0 break-words text-base font-semibold">{template.title}</h3>
                <span className="text-xs text-muted-foreground">Version {template.version}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{template.summary}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                {template.appliesTo.join(" · ")} · {template.tasks.length} task
                {template.tasks.length === 1 ? "" : "s"}
                {template.document ? " + draft document" : ""}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="accent" onClick={() => setApplying(template)}>
                  Apply template
                </Button>
                <Button variant="outline" onClick={() => setEditing(template)}>
                  Edit template
                </Button>
              </div>
              <Disclosure
                className="mt-3"
                summary="Preview and version history"
                meta={`${template.history.length} earlier versions`}
              >
                <TemplatePreview template={template} />
                <p className="mt-4 text-xs text-muted-foreground">
                  Catalogue {template.provenance.catalogueId} v
                  {template.provenance.catalogueVersion} · Updated{" "}
                  {fmtDateTime(template.provenance.updatedAt)} by{" "}
                  {"personId" in template.provenance.updatedBy
                    ? ownerName(template.provenance.updatedBy.personId)
                    : "Catalogue"}
                </p>
                {template.history.length ? (
                  <div className="mt-3 space-y-3">
                    {[...template.history].reverse().map((version) => (
                      <Disclosure
                        key={version.version}
                        summary={`Version ${version.version} · ${version.title}`}
                        meta={fmtDateTime(version.savedAt)}
                      >
                        <TemplatePreview template={version} />
                      </Disclosure>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    No earlier versions. Saving your first edit retains the original.
                  </p>
                )}
              </Disclosure>
            </Surface>
          ))}
        </div>
      ) : (
        !query.isError && (
          <EmptyState
            title={templates.length ? "No matching templates" : "No templates available"}
            body={
              templates.length
                ? "Try another search or record type."
                : "Refresh to load the workflow catalogue."
            }
          />
        )
      )}
      {editing && (
        <TemplateEditor
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={(receipt) => {
            setEditing(null);
            void query.refetch();
            onSaved(receipt);
          }}
        />
      )}
      {applying && (
        <ApplyWorkflow
          template={applying}
          snapshot={snapshot}
          onClose={() => setApplying(null)}
          onSaved={(receipt) => {
            setApplying(null);
            onSaved(receipt);
          }}
        />
      )}
    </Section>
  );
}
function TemplatePreview({ template }: { template: WorkflowTemplateDefinition }) {
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        {template.tasks.map((task) => (
          <li key={task.key}>
            <p className="font-medium">{task.title}</p>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{task.description}</p>
          </li>
        ))}
      </ol>
      {template.document && (
        <div className="border-t border-border pt-3">
          <p className="text-sm font-medium">Draft: {template.document.title}</p>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-muted-foreground">
            {template.document.content}
          </pre>
        </div>
      )}
    </div>
  );
}
export function TemplateEditor({
  template,
  onClose,
  onSaved,
}: {
  template: WorkflowTemplate;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [base] = useState(template);
  const [draft, setDraft] = useState<WorkflowTemplateDefinition>(() => ({
    id: base.id,
    title: base.title,
    summary: base.summary,
    appliesTo: [...base.appliesTo],
    tasks: base.tasks.map((t) => ({ ...t })),
    document: base.document ? { ...base.document } : null,
  }));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const set = <K extends keyof WorkflowTemplateDefinition>(
    key: K,
    value: WorkflowTemplateDefinition[K],
  ) => setDraft((d) => ({ ...d, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current) return;
    const { id, ...patch } = draft;
    const parsed = workflowTemplateUpdateSchema.safeParse({
      id,
      expectedVersion: base.version,
      patch,
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(" → ")}: ${issue.message}`)
          .join(". "),
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      onSaved(await crmOperation("crm.workflow.update", parsed.data));
    } catch (error) {
      setError(crmErrorMessage(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Edit ${base.title}`}
      description={`Save a new version from version ${base.version}. Existing tasks and documents keep their original content.`}
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5">
        {error && (
          <Notice tone="danger" title="Template not saved">
            {error}
          </Notice>
        )}
        <Field label="Template title">
          <Input
            type="text"
            required
            maxLength={300}
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </Field>
        <Field label="Summary">
          <Input
            type="text"
            required
            maxLength={300}
            value={draft.summary}
            onChange={(e) => set("summary", e.target.value)}
          />
        </Field>
        <fieldset>
          <legend className="text-sm font-medium">Available for</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {(["company", "deal", "project"] as const).map((kind) => (
              <label key={kind} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.appliesTo.includes(kind)}
                  onChange={(e) =>
                    set(
                      "appliesTo",
                      e.target.checked
                        ? [...draft.appliesTo, kind]
                        : draft.appliesTo.filter((k) => k !== kind),
                    )
                  }
                />
                {kind}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Supported placeholders: {WORKFLOW_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}. Missing
          record details remain marked for review.
        </p>
        {draft.tasks.map((task, index) => (
          <fieldset key={task.key} className="space-y-3 rounded-xl border border-border p-4">
            <legend className="px-1 text-sm font-medium">Task {index + 1}</legend>
            <Field label={`Task ${index + 1} title`}>
              <Input
                type="text"
                required
                maxLength={300}
                value={task.title}
                onChange={(e) =>
                  set(
                    "tasks",
                    draft.tasks.map((t, i) => (i === index ? { ...t, title: e.target.value } : t)),
                  )
                }
              />
            </Field>
            <Field label={`Task ${index + 1} type`}>
              <NativeSelect
                value={task.kind}
                onChange={(e) =>
                  set(
                    "tasks",
                    draft.tasks.map((t, i) =>
                      i === index ? { ...t, kind: e.target.value as typeof task.kind } : t,
                    ),
                  )
                }
              >
                {taskKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={`Task ${index + 1} instructions`}>
              <Textarea
                rows={3}
                maxLength={10000}
                value={task.description}
                onChange={(e) =>
                  set(
                    "tasks",
                    draft.tasks.map((t, i) =>
                      i === index ? { ...t, description: e.target.value } : t,
                    ),
                  )
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              disabled={draft.tasks.length === 1}
              onClick={() =>
                set(
                  "tasks",
                  draft.tasks.filter((_, i) => i !== index),
                )
              }
            >
              Remove task {index + 1}
            </Button>
          </fieldset>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={draft.tasks.length >= 8}
          onClick={() =>
            set("tasks", [
              ...draft.tasks,
              { key: `task-${crypto.randomUUID()}`, title: "", description: "", kind: "follow-up" },
            ])
          }
        >
          Add template task
        </Button>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={!!draft.document}
            onChange={(e) =>
              set(
                "document",
                e.target.checked
                  ? {
                      title: draft.title,
                      kind: "brief",
                      content: "Details to confirm for {{company.name}}",
                    }
                  : null,
              )
            }
          />
          Create an internal draft document
        </label>
        {draft.document && (
          <div className="space-y-4 rounded-xl border border-border p-4">
            <Field label="Draft document title">
              <Input
                type="text"
                required
                value={draft.document.title}
                onChange={(e) => set("document", { ...draft.document!, title: e.target.value })}
              />
            </Field>
            <Field label="Draft document type">
              <NativeSelect
                value={draft.document.kind}
                onChange={(e) =>
                  set("document", {
                    ...draft.document!,
                    kind: e.target.value as NonNullable<typeof draft.document>["kind"],
                  })
                }
              >
                {documentKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Draft document content">
              <Textarea
                required
                rows={10}
                maxLength={10000}
                value={draft.document.content}
                onChange={(e) => set("document", { ...draft.document!, content: e.target.value })}
              />
            </Field>
          </div>
        )}
        <SaveActions busy={busy} onClose={onClose} label="Save new template version" />
      </form>
    </Modal>
  );
}
export function ApplyWorkflow({
  template,
  snapshot,
  onClose,
  onSaved,
}: {
  template: WorkflowTemplate;
  snapshot: CrmSnapshot;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [baseSnapshot] = useState(snapshot);
  snapshot = baseSnapshot;
  const [base] = useState(template),
    [requestId] = useState(() => `workflow-${crypto.randomUUID()}`);
  const [kind, setKind] = useState<WorkflowApplyInput["ref"]["kind"]>(base.appliesTo[0]);
  const [recordId, setRecordId] = useState(""),
    [owner, setOwner] = useState<"usman" | "mehroz" | "">(""),
    [due, setDue] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const running = useRef(false),
    queryClient = useQueryClient();
  const choices =
    kind === "company"
      ? snapshot.companies.filter((c) => !c.mergedInto).map((c) => ({ id: c.id, label: c.name }))
      : kind === "deal"
        ? snapshot.deals.map((d) => ({
            id: d.id,
            label: `${snapshot.companies.find((c) => c.id === d.companyId)?.name ?? "Company unavailable"} · ${d.title}`,
          }))
        : snapshot.projects.map((p) => ({
            id: p.id,
            label: `${snapshot.companies.find((c) => c.id === p.companyId)?.name ?? "Company unavailable"} · ${p.name}`,
          }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || !recordId) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const receipt = await crmOperation<WorkflowRunReceipt>("crm.workflow.apply", {
        templateId: base.id,
        expectedVersion: base.version,
        requestId,
        ref: { kind, id: recordId },
        expectedDealVersion: snapshot.deals.find(
          (deal) =>
            deal.id ===
            (kind === "deal"
              ? recordId
              : kind === "project"
                ? snapshot.projects.find((project) => project.id === recordId)?.dealId
                : undefined),
        )?.version,
        owner,
        dueAt: dateTimeValue(due),
      });
      void queryClient.invalidateQueries({ queryKey: CRM_QUERY_KEY });
      onSaved(receipt);
    } catch (error) {
      setError(crmErrorMessage(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Apply ${base.title}`}
      description={`Version ${base.version} creates ${base.tasks.length} task${base.tasks.length === 1 ? "" : "s"}${base.document ? " and one draft document" : ""}. Review the destination before applying.`}
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5">
        {error && (
          <Notice tone="danger" title="Application not confirmed">
            {error}
          </Notice>
        )}
        <Field label="Record type">
          <NativeSelect
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setRecordId("");
            }}
          >
            {base.appliesTo.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Apply to record">
          <NativeSelect required value={recordId} onChange={(e) => setRecordId(e.target.value)}>
            <option value="">Choose the exact {kind}</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {!choices.length && (
          <Notice tone="info">Create a {kind} record before applying this template.</Notice>
        )}
        <Field label="Task owner">
          <NativeSelect value={owner} onChange={(e) => setOwner(e.target.value as typeof owner)}>
            {ownerOptions}
          </NativeSelect>
        </Field>
        <Field label="Task due date" hint="Optional; uses your browser's local time zone">
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Disclosure summary="Review tasks and draft" defaultOpen>
          <TemplatePreview template={base} />
        </Disclosure>
        <p className="text-xs text-muted-foreground">
          No email, agent job, payment, acceptance or completed delivery is recorded by applying a
          template.
        </p>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="accent" disabled={busy || !recordId}>
            {busy ? "Applying…" : "Create tasks and draft"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
