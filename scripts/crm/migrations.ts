/** Additive CRM schema. The existing Leads tables and every original row remain untouched.
 * Dry run performs SELECTs only. Rollback is deliberately explicit and requires a disposable copy.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { receptionistOnHold } from "./policy";
import { offerDefaults } from "../leads/deals";
import { WEBSITE_EX_GST_CENTS, type Offer } from "../leads/sales-backoffice";
import {
  SALES_STAGES,
  type Company,
  type Deal,
  type Task,
  type Project,
  type Activity,
  type Pipeline,
  type Versioned,
  type StageHistory,
} from "./types";

export const CRM_SCHEMA_VERSION = 1;
export type MigrationReport = {
  fromVersion: number;
  toVersion: number;
  applied: boolean;
  counts: {
    leads: number;
    activities: number;
    deals: number;
    followUps: number;
    kickoffs: number;
    optouts: number;
    duplicates: number;
    excluded: number;
    companiesAlreadyLinked: number;
  };
  relationships: {
    orphanActivities: number;
    orphanDeals: number;
    orphanKickoffs: number;
    danglingDuplicates: number;
  };
  ambiguities: { leadId: number | null; code: string; detail: string }[];
  preservedTables: string[];
  backupPath?: string;
  validation?: {
    companies: number;
    deals: number;
    tasks: number;
    projects: number;
    activities: number;
    originalRowsUnchanged: boolean;
    foreignKeyViolations: number;
  };
};
type Row = Record<string, any>;
export function hasTable(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
const rows = (db: Database, name: string): Row[] =>
  hasTable(db, name) ? (db.query(`SELECT * FROM ${name}`).all() as Row[]) : [];
export function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function count(db: Database, table: string): number {
  return hasTable(db, table)
    ? (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    : 0;
}
export function schemaVersion(db: Database): number {
  return hasTable(db, "crm_schema_migrations")
    ? ((
        db.query("SELECT MAX(version) AS n FROM crm_schema_migrations").get() as {
          n: number | null;
        }
      ).n ?? 0)
    : 0;
}
const LEGACY_TABLES = [
  "leads",
  "activities",
  "activity_events",
  "lead_deals",
  "kickoffs",
  "coaching",
  "phone_findings",
  "lead_locations",
  "optouts",
  "places_usage",
  "goals",
  "crm_settings",
];
export function dryRunMigration(db: Database): MigrationReport {
  const leads = rows(db, "leads"),
    ids = new Set(leads.map((r) => r.id));
  const activities = rows(db, "activities"),
    deals = rows(db, "lead_deals"),
    kickoffs = rows(db, "kickoffs");
  const ambiguities: MigrationReport["ambiguities"] = [];
  for (const lead of leads) {
    if (!safeLead(lead).name)
      ambiguities.push({
        leadId: lead.id,
        code: "name-unavailable",
        detail:
          "No independently sourced business name; live Google display content is not migrated.",
      });
    if (
      lead.source === "google" &&
      ["name", "phone", "website", "address"].some((k) => lead[k] && !safeLead(lead)[k])
    )
      ambiguities.push({
        leadId: lead.id,
        code: "transient-fields-omitted",
        detail:
          "Unproven Google-derived fields stay outside CRM records. Original row is unchanged.",
      });
    if (lead.owner && !["usman", "mehroz"].includes(lead.owner))
      ambiguities.push({
        leadId: lead.id,
        code: "unknown-owner",
        detail: "Unrecognised owner preserved in original lead; new responsibility is unassigned.",
      });
    if (lead.next_at && !Number.isFinite(Date.parse(lead.next_at)))
      ambiguities.push({
        leadId: lead.id,
        code: "invalid-follow-up-date",
        detail: "Original date preserved; task needs a valid due date.",
      });
    if (lead.merged_into && !ids.has(lead.merged_into))
      ambiguities.push({
        leadId: lead.id,
        code: "dangling-duplicate",
        detail: `Original duplicate target #${lead.merged_into} does not exist.`,
      });
    if (/receptionist|both/.test(String(lead.pitch)))
      ambiguities.push({
        leadId: lead.id,
        code: "receptionist-on-hold",
        detail:
          "Existing commercial data retained; no receptionist service, billing or onboarding is activated.",
      });
  }
  for (const kickoff of kickoffs)
    if (!Array.isArray(parseJson<Row>(kickoff.checklist, {}).milestones))
      ambiguities.push({
        leadId: kickoff.lead_id,
        code: "unstructured-kickoff",
        detail: "Original kickoff retained; unstructured checklist needs review.",
      });
  return {
    fromVersion: schemaVersion(db),
    toVersion: CRM_SCHEMA_VERSION,
    applied: false,
    counts: {
      leads: leads.length,
      activities: activities.length,
      deals: leads.length,
      followUps: leads.filter((r) => r.next_at).length,
      kickoffs: kickoffs.length,
      optouts: count(db, "optouts"),
      duplicates: leads.filter((r) => r.merged_into).length,
      excluded: leads.filter((r) => r.excluded).length,
      companiesAlreadyLinked: count(db, "crm_legacy_links"),
    },
    relationships: {
      orphanActivities: activities.filter((r) => !ids.has(r.lead_id)).length,
      orphanDeals: deals.filter((r) => !ids.has(r.lead_id)).length,
      orphanKickoffs: kickoffs.filter((r) => !ids.has(r.lead_id)).length,
      danglingDuplicates: leads.filter((r) => r.merged_into && !ids.has(r.merged_into)).length,
    },
    ambiguities,
    preservedTables: LEGACY_TABLES.filter((t) => hasTable(db, t)),
  };
}
const SCHEMA = `
CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, report TEXT NOT NULL);
CREATE TABLE crm_companies(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), legacy_lead_id INTEGER UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE crm_contacts(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), company_id TEXT NOT NULL REFERENCES crm_companies(id), data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX crm_contacts_company ON crm_contacts(company_id);
CREATE TABLE crm_pipelines(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE crm_pipeline_stages(id TEXT NOT NULL, pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id), ordinal INTEGER NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('open','won','lost')), archived INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pipeline_id,id));
CREATE TABLE crm_deals(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), company_id TEXT NOT NULL REFERENCES crm_companies(id), pipeline_id TEXT NOT NULL, stage_id TEXT NOT NULL, legacy_lead_id INTEGER UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)), FOREIGN KEY(pipeline_id,stage_id) REFERENCES crm_pipeline_stages(pipeline_id,id));
CREATE INDEX crm_deals_company ON crm_deals(company_id);
CREATE TABLE crm_deal_contacts(deal_id TEXT NOT NULL REFERENCES crm_deals(id), contact_id TEXT NOT NULL REFERENCES crm_contacts(id), PRIMARY KEY(deal_id,contact_id));
CREATE TABLE crm_projects(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), company_id TEXT NOT NULL REFERENCES crm_companies(id), deal_id TEXT UNIQUE REFERENCES crm_deals(id), data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE crm_tasks(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), company_id TEXT NOT NULL REFERENCES crm_companies(id), deal_id TEXT REFERENCES crm_deals(id), project_id TEXT REFERENCES crm_projects(id), contact_id TEXT REFERENCES crm_contacts(id), data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX crm_tasks_company ON crm_tasks(company_id);
CREATE TABLE crm_activities(id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, company_id TEXT NOT NULL REFERENCES crm_companies(id), ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX crm_activities_company_at ON crm_activities(company_id,at DESC);
CREATE UNIQUE INDEX crm_provider_events ON crm_activities(json_extract(data,'$.providerEvidence.provider'),json_extract(data,'$.providerEvidence.eventId')) WHERE json_type(data,'$.providerEvidence')='object';
CREATE TABLE crm_documents(id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), company_id TEXT NOT NULL REFERENCES crm_companies(id), deal_id TEXT REFERENCES crm_deals(id), project_id TEXT REFERENCES crm_projects(id), data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE crm_document_versions(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES crm_documents(id), number INTEGER NOT NULL CHECK(number>0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(document_id,number));
CREATE TABLE crm_document_statuses(id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES crm_documents(id), version_number INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','issued','accepted','superseded')), at TEXT NOT NULL, actor TEXT NOT NULL, FOREIGN KEY(document_id,version_number) REFERENCES crm_document_versions(document_id,number));
CREATE TABLE crm_legacy_links(lead_id INTEGER PRIMARY KEY, company_id TEXT NOT NULL UNIQUE REFERENCES crm_companies(id), deal_id TEXT NOT NULL UNIQUE REFERENCES crm_deals(id), fingerprint TEXT NOT NULL, projection TEXT NOT NULL CHECK(json_valid(projection)));
CREATE TABLE crm_record_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)));
CREATE TABLE crm_csv_previews(id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE crm_csv_commits(preview_id TEXT PRIMARY KEY, resolution_hash TEXT NOT NULL, receipt TEXT NOT NULL);
CREATE TABLE crm_automation_rules(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, last_outcome TEXT, last_error TEXT, last_run_at TEXT);
CREATE TABLE crm_automation_runs(event_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, rule_id TEXT NOT NULL, semantic_key TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, receipt TEXT, error TEXT, job_id TEXT);
CREATE INDEX crm_automation_semantic ON crm_automation_runs(semantic_key,state);
CREATE TABLE crm_mutation_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, version INTEGER NOT NULL);
`;
const ownTables = [
  "crm_automation_runs",
  "crm_automation_rules",
  "crm_csv_commits",
  "crm_csv_previews",
  "crm_mutation_audit",
  "crm_record_settings",
  "crm_legacy_links",
  "crm_document_statuses",
  "crm_document_versions",
  "crm_documents",
  "crm_activities",
  "crm_tasks",
  "crm_projects",
  "crm_deal_contacts",
  "crm_deals",
  "crm_pipeline_stages",
  "crm_pipelines",
  "crm_contacts",
  "crm_companies",
  "crm_schema_migrations",
];
export function migrateCrm(
  db: Database,
  now = new Date().toISOString(),
  options: { backupPath?: string } = {},
): MigrationReport {
  // Serialize schema admission, then re-read the version/counts under the same write lock.
  // A concurrent hub that finished first makes this a no-op instead of a second CREATE.
  return db
    .transaction(() => {
      const report = dryRunMigration(db);
      if (report.fromVersion > CRM_SCHEMA_VERSION)
        throw new Error("CRM database was written by a newer version. Upgrade before opening it.");
      if (report.fromVersion === CRM_SCHEMA_VERSION) return report;
      if (Object.values(report.relationships).some((n) => n > 0))
        throw new Error(
          "Legacy relationships need review before migration. Run a dry run and resolve the reported orphan/duplicate targets on a backed-up copy.",
        );
      const originals = createHash("sha256")
        .update(JSON.stringify(report.preservedTables.map((t) => [t, rows(db, t)])))
        .digest("hex");
      db.exec(SCHEMA);
      const pipeline: Pipeline = {
        id: "sales",
        version: 1,
        createdAt: now,
        updatedAt: now,
        name: "Sales",
        stages: SALES_STAGES.map((s) => ({ ...s })),
      };
      insertRecord(db, "crm_pipelines", pipeline);
      for (const [index, stage] of pipeline.stages.entries())
        db.query(
          "INSERT INTO crm_pipeline_stages(id,pipeline_id,ordinal,name,category,archived) VALUES(?,?,?,?,?,?)",
        ).run(stage.id, pipeline.id, index, stage.name, stage.category, 0);
      synchroniseLegacy(db, now);
      const foreignKeyViolations = (
        db.query("PRAGMA foreign_key_check").all() as { table: string }[]
      ).filter((r) => r.table.startsWith("crm_")).length;
      const unchanged =
        createHash("sha256")
          .update(JSON.stringify(report.preservedTables.map((t) => [t, rows(db, t)])))
          .digest("hex") === originals;
      report.validation = {
        companies: count(db, "crm_companies"),
        deals: count(db, "crm_deals"),
        tasks: count(db, "crm_tasks"),
        projects: count(db, "crm_projects"),
        activities: count(db, "crm_activities"),
        originalRowsUnchanged: unchanged,
        foreignKeyViolations,
      };
      if (
        !unchanged ||
        foreignKeyViolations ||
        report.validation.companies !== report.counts.leads ||
        report.validation.deals !== report.counts.leads ||
        report.validation.tasks !== report.counts.followUps ||
        report.validation.projects !== report.counts.kickoffs ||
        report.validation.activities !== report.counts.activities
      )
        throw new Error(
          "Migration reconciliation failed. All migration changes were rolled back; original data remains unchanged.",
        );
      if (options.backupPath) report.backupPath = options.backupPath;
      db.query("INSERT INTO crm_schema_migrations(version,applied_at,report) VALUES(?,?,?)").run(
        CRM_SCHEMA_VERSION,
        now,
        JSON.stringify({ ...report, applied: true }),
      );
      return { ...report, applied: true };
    })
    .immediate();
}
/** Intended for a disposable migration verification copy only; never rolls back the operator's live database. */
export function rollbackCrm(
  db: Database,
  options: { disposable: true; acknowledgeDataLoss: true },
): void {
  if (options?.disposable !== true || options?.acknowledgeDataLoss !== true)
    throw new Error(
      "Rollback requires an explicitly acknowledged disposable database. Restore a verified SQLite backup for production.",
    );
  const extra = (
    db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'crm_%'").all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter((n) => !ownTables.includes(n) && n !== "crm_settings");
  if (extra.length)
    throw new Error(
      `Additional CRM feature tables exist (${extra.join(", ")}). Restore the verified backup rather than dropping partial data.`,
    );
  db.transaction(() => {
    for (const table of ownTables) db.exec(`DROP TABLE IF EXISTS ${table}`);
  })();
}
export function insertRecord(
  db: Database,
  table: string,
  record: Versioned,
  columns: Record<string, string | number | null> = {},
): void {
  const keys = ["id", "version", ...Object.keys(columns), "data"];
  db.query(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(
    record.id,
    record.version,
    ...Object.values(columns),
    JSON.stringify(record),
  );
}
export function readRecord<T>(db: Database, table: string, id: string): T | null {
  const r = db.query(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | null;
  return r ? (JSON.parse(r.data) as T) : null;
}
export function allRecords<T>(db: Database, table: string): T[] {
  return (db.query(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]).map(
    (r) => JSON.parse(r.data) as T,
  );
}
export function replaceRecord(
  db: Database,
  table: string,
  record: Versioned,
  expectedVersion: number,
  columns: Record<string, string | number | null> = {},
): boolean {
  const assignments = ["version=?", ...Object.keys(columns).map((k) => `${k}=?`), "data=?"];
  return (
    db
      .query(`UPDATE ${table} SET ${assignments.join(",")} WHERE id=? AND version=?`)
      .run(
        record.version,
        ...Object.values(columns),
        JSON.stringify(record),
        record.id,
        expectedVersion,
      ).changes === 1
  );
}
const owner = (v: unknown): "usman" | "mehroz" | "" => (v === "usman" || v === "mehroz" ? v : "");
const date = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const jsonStrings = (v: unknown): string[] => {
  const parsed = parseJson<unknown>(v, []);
  return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
};
const independent = (s: unknown) =>
  typeof s === "string" && !!s && !["google", "places"].includes(s.toLowerCase());
/** A safe projection, not a cached copy of the original row. Never persist unproven Google fields. */
function safeLead(row: Row): Row {
  const sources = parseJson<Row>(row.field_sources, {}),
    isGoogle = row.source !== "osm" && !/^osm:|^manual:/.test(String(row.place_id));
  const field = (name: string) =>
    !isGoogle ||
    independent(sources[name]) ||
    (name === "website" && independent(row.website_source)) ||
    (name === "phone" && independent(row.phone_source))
      ? String(row[name] ?? "")
      : "";
  return {
    id: row.id,
    name: field("name"),
    phone: field("phone"),
    address: field("address"),
    website: field("website"),
    source:
      row.source === "osm" ? "osm" : /^manual:/.test(String(row.place_id)) ? "manual" : "google",
    placeId: row.place_id,
    attribution: row.attribution ?? "",
    fieldSources: sources && typeof sources === "object" && !Array.isArray(sources) ? sources : {},
    industry: row.vertical ?? "",
    locality: row.area ?? "",
    emails: jsonStrings(row.emails),
    owner: owner(row.owner),
    emailAllowed: !!row.email_ok,
    status: row.status,
    nextAt: date(row.next_at),
    nextAtOriginal: row.next_at ?? null,
    createdAt: row.created_at,
    excluded: !!row.excluded,
    excludedReason: row.excluded_reason ?? "",
    mergedInto: row.merged_into ? `legacy-company-${row.merged_into}` : null,
    websiteCheck: [
      "found",
      "none-verified",
      "check-failed",
      "search-unavailable",
      "not-checked",
    ].includes(row.website_check)
      ? row.website_check
      : "not-checked",
    websiteCheckedAt: date(row.website_checked_at),
    pitch: row.pitch ?? "",
  };
}
const stageOf = (status: string): string =>
  (
    ({
      interested: "qualified",
      to_call: "new",
      no_answer: "contacted",
      voicemail: "contacted",
      call_back: "contacted",
      emailed: "contacted",
      meeting: "meeting",
      proposal: "proposal",
      won: "won",
      lost: "lost",
      not_interested: "lost",
      do_not_contact: "lost",
    }) as Record<string, string>
  )[status] ?? "new";
function optedOut(db: Database, p: Row): boolean {
  return (
    p.status === "do_not_contact" ||
    (hasTable(db, "optouts") &&
      [p.phone, ...p.emails]
        .filter(Boolean)
        .some(
          (v: string) =>
            !!db
              .query("SELECT 1 FROM optouts WHERE value=?")
              .get(v.includes("@") ? v.toLowerCase() : v.replace(/\D/g, "")),
        ))
  );
}
function legacyProjection(db: Database, row: Row): Row {
  const safe = safeLead(row);
  const economics = hasTable(db, "lead_deals")
    ? (db.query("SELECT * FROM lead_deals WHERE lead_id=?").get(row.id) as Row | null)
    : null;
  const kickoff = hasTable(db, "kickoffs")
    ? (db.query("SELECT * FROM kickoffs WHERE lead_id=?").get(row.id) as Row | null)
    : null;
  return { ...safe, doNotContact: optedOut(db, safe), economics, kickoff };
}
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function canonicalCompanyId(db: Database, id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const company = readRecord<Company>(db, "crm_companies", current);
    if (!company?.mergedInto || !readRecord<Company>(db, "crm_companies", company.mergedInto))
      return current;
    current = company.mergedInto;
  }
  throw new Error("Company merge cycle requires review.");
}
function legacyDefaults(
  offer: string,
  packageId?: string | null,
): { setup: number; monthly: number } {
  if (!["website", "redesign", "receptionist", "both"].includes(offer))
    return { setup: 0, monthly: 0 };
  try {
    const value = offerDefaults(offer as Offer, packageId);
    return { setup: value.setupCents, monthly: value.monthlyCents };
  } catch {
    return { setup: offer === "both" ? WEBSITE_EX_GST_CENTS : 0, monthly: 0 };
  }
}
export function refreshLegacyBaseline(db: Database, leadId: number): void {
  const raw = hasTable(db, "leads")
    ? (db.query("SELECT * FROM leads WHERE id=?").get(leadId) as Row | null)
    : null;
  if (!raw) return;
  const projection = legacyProjection(db, raw);
  db.query("UPDATE crm_legacy_links SET fingerprint=?,projection=? WHERE lead_id=?").run(
    hash(projection),
    JSON.stringify(projection),
    leadId,
  );
}
function changed(a: unknown, b: unknown) {
  return JSON.stringify(a) !== JSON.stringify(b);
}
/** Safe incremental bridge. Only fields changed in legacy since the last bridge are applied.
 * New CRM fields are never reset by merely reading the legacy row. CRM writes refresh the baseline.
 */
export function synchroniseLegacy(db: Database, now = new Date().toISOString()): void {
  if (!hasTable(db, "leads")) return;
  db.transaction(() => {
    for (const raw of rows(db, "leads")) {
      const p = legacyProjection(db, raw),
        fingerprint = hash(p);
      const link = db
        .query("SELECT * FROM crm_legacy_links WHERE lead_id=?")
        .get(raw.id) as Row | null;
      if (link?.fingerprint === fingerprint) continue;
      const previous = parseJson<Row>(link?.projection, {});
      const id = `legacy-company-${raw.id}`,
        dealId = `legacy-deal-${raw.id}`;
      const existing = readRecord<Company>(db, "crm_companies", id);
      const base = { id, version: 1, createdAt: date(p.createdAt) ?? now, updatedAt: now };
      const companyBefore = existing ? JSON.stringify(existing) : null;
      const company: Company = existing ?? {
        ...base,
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
        source: { kind: p.source, reference: p.placeId, attribution: p.attribution },
        fieldSources: {},
        status: "prospect",
        notes: "",
        doNotContact: false,
        emailAllowed: false,
        excluded: false,
        excludedReason: "",
        mergedInto: null,
        legacyLeadId: raw.id,
        websiteCheck: "not-checked",
        websiteCheckedAt: null,
      };
      for (const key of [
        "name",
        "industry",
        "website",
        "locality",
        "address",
        "phone",
        "emails",
        "owner",
        "fieldSources",
        "emailAllowed",
        "excluded",
        "excludedReason",
        "mergedInto",
        "websiteCheck",
        "websiteCheckedAt",
      ] as const)
        if (!existing || changed(previous[key], p[key])) (company as any)[key] = p[key];
      if (
        !existing ||
        changed(previous.source, p.source) ||
        changed(previous.placeId, p.placeId) ||
        changed(previous.attribution, p.attribution)
      )
        company.source = { kind: p.source, reference: p.placeId, attribution: p.attribution };
      company.doNotContact = company.doNotContact || p.doNotContact;
      if (company.doNotContact) company.emailAllowed = false;
      const preference =
        typeof p.economics?.contact_pref === "string" ? p.economics.contact_pref.trim() : "";
      if (preference && (!existing || changed(previous.economics?.contact_pref, preference)))
        company.notes = [company.notes, `Legacy contact preference: ${preference}`]
          .filter(Boolean)
          .join("\n");
      if (!existing) insertRecord(db, "crm_companies", company, { legacy_lead_id: raw.id });
      else if (companyBefore !== JSON.stringify(company)) {
        company.version++;
        company.updatedAt = now;
        replaceRecord(db, "crm_companies", company, company.version - 1);
      }
      const relatedCompanyId = canonicalCompanyId(db, id);
      const econ = p.economics ?? {},
        offer = econ.offer || p.pitch || "website",
        defaults = legacyDefaults(offer, econ.package_id);
      const stageId = stageOf(p.status);
      const existingDeal = readRecord<Deal>(db, "crm_deals", dealId);
      const history = (): StageHistory => ({
        stageId,
        stageName: SALES_STAGES.find((s) => s.id === stageId)!.name,
        at: now,
        by: { legacy: raw.owner || "legacy" },
        reason: `Legacy lead status: ${p.status}`,
      });
      const importedHistory: StageHistory[] = [];
      if (!existingDeal && hasTable(db, "activities")) {
        for (const event of db
          .query(
            "SELECT at,outcome,by FROM activities WHERE lead_id=? AND outcome<>'' ORDER BY at,id",
          )
          .all(raw.id) as Row[]) {
          const eventStage = stageOf(event.outcome);
          if (importedHistory.at(-1)?.stageId !== eventStage)
            importedHistory.push({
              stageId: eventStage,
              stageName: SALES_STAGES.find((s) => s.id === eventStage)!.name,
              at: event.at,
              by: { legacy: event.by || "legacy" },
              reason: `Legacy activity outcome: ${event.outcome}`,
            });
        }
      }
      if (importedHistory.at(-1)?.stageId !== stageId) importedHistory.push(history());
      const deal: Deal = existingDeal ?? {
        ...base,
        id: dealId,
        companyId: relatedCompanyId,
        title: `${company.name || `Lead #${raw.id}`} opportunity`,
        owner: p.owner,
        contactIds: [],
        service: offer,
        scope: "",
        pipelineId: "sales",
        stageId,
        oneOffCents: econ.setup_cents ?? defaults.setup,
        recurringCents: econ.monthly_cents ?? defaults.monthly,
        currency: "AUD",
        gstTreatment: "exclusive",
        probability: econ.probability ?? null,
        expectedClose: econ.expected_close ?? null,
        nextAction: "",
        nextActionDue: p.nextAt,
        closeReason: stageId === "lost" ? `Legacy outcome: ${p.status}` : "",
        stageHistory: importedHistory,
        legacyLeadId: raw.id,
        catalogueId:
          econ.package_id ?? (offer === "website" || offer === "redesign" ? "website" : null),
        commercialBasis:
          econ.setup_cents != null || econ.monthly_cents != null
            ? "agreed"
            : offer === "website" || offer === "redesign"
              ? "catalogue"
              : "legacy-unconfirmed",
      };
      if (!existingDeal)
        insertRecord(db, "crm_deals", deal, {
          company_id: relatedCompanyId,
          pipeline_id: deal.pipelineId,
          stage_id: deal.stageId,
          legacy_lead_id: raw.id,
        });
      else {
        let dirty = false;
        if (changed(previous.status, p.status) && deal.stageId !== stageId) {
          deal.stageId = stageId;
          deal.pipelineId = "sales";
          deal.stageHistory.push(history());
          dirty = true;
        }
        if (changed(previous.owner, p.owner)) {
          deal.owner = p.owner;
          dirty = true;
        }
        if (changed(previous.nextAt, p.nextAt)) {
          deal.nextActionDue = p.nextAt;
          dirty = true;
        }
        if (changed(previous.economics, p.economics)) {
          const old = previous.economics ?? {};
          for (const [legacy, key] of [
            ["setup_cents", "oneOffCents"],
            ["monthly_cents", "recurringCents"],
            ["probability", "probability"],
            ["expected_close", "expectedClose"],
            ["package_id", "catalogueId"],
            ["offer", "service"],
          ] as const)
            if (changed(old[legacy], econ[legacy])) {
              const value =
                econ[legacy] ??
                (key === "oneOffCents"
                  ? defaults.setup
                  : key === "recurringCents"
                    ? defaults.monthly
                    : key === "service"
                      ? offer
                      : null);
              (deal as any)[key] =
                (key === "oneOffCents" || key === "recurringCents") &&
                deal.gstTreatment === "inclusive"
                  ? value + Math.round(value * 0.1)
                  : value;
              dirty = true;
            }
        }
        if (
          changed(previous.economics?.offer, econ.offer) ||
          changed(previous.economics?.package_id, econ.package_id)
        ) {
          const inclusive = (v: number) =>
            deal.gstTreatment === "inclusive" ? v + Math.round(v * 0.1) : v;
          if (econ.setup_cents == null) deal.oneOffCents = inclusive(defaults.setup);
          if (econ.monthly_cents == null) deal.recurringCents = inclusive(defaults.monthly);
          dirty = true;
        }
        if (dirty) {
          deal.version++;
          deal.updatedAt = now;
          replaceRecord(db, "crm_deals", deal, deal.version - 1, {
            pipeline_id: deal.pipelineId,
            stage_id: deal.stageId,
          });
        }
      }
      const taskId = `legacy-followup-${raw.id}`,
        task = readRecord<Task>(db, "crm_tasks", taskId);
      if (p.nextAtOriginal || task) {
        const status =
          p.nextAtOriginal &&
          !company.excluded &&
          !company.doNotContact &&
          !["won", "lost", "not_interested"].includes(p.status)
            ? "open"
            : "cancelled";
        if (!task) {
          const t: Task = {
            ...base,
            id: taskId,
            companyId: relatedCompanyId,
            dealId,
            projectId: null,
            contactId: null,
            title:
              p.nextAtOriginal && !p.nextAt
                ? "Legacy follow-up (date needs review)"
                : "Legacy follow-up",
            description: `Follow-up preserved from Leads. Review the timeline for the original promise.${p.nextAtOriginal && !p.nextAt ? ` Original date needs review: ${String(p.nextAtOriginal).slice(0, 500)}` : ""}`,
            kind: "follow-up",
            status,
            owner: p.owner,
            dueAt: p.nextAt,
            completedAt: null,
            legacyLeadId: raw.id,
          };
          insertRecord(db, "crm_tasks", t, {
            company_id: relatedCompanyId,
            deal_id: dealId,
            project_id: null,
            contact_id: null,
          });
        } else if (
          changed(previous.nextAt, p.nextAt) ||
          changed(previous.owner, p.owner) ||
          changed(previous.status, p.status) ||
          changed(previous.excluded, p.excluded) ||
          changed(previous.doNotContact, p.doNotContact)
        ) {
          task.version++;
          task.updatedAt = now;
          task.dueAt = p.nextAt;
          task.owner = p.owner;
          task.status = status;
          replaceRecord(db, "crm_tasks", task, task.version - 1);
        }
      }
      if (p.kickoff && changed(previous.kickoff, p.kickoff)) {
        const kid = `legacy-project-${raw.id}`,
          oldProject = readRecord<Project>(db, "crm_projects", kid),
          checklist = parseJson<Row>(p.kickoff.checklist, {});
        const list = (key: string) =>
          Array.isArray(checklist[key])
            ? checklist[key].filter((v: unknown) => typeof v === "string")
            : [];
        const milestones = Array.isArray(checklist.milestones)
          ? checklist.milestones.map((m: any, i: number) => ({
              id: `legacy-${i}`,
              name: typeof m === "string" ? m : String(m.name ?? `Milestone ${i + 1}`),
              status:
                m.state === "done"
                  ? ("done" as const)
                  : m.state === "partial"
                    ? ("in-progress" as const)
                    : ("pending" as const),
              dueAt: date(m.due),
              completedAt: date(m.completedAt),
              note: m.note ?? "",
            }))
          : [];
        const project: Project = oldProject ?? {
          ...base,
          id: kid,
          companyId: relatedCompanyId,
          dealId,
          name: `${company.name || `Lead #${raw.id}`} delivery`,
          owner: p.owner,
          status: receptionistOnHold({ service: offer, catalogueId: econ.package_id })
            ? "on-hold"
            : "onboarding",
          scope: p.kickoff.scope ?? "",
          contentRequests: [...list("intake"), ...list("assets")],
          accessRequests: list("access"),
          milestones,
          previewUrls: [],
          revisionRequests: [],
          deliverables: [],
          launchAt: null,
          renewalAt: null,
          legacyLeadId: raw.id,
        };
        if (!oldProject)
          insertRecord(db, "crm_projects", project, {
            company_id: relatedCompanyId,
            deal_id: dealId,
          });
        else {
          project.version++;
          project.updatedAt = now;
          project.scope = p.kickoff.scope ?? project.scope;
          project.milestones = milestones;
          replaceRecord(db, "crm_projects", project, project.version - 1);
        }
      }
      db.query(
        "INSERT INTO crm_legacy_links(lead_id,company_id,deal_id,fingerprint,projection) VALUES(?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET fingerprint=excluded.fingerprint,projection=excluded.projection",
      ).run(raw.id, id, dealId, fingerprint, JSON.stringify(p));
    }
    // A keeper may sort after its duplicate. Reconcile only after every company exists,
    // so forward legacy merged_into references and later old-UI merges converge identically.
    for (const table of [
      "crm_contacts",
      "crm_deals",
      "crm_projects",
      "crm_tasks",
      "crm_documents",
    ]) {
      for (const record of allRecords<Versioned & { companyId: string; primary?: boolean }>(
        db,
        table,
      )) {
        const canonical = canonicalCompanyId(db, record.companyId);
        if (canonical === record.companyId) continue;
        if (
          table === "crm_contacts" &&
          record.primary &&
          allRecords<{ id: string; companyId: string; primary: boolean }>(db, table).some(
            (c) => c.companyId === canonical && c.primary && c.id !== record.id,
          )
        )
          record.primary = false;
        record.companyId = canonical;
        const prior = record.version;
        record.version++;
        record.updatedAt = now;
        replaceRecord(db, table, record, prior, { company_id: canonical });
      }
    }
    for (const activity of allRecords<Activity>(db, "crm_activities")) {
      const canonical = canonicalCompanyId(db, activity.companyId);
      if (canonical !== activity.companyId) {
        activity.companyId = canonical;
        db.query("UPDATE crm_activities SET company_id=?,data=? WHERE id=?").run(
          canonical,
          JSON.stringify(activity),
          activity.id,
        );
      }
    }
    for (const a of rows(db, "activities")) {
      const link = db
        .query("SELECT company_id FROM crm_legacy_links WHERE lead_id=?")
        .get(a.lead_id) as { company_id: string } | null;
      if (!link) continue;
      link.company_id = canonicalCompanyId(db, link.company_id);
      const id = `legacy-activity-${a.id}`;
      if (db.query("SELECT 1 FROM crm_activities WHERE id=?").get(id)) continue;
      const original = hasTable(db, "activity_events")
        ? (db
            .query(
              "SELECT event_id FROM activity_events WHERE activity_id=? ORDER BY event_id LIMIT 1",
            )
            .get(a.id) as { event_id: string } | null)
        : null;
      const eventId = original?.event_id ?? `legacy:activity:${a.id}`;
      const activity: Activity = {
        id,
        companyId: link.company_id,
        ref: { kind: "company", id: link.company_id },
        eventId,
        kind: a.kind,
        title: a.outcome ? `${a.kind}: ${a.outcome}` : a.kind,
        note: a.note,
        at: a.at,
        by: { legacy: a.by || "legacy" },
        outcome: a.outcome ?? "",
        artifact: null,
        communicationState: a.kind === "email" ? "unknown" : null,
        externalUrl: null,
      };
      db.query(
        "INSERT OR IGNORE INTO crm_activities(id,event_id,company_id,ref_kind,ref_id,at,data) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        eventId,
        link.company_id,
        "company",
        link.company_id,
        a.at,
        JSON.stringify(activity),
      );
    }
  })();
}
