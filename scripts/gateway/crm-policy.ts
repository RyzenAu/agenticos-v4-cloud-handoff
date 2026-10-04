/**
 * What the Dot gateway's collaborator may do through the CRM's typed operations (scripts/crm/ops.ts). Dependency-free.
 *
 * The CRM's own registry calls `gatewayCrmGuard` for a gateway principal BEFORE validating or running an operation, so the
 * same rule holds on every path that can reach `operations.run` (the gateway's own route, a Jarvis task): the capability on
 * the verified assertion, an explicit operation allow-list (default deny), and the input checks below. A founder's call is
 * untouched: this module is consulted only when `isGatewayActor(principal)`.
 *
 * Owner instruction (4 Oct): Dot owns business workflows. What stays refused is ONLY what would send to, charge or issue to an
 * outside party, or bypass the approvals and consent rules that guard those (GATEWAY_CRM_RESTRICTIONS, each with its reason).
 * Every operation below was read in ops.ts, workflows.ts, automation.ts and csv.ts: none of them sends, charges or issues.
 *   - drafts: `crm.proposal.draft`, `crm.invoice.draft` (NOT A VALID TAX INVOICE, "not issued or sent"), `crm.quote.package`
 *     (a deal-desk workbook, "not sent");
 *   - pipelines, workflows (apply creates internal tasks and documents marked "DRAFT — FOR FOUNDER REVIEW"), automations
 *     (every rule does internal CRM work only: records, tasks, a project; "Nothing is sent from here"), saved views,
 *     duplicate merges (source records and history are kept), CSV import (it can only TIGHTEN an existing opt-out) and export;
 *   - winning a deal: the deal.won automation opens the delivery project and an onboarding task, once. Nothing is invoiced,
 *     charged or sent ("Won business is not a payment receipt").
 */
import { gatewayHolds, gatewayProvenance, isGatewayActor } from "./actor";

export const CRM_READ = "crm.read";
export const CRM_WRITE = "crm.write";

/** Reads: the shared business records and the CRM's own configuration lists. */
export const GATEWAY_CRM_READS: readonly string[] = [
  "crm.snapshot",
  "crm.record.get",
  "crm.companies.query",
  "crm.contacts.query",
  "crm.deals.query",
  "crm.followups.overdue",
  "crm.promises.list",
  "crm.search",
  "crm.next.list",
  "crm.drafts.list",
  "crm.workflow.templates",
  "crm.views.list",
  "crm.duplicates.list",
  "crm.automations.list",
];

/** Writes: records, drafts and the business workflows. */
export const GATEWAY_CRM_WRITES: readonly string[] = [
  "crm.company.create",
  "crm.company.update",
  "crm.contact.add",
  "crm.contact.create",
  "crm.contact.update",
  "crm.deal.create",
  "crm.deal.update",
  "crm.deal.move",
  "crm.task.create",
  "crm.task.add",
  "crm.task.update",
  "crm.task.complete",
  "crm.task.reopen",
  "crm.task.assign",
  "crm.activity.add",
  "crm.project.create",
  "crm.project.update",
  "crm.document.create",
  "crm.document.update",
  "crm.document.version.add",
  // Drafts only (see the header).
  "crm.proposal.draft",
  "crm.invoice.draft",
  "crm.quote.package",
  // Business workflows (see the header): internal records only.
  "crm.pipeline.create",
  "crm.pipeline.update",
  "crm.workflow.update",
  "crm.workflow.apply",
  "crm.automations.configure",
  "crm.views.save",
  "crm.duplicates.merge",
  "crm.csv.preview",
  "crm.csv.commit",
  "crm.csv.export",
];

/** No whole operation is a founder's any more; the refusals are input-level (GATEWAY_CRM_RESTRICTIONS). Kept for callers. */
export const GATEWAY_CRM_FOUNDER_ONLY: readonly string[] = [];
export const GATEWAY_CRM_FOUNDER_ONLY_WHY: Record<string, string> = {};

/** What is still refused, and the ONE reason each ties to a send, a payment or an approval bypass (the matrix quotes these). */
export const GATEWAY_CRM_RESTRICTIONS = {
  documentIssued: "A document marked issued or accepted says it went to the client: issuing is a send, and sends need the founder's approval.",
  communicationClaim: "An activity saying a message was queued, sent or received records outbound contact without the provider's evidence or the founder's approval of the send.",
  attribution: "Supplying another person's or agent's attribution would make Dot's record pass as theirs, including a founder's approval trail.",
  providerEvidence: "Provider evidence is what proves a real send or receipt; it comes from the mail or message provider, never from a caller.",
  loosenContact: "Allowing contact (email permission on, do-not-contact off, not excluded) authorises future outbound messages, which consent and the Spam Act 2003 require a founder to decide.",
} as const;

/** Tightening only: what Dot may set on who may be contacted. */
const TIGHTENING: Record<string, unknown> = { doNotContact: true, emailAllowed: false, excluded: true };
/** A document Dot touches stays a draft (or is retired). */
const DOCUMENT_STATUS_ALLOWED = ["draft", "superseded"];
/** An activity may say a message was drafted (or that it failed, or is unknown). */
const COMMUNICATION_ALLOWED = ["drafted", "failed", "unknown"];

export type GatewayCrmVerdict = { ok: true; attribution: { agent: string; jobId: string }; kind: "read" | "write" } | { ok: false; code: "unauthorised" | "restricted" | "not-found"; text: string };

const refuse = (code: "unauthorised" | "restricted" | "not-found", text: string): GatewayCrmVerdict => ({ ok: false, code, text });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The contact-permission fields in this input that would LOOSEN who may be contacted (tightening is allowed). */
export function looseningFields(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const source of [input, obj(input.patch)])
    for (const [field, tight] of Object.entries(TIGHTENING)) if (field in source && source[field] !== tight) out.push(field);
  // A reason is only meaningful with an exclusion; setting it alone is harmless, but never with excluded false.
  return out;
}

/**
 * May this gateway principal run this operation with this (raw, not yet validated) input?
 * `wonStageIds` is kept for callers (winning a deal is allowed now); it is not consulted.
 */
export function gatewayCrmGuard(name: string, raw: unknown, principal: unknown, _lookup?: { wonStageIds: () => ReadonlySet<string> }): GatewayCrmVerdict {
  if (!isGatewayActor(principal)) return refuse("unauthorised", "A verified founder session is required.");
  const read = GATEWAY_CRM_READS.includes(name);
  const write = GATEWAY_CRM_WRITES.includes(name);
  if (!read && !write) return refuse("not-found", "Unknown CRM operation.");
  const needs = read ? CRM_READ : CRM_WRITE;
  const input = obj(raw);
  // A reply draft for a message in an authorised mailbox (scripts/gateway/mail.ts) is the OS's own draft record: mail.draft is enough.
  const replyDraft = name === "crm.activity.add" && input.kind === "draft-reply" && gatewayHolds(principal, "mail.draft");
  if (!replyDraft && !gatewayHolds(principal, needs)) return refuse("unauthorised", `That needs the ${needs} capability.`);
  const patch = obj(input.patch);
  if (write) {
    if (/^crm\.(company|contact)\./.test(name) && looseningFields(input).length) return refuse("restricted", `${GATEWAY_CRM_RESTRICTIONS.loosenContact} Tightening (do not contact, email off, excluded) is allowed. Nothing changed.`);
    if (name.startsWith("crm.document.")) {
      const status = typeof input.status === "string" ? input.status : typeof patch.status === "string" ? patch.status : null;
      if (status && !DOCUMENT_STATUS_ALLOWED.includes(status)) return refuse("restricted", `${GATEWAY_CRM_RESTRICTIONS.documentIssued} Nothing changed.`);
    }
    if (name === "crm.activity.add") {
      if (input.by !== undefined) return refuse("restricted", GATEWAY_CRM_RESTRICTIONS.attribution);
      if (input.providerEvidence !== undefined) return refuse("restricted", GATEWAY_CRM_RESTRICTIONS.providerEvidence);
      const state = input.communicationState;
      if (state !== undefined && state !== null && !COMMUNICATION_ALLOWED.includes(String(state))) return refuse("restricted", GATEWAY_CRM_RESTRICTIONS.communicationClaim);
    }
  }
  return { ok: true, attribution: gatewayProvenance(principal), kind: read ? "read" : "write" };
}
