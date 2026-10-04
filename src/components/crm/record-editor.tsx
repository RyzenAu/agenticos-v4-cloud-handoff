import { useEffect, useRef, useState, type FormEvent } from "react";
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
import { PRIVATE_TEXT_FIELDS } from "../../../scripts/crm/redact";
import { Button, Notice } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  CrmRequestError,
  crmErrorMessage,
  crmOperation,
  getCrmSnapshot,
  type CrmReceipt,
  type CrmOperationName,
  type CrmOperationInputMap,
} from "@/lib/crm-client";
import { Field, Modal, NativeSelect, SaveActions, ownerOptions } from "./controls";
import {
  companyLabel,
  dateTimeValue,
  localDateTime,
  moneyCents,
  sentence,
  splitLines,
  timeZoneChoices,
} from "./selectors";

export type EditableKind = "company" | "contact" | "deal" | "task" | "project" | "document";
export type EditableRecord = Company | Contact | Deal | Task | Project | Document;
export type EditorTarget = {
  kind: EditableKind;
  record?: EditableRecord;
  companyId?: string;
  dealId?: string;
  projectId?: string;
  documentKind?: Document["kind"];
  /** Open with only this field (a one-field edit such as "Add notes"); the rest of the record is untouched. */
  focus?: "notes";
};
type Fields = Record<string, string>;
const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  owner: "Responsible founder",
  industry: "Industry",
  website: "Website",
  locality: "Locality",
  address: "Address",
  timezone: "Time zone",
  phone: "Phone",
  emails: "Email addresses",
  tags: "Tags",
  notes: "Internal notes",
  status: "Status",
  role: "Role",
  email: "Email",
  service: "Service",
  scope: "Scope",
  stageId: "Sales stage",
  oneOff: "One-off value",
  recurring: "Monthly recurring value",
  expectedClose: "Expected close",
  nextAction: "Next action",
  nextActionDue: "Next action due",
  closeReason: "Won / lost reason",
  description: "Details",
  dueAt: "Due",
  kind: "Type",
  launchAt: "Launch date",
  renewalAt: "Renewal date",
  externalUrl: "Document link",
};
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
    // A pending price has no amount: the boxes stay blank rather than showing 0.
    oneOff:
      target.record && r.commercialBasis !== "pending"
        ? String(Number(r.oneOffCents ?? 0) / 100)
        : "",
    recurring:
      target.record && r.commercialBasis !== "pending"
        ? String(Number(r.recurringCents ?? 0) / 100)
        : "",
    gstTreatment: val("gstTreatment", "exclusive"),
    expectedClose: val("expectedClose").slice(0, 10),
    nextAction: val("nextAction"),
    nextActionDue: localDateTime(val("nextActionDue")),
    closeReason: val("closeReason"),
    commercialBasis: val("commercialBasis", "catalogue"),
    kind: val(
      "kind",
      target.kind === "document"
        ? (target.documentKind ?? "brief")
        : target.projectId
          ? "delivery"
          : "follow-up",
    ),
    description: val("description"),
    dueAt: localDateTime(val("dueAt")),
    dealId: target.dealId ?? val("dealId"),
    projectId: target.projectId ?? val("projectId"),
    contactId: val("contactId"),
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
  onSnapshot,
}: {
  /** Called with the fresh snapshot when Reload latest read it, so the page behind the form is current too. */
  onSnapshot?: (snapshot: CrmSnapshot) => void;
  target: EditorTarget;
  snapshot: CrmSnapshot;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [baseTarget, setBaseTarget] = useState(target);
  target = baseTarget;
  const [originalFields, setOriginalFields] = useState(() => initialFields(baseTarget, snapshot));
  // Set when the server says this record changed elsewhere: the draft is kept, and Reload latest re-bases it.
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [clashes, setClashes] = useState<
    { key: string; label: string; mine: string; theirs: string; choice: "mine" | "theirs" | null }[]
  >([]);
  const conflictNotice = useRef<HTMLDivElement>(null);
  // The notice is at the top of a long form: bring it into view, and move focus there so a keyboard or screen-reader user is told.
  useEffect(() => {
    if (!changedElsewhere) return;
    conflictNotice.current?.scrollIntoView?.({ block: "start" });
    conflictNotice.current?.focus?.();
  }, [changedElsewhere]);
  // Intentionally initialised once. A background refresh must not erase a draft or
  // silently advance the optimistic concurrency revision under the user's cursor.
  const [fields, setFields] = useState(() => initialFields(target, snapshot));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    // Validation messages by the form's field name, shown beside each field; typing in a field clears its message.
    [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (key: string, value: string) => {
    setFieldErrors((previous) => {
      if (!previous[key]) return previous;
      const { [key]: _gone, ...rest } = previous;
      return rest;
    });
    setFields((previous) => ({
      ...previous,
      [key]: value,
      ...(["oneOff", "recurring"].includes(key) && value !== ""
        ? { commercialBasis: "agreed" }
        : {}),
    }));
  };
  // Private free text withheld from an unconfirmed browser: its box is locked so typing can never replace the real text.
  const withheld = !!snapshot.privateTextWithheld;
  const locked = (key: string) =>
    withheld && (PRIVATE_TEXT_FIELDS as readonly string[]).includes(key);
  const CONFIRM_HINT = "Confirm this browser to read and edit this.";
  const text = (
    key: string,
    label: string,
    options: { type?: string; required?: boolean; wide?: boolean; hint?: string } = {},
  ) => (
    <Field
      key={key}
      label={label}
      wide={options.wide}
      hint={locked(key) ? CONFIRM_HINT : options.hint}
      error={fieldErrors[key]}
    >
      <Input
        disabled={locked(key)}
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
    <Field
      key={key}
      label={label}
      wide
      hint={locked(key) ? CONFIRM_HINT : hint}
      error={fieldErrors[key]}
    >
      <Textarea
        disabled={locked(key)}
        rows={3}
        value={fields[key] ?? ""}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  );
  const select = (key: string, label: string, options: { value: string; label: string }[]) => (
    <Field key={key} label={label} error={fieldErrors[key]}>
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
      <NativeSelect
        value={fields.dealId}
        onChange={(e) => {
          set("dealId", e.target.value);
          const project = snapshot.projects.find((p) => p.id === fields.projectId);
          if (project?.dealId && project.dealId !== e.target.value) set("projectId", "");
        }}
      >
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
  const linkedProject = (
    <Field label="Linked project">
      <NativeSelect
        value={fields.projectId}
        onChange={(e) => {
          set("projectId", e.target.value);
          const project = snapshot.projects.find((p) => p.id === e.target.value);
          if (project?.dealId) set("dealId", project.dealId);
        }}
      >
        <option value="">No linked project</option>
        {snapshot.projects
          .filter(
            (p) =>
              p.companyId === fields.companyId &&
              (!fields.dealId || !p.dealId || p.dealId === fields.dealId),
          )
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
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
  /** Re-base on the saved record: fields you edited keep your text; every other field takes the latest saved value. Nothing you typed is dropped. */
  async function reloadLatest() {
    if (!target.record || reloading) return;
    setReloading(true);
    try {
      const fresh = await getCrmSnapshot();
      const table = {
        company: fresh.companies,
        contact: fresh.contacts,
        deal: fresh.deals,
        task: fresh.tasks,
        project: fresh.projects,
        document: fresh.documents,
      }[target.kind] as EditableRecord[];
      const latest = table.find((r) => r.id === target.record!.id);
      if (!latest) {
        setError("This record is no longer in the CRM. Close this form and check the list.");
        return;
      }
      const nextTarget = { ...target, record: latest };
      const latestFields = initialFields(nextTarget, fresh);
      // A field you edited AND the other person changed to something else is a clash: show it, and let the person pick. Nothing is chosen silently.
      const found = Object.keys(fields)
        .filter(
          (key) =>
            fields[key] !== originalFields[key] &&
            latestFields[key] !== originalFields[key] &&
            fields[key] !== latestFields[key],
        )
        .map((key) => ({
          key,
          label: FIELD_LABELS[key] ?? key,
          mine: fields[key],
          theirs: latestFields[key] ?? "",
          choice: null as "mine" | "theirs" | null,
        }));
      setClashes(found);
      setFields((draft) =>
        Object.fromEntries(
          Object.keys(draft).map((key) => [
            key,
            draft[key] !== originalFields[key] ? draft[key] : (latestFields[key] ?? draft[key]),
          ]),
        ),
      );
      setOriginalFields(latestFields);
      onSnapshot?.(fresh);
      setBaseTarget(nextTarget);
      setChangedElsewhere(false);
      setError(null);
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setReloading(false);
    }
  }
  const stages = snapshot.pipelines.find((p) => p.id === fields.pipelineId)?.stages ?? SALES_STAGES;
  const running = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setFieldErrors({});
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
            // Pending holds no amounts: save zero cents whatever the boxes say, so switching to pending never fails validation.
            ...(fields.commercialBasis === "pending"
              ? { oneOffCents: 0, recurringCents: 0 }
              : {
                  ...(fields.oneOff !== "" ? { oneOffCents: moneyCents(fields.oneOff) } : {}),
                  ...(fields.recurring !== ""
                    ? { recurringCents: moneyCents(fields.recurring) }
                    : {}),
                }),
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
            contactId: fields.contactId || null,
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
              artifact: fields.artifact || null,
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
      // Only a stale version is "changed elsewhere". An idempotency conflict (the same retry key with different content) is a plain error.
      if (
        target.record &&
        error instanceof CrmRequestError &&
        error.code !== "idempotency-conflict" &&
        (error.status === 409 || error.code === "conflict")
      ) {
        setChangedElsewhere(true);
        setError(null);
      } else if (
        error instanceof CrmRequestError &&
        error.fieldErrors &&
        Object.keys(error.fieldErrors).length
      ) {
        // Each message goes beside its own field, by that field's name; the form keeps every value.
        const toForm: Record<string, string> = {
          oneOffCents: "oneOff",
          recurringCents: "recurring",
          companyId: "companyId",
        };
        setFieldErrors(
          Object.fromEntries(
            Object.entries(error.fieldErrors).map(([key, message]) => [
              toForm[key] ?? key,
              message,
            ]),
          ),
        );
        setError("Some details need fixing. They are marked below.");
      } else setError(crmErrorMessage(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const noun = target.kind === "company" ? "company" : target.kind;
  const notesOnly = target.focus === "notes" && target.kind === "company" && !!target.record;
  return (
    <Modal
      title={notesOnly ? "Internal notes" : `${target.record ? "Edit" : "Add"} ${noun}`}
      description={
        target.record
          ? "Both founders can see this record."
          : "Saved to the shared CRM. Nothing is sent to anyone."
      }
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-5">
        {changedElsewhere && (
          <div ref={conflictNotice} tabIndex={-1} className="outline-none">
            <Notice tone="warn" title="Changed elsewhere">
              Someone saved this {noun} after you opened it. Your edits are still here. Reload the
              latest to keep them and pick up the rest, then save again.
              <div className="mt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void reloadLatest()}
                  disabled={reloading}
                >
                  {reloading ? "Reloading…" : "Reload latest"}
                </Button>
              </div>
            </Notice>
          </div>
        )}
        {clashes.length > 0 && (
          <Notice tone="warn" title="You both changed these">
            <p className="mb-3">
              Choose which value to keep for each. Nothing is changed until you save.
            </p>
            <ul className="space-y-3">
              {clashes.map((clash) => (
                <li key={clash.key} className="min-w-0">
                  <div className="font-medium">{clash.label}</div>
                  <div className="mt-1 grid gap-2 sm:grid-cols-2">
                    {(["mine", "theirs"] as const).map((side) => (
                      <button
                        key={side}
                        type="button"
                        aria-pressed={clash.choice === side}
                        className={`ds-interactive min-h-11 min-w-0 break-words rounded-lg border px-3 py-2 text-left text-sm ${clash.choice === side ? "border-[var(--brand)] bg-card" : "border-border"}`}
                        onClick={() => {
                          set(clash.key, clash[side]);
                          setClashes((all) =>
                            all.map((c) => (c.key === clash.key ? { ...c, choice: side } : c)),
                          );
                        }}
                      >
                        <span className="block text-xs text-muted-foreground">
                          {side === "mine" ? "Keep mine" : "Use theirs"}
                        </span>
                        {clash[side] || "(empty)"}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {error && (
          <Notice tone="danger" title="Could not save">
            {error}
          </Notice>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          {notesOnly ? (
            area("notes", "Internal notes")
          ) : (
            <>
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
                      set("contactId", "");
                    }}
                  >
                    <option value="">Choose a company</option>
                    {snapshot.companies
                      .filter((c) => !c.mergedInto)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {companyLabel(c)}
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
                  {select("timezone", "Time zone", timeZoneChoices(fields.timezone))}
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
                    { value: "pending", label: "Pricing pending (no approved price yet)" },
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
                          <label
                            key={contact.id}
                            className="flex min-h-11 items-center gap-3 text-sm"
                          >
                            <input
                              className="size-4"
                              type="checkbox"
                              checked={fields.contactIds.split(",").includes(contact.id)}
                              onChange={(e) => {
                                const selected = new Set(
                                  fields.contactIds.split(",").filter(Boolean),
                                );
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
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    Values are in AUD. Winning a deal does not record a payment.
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
                    ].map((value) => ({ value, label: sentence(value) })),
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
                  {linkedProject}
                  <Field label="Linked contact">
                    <NativeSelect
                      value={fields.contactId}
                      onChange={(e) => set("contactId", e.target.value)}
                    >
                      <option value="">No linked contact</option>
                      {snapshot.contacts
                        .filter((c) => c.companyId === fields.companyId)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
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
                    ].map((value) => ({ value, label: sentence(value) })),
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
                      label: sentence(value),
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
                        ].map((value) => ({ value, label: sentence(value) })),
                      )}
                      {linkedDeal}
                      {linkedProject}
                      {text("artifact", "Saved result", {
                        wide: true,
                        hint: "Optional. Paste the reference shown on the saved result.",
                      })}
                      {area(
                        "content",
                        "First version content",
                        "To include the agreed price, use Draft proposal on the deal.",
                      )}
                    </>
                  )}
                  {text("externalUrl", "Existing document link", { type: "url", wide: true })}
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    Saving records the status only. Nothing is sent or signed.
                  </p>
                </>
              )}
            </>
          )}
        </div>
        <SaveActions
          busy={busy}
          onClose={onClose}
          label={target.record ? "Save changes" : `Add ${noun}`}
          disabled={changedElsewhere || clashes.some((c) => !c.choice)}
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
  const running = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (running.current) return;
    running.current = true;
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
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Log an activity"
      description={`Record what happened with ${companyLabel(company)}. No external communication is sent.`}
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
                    {sentence(value)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
        </div>
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
  const [baseDocument] = useState(document);
  document = baseDocument;
  const [content, setContent] = useState(document.versions.at(-1)?.content ?? ""),
    [artifact, setArtifact] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (running.current) return;
    running.current = true;
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
      running.current = false;
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
        <Field label="Saved result" hint="Optional. Paste the reference shown on the saved result.">
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
  const running = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (running.current) return;
    running.current = true;
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
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Configure sales stages"
      description="Existing history is kept. Archive a stage instead of deleting it."
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
