import { useState, type FormEvent } from "react";
import type {
  Company,
  Contact,
  Deal,
  Task,
  Project,
  Document,
  CrmSnapshot,
  Pipeline,
  CommunicationState,
} from "../../../scripts/crm/types";
import { SALES_STAGES } from "../../../scripts/crm/types";
import { Button, Notice } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  crmErrorMessage,
  crmOperation,
  type CrmReceipt,
  type CrmOperationName,
  type CrmOperationInputMap,
} from "@/lib/crm-client";
import { Field, Modal, NativeSelect, SaveActions, ownerOptions } from "./controls";
import { dateTimeValue, localDateTime, moneyCents, splitLines } from "./selectors";

export type EditableKind = "company" | "contact" | "deal" | "task" | "project" | "document";
export type EditableRecord = Company | Contact | Deal | Task | Project | Document;
export type EditorTarget = {
  kind: EditableKind;
  record?: EditableRecord;
  companyId?: string;
  dealId?: string;
  projectId?: string;
};
type Fields = Record<string, string>;
function initialFields(target: EditorTarget, snapshot: CrmSnapshot): Fields {
  const r: Record<string, unknown> = { ...target.record };
  const val = (key: string, fallback = "") => String(r[key] ?? fallback);
  return {
    name: val("name"),
    title: val("title"),
    companyId:
      target.companyId ?? val("companyId", snapshot.companies.find((c) => !c.mergedInto)?.id),
    owner: val("owner"),
    industry: val("industry"),
    website: val("website"),
    locality: val("locality"),
    address: val("address"),
    timezone: val("timezone", "Australia/Sydney"),
    phone: val("phone"),
    emails: Array.isArray(r.emails) ? r.emails.join("\n") : "",
    tags: Array.isArray(r.tags) ? r.tags.join(", ") : "",
    notes: val("notes"),
    status: val(
      "status",
      target.kind === "company"
        ? "prospect"
        : target.kind === "task"
          ? "open"
          : target.kind === "document"
            ? "draft"
            : "onboarding",
    ),
    doNotContact: val("doNotContact", "false"),
    emailAllowed: val("emailAllowed", "false"),
    excluded: val("excluded", "false"),
    excludedReason: val("excludedReason"),
    role: val("role"),
    email: val("email"),
    primary: val("primary", "false"),
    preferences: val("preferences"),
    restrictions: Array.isArray(r.restrictions) ? r.restrictions.join("\n") : "",
    service: val("service", "website"),
    scope: val("scope"),
    pipelineId: val("pipelineId", snapshot.pipelines[0]?.id ?? "sales"),
    stageId: val("stageId", "new"),
    contactIds: Array.isArray(r.contactIds) ? r.contactIds.join(",") : "",
    oneOff: target.record ? String(Number(r.oneOffCents ?? 0) / 100) : "",
    recurring: target.record ? String(Number(r.recurringCents ?? 0) / 100) : "",
    gstTreatment: val("gstTreatment", "exclusive"),
    expectedClose: val("expectedClose").slice(0, 10),
    nextAction: val("nextAction"),
    nextActionDue: localDateTime(val("nextActionDue")),
    closeReason: val("closeReason"),
    commercialBasis: val("commercialBasis", "catalogue"),
    kind: val("kind", target.kind === "document" ? "brief" : "follow-up"),
    description: val("description"),
    dueAt: localDateTime(val("dueAt")),
    dealId: target.dealId ?? val("dealId"),
    projectId: target.projectId ?? val("projectId"),
    contentRequests: Array.isArray(r.contentRequests) ? r.contentRequests.join("\n") : "",
    accessRequests: Array.isArray(r.accessRequests) ? r.accessRequests.join("\n") : "",
    previewUrls: Array.isArray(r.previewUrls) ? r.previewUrls.join("\n") : "",
    revisionRequests: Array.isArray(r.revisionRequests) ? r.revisionRequests.join("\n") : "",
    deliverables: Array.isArray(r.deliverables) ? r.deliverables.join("\n") : "",
    launchAt: localDateTime(val("launchAt")),
    renewalAt: localDateTime(val("renewalAt")),
    content: "",
    externalUrl: val("externalUrl"),
    artifact: "",
  };
}
export function RecordEditor({
  target,
  snapshot,
  onClose,
  onSaved,
}: {
  target: EditorTarget;
  snapshot: CrmSnapshot;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [baseTarget] = useState(target);
  target = baseTarget;
  const [originalFields] = useState(() => initialFields(baseTarget, snapshot));
  // Intentionally initialised once. A background refresh must not erase a draft or
  // silently advance the optimistic concurrency revision under the user's cursor.
  const [fields, setFields] = useState(() => initialFields(target, snapshot));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const set = (key: string, value: string) =>
    setFields((previous) => ({
      ...previous,
      [key]: value,
      ...(["oneOff", "recurring"].includes(key) && value !== ""
        ? { commercialBasis: "agreed" }
        : {}),
    }));
  const text = (
    key: string,
    label: string,
    options: { type?: string; required?: boolean; wide?: boolean; hint?: string } = {},
  ) => (
    <Field key={key} label={label} wide={options.wide} hint={options.hint}>
      <Input
        className="min-h-11"
        type={options.type ?? "text"}
        value={fields[key] ?? ""}
        onChange={(event) => set(key, event.target.value)}
        required={options.required}
        step={options.type === "number" ? "0.01" : undefined}
        min={options.type === "number" ? "0" : undefined}
      />
    </Field>
  );
  const area = (key: string, label: string, hint?: string) => (
    <Field key={key} label={label} wide hint={hint}>
      <Textarea
        rows={3}
        value={fields[key] ?? ""}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  );
  const select = (key: string, label: string, options: { value: string; label: string }[]) => (
    <Field key={key} label={label}>
      <NativeSelect value={fields[key]} onChange={(event) => set(key, event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
  const check = (key: string, label: string) => (
    <label key={key} className="flex min-h-11 items-center gap-3 text-sm sm:col-span-2">
      <input
        className="size-4 accent-[var(--brand)]"
        type="checkbox"
        checked={fields[key] === "true"}
        disabled={
          (key === "doNotContact" && originalFields.doNotContact === "true") ||
          (key === "emailAllowed" && fields.doNotContact === "true")
        }
        onChange={(event) => set(key, String(event.target.checked))}
      />
      {label}
      {key === "doNotContact" && originalFields.doNotContact === "true" && (
        <span className="text-xs text-muted-foreground">Existing opt-out retained</span>
      )}
    </label>
  );
  const linkedDeal = (
    <Field label="Linked deal">
      <NativeSelect value={fields.dealId} onChange={(e) => set("dealId", e.target.value)}>
        <option value="">No linked deal</option>
        {snapshot.deals
          .filter((d) => d.companyId === fields.companyId)
          .map((d) => (
            <option value={d.id} key={d.id}>
              {d.title}
            </option>
          ))}
      </NativeSelect>
    </Field>
  );
  const owner = (
    <Field label="Responsible founder">
      <NativeSelect value={fields.owner} onChange={(e) => set("owner", e.target.value)}>
        {ownerOptions}
      </NativeSelect>
    </Field>
  );
  const stages = snapshot.pipelines.find((p) => p.id === fields.pipelineId)?.stages ?? SALES_STAGES;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let patch: Record<string, unknown>;
      switch (target.kind) {
        case "company":
          patch = {
            name: fields.name.trim(),
            industry: fields.industry,
            website: fields.website,
            locality: fields.locality,
            address: fields.address,
            timezone: fields.timezone,
            phone: fields.phone,
            emails: splitLines(fields.emails),
            owner: fields.owner,
            tags: fields.tags
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            notes: fields.notes,
            status: fields.status,
            doNotContact: fields.doNotContact === "true",
            emailAllowed: fields.emailAllowed === "true",
            excluded: fields.excluded === "true",
            excludedReason: fields.excludedReason,
          };
          break;
        case "contact":
          patch = {
            name: fields.name.trim(),
            role: fields.role,
            email: fields.email,
            phone: fields.phone,
            primary: fields.primary === "true",
            owner: fields.owner,
            preferences: fields.preferences,
            restrictions: splitLines(fields.restrictions),
            doNotContact: fields.doNotContact === "true",
          };
          break;
        case "deal":
          patch = {
            title: fields.title.trim(),
            owner: fields.owner,
            service: fields.service,
            scope: fields.scope,
            pipelineId: fields.pipelineId,
            stageId: fields.stageId,
            contactIds: fields.contactIds.split(",").filter(Boolean),
            ...(fields.oneOff !== "" ? { oneOffCents: moneyCents(fields.oneOff) } : {}),
            ...(fields.recurring !== "" ? { recurringCents: moneyCents(fields.recurring) } : {}),
            gstTreatment: fields.gstTreatment,
            expectedClose: fields.expectedClose || null,
            nextAction: fields.nextAction,
            nextActionDue: dateTimeValue(fields.nextActionDue),
            closeReason: fields.closeReason,
            commercialBasis: fields.commercialBasis,
          };
          break;
        case "task":
          patch = {
            title: fields.title.trim(),
            description: fields.description,
            kind: fields.kind,
            owner: fields.owner,
            status: fields.status,
            dueAt: dateTimeValue(fields.dueAt),
            dealId: fields.dealId || null,
            projectId: fields.projectId || null,
          };
          break;
        case "project":
          patch = {
            name: fields.name.trim(),
            owner: fields.owner,
            status: fields.status,
            scope: fields.scope,
            dealId: fields.dealId || null,
            contentRequests: splitLines(fields.contentRequests),
            accessRequests: splitLines(fields.accessRequests),
            previewUrls: splitLines(fields.previewUrls),
            revisionRequests: splitLines(fields.revisionRequests),
            deliverables: splitLines(fields.deliverables),
            launchAt: dateTimeValue(fields.launchAt),
            renewalAt: dateTimeValue(fields.renewalAt),
          };
          break;
        case "document":
          patch = {
            title: fields.title.trim(),
            status: fields.status,
            externalUrl: fields.externalUrl || null,
          };
          if (!target.record)
            Object.assign(patch, {
              kind: fields.kind,
              dealId: fields.dealId || null,
              projectId: fields.projectId || null,
              content: fields.content,
            });
          break;
      }
      if (target.record) {
        const fieldsForKey: Record<string, string> = {
          oneOffCents: "oneOff",
          recurringCents: "recurring",
        };
        patch = Object.fromEntries(
          Object.entries(patch).filter(([key]) => {
            const field = fieldsForKey[key] ?? key;
            return fields[field] !== originalFields[field];
          }),
        );
        if (!Object.keys(patch).length) {
          onSaved({ ok: true, text: "No changes to save." });
          return;
        }
      }
      const input = target.record
        ? { id: target.record.id, expectedVersion: target.record.version, patch }
        : { ...patch, ...(target.kind !== "company" ? { companyId: fields.companyId } : {}) };
      const name: CrmOperationName = `crm.${target.kind}.${target.record ? "update" : "create"}`;
      // Field widgets provide strings; the registry validates the complete typed operation at the trust boundary.
      const receipt = await crmOperation(name, input as CrmOperationInputMap[typeof name]);
      onSaved(receipt);
    } catch (error) {
      setError(crmErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const noun = target.kind === "company" ? "company" : target.kind;
  return (
    <Modal
      title={`${target.record ? "Edit" : "Add"} ${noun}`}
      description={
        target.record
          ? `Changes are checked against record version ${target.record.version}. Both founders can access this record.`
          : "Save a shared business record. No message or invitation is sent."
      }
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-5">
        {error && (
          <Notice tone="danger" title="Could not save">
            {error}
          </Notice>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          {!target.record && target.kind !== "company" && (
            <Field label="Company" wide>
              <NativeSelect
                required
                value={fields.companyId}
                onChange={(e) => {
                  set("companyId", e.target.value);
                  set("dealId", "");
                  set("projectId", "");
                  set("contactIds", "");
                }}
              >
                <option value="">Choose a company</option>
                {snapshot.companies
                  .filter((c) => !c.mergedInto)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          )}
          {target.kind === "company" || target.kind === "contact" || target.kind === "project"
            ? text(
                "name",
                target.kind === "company"
                  ? "Business name"
                  : target.kind === "contact"
                    ? "Full name"
                    : "Project name",
                { required: true, wide: true },
              )
            : text("title", "Title", { required: true, wide: true })}
          {target.kind !== "document" && owner}
          {target.kind === "company" && (
            <>
              {select("status", "Relationship", [
                { value: "prospect", label: "Prospect" },
                { value: "client", label: "Client" },
                { value: "inactive", label: "Inactive" },
              ])}
              {text("industry", "Industry")}
              {text("locality", "Locality")}
              {text("website", "Website", { type: "url" })}
              {text("phone", "Business phone", { type: "tel" })}
              {area("emails", "Business email addresses", "One email per line")}
              {text("address", "Address", { wide: true })}
              {text("timezone", "Time zone", { hint: "IANA name, for example Australia/Sydney" })}
              {text("tags", "Tags", { hint: "Separate with commas" })}
              {area("notes", "Internal notes")}
              {check("doNotContact", "Do not contact this company")}
              {check("emailAllowed", "Email permission has been verified")}
              {check("excluded", "Exclude from prospecting")}
              {fields.excluded === "true" &&
                text("excludedReason", "Reason for exclusion", { wide: true })}
            </>
          )}
          {target.kind === "contact" && (
            <>
              {text("role", "Role")}
              {text("email", "Email", { type: "email" })}
              {text("phone", "Phone", { type: "tel" })}
              {check("primary", "Primary contact for this company")}
              {check("doNotContact", "Do not contact this person")}
              {area("preferences", "Contact preferences")}
              {area(
                "restrictions",
                "Restrictions",
                "One restriction per line. Record consent and channel limits here.",
              )}
            </>
          )}
          {target.kind === "deal" && (
            <>
              {select(
                "pipelineId",
                "Pipeline",
                snapshot.pipelines.length
                  ? snapshot.pipelines.map((p) => ({ value: p.id, label: p.name }))
                  : [{ value: "sales", label: "Sales" }],
              )}
              {select(
                "stageId",
                "Sales stage",
                stages
                  .filter((s) => !s.archived || s.id === fields.stageId)
                  .map((s) => ({ value: s.id, label: s.name })),
              )}
              {text("service", "Service", { required: true })}
              {text("oneOff", "One-off value (AUD)", {
                type: "number",
                hint: !target.record ? "Leave blank to use the approved catalogue" : undefined,
              })}
              {text("recurring", "Monthly recurring value (AUD)", {
                type: "number",
                hint: !target.record ? "Leave blank to use the approved catalogue" : undefined,
              })}
              {select("gstTreatment", "GST treatment", [
                { value: "exclusive", label: "GST exclusive" },
                { value: "inclusive", label: "GST inclusive" },
                { value: "not-applicable", label: "GST not applicable" },
              ])}
              {text("expectedClose", "Expected close", { type: "date" })}
              {select("commercialBasis", "Commercial basis", [
                { value: "agreed", label: "Agreed deal value" },
                { value: "catalogue", label: "Approved catalogue" },
                { value: "legacy-unconfirmed", label: "Legacy value, unconfirmed" },
              ])}
              {area("scope", "Service and scope")}
              {text("nextAction", "Next action", { wide: true })}
              {text("nextActionDue", "Next action due", {
                type: "datetime-local",
                hint: "Times are entered in your browser's local time zone",
              })}
              {text("closeReason", "Won / lost reason")}
              {snapshot.contacts.some((c) => c.companyId === fields.companyId) && (
                <fieldset className="sm:col-span-2">
                  <legend className="mb-2 text-sm font-medium">Participating contacts</legend>
                  {snapshot.contacts
                    .filter((c) => c.companyId === fields.companyId)
                    .map((contact) => (
                      <label key={contact.id} className="flex min-h-11 items-center gap-3 text-sm">
                        <input
                          className="size-4"
                          type="checkbox"
                          checked={fields.contactIds.split(",").includes(contact.id)}
                          onChange={(e) => {
                            const selected = new Set(fields.contactIds.split(",").filter(Boolean));
                            e.target.checked
                              ? selected.add(contact.id)
                              : selected.delete(contact.id);
                            set("contactIds", [...selected].join(","));
                          }}
                        />
                        {contact.name}
                        {contact.role ? ` · ${contact.role}` : ""}
                      </label>
                    ))}
                </fieldset>
              )}
              <p className="text-sm text-muted-foreground sm:col-span-2">
                Values stay in AUD. Winning a deal does not mark an invoice or payment as received.
                Pricing catalogue and pilot terms remain unchanged.
              </p>
            </>
          )}
          {target.kind === "task" && (
            <>
              {select(
                "kind",
                "Task type",
                [
                  "follow-up",
                  "call",
                  "email",
                  "meeting",
                  "promise",
                  "delivery",
                  "renewal",
                  "other",
                ].map((value) => ({ value, label: value.replaceAll("-", " ") })),
              )}
              {select("status", "Status", [
                { value: "open", label: "Open" },
                { value: "in-progress", label: "In progress" },
                { value: "done", label: "Done" },
                { value: "cancelled", label: "Cancelled" },
              ])}
              {text("dueAt", "Due date and time", {
                type: "datetime-local",
                hint: "Your browser's local time zone",
              })}
              {linkedDeal}
              <Field label="Delivery project">
                <NativeSelect
                  value={fields.projectId}
                  onChange={(e) => set("projectId", e.target.value)}
                >
                  <option value="">No linked project</option>
                  {snapshot.projects
                    .filter((p) => p.companyId === fields.companyId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </NativeSelect>
              </Field>
              {area("description", "Details")}
            </>
          )}
          {target.kind === "project" && (
            <>
              {select(
                "status",
                "Delivery status",
                [
                  "onboarding",
                  "in-progress",
                  "review",
                  "launched",
                  "ongoing",
                  "on-hold",
                  "completed",
                ].map((value) => ({ value, label: value.replaceAll("-", " ") })),
              )}
              {linkedDeal}
              {area("scope", "Agreed scope")}
              {area("contentRequests", "Content requests", "One request per line")}
              {area(
                "accessRequests",
                "Access requests",
                "Describe what is needed. Do not store passwords or access tokens.",
              )}
              {area("previewUrls", "Preview links", "One full https:// URL per line")}
              {area("revisionRequests", "Revision requests", "One request per line")}
              {area("deliverables", "Deliverables", "One deliverable per line")}
              {text("launchAt", "Launch date", { type: "datetime-local" })}
              {text("renewalAt", "Service / renewal date", { type: "datetime-local" })}
            </>
          )}
          {target.kind === "document" && (
            <>
              {select(
                "status",
                "Document status",
                ["draft", "issued", "accepted", "superseded"].map((value) => ({
                  value,
                  label: value[0].toUpperCase() + value.slice(1),
                })),
              )}
              {!target.record && (
                <>
                  {select(
                    "kind",
                    "Document type",
                    [
                      "brief",
                      "proposal",
                      "agreement",
                      "invoice-reference",
                      "deliverable",
                      "other",
                    ].map((value) => ({ value, label: value.replaceAll("-", " ") })),
                  )}
                  {linkedDeal}
                  {area(
                    "content",
                    "First version content",
                    "Use Draft proposal on a deal for server-verified agreed pricing.",
                  )}
                </>
              )}
              {text("externalUrl", "Existing document link", { type: "url", wide: true })}
              <p className="text-sm text-muted-foreground sm:col-span-2">
                Status records what already happened. Saving here does not issue, send or accept a
                document with another party.
              </p>
            </>
          )}
        </div>
        <SaveActions
          busy={busy}
          onClose={onClose}
          label={target.record ? "Save changes" : `Add ${noun}`}
        />
      </form>
    </Modal>
  );
}

export function ActivityEditor({
  company,
  onClose,
  onSaved,
}: {
  company: Company;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [eventId] = useState(() => `manual:${crypto.randomUUID()}`);
  const [title, setTitle] = useState(""),
    [note, setNote] = useState(""),
    [kind, setKind] = useState("note"),
    [outcome, setOutcome] = useState(""),
    [externalUrl, setExternalUrl] = useState(""),
    [state, setState] = useState<CommunicationState>("unknown");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await crmOperation("crm.activity.add", {
          ref: { kind: "company", id: company.id },
          eventId,
          kind,
          title,
          note,
          outcome,
          externalUrl: externalUrl || null,
          ...(kind === "email" ? { communicationState: state } : {}),
        }),
      );
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Log an activity"
      description={`Record what happened with ${company.name}. No external communication is sent.`}
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Activity type">
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value)}>
              {["note", "call", "email", "meeting", "promise"].map((k) => (
                <option key={k} value={k}>
                  {k[0].toUpperCase() + k.slice(1)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Outcome">
            <Input
              className="min-h-11"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="For example, requested a callback"
            />
          </Field>
          <Field label="Summary" wide>
            <Input
              className="min-h-11"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Details" wide>
            <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Field label="Email thread / meeting link" wide>
            <Input
              className="min-h-11"
              type="url"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
            />
          </Field>
          {kind === "email" && (
            <Field label="Communication state">
              <NativeSelect
                value={state}
                onChange={(e) => setState(e.target.value as CommunicationState)}
              >
                {["unknown", "drafted", "received", "failed"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Sent and queued states require provider evidence. Add a follow-up task separately when an
          action is still due.
        </p>
        <SaveActions busy={busy} onClose={onClose} label="Log activity" />
      </form>
    </Modal>
  );
}

export function DocumentVersionEditor({
  document,
  onClose,
  onSaved,
}: {
  document: Document;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [content, setContent] = useState(document.versions.at(-1)?.content ?? ""),
    [artifact, setArtifact] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await crmOperation("crm.document.version.add", {
          id: document.id,
          expectedVersion: document.version,
          content,
          artifact: artifact || undefined,
        }),
      );
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`New version of ${document.title}`}
      description="Previous versions are retained. This saves an internal version without sending it."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Content">
          <Textarea rows={10} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        <Field
          label="Agent result reference"
          hint="Optional saved artifact: artifact:job-id or artifact:job-id/file"
        >
          <Input value={artifact} onChange={(e) => setArtifact(e.target.value)} />
        </Field>
        <SaveActions busy={busy} onClose={onClose} label="Save new version" />
      </form>
    </Modal>
  );
}

export function PipelineEditor({
  pipeline,
  onClose,
  onSaved,
}: {
  pipeline: Pipeline;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [name, setName] = useState(pipeline.name),
    [stages, setStages] = useState(() => pipeline.stages.map((s) => ({ ...s })));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await crmOperation("crm.pipeline.update", {
          id: pipeline.id,
          expectedVersion: pipeline.version,
          patch: { name, stages },
        }),
      );
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Configure sales stages"
      description="Stable stage IDs and existing history are preserved. Archive a stage instead of deleting it."
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Pipeline name">
          <Input
            className="min-h-11"
            value={name}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="space-y-4">
          {stages.map((stage, index) => (
            <fieldset
              key={stage.id}
              className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-3"
            >
              <legend className="px-1 text-xs text-muted-foreground">Stage {index + 1}</legend>
              <Field label="Name">
                <Input
                  className="min-h-11"
                  value={stage.name}
                  required
                  onChange={(e) =>
                    setStages((s) =>
                      s.map((x, i) => (i === index ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Field label="Category">
                <NativeSelect
                  value={stage.category}
                  onChange={(e) =>
                    setStages((s) =>
                      s.map((x, i) =>
                        i === index
                          ? { ...x, category: e.target.value as typeof stage.category }
                          : x,
                      ),
                    )
                  }
                >
                  <option value="open">Open</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </NativeSelect>
              </Field>
              <Field label="Probability (%)">
                <Input
                  className="min-h-11"
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round(stage.probability * 100)}
                  onChange={(e) =>
                    setStages((s) =>
                      s.map((x, i) =>
                        i === index ? { ...x, probability: Number(e.target.value) / 100 } : x,
                      ),
                    )
                  }
                />
              </Field>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={stage.archived}
                  onChange={(e) =>
                    setStages((s) =>
                      s.map((x, i) => (i === index ? { ...x, archived: e.target.checked } : x)),
                    )
                  }
                />
                Archived
              </label>
              <div className="flex gap-2 sm:col-span-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() =>
                    setStages((s) => {
                      const copy = [...s];
                      [copy[index - 1], copy[index]] = [copy[index], copy[index - 1]];
                      return copy;
                    })
                  }
                >
                  Move up
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={index === stages.length - 1}
                  onClick={() =>
                    setStages((s) => {
                      const copy = [...s];
                      [copy[index], copy[index + 1]] = [copy[index + 1], copy[index]];
                      return copy;
                    })
                  }
                >
                  Move down
                </Button>
              </div>
            </fieldset>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setStages((s) => [
              ...s,
              {
                id: `stage-${crypto.randomUUID()}`,
                name: "New stage",
                category: "open",
                probability: 0.5,
                archived: false,
              },
            ])
          }
        >
          Add stage
        </Button>
        <SaveActions busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
