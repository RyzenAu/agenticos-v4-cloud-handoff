/** Browser-safe workflow catalogue and request contracts. No database, filesystem or provider imports. */
import { z } from "zod";

export const WORKFLOW_TEMPLATE_IDS = [
  "website-enquiry",
  "discovery",
  "proposal",
  "onboarding",
  "delivery-acceptance",
  "cms-handover",
  "change-request",
  "follow-up",
  "maintenance-review",
] as const;
export const WORKFLOW_CATALOGUE_VERSION = 1;
export const WORKFLOW_HISTORY_LIMIT = 50;
export const WORKFLOW_RUN_LIMIT = 2000;
export const WORKFLOW_RECORD_KINDS = ["company", "deal", "project"] as const;
export const WORKFLOW_PLACEHOLDERS = [
  "company.name",
  "deal.title",
  "deal.scope",
  "project.name",
] as const;

const id = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const line = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\r\n\0]+$/, "Use one line");
const copy = z
  .string()
  .max(10000)
  .refine((v) => !v.includes("\0"), "Remove null characters")
  .refine(
    (v) =>
      [...v.matchAll(/\{\{([^{}]+)\}\}/g)].every((m) =>
        (WORKFLOW_PLACEHOLDERS as readonly string[]).includes(m[1]!.trim()),
      ),
    "Unknown workflow placeholder",
  );
const recordRef = z.object({ kind: z.enum(WORKFLOW_RECORD_KINDS), id }).strict();
// A founder, or an agent with its job (the Dot gateway's collaborator: { agent: "dot", jobId: "gw:<session>" }).
const bySchema = z.union([z.object({ personId: z.enum(["usman", "mehroz"]) }).strict(), z.object({ agent: z.string().trim().min(1).max(40), jobId: z.string().trim().min(1).max(80) }).strict()]);
const authorSchema = z.union([bySchema, z.object({ catalogue: z.literal(true) }).strict()]);
const date = z
  .union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v.slice(0, 10)).toISOString().slice(0, 10) === v.slice(0, 10),
    "Use a valid date",
  );
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const workflowTaskSchema = z
  .object({
    key: id,
    title: line,
    description: copy,
    kind: z.enum([
      "follow-up",
      "call",
      "email",
      "meeting",
      "promise",
      "delivery",
      "renewal",
      "other",
    ]),
  })
  .strict();
export const workflowDocumentSchema = z
  .object({
    title: line,
    kind: z.enum(["proposal", "brief", "deliverable", "other"]),
    content: copy.refine((v) => !!v.trim(), "Add draft content"),
  })
  .strict();
const editableFields = z
  .object({
    title: line,
    summary: line,
    appliesTo: z
      .array(z.enum(WORKFLOW_RECORD_KINDS))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length, "Choose each record kind once"),
    tasks: z
      .array(workflowTaskSchema)
      .min(1)
      .max(8)
      .refine((v) => new Set(v.map((t) => t.key)).size === v.length, "Task keys must be unique"),
    document: workflowDocumentSchema.nullable(),
  })
  .strict();
export const workflowTemplateDefinitionSchema = editableFields
  .extend({ id: z.enum(WORKFLOW_TEMPLATE_IDS) })
  .strict();
export const workflowTemplatePatchSchema = editableFields
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Choose a field to update");
export const workflowTemplateUpdateSchema = z
  .object({
    id: z.enum(WORKFLOW_TEMPLATE_IDS),
    expectedVersion: version,
    patch: workflowTemplatePatchSchema,
  })
  .strict();
export const workflowApplySchema = z
  .object({
    templateId: z.enum(WORKFLOW_TEMPLATE_IDS),
    expectedVersion: version,
    ref: recordRef,
    requestId: id,
    expectedDealVersion: version.optional(),
    owner: z.enum(["usman", "mehroz", ""]).optional(),
    dueAt: date.nullable().optional(),
  })
  .strict();
export const workflowTemplateSnapshotSchema = workflowTemplateDefinitionSchema
  .extend({
    version,
    savedAt: z.string().datetime({ offset: true }),
    by: authorSchema,
  })
  .strict();
export const workflowTemplateSchema = workflowTemplateDefinitionSchema
  .extend({
    version,
    provenance: z
      .object({
        catalogueId: z.string().min(1).max(160),
        catalogueVersion: version,
        createdAt: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        updatedBy: authorSchema,
      })
      .strict(),
    history: z.array(workflowTemplateSnapshotSchema).max(WORKFLOW_HISTORY_LIMIT),
  })
  .strict();
export const workflowRunReceiptSchema = z
  .object({
    requestId: id,
    templateId: z.enum(WORKFLOW_TEMPLATE_IDS),
    templateVersion: version,
    ref: recordRef,
    taskIds: z.array(id).min(1).max(8),
    documentIds: z.array(id).max(1),
    activityId: id,
    duplicate: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    by: bySchema,
  })
  .strict();
export type WorkflowTemplateDefinition = z.infer<typeof workflowTemplateDefinitionSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type WorkflowTemplateSnapshot = z.infer<typeof workflowTemplateSnapshotSchema>;
export type WorkflowTemplateUpdate = z.infer<typeof workflowTemplateUpdateSchema>;
export type WorkflowApplyInput = z.infer<typeof workflowApplySchema>;
export type WorkflowRunReceipt = z.infer<typeof workflowRunReceiptSchema>;
export type WorkflowFounder = z.infer<typeof bySchema>;

/** Returns independent editable copies; catalogue defaults never contain client facts or quoted prices. */
export function defaultWorkflowDefinitions(): WorkflowTemplateDefinition[] {
  const task = (
    key: string,
    title: string,
    description: string,
    kind: z.infer<typeof workflowTaskSchema>["kind"] = "follow-up",
  ) => ({ key, title, description, kind });
  const document = (
    title: string,
    content: string,
    kind: z.infer<typeof workflowDocumentSchema>["kind"] = "brief",
  ) => ({ title, content, kind });
  const definitions: WorkflowTemplateDefinition[] = [
    {
      id: "website-enquiry",
      title: "Website enquiry qualification",
      summary: "Check fit, missing details and the next useful step",
      appliesTo: ["company", "deal"],
      tasks: [
        task(
          "qualify",
          "Qualify the website enquiry",
          "Review the enquiry source, website need, decision-maker, budget and timing. Record unknowns and check contact preferences before any outreach.",
        ),
      ],
      document: document(
        "Website enquiry notes",
        "## Website enquiry — {{company.name}}\nEnquiry source and date: [to confirm]\nBusiness goal and current website: [to confirm]\nDecision-maker: [to confirm]\nBudget and target date: [to confirm]\nContact preferences and restrictions: [check CRM]\nFit, missing information and next step: [founder to record]",
      ),
    },
    {
      id: "discovery",
      title: "Discovery meeting notes and requirements",
      summary: "Capture what was said, what is needed and what remains open",
      appliesTo: ["company", "deal", "project"],
      tasks: [
        task(
          "requirements",
          "Review discovery requirements and open questions",
          "Confirm the recorded requirements, missing content, access needs and next action. A template does not confirm a meeting happened.",
          "meeting",
        ),
      ],
      document: document(
        "Discovery notes and requirements",
        "## Discovery — {{company.name}}\nMeeting date, participants and source: [to confirm]\nGoals and audience: [to confirm]\nPages, functionality and integrations: [to confirm]\nContent, accessibility and brand needs: [to confirm]\nAccess needed: [list accounts; never passwords]\nBudget, timing and dependencies: [to confirm]\nDecisions actually agreed: [record evidence]\nOpen questions, owner and next date: [to confirm]",
      ),
    },
    {
      id: "proposal",
      title: "Proposal draft",
      summary: "Prepare a draft using the selected deal's reviewed price and scope",
      appliesTo: ["deal"],
      tasks: [
        task(
          "review-proposal",
          "Review the proposal draft before issue",
          "Confirm the client identity, scope, recorded price, dates, responsibilities and approval process. Resolve all placeholders before separately approving issue.",
        ),
      ],
      document: document(
        "Proposal draft",
        "## Proposal — {{deal.title}}\nPrepared for {{company.name}}\n## Recorded scope\n{{deal.scope}}\n## Scope details\nPages, integrations, exclusions and revision allowance: [confirm in writing]\n## Delivery and responsibilities\nContent, access, hosting, milestones and acceptance: [confirm in the agreement]\n## Terms to confirm\nDeposit, payment dates, cancellation and ownership: [confirm in the agreement]",
        "proposal",
      ),
    },
    {
      id: "onboarding",
      title: "Client onboarding",
      summary: "Confirm the agreement, content and secure access before delivery",
      appliesTo: ["deal", "project"],
      tasks: [
        task(
          "confirm-scope",
          "Confirm onboarding scope and responsibilities",
          "Check the approved agreement, agreed deliverables, dates, approver and payment status in Finance. A won deal does not prove payment.",
          "delivery",
        ),
        task(
          "gather-inputs",
          "Confirm content and secure access requirements",
          "List approved assets and missing content. Use secure account invitations for access; do not put passwords in CRM notes.",
          "delivery",
        ),
      ],
      document: document(
        "Client onboarding checklist",
        "## Onboarding — {{company.name}}\nAgreement and approved scope reference: [to confirm]\nClient approver and delivery owner: [to confirm]\nPayment status: [verify in Finance]\nApproved brand assets and content: [to confirm]\nDomain, hosting and CMS access: [secure invitation status only]\nDependencies, dates and next review: [to confirm]",
      ),
    },
    {
      id: "delivery-acceptance",
      title: "Delivery acceptance",
      summary: "Review deliverables and record explicit acceptance evidence",
      appliesTo: ["project"],
      tasks: [
        task(
          "acceptance",
          "Review delivery against the agreed scope",
          "Check links, devices, forms and agreed acceptance criteria. Record defects and the client's explicit acceptance evidence; leave acceptance pending until confirmed.",
          "delivery",
        ),
      ],
      document: document(
        "Delivery acceptance review",
        "## Delivery review — {{project.name}}\nAgreed scope and acceptance criteria: [reference]\nPreview and deliverable links: [to confirm]\nChecks completed and evidence: [record actual results]\nOpen defects, changes and owner: [to confirm]\nClient acceptance: [pending; record approver, date and evidence]\nLaunch approval: [pending; separate decision]",
        "deliverable",
      ),
    },
    {
      id: "cms-handover",
      title: "CMS training and handover",
      summary: "Prepare practical training and confirm the handover record",
      appliesTo: ["project"],
      tasks: [
        task(
          "handover",
          "Prepare CMS training and handover",
          "Confirm who needs training, their access and the agreed topics. Record delivered training, remaining questions and handover evidence.",
          "delivery",
        ),
      ],
      document: document(
        "CMS training and handover notes",
        "## Handover — {{project.name}}\nTraining participants and date: [to confirm]\nCMS access: [check secure invitations; never passwords]\nEditing pages, media and forms: [agreed topics]\nBackups, updates and support contacts: [confirm responsibilities]\nGuides and recording links: [if available and authorised]\nQuestions, follow-up and handover confirmation: [to record]",
      ),
    },
    {
      id: "change-request",
      title: "Change request and revisions",
      summary: "Check scope, cost and timing before approving additional work",
      appliesTo: ["deal", "project"],
      tasks: [
        task(
          "assess-change",
          "Assess the requested change before starting",
          "Compare the request with the approved scope and revision allowance. Record impacts and obtain the appropriate written decision before extra work.",
          "delivery",
        ),
      ],
      document: document(
        "Change request review",
        "## Change request — {{company.name}}\nRequester, date and source: [to confirm]\nRequested change and reason: [to record]\nExisting scope and revision allowance: [reference]\nImpact on deliverables, cost and timing: [to assess]\nWritten decision and approver: [pending]\nAgreed next step: [to confirm]",
      ),
    },
    {
      id: "follow-up",
      title: "Follow-up tasks",
      summary: "Create a clear internal next action with an owner and chosen date",
      appliesTo: ["company", "deal", "project"],
      tasks: [
        task(
          "follow-up",
          "Review and complete the agreed next action",
          "Check the latest CRM activity, promises and contact preferences. Confirm the next action, owner and due date before separately approved outreach.",
        ),
      ],
      document: null,
    },
    {
      id: "maintenance-review",
      title: "Maintenance review",
      summary: "Review the agreed care scope and record any issues or next work",
      appliesTo: ["project"],
      tasks: [
        task(
          "maintenance",
          "Review the agreed maintenance scope",
          "Check agreed updates, backups, access, known issues and renewal dates. Verify actual results and quote additional work separately.",
          "renewal",
        ),
      ],
      document: document(
        "Maintenance review notes",
        "## Maintenance review — {{project.name}}\nReview date and agreed care scope: [to confirm]\nUpdates, backups and checks: [record actual results]\nIssues, evidence and owner: [to record]\nAdditional work: [assess and approve separately]\nRenewal and next review date: [confirm from agreement]\nClient update: [draft only; separate approval before sending]",
      ),
    },
  ];
  return definitions.map((definition) => workflowTemplateDefinitionSchema.parse(definition));
}

export const DEFAULT_WORKFLOW_TEMPLATES = defaultWorkflowDefinitions();
