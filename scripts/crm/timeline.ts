/** The account's story in words: what a founder or Jarvis did to a record, as a timeline entry. Pure; ops.ts records it through the existing idempotent activity mechanism. */
import type { CrmRef } from "../../src/lib/crm-ref";

export type TimelineEntry = { ref: CrmRef; eventId: string; title: string; note?: string };

export const FIELD_WORDS: Record<string, string> = {
  name: "name",
  industry: "industry",
  website: "website",
  locality: "locality",
  address: "address",
  timezone: "time zone",
  phone: "phone",
  emails: "email addresses",
  email: "email",
  owner: "owner",
  tags: "tags",
  notes: "notes",
  status: "status",
  doNotContact: "contact permission",
  emailAllowed: "contact permission",
  excluded: "prospecting",
  role: "role",
  primary: "primary contact",
  preferences: "preferences",
  title: "title",
  service: "service",
  scope: "scope",
  oneOffCents: "one-off value",
  recurringCents: "monthly value",
  gstTreatment: "GST",
  expectedClose: "expected close",
  nextAction: "next action",
  nextActionDue: "next action due",
  closeReason: "won or lost reason",
  stageId: "stage",
  dueAt: "due date",
  description: "details",
  contactId: "contact",
  dealId: "deal",
  projectId: "project",
  launchAt: "launch date",
  renewalAt: "renewal date",
  contentRequests: "content requests",
  accessRequests: "access requests",
  previewUrls: "preview links",
  revisionRequests: "revision requests",
  deliverables: "deliverables",
  externalUrl: "document link",
};
const fields = (patch: unknown): string => {
  const words = [
    ...new Set(
      Object.keys((patch as Record<string, unknown>) ?? {})
        .map((k) => FIELD_WORDS[k])
        .filter(Boolean),
    ),
  ];
  return words.length ? ` (${words.join(", ")})` : "";
};
type Rec = {
  id: string;
  version: number;
  companyId?: string;
  name?: string;
  title?: string;
  owner?: string;
  stageId?: string;
  stageHistory?: { stageName?: string }[];
};
const label = (r: Rec) => (r.name ?? r.title ?? "").trim();
const named = (prefix: string, r: Rec) => (label(r) ? `${prefix}: ${label(r)}` : prefix);
const owner = (o?: string) => (o === "usman" ? "Usman" : o === "mehroz" ? "Mehroz" : "nobody");

/** The entry for a successful operation, or null when the operation leaves nothing to say (reads, imports, templates that record their own). */
export function timelineEntry(name: string, input: unknown, data: unknown): TimelineEntry | null {
  const r = data as Rec | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.version !== "number")
    return null;
  const v = (input ?? {}) as { patch?: unknown; reason?: string };
  const key = (kind: string) => `crm-change:${name}:${r.id}:${r.version}:${kind}`;
  const company = (id?: string): CrmRef | null => (id ? { kind: "company", id } : null);
  switch (name) {
    case "crm.company.create":
      return {
        ref: { kind: "company", id: r.id },
        eventId: key("c"),
        title: named("Company added", r),
      };
    case "crm.company.update":
      return {
        ref: { kind: "company", id: r.id },
        eventId: key("u"),
        title: `Company details updated${fields(v.patch)}`,
      };
    case "crm.contact.add":
    case "crm.contact.create":
    case "crm.contact.update": {
      const ref = company(r.companyId);
      return ref
        ? {
            ref,
            eventId: key("c"),
            title: named(
              name.endsWith("update") ? `Contact updated${fields(v.patch)}` : "Contact added",
              r,
            ),
          }
        : null;
    }
    case "crm.deal.create":
      return { ref: { kind: "deal", id: r.id }, eventId: key("c"), title: named("Deal added", r) };
    case "crm.deal.update":
      return {
        ref: { kind: "deal", id: r.id },
        eventId: key("u"),
        title: named(`Deal updated${fields(v.patch)}`, r),
      };
    case "crm.deal.move": {
      const stage = r.stageHistory?.at(-1)?.stageName;
      return {
        ref: { kind: "deal", id: r.id },
        eventId: key("m"),
        title: named(stage ? `Deal moved to ${stage}` : "Deal moved", r),
        ...(v.reason ? { note: v.reason } : {}),
      };
    }
    case "crm.task.create":
    case "crm.task.add": {
      const ref = company(r.companyId);
      return ref ? { ref, eventId: key("c"), title: named("Task added", r) } : null;
    }
    case "crm.task.update":
    case "crm.task.complete":
    case "crm.task.reopen":
    case "crm.task.assign": {
      const ref = company(r.companyId);
      if (!ref) return null;
      const what = name.endsWith("complete")
        ? "Task completed"
        : name.endsWith("reopen")
          ? "Task reopened"
          : name.endsWith("assign")
            ? `Task assigned to ${owner(r.owner)}`
            : `Task updated${fields(v.patch)}`;
      return { ref, eventId: key("t"), title: named(what, r) };
    }
    case "crm.project.create": {
      const ref = company(r.companyId);
      return ref ? { ref, eventId: key("c"), title: named("Delivery project added", r) } : null;
    }
    case "crm.project.update": {
      const ref = company(r.companyId);
      return ref
        ? { ref, eventId: key("u"), title: named(`Delivery project updated${fields(v.patch)}`, r) }
        : null;
    }
    case "crm.document.create": {
      const ref = company(r.companyId);
      return ref ? { ref, eventId: key("c"), title: named("Document added", r) } : null;
    }
    default:
      return null;
  }
}
