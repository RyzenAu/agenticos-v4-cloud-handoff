/** Repeatable, idempotent, private importer for a reviewed deliverables preview (companies, contacts, deals, documents, tasks, activities).
 *
 *   bun scripts/crm/import-deliverables.ts --db <crm.sqlite> --preview <preview folder> --extracted <extracted folder>
 *       [--decisions <json>] [--report <file outside the repo>] [--storage <folder>]
 *       dry run (default): applies the whole import to a THROWAWAY COPY of the database and prints what it would do; the real file is only read.
 *   RUNBOOK: --apply holds one write transaction on the whole database, so STOP THE HUB first (the dry run does not need that), apply, then start it.
 *   Any record with an error or conflict aborts the whole apply: nothing is written until every line is clean.
 *   bun scripts/crm/import-deliverables.ts ... --apply --backup <new-backup.sqlite>
 *       copies the database to the backup first (integrity checked), then writes in ONE transaction.
 *
 * Rules: re-running changes nothing; a field a person edited after import is kept ("kept"), never overwritten; a company that looks like an
 * existing one is reported for a person to decide (a decisions file can say create, attach or skip) and is never auto-merged; documents'
 * files are copied into the hub's private data folder (crm-files), never into the repository; every reply stays an unsent draft.
 * Nothing here sends, publishes or fetches anything. Private client material is read from the folders you name and is never written to Git. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CRM_SCHEMA_VERSION, schemaVersion } from "./migrations";
import { CrmStore } from "./store";
import {
  CrmError,
  type Attribution,
  type Company,
  type Contact,
  type Deal,
  type Document,
  type Task,
} from "./types";

// ───────────────────────────── plan input ─────────────────────────────
type PlanRecord = {
  stageRef?: string;
  externalKey?: string;
  eventId?: string;
  companyRef?: string;
  dealRef?: string;
  ref?: string;
  fields: Record<string, any>;
  provenance?: Record<string, any>;
  pricing?: { status?: string; historicalQuote?: string; oneOffCents?: number | null };
  cohort?: string;
  recordedUrl?: string;
  attachments?: { path: string; name?: string }[];
};
export type PreviewSet = {
  batch: string;
  companies: PlanRecord[];
  contacts: PlanRecord[];
  deals: PlanRecord[];
  tasks: PlanRecord[];
  documents: PlanRecord[];
  activities: PlanRecord[];
  dedup: { stageRef: string; keys: DedupKeys }[];
  held: Record<string, unknown[]>;
};
type DedupKeys = { nameLocality: string[]; phones: string[]; domains: string[]; emails: string[] };

export function loadPreview(dir: string): PreviewSet {
  const read = (name: string) => {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`The preview folder has no ${name}.`);
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const array = (name: string): PlanRecord[] => {
    const value = read(name);
    if (!Array.isArray(value)) throw new Error(`${name} must be a list.`);
    return value;
  };
  const summary = read("summary.json");
  const batch = String(summary.importBatch ?? "");
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(batch))
    throw new Error("summary.json needs a plain importBatch name.");
  return {
    batch,
    companies: array("companies.json"),
    contacts: array("contacts.json"),
    deals: array("deals.json"),
    tasks: array("tasks.json"),
    documents: array("documents.json"),
    activities: array("activities.json"),
    dedup: read("dedup-keys.json"),
    held: read("held-not-imported.json"),
  };
}

// ───────────────────────────── report ─────────────────────────────
export type Kind = "company" | "contact" | "deal" | "task" | "document" | "activity";
export type Action =
  | "create"
  | "update"
  | "unchanged"
  | "kept"
  | "conflict"
  | "duplicate"
  | "waiting"
  | "orphan"
  | "error"
  | "adopted"
  | "attached"
  | "changed"
  | "skipped";
export type ReportLine = {
  kind: Kind;
  key: string;
  action: Action;
  fields?: string[];
  reason?: string;
  matches?: DuplicateMatch[];
};
export type DuplicateMatch = {
  companyId: string;
  name: string;
  locality: string;
  reasons: string[];
};
export type ImportReport = {
  batch: string;
  mode: "dry-run" | "apply";
  counts: Record<Kind, Record<Action, number>>;
  files: { added: number; unchanged: number; missing: string[] };
  held: Record<string, number>;
  lines: ReportLine[];
  /** Set when any line was an error or conflict: the whole import was rolled back and nothing was written. */
  aborted?: string;
};
const ACTIONS: Action[] = [
  "create",
  "update",
  "unchanged",
  "kept",
  "conflict",
  "duplicate",
  "waiting",
  "orphan",
  "error",
  "adopted",
  "attached",
  "changed",
  "skipped",
];
const KINDS: Kind[] = ["company", "contact", "deal", "task", "document", "activity"];
function emptyCounts() {
  return Object.fromEntries(
    KINDS.map((k) => [k, Object.fromEntries(ACTIONS.map((a) => [a, 0]))]),
  ) as ImportReport["counts"];
}

export type Decision =
  | { action: "create" }
  | { action: "skip" }
  | { action: "attach"; companyId: string };
export type ImportOptions = {
  extractedDir: string;
  /** Person decisions for probable duplicates, keyed by the plan's company externalKey. */
  decisions?: Record<string, Decision>;
  mode: "dry-run" | "apply";
};

// ───────────────────────────── ledger ─────────────────────────────
/** Marks a ledger link made by "attach": the existing company is never reconciled or edited, on this run or any later one. */
const ATTACHED = "__attached";
type Ledger = { planned: Record<string, string>; saved: Record<string, string | string[]> };
function ensureLedger(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS crm_import_links(
    batch TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, record_id TEXT NOT NULL,
    planned TEXT NOT NULL, saved TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
    PRIMARY KEY(batch,kind,key));`);
}
type Link = { recordId: string; ledger: Ledger; raw: string };
function getLink(db: Database, batch: string, kind: Kind, key: string): Link | null {
  const row = db
    .query(
      "SELECT record_id,planned,saved FROM crm_import_links WHERE batch=? AND kind=? AND key=?",
    )
    .get(batch, kind, key) as { record_id: string; planned: string; saved: string } | null;
  if (!row) return null;
  return {
    recordId: row.record_id,
    ledger: { planned: JSON.parse(row.planned), saved: JSON.parse(row.saved) },
    raw: row.planned + row.saved,
  };
}
function putLink(
  db: Database,
  batch: string,
  kind: Kind,
  key: string,
  recordId: string,
  ledger: Ledger,
  now: string,
  previous: Link | null,
): void {
  const planned = JSON.stringify(ledger.planned),
    saved = JSON.stringify(ledger.saved);
  if (previous && previous.raw === planned + saved && previous.recordId === recordId) return; // re-runs write nothing
  if (previous)
    db.query(
      "UPDATE crm_import_links SET record_id=?,planned=?,saved=?,last_at=? WHERE batch=? AND kind=? AND key=?",
    ).run(recordId, planned, saved, now, batch, kind, key);
  else
    db.query(
      "INSERT INTO crm_import_links(batch,kind,key,record_id,planned,saved,first_at,last_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(batch, kind, key, recordId, planned, saved, now, now);
}

// ───────────────────────────── normalisation ─────────────────────────────
const normal = (s: string) => s.trim().toLocaleLowerCase("en-AU").replace(/\s+/g, " ");
const phoneDigits = (s: string) => s.replace(/\D/g, "").replace(/^61/, "0");
export function normName(s: string): string {
  return s
    .toLocaleLowerCase("en-AU")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/\((nsw|aust|australia)\)/g, " ")
    .replace(/\b(pty\.?\s*ltd\.?|pty|ltd\.?|limited|the)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const FREE_MAIL = new Set([
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "bigpond.com",
  "icloud.com",
  "live.com",
]);
const host = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function keysOfCompany(c: {
  name: string;
  locality: string;
  phone: string;
  emails: string[];
  website: string;
}): DedupKeys {
  const names = [c.name, ...c.name.split(" / ").map((s) => s.trim())].map(normName).filter(Boolean);
  const domains = [c.website, ...c.emails.map((e) => e.split("@")[1] ?? "")]
    .map(host)
    .filter((d) => d && !FREE_MAIL.has(d));
  return {
    nameLocality: [...new Set(names)].map((n) => `${n}|${normal(c.locality)}`),
    phones: [phoneDigits(c.phone)].filter((d) => d.length >= 6),
    domains: [...new Set(domains)],
    emails: [...new Set(c.emails.map(normal).filter(Boolean))],
  };
}
export function duplicateReasons(planned: DedupKeys, existing: DedupKeys): string[] {
  const reasons: string[] = [];
  if (planned.emails.some((e) => existing.emails.includes(e))) reasons.push("same email");
  if (planned.phones.some((p) => existing.phones.includes(p))) reasons.push("same phone");
  if (planned.domains.some((d) => existing.domains.includes(d)))
    reasons.push("same website domain");
  if (planned.nameLocality.some((k) => existing.nameLocality.includes(k)))
    reasons.push("same name and locality");
  else {
    const names = new Set(existing.nameLocality.map((k) => k.split("|")[0]));
    if (planned.nameLocality.some((k) => names.has(k.split("|")[0])))
      reasons.push("same name (locality differs or blank), review");
  }
  return reasons;
}

/** What to do with one field: compare the plan, what we last planned, what we last saved and what is there now. */
export function decide(
  p: string,
  last: string | undefined,
  saved: string | undefined,
  now: string,
): "blank" | "match" | "plan-same" | "kept-edited" | "update" | "kept-conflict" {
  if (p === "") return "blank"; // a blank source value never overwrites anything
  if (now === p) return "match";
  if (last === p) return now !== (saved ?? "") ? "kept-edited" : "plan-same";
  if (now === (saved ?? "") || (saved === undefined && now === "")) return "update";
  return "kept-conflict";
}
const canon = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "string" ? v.trim() : JSON.stringify(v);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

// ───────────────────────────── engine ─────────────────────────────
type Spec = { scalars: string[]; sets: string[]; lower?: string[] };
const SPECS: Record<"company" | "contact" | "deal" | "task", Spec> = {
  company: {
    scalars: ["name", "industry", "website", "locality", "address", "phone", "notes"],
    sets: ["emails", "tags"],
    lower: ["emails"],
  },
  contact: { scalars: ["name", "role", "email", "phone", "preferences"], sets: ["restrictions"] },
  deal: { scalars: ["title", "scope", "service", "nextAction", "stageId"], sets: [] },
  task: {
    scalars: ["title", "description", "kind", "status", "dueAt"],
    sets: ["dependsOn", "evidence"],
  },
};

class Run {
  readonly report: ImportReport;
  readonly ids = new Map<string, { kind: Kind; id: string }>(); // plan stageRef -> saved record
  readonly dupKeys = new Map<string, DedupKeys>();
  readonly newBlobs: string[] = [];
  readonly waiting = new Set<string>(); // company stageRefs awaiting a person's decision
  readonly by: Attribution;
  private existing: Company[] = [];
  constructor(
    readonly store: CrmStore,
    readonly plan: PreviewSet,
    readonly options: ImportOptions,
  ) {
    this.by = { agent: "deliverables-import", jobId: plan.batch };
    this.report = {
      batch: plan.batch,
      mode: options.mode,
      counts: emptyCounts(),
      files: { added: 0, unchanged: 0, missing: [] },
      held: {},
      lines: [],
    };
    for (const entry of plan.dedup) this.dupKeys.set(entry.stageRef, entry.keys);
  }
  get db() {
    return this.store.db;
  }
  now() {
    return new Date().toISOString();
  }
  note(kind: Kind, key: string, action: Action, extra: Partial<ReportLine> = {}) {
    this.report.counts[kind][action]++;
    this.report.lines.push({ kind, key, action, ...extra });
  }
  guard<T>(kind: Kind, key: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      const idem = error instanceof CrmError && error.code === "idempotency-conflict";
      this.note(kind, key, idem ? "conflict" : "error", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** Create-or-reconcile a record described by the generic spec. `create` runs only when no ledger link exists. */
  private reconcile<T extends Record<string, any>>(
    kind: "company" | "contact" | "deal" | "task",
    key: string,
    planned: Record<string, any>,
    create: () => T,
    read: (id: string) => T | null,
    patch: (current: T, change: Record<string, unknown>) => T,
    preLinked?: string,
  ): T | undefined {
    const spec = SPECS[kind];
    const link = getLink(this.db, this.plan.batch, kind, key);
    const plannedValue = (field: string) =>
      spec.lower?.includes(field)
        ? list(planned[field]).map((v) => v.toLowerCase())
        : planned[field];
    const snapshot = (record: Record<string, any>): Ledger["saved"] =>
      Object.fromEntries([
        ...spec.scalars.map((f) => [f, canon(record[f])]),
        ...spec.sets.map((f) => [f, list(record[f])]),
      ]);
    const plannedLedger = (): Ledger["planned"] =>
      Object.fromEntries([
        ...spec.scalars.map((f) => [f, canon(plannedValue(f))]),
        ...spec.sets.map((f) => [f, JSON.stringify(list(plannedValue(f)))]),
      ]);
    if (link?.ledger.planned[ATTACHED] === "1") {
      const existing = read(link.recordId);
      this.note(kind, key, "unchanged", {
        reason: "attached to an existing record; never edited by the import",
      });
      return existing ?? undefined;
    }
    if (!link) {
      if (preLinked) {
        const record = read(preLinked);
        if (!record) return undefined;
        putLink(
          this.db,
          this.plan.batch,
          kind,
          key,
          preLinked,
          { planned: plannedLedger(), saved: snapshot(record) },
          this.now(),
          null,
        );
        this.note(kind, key, "adopted", { reason: "already present; linked without changes" });
        return record;
      }
      const record = create();
      putLink(
        this.db,
        this.plan.batch,
        kind,
        key,
        record.id,
        { planned: plannedLedger(), saved: snapshot(record) },
        this.now(),
        null,
      );
      this.note(kind, key, "create");
      return record;
    }
    const current = read(link.recordId);
    if (!current) {
      this.note(kind, key, "conflict", { reason: "the linked record no longer exists" });
      return undefined;
    }
    const change: Record<string, unknown> = {};
    const kept: string[] = [];
    const nextPlanned = { ...link.ledger.planned };
    const nextSaved = { ...link.ledger.saved };
    for (const field of spec.scalars) {
      const p = canon(plannedValue(field));
      const verdict = decide(
        p,
        link.ledger.planned[field],
        link.ledger.saved[field] as string | undefined,
        canon(current[field]),
      );
      if (verdict === "update") {
        change[field] = plannedValue(field);
        nextPlanned[field] = p;
      } else if (verdict === "match") {
        nextPlanned[field] = p;
        nextSaved[field] = canon(current[field]);
      } else if (verdict === "kept-edited" || verdict === "kept-conflict") kept.push(field);
    }
    for (const field of spec.sets) {
      const want = list(plannedValue(field));
      const have = new Set(list(current[field]));
      const was = new Set(((link.ledger.saved[field] as string[] | undefined) ?? []).map(String));
      const add = want.filter((v) => !have.has(v) && !was.has(v));
      if (add.length) change[field] = [...list(current[field]), ...add];
      if (want.some((v) => !have.has(v) && was.has(v))) kept.push(field); // a person removed it
      nextPlanned[field] = JSON.stringify(want);
    }
    let record = current;
    if (Object.keys(change).length) {
      record = patch(current, change);
      for (const field of Object.keys(change))
        nextSaved[field] = spec.sets.includes(field) ? list(record[field]) : canon(record[field]);
      for (const field of spec.sets)
        if (!(field in change))
          nextSaved[field] = [
            ...new Set([
              ...((link.ledger.saved[field] as string[] | undefined) ?? []),
              ...list(current[field]),
            ]),
          ];
    } else
      for (const field of spec.sets)
        nextSaved[field] = [
          ...new Set([
            ...((link.ledger.saved[field] as string[] | undefined) ?? []),
            ...list(current[field]),
          ]),
        ];
    putLink(
      this.db,
      this.plan.batch,
      kind,
      key,
      link.recordId,
      { planned: nextPlanned, saved: nextSaved },
      this.now(),
      link,
    );
    if (Object.keys(change).length)
      this.note(kind, key, "update", {
        fields: Object.keys(change),
        ...(kept.length ? { reason: `kept a person's edit to: ${kept.join(", ")}` } : {}),
      });
    else if (kept.length)
      this.note(kind, key, "kept", {
        fields: kept,
        reason: "edited by a person after import, so left as it is",
      });
    else this.note(kind, key, "unchanged");
    return record;
  }

  // ───── companies ─────
  private companyInput(record: PlanRecord, key: string) {
    const f = record.fields;
    const ref = String(f.source?.reference ?? "");
    const label = `${this.plan.batch}:${record.externalKey}`;
    const sources: Record<string, string> = {};
    for (const field of ["name", "phone", "website"])
      if (canon(f[field])) sources[field] = `import:${this.plan.batch}`;
    if (list(f.emails).length) sources.emails = `import:${this.plan.batch}`;
    return {
      externalKey: key,
      name: f.name,
      industry: f.industry ?? "",
      website: f.website ?? "",
      locality: f.locality ?? "",
      address: f.address ?? "",
      timezone: f.timezone || "Australia/Sydney",
      phone: f.phone ?? "",
      emails: list(f.emails).map((e) => e.toLowerCase()),
      owner: f.owner ?? "",
      tags: list(f.tags),
      status: f.status ?? "prospect",
      notes: f.notes ?? "",
      doNotContact: f.doNotContact === true,
      emailAllowed: f.emailAllowed === true,
      source: {
        kind: (["manual", "csv", "osm", "enquiry", "legacy"].includes(f.source?.kind)
          ? f.source.kind
          : "csv") as "csv",
        reference: ref && !ref.startsWith("<") ? ref : label,
        attribution: `Imported from ${this.plan.batch} by the deliverables importer; reviewed preview, not yet founder-confirmed`,
      },
      fieldSources: sources,
    };
  }
  private matchExisting(record: PlanRecord): DuplicateMatch[] {
    const keys =
      this.dupKeys.get(record.stageRef ?? "") ??
      keysOfCompany({
        name: record.fields.name,
        locality: record.fields.locality ?? "",
        phone: record.fields.phone ?? "",
        emails: list(record.fields.emails),
        website: record.fields.website ?? "",
      });
    const out: DuplicateMatch[] = [];
    for (const company of this.existing) {
      const reasons = duplicateReasons(keys, keysOfCompany(company));
      if (reasons.length)
        out.push({
          companyId: company.id,
          name: company.name,
          locality: company.locality,
          reasons,
        });
    }
    return out;
  }
  companies(): void {
    const batchTag = `import:${this.plan.batch}`;
    const linked = new Set(
      (
        this.db
          .query("SELECT record_id FROM crm_import_links WHERE batch=? AND kind='company'")
          .all(this.plan.batch) as { record_id: string }[]
      ).map((r) => r.record_id),
    );
    this.existing = this.store
      .snapshot()
      .companies.filter((c) => !c.mergedInto && !linked.has(c.id) && !c.tags.includes(batchTag));
    const byTag = new Map<string, Company>();
    for (const c of this.store.snapshot().companies)
      for (const t of c.tags) if (t.startsWith("dot:")) byTag.set(t, c);
    for (const record of this.plan.companies) {
      const stageRef = record.stageRef ?? `stage:company:${record.externalKey}`;
      const key = `${this.plan.batch}:company:${record.externalKey}`;
      this.guard("company", record.externalKey!, () => {
        const have = getLink(this.db, this.plan.batch, "company", record.externalKey!);
        let preLinked: string | undefined;
        if (!have) {
          const tagged = byTag.get(`dot:${record.externalKey}`);
          if (tagged) preLinked = tagged.id;
          else {
            const decision = this.options.decisions?.[record.externalKey!];
            const matches = this.matchExisting(record);
            if (decision?.action === "skip") {
              this.waiting.add(stageRef);
              return this.note("company", record.externalKey!, "skipped", {
                reason: "a person decided to skip this company",
              });
            }
            if (decision?.action === "attach") {
              if (!this.store.getCompany(decision.companyId))
                throw new CrmError(
                  "not-found",
                  "The company chosen for attaching no longer exists.",
                );
              this.ids.set(stageRef, { kind: "company", id: decision.companyId });
              putLink(
                this.db,
                this.plan.batch,
                "company",
                record.externalKey!,
                decision.companyId,
                { planned: { [ATTACHED]: "1" }, saved: {} },
                this.now(),
                null,
              );
              return this.note("company", record.externalKey!, "attached", {
                reason:
                  "attached to the existing company a person chose; its fields were not changed",
              });
            }
            if (matches.length && decision?.action !== "create") {
              this.waiting.add(stageRef);
              return this.note("company", record.externalKey!, "duplicate", {
                matches,
                reason: "probable duplicate of an existing company; decide create, attach or skip",
              });
            }
          }
        }
        const input = this.companyInput(record, key);
        const saved = this.reconcile<Company>(
          "company",
          record.externalKey!,
          input,
          () => this.store.createCompany(input, this.by),
          (id) => this.store.getCompany(id),
          (current, change) =>
            this.store.updateCompany(current.id, change as any, current.version, this.by),
          preLinked,
        );
        if (saved) this.ids.set(stageRef, { kind: "company", id: saved.id });
      });
      // A linked "attached" company from an earlier run resolves from the ledger.
      if (!this.ids.has(stageRef) && !this.waiting.has(stageRef)) {
        const link = getLink(this.db, this.plan.batch, "company", record.externalKey!);
        if (link) this.ids.set(stageRef, { kind: "company", id: link.recordId });
      }
    }
  }
  private company(ref: string | undefined): string | null {
    const hit = ref ? this.ids.get(ref) : undefined;
    return hit?.kind === "company" ? hit.id : null;
  }

  // ───── contacts, deals, tasks ─────
  contacts(): void {
    for (const record of this.plan.contacts) {
      const companyId = this.company(record.companyRef);
      if (!companyId) {
        this.note(
          "contact",
          record.externalKey!,
          this.waiting.has(record.companyRef ?? "") ? "waiting" : "orphan",
          { reason: "its company is held or not imported" },
        );
        continue;
      }
      const f = record.fields;
      const key = `${this.plan.batch}:contact:${record.externalKey}`;
      const input = {
        externalKey: key,
        companyId,
        name: f.name,
        role: f.role ?? "",
        email: f.email ?? "",
        phone: f.phone ?? "",
        primary: f.primary === true,
        preferences: f.preferences ?? "",
        doNotContact: f.doNotContact === true,
        restrictions: list(f.restrictions),
        owner: f.owner ?? "",
        source: f.source,
        fieldSources: f.fieldSources ?? {},
      };
      this.guard("contact", record.externalKey!, () => {
        const sameCompany = this.store.snapshot().contacts.filter((c) => c.companyId === companyId);
        const twin = !getLink(this.db, this.plan.batch, "contact", record.externalKey!)
          ? sameCompany.find(
              (c) =>
                (input.email && c.email === String(input.email).toLowerCase()) ||
                normal(c.name) === normal(input.name),
            )
          : undefined;
        const saved = this.reconcile<Contact>(
          "contact",
          record.externalKey!,
          input,
          () => this.store.createContact(input, this.by),
          (id) => this.store.getContact(id),
          (cur, change) => this.store.updateContact(cur.id, change as any, cur.version, this.by),
          twin?.id,
        );
        if (saved) this.ids.set(record.stageRef!, { kind: "contact", id: saved.id });
      });
    }
  }
  deals(): void {
    for (const record of this.plan.deals) {
      const companyId = this.company(record.companyRef);
      if (!companyId) {
        this.note(
          "deal",
          record.externalKey!,
          this.waiting.has(record.companyRef ?? "") ? "waiting" : "orphan",
          { reason: "its company is held or not imported" },
        );
        continue;
      }
      const f = record.fields;
      const pending =
        record.pricing?.status === "pending-unverified" || record.pricing?.oneOffCents == null;
      const scope = [
        f.scope ?? "",
        record.pricing?.historicalQuote
          ? `\n\nHistorical quote (not a current offer, not an approved price): ${record.pricing.historicalQuote}`
          : "",
      ].join("");
      const key = `${this.plan.batch}:deal:${record.externalKey}`;
      const contactIds = list(f.contactIds)
        .map((ref) => this.ids.get(ref)?.id)
        .filter((v): v is string => !!v);
      const input = {
        externalKey: key,
        companyId,
        title: f.title,
        owner: f.owner ?? "",
        contactIds,
        service: f.service || "website",
        scope,
        pipelineId: f.pipelineId || "sales",
        stageId: f.stageId || "new",
        nextAction: f.nextAction ?? "",
        nextActionDue: f.nextActionDue ?? null,
        expectedClose: f.expectedClose ?? null,
        closeReason: f.closeReason ?? "",
        ...(pending ? { commercialBasis: "pending" as const } : {}),
      };
      this.guard("deal", record.externalKey!, () => {
        const saved = this.reconcile<Deal>(
          "deal",
          record.externalKey!,
          input,
          () => this.store.createDeal(input as any, this.by),
          (id) => this.store.getDeal(id),
          (cur, change) => this.store.updateDeal(cur.id, change as any, cur.version, this.by),
        );
        if (saved) this.ids.set(record.stageRef!, { kind: "deal", id: saved.id });
      });
    }
  }
  tasks(): void {
    for (const record of this.plan.tasks) {
      const companyId = this.company(record.companyRef);
      if (!companyId) {
        this.note(
          "task",
          record.externalKey!,
          this.waiting.has(record.companyRef ?? "") ? "waiting" : "orphan",
          { reason: "its company is held or not imported" },
        );
        continue;
      }
      const f = record.fields;
      const dealId =
        record.dealRef && this.ids.get(record.dealRef)?.kind === "deal"
          ? this.ids.get(record.dealRef)!.id
          : null;
      const description = String(f.description ?? "");
      const dependency = /^Dependencies:\s*(.+)$/im.exec(description)?.[1];
      const prov = record.provenance ?? {};
      const evidence = [
        prov.file
          ? `${basename(String(prov.file))} · ${prov.locator ?? ""} · sha256 ${String(prov.fileSha256 ?? "").slice(0, 12)}`
          : "",
        record.recordedUrl ? `Recorded URL as sent: ${record.recordedUrl}` : "",
      ].filter(Boolean);
      const key = `${this.plan.batch}:task:${record.externalKey}`;
      const input = {
        externalKey: key,
        companyId,
        dealId,
        title: f.title,
        description,
        kind: f.kind || "other",
        status: f.status || "open",
        owner: f.owner ?? "",
        dueAt: f.dueAt ?? null,
        dependsOn: dependency
          ? dependency
              .split(/\s\|\s/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s) => s.slice(0, 2000))
          : [],
        evidence,
      };
      this.guard("task", record.externalKey!, () => {
        const saved = this.reconcile<Task>(
          "task",
          record.externalKey!,
          input,
          () => this.store.createTask(input as any, this.by),
          (id) => this.store.getTask(id),
          (cur, change) => this.store.updateTask(cur.id, change as any, cur.version, this.by),
        );
        if (saved) this.ids.set(record.stageRef!, { kind: "task", id: saved.id });
      });
    }
  }

  // ───── documents (and their private files) ─────
  documents(): void {
    for (const record of this.plan.documents) {
      const companyId = this.company(record.companyRef);
      if (!companyId) {
        this.note(
          "document",
          record.externalKey!,
          this.waiting.has(record.companyRef ?? "") ? "waiting" : "orphan",
          { reason: "its company is held or not imported" },
        );
        continue;
      }
      const dealId =
        record.dealRef && this.ids.get(record.dealRef)?.kind === "deal"
          ? this.ids.get(record.dealRef)!.id
          : null;
      const f = record.fields;
      const key = `${this.plan.batch}:document:${record.externalKey}`;
      const content = String(f.content ?? "");
      this.guard("document", record.externalKey!, () => {
        const link = getLink(this.db, this.plan.batch, "document", record.externalKey!);
        let doc: Document | null = null;
        if (!link) {
          doc = this.store.createDocument(
            {
              externalKey: key,
              companyId,
              dealId,
              title: f.title,
              kind: f.kind ?? "other",
              status: f.status ?? "draft",
              externalUrl: f.externalUrl ?? null,
              content,
              ...(f.pricing ? { pricing: f.pricing } : {}),
            } as any,
            this.by,
          );
          putLink(
            this.db,
            this.plan.batch,
            "document",
            record.externalKey!,
            doc.id,
            {
              planned: { title: canon(f.title), content: sha(content) },
              saved: { title: canon(doc.title), content: sha(doc.versions.at(-1)?.content ?? "") },
            },
            this.now(),
            null,
          );
          this.note("document", record.externalKey!, "create");
        } else {
          doc = this.store.getDocument(link.recordId);
          if (!doc)
            return this.note("document", record.externalKey!, "conflict", {
              reason: "the linked document no longer exists",
            });
          const changed: string[] = [],
            kept: string[] = [];
          const nextPlanned = { ...link.ledger.planned },
            nextSaved = { ...link.ledger.saved };
          const title = decide(
            canon(f.title),
            link.ledger.planned.title,
            link.ledger.saved.title as string | undefined,
            canon(doc.title),
          );
          if (title === "update") {
            doc = this.store.updateDocument(doc.id, { title: f.title }, doc.version, this.by);
            changed.push("title");
            nextPlanned.title = canon(f.title);
            nextSaved.title = canon(doc.title);
          } else if (title === "match") {
            nextPlanned.title = canon(f.title);
            nextSaved.title = canon(doc.title);
          } else if (title.startsWith("kept")) kept.push("title");
          const latest = sha(doc.versions.at(-1)?.content ?? "");
          const body = decide(
            sha(content),
            link.ledger.planned.content,
            link.ledger.saved.content as string | undefined,
            latest,
          );
          if (body === "update") {
            doc = this.store.addDocumentVersion(doc.id, { content }, doc.version, this.by);
            changed.push("content (new version)");
            nextPlanned.content = sha(content);
            nextSaved.content = sha(doc.versions.at(-1)?.content ?? "");
          } else if (body === "match") {
            nextPlanned.content = sha(content);
            nextSaved.content = latest;
          } else if (body.startsWith("kept")) kept.push("content");
          putLink(
            this.db,
            this.plan.batch,
            "document",
            record.externalKey!,
            doc.id,
            { planned: nextPlanned, saved: nextSaved },
            this.now(),
            link,
          );
          if (changed.length)
            this.note("document", record.externalKey!, "update", {
              fields: changed,
              ...(kept.length ? { reason: `kept a person's edit to: ${kept.join(", ")}` } : {}),
            });
          else if (kept.length)
            this.note("document", record.externalKey!, "kept", {
              fields: kept,
              reason: "edited by a person after import, so left as it is",
            });
          else this.note("document", record.externalKey!, "unchanged");
        }
        this.ids.set(record.stageRef!, { kind: "document", id: doc.id });
        this.attach(record, doc.id);
      });
    }
  }
  private attach(record: PlanRecord, documentId: string): void {
    for (const file of stagedFiles(record, this.options.extractedDir)) {
      if ("missing" in file) {
        this.report.files.missing.push(`${record.externalKey}: ${file.missing}`);
        continue;
      }
      const result = this.store.attachFile(documentId, file.name, readFileSync(file.path), this.by);
      if (result.blobCreated) this.newBlobs.push(result.blobPath);
      this.report.files[result.created ? "added" : "unchanged"]++;
    }
  }

  // ───── activities (native eventId idempotency; every reply stays an unsent draft) ─────
  activities(): void {
    for (const record of this.plan.activities) {
      const eventId = String(record.eventId ?? "");
      const target = record.ref ? this.ids.get(record.ref) : undefined;
      if (!target || (target.kind !== "company" && target.kind !== "deal")) {
        const companyRef = record.ref?.startsWith("stage:company:") ? record.ref : undefined;
        this.note("activity", eventId, this.waiting.has(companyRef ?? "") ? "waiting" : "orphan", {
          reason: "its company or deal is held or not imported",
        });
        continue;
      }
      const f = record.fields;
      if (f.communicationState === "sent" || f.communicationState === "received") {
        this.note("activity", eventId, "error", {
          reason: "refused: an import cannot claim a message was sent or received",
        });
        continue;
      }
      this.guard("activity", eventId, () => {
        // The same eventId already saved is a skip whoever runs the import again (never an idempotency-conflict).
        const saved = this.db
          .query("SELECT data FROM crm_activities WHERE event_id=?")
          .get(eventId) as {
          data: string;
        } | null;
        if (saved) {
          const prior = JSON.parse(saved.data) as { title: string; note: string; kind: string };
          // A revised body under the same eventId is reported, never overwritten.
          if (prior.title !== f.title || prior.note !== (f.note ?? "") || prior.kind !== f.kind)
            return this.note("activity", eventId, "changed", {
              reason: "the source text changed after import; the saved activity was left as it is",
            });
          return this.note("activity", eventId, "unchanged");
        }
        const at = f.at ?? record.fields.at;
        this.store.addActivity(
          {
            ref: { kind: target.kind as "company" | "deal", id: target.id },
            eventId,
            kind: f.kind,
            title: f.title,
            note: f.note ?? "",
            ...(at ? { at: String(at) } : {}),
            communicationState: f.communicationState ?? null,
            externalUrl: f.externalUrl ?? null,
          },
          this.by,
        );
        this.note("activity", eventId, "create");
      });
    }
  }
}

// ───────────────────────────── staged files ─────────────────────────────
type Staged = { path: string; name: string } | { missing: string };
/** Find a relative path inside the extracted folder (or one pack folder, or the pack folder nested once), never outside it. */
export function resolveStaged(extractedDir: string, rel: string): string | null {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!cleaned || cleaned.split("/").some((p) => p === ".." || p === "")) return null;
  const root = resolve(extractedDir);
  const roots = [root];
  for (const a of safeDirs(root)) {
    roots.push(join(root, a));
    for (const b of safeDirs(join(root, a))) roots.push(join(root, a, b));
  }
  for (const base of roots) {
    const candidate = resolve(base, cleaned);
    if (candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile())
      return candidate;
  }
  return null;
}
function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
/** Files a document should carry: an explicit `attachments` list, else the DOCX or concept folder its own text names. */
export function stagedFiles(record: PlanRecord, extractedDir: string): Staged[] {
  const out: Staged[] = [];
  const add = (rel: string, name?: string) => {
    const found = resolveStaged(extractedDir, rel);
    if (found) out.push({ path: found, name: name ?? basename(found) });
    else out.push({ missing: rel });
  };
  if (Array.isArray(record.attachments)) {
    for (const item of record.attachments) add(item.path, item.name);
    return out;
  }
  const content = String(record.fields.content ?? "");
  const docx = /stays in staging:\s*(\S+\.docx)/i.exec(content)?.[1];
  if (docx) add(docx);
  // Only a concept document carries its concept folder; an outreach pack that merely mentions a concept path does not.
  const concept = /^CONCEPT/.test(record.externalKey ?? "")
    ? /concepts\/([a-z0-9-]+)\/index\.html/i.exec(content)?.[1]
    : undefined;
  if (concept) {
    const index =
      resolveStaged(extractedDir, `packages/sales/concepts/${concept}/index.html`) ??
      resolveStaged(extractedDir, `concepts/${concept}/index.html`);
    if (!index) out.push({ missing: `concepts/${concept}/` });
    else
      for (const entry of readdirSync(dirname(index), { withFileTypes: true }))
        if (entry.isFile()) out.push({ path: join(dirname(index), entry.name), name: entry.name });
  }
  return out;
}

// ───────────────────────────── entry points ─────────────────────────────
export function runImport(store: CrmStore, plan: PreviewSet, options: ImportOptions): ImportReport {
  if (schemaVersion(store.db) < CRM_SCHEMA_VERSION)
    throw new Error(
      "This CRM database has not had its one-time upgrade. Run scripts/crm/migrate.ts first.",
    );
  ensureLedger(store.db);
  const run = new Run(store, plan, options);
  for (const [name, rows] of Object.entries(plan.held))
    run.report.held[name] = Array.isArray(rows) ? rows.length : 0;
  class Abort extends Error {}
  try {
    store.transaction(() => {
      run.companies();
      run.contacts();
      run.deals();
      run.documents();
      run.tasks();
      run.activities();
      // One bad line means nothing is written: fix it (or the plan) and run again.
      if (run.report.lines.some((l) => l.action === "error" || l.action === "conflict"))
        throw new Abort();
    });
  } catch (error) {
    if (!(error instanceof Abort)) throw error;
    for (const file of run.newBlobs) rmSync(file, { force: true });
    run.report.aborted =
      "Nothing was written: at least one record had an error or conflict. Fix it and run again.";
  }
  return run.report;
}

function copyDatabase(from: string, to: string): void {
  const source = new Database(from, { readonly: true });
  try {
    source.query("VACUUM INTO ?").run(to);
  } finally {
    source.close();
  }
  const copy = new Database(to, { readonly: true });
  try {
    const check = copy.query("PRAGMA integrity_check").all() as Record<string, string>[];
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok")
      throw new Error("Copy integrity check failed.");
  } finally {
    copy.close();
  }
}

export function importDeliverables(args: {
  db: string;
  preview: string;
  extracted: string;
  apply: boolean;
  backup?: string;
  storage?: string;
  decisions?: Record<string, Decision>;
}): ImportReport {
  const dbPath = resolve(args.db);
  if (!existsSync(dbPath))
    throw new Error(
      "Pass --db pointing to an existing crm.sqlite. Never infer the live data directory.",
    );
  // Opening a CrmStore would run the one-time schema upgrade on an old file. The importer never does that: the owner-run migrate.ts does.
  const probe = new Database(dbPath, { readonly: true });
  try {
    if (schemaVersion(probe) < CRM_SCHEMA_VERSION)
      throw new Error(
        "This CRM database has not had its one-time upgrade, so nothing was changed. Run scripts/crm/migrate.ts (--apply --backup) first.",
      );
  } finally {
    probe.close();
  }
  const plan = loadPreview(args.preview);
  if (!existsSync(args.extracted))
    throw new Error("--extracted must be the folder holding the extracted packs.");
  const options: ImportOptions = {
    extractedDir: args.extracted,
    decisions: args.decisions,
    mode: args.apply ? "apply" : "dry-run",
  };
  if (!args.apply) {
    // Dry run = the real import, applied to a throwaway copy. The real database is only read.
    const scratch = mkdtempSync(join(tmpdir(), "crm-import-dry-"));
    try {
      const copy = join(scratch, "crm.sqlite");
      copyDatabase(dbPath, copy);
      const db = new Database(copy);
      const store = new CrmStore(db, {
        attachmentsDir: join(scratch, "crm-files"),
        ownsDatabase: true,
      });
      try {
        return runImport(store, plan, options);
      } finally {
        store.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (!args.backup || existsSync(args.backup) || resolve(args.backup) === dbPath)
    throw new Error(
      "--apply needs --backup with a NEW file path. Existing backups are never overwritten.",
    );
  if (dbPath.toLowerCase().includes(`${sep}.operator-data`) && !process.env.MU_IMPORT_ALLOW_LIVE) {
    // not a block: the lead decides which database to name; this only guards against a typo pointing at the repo's own data folder.
  }
  copyDatabase(dbPath, resolve(args.backup));
  const storage = resolve(args.storage ?? join(dirname(dbPath), "crm-files"));
  mkdirSync(storage, { recursive: true });
  const db = new Database(dbPath);
  const store = new CrmStore(db, { attachmentsDir: storage, ownsDatabase: true });
  try {
    return runImport(store, plan, options);
  } finally {
    store.close();
  }
}

export function formatReport(report: ImportReport, verbose = false): string {
  const out: string[] = [`Deliverables import ${report.batch} (${report.mode})`, ""];
  if (report.aborted) out.push(`*** ${report.aborted} ***`, "");
  out.push(
    "kind       " +
      ACTIONS.filter((a) => KINDS.some((k) => report.counts[k][a]))
        .map((a) => a.padStart(10))
        .join(""),
  );
  const shown = ACTIONS.filter((a) => KINDS.some((k) => report.counts[k][a]));
  for (const kind of KINDS)
    out.push(
      kind.padEnd(11) + shown.map((a) => String(report.counts[kind][a]).padStart(10)).join(""),
    );
  out.push(
    "",
    `files: ${report.files.added} added, ${report.files.unchanged} already stored, ${report.files.missing.length} missing`,
  );
  for (const line of report.files.missing) out.push(`  missing: ${line}`);
  out.push(
    `held (never imported): ${Object.entries(report.held)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  const notable = report.lines.filter(
    (l) =>
      ["duplicate", "conflict", "error", "kept", "changed", "waiting", "orphan"].includes(l.action) ||
      (verbose && l.action !== "unchanged"),
  );
  if (notable.length) out.push("", "Needs a person:");
  for (const l of notable) {
    out.push(
      `  ${l.action.toUpperCase()} ${l.kind} ${l.key}${l.fields ? ` [${l.fields.join(", ")}]` : ""}${l.reason ? ` - ${l.reason}` : ""}`,
    );
    for (const m of l.matches ?? [])
      out.push(
        `      probably ${m.companyId} "${m.name}" (${m.locality || "no locality"}): ${m.reasons.join("; ")}`,
      );
  }
  return out.join("\n");
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const after = (flag: string) => {
      const at = args.indexOf(flag);
      return at === -1 ? undefined : args[at + 1];
    };
    const db = after("--db"),
      preview = after("--preview"),
      extracted = after("--extracted");
    if (!db || !preview || !extracted)
      throw new Error(
        "Usage: --db <crm.sqlite> --preview <folder> --extracted <folder> [--apply --backup <new.sqlite>] [--decisions <json>] [--report <file>] [--storage <folder>]",
      );
    const apply = args.includes("--apply");
    if (apply && args.includes("--dry-run"))
      throw new Error("Choose --dry-run or --apply, not both.");
    const reportFile = after("--report");
    const repoRoot = resolve(import.meta.dir, "..", "..");
    if (reportFile) {
      const rel = relative(repoRoot, resolve(reportFile));
      if (!rel.startsWith("..") && !rel.startsWith(sep))
        throw new Error("Write the report outside the repository: it names private clients.");
    }
    const decisionsFile = after("--decisions");
    const report = importDeliverables({
      db,
      preview,
      extracted,
      apply,
      backup: after("--backup"),
      storage: after("--storage"),
      decisions: decisionsFile ? JSON.parse(readFileSync(decisionsFile, "utf8")) : undefined,
    });
    console.log(formatReport(report, args.includes("--verbose")));
    if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2));
    if (report.aborted || report.lines.some((l) => l.action === "error")) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
