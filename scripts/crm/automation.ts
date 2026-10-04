import { receptionistOnHold } from "./policy";
/** CRM reactions to durable source events. No timer, provider calls, scheduler or second job engine. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Principal } from "../identity/principal";
import { isPrincipal } from "../approvals/principal";
import type { JobService } from "../jobs/service";
import type { CrmStore } from "./store";
import { CrmError, type Attribution } from "./types";
import { crmHref } from "../../src/lib/crm-links";
import { CRM_KINDS, type CrmRef } from "../../src/lib/crm-ref";
class AutomationError extends Error {}
const dateTime = z
  .string()
  .datetime({ offset: true })
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v.slice(0, 10)).toISOString().slice(0, 10) === v.slice(0, 10),
    "Use a valid date-time and UTC offset",
  );
const short = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\r\n\0]+$/, "Use a single line");
const ref = z
  .object({
    kind: z.enum(CRM_KINDS),
    id: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  })
  .strict();
export const CRM_AUTOMATION_TRIGGERS = [
  "enquiry.received",
  "reply.received",
  "meeting.completed",
  "proposal.inactive",
  "deal.won",
  "renewal.approaching",
] as const;
export type CrmAutomationTrigger = (typeof CRM_AUTOMATION_TRIGGERS)[number];
export const automationEventSchema = z
  .object({
    eventId: short,
    trigger: z.enum(CRM_AUTOMATION_TRIGGERS),
    at: dateTime,
    ref: ref.optional(),
    payload: z
      .object({
        companyName: short.optional(),
        contactName: short.optional(),
        email: z.string().email().max(320).optional(),
        phone: z.string().max(80).optional(),
        locality: z.string().max(200).optional(),
        owner: z.enum(["usman", "mehroz"]).optional(),
        title: short.optional(),
        nextAction: short.optional(),
        dueAt: dateTime.optional(),
        provider: z.string().trim().min(1).max(80).optional(),
        providerEventId: short.optional(),
        inactiveDays: z.number().int().min(1).max(365).optional(),
        renewalDate: dateTime.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type CrmAutomationEvent = z.infer<typeof automationEventSchema>;
export type AutomationRule = {
  id: CrmAutomationTrigger;
  enabled: boolean;
  trigger: CrmAutomationTrigger;
  action: string;
  sourceRequirement: string;
  lastOutcome: string | null;
  lastError: string | null;
  lastRunAt: string | null;
};
export type AutomationReceipt = {
  ok: boolean;
  duplicate: boolean;
  skipped: boolean;
  eventId: string;
  ruleId: CrmAutomationTrigger;
  jobId: string | null;
  href: string;
  text: string;
  outcome: string;
};
const RULES: { id: CrmAutomationTrigger; action: string; sourceRequirement: string }[] = [
  {
    id: "enquiry.received",
    action: "Create a company, contact and enquiry task",
    sourceRequirement: "Starts when a verified enquiry source is connected",
  },
  {
    id: "reply.received",
    action: "Record a received reply and create a follow-up",
    sourceRequirement:
      "Starts when an email or message source is connected. Nothing is sent from here",
  },
  {
    id: "meeting.completed",
    action: "Record the completed meeting and next action",
    sourceRequirement: "Starts when a meeting or its notes are linked",
  },
  {
    id: "proposal.inactive",
    action: "Create one proposal reminder",
    sourceRequirement: "Starts when a proposal has had no reply for the set time",
  },
  {
    id: "deal.won",
    action: "Open the agreed delivery project and onboarding task once",
    sourceRequirement: "Runs when a deal is marked Won",
  },
  {
    id: "renewal.approaching",
    action: "Create one renewal task",
    sourceRequirement: "Starts when a renewal date is near",
  },
];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Jobs = Pick<JobService, "create" | "get" | "begin" | "finish" | "step">;
export type CrmAutomationOptions = {
  store: CrmStore;
  jobs?: Jobs;
  targetDeviceId?: string;
  now?: () => string;
};

type RunRow = {
  event_id: string;
  fingerprint: string;
  rule_id: CrmAutomationTrigger;
  semantic_key: string;
  state: string;
  attempt: number;
  receipt: string | null;
  error: string | null;
  job_id: string | null;
};
export class CrmAutomations {
  private readonly now: () => string;
  constructor(private readonly options: CrmAutomationOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    for (const rule of RULES)
      options.store.db
        .query("INSERT OR IGNORE INTO crm_automation_rules(id) VALUES (?)")
        .run(rule.id);
  }
  list(): AutomationRule[] {
    return RULES.map((rule) => {
      const row = this.options.store.db
        .query("SELECT * FROM crm_automation_rules WHERE id=?")
        .get(rule.id) as {
        enabled: number;
        last_outcome: string | null;
        last_error: string | null;
        last_run_at: string | null;
      };
      return {
        ...rule,
        trigger: rule.id,
        enabled: !!row.enabled,
        lastOutcome: row.last_outcome,
        lastError: row.last_error,
        lastRunAt: row.last_run_at,
      };
    });
  }
  setEnabled(id: CrmAutomationTrigger, enabled: boolean): AutomationRule {
    if (!RULES.some((r) => r.id === id)) throw new AutomationError("Unknown CRM automation rule.");
    this.options.store.db
      .query("UPDATE crm_automation_rules SET enabled=? WHERE id=?")
      .run(enabled ? 1 : 0, id);
    return this.list().find((r) => r.id === id)!;
  }
  /** Caller authenticates the source event and principal; this adapter performs internal CRM work only. */
  accept(input: CrmAutomationEvent, principal: Principal): AutomationReceipt {
    if (!isPrincipal(principal))
      throw new AutomationError("A verified founder principal is required.");
    const event = automationEventSchema.parse(input),
      fingerprint = hash(event),
      store = this.options.store;
    const existing = store.db
      .query("SELECT * FROM crm_automation_runs WHERE event_id=?")
      .get(event.eventId) as RunRow | null;
    if (existing && existing.fingerprint !== fingerprint)
      throw new AutomationError("The event ID is already associated with different CRM content.");
    if (existing?.state === "succeeded" || existing?.state === "skipped")
      return { ...JSON.parse(existing.receipt!), duplicate: true };
    const rule = this.list().find((r) => r.id === event.trigger)!;
    const base = {
      eventId: event.eventId,
      ruleId: event.trigger,
      jobId: null as string | null,
      href: event.ref ? crmHref(event.ref) : "/crm?view=today",
      duplicate: false,
    };
    const finishRule = (outcome: string, error: string | null) =>
      store.db
        .query(
          "UPDATE crm_automation_rules SET last_outcome=?,last_error=?,last_run_at=? WHERE id=?",
        )
        .run(outcome, error, this.now(), rule.id);
    if (!rule.enabled) {
      const receipt: AutomationReceipt = {
        ...base,
        ok: true,
        skipped: true,
        text: "Rule is disabled; no action was taken.",
        outcome: "disabled",
      };
      store.db
        .query("INSERT OR REPLACE INTO crm_automation_runs VALUES (?,?,?,?,?,?,?,?,?)")
        .run(
          event.eventId,
          fingerprint,
          rule.id,
          event.eventId,
          "skipped",
          0,
          JSON.stringify(receipt),
          null,
          null,
        );
      finishRule(receipt.outcome, null);
      return receipt;
    }
    const semantic = this.semanticKey(event);
    const completed = store.db
      .query(
        "SELECT receipt FROM crm_automation_runs WHERE semantic_key=? AND state='succeeded' LIMIT 1",
      )
      .get(semantic) as { receipt: string } | null;
    if (completed)
      return { ...JSON.parse(completed.receipt), eventId: event.eventId, duplicate: true };
    if (!this.options.jobs) {
      const error = "Connect the existing durable Jobs service before running CRM automations.";
      finishRule("blocked", error);
      return { ...base, ok: false, skipped: false, text: error, outcome: "blocked" };
    }
    const claim = store.transaction(() => {
      const current = store.db
        .query("SELECT * FROM crm_automation_runs WHERE event_id=?")
        .get(event.eventId) as RunRow | null;
      if (current && current.fingerprint !== fingerprint)
        throw new AutomationError("The event ID is already associated with different CRM content.");
      if (current?.state === "succeeded" || current?.state === "skipped")
        return {
          receipt: { ...JSON.parse(current.receipt!), duplicate: true } as AutomationReceipt,
        };
      if (current?.state === "running" && current.job_id) {
        const running = this.options.jobs!.get(current.job_id);
        if (running && ["queued", "running", "awaiting-approval"].includes(running.state))
          return {
            receipt: {
              ...base,
              jobId: running.id,
              ok: false,
              skipped: false,
              duplicate: true,
              outcome: "running",
              text: "This CRM event already has a running durable job.",
            } as AutomationReceipt,
          };
      }
      const won = store.db
        .query(
          "SELECT receipt FROM crm_automation_runs WHERE semantic_key=? AND state='succeeded' LIMIT 1",
        )
        .get(semantic) as { receipt: string } | null;
      if (won)
        return {
          receipt: {
            ...JSON.parse(won.receipt),
            eventId: event.eventId,
            duplicate: true,
          } as AutomationReceipt,
        };
      const attempt = (current?.attempt ?? 0) + 1;
      const job = this.options.jobs!.create({
        kind: "trigger",
        principal,
        targetDeviceId: this.options.targetDeviceId ?? "crm",
        title: `CRM: ${rule.action}`,
        requestId: `crm:${hash([event.eventId, attempt]).slice(0, 64)}`,
      });
      store.db
        .query("INSERT OR REPLACE INTO crm_automation_runs VALUES (?,?,?,?,?,?,?,?,?)")
        .run(event.eventId, fingerprint, rule.id, semantic, "running", attempt, null, null, job.id);
      return { job };
    });
    if (claim.receipt) return claim.receipt;
    const job = claim.job!;
    base.jobId = job.id;
    if (!this.options.jobs.begin(job.id)) {
      const error = "The durable job could not begin. Review its current state before retrying.";
      store.db
        .query("UPDATE crm_automation_runs SET state='failed',error=? WHERE event_id=?")
        .run(error, event.eventId);
      finishRule("failed", error);
      return { ...base, ok: false, skipped: false, text: error, outcome: "failed" };
    }
    let receipt: AutomationReceipt;
    try {
      receipt = store.transaction(() => {
        const outcome = this.apply(event, { personId: principal.personId });
        const value: AutomationReceipt = { ...base, ...outcome, ok: true, duplicate: false };
        store.db
          .query("UPDATE crm_automation_runs SET state=?,receipt=?,error=NULL WHERE event_id=?")
          .run(value.skipped ? "skipped" : "succeeded", JSON.stringify(value), event.eventId);
        finishRule(value.outcome, null);
        return value;
      });
    } catch (error) {
      const message =
        error instanceof AutomationError || error instanceof CrmError
          ? error.message
          : "CRM automation could not complete. Review the durable job and retry after the store is available.";
      store.db
        .query("UPDATE crm_automation_runs SET state='failed',error=? WHERE event_id=?")
        .run(message.slice(0, 800), event.eventId);
      finishRule("failed", message.slice(0, 800));
      this.options.jobs.finish(
        job.id,
        "failed",
        "CRM automation failed; inspect the rule error before retrying.",
      );
      return { ...base, ok: false, skipped: false, text: message, outcome: "failed" };
    }
    // The CRM transaction is authoritative. A Jobs notification failure must never roll back or repeat it.
    try {
      this.options.jobs.step(job.id, {
        intent: rule.action,
        executor: "crm",
        ms: 0,
        outcome: receipt.skipped ? "skipped" : "ok",
        verification: { method: "CRM transaction", ok: true },
      });
      this.options.jobs.finish(
        job.id,
        "succeeded",
        receipt.skipped
          ? "CRM rule skipped with a recorded reason."
          : "CRM records persisted; no external communication.",
      );
    } catch {
      /* retry returns the committed receipt */
    }
    return receipt;
  }
  private proposalBaseline(dealId: string): number {
    const deal = this.options.store.getDeal(dealId);
    if (!deal) return 0;
    return Math.max(
      Date.parse(deal.updatedAt),
      ...this.options.store
        .snapshot()
        .activities.filter(
          (a) => a.ref.kind === "deal" && a.ref.id === dealId && a.kind !== "automation",
        )
        .map((a) => Date.parse(a.at))
        .filter(Number.isFinite),
    );
  }
  private semanticKey(event: CrmAutomationEvent): string {
    if (event.trigger === "deal.won") return `deal.won:${event.ref?.id ?? "missing"}`;
    if (event.trigger === "renewal.approaching")
      return `renewal:${event.ref?.id ?? "missing"}:${event.payload.renewalDate ? new Date(event.payload.renewalDate).toISOString() : "missing"}`;
    if (event.trigger === "proposal.inactive")
      return `proposal:${event.ref?.id ?? "missing"}:${this.proposalBaseline(event.ref?.id ?? "")}:${event.payload.inactiveDays ?? 7}`;
    if (
      (event.trigger === "enquiry.received" || event.trigger === "reply.received") &&
      event.payload.provider &&
      event.payload.providerEventId
    )
      return `${event.trigger}:${event.payload.provider}:${event.payload.providerEventId}`;
    return event.eventId;
  }
  private apply(
    event: CrmAutomationEvent,
    by: Attribution,
  ): Pick<AutomationReceipt, "href" | "text" | "outcome" | "skipped"> {
    const store = this.options.store,
      p = event.payload;
    const success = (ref: CrmRef, text: string, outcome = "completed", skipped = false) => ({
      href: crmHref(ref, ref.kind === "project" ? "delivery" : "timeline"),
      text,
      outcome,
      skipped,
    });
    if (event.trigger === "enquiry.received") {
      if (!p.companyName && !event.ref)
        throw new AutomationError(
          "An enquiry needs a company name or an explicit existing company reference.",
        );
      if (!p.provider || !p.providerEventId)
        throw new AutomationError(
          "A verified enquiry provider and stable provider event ID are required.",
        );
      if (event.ref && event.ref.kind !== "company")
        throw new AutomationError("An enquiry target must be a company.");
      const company = event.ref
        ? store.getCompany(event.ref.id)
        : store.createCompany(
            {
              name: p.companyName!,
              locality: p.locality ?? "",
              owner: p.owner ?? ("personId" in by ? by.personId : ""),
              source: { kind: "enquiry", reference: p.providerEventId, attribution: p.provider },
              fieldSources: { name: "enquiry", emails: "enquiry", phone: "enquiry" },
              emails: p.email ? [p.email] : [],
              phone: p.phone ?? "",
            },
            by,
          );
      if (!company) throw new AutomationError("The enquiry company was not found.");
      if (p.contactName)
        store.createContact(
          {
            companyId: company.id,
            name: p.contactName,
            email: p.email ?? "",
            phone: p.phone ?? "",
            source: { kind: "enquiry", reference: p.providerEventId, attribution: p.provider },
          },
          by,
        );
      const target: CrmRef = { kind: "company", id: company.id };
      store.addActivity(
        {
          ref: target,
          eventId: `${event.eventId}:activity`,
          kind: "enquiry",
          title: p.title ?? "New enquiry",
          at: event.at,
          communicationState: "received",
          providerEvidence: {
            provider: p.provider,
            eventId: p.providerEventId,
            observedAt: event.at,
            state: "received",
          },
          note: `Received from ${p.provider}; provider event ${p.providerEventId}.`,
        },
        by,
      );
      store.createTask(
        {
          companyId: company.id,
          title: p.nextAction ?? "Review the new enquiry",
          kind: "follow-up",
          owner: p.owner ?? company.owner,
          dueAt: p.dueAt ?? event.at,
        },
        by,
      );
      return success(target, "Enquiry saved with a follow-up task.");
    }
    if (!event.ref) throw new AutomationError("This automation needs an explicit CRM record.");
    if (event.trigger === "deal.won") {
      if (event.ref.kind !== "deal")
        throw new AutomationError("Won automation needs a deal reference.");
      const deal = store.getDeal(event.ref.id);
      if (!deal) throw new AutomationError("Deal not found.");
      const pipeline = store.snapshot().pipelines.find((p) => p.id === deal.pipelineId);
      if (pipeline?.stages.find((s) => s.id === deal.stageId)?.category !== "won")
        throw new AutomationError("The deal must already be Won.");
      if (receptionistOnHold(deal))
        return success(
          event.ref,
          "Receptionist remains on hold. No onboarding or billing was activated.",
          "receptionist-on-hold",
          true,
        );
      const existing = store.snapshot().projects.find((project) => project.dealId === deal.id);
      if (existing)
        return success(
          { kind: "project", id: existing.id },
          "This deal already has a delivery project.",
          "already-onboarded",
          true,
        );
      const project = store.createProject(
        {
          companyId: deal.companyId,
          dealId: deal.id,
          name: deal.title,
          owner: deal.owner,
          scope: deal.scope,
          status: "onboarding",
          contentRequests: ["Confirm approved content and brand assets"],
          accessRequests: ["Request appropriate website and domain access through secure channels"],
        },
        by,
      );
      store.createTask(
        {
          companyId: deal.companyId,
          dealId: deal.id,
          projectId: project.id,
          title: "Confirm onboarding scope, content and access",
          kind: "delivery",
          owner: deal.owner,
          dueAt: p.dueAt ?? event.at,
        },
        by,
      );
      store.addActivity(
        {
          ref: event.ref,
          eventId: `${event.eventId}:activity`,
          kind: "onboarding",
          title: "Delivery project opened",
          note: "Won business is not a payment receipt. Existing Finance remains authoritative.",
        },
        by,
      );
      return success(
        { kind: "project", id: project.id },
        "Delivery project and onboarding task created. Payment remains unconfirmed.",
      );
    }
    if (event.trigger === "renewal.approaching") {
      if (event.ref.kind !== "project")
        throw new AutomationError("Renewal automation needs a project reference.");
      const project = store.getProject(event.ref.id);
      if (!project) throw new AutomationError("Project not found.");
      if (
        !project.renewalAt ||
        !p.renewalDate ||
        Date.parse(project.renewalAt) !== Date.parse(p.renewalDate)
      )
        throw new AutomationError("Renewal event must match the project's current renewal date.");
      store.createTask(
        {
          companyId: project.companyId,
          dealId: project.dealId,
          projectId: project.id,
          title: p.nextAction ?? `Review renewal: ${project.name}`,
          kind: "renewal",
          owner: p.owner ?? project.owner,
          dueAt: p.dueAt ?? project.renewalAt,
        },
        by,
      );
      return success(event.ref, "Renewal task saved.");
    }
    let companyId: string,
      dealId: string | null = null,
      owner: "usman" | "mehroz" | "" = "";
    if (event.ref.kind === "company") {
      const c = store.getCompany(event.ref.id);
      if (!c) throw new AutomationError("Company not found.");
      companyId = c.id;
      owner = c.owner;
    } else if (event.ref.kind === "deal") {
      const d = store.getDeal(event.ref.id);
      if (!d) throw new AutomationError("Deal not found.");
      companyId = d.companyId;
      dealId = d.id;
      owner = d.owner;
    } else if (event.ref.kind === "contact") {
      const c = store.getContact(event.ref.id);
      if (!c) throw new AutomationError("Contact not found.");
      companyId = c.companyId;
      owner = c.owner;
    } else throw new AutomationError("Choose the linked company, contact or deal for this event.");
    if (event.trigger === "proposal.inactive") {
      if (!dealId) throw new AutomationError("Proposal inactivity requires a deal.");
      const deal = store.getDeal(dealId)!;
      if (deal.stageId !== "proposal")
        return success(
          event.ref,
          "The deal has left Proposal; no reminder created.",
          "no-longer-proposal",
          true,
        );
      const last = this.proposalBaseline(dealId);
      if (Date.parse(event.at) - last < (p.inactiveDays ?? 7) * 86400000)
        return success(
          event.ref,
          "The proposal is not inactive for the configured period.",
          "still-active",
          true,
        );
    }
    if (event.trigger === "reply.received" && (!p.provider || !p.providerEventId))
      throw new AutomationError(
        "A received reply requires verified provider evidence and its stable event ID.",
      );
    const meeting = event.trigger === "meeting.completed";
    const title =
      p.nextAction ??
      (meeting
        ? "Confirm the meeting's next action"
        : event.trigger === "proposal.inactive"
          ? "Review the inactive proposal"
          : "Review reply and follow up");
    store.createTask(
      {
        companyId,
        dealId,
        title,
        kind: "follow-up",
        owner: p.owner ?? owner,
        dueAt: p.dueAt ?? event.at,
      },
      by,
    );
    store.addActivity(
      {
        ref: event.ref,
        eventId: `${event.eventId}:activity`,
        kind: meeting ? "meeting" : event.trigger === "reply.received" ? "email" : "automation",
        title:
          p.title ??
          (meeting
            ? "Meeting completed"
            : event.trigger === "reply.received"
              ? "Reply received"
              : "Proposal reminder created"),
        at: event.at,
        ...(event.trigger === "reply.received"
          ? {
              communicationState: "received" as const,
              providerEvidence: {
                provider: p.provider!,
                eventId: p.providerEventId!,
                observedAt: event.at,
                state: "received" as const,
              },
              note: `Provider ${p.provider}, event ${p.providerEventId}.`,
            }
          : {}),
      },
      by,
    );
    return success(event.ref, "Activity and next-action task saved.");
  }
}
