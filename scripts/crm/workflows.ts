/** Local workflow materialisation. Uses the existing CRM transaction and settings; no new schema or outward actions. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { WEBSITE_OFFER, WEBSITE_EX_GST_CENTS } from "../leads/sales-backoffice";
import { splitGst } from "../../src/lib/business-economics";
import type { CrmStore } from "./store";
import { CrmError, type Company, type Deal, type DocumentPricing, type OwnerId } from "./types";
import { receptionistOnHold } from "./policy";
import {
  defaultWorkflowDefinitions,
  WORKFLOW_CATALOGUE_VERSION,
  WORKFLOW_HISTORY_LIMIT,
  WORKFLOW_RUN_LIMIT,
  workflowApplySchema,
  workflowRunReceiptSchema,
  workflowTemplateDefinitionSchema,
  workflowTemplateSchema,
  workflowTemplateUpdateSchema,
  type WorkflowApplyInput,
  type WorkflowFounder,
  type WorkflowRunReceipt,
  type WorkflowTemplate,
  type WorkflowTemplateDefinition,
  type WorkflowTemplateUpdate,
} from "./workflow-templates";

const templateKey = (id: string) => `crm.workflow.template.${id}`;
const runKey = (id: string) => `crm.workflow.run.${id}`;
const RUN_INDEX = "crm.workflow.run-index";
const runSchema = z
  .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), receipt: workflowRunReceiptSchema })
  .strict();
const runIndexSchema = z
  .array(workflowApplySchema.shape.requestId)
  .max(WORKFLOW_RUN_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length);
function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new CrmError("validation", result.error.issues[0]?.message ?? "Invalid workflow data.");
  return result.data;
}
function founder(value: WorkflowFounder): WorkflowFounder {
  return validated(workflowRunReceiptSchema.shape.by, value);
}
function settingSize(value: unknown): void {
  if (JSON.stringify(value).length > 900_000)
    throw new CrmError(
      "validation",
      "Workflow history is full. Preserve its audit history before making further changes.",
    );
}
function definition(template: WorkflowTemplate): WorkflowTemplateDefinition {
  const { id, title, summary, appliesTo, tasks, document } = template;
  return structuredClone({ id, title, summary, appliesTo, tasks, document });
}
function reviewedPricing(deal: Deal): DocumentPricing {
  if (receptionistOnHold(deal))
    throw new CrmError("restricted", "Receptionist development and billing remain on hold.");
  if (deal.commercialBasis === "legacy-unconfirmed" || deal.commercialBasis === "pending")
    throw new CrmError(
      "validation",
      deal.commercialBasis === "pending"
        ? "Pricing is pending. Record the approved price before drafting a proposal."
        : "Confirm this deal's agreed price before drafting a proposal.",
    );
  if (deal.commercialBasis === "catalogue") {
    if (deal.catalogueId !== "website")
      throw new CrmError(
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
      throw new CrmError(
        "validation",
        "Deal values differ from the approved catalogue. Confirm an agreed price before drafting; catalogue prices were not changed.",
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
function pricingCopy(deal: Deal, pricing: DocumentPricing): string {
  const money = (cents: number) =>
    new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
  const amount = (cents: number) => {
    const gst = splitGst(
      cents,
      pricing.gstTreatment === "not-applicable" ? "none" : pricing.gstTreatment,
    );
    return `${money(gst.netCents)} ex GST + ${money(gst.gstCents)} GST = ${money(gst.grossCents)} total`;
  };
  return `## Reviewed deal price\nOne-off: ${amount(pricing.oneOffCents)}\nRecurring per month: ${amount(pricing.recurringCents)}\nPrice basis: ${deal.commercialBasis}; deal version ${deal.version}${pricing.catalogueId ? `; catalogue reference ${pricing.catalogueId}` : ""}.\nGST treatment: ${pricing.gstTreatment}.\nPayment dates and deposits: confirm in the approved agreement. No payment is requested by this draft.`;
}
type Context = {
  company: Company;
  deal: Deal | null;
  projectId: string | null;
  owner: OwnerId;
  placeholders: Record<string, string>;
};

export class CrmWorkflows {
  private readonly now: () => string;
  constructor(
    private readonly store: CrmStore,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }
  private timestamp(): string {
    return validated(z.string().datetime({ offset: true }), this.now());
  }
  private loadTemplates(): WorkflowTemplate[] {
    return defaultWorkflowDefinitions().map((entry) => {
      const saved = this.store.getSetting<unknown>(templateKey(entry.id), null);
      if (saved !== null) {
        const template = validated(workflowTemplateSchema, saved);
        if (
          template.id !== entry.id ||
          template.history.length !== template.version - 1 ||
          template.history.some(
            (snapshot, index) => snapshot.id !== entry.id || snapshot.version !== index + 1,
          )
        )
          throw new CrmError(
            "validation",
            "Workflow history needs review; the customised template was not replaced.",
          );
        return template;
      }
      const at = this.timestamp();
      const template: WorkflowTemplate = {
        ...entry,
        version: 1,
        history: [],
        provenance: {
          catalogueId: `crm-workflows:${entry.id}`,
          catalogueVersion: WORKFLOW_CATALOGUE_VERSION,
          createdAt: at,
          updatedAt: at,
          updatedBy: { catalogue: true },
        },
      };
      this.store.setSetting(templateKey(entry.id), template);
      return template;
    });
  }
  listTemplates(): WorkflowTemplate[] {
    return this.store.transaction(() => this.loadTemplates());
  }
  updateTemplate(input: WorkflowTemplateUpdate, by: WorkflowFounder): WorkflowTemplate {
    const change = validated(workflowTemplateUpdateSchema, input),
      author = founder(by);
    return this.store.transaction(() => {
      const prior = this.loadTemplates().find((template) => template.id === change.id)!;
      if (prior.version !== change.expectedVersion)
        throw new CrmError(
          "conflict",
          "This workflow template changed. Reload it before saving your changes.",
        );
      if (prior.history.length >= WORKFLOW_HISTORY_LIMIT)
        throw new CrmError(
          "validation",
          "Workflow version history is full. Preserve its audit history before further changes.",
        );
      const nextDefinition = validated(workflowTemplateDefinitionSchema, {
        ...definition(prior),
        ...change.patch,
      });
      if (prior.id === "proposal" && nextDefinition.document?.kind !== "proposal")
        throw new CrmError(
          "validation",
          "Keep a proposal draft document in the proposal workflow.",
        );
      const next: WorkflowTemplate = {
        ...nextDefinition,
        version: prior.version + 1,
        provenance: { ...prior.provenance, updatedAt: this.timestamp(), updatedBy: author },
        history: [
          ...prior.history,
          {
            ...definition(prior),
            version: prior.version,
            savedAt: prior.provenance.updatedAt,
            by: prior.provenance.updatedBy,
          },
        ],
      };
      settingSize(next);
      this.store.setSetting(templateKey(next.id), next);
      return next;
    });
  }
  private context(ref: WorkflowApplyInput["ref"]): Context {
    let companyId: string,
      deal: Deal | null = null,
      projectId: string | null = null,
      targetOwner: OwnerId = "",
      projectName = "";
    if (ref.kind === "deal") {
      deal = this.store.getDeal(ref.id);
      if (!deal) throw new CrmError("not-found", "Deal not found.");
      companyId = deal.companyId;
      targetOwner = deal.owner;
    } else if (ref.kind === "project") {
      const project = this.store.getProject(ref.id);
      if (!project) throw new CrmError("not-found", "Project not found.");
      companyId = project.companyId;
      projectId = project.id;
      projectName = project.name;
      targetOwner = project.owner;
      if (project.dealId) {
        deal = this.store.getDeal(project.dealId);
        if (!deal || deal.companyId !== companyId)
          throw new CrmError(
            "validation",
            "Review this project's linked deal before applying a workflow.",
          );
      }
    } else companyId = ref.id;
    const company = this.store.getCompany(companyId);
    if (!company) throw new CrmError("not-found", "Company not found.");
    if (company.mergedInto)
      throw new CrmError("conflict", "Open the retained company before applying a workflow.");
    if (deal && receptionistOnHold(deal))
      throw new CrmError(
        "restricted",
        "Receptionist development and billing remain on hold. No workflow work was created.",
      );
    return {
      company,
      deal,
      projectId,
      owner: targetOwner || company.owner,
      placeholders: {
        "company.name": company.name,
        "deal.title": deal?.title || "[To confirm]",
        "deal.scope": deal?.scope || "[Scope to confirm]",
        "project.name": projectName || "[Project to confirm]",
      },
    };
  }
  applyTemplate(input: WorkflowApplyInput, by: WorkflowFounder): WorkflowRunReceipt {
    const request = validated(workflowApplySchema, input),
      author = founder(by);
    // Explicit null and omitted dates mean the same thing. Never invent a deadline or an owner choice.
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          templateId: request.templateId,
          expectedVersion: request.expectedVersion,
          ref: request.ref,
          expectedDealVersion: request.expectedDealVersion ?? null,
          owner: request.owner ?? null,
          dueAt: request.dueAt ?? null,
          by: author,
        }),
      )
      .digest("hex");
    return this.store.transaction(() => {
      const saved = this.store.getSetting<unknown>(runKey(request.requestId), null);
      if (saved !== null) {
        const prior = validated(runSchema, saved);
        if (prior.fingerprint !== fingerprint || prior.receipt.requestId !== request.requestId)
          throw new CrmError(
            "idempotency-conflict",
            "This workflow request ID was already used for different details. Use a new ID for a new action.",
          );
        return { ...prior.receipt, duplicate: true };
      }
      const runIds = validated(runIndexSchema, this.store.getSetting<unknown>(RUN_INDEX, []));
      if (runIds.includes(request.requestId))
        throw new CrmError(
          "conflict",
          "This workflow receipt needs recovery. No tasks or drafts were recreated.",
        );
      if (runIds.length >= WORKFLOW_RUN_LIMIT)
        throw new CrmError(
          "validation",
          "Workflow run history is full. Preserve the receipts before running more workflows.",
        );
      const template = this.loadTemplates().find((entry) => entry.id === request.templateId)!;
      if (template.version !== request.expectedVersion)
        throw new CrmError(
          "conflict",
          "This workflow template changed. Review its current version before applying it.",
        );
      if (!template.appliesTo.includes(request.ref.kind))
        throw new CrmError("validation", "Choose a supported record for this workflow.");
      const context = this.context(request.ref);
      const needsPricing = template.id === "proposal" || template.document?.kind === "proposal";
      if (needsPricing && !context.deal)
        throw new CrmError(
          "validation",
          "Choose the explicit deal for this proposal. A company's deal is never guessed.",
        );
      if (needsPricing && request.expectedDealVersion === undefined)
        throw new CrmError(
          "validation",
          "Review the linked deal price and provide its current version before drafting a proposal.",
        );
      if (needsPricing && context.deal!.version !== request.expectedDealVersion)
        throw new CrmError(
          "conflict",
          "The deal changed. Refresh and review its price before drafting.",
        );
      const pricing = needsPricing ? reviewedPricing(context.deal!) : null;
      const render = (copy: string) =>
        copy.replace(
          /\{\{([^{}]+)\}\}/g,
          (_match, key: string) => context.placeholders[key.trim()] ?? "[To confirm]",
        );
      const at = this.timestamp(),
        taskIds: string[] = [],
        documentIds: string[] = [];
      const trace = `Workflow: ${template.title}; template ${template.id} version ${template.version}; catalogue ${template.provenance.catalogueVersion}; request ${request.requestId}.`;
      const renderedTasks = template.tasks.map((task) => ({
        ...task,
        title: render(task.title),
        description: render(task.description),
      }));
      if (renderedTasks.some((task) => task.title.length > 500 || task.description.length > 10000))
        throw new CrmError(
          "validation",
          "The selected record expands this template beyond the task text limit. Shorten the template or its placeholders; no work was created.",
        );
      for (const task of renderedTasks) {
        const created = this.store.createTask(
          {
            companyId: context.company.id,
            dealId: context.deal?.id ?? null,
            projectId: context.projectId,
            title: task.title,
            // Provenance lives in the immutable activity and receipt linked below. It must
            // not consume a user's valid task-text allowance or truncate their copy.
            description: task.description,
            kind: task.kind,
            status: "open",
            owner: request.owner ?? (context.owner || ("personId" in author ? author.personId : "")),
            dueAt: request.dueAt ?? null,
          },
          author,
        );
        taskIds.push(created.id);
      }
      if (template.document) {
        const created = this.store.createDocument(
          {
            companyId: context.company.id,
            dealId: context.deal?.id ?? null,
            projectId: context.projectId,
            title: render(template.document.title),
            kind: template.document.kind,
            status: "draft",
            content: `DRAFT — FOR FOUNDER REVIEW\n\n${render(template.document.content)}\n\n${pricing ? `${pricingCopy(context.deal!, pricing)}\n\n` : ""}Setup and pilot terms remain unapproved. Receptionist development and billing remain on hold.\nNo document has been issued, signed or accepted. No payment, message or launch is authorised by this draft. Verify invoice and payment status in Finance.\n\n${trace}`,
            pricing,
          },
          author,
        );
        documentIds.push(created.id);
      }
      const activity = this.store.addActivity(
        {
          ref: request.ref,
          eventId: `crm-workflow:${request.requestId}`,
          kind: "workflow",
          title: `Applied ${template.title}`,
          // Names, never ids: the ids live in the workflow receipt; the timeline tells the story in words.
          note: `${renderedTasks.length ? `Tasks added: ${renderedTasks.map((task) => task.title).join("; ")}.` : "No tasks added."}${template.document ? `\nDraft document: ${render(template.document.title)}.` : ""}`,
          outcome: "Internal tasks and drafts created",
          at,
        },
        author,
      );
      const receipt: WorkflowRunReceipt = {
        requestId: request.requestId,
        templateId: template.id,
        templateVersion: template.version,
        ref: request.ref,
        taskIds,
        documentIds,
        activityId: activity.id,
        duplicate: false,
        createdAt: at,
        by: author,
      };
      this.store.setSetting(runKey(request.requestId), { fingerprint, receipt });
      this.store.setSetting(RUN_INDEX, [...runIds, request.requestId]);
      return receipt;
    });
  }
}
