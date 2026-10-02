/** Shared, browser-safe CRM contract. IDs are opaque strings; original numeric lead IDs remain valid. */
export type FounderId = "usman" | "mehroz";
export type OwnerId = FounderId | "";
export type Attribution = { personId: FounderId } | { agent: string; jobId: string };
export type CrmKind = "company" | "contact" | "deal" | "project" | "document" | "lead";
export type CrmRef = { kind: CrmKind; id: string };
export type Versioned = { id: string; version: number; createdAt: string; updatedAt: string };
export type Source = {
  kind: "manual" | "csv" | "osm" | "google" | "enquiry" | "legacy";
  reference: string;
  attribution: string;
};
export type FieldSources = Record<string, string>;
export type WebsiteCheck =
  | "found"
  | "none-verified"
  | "check-failed"
  | "search-unavailable"
  | "not-checked";
export type Company = Versioned & {
  name: string;
  industry: string;
  website: string;
  locality: string;
  address: string;
  timezone: string;
  phone: string;
  emails: string[];
  owner: OwnerId;
  tags: string[];
  source: Source;
  fieldSources: FieldSources;
  status: "prospect" | "client" | "inactive";
  notes: string;
  doNotContact: boolean;
  emailAllowed: boolean;
  excluded: boolean;
  excludedReason: string;
  mergedInto: string | null;
  legacyLeadId: number | null;
  websiteCheck: WebsiteCheck;
  websiteCheckedAt: string | null;
};
export type Contact = Versioned & {
  companyId: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  primary: boolean;
  preferences: string;
  doNotContact: boolean;
  restrictions: string[];
  owner: OwnerId;
  source: Source;
  fieldSources: FieldSources;
};
export type StageCategory = "open" | "won" | "lost";
export type PipelineStage = {
  id: string;
  name: string;
  category: StageCategory;
  probability: number;
  archived: boolean;
};
export type Pipeline = Versioned & { name: string; stages: PipelineStage[] };
export const DEFAULT_PIPELINE_ID = "sales";
export const SALES_STAGES: readonly PipelineStage[] = [
  { id: "new", name: "New", category: "open", probability: 0.05, archived: false },
  { id: "qualified", name: "Qualified", category: "open", probability: 0.15, archived: false },
  { id: "contacted", name: "Contacted", category: "open", probability: 0.25, archived: false },
  { id: "meeting", name: "Meeting", category: "open", probability: 0.4, archived: false },
  { id: "proposal", name: "Proposal", category: "open", probability: 0.6, archived: false },
  { id: "negotiation", name: "Negotiation", category: "open", probability: 0.8, archived: false },
  { id: "won", name: "Won", category: "won", probability: 1, archived: false },
  { id: "lost", name: "Lost", category: "lost", probability: 0, archived: false },
];
export type GstTreatment = "inclusive" | "exclusive" | "not-applicable";
export type StageHistory = {
  stageId: string;
  stageName: string;
  at: string;
  by: Attribution | { legacy: string };
  reason: string;
};
export type Deal = Versioned & {
  companyId: string;
  title: string;
  owner: OwnerId;
  contactIds: string[];
  service: string;
  scope: string;
  pipelineId: string;
  stageId: string;
  oneOffCents: number;
  recurringCents: number;
  currency: "AUD";
  gstTreatment: GstTreatment;
  probability: number | null;
  expectedClose: string | null;
  nextAction: string;
  nextActionDue: string | null;
  closeReason: string;
  stageHistory: StageHistory[];
  legacyLeadId: number | null;
  catalogueId: string | null;
  commercialBasis: "catalogue" | "agreed" | "legacy-unconfirmed";
};
export type TaskStatus = "open" | "in-progress" | "done" | "cancelled";
export type TaskKind =
  | "follow-up"
  | "call"
  | "email"
  | "meeting"
  | "promise"
  | "delivery"
  | "renewal"
  | "other";
export type Task = Versioned & {
  companyId: string;
  dealId: string | null;
  projectId: string | null;
  contactId: string | null;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  owner: OwnerId;
  dueAt: string | null;
  completedAt: string | null;
  legacyLeadId: number | null;
};
export type CommunicationState = "drafted" | "queued" | "sent" | "received" | "failed" | "unknown";
export type ProviderEvidence = {
  provider: string;
  eventId: string;
  observedAt: string;
  state: "sent" | "received" | "failed";
};
export type Activity = {
  id: string;
  ref: CrmRef;
  companyId: string;
  eventId: string;
  kind: string;
  title: string;
  note: string;
  at: string;
  by: Attribution | { legacy: string };
  outcome: string;
  artifact: string | null;
  communicationState: CommunicationState | null;
  externalUrl: string | null;
  providerEvidence?: ProviderEvidence;
};
export type ProjectStatus =
  | "onboarding"
  | "in-progress"
  | "review"
  | "launched"
  | "ongoing"
  | "on-hold"
  | "completed";
export type ProjectMilestone = {
  id: string;
  name: string;
  status: "pending" | "in-progress" | "done";
  dueAt: string | null;
  completedAt: string | null;
  note: string;
};
export type Project = Versioned & {
  companyId: string;
  dealId: string | null;
  name: string;
  owner: OwnerId;
  status: ProjectStatus;
  scope: string;
  contentRequests: string[];
  accessRequests: string[];
  milestones: ProjectMilestone[];
  previewUrls: string[];
  revisionRequests: string[];
  deliverables: string[];
  launchAt: string | null;
  renewalAt: string | null;
  legacyLeadId: number | null;
};
export type DocumentStatus = "draft" | "issued" | "accepted" | "superseded";
export type DocumentPricing = {
  oneOffCents: number;
  recurringCents: number;
  currency: "AUD";
  gstTreatment: GstTreatment;
  catalogueId: string | null;
  dealVersion: number | null;
};
export type DocumentVersion = {
  id: string;
  documentId: string;
  number: number;
  status?: DocumentStatus;
  createdAt: string;
  by: Attribution | { legacy: string };
  content: string;
  /** Directory transport omitted this body; read crm.record.get before showing/editing it. */
  contentDeferred?: boolean;
  artifact: string | null;
  pricing: DocumentPricing | null;
};
export type Document = Versioned & {
  companyId: string;
  dealId: string | null;
  projectId: string | null;
  title: string;
  kind: "proposal" | "agreement" | "invoice-reference" | "brief" | "deliverable" | "other";
  status: DocumentStatus;
  currentVersion: number;
  versions: DocumentVersion[];
  externalUrl: string | null;
};
export type CrmSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  companies: Company[];
  contacts: Contact[];
  deals: Deal[];
  tasks: Task[];
  activities: Activity[];
  projects: Project[];
  documents: Document[];
  pipelines: Pipeline[];
};
export type CompanyInput = Pick<Company, "name"> &
  Partial<Omit<Company, keyof Versioned | "legacyLeadId" | "mergedInto">>;
export type CompanyPatch = Partial<Omit<Company, keyof Versioned | "legacyLeadId" | "mergedInto">>;
export type ContactInput = Pick<Contact, "companyId" | "name"> &
  Partial<Omit<Contact, keyof Versioned | "companyId" | "name">>;
export type ContactPatch = Partial<Omit<Contact, keyof Versioned | "companyId">>;
export type DealInput = Pick<Deal, "companyId" | "title"> &
  Partial<Omit<Deal, keyof Versioned | "companyId" | "title" | "stageHistory" | "legacyLeadId">>;
export type DealPatch = Partial<
  Omit<Deal, keyof Versioned | "companyId" | "stageHistory" | "legacyLeadId">
>;
export type TaskInput = Pick<Task, "companyId" | "title"> &
  Partial<Omit<Task, keyof Versioned | "companyId" | "title" | "legacyLeadId" | "completedAt">>;
export type TaskPatch = Partial<
  Omit<Task, keyof Versioned | "companyId" | "legacyLeadId" | "completedAt">
>;
export type ProjectInput = Pick<Project, "companyId" | "name"> &
  Partial<Omit<Project, keyof Versioned | "companyId" | "name" | "legacyLeadId">>;
export type ProjectPatch = Partial<Omit<Project, keyof Versioned | "companyId" | "legacyLeadId">>;
export type DocumentVersionInput = {
  content?: string;
  artifact?: string | null;
  pricing?: DocumentPricing | null;
};
export type DocumentInput = Pick<Document, "companyId" | "title"> &
  Partial<Omit<Document, keyof Versioned | "companyId" | "title" | "versions" | "currentVersion">> &
  DocumentVersionInput;
export type DocumentPatch = Partial<Pick<Document, "title" | "status" | "externalUrl">>;
export type ActivityInput = {
  ref: CrmRef;
  eventId: string;
  kind: string;
  title: string;
  note?: string;
  at?: string;
  outcome?: string;
  artifact?: string | null;
  communicationState?: CommunicationState | null;
  externalUrl?: string | null;
  providerEvidence?: ProviderEvidence;
};
export type PipelineInput = { id?: string; name: string; stages: PipelineStage[] };
export class CrmError extends Error {
  constructor(
    public code: "not-found" | "conflict" | "validation" | "restricted" | "idempotency-conflict",
    message: string,
  ) {
    super(message);
    this.name = "CrmError";
  }
  get status() {
    return this.code === "not-found"
      ? 404
      : this.code === "conflict" || this.code === "idempotency-conflict"
        ? 409
        : this.code === "restricted"
          ? 403
          : 400;
  }
}
