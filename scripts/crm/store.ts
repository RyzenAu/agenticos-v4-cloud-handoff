/** One authoritative CRM in the existing crm.sqlite. All mutations are atomic and version checked.
 * Responsibility never gates reads: both verified founders operate on the same records.
 * This module performs no network calls, sends, accounting entries, scheduled work or deployments.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { receptionistOnHold } from "./policy";
import { WEBSITE_EX_GST_CENTS } from "../leads/sales-backoffice";
import { crmPath, openCrm } from "../leads/crm";
import { editLead, leadEditVersion } from "../leads/edit";
import { findLead } from "../leads/crm";
import {
  allRecords,
  canonicalCompanyId,
  schemaVersion,
  hasTable,
  insertRecord,
  migrateCrm,
  readRecord,
  refreshLegacyBaseline,
  replaceRecord,
  synchroniseLegacy,
  CRM_SCHEMA_VERSION,
} from "./migrations";
import {
  CrmError,
  DEFAULT_PIPELINE_ID,
  type Activity,
  type ActivityInput,
  type Attribution,
  type Company,
  type CompanyInput,
  type CompanyPatch,
  type Contact,
  type ContactInput,
  type ContactPatch,
  type CrmRef,
  type CrmSnapshot,
  type Deal,
  type DealInput,
  type DealPatch,
  type Document,
  type DocumentInput,
  type DocumentPatch,
  type DocumentVersion,
  type DocumentVersionInput,
  type FieldSources,
  type OwnerId,
  type Pipeline,
  type PipelineInput,
  type Project,
  type ProjectInput,
  type ProjectPatch,
  type Source,
  type Task,
  type TaskInput,
  type TaskPatch,
  type Versioned,
} from "./types";
export type CrmChange = { ref: CrmRef; change: "created" | "updated" | "deleted"; at: string };
export type CrmStoreOptions = {
  root?: string;
  now?: () => string;
  onChange?: (event: CrmChange) => void;
  ownsDatabase?: boolean;
  backupPath?: string;
};
const MANUAL_SOURCE: Source = { kind: "manual", reference: "", attribution: "Founder entry" };
const actor = (by: Attribution): string =>
  "personId" in by ? by.personId : `agent:${by.agent}:${by.jobId}`;
function validActor(by: Attribution): void {
  if (
    !by ||
    typeof by !== "object" ||
    !("personId" in by
      ? ["usman", "mehroz"].includes(by.personId)
      : typeof by.agent === "string" &&
        !!by.agent.trim() &&
        typeof by.jobId === "string" &&
        !!by.jobId.trim())
  )
    throw new CrmError("validation", "A verified founder or attributed agent job is required.");
}
function text(value: unknown, name: string, max = 1000, required = false): string {
  if (typeof value !== "string" || value.length > max || /\u0000/.test(value))
    throw new CrmError("validation", `${name} must be text of at most ${max} characters.`);
  const v = value.trim();
  if (required && !v) throw new CrmError("validation", `${name} is required.`);
  return v;
}
function owner(value: unknown): OwnerId {
  if (!["", "usman", "mehroz"].includes(value as string))
    throw new CrmError("validation", "Choose Usman, Mehroz or unassigned.");
  return value as OwnerId;
}
function list(value: unknown, name: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new CrmError("validation", `${name} must be a list of up to ${max} values.`);
  return [...new Set(value.map((v) => text(v, name, 2000, true)))];
}
function validDate(value: unknown, name: string, dayOnly = false): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new CrmError("validation", `Choose a valid ${name}.`);
  if (dayOnly) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    )
      throw new CrmError("validation", `${name} must be a real calendar date.`);
    return value;
  }
  return new Date(value).toISOString();
}
function url(value: unknown, name: string): string {
  const v = text(value, name, 2000);
  if (!v) return v;
  try {
    const u = new URL(v);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new Error();
  } catch {
    throw new CrmError("validation", `Use a full http or https ${name}.`);
  }
  return v;
}
function email(value: unknown): string {
  const v = text(value, "Email", 254).toLowerCase();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    throw new CrmError("validation", "Enter a valid email address.");
  return v;
}
function phone(value: unknown): string {
  const v = text(value, "Phone", 60);
  if (v && !/^[+\d\s().-]{5,60}$/.test(v))
    throw new CrmError("validation", "Enter a valid phone number.");
  return v;
}
function cents(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100_000_000)
    throw new CrmError("validation", "Amounts must be whole cents between 0 and A$1,000,000.");
  return value as number;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new CrmError("validation", `${name} must be true or false.`);
  return value;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (!choices.includes(value as T)) throw new CrmError("validation", `Choose a valid ${name}.`);
  return value as T;
}
function assertKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CrmError("validation", "Provide an object.");
  const unknown = Object.keys(value).find((k) => !keys.includes(k));
  if (unknown) throw new CrmError("validation", `Unsupported field: ${unknown}.`);
}
function source(value: Source): Source {
  if (!value || typeof value !== "object") throw new CrmError("validation", "Record a source.");
  return {
    kind: oneOf(value.kind, ["manual", "csv", "osm", "google", "enquiry", "legacy"], "source"),
    reference: text(value.reference, "Source reference", 2000),
    attribution: text(value.attribution, "Attribution", 2000),
  };
}
function sources(value: FieldSources): FieldSources {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 50)
    throw new CrmError("validation", "Invalid field provenance.");
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      text(k, "Field", 80, true),
      text(v, "Source", 200, true),
    ]),
  );
}
const COMPANY_KEYS = [
  "name",
  "industry",
  "website",
  "locality",
  "address",
  "timezone",
  "phone",
  "emails",
  "owner",
  "tags",
  "source",
  "fieldSources",
  "status",
  "notes",
  "doNotContact",
  "emailAllowed",
  "excluded",
  "excludedReason",
  "websiteCheck",
  "websiteCheckedAt",
];
const CONTACT_KEYS = [
  "name",
  "role",
  "email",
  "phone",
  "primary",
  "preferences",
  "doNotContact",
  "restrictions",
  "owner",
  "source",
  "fieldSources",
];
const DEAL_KEYS = [
  "title",
  "owner",
  "contactIds",
  "service",
  "scope",
  "pipelineId",
  "stageId",
  "oneOffCents",
  "recurringCents",
  "currency",
  "gstTreatment",
  "probability",
  "expectedClose",
  "nextAction",
  "nextActionDue",
  "closeReason",
  "catalogueId",
  "commercialBasis",
];
const TASK_KEYS = [
  "dealId",
  "projectId",
  "contactId",
  "title",
  "description",
  "kind",
  "status",
  "owner",
  "dueAt",
];
const PROJECT_KEYS = [
  "dealId",
  "name",
  "owner",
  "status",
  "scope",
  "contentRequests",
  "accessRequests",
  "milestones",
  "previewUrls",
  "revisionRequests",
  "deliverables",
  "launchAt",
  "renewalAt",
];
const DOCUMENT_KEYS = [
  "companyId",
  "dealId",
  "projectId",
  "title",
  "kind",
  "status",
  "externalUrl",
  "content",
  "artifact",
  "pricing",
];
export class CrmStore {
  readonly db: Database;
  readonly root?: string;
  private readonly clock: () => string;
  private readonly ownsDatabase: boolean;
  private depth = 0;
  private pending: CrmChange[] = [];
  private listeners = new Set<(event: CrmChange) => void>();
  constructor(db: Database, options: CrmStoreOptions = {}) {
    this.db = db;
    this.root = options.root;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.ownsDatabase = options.ownsDatabase ?? false;
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=4000;");
    migrateCrm(db, this.clock(), { backupPath: options.backupPath });
    // Same suppression registry used by Leads, not a second contact-permission store.
    db.exec(
      "CREATE TABLE IF NOT EXISTS optouts(value TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    );
    if (options.onChange) this.listeners.add(options.onChange);
  }
  close(): void {
    this.listeners.clear();
    if (this.ownsDatabase) this.db.close();
  }
  subscribe(listener: (event: CrmChange) => void): () => void {
    return this.onChange(listener);
  }
  onChange(listener: (event: CrmChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  transaction<T>(fn: () => T): T {
    const start = this.pending.length;
    this.depth++;
    let result: T;
    try {
      result = this.db
        .transaction(() => {
          const value = fn();
          if (value && typeof (value as any).then === "function")
            throw new CrmError("validation", "CRM transactions must be synchronous.");
          return value;
        })
        .immediate();
    } catch (error) {
      this.pending.splice(start);
      throw error;
    } finally {
      this.depth--;
    }
    if (!this.depth) {
      const events = this.pending.splice(0);
      for (const event of events)
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            /* A refresh subscriber must never roll back a committed business edit. */
          }
        }
    }
    return result;
  }
  syncLegacy(): void {
    this.transaction(() => {
      synchroniseLegacy(this.db, this.clock());
      this.refreshRestrictions();
    });
  }
  /** Suppression is shared across all matching addresses/numbers and existing child contacts.
   * Persist effective changes atomically so form versions cannot hide a new restriction.
   * Monotonic closure also suppresses newly discovered contact details without granting consent.
   */
  private refreshRestrictions(): void {
    if (!hasTable(this.db, "optouts")) return;
    const companies = allRecords<Company>(this.db, "crm_companies"),
      contacts = allRecords<Contact>(this.db, "crm_contacts");
    const normal = (v: string) => (v.includes("@") ? v.toLowerCase() : v.replace(/\D/g, ""));
    const denied = new Set(
      (this.db.query("SELECT value FROM optouts").all() as { value: string }[]).map((r) => r.value),
    );
    const dirtyCompanies = new Set<string>(),
      dirtyContacts = new Set<string>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      const add = (values: string[]) => {
        for (const value of values.filter(Boolean).map(normal))
          if (!denied.has(value)) {
            denied.add(value);
            expanded = true;
          }
      };
      for (const company of companies) {
        const values = [company.phone, ...company.emails].filter(Boolean);
        if (company.doNotContact || values.some((v) => denied.has(normal(v)))) {
          if (!company.doNotContact || company.emailAllowed) {
            company.doNotContact = true;
            company.emailAllowed = false;
            dirtyCompanies.add(company.id);
            expanded = true;
          }
          add(values);
          const canonical = canonicalCompanyId(this.db, company.id);
          const kept =
            canonical === company.id ? undefined : companies.find((c) => c.id === canonical);
          if (kept && (!kept.doNotContact || kept.emailAllowed)) {
            kept.doNotContact = true;
            kept.emailAllowed = false;
            dirtyCompanies.add(kept.id);
            expanded = true;
          }
        }
      }
      const suppressedCompanies = new Set(companies.filter((c) => c.doNotContact).map((c) => c.id));
      for (const contact of contacts) {
        const values = [contact.email, contact.phone].filter(Boolean);
        if (
          contact.doNotContact ||
          suppressedCompanies.has(canonicalCompanyId(this.db, contact.companyId)) ||
          values.some((v) => denied.has(normal(v)))
        ) {
          if (!contact.doNotContact) {
            contact.doNotContact = true;
            dirtyContacts.add(contact.id);
            expanded = true;
          }
          add(values);
        }
      }
    }
    for (const value of denied)
      this.db.query("INSERT OR IGNORE INTO optouts(value) VALUES(?)").run(value);
    const persist = (table: string, record: Company | Contact, kind: "company" | "contact") => {
      const before = record.version;
      record.version++;
      record.updatedAt = this.clock();
      if (!replaceRecord(this.db, table, record, before))
        throw new CrmError(
          "conflict",
          "Contact restrictions changed concurrently. Reload the record.",
        );
      this.db
        .query(
          "INSERT INTO crm_mutation_audit(ref_kind,ref_id,at,actor,action,version) VALUES(?,?,?,?,?,?)",
        )
        .run(
          kind,
          record.id,
          record.updatedAt,
          JSON.stringify({ system: "shared-optout" }),
          "restriction-updated",
          record.version,
        );
      this.pending.push({ ref: { kind, id: record.id }, change: "updated", at: record.updatedAt });
    };
    for (const company of companies)
      if (dirtyCompanies.has(company.id)) persist("crm_companies", company, "company");
    for (const contact of contacts)
      if (dirtyContacts.has(contact.id)) persist("crm_contacts", contact, "contact");
    const suppressedIds = new Set(companies.filter((c) => c.doNotContact).map((c) => c.id));
    for (const task of allRecords<Task>(this.db, "crm_tasks")) {
      if (
        task.legacyLeadId === null ||
        task.kind !== "follow-up" ||
        !["open", "in-progress"].includes(task.status) ||
        !suppressedIds.has(task.companyId)
      )
        continue;
      const previous = task.version;
      task.status = "cancelled";
      task.version++;
      task.updatedAt = this.clock();
      replaceRecord(this.db, "crm_tasks", task, previous);
      this.pending.push({
        ref: { kind: "company", id: task.companyId },
        change: "updated",
        at: task.updatedAt,
      });
    }
  }
  snapshot(): CrmSnapshot {
    return this.transaction(() => {
      this.syncLegacy();
      return {
        schemaVersion: CRM_SCHEMA_VERSION,
        generatedAt: this.clock(),
        companies: allRecords<Company>(this.db, "crm_companies"),
        contacts: allRecords<Contact>(this.db, "crm_contacts"),
        deals: allRecords<Deal>(this.db, "crm_deals"),
        tasks: allRecords<Task>(this.db, "crm_tasks"),
        activities: allRecords<Activity>(this.db, "crm_activities").sort((a, b) =>
          b.at.localeCompare(a.at),
        ),
        projects: allRecords<Project>(this.db, "crm_projects"),
        documents: allRecords<Document>(this.db, "crm_documents").map((d) =>
          this.documentVersions(d),
        ),
        pipelines: allRecords<Pipeline>(this.db, "crm_pipelines"),
      };
    });
  }
  private get<T>(table: string, id: string): T | null {
    this.syncLegacy();
    return readRecord<T>(this.db, table, id);
  }
  getCompany(id: string): Company | null {
    return this.get("crm_companies", id);
  }
  getContact(id: string): Contact | null {
    return this.get("crm_contacts", id);
  }
  getDeal(id: string): Deal | null {
    return this.get("crm_deals", id);
  }
  getTask(id: string): Task | null {
    return this.get("crm_tasks", id);
  }
  getProject(id: string): Project | null {
    return this.get("crm_projects", id);
  }
  getPipeline(id: string): Pipeline | null {
    return this.get("crm_pipelines", id);
  }
  getDocument(id: string): Document | null {
    const d = this.get<Document>("crm_documents", id);
    return d ? this.documentVersions(d) : null;
  }
  private documentVersions(d: Document): Document {
    return {
      ...d,
      versions: (
        this.db
          .query("SELECT data FROM crm_document_versions WHERE document_id=? ORDER BY number")
          .all(d.id) as { data: string }[]
      ).map((r) => {
        const version: DocumentVersion = JSON.parse(r.data);
        const status = this.db
          .query(
            "SELECT status FROM crm_document_statuses WHERE document_id=? AND version_number=? ORDER BY id DESC LIMIT 1",
          )
          .get(d.id, version.number) as { status: Document["status"] } | null;
        return { ...version, status: status?.status ?? "draft" };
      }),
    };
  }
  private documentStatus(d: Document, by: Attribution): void {
    this.db
      .query(
        "INSERT INTO crm_document_statuses(document_id,version_number,status,at,actor) VALUES(?,?,?,?,?)",
      )
      .run(d.id, d.currentVersion, d.status, this.clock(), JSON.stringify(by));
  }
  resolveLegacyLead(id: number | string): CrmRef | null {
    this.syncLegacy();
    const row = this.db
      .query("SELECT company_id FROM crm_legacy_links WHERE lead_id=?")
      .get(Number(id)) as { company_id: string } | null;
    return row ? { kind: "company", id: canonicalCompanyId(this.db, row.company_id) } : null;
  }
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db
      .query("SELECT value FROM crm_record_settings WHERE key=?")
      .get(text(key, "Setting key", 200, true)) as { value: string } | null;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  setSetting(key: string, value: unknown): void {
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length > 1_000_000)
      throw new CrmError("validation", "Setting value is missing or too large.");
    this.db
      .query(
        "INSERT INTO crm_record_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(text(key, "Setting key", 200, true), encoded);
  }
  private base(prefix: string): Versioned {
    const at = this.clock();
    return { id: `${prefix}-${randomUUID()}`, version: 1, createdAt: at, updatedAt: at };
  }
  private need<T extends Versioned>(table: string, id: string, version?: number): T {
    const record = readRecord<T>(this.db, table, id);
    if (!record) throw new CrmError("not-found", "This record no longer exists.");
    if (version !== undefined && (!Number.isSafeInteger(version) || record.version !== version))
      throw new CrmError(
        "conflict",
        `This record changed while you were editing (current version ${record.version}). Reload before saving.`,
      );
    return record;
  }
  private save<T extends Versioned>(
    table: string,
    record: T,
    by: Attribution,
    kind: CrmRef["kind"] | CrmRef,
    columns: Record<string, string | number | null> = {},
  ): T {
    const old = record.version;
    record.version++;
    record.updatedAt = this.clock();
    if (!replaceRecord(this.db, table, record, old, columns))
      throw new CrmError(
        "conflict",
        "This record changed while you were editing. Reload before saving.",
      );
    this.audit(
      typeof kind === "string" ? { kind, id: record.id } : kind,
      by,
      "updated",
      record.version,
    );
    return record;
  }
  private audit(
    ref: CrmRef,
    by: Attribution,
    change: "created" | "updated",
    version: number,
  ): void {
    const at = this.clock();
    this.db
      .query(
        "INSERT INTO crm_mutation_audit(ref_kind,ref_id,at,actor,action,version) VALUES(?,?,?,?,?,?)",
      )
      .run(ref.kind, ref.id, at, JSON.stringify(by), change, version);
    this.pending.push({ ref, change, at });
  }
  private optedOut(value: string): boolean {
    if (!value) return false;
    return !!this.db
      .query("SELECT 1 FROM optouts WHERE value=?")
      .get(value.includes("@") ? value.toLowerCase() : value.replace(/\D/g, ""));
  }
  private suppress(values: string[]): void {
    for (const value of values.filter(Boolean))
      this.db
        .query("INSERT OR IGNORE INTO optouts(value) VALUES(?)")
        .run(value.includes("@") ? value.toLowerCase() : value.replace(/\D/g, ""));
  }
  private companyValues(
    c: Company,
    patch: CompanyPatch,
    by: Attribution,
    creating = false,
  ): Company {
    assertKeys(patch, COMPANY_KEYS);
    const next = { ...c, ...patch };
    next.name = text(next.name, "Business name", 400, creating || "name" in patch);
    next.industry = text(next.industry, "Industry", 100);
    next.website = url(next.website, "website");
    next.locality = text(next.locality, "Locality", 400);
    next.address = text(next.address, "Address", 1000);
    next.phone = phone(next.phone);
    next.emails = list(next.emails, "Emails", 20).map(email);
    next.owner = owner(next.owner);
    next.tags = list(next.tags, "Tags", 50);
    next.notes = text(next.notes, "Notes", 20000);
    next.excludedReason = text(next.excludedReason, "Exclusion reason", 2000);
    next.status = oneOf(next.status, ["prospect", "client", "inactive"], "company status");
    next.source = source(next.source);
    next.fieldSources = sources({ ...c.fieldSources, ...next.fieldSources });
    next.timezone = text(next.timezone, "Timezone", 100, true);
    try {
      new Intl.DateTimeFormat("en-AU", { timeZone: next.timezone });
    } catch {
      throw new CrmError("validation", "Choose a valid IANA timezone.");
    }
    next.doNotContact = bool(next.doNotContact, "Do not contact");
    next.emailAllowed = bool(next.emailAllowed, "Email allowed");
    next.excluded = bool(next.excluded, "Excluded");
    if (c.doNotContact && !next.doNotContact)
      throw new CrmError(
        "restricted",
        "An existing opt-out cannot be cleared by an ordinary CRM edit.",
      );
    next.doNotContact ||= [next.phone, ...next.emails].some((v) => this.optedOut(v));
    if (next.doNotContact) {
      next.emailAllowed = false;
      this.suppress([next.phone, ...next.emails]);
    }
    next.websiteCheck = oneOf(
      next.websiteCheck,
      ["found", "none-verified", "check-failed", "search-unavailable", "not-checked"],
      "website check",
    );
    next.websiteCheckedAt = validDate(next.websiteCheckedAt, "website check date");
    if ("website" in patch && next.website !== c.website) {
      next.websiteCheck = next.website ? "found" : "not-checked";
      next.websiteCheckedAt = null;
    }
    // A founder explicitly entering a changed value establishes manual provenance. Agent imports
    // must prove independent origins for Google fields; they cannot turn a display cache permanent.
    for (const key of ["name", "phone", "address", "website", "emails"] as const)
      if (key in patch && "personId" in by) next.fieldSources[key] = "manual";
    if (next.source.kind === "google")
      for (const key of ["name", "phone", "address", "website"] as const)
        if (
          next[key] &&
          (!next.fieldSources[key] ||
            ["google", "places"].includes(next.fieldSources[key].toLowerCase()))
        )
          throw new CrmError(
            "restricted",
            `Google ${key} requires independent non-Places provenance.`,
          );
    return next;
  }
  createCompany(input: CompanyInput, by: Attribution): Company {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      const c: Company = {
        ...this.base("company"),
        name: "",
        industry: "",
        website: "",
        locality: "",
        address: "",
        timezone: "Australia/Sydney",
        phone: "",
        emails: [],
        owner: "",
        tags: [],
        source: { ...MANUAL_SOURCE },
        fieldSources: {},
        status: "prospect",
        notes: "",
        doNotContact: false,
        emailAllowed: false,
        excluded: false,
        excludedReason: "",
        mergedInto: null,
        legacyLeadId: null,
        websiteCheck: "not-checked",
        websiteCheckedAt: null,
      };
      const next = this.companyValues(c, input, by, true);
      insertRecord(this.db, "crm_companies", next, { legacy_lead_id: null });
      this.audit({ kind: "company", id: next.id }, by, "created", 1);
      return next;
    });
  }
  updateCompany(id: string, patch: CompanyPatch, version: number, by: Attribution): Company {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      const old = this.need<Company>("crm_companies", id, version);
      const next = this.companyValues(old, patch, by);
      this.save("crm_companies", next, by, "company");
      this.writeLegacyCompany(old, next, by);
      return next;
    });
  }
  private writeLegacyCompany(old: Company, next: Company, by: Attribution): void {
    if (next.legacyLeadId === null || !hasTable(this.db, "leads")) return;
    const lead = findLead(this.db, next.legacyLeadId);
    if (!lead) return;
    if (!("personId" in by))
      throw new CrmError(
        "restricted",
        "Legacy business corrections require a verified founder. Agents may add attributed activities.",
      );
    const patch: Record<string, unknown> = { by: by.personId, version: leadEditVersion(lead) };
    for (const key of ["name", "phone", "address", "website", "emails", "owner"] as const)
      if (JSON.stringify(old[key]) !== JSON.stringify(next[key])) patch[key] = next[key];
    if (old.locality !== next.locality) patch.area = next.locality;
    if (next.doNotContact) patch.status = "do_not_contact";
    if (Object.keys(patch).length > 2) editLead(this.db, next.legacyLeadId, patch);
    this.db
      .query("UPDATE leads SET excluded=?,excluded_reason=?,email_ok=? WHERE id=?")
      .run(
        next.excluded ? 1 : 0,
        next.excludedReason,
        next.emailAllowed && !next.doNotContact ? 1 : 0,
        next.legacyLeadId,
      );
    refreshLegacyBaseline(this.db, next.legacyLeadId);
  }
  private contactValues(c: Contact, patch: ContactPatch, by: Attribution): Contact {
    assertKeys(patch, CONTACT_KEYS);
    const next = { ...c, ...patch };
    next.name = text(next.name, "Contact name", 300, true);
    next.role = text(next.role, "Role", 300);
    next.email = email(next.email);
    next.phone = phone(next.phone);
    next.primary = bool(next.primary, "Primary contact");
    next.preferences = text(next.preferences, "Preferences", 2000);
    next.restrictions = list(next.restrictions, "Restrictions", 30);
    next.owner = owner(next.owner);
    next.source = source(next.source);
    next.fieldSources = sources({ ...c.fieldSources, ...next.fieldSources });
    next.doNotContact = bool(next.doNotContact, "Do not contact");
    if (c.doNotContact && !next.doNotContact)
      throw new CrmError(
        "restricted",
        "An existing contact opt-out cannot be removed by an ordinary edit.",
      );
    const company = this.need<Company>("crm_companies", c.companyId);
    next.doNotContact ||=
      company.doNotContact || this.optedOut(next.email) || this.optedOut(next.phone);
    if (next.doNotContact) this.suppress([next.email, next.phone]);
    for (const key of ["name", "email", "phone"] as const)
      if (key in patch && "personId" in by) next.fieldSources[key] = "manual";
    if (next.source.kind === "google")
      for (const key of ["name", "email", "phone"] as const)
        if (
          next[key] &&
          (!next.fieldSources[key] ||
            ["google", "places"].includes(next.fieldSources[key].toLowerCase()))
        )
          throw new CrmError(
            "restricted",
            `Google contact ${key} requires independent non-Places provenance.`,
          );
    return next;
  }
  private unprimary(companyId: string, exceptId: string, by: Attribution): void {
    for (const contact of allRecords<Contact>(this.db, "crm_contacts"))
      if (contact.companyId === companyId && contact.primary && contact.id !== exceptId) {
        contact.primary = false;
        this.save("crm_contacts", contact, by, "contact");
      }
  }
  createContact(input: ContactInput, by: Attribution): Contact {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      assertKeys(input, ["companyId", ...CONTACT_KEYS]);
      this.need<Company>("crm_companies", input.companyId);
      const c: Contact = {
        ...this.base("contact"),
        companyId: input.companyId,
        name: "",
        role: "",
        email: "",
        phone: "",
        primary: false,
        preferences: "",
        doNotContact: false,
        restrictions: [],
        owner: "",
        source: { ...MANUAL_SOURCE },
        fieldSources: {},
      };
      const { companyId, ...patch } = input;
      const next = this.contactValues(c, patch, by);
      if (next.primary) this.unprimary(companyId, next.id, by);
      insertRecord(this.db, "crm_contacts", next, { company_id: companyId });
      this.audit({ kind: "contact", id: next.id }, by, "created", 1);
      return next;
    });
  }
  updateContact(id: string, patch: ContactPatch, version: number, by: Attribution): Contact {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      const next = this.contactValues(this.need<Contact>("crm_contacts", id, version), patch, by);
      if (next.primary) this.unprimary(next.companyId, id, by);
      return this.save("crm_contacts", next, by, "contact");
    });
  }
  private related(companyId: string, table: string, id: string | null): void {
    if (!id) return;
    const related = this.need<Versioned & { companyId: string }>(table, id);
    if (related.companyId !== companyId)
      throw new CrmError("validation", "Linked records must belong to the same company.");
  }
  private dealValues(d: Deal, patch: DealPatch, by: Attribution, creating = false): Deal {
    assertKeys(patch, DEAL_KEYS);
    const next = { ...d, ...patch };
    next.title = text(next.title, "Deal title", 400, true);
    next.owner = owner(next.owner);
    next.contactIds = list(next.contactIds, "Contacts", 50);
    next.service = text(next.service, "Service", 200, true);
    next.scope = text(next.scope, "Scope", 20000);
    next.oneOffCents = cents(next.oneOffCents);
    next.recurringCents = cents(next.recurringCents);
    next.currency = oneOf(next.currency, ["AUD"], "currency");
    next.gstTreatment = oneOf(
      next.gstTreatment,
      ["inclusive", "exclusive", "not-applicable"],
      "GST treatment",
    );
    next.commercialBasis = oneOf(
      next.commercialBasis,
      ["catalogue", "agreed", "legacy-unconfirmed"],
      "commercial basis",
    );
    if (
      next.probability !== null &&
      (typeof next.probability !== "number" ||
        !Number.isFinite(next.probability) ||
        next.probability < 0 ||
        next.probability > 1)
    )
      throw new CrmError("validation", "Probability must be between 0 and 1.");
    if (next.legacyLeadId !== null && next.gstTreatment === "not-applicable")
      throw new CrmError(
        "restricted",
        "Legacy Leads pricing is GST-taxable. Keep inclusive or exclusive GST for linked deals so old proposals and CRM agree.",
      );
    next.expectedClose = validDate(next.expectedClose, "expected close", true);
    next.nextActionDue = validDate(next.nextActionDue, "next action date");
    next.nextAction = text(next.nextAction, "Next action", 2000);
    next.closeReason = text(next.closeReason, "Won/lost reason", 4000);
    next.catalogueId =
      next.catalogueId === null ? null : text(next.catalogueId, "Catalogue ID", 100, true);
    for (const id of next.contactIds) this.related(next.companyId, "crm_contacts", id);
    const pipeline = this.need<Pipeline>("crm_pipelines", next.pipelineId);
    const stage = pipeline.stages.find((s) => s.id === next.stageId);
    if (
      !stage ||
      (stage.archived &&
        (creating || next.stageId !== d.stageId || next.pipelineId !== d.pipelineId))
    )
      throw new CrmError("validation", "Choose an active pipeline stage.");
    const moving = creating || next.stageId !== d.stageId || next.pipelineId !== d.pipelineId;
    if (moving && stage.category === "lost" && !next.closeReason)
      throw new CrmError("validation", "Record why this opportunity was lost.");
    if (moving)
      next.stageHistory = [
        ...d.stageHistory,
        {
          stageId: stage.id,
          stageName: stage.name,
          at: this.clock(),
          by,
          reason: next.closeReason,
        },
      ];
    return next;
  }
  private dealContacts(deal: Deal): void {
    this.db.query("DELETE FROM crm_deal_contacts WHERE deal_id=?").run(deal.id);
    for (const id of deal.contactIds)
      this.db
        .query("INSERT INTO crm_deal_contacts(deal_id,contact_id) VALUES(?,?)")
        .run(deal.id, id);
  }
  createDeal(input: DealInput, by: Attribution): Deal {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      assertKeys(input, ["companyId", ...DEAL_KEYS]);
      this.need<Company>("crm_companies", input.companyId);
      const d: Deal = {
        ...this.base("deal"),
        companyId: input.companyId,
        title: "",
        owner: "",
        contactIds: [],
        service: "website",
        scope: "",
        pipelineId: DEFAULT_PIPELINE_ID,
        stageId: "new",
        oneOffCents: WEBSITE_EX_GST_CENTS,
        recurringCents: 0,
        currency: "AUD",
        gstTreatment: "exclusive",
        probability: null,
        expectedClose: null,
        nextAction: "",
        nextActionDue: null,
        closeReason: "",
        stageHistory: [],
        legacyLeadId: null,
        catalogueId: "website",
        commercialBasis: "catalogue",
      };
      const { companyId, ...patch } = input;
      const next = this.dealValues(d, patch, by, true);
      insertRecord(this.db, "crm_deals", next, {
        company_id: companyId,
        pipeline_id: next.pipelineId,
        stage_id: next.stageId,
        legacy_lead_id: null,
      });
      this.dealContacts(next);
      this.audit({ kind: "deal", id: next.id }, by, "created", 1);
      return next;
    });
  }
  updateDeal(id: string, patch: DealPatch, version: number, by: Attribution): Deal {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      const old = this.need<Deal>("crm_deals", id, version);
      const next = this.dealValues(old, patch, by);
      this.save("crm_deals", next, by, "deal", {
        pipeline_id: next.pipelineId,
        stage_id: next.stageId,
      });
      this.dealContacts(next);
      this.writeLegacyDeal(old, next, by);
      return next;
    });
  }
  moveDeal(id: string, stageId: string, version: number, by: Attribution, reason?: string): Deal {
    return this.updateDeal(
      id,
      { stageId, ...(reason === undefined ? {} : { closeReason: reason }) },
      version,
      by,
    );
  }
  private writeLegacyDeal(old: Deal, next: Deal, by: Attribution): void {
    if (next.legacyLeadId === null || !hasTable(this.db, "lead_deals")) return;
    const cols = this.db.query("PRAGMA table_info(lead_deals)").all() as { name: string }[];
    // Keep exact agreed numbers. New CRM GST treatment is explicit; legacy economics are ex GST.
    const toExclusive = (value: number) =>
      next.gstTreatment === "inclusive" ? value - Math.round(value / 11) : value;
    this.db
      .query(
        "INSERT INTO lead_deals(lead_id,offer,setup_cents,monthly_cents,probability,expected_close,updated_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET offer=excluded.offer,setup_cents=excluded.setup_cents,monthly_cents=excluded.monthly_cents,probability=excluded.probability,expected_close=excluded.expected_close,updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
      )
      .run(
        next.legacyLeadId,
        ["website", "redesign", "receptionist", "both"].includes(next.service)
          ? next.service
          : null,
        toExclusive(next.oneOffCents),
        toExclusive(next.recurringCents),
        next.probability,
        next.expectedClose,
        actor(by),
      );
    if (cols.some((c) => c.name === "package_id") && /^receptionist-/.test(next.catalogueId ?? ""))
      this.db
        .query("UPDATE lead_deals SET package_id=? WHERE lead_id=?")
        .run(next.catalogueId, next.legacyLeadId);
    if (old.owner !== next.owner)
      this.db.query("UPDATE leads SET owner=? WHERE id=?").run(next.owner, next.legacyLeadId);
    if (old.nextActionDue !== next.nextActionDue)
      this.db
        .query("UPDATE leads SET next_at=? WHERE id=?")
        .run(next.nextActionDue, next.legacyLeadId);
    // Sales lifecycle belongs to the opportunity. Do not turn the company or other opportunities
    // into closed records, or overwrite a legacy opt-out when a deal is moved.
    if (old.stageId !== next.stageId && next.pipelineId === "sales") {
      const status = (
        {
          new: "new",
          qualified: "interested",
          contacted: "emailed",
          meeting: "meeting",
          proposal: "proposal",
          negotiation: "proposal",
          won: "won",
          lost: "lost",
        } as Record<string, string>
      )[next.stageId];
      if (status)
        this.db
          .query("UPDATE leads SET status=? WHERE id=? AND status<>'do_not_contact'")
          .run(status, next.legacyLeadId);
    }
    refreshLegacyBaseline(this.db, next.legacyLeadId);
  }
  private taskValues(t: Task, patch: TaskPatch): Task {
    assertKeys(patch, TASK_KEYS);
    const next = { ...t, ...patch };
    next.title = text(next.title, "Task title", 500, true);
    next.description = text(next.description, "Task description", 10000);
    next.owner = owner(next.owner);
    next.kind = oneOf(
      next.kind,
      ["follow-up", "call", "email", "meeting", "promise", "delivery", "renewal", "other"],
      "task kind",
    );
    next.status = oneOf(next.status, ["open", "in-progress", "done", "cancelled"], "task status");
    next.dueAt = validDate(next.dueAt, "due date");
    next.completedAt = next.status === "done" ? (t.completedAt ?? this.clock()) : null;
    this.related(next.companyId, "crm_deals", next.dealId);
    this.related(next.companyId, "crm_projects", next.projectId);
    this.related(next.companyId, "crm_contacts", next.contactId);
    return next;
  }
  createTask(input: TaskInput, by: Attribution): Task {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      assertKeys(input, ["companyId", ...TASK_KEYS]);
      this.need<Company>("crm_companies", input.companyId);
      const t: Task = {
        ...this.base("task"),
        companyId: input.companyId,
        dealId: null,
        projectId: null,
        contactId: null,
        title: "",
        description: "",
        kind: "follow-up",
        status: "open",
        owner: "",
        dueAt: null,
        completedAt: null,
        legacyLeadId: null,
      };
      const { companyId, ...patch } = input;
      const next = this.taskValues(t, patch);
      insertRecord(this.db, "crm_tasks", next, {
        company_id: companyId,
        deal_id: next.dealId,
        project_id: next.projectId,
        contact_id: next.contactId,
      });
      this.audit({ kind: "company", id: companyId }, by, "updated", 1);
      return next;
    });
  }
  updateTask(id: string, patch: TaskPatch, version: number, by: Attribution): Task {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      const next = this.taskValues(this.need<Task>("crm_tasks", id, version), patch);
      this.save(
        "crm_tasks",
        next,
        by,
        { kind: "company", id: next.companyId },
        { deal_id: next.dealId, project_id: next.projectId, contact_id: next.contactId },
      );
      if (next.legacyLeadId !== null && hasTable(this.db, "leads")) {
        this.db
          .query("UPDATE leads SET next_at=?,owner=? WHERE id=?")
          .run(
            ["done", "cancelled"].includes(next.status) ? null : next.dueAt,
            next.owner,
            next.legacyLeadId,
          );
        refreshLegacyBaseline(this.db, next.legacyLeadId);
      }
      return next;
    });
  }
  private projectValues(p: Project, patch: ProjectPatch): Project {
    assertKeys(patch, PROJECT_KEYS);
    const next = { ...p, ...patch };
    next.name = text(next.name, "Project name", 500, true);
    next.owner = owner(next.owner);
    next.status = oneOf(
      next.status,
      ["onboarding", "in-progress", "review", "launched", "ongoing", "on-hold", "completed"],
      "project status",
    );
    next.scope = text(next.scope, "Agreed scope", 20000);
    for (const key of [
      "contentRequests",
      "accessRequests",
      "revisionRequests",
      "deliverables",
    ] as const)
      next[key] = list(next[key], key);
    next.previewUrls = list(next.previewUrls, "Preview links", 30).map((v) =>
      url(v, "preview URL"),
    );
    next.launchAt = validDate(next.launchAt, "launch date");
    next.renewalAt = validDate(next.renewalAt, "renewal date");
    if (!Array.isArray(next.milestones) || next.milestones.length > 100)
      throw new CrmError("validation", "Use at most 100 milestones.");
    next.milestones = next.milestones.map((m) => ({
      id: text(m.id, "Milestone ID", 100, true),
      name: text(m.name, "Milestone name", 500, true),
      status: oneOf(m.status, ["pending", "in-progress", "done"], "milestone status"),
      dueAt: validDate(m.dueAt, "milestone due date"),
      completedAt:
        m.status === "done"
          ? (validDate(m.completedAt, "milestone completion date") ?? this.clock())
          : null,
      note: text(m.note, "Milestone note", 5000),
    }));
    if (new Set(next.milestones.map((m) => m.id)).size !== next.milestones.length)
      throw new CrmError("validation", "Milestone IDs must be unique.");
    this.related(next.companyId, "crm_deals", next.dealId);
    if (next.dealId) {
      const deal = this.need<Deal>("crm_deals", next.dealId);
      if (receptionistOnHold(deal) && next.status !== "on-hold")
        throw new CrmError("restricted", "Receptionist delivery remains on hold.");
      const other = this.db
        .query("SELECT id FROM crm_projects WHERE deal_id=? AND id<>?")
        .get(next.dealId, next.id);
      if (other)
        throw new CrmError(
          "conflict",
          "This opportunity already has an onboarding/delivery project.",
        );
    }
    return next;
  }
  createProject(input: ProjectInput, by: Attribution): Project {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      assertKeys(input, ["companyId", ...PROJECT_KEYS]);
      this.need<Company>("crm_companies", input.companyId);
      const p: Project = {
        ...this.base("project"),
        companyId: input.companyId,
        dealId: null,
        name: "",
        owner: "",
        status: "onboarding",
        scope: "",
        contentRequests: [],
        accessRequests: [],
        milestones: [],
        previewUrls: [],
        revisionRequests: [],
        deliverables: [],
        launchAt: null,
        renewalAt: null,
        legacyLeadId: null,
      };
      const { companyId, ...patch } = input;
      const next = this.projectValues(p, patch);
      insertRecord(this.db, "crm_projects", next, { company_id: companyId, deal_id: next.dealId });
      this.audit({ kind: "project", id: next.id }, by, "created", 1);
      return next;
    });
  }
  updateProject(id: string, patch: ProjectPatch, version: number, by: Attribution): Project {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      const next = this.projectValues(this.need<Project>("crm_projects", id, version), patch);
      this.save("crm_projects", next, by, "project", { deal_id: next.dealId });
      if (next.legacyLeadId !== null && hasTable(this.db, "kickoffs")) {
        const old = this.db
          .query("SELECT checklist FROM kickoffs WHERE lead_id=?")
          .get(next.legacyLeadId) as { checklist: string } | null;
        if (old) {
          let checklist: Record<string, unknown> = {};
          try {
            checklist = JSON.parse(old.checklist);
          } catch {
            /* preserve the raw original in its prior backup */
          }
          checklist.scope = next.scope;
          checklist.milestones = next.milestones.map((m) => ({
            name: m.name,
            state: m.status === "in-progress" ? "partial" : m.status,
            note: m.note,
            due: m.dueAt ?? undefined,
            completedAt: m.completedAt ?? undefined,
          }));
          this.db
            .query("UPDATE kickoffs SET scope=?,checklist=?,by=? WHERE lead_id=?")
            .run(next.scope, JSON.stringify(checklist), actor(by), next.legacyLeadId);
          refreshLegacyBaseline(this.db, next.legacyLeadId);
        }
      }
      return next;
    });
  }
  private companyForRef(ref: CrmRef): string {
    if (!ref || typeof ref.id !== "string" || !ref.id)
      throw new CrmError("validation", "Choose a CRM record.");
    if (ref.kind === "lead") {
      const resolved = this.resolveLegacyLead(ref.id);
      if (!resolved) throw new CrmError("not-found", "Legacy lead not found.");
      return resolved.id;
    }
    if (ref.kind === "company")
      return canonicalCompanyId(this.db, this.need<Company>("crm_companies", ref.id).id);
    const table = (
      {
        contact: "crm_contacts",
        deal: "crm_deals",
        project: "crm_projects",
        document: "crm_documents",
      } as const
    )[ref.kind];
    if (!table) throw new CrmError("validation", "Unknown CRM record kind.");
    return this.need<Versioned & { companyId: string }>(table, ref.id).companyId;
  }
  private artifact(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    const v = text(value, "Artifact reference", 2000, true);
    if (
      !/^artifact:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_. /-]+)?$/.test(v) ||
      v.includes("..") ||
      v.includes("\\")
    )
      throw new CrmError(
        "validation",
        "Use an existing artifact:<jobId> or artifact:<jobId>/<file> reference.",
      );
    return v;
  }
  addActivity(input: ActivityInput, by: Attribution): Activity {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      assertKeys(input, [
        "ref",
        "eventId",
        "kind",
        "title",
        "note",
        "at",
        "outcome",
        "artifact",
        "communicationState",
        "externalUrl",
        "providerEvidence",
      ]);
      const companyId = this.companyForRef(input.ref),
        eventId = text(input.eventId, "Event ID", 300, true);
      const sameEvent = this.db
        .query("SELECT data FROM crm_activities WHERE event_id=?")
        .get(eventId) as { data: string } | null;
      const sameProvider = input.providerEvidence
        ? (this.db
            .query(
              "SELECT data FROM crm_activities WHERE json_extract(data,'$.providerEvidence.provider')=? AND json_extract(data,'$.providerEvidence.eventId')=?",
            )
            .get(input.providerEvidence.provider, input.providerEvidence.eventId) as {
            data: string;
          } | null)
        : null;
      const existing = sameEvent ?? sameProvider;
      if (
        sameEvent &&
        sameProvider &&
        JSON.parse(sameEvent.data).id !== JSON.parse(sameProvider.data).id
      )
        throw new CrmError(
          "idempotency-conflict",
          "Activity and provider event IDs belong to different saved events.",
        );
      if (existing) {
        const prior: Activity = JSON.parse(existing.data);
        const same =
          prior.companyId === companyId &&
          prior.ref.kind === input.ref.kind &&
          prior.ref.id === input.ref.id &&
          prior.kind === text(input.kind, "Activity kind", 100, true) &&
          prior.title === text(input.title, "Activity title", 500, true) &&
          prior.note === text(input.note ?? "", "Activity note", 20000) &&
          prior.outcome === text(input.outcome ?? "", "Outcome", 500) &&
          prior.artifact === this.artifact(input.artifact) &&
          prior.communicationState === (input.communicationState ?? null) &&
          prior.externalUrl ===
            (input.externalUrl == null ? null : url(input.externalUrl, "external link")) &&
          !("legacy" in prior.by) &&
          actor(prior.by) === actor(by) &&
          JSON.stringify(prior.providerEvidence ?? null) ===
            JSON.stringify(input.providerEvidence ?? null) &&
          (input.at === undefined || prior.at === validDate(input.at, "activity date"));
        if (!same)
          throw new CrmError(
            "idempotency-conflict",
            "This event ID was already used with different activity details. Use a new event ID for a new event.",
          );
        return prior;
      }
      const state =
        input.communicationState == null
          ? null
          : oneOf(
              input.communicationState,
              ["drafted", "queued", "sent", "received", "failed", "unknown"],
              "communication state",
            );
      const evidence = input.providerEvidence;
      if ((state === "sent" || state === "received") && (!evidence || evidence.state !== state))
        throw new CrmError(
          "validation",
          "Sent or received requires verified provider evidence. Use unknown for an unconfirmed outcome.",
        );
      if (evidence) {
        text(evidence.provider, "Provider", 100, true);
        text(evidence.eventId, "Provider event ID", 300, true);
        validDate(evidence.observedAt, "provider evidence date");
        oneOf(evidence.state, ["sent", "received", "failed"], "provider state");
      }
      const activity: Activity = {
        id: `activity-${randomUUID()}`,
        companyId,
        ref: { ...input.ref },
        eventId,
        kind: text(input.kind, "Activity kind", 100, true),
        title: text(input.title, "Activity title", 500, true),
        note: text(input.note ?? "", "Activity note", 20000),
        at:
          input.at === undefined
            ? this.clock()
            : (validDate(input.at, "activity date") ?? this.clock()),
        by,
        outcome: text(input.outcome ?? "", "Outcome", 500),
        artifact: this.artifact(input.artifact),
        communicationState: state,
        externalUrl: input.externalUrl == null ? null : url(input.externalUrl, "external link"),
        ...(evidence ? { providerEvidence: { ...evidence } } : {}),
      };
      this.db
        .query(
          "INSERT INTO crm_activities(id,event_id,company_id,ref_kind,ref_id,at,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          activity.id,
          eventId,
          companyId,
          activity.ref.kind,
          activity.ref.id,
          activity.at,
          JSON.stringify(activity),
        );
      // The old Leads timeline remains a projection of activity on a legacy company. Its existing
      // activity_events table is used, preventing an old dictation/webhook retry from duplicating it.
      const company = this.need<Company>("crm_companies", companyId);
      if (
        company.legacyLeadId !== null &&
        hasTable(this.db, "activities") &&
        hasTable(this.db, "activity_events")
      ) {
        const prior = this.db.query("SELECT 1 FROM activity_events WHERE event_id=?").get(eventId);
        if (!prior) {
          const row = this.db
            .query("INSERT INTO activities(lead_id,at,kind,outcome,note,by) VALUES(?,?,?,?,?,?)")
            .run(
              company.legacyLeadId,
              activity.at,
              activity.kind,
              activity.outcome,
              `${activity.title}${activity.note ? `\n${activity.note}` : ""}`,
              actor(by),
            );
          this.db
            .query("INSERT INTO activity_events(event_id,activity_id,lead_id) VALUES(?,?,?)")
            .run(eventId, row.lastInsertRowid, company.legacyLeadId);
        }
      }
      this.audit(activity.ref, by, "updated", 0);
      return activity;
    });
  }
  private documentVersion(
    document: Document,
    input: DocumentVersionInput,
    by: Attribution,
  ): DocumentVersion {
    assertKeys(input, ["content", "artifact", "pricing"]);
    const previous = this.documentVersions(document).versions.at(-1);
    const pricing = input.pricing === undefined ? (previous?.pricing ?? null) : input.pricing;
    if (pricing) {
      cents(pricing.oneOffCents);
      cents(pricing.recurringCents);
      oneOf(pricing.currency, ["AUD"], "currency");
      oneOf(pricing.gstTreatment, ["inclusive", "exclusive", "not-applicable"], "GST treatment");
      if (
        pricing.dealVersion !== null &&
        (!Number.isSafeInteger(pricing.dealVersion) || pricing.dealVersion < 1)
      )
        throw new CrmError("validation", "Invalid pricing deal version.");
    }
    const content =
      input.content === undefined
        ? (previous?.content ?? "")
        : text(input.content, "Document content", 200000);
    const artifact =
      input.artifact === undefined ? (previous?.artifact ?? null) : this.artifact(input.artifact);
    if (!content && !artifact && !document.externalUrl)
      throw new CrmError(
        "validation",
        "Provide document content, an artifact, or a linked document.",
      );
    return {
      id: `document-version-${randomUUID()}`,
      documentId: document.id,
      number: document.currentVersion + 1,
      createdAt: this.clock(),
      by,
      content,
      artifact,
      pricing: pricing ? structuredClone(pricing) : null,
    };
  }
  createDocument(input: DocumentInput, by: Attribution): Document {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      assertKeys(input, DOCUMENT_KEYS);
      this.need<Company>("crm_companies", input.companyId);
      this.related(input.companyId, "crm_deals", input.dealId ?? null);
      this.related(input.companyId, "crm_projects", input.projectId ?? null);
      const d: Document = {
        ...this.base("document"),
        companyId: input.companyId,
        dealId: input.dealId ?? null,
        projectId: input.projectId ?? null,
        title: text(input.title, "Document title", 500, true),
        kind: oneOf(
          input.kind ?? "other",
          ["proposal", "agreement", "invoice-reference", "brief", "deliverable", "other"],
          "document kind",
        ),
        status: oneOf(
          input.status ?? "draft",
          ["draft", "issued", "accepted", "superseded"],
          "document status",
        ),
        currentVersion: 0,
        versions: [],
        externalUrl: input.externalUrl == null ? null : url(input.externalUrl, "document URL"),
      };
      insertRecord(this.db, "crm_documents", d, {
        company_id: d.companyId,
        deal_id: d.dealId,
        project_id: d.projectId,
      });
      const version = this.documentVersion(
        d,
        { content: input.content, artifact: input.artifact, pricing: input.pricing },
        by,
      );
      this.db
        .query("INSERT INTO crm_document_versions(id,document_id,number,data) VALUES(?,?,?,?)")
        .run(version.id, d.id, version.number, JSON.stringify(version));
      d.currentVersion = 1;
      this.documentStatus(d, by);
      replaceRecord(this.db, "crm_documents", d, 1);
      this.audit({ kind: "document", id: d.id }, by, "created", 1);
      return this.documentVersions(d);
    });
  }
  updateDocument(id: string, patch: DocumentPatch, version: number, by: Attribution): Document {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      assertKeys(patch, ["title", "status", "externalUrl"]);
      const next = { ...this.need<Document>("crm_documents", id, version), ...patch };
      next.title = text(next.title, "Document title", 500, true);
      next.status = oneOf(
        next.status,
        ["draft", "issued", "accepted", "superseded"],
        "document status",
      );
      next.externalUrl = next.externalUrl === null ? null : url(next.externalUrl, "document URL");
      this.save("crm_documents", next, by, "document");
      if ("status" in patch) this.documentStatus(next, by);
      return this.documentVersions(next);
    });
  }
  addDocumentVersion(
    id: string,
    input: DocumentVersionInput,
    version: number,
    by: Attribution,
  ): Document {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      const d = this.need<Document>("crm_documents", id, version);
      const next = this.documentVersion(d, input, by);
      this.db
        .query("INSERT INTO crm_document_versions(id,document_id,number,data) VALUES(?,?,?,?)")
        .run(next.id, d.id, next.number, JSON.stringify(next));
      d.currentVersion = next.number;
      d.status = "draft";
      this.documentStatus(d, by);
      this.save("crm_documents", d, by, "document");
      return this.documentVersions(d);
    });
  }
  savePipeline(input: PipelineInput, version: number, by: Attribution): Pipeline {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      assertKeys(input, ["id", "name", "stages"]);
      const id = input.id ?? DEFAULT_PIPELINE_ID;
      let prior = readRecord<Pipeline>(this.db, "crm_pipelines", id);
      if (prior && prior.version !== version)
        throw new CrmError("conflict", "This pipeline changed. Reload before saving.");
      if (!prior && version !== 0) throw new CrmError("not-found", "Pipeline not found.");
      if (!Array.isArray(input.stages) || input.stages.length < 2 || input.stages.length > 50)
        throw new CrmError("validation", "Provide 2–50 pipeline stages.");
      const stages = input.stages.map((s) => {
        const probability = s.probability;
        if (
          typeof probability !== "number" ||
          !Number.isFinite(probability) ||
          probability < 0 ||
          probability > 1
        )
          throw new CrmError("validation", "Stage probability must be between 0 and 1.");
        const category = oneOf(s.category, ["open", "won", "lost"], "stage category");
        if ((category === "won" && probability !== 1) || (category === "lost" && probability !== 0))
          throw new CrmError(
            "validation",
            "Won stages have probability 1; lost stages have probability 0.",
          );
        return {
          id: text(s.id, "Stage ID", 100, true),
          name: text(s.name, "Stage name", 100, true),
          category,
          probability,
          archived: bool(s.archived, "Archived"),
        };
      });
      if (new Set(stages.map((s) => s.id)).size !== stages.length)
        throw new CrmError("validation", "Stage IDs must be unique.");
      if (
        !["open", "won", "lost"].every((c) => stages.some((s) => s.category === c && !s.archived))
      )
        throw new CrmError("validation", "Keep an active open, won and lost stage.");
      // Removed stages remain archived so old histories and deal references never break.
      for (const old of prior?.stages ?? []) {
        const next = stages.find((s) => s.id === old.id);
        if (!next) stages.push({ ...old, archived: true });
        else if (
          next.category !== old.category &&
          this.db
            .query("SELECT 1 FROM crm_deals WHERE pipeline_id=? AND stage_id=?")
            .get(id, old.id)
        )
          throw new CrmError(
            "validation",
            "A stage with deals cannot change outcome category. Add a new stage instead.",
          );
      }
      const at = this.clock();
      const pipeline: Pipeline = {
        id,
        version: prior ? prior.version + 1 : 1,
        createdAt: prior?.createdAt ?? at,
        updatedAt: at,
        name: text(input.name, "Pipeline name", 150, true),
        stages,
      };
      if (prior) {
        if (!replaceRecord(this.db, "crm_pipelines", pipeline, version))
          throw new CrmError("conflict", "Pipeline changed.");
      } else insertRecord(this.db, "crm_pipelines", pipeline);
      for (const [index, stage] of stages.entries())
        this.db
          .query(
            "INSERT INTO crm_pipeline_stages(id,pipeline_id,ordinal,name,category,archived) VALUES(?,?,?,?,?,?) ON CONFLICT(pipeline_id,id) DO UPDATE SET ordinal=excluded.ordinal,name=excluded.name,category=excluded.category,archived=excluded.archived",
          )
          .run(stage.id, id, index, stage.name, stage.category, stage.archived ? 1 : 0);
      this.db
        .query(
          "INSERT INTO crm_mutation_audit(ref_kind,ref_id,at,actor,action,version) VALUES('pipeline',?,?,?,?,?)",
        )
        .run(id, at, JSON.stringify(by), prior ? "updated" : "created", pipeline.version);
      for (const deal of allRecords<Deal>(this.db, "crm_deals"))
        if (deal.pipelineId === id)
          this.pending.push({ ref: { kind: "deal", id: deal.id }, change: "updated", at });
      return pipeline;
    });
  }
  mergeCompanies(
    keepId: string,
    mergeId: string,
    keepVersion: number,
    mergeVersion: number,
    by: Attribution,
  ): Company {
    return this.transaction(() => {
      validActor(by);
      this.syncLegacy();
      if (keepId === mergeId) throw new CrmError("validation", "Choose two different companies.");
      const keep = this.need<Company>("crm_companies", keepId, keepVersion),
        duplicate = this.need<Company>("crm_companies", mergeId, mergeVersion);
      if (keep.mergedInto || duplicate.mergedInto)
        throw new CrmError(
          "conflict",
          "One of these companies was already merged. Refresh duplicate review.",
        );
      const before = structuredClone(keep);
      for (const key of ["phone", "address", "website", "locality", "industry"] as const)
        if (!keep[key] && duplicate[key]) {
          keep[key] = duplicate[key];
          if (duplicate.fieldSources[key]) keep.fieldSources[key] = duplicate.fieldSources[key];
        }
      keep.emails = [...new Set([...keep.emails, ...duplicate.emails])];
      keep.tags = [...new Set([...keep.tags, ...duplicate.tags])];
      keep.doNotContact ||= duplicate.doNotContact;
      keep.excluded ||= duplicate.excluded;
      if (duplicate.excludedReason)
        keep.excludedReason = [keep.excludedReason, duplicate.excludedReason]
          .filter(Boolean)
          .join("; ");
      if (keep.doNotContact) {
        keep.emailAllowed = false;
        this.suppress([keep.phone, ...keep.emails]);
      }
      keep.notes = [
        keep.notes,
        duplicate.notes,
        `Merged ${duplicate.name || duplicate.id}; original source: ${duplicate.source.kind} ${duplicate.source.reference}. Original record retained as ${duplicate.id}.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      for (const [table, kind] of [
        ["crm_contacts", "contact"],
        ["crm_deals", "deal"],
        ["crm_projects", "project"],
        ["crm_tasks", "company"],
        ["crm_documents", "document"],
      ] as const) {
        const related = allRecords<Versioned & { companyId: string; primary?: boolean }>(
          this.db,
          table,
        ).filter((r) => r.companyId === mergeId);
        for (const row of related) {
          row.companyId = keepId;
          if (
            table === "crm_contacts" &&
            row.primary &&
            allRecords<Contact>(this.db, table).some((c) => c.companyId === keepId && c.primary)
          )
            row.primary = false;
          this.save(
            table,
            row,
            by,
            table === "crm_tasks" ? { kind: "company", id: keepId } : kind,
            { company_id: keepId },
          );
        }
      }
      for (const a of allRecords<Activity>(this.db, "crm_activities").filter(
        (a) => a.companyId === mergeId,
      )) {
        a.companyId = keepId;
        this.db
          .query("UPDATE crm_activities SET company_id=?,data=? WHERE id=?")
          .run(keepId, JSON.stringify(a), a.id);
      }
      duplicate.mergedInto = keepId;
      duplicate.excluded = true;
      duplicate.excludedReason = `Duplicate of ${keepId}`;
      this.save("crm_companies", keep, by, "company");
      this.save("crm_companies", duplicate, by, "company");
      this.writeLegacyCompany(before, keep, by);
      if (duplicate.legacyLeadId !== null && hasTable(this.db, "leads")) {
        this.db
          .query(
            "UPDATE leads SET excluded=1,excluded_reason=?,merged_into=COALESCE(?,merged_into) WHERE id=?",
          )
          .run(`Duplicate of CRM company ${keepId}`, keep.legacyLeadId, duplicate.legacyLeadId);
        refreshLegacyBaseline(this.db, duplicate.legacyLeadId);
      }
      this.addActivity(
        {
          ref: { kind: "company", id: keepId },
          eventId: `crm:merge:${mergeId}:${keepId}`,
          kind: "company-merge",
          title: `Merged ${duplicate.name || duplicate.id}`,
          note: `Original ${mergeId} and its source/history retained. Related records now belong to this company.`,
        },
        by,
      );
      return keep;
    });
  }
}
/** Runtime upgrades also make a consistent, verified backup before openCrm can add legacy columns. */
export function openCrmStore(
  root: string,
  options: Omit<CrmStoreOptions, "root" | "ownsDatabase"> = {},
): CrmStore {
  const file = crmPath(root);
  let backupPath: string | undefined;
  if (existsSync(file)) {
    const original = new Database(file);
    try {
      if (schemaVersion(original) < CRM_SCHEMA_VERSION && hasTable(original, "leads")) {
        backupPath = `${file}.pre-crm-v${CRM_SCHEMA_VERSION}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID().slice(0, 8)}.sqlite`;
        original.query("VACUUM INTO ?").run(backupPath);
        const backup = new Database(backupPath, { readonly: true });
        try {
          const result = backup.query("PRAGMA integrity_check").all() as Record<string, string>[];
          if (result.length !== 1 || Object.values(result[0])[0] !== "ok")
            throw new Error(
              "Pre-migration backup failed integrity verification. Original CRM was not migrated.",
            );
        } finally {
          backup.close();
        }
      }
    } finally {
      original.close();
    }
  }
  const db = openCrm(file);
  try {
    return new CrmStore(db, { ...options, root, ownsDatabase: true, backupPath });
  } catch (error) {
    db.close();
    throw error;
  }
}
