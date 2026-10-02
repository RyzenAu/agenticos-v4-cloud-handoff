/** One typed CRM operation registry for HTTP buttons and Jarvis. A Principal comes from B1, never JSON. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isPrincipal } from "../approvals/principal";
import type { Principal } from "../identity/principal";
import type { CrmStore } from "./store";
import type { Attribution, Company, CrmSnapshot, Deal, DocumentPricing } from "./types";
import { CrmError } from "./types";
import { CrmCsv, CsvError, type CsvKind } from "./csv";
import { CrmAutomations, automationEventSchema, CRM_AUTOMATION_TRIGGERS } from "./automation";
import { crmHref, parseArtifactRef } from "../../src/lib/crm-links";
import { CRM_KINDS, isCrmRef, resolveCrmContext, type CrmRef } from "../../src/lib/crm-ref";
import { splitGst } from "../../src/lib/business-economics";
import { WEBSITE_OFFER, WEBSITE_EX_GST_CENTS } from "../leads/sales-backoffice";
import { receptionistOnHold } from "./policy";

const id = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const short = z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^[^\r\n\0]+$/, "Use a single line"),
  text = z.string().max(10000),
  optionalText = z.string().max(1000).optional();
const owner = z.enum(["usman", "mehroz", ""]);
const cents = z.number().int().min(0).max(100_000_000);
const version = z.number().int().min(1);
const date = z.union([
  z
    .string()
    .datetime({ offset: true })
    .refine(
      (v) =>
        Number.isFinite(Date.parse(v)) &&
        new Date(v.slice(0, 10)).toISOString().slice(0, 10) === v.slice(0, 10),
      "Use a valid date-time and UTC offset",
    ),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
      "Use a valid calendar date",
    ),
]);
const url = z
  .string()
  .max(2048)
  .refine((v) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "Use an http or https URL without credentials");
const email = z
  .string()
  .max(320)
  .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Invalid email address");
const artifact = z
  .string()
  .max(1024)
  .refine((v) => !!parseArtifactRef(v), "Use a saved artifact:jobId[/file] reference");
export const crmRefSchema = z
  .object({ kind: z.enum(CRM_KINDS), id })
  .strict()
  .refine(isCrmRef, "Invalid CRM reference");
const source = z
  .object({
    kind: z.enum(["manual", "csv", "osm", "enquiry"]),
    reference: z.string().max(500),
    attribution: z.string().max(500),
  })
  .strict();
const fieldSources = z.record(z.string().max(60), z.string().max(500));
const companyFields = z
  .object({
    name: short,
    industry: optionalText,
    website: url.optional(),
    locality: optionalText,
    address: optionalText,
    timezone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en-AU", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Use a valid IANA timezone")
      .optional(),
    phone: z.string().max(80).optional(),
    emails: z.array(email).max(100).optional(),
    owner: owner.optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
    source: source.optional(),
    fieldSources: fieldSources.optional(),
    status: z.enum(["prospect", "client", "inactive"]).optional(),
    notes: text.optional(),
    doNotContact: z.boolean().optional(),
    emailAllowed: z.boolean().optional(),
    excluded: z.boolean().optional(),
    excludedReason: optionalText,
    websiteCheck: z
      .enum(["found", "none-verified", "check-failed", "search-unavailable", "not-checked"])
      .optional(),
    websiteCheckedAt: date.nullable().optional(),
  })
  .strict();
const contactFields = z
  .object({
    companyId: id,
    name: short,
    role: optionalText,
    email: email.optional(),
    phone: z.string().max(80).optional(),
    primary: z.boolean().optional(),
    preferences: text.optional(),
    doNotContact: z.boolean().optional(),
    restrictions: z.array(z.string().max(500)).max(100).optional(),
    owner: owner.optional(),
    source: source.optional(),
    fieldSources: fieldSources.optional(),
  })
  .strict();
const dealFields = z
  .object({
    companyId: id,
    title: short,
    owner: owner.optional(),
    contactIds: z.array(id).max(100).optional(),
    service: optionalText,
    scope: text.optional(),
    pipelineId: id.optional(),
    stageId: id.optional(),
    oneOffCents: cents.optional(),
    recurringCents: cents.optional(),
    currency: z.literal("AUD").optional(),
    gstTreatment: z.enum(["inclusive", "exclusive", "not-applicable"]).optional(),
    probability: z.number().min(0).max(1).nullable().optional(),
    expectedClose: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
        "Use a valid calendar date",
      )
      .nullable()
      .optional(),
    nextAction: optionalText,
    nextActionDue: date.nullable().optional(),
    closeReason: optionalText,
    catalogueId: id.nullable().optional(),
    commercialBasis: z.enum(["catalogue", "agreed", "legacy-unconfirmed"]).optional(),
  })
  .strict();
const taskFields = z
  .object({
    companyId: id,
    title: short,
    dealId: id.nullable().optional(),
    projectId: id.nullable().optional(),
    contactId: id.nullable().optional(),
    description: text.optional(),
    kind: z
      .enum(["follow-up", "call", "email", "meeting", "promise", "delivery", "renewal", "other"])
      .optional(),
    status: z.enum(["open", "in-progress", "done", "cancelled"]).optional(),
    owner: owner.optional(),
    dueAt: date.nullable().optional(),
  })
  .strict();
const milestone = z
  .object({
    id,
    name: short,
    status: z.enum(["pending", "in-progress", "done"]),
    dueAt: date.nullable(),
    completedAt: date.nullable(),
    note: text,
  })
  .strict();
const projectFields = z
  .object({
    companyId: id,
    name: short,
    dealId: id.nullable().optional(),
    owner: owner.optional(),
    status: z
      .enum(["onboarding", "in-progress", "review", "launched", "ongoing", "on-hold", "completed"])
      .optional(),
    scope: text.optional(),
    contentRequests: z.array(text).max(100).optional(),
    accessRequests: z.array(text).max(100).optional(),
    milestones: z.array(milestone).max(100).optional(),
    previewUrls: z.array(url).max(100).optional(),
    revisionRequests: z.array(text).max(100).optional(),
    deliverables: z.array(text).max(100).optional(),
    launchAt: date.nullable().optional(),
    renewalAt: date.nullable().optional(),
  })
  .strict();
const documentFields = z
  .object({
    companyId: id,
    title: short,
    dealId: id.nullable().optional(),
    projectId: id.nullable().optional(),
    kind: z
      .enum(["proposal", "agreement", "invoice-reference", "brief", "deliverable", "other"])
      .optional(),
    status: z.enum(["draft", "issued", "accepted", "superseded"]).optional(),
    externalUrl: url.nullable().optional(),
    content: z.string().max(100000).optional(),
    artifact: artifact.nullable().optional(),
  })
  .strict();
const stage = z
  .object({
    id,
    name: short,
    category: z.enum(["open", "won", "lost"]),
    probability: z.number().min(0).max(1),
    archived: z.boolean(),
  })
  .strict();
const filters = z
  .object({
    search: z.string().max(500).optional(),
    owner: owner.optional(),
    companyId: id.optional(),
    stageId: id.optional(),
    status: z.string().max(40).optional(),
    tag: z.string().max(80).optional(),
    restriction: z.enum(["restricted", "contactable"]).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();
const empty = z.object({}).strict();
const change = (patch: z.ZodTypeAny) => z.object({ id, expectedVersion: version, patch }).strict();
const target = z
  .object({
    ref: crmRefSchema.optional(),
    context: z
      .object({
        crm: crmRefSchema.nullable().optional(),
        candidates: z.array(crmRefSchema).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CrmReceipt<T = unknown> = {
  ok: boolean;
  href: string;
  text: string;
  data?: T;
  code?: string;
  activityId?: string;
};
export type CrmOperation<I = unknown> = {
  name: string;
  summary: string;
  input: z.ZodType<I>;
  run(input: I, principal: Principal): CrmReceipt;
};
export type CrmOperationsOptions = {
  store: CrmStore;
  csv?: CrmCsv;
  automations?: CrmAutomations;
  now?: () => string;
  verifyCommunicationEvidence?: (
    evidence: {
      provider: string;
      eventId: string;
      observedAt: string;
      state: "sent" | "received" | "failed";
    },
    principal: Principal,
    ref: CrmRef,
  ) => boolean;
  verifyAgent?: (
    by: { agent: string; jobId: string },
    principal: Principal,
    ref: CrmRef,
  ) => boolean;
};
export type SavedCrmView = {
  id: string;
  name: string;
  kind: CsvKind;
  filters: z.infer<typeof filters>;
  version: number;
  updatedBy: string;
};
class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function attribution(principal: Principal): Attribution {
  if (!isPrincipal(principal))
    throw new OperationError("unauthorised", "A verified founder session is required.");
  return { personId: principal.personId };
}
function needed<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new OperationError("not-found", `${what} was not found.`);
  return value;
}
function receipt(
  data: unknown,
  ref: CrmRef,
  text: string,
  tab: "overview" | "timeline" | "deals" | "delivery" = "overview",
): CrmReceipt {
  return { ok: true, href: crmHref(ref, tab), text, data };
}
export function createCrmOperations(options: CrmOperationsOptions) {
  const store = options.store,
    csv = options.csv ?? new CrmCsv(store),
    now = options.now ?? (() => new Date().toISOString());
  const operations = new Map<string, CrmOperation<any>>();
  const register = <S extends z.ZodTypeAny>(
    name: string,
    summary: string,
    input: S,
    execute: (input: z.infer<S>, principal: Principal) => CrmReceipt,
  ) => {
    const op: CrmOperation<z.infer<S>> = {
      name,
      summary,
      input,
      run(raw, principal) {
        try {
          attribution(principal);
          const value = input.parse(raw);
          return execute(value, principal);
        } catch (error) {
          if (error instanceof z.ZodError)
            return {
              ok: false,
              href: "/crm",
              text: error.issues
                .map((e) => `${e.path.join(".") || "input"}: ${e.message}`)
                .join("; "),
              code: "validation",
            };
          if (
            error instanceof OperationError ||
            error instanceof CrmError ||
            error instanceof CsvError
          )
            return {
              ok: false,
              href: "/crm",
              text: error.message,
              code: error instanceof CsvError ? "validation" : error.code,
            };
          return {
            ok: false,
            href: "/crm",
            text: "CRM could not confirm this operation. Refresh the record before retrying.",
            code: "unavailable",
          };
        }
      },
    };
    operations.set(name, op);
    return op;
  };
  const alias = (from: string, to: string) => {
    const op = operations.get(from)!;
    operations.set(to, { ...op, name: to });
  };
  const dealReceipt = (deal: Deal, principal: Principal, message: string): CrmReceipt => {
    const pipeline = store.snapshot().pipelines.find((item) => item.id === deal.pipelineId);
    const wonIds = new Set(
      pipeline?.stages.filter((item) => item.category === "won").map((item) => item.id) ?? [],
    );
    if (wonIds.has(deal.stageId)) {
      const entry = deal.stageHistory.find((item) => wonIds.has(item.stageId));
      if (options.automations) {
        try {
          const result = options.automations.accept(
            {
              eventId: `crm:deal:${deal.id}:won:${entry?.at ?? deal.createdAt}`,
              trigger: "deal.won",
              ref: { kind: "deal", id: deal.id },
              at: entry?.at ?? deal.createdAt,
              payload: {},
            },
            principal,
          );
          message += result.ok ? ` ${result.text}` : ` Onboarding needs attention: ${result.text}`;
        } catch (error) {
          message += ` Onboarding needs attention: ${error instanceof CrmError || error instanceof OperationError ? error.message : "check the automation rule and durable Jobs service"}`;
        }
      } else message += " Onboarding is waiting for the existing durable Jobs service connection.";
    }
    return receipt(deal, { kind: "deal", id: deal.id }, message, "deals");
  };
  register("crm.snapshot", "Read the shared business workspace", empty, () => ({
    ok: true,
    href: "/crm",
    text: "Shared CRM loaded.",
    data: store.snapshot(),
  }));
  register("crm.record.get", "Open the explicit or unambiguous active record", target, (input) => {
    const resolved = resolveCrmContext(input);
    if (!resolved.ok) throw new OperationError("ambiguous", resolved.ask);
    let ref = resolved.ref;
    if (ref.kind === "lead") ref = store.resolveLegacyLead(ref.id) ?? ref;
    const record =
      ref.kind === "company"
        ? store.getCompany(ref.id)
        : ref.kind === "contact"
          ? store.getContact(ref.id)
          : ref.kind === "deal"
            ? store.getDeal(ref.id)
            : ref.kind === "project"
              ? store.getProject(ref.id)
              : ref.kind === "document"
                ? store.getDocument(ref.id)
                : null;
    return receipt(needed(record, "Record"), ref, "Record opened.");
  });
  const query = (kind: CsvKind) =>
    register(`crm.${kind}.query`, `Find ${kind} in the shared CRM`, filters, (f) => {
      const snapshot = store.snapshot();
      const rows = snapshot[kind].filter((row) => {
        if ("mergedInto" in row && row.mergedInto) return false;
        if (f.owner !== undefined && "owner" in row && row.owner !== f.owner) return false;
        if (f.companyId && ("companyId" in row ? row.companyId : row.id) !== f.companyId)
          return false;
        if (f.stageId && (!("stageId" in row) || row.stageId !== f.stageId)) return false;
        if (f.status && (!("status" in row) || row.status !== f.status)) return false;
        if (f.tag && (!("tags" in row) || !row.tags.includes(f.tag))) return false;
        const company =
          "companyId" in row ? snapshot.companies.find((c) => c.id === row.companyId) : null;
        const restricted =
          !!company?.doNotContact ||
          !!company?.excluded ||
          ("doNotContact" in row && row.doNotContact) ||
          ("excluded" in row && row.excluded) ||
          ("restrictions" in row && row.restrictions.length > 0);
        if (
          (f.restriction === "restricted" && !restricted) ||
          (f.restriction === "contactable" && restricted)
        )
          return false;
        return matchesCrmSearch(row, f.search ?? "");
      });
      return {
        ok: true,
        href: `/crm?view=${kind === "deals" ? "pipeline" : kind}`,
        text: `${rows.length} ${kind} found.`,
        data: {
          total: rows.length,
          items: rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 200)),
        },
      };
    });
  for (const kind of ["companies", "contacts", "deals"] as const) query(kind);
  register(
    "crm.company.create",
    "Create a company without a directory identifier",
    companyFields,
    (v, p) => {
      const c = store.createCompany(v, attribution(p));
      return receipt(c, { kind: "company", id: c.id }, "Company saved.");
    },
  );
  register(
    "crm.company.update",
    "Update a company using its current version",
    change(companyFields.partial()),
    (v, p) => {
      const c = store.updateCompany(v.id, v.patch, v.expectedVersion, attribution(p));
      return receipt(c, { kind: "company", id: c.id }, "Company changes saved.");
    },
  );
  register("crm.contact.add", "Add another contact to a company", contactFields, (v, p) => {
    const c = store.createContact(v, attribution(p));
    return receipt(c, { kind: "company", id: c.companyId }, "Contact saved.");
  });
  alias("crm.contact.add", "crm.contact.create");
  register(
    "crm.contact.update",
    "Update a contact and their preferences",
    change(contactFields.omit({ companyId: true }).partial()),
    (v, p) => {
      const c = store.updateContact(v.id, v.patch, v.expectedVersion, attribution(p));
      return receipt(c, { kind: "company", id: c.companyId }, "Contact changes saved.");
    },
  );
  register("crm.deal.create", "Create another opportunity for a company", dealFields, (v, p) => {
    const d = store.createDeal(v, attribution(p));
    return dealReceipt(d, p, "Deal saved.");
  });
  register(
    "crm.deal.update",
    "Update a deal's scope, stage and agreed value",
    change(dealFields.omit({ companyId: true }).partial()),
    (v, p) => {
      const d = store.updateDeal(v.id, v.patch, v.expectedVersion, attribution(p));
      return dealReceipt(d, p, "Deal changes saved.");
    },
  );
  register(
    "crm.deal.move",
    "Move a deal and retain its stage history",
    z
      .object({
        id,
        stageId: id,
        expectedVersion: version,
        reason: z.string().max(1000).optional(),
      })
      .strict(),
    (v, p) => {
      const d = store.updateDeal(
        v.id,
        { stageId: v.stageId, ...(v.reason !== undefined ? { closeReason: v.reason } : {}) },
        v.expectedVersion,
        attribution(p),
      );
      return dealReceipt(d, p, "Deal stage saved. Won business is not a payment receipt.");
    },
  );
  register("crm.task.create", "Save a follow-up, promise or delivery task", taskFields, (v, p) => {
    const t = store.createTask(v, attribution(p));
    return receipt(t, { kind: "company", id: t.companyId }, "Task saved.");
  });
  alias("crm.task.create", "crm.task.add");
  register(
    "crm.task.update",
    "Edit a task using its current version",
    change(taskFields.omit({ companyId: true }).partial()),
    (v, p) => {
      const t = store.updateTask(v.id, v.patch, v.expectedVersion, attribution(p));
      return receipt(t, { kind: "company", id: t.companyId }, "Task changes saved.");
    },
  );
  for (const [name, status] of [
    ["complete", "done"],
    ["reopen", "open"],
  ] as const)
    register(
      `crm.task.${name}`,
      `${name === "complete" ? "Complete" : "Reopen"} a task`,
      z.object({ id, expectedVersion: version }).strict(),
      (v, p) => {
        const t = store.updateTask(v.id, { status }, v.expectedVersion, attribution(p));
        return receipt(
          t,
          { kind: "company", id: t.companyId },
          status === "done" ? "Task completed." : "Task reopened.",
        );
      },
    );
  register(
    "crm.task.assign",
    "Assign responsibility to either founder",
    z.object({ id, expectedVersion: version, owner }).strict(),
    (v, p) => {
      const t = store.updateTask(v.id, { owner: v.owner }, v.expectedVersion, attribution(p));
      return receipt(
        t,
        { kind: "company", id: t.companyId },
        "Task assignment saved. Both founders retain access.",
      );
    },
  );
  register(
    "crm.followups.overdue",
    "Show overdue open follow-ups",
    z.object({ owner: owner.optional(), mine: z.boolean().optional() }).strict(),
    (v, p) => {
      const tasks = store
        .snapshot()
        .tasks.filter(
          (t) =>
            !["done", "cancelled"].includes(t.status) &&
            !!t.dueAt &&
            Date.parse(t.dueAt) < Date.parse(now()) &&
            (!v.mine || t.owner === p.personId) &&
            (v.owner === undefined || t.owner === v.owner),
        )
        .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
      return {
        ok: true,
        href: "/crm?view=today",
        text: `${tasks.length} overdue tasks.`,
        data: tasks,
      };
    },
  );
  register("crm.promises.list", "Show everything promised to a client", target, (v) => {
    const r = resolveCrmContext(v);
    if (!r.ok) throw new OperationError("ambiguous", r.ask);
    const company = companyFor(store, r.ref);
    const s = store.snapshot();
    return receipt(
      {
        tasks: s.tasks.filter((t) => t.companyId === company.id && t.kind === "promise"),
        activities: s.activities.filter((a) => a.companyId === company.id && a.kind === "promise"),
      },
      { kind: "company", id: company.id },
      "Client promises loaded.",
      "timeline",
    );
  });
  register(
    "crm.activity.add",
    "Add an idempotent activity or saved agent result",
    z
      .object({
        ref: crmRefSchema,
        eventId: short,
        kind: short,
        title: short,
        note: text.optional(),
        detail: text.optional(),
        at: date.optional(),
        outcome: optionalText,
        artifact: artifact.nullable().optional(),
        externalUrl: url.nullable().optional(),
        communicationState: z
          .enum(["drafted", "queued", "sent", "received", "failed", "unknown"])
          .nullable()
          .optional(),
        providerEvidence: z
          .object({
            provider: short,
            eventId: short,
            observedAt: date,
            state: z.enum(["sent", "received", "failed"]),
          })
          .strict()
          .optional(),
        by: z
          .union([
            z.object({ personId: z.enum(["usman", "mehroz"]) }).strict(),
            z.object({ agent: short, jobId: id }).strict(),
          ])
          .optional(),
      })
      .strict(),
    (v, p) => {
      let by = attribution(p);
      if (v.by && "personId" in v.by && v.by.personId !== p.personId)
        throw new OperationError(
          "restricted",
          "Activity attribution must match the verified founder.",
        );
      if (v.by && "agent" in v.by) {
        if (!options.verifyAgent?.(v.by, p, v.ref))
          throw new OperationError(
            "restricted",
            "The linked agent job must be verified by the Jobs service before adding its attribution.",
          );
        if (v.artifact && parseArtifactRef(v.artifact)?.jobId !== v.by.jobId)
          throw new OperationError(
            "restricted",
            "An agent result must link an artifact from its verified job.",
          );
        by = v.by;
      }
      if (
        (v.communicationState === "sent" || v.communicationState === "received") &&
        (!v.providerEvidence ||
          v.providerEvidence.state !== v.communicationState ||
          !options.verifyCommunicationEvidence?.(v.providerEvidence, p, v.ref))
      )
        throw new OperationError(
          "restricted",
          "A verified provider event is required for Sent or Received. Use Unknown for an unverified communication.",
        );
      const { by: _by, providerEvidence: _evidence, detail, ...fields } = v;
      const activity = store.addActivity(
        {
          ...fields,
          note: v.note ?? detail ?? "",
          ...(_evidence ? { providerEvidence: _evidence } : {}),
        },
        by,
      );
      // Store adapters may return the activity itself or an idempotency wrapper; the store contract is the activity.
      return {
        ...receipt(activity, v.ref, "Activity saved.", "timeline"),
        activityId: activity.id,
      };
    },
  );
  register("crm.project.create", "Create a linked delivery project", projectFields, (v, p) => {
    const project = store.createProject(v, attribution(p));
    return receipt(
      project,
      { kind: "project", id: project.id },
      "Delivery project saved.",
      "delivery",
    );
  });
  register(
    "crm.project.update",
    "Update delivery, milestones and renewal dates",
    change(projectFields.omit({ companyId: true }).partial()),
    (v, p) => {
      const project = store.updateProject(v.id, v.patch, v.expectedVersion, attribution(p));
      return receipt(
        project,
        { kind: "project", id: project.id },
        "Delivery changes saved.",
        "delivery",
      );
    },
  );
  register(
    "crm.document.create",
    "Save an internal document or existing Finance reference",
    documentFields,
    (v, p) => {
      const document = store.createDocument(v, attribution(p));
      return receipt(
        document,
        { kind: "document", id: document.id },
        "Document saved. No document was sent or signed.",
      );
    },
  );
  register(
    "crm.document.update",
    "Record a document's internal status",
    change(
      z
        .object({
          title: short.optional(),
          status: z.enum(["draft", "issued", "accepted", "superseded"]).optional(),
          externalUrl: url.nullable().optional(),
        })
        .strict(),
    ),
    (v, p) => {
      const document = store.updateDocument(v.id, v.patch, v.expectedVersion, attribution(p));
      return receipt(
        document,
        { kind: "document", id: document.id },
        "Document status saved. No document was sent or signed.",
      );
    },
  );
  register(
    "crm.document.version.add",
    "Save another immutable document version",
    z
      .object({
        id,
        expectedVersion: version,
        content: z.string().max(100000).optional(),
        artifact: artifact.nullable().optional(),
      })
      .strict(),
    (v, p) => {
      const document = store.addDocumentVersion(
        v.id,
        { content: v.content, artifact: v.artifact },
        v.expectedVersion,
        attribution(p),
      );
      return receipt(
        document,
        { kind: "document", id: document.id },
        "New document version saved.",
      );
    },
  );
  register(
    "crm.proposal.draft",
    "Draft a versioned proposal from the agreed AUD price",
    z
      .object({
        dealId: id,
        expectedVersion: version,
        title: short.optional(),
        documentId: id.optional(),
        expectedDocumentVersion: version.optional(),
      })
      .strict(),
    (v, p) =>
      store.transaction(() => {
        const deal = needed(store.getDeal(v.dealId), "Deal");
        if (deal.version !== v.expectedVersion)
          throw new OperationError(
            "conflict",
            "The deal changed. Refresh and review its price before drafting.",
          );
        const company = needed(store.getCompany(deal.companyId), "Company");
        const pricing = proposalPricing(deal);
        const content = proposalContent(company, deal, pricing);
        let document;
        if (v.documentId) {
          const current = needed(store.getDocument(v.documentId), "Document");
          if (current.dealId !== deal.id || current.kind !== "proposal")
            throw new OperationError("validation", "Choose a proposal belonging to this deal.");
          if (v.expectedDocumentVersion === undefined)
            throw new OperationError("validation", "The proposal's current version is required.");
          document = store.addDocumentVersion(
            current.id,
            { content, pricing },
            v.expectedDocumentVersion,
            attribution(p),
          );
        } else
          document = store.createDocument(
            {
              companyId: company.id,
              dealId: deal.id,
              title: v.title ?? `Proposal — ${deal.title}`,
              kind: "proposal",
              status: "draft",
              content,
              pricing,
            },
            attribution(p),
          );
        return receipt(
          document,
          { kind: "document", id: document.id },
          "Proposal draft saved using the deal's agreed price. No invoice or payment request was created.",
        );
      }),
  );
  register(
    "crm.pipeline.update",
    "Edit sales stages while retaining historical stage names",
    z
      .object({
        id,
        expectedVersion: version,
        patch: z.object({ name: short, stages: z.array(stage).min(3).max(50) }).strict(),
      })
      .strict(),
    (v, p) => {
      const pipeline = store.savePipeline(
        { id: v.id, ...v.patch },
        v.expectedVersion,
        attribution(p),
      );
      return {
        ok: true,
        href: "/crm?view=pipeline",
        text: "Pipeline configuration saved.",
        data: pipeline,
      };
    },
  );
  register(
    "crm.pipeline.create",
    "Create a sales pipeline",
    z.object({ id: id.optional(), name: short, stages: z.array(stage).min(3).max(50) }).strict(),
    (v, p) => {
      const pipeline = store.savePipeline(
        { ...v, id: v.id ?? `pipeline-${randomUUID()}` },
        0,
        attribution(p),
      );
      return { ok: true, href: "/crm?view=pipeline", text: "Pipeline created.", data: pipeline };
    },
  );
  register(
    "crm.csv.preview",
    "Validate CSV rows and review duplicate candidates",
    z
      .object({
        csv: z.string().max(2 * 1024 * 1024),
        kind: z.enum(["companies", "contacts", "deals"]).optional(),
      })
      .strict(),
    (v) => ({
      ok: true,
      href: "/crm?view=companies",
      text: "CSV preview ready. No business records changed.",
      data: csv.preview(v.csv, v.kind),
    }),
  );
  register(
    "crm.csv.commit",
    "Atomically commit the reviewed CSV decisions",
    z
      .object({
        previewId: id,
        resolutions: z
          .array(
            z
              .object({
                row: z.number().int().min(2),
                action: z.enum(["create", "skip", "update"]),
                recordId: id.optional(),
                companyId: id.optional(),
                expectedVersion: version.optional(),
              })
              .strict(),
          )
          .max(5000)
          .default([]),
      })
      .strict(),
    (v, p) => {
      const result = csv.commit(v.previewId, v.resolutions, attribution(p));
      return {
        ok: true,
        href: "/crm?view=companies",
        text: result.duplicate
          ? "This import was already committed; no records duplicated."
          : `${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
        data: result,
      };
    },
  );
  register(
    "crm.csv.export",
    "Export spreadsheet-safe CRM data",
    z.object({ kind: z.enum(["companies", "contacts", "deals"]) }).strict(),
    (v) => ({
      ok: true,
      href: `/crm?view=${v.kind === "deals" ? "pipeline" : v.kind}`,
      text: "CSV export prepared.",
      data: csv.export(v.kind),
    }),
  );
  register("crm.views.list", "List saved shared CRM views", empty, () => ({
    ok: true,
    href: "/crm",
    text: "Saved views loaded.",
    data: store.getSetting<SavedCrmView[]>("crm.savedViews", []),
  }));
  register(
    "crm.views.save",
    "Save a shared CRM filter view",
    z
      .object({
        id: id.optional(),
        name: short,
        kind: z.enum(["companies", "contacts", "deals"]),
        filters,
        expectedVersion: version.optional(),
      })
      .strict(),
    (v, p) =>
      store.transaction(() => {
        const views = store.getSetting<SavedCrmView[]>("crm.savedViews", []),
          old = v.id ? views.find((view) => view.id === v.id) : null;
        if (v.id && !old) throw new OperationError("not-found", "Saved view not found.");
        if (old && v.expectedVersion !== old.version)
          throw new OperationError("conflict", "The saved view changed. Refresh first.");
        const view: SavedCrmView = {
          id: old?.id ?? randomUUID(),
          name: v.name,
          kind: v.kind,
          filters: v.filters,
          version: (old?.version ?? 0) + 1,
          updatedBy: p.personId,
        };
        store.setSetting("crm.savedViews", [...views.filter((item) => item.id !== view.id), view]);
        return {
          ok: true,
          href: `/crm?view=${v.kind === "deals" ? "pipeline" : v.kind}`,
          text: "Shared view saved.",
          data: view,
        };
      }),
  );
  register(
    "crm.duplicates.list",
    "Review possible company duplicates without guessing",
    empty,
    () => ({
      ok: true,
      href: "/crm?view=companies",
      text: "Duplicate candidates loaded. No records were merged.",
      data: duplicateCompanies(store.snapshot()),
    }),
  );
  register(
    "crm.duplicates.merge",
    "Merge reviewed duplicate companies and preserve their history",
    z
      .object({
        keepId: id,
        mergeId: id,
        expectedKeepVersion: version,
        expectedMergeVersion: version,
      })
      .strict(),
    (v, p) => {
      const result = store.mergeCompanies(
        v.keepId,
        v.mergeId,
        v.expectedKeepVersion,
        v.expectedMergeVersion,
        attribution(p),
      );
      return receipt(
        result,
        { kind: "company", id: v.keepId },
        "Companies merged; source records and history retained.",
      );
    },
  );
  register(
    "crm.automations.list",
    "Inspect event rules, outcomes and connection requirements",
    empty,
    () => {
      if (!options.automations)
        return {
          ok: true,
          href: "/crm?view=today",
          text: "CRM automation adapter is not connected to the durable Jobs service.",
          data: [],
        };
      return {
        ok: true,
        href: "/crm?view=today",
        text: "Automation rules loaded.",
        data: options.automations.list(),
      };
    },
  );
  register(
    "crm.automations.configure",
    "Enable or pause a CRM event rule",
    z.object({ id: z.enum(CRM_AUTOMATION_TRIGGERS), enabled: z.boolean() }).strict(),
    (v) => {
      if (!options.automations)
        throw new OperationError(
          "unavailable",
          "Connect the existing durable Jobs service to configure CRM automations.",
        );
      return {
        ok: true,
        href: "/crm?view=today",
        text: "Automation setting saved.",
        data: options.automations.setEnabled(v.id, v.enabled),
      };
    },
  );
  // Provider/source adapters call CrmAutomations.accept directly after verifying the source. Browser JSON
  // and Jarvis cannot manufacture enquiry/reply evidence merely by invoking an operation name.
  return {
    list: () => [...operations.values()],
    get: (name: string) => operations.get(name),
    run: (name: string, input: unknown, principal: Principal): CrmReceipt =>
      operations.get(name)?.run(input, principal) ?? {
        ok: false,
        href: "/crm",
        text: "Unknown CRM operation.",
        code: "not-found",
      },
  };
}
export type CrmOperations = ReturnType<typeof createCrmOperations>;
function companyFor(store: CrmStore, ref: CrmRef): Company {
  if (ref.kind === "lead") {
    const mapped = store.resolveLegacyLead(ref.id);
    if (!mapped || mapped.kind === "lead")
      throw new OperationError("not-found", "Legacy lead has not been migrated.");
    return companyFor(store, mapped);
  }
  if (ref.kind === "company") return needed(store.getCompany(ref.id), "Company");
  const record =
    ref.kind === "contact"
      ? store.getContact(ref.id)
      : ref.kind === "deal"
        ? store.getDeal(ref.id)
        : ref.kind === "project"
          ? store.getProject(ref.id)
          : store.getDocument(ref.id);
  return needed(store.getCompany(needed(record, "Record").companyId), "Company");
}
/** Pricing is a snapshot of the reviewed deal; catalogue defaults never silently replace an agreement. */
export function proposalPricing(deal: Deal): DocumentPricing {
  if (receptionistOnHold(deal))
    throw new OperationError("restricted", "Receptionist development and billing remain on hold.");
  if (deal.commercialBasis === "legacy-unconfirmed")
    throw new OperationError(
      "validation",
      "Confirm this deal's agreed price before drafting a proposal.",
    );
  if (deal.commercialBasis === "catalogue") {
    if (deal.catalogueId !== "website")
      throw new OperationError(
        "validation",
        "Choose the existing approved website catalogue item or confirm an agreed deal price.",
      );
    const oneOff =
      deal.gstTreatment === "inclusive" ? WEBSITE_OFFER.priceCents : WEBSITE_EX_GST_CENTS;
    const recurring =
      deal.gstTreatment === "inclusive"
        ? WEBSITE_OFFER.carePlanMonthlyCents
        : splitGst(WEBSITE_OFFER.carePlanMonthlyCents, "inclusive").netCents;
    if (
      deal.gstTreatment === "not-applicable" ||
      deal.oneOffCents !== oneOff ||
      ![0, recurring].includes(deal.recurringCents)
    )
      throw new OperationError(
        "validation",
        "Deal values differ from the approved catalogue. Confirm them as an agreed price; catalogue prices were not changed.",
      );
  }
  return {
    oneOffCents: deal.oneOffCents,
    recurringCents: deal.recurringCents,
    currency: "AUD",
    gstTreatment: deal.gstTreatment,
    catalogueId: deal.catalogueId,
    dealVersion: deal.version,
  };
}
export function proposalContent(company: Company, deal: Deal, pricing: DocumentPricing): string {
  const money = (c: number) =>
    new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(c / 100);
  const value = (c: number) => {
    const s = splitGst(
      c,
      pricing.gstTreatment === "not-applicable" ? "none" : pricing.gstTreatment,
    );
    return `${money(s.netCents)} ex GST + ${money(s.gstCents)} GST = ${money(s.grossCents)} total`;
  };
  return `DRAFT — FOR FOUNDER REVIEW\n# Proposal — ${deal.title}\nPrepared for ${company.name}\nM&U Ventures · AUD\n\n## Agreed scope\n${deal.scope || "Scope must be confirmed before issue."}\n\n## Agreed price\nOne-off: ${value(pricing.oneOffCents)}\nRecurring per month: ${value(pricing.recurringCents)}\nPrice basis: ${deal.commercialBasis}; deal version ${deal.version}${pricing.catalogueId ? `; catalogue reference ${pricing.catalogueId}` : ""}.\nGST treatment: ${pricing.gstTreatment}.\n\nPayment dates, deposits, hosting, content responsibilities, milestones and acceptance terms: confirm in the existing agreement. This draft does not change catalogue prices, setup fees or pilot terms.\n\nNo payment is requested by this draft. Won status does not confirm an invoice or money received. Existing Finance is the source for invoices and payment status.\nNo document has been issued, signed or accepted through this operation.\n`;
}
export function duplicateCompanies(
  snapshot: CrmSnapshot,
): { a: Company; b: Company; reasons: string[] }[] {
  const companies = snapshot.companies.filter((c) => !c.mergedInto),
    result: { a: Company; b: Company; reasons: string[] }[] = [];
  const norm = (s: string) => s.trim().toLocaleLowerCase("en-AU").replace(/\s+/g, " ");
  const phone = (s: string) => s.replace(/\D/g, "").replace(/^61/, "0");
  for (let i = 0; i < companies.length; i++)
    for (let j = i + 1; j < companies.length; j++) {
      const a = companies[i],
        b = companies[j],
        reasons: string[] = [];
      if (a.phone && b.phone && phone(a.phone) === phone(b.phone)) reasons.push("same phone");
      if (a.emails.some((e) => b.emails.some((other) => norm(e) === norm(other))))
        reasons.push("same email");
      if (norm(a.name) === norm(b.name) && norm(a.locality) === norm(b.locality))
        reasons.push("same name and locality");
      if (reasons.length) result.push({ a, b, reasons });
    }
  return result;
}

/** Type-only imports of this map are browser-safe; the server registry remains the validator. */
export type CrmOperationInputMap = {
  "crm.snapshot": Record<string, never>;
  "crm.record.get": z.input<typeof target>;
  "crm.companies.query": z.input<typeof filters>;
  "crm.contacts.query": z.input<typeof filters>;
  "crm.deals.query": z.input<typeof filters>;
  "crm.company.create": z.input<typeof companyFields>;
  "crm.company.update": {
    id: string;
    expectedVersion: number;
    patch: Partial<z.input<typeof companyFields>>;
  };
  "crm.contact.add": z.input<typeof contactFields>;
  "crm.contact.create": z.input<typeof contactFields>;
  "crm.contact.update": {
    id: string;
    expectedVersion: number;
    patch: Partial<Omit<z.input<typeof contactFields>, "companyId">>;
  };
  "crm.deal.create": z.input<typeof dealFields>;
  "crm.deal.update": {
    id: string;
    expectedVersion: number;
    patch: Partial<Omit<z.input<typeof dealFields>, "companyId">>;
  };
  "crm.deal.move": { id: string; expectedVersion: number; stageId: string; reason?: string };
  "crm.task.create": z.input<typeof taskFields>;
  "crm.task.add": z.input<typeof taskFields>;
  "crm.task.update": {
    id: string;
    expectedVersion: number;
    patch: Partial<Omit<z.input<typeof taskFields>, "companyId">>;
  };
  "crm.task.complete": { id: string; expectedVersion: number };
  "crm.task.reopen": { id: string; expectedVersion: number };
  "crm.task.assign": { id: string; expectedVersion: number; owner: z.input<typeof owner> };
  "crm.followups.overdue": { owner?: z.input<typeof owner>; mine?: boolean };
  "crm.promises.list": z.input<typeof target>;
  "crm.activity.add": {
    ref: CrmRef;
    eventId: string;
    kind: string;
    title: string;
    note?: string;
    detail?: string;
    at?: string;
    outcome?: string;
    artifact?: string | null;
    externalUrl?: string | null;
    communicationState?: "drafted" | "queued" | "sent" | "received" | "failed" | "unknown" | null;
    providerEvidence?: {
      provider: string;
      eventId: string;
      observedAt: string;
      state: "sent" | "received" | "failed";
    };
    by?: Attribution;
  };
  "crm.project.create": z.input<typeof projectFields>;
  "crm.project.update": {
    id: string;
    expectedVersion: number;
    patch: Partial<Omit<z.input<typeof projectFields>, "companyId">>;
  };
  "crm.document.create": z.input<typeof documentFields>;
  "crm.document.update": {
    id: string;
    expectedVersion: number;
    patch: {
      title?: string;
      status?: "draft" | "issued" | "accepted" | "superseded";
      externalUrl?: string | null;
    };
  };
  "crm.document.version.add": {
    id: string;
    expectedVersion: number;
    content?: string;
    artifact?: string | null;
  };
  "crm.proposal.draft": {
    dealId: string;
    expectedVersion: number;
    title?: string;
    documentId?: string;
    expectedDocumentVersion?: number;
  };
  "crm.pipeline.update": {
    id: string;
    expectedVersion: number;
    patch: { name: string; stages: z.input<typeof stage>[] };
  };
  "crm.pipeline.create": { id?: string; name: string; stages: z.input<typeof stage>[] };
  "crm.csv.preview": { csv: string; kind?: CsvKind };
  "crm.csv.commit": { previewId: string; resolutions?: import("./csv").CsvResolution[] };
  "crm.csv.export": { kind: CsvKind };
  "crm.views.list": Record<string, never>;
  "crm.views.save": {
    id?: string;
    name: string;
    kind: CsvKind;
    filters: z.input<typeof filters>;
    expectedVersion?: number;
  };
  "crm.duplicates.list": Record<string, never>;
  "crm.duplicates.merge": {
    keepId: string;
    mergeId: string;
    expectedKeepVersion: number;
    expectedMergeVersion: number;
  };
  "crm.automations.list": Record<string, never>;
  "crm.automations.configure": { id: (typeof CRM_AUTOMATION_TRIGGERS)[number]; enabled: boolean };
};
export function matchesCrmSearch(
  row:
    | CrmSnapshot["companies"][number]
    | CrmSnapshot["contacts"][number]
    | CrmSnapshot["deals"][number],
  search: string,
): boolean {
  const query = search.trim();
  if (!query) return true;
  const exact = /^#([A-Za-z0-9._-]+)$/.exec(query);
  if (exact)
    return (
      row.id === exact[1] ||
      ("legacyLeadId" in row && row.legacyLeadId !== null && String(row.legacyLeadId) === exact[1])
    );
  const normal = (s: string) =>
    s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-AU");
  const phone = (s: string) => s.replace(/\D/g, "").replace(/^61/, "0");
  if (/^[+()\d\s-]+$/.test(query) && phone(query).length >= 5 && "phone" in row)
    return phone(row.phone).includes(phone(query));
  const hay = normal(
    [
      row.id,
      ...Object.entries(row)
        .filter(
          ([key, value]) => typeof value === "string" && !["createdAt", "updatedAt"].includes(key),
        )
        .map(([, value]) => String(value)),
      ...("emails" in row ? row.emails : []),
      ...("tags" in row ? row.tags : []),
    ].join(" "),
  );
  return normal(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}
