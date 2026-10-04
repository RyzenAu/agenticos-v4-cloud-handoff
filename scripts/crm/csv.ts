/** Bounded RFC 4180 CSV parsing and spreadsheet-safe export. Imports are previewed before any records change. */
import { createHash, randomUUID } from "node:crypto";
import type { CrmStore } from "./store";
import type { Attribution, CrmSnapshot } from "./types";

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 5000;
export const CSV_MAX_COLUMNS = 64;
export type CsvKind = "companies" | "contacts" | "deals";
export class CsvError extends Error {
  readonly code = "CSV_INVALID";
}
export function parseCsv(input: string): string[][] {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > CSV_MAX_BYTES)
    throw new CsvError("CSV must be text no larger than 2 MiB.");
  const text = input.replace(/^\uFEFF/, "");
  if (text.includes("\0")) throw new CsvError("CSV contains a NUL character.");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const pushField = () => {
    row.push(field);
    field = "";
    closed = false;
    if (row.length > CSV_MAX_COLUMNS) throw new CsvError("CSV has too many columns.");
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    if (rows.length > CSV_MAX_ROWS + 1)
      throw new CsvError("CSV has too many rows (maximum 5,000 records).");
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === ",") pushField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === '"' || closed)
      throw new CsvError(`Malformed quoted field on row ${rows.length + 1}.`);
    else field += c;
  }
  if (quoted) throw new CsvError("CSV has an unterminated quoted field.");
  if (field || row.length || closed) pushRow();
  return rows;
}
/** Quote every cell. Prefix formula/control starts, even after whitespace, with an apostrophe. */
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\uFEFF]*[=+@\-\t\r\n]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function serialiseCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export type CsvConflict = { id: string; version: number; label: string; reason: string };
export type CsvPreviewRow = {
  row: number;
  values: Record<string, string>;
  errors: string[];
  conflicts: CsvConflict[];
};
export type CsvPreview = {
  id: string;
  kind: CsvKind;
  createdAt: string;
  rows: CsvPreviewRow[];
  valid: number;
  invalid: number;
  conflicts: number;
  headers: string[];
  /** Columns the CRM's own export adds (id, version, source, currency): read as context, never imported. */
  ignored?: string[];
};
export type CsvResolution = {
  row: number;
  action: "create" | "skip" | "update";
  recordId?: string;
  companyId?: string;
  expectedVersion?: number;
};
export type CsvCommit = {
  previewId: string;
  created: number;
  updated: number;
  skipped: number;
  ids: string[];
  duplicate: boolean;
};
const HEADERS: Record<CsvKind, readonly string[]> = {
  companies: [
    "name",
    "industry",
    "website",
    "locality",
    "timezone",
    "email",
    "phone",
    "owner",
    "tags",
    "notes",
    "optedOut",
  ],
  contacts: ["companyId", "name", "role", "email", "phone", "primary", "preferences", "optedOut"],
  deals: [
    "companyId",
    "title",
    "owner",
    "service",
    "scope",
    "pipelineId",
    "stageId",
    "oneOffCents",
    "recurringCents",
    "gst",
    "expectedClose",
    "nextAction",
    "nextActionDue",
    "closeReason",
    "commercialBasis",
    "catalogueId",
  ],
};
/** A header as people write it: case, spaces, hyphens and underscores do not matter ("Business name", "business_name" and "businessName" are one column). */
const headerKey = (s: string) => s.toLocaleLowerCase("en-AU").replace(/[^a-z0-9]/g, "");
const ALIASES: Record<CsvKind, Record<string, string>> = {
  companies: {
    businessname: "name",
    company: "name",
    companyname: "name",
    category: "industry",
    vertical: "industry",
    url: "website",
    web: "website",
    site: "website",
    suburb: "locality",
    area: "locality",
    city: "locality",
    tz: "timezone",
    emails: "email",
    emailaddress: "email",
    emailaddresses: "email",
    businessemail: "email",
    mobile: "phone",
    telephone: "phone",
    phonenumber: "phone",
    businessphone: "phone",
    responsiblefounder: "owner",
    note: "notes",
    internalnotes: "notes",
    donotcontact: "optedOut",
    optout: "optedOut",
  },
  contacts: {
    company: "companyId",
    fullname: "name",
    contactname: "name",
    position: "role",
    emailaddress: "email",
    mobile: "phone",
    telephone: "phone",
    phonenumber: "phone",
    primarycontact: "primary",
    contactpreferences: "preferences",
    donotcontact: "optedOut",
    optout: "optedOut",
    responsiblefounder: "owner",
  },
  deals: {
    company: "companyId",
    dealtitle: "title",
    name: "title",
    deal: "title",
    responsiblefounder: "owner",
    pipeline: "pipelineId",
    stage: "stageId",
    salesstage: "stageId",
    oneoff: "oneOffCents",
    recurring: "recurringCents",
    gsttreatment: "gst",
    expectedclose: "expectedClose",
    nextaction: "nextAction",
    nextactiondue: "nextActionDue",
    reason: "closeReason",
    wonlostreason: "closeReason",
    basis: "commercialBasis",
    catalogue: "catalogueId",
  },
};
/** Columns the CRM's own export adds; they are read-only context and are ignored on import. */
const EXPORT_ONLY = new Set(["version", "source", "currency", "id"]);
/**
 * Each CSV column mapped to the field it means (or null: ignored). Matching is by the field's own name or a common synonym, so the export's own
 * file and a spreadsheet with natural headings both work. Anything else is named in a plain sentence.
 */
function mapHeaders(
  kind: CsvKind,
  headers: string[],
): { columns: (string | null)[]; ignored: string[] } {
  const own = new Map(HEADERS[kind].map((h) => [headerKey(h), h]));
  const columns: (string | null)[] = [];
  const unknown: string[] = [];
  const ignored: string[] = [];
  for (const header of headers) {
    const key = headerKey(header);
    const field = own.get(key) ?? ALIASES[kind][key] ?? null;
    if (field) columns.push(field);
    else if (EXPORT_ONLY.has(key)) {
      columns.push(null);
      ignored.push(header);
    } else {
      columns.push(null);
      unknown.push(header);
    }
  }
  if (unknown.length)
    throw new CsvError(
      `These columns aren't recognised: ${unknown.join(", ")}. Rename them to match (${HEADERS[kind].join(", ")}) or remove them.`,
    );
  const seen = new Map<string, string>();
  for (const [i, field] of columns.entries())
    if (field) {
      const earlier = seen.get(field);
      if (earlier)
        throw new CsvError(
          `The columns "${earlier}" and "${headers[i]}" both mean "${field}". Keep one of them.`,
        );
      seen.set(field, headers[i]);
    }
  return { columns, ignored };
}
const normal = (s: string) => s.trim().toLocaleLowerCase("en-AU").replace(/\s+/g, " ");
const phone = (s: string) => s.replace(/\D/g, "").replace(/^61/, "0");
const bool = (s: string) => /^(true|yes|1)$/i.test(s);

/** Uses the authoritative CRM database; preview and commit receipts survive restart. */
export class CrmCsv {
  constructor(
    readonly store: CrmStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  preview(csv: string, kind: CsvKind = "companies"): CsvPreview {
    if (!HEADERS[kind]) throw new CsvError("Unknown CSV record type.");
    const records = parseCsv(csv);
    if (records.length < 2) throw new CsvError("CSV needs a header and at least one record.");
    const headers = records[0].map((h) => h.trim());
    if (headers.some((h) => !h) || new Set(headers).size !== headers.length)
      throw new CsvError("CSV headers must be non-empty and unique.");
    const { columns, ignored } = mapHeaders(kind, headers);
    const snapshot = this.store.snapshot();
    const prior: CsvPreviewRow[] = [];
    const rows = records
      .slice(1)
      .map((cells, i) => ({ cells, line: i + 2 }))
      .filter(({ cells }) => cells.some((v) => v.trim()))
      .map(({ cells, line }) => {
        const values: Record<string, string> = {};
        columns.forEach((field, j) => {
          if (field) values[field] = cells[j]?.trim() ?? "";
        });
        const recordId = headers.some((h, j) => !columns[j] && headerKey(h) === "id")
          ? (cells[headers.findIndex((h) => headerKey(h) === "id")]?.trim() ?? "")
          : "";
        const errors: string[] = [];
        if (cells.length !== headers.length)
          errors.push(`Expected ${headers.length} columns, found ${cells.length}.`);
        const name = kind === "deals" ? values.title : values.name;
        if (!name) errors.push(`${kind === "deals" ? "title" : "name"} is required.`);
        const limits: Record<string, number> = {
          name: kind === "contacts" ? 300 : 400,
          title: 400,
          industry: 100,
          website: 2000,
          locality: 400,
          timezone: 100,
          email: 254,
          phone: 60,
          notes: 10000,
          role: 300,
          preferences: 2000,
          service: 200,
          scope: 10000,
          nextAction: 2000,
          closeReason: 4000,
          catalogueId: 100,
        };
        for (const [key, value] of Object.entries(values))
          if (value.length > (limits[key] ?? 10000))
            errors.push(`${key} is too long (maximum ${limits[key] ?? 10000} characters).`);
        if (values.phone && !/^[+\d\s().-]{5,60}$/.test(values.phone))
          errors.push("Invalid phone number.");
        if (values.tags && values.tags.split(";").filter(Boolean).length > 50)
          errors.push("At most 50 tags are supported.");
        if (values.owner && !["usman", "mehroz"].includes(values.owner))
          errors.push("Owner must be usman or mehroz.");
        if (
          values.email &&
          !(kind === "companies" ? values.email.split(";") : [values.email]).every((e) =>
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()),
          )
        )
          errors.push("Invalid email address.");
        if (values.website) {
          try {
            const u = new URL(values.website);
            if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw 0;
          } catch {
            errors.push("Website must be an http or https URL without credentials.");
          }
        }
        if (values.timezone) {
          try {
            new Intl.DateTimeFormat("en-AU", { timeZone: values.timezone });
          } catch {
            errors.push("Invalid IANA timezone.");
          }
        }
        for (const key of ["primary", "optedOut"])
          if (values[key] && !/^(true|false|yes|no|1|0)$/i.test(values[key]))
            errors.push(`${key} must be true or false.`);
        if (
          kind !== "companies" &&
          (!values.companyId ||
            !snapshot.companies.some((c) => c.id === values.companyId && !c.mergedInto))
        )
          errors.push("companyId must identify an existing company.");
        for (const key of ["oneOffCents", "recurringCents"])
          if (
            values[key] &&
            (!/^\d+$/.test(values[key]) ||
              !Number.isSafeInteger(Number(values[key])) ||
              Number(values[key]) > 100_000_000)
          )
            errors.push(`${key} must be a non-negative integer number of cents.`);
        if (values.gst && !["inclusive", "exclusive", "not-applicable"].includes(values.gst))
          errors.push("GST must be inclusive, exclusive or not-applicable.");
        for (const key of ["expectedClose", "nextActionDue"])
          if (
            values[key] &&
            (!/^\d{4}-\d\d-\d\d(?:T.*(?:Z|[+-]\d\d:\d\d))?$/.test(values[key]) ||
              !Number.isFinite(Date.parse(values[key])) ||
              new Date(values[key].slice(0, 10)).toISOString().slice(0, 10) !==
                values[key].slice(0, 10))
          )
            errors.push(`${key} needs an ISO date or date-time with timezone.`);
        if (values.expectedClose && !/^\d{4}-\d{2}-\d{2}$/.test(values.expectedClose))
          errors.push("expectedClose must be a calendar date (YYYY-MM-DD).");
        if (
          values.commercialBasis &&
          !["catalogue", "agreed", "legacy-unconfirmed", "pending"].includes(values.commercialBasis)
        )
          errors.push("Invalid commercial basis.");
        if (kind === "deals") {
          const pipeline = snapshot.pipelines.find((p) => p.id === (values.pipelineId || "sales"));
          if (
            !pipeline ||
            (values.stageId && !pipeline.stages.some((s) => s.id === values.stageId && !s.archived))
          )
            errors.push("Pipeline or stage is unavailable.");
          if (
            pipeline?.stages.find((s) => s.id === values.stageId)?.category === "lost" &&
            !values.closeReason
          )
            errors.push("Lost deals need a closeReason.");
        }
        const conflicts = csvConflicts(snapshot, kind, values, recordId);
        const repeated = prior.find((row) => {
          const v = row.values;
          return kind === "companies"
            ? normal(v.name || "") === normal(values.name || "") &&
                normal(v.locality || "") === normal(values.locality || "")
            : v.companyId === values.companyId &&
                normal(v[kind === "deals" ? "title" : "name"] || "") === normal(name || "");
        });
        if (repeated)
          conflicts.push({
            id: `csv-row:${repeated.row}`,
            version: 0,
            label: name,
            reason: `duplicates CSV row ${repeated.row}; choose Create or Skip explicitly`,
          });
        const result = { row: line, values, errors, conflicts };
        prior.push(result);
        return result;
      });
    if (!rows.length) throw new CsvError("CSV has no non-empty records.");
    const preview: CsvPreview = {
      id: randomUUID(),
      kind,
      createdAt: this.now(),
      rows,
      valid: rows.filter((r) => !r.errors.length).length,
      invalid: rows.filter((r) => r.errors.length).length,
      conflicts: rows.filter((r) => r.conflicts.length).length,
      headers: columns.map((field, j) => field ?? headers[j]),
      ...(ignored.length ? { ignored } : {}),
    };
    this.store.db
      .query("INSERT INTO crm_csv_previews VALUES (?, ?, ?)")
      .run(preview.id, JSON.stringify(preview), preview.createdAt);
    return preview;
  }
  getPreview(id: string): CsvPreview | null {
    const row = this.store.db.query("SELECT data FROM crm_csv_previews WHERE id=?").get(id) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : null;
  }
  commit(previewId: string, resolutions: CsvResolution[], by: Attribution): CsvCommit {
    if (new Set(resolutions.map((r) => r.row)).size !== resolutions.length)
      throw new CsvError("Each CSV row can have only one decision.");
    const resolutionHash = digest(
      resolutions
        .map((r) => ({
          row: r.row,
          action: r.action,
          recordId: r.recordId ?? r.companyId ?? null,
          expectedVersion: r.expectedVersion ?? null,
        }))
        .sort((a, b) => a.row - b.row),
    );
    return this.store.transaction(() => {
      const prior = this.store.db
        .query("SELECT resolution_hash,receipt FROM crm_csv_commits WHERE preview_id=?")
        .get(previewId) as { resolution_hash: string; receipt: string } | null;
      if (prior) {
        if (prior.resolution_hash !== resolutionHash)
          throw new CsvError(
            "This preview was already committed with different decisions. Make a fresh preview.",
          );
        return { ...JSON.parse(prior.receipt), duplicate: true } as CsvCommit;
      }
      const preview = this.getPreview(previewId);
      if (!preview) throw new CsvError("Import preview not found. Preview the CSV again.");
      if (resolutions.some((r) => !preview.rows.some((row) => row.row === r.row)))
        throw new CsvError("A decision refers to a row outside this preview.");
      const result: CsvCommit = {
        previewId,
        created: 0,
        updated: 0,
        skipped: 0,
        ids: [],
        duplicate: false,
      };
      const currentSnapshot = this.store.snapshot();
      for (const row of preview.rows) {
        const decision = resolutions.find((r) => r.row === row.row);
        if (decision?.action === "skip") {
          result.skipped++;
          continue;
        }
        if (row.errors.length)
          throw new CsvError(`Row ${row.row}: fix the validation errors or explicitly skip it.`);
        if (row.conflicts.length && !decision)
          throw new CsvError(`Row ${row.row}: choose how to resolve the duplicate first.`);
        const values = row.values;
        const newConflicts = csvConflicts(currentSnapshot, preview.kind, values).filter(
          (candidate) => !row.conflicts.some((old) => old.id === candidate.id),
        );
        if (newConflicts.length)
          throw new CsvError(
            `Row ${row.row}: new duplicate candidates appeared after preview. Preview again before importing.`,
          );
        const common = {
          source: {
            kind: "csv" as const,
            reference: preview.id,
            // Who reviewed the rows: a founder, or the agent that committed them (the Dot gateway's collaborator is "dot").
            attribution: "personId" in by ? "Founder-reviewed CSV import" : `CSV import reviewed by ${by.agent} (agent)`,
          },
          fieldSources: Object.fromEntries(
            Object.keys(values)
              .filter((k) => !!values[k])
              .map((k) => [
                k === "email" ? "emails" : k === "optedOut" ? "doNotContact" : k,
                "manual",
              ]),
          ),
        };
        const nonempty = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
        let data: Record<string, unknown>;
        if (preview.kind === "companies") {
          const { email, tags, optedOut, ...rest } = nonempty;
          data = {
            ...rest,
            ...common,
            ...(email
              ? {
                  emails: email
                    .split(";")
                    .map((e) => e.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(tags
              ? {
                  tags: tags
                    .split(";")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(optedOut ? { doNotContact: bool(optedOut) } : {}),
          };
        } else if (preview.kind === "contacts") {
          const { primary, optedOut, ...rest } = nonempty;
          data = {
            ...rest,
            ...common,
            ...(primary ? { primary: bool(primary) } : {}),
            ...(optedOut ? { doNotContact: bool(optedOut) } : {}),
          };
        } else {
          const { gst, oneOffCents, recurringCents, ...rest } = nonempty;
          data = {
            ...rest,
            ...(gst ? { gstTreatment: gst } : {}),
            ...(oneOffCents ? { oneOffCents: Number(oneOffCents) } : {}),
            ...(recurringCents ? { recurringCents: Number(recurringCents) } : {}),
          };
        }
        let record: { id: string };
        if (decision?.action === "update") {
          const id = decision.recordId ?? decision.companyId;
          const conflict = row.conflicts.find((c) => c.id === id);
          if (
            !id ||
            !conflict ||
            id.startsWith("csv-row:") ||
            decision.expectedVersion !== conflict.version
          )
            throw new CsvError(
              `Row ${row.row}: choose a listed existing record with its preview version.`,
            );
          delete data.companyId;
          if (preview.kind === "companies") {
            const current = this.store.getCompany(id);
            if (!current) throw new CsvError("Company no longer exists.");
            data.source = current.source;
            data.fieldSources = { ...current.fieldSources, ...common.fieldSources };
            // CSV never revokes an opt-out or exclusion, and never silently deletes existing contact routes.
            data.doNotContact = current.doNotContact || data.doNotContact === true;
            if (data.emails)
              data.emails = [...new Set([...current.emails, ...(data.emails as string[])])];
            if (data.tags) data.tags = [...new Set([...current.tags, ...(data.tags as string[])])];
            record = this.store.updateCompany(id, data, decision.expectedVersion!, by);
          } else if (preview.kind === "contacts") {
            const current = this.store.getContact(id);
            if (!current) throw new CsvError("Contact no longer exists.");
            data.source = current.source;
            data.fieldSources = { ...current.fieldSources, ...common.fieldSources };
            data.doNotContact = current.doNotContact || data.doNotContact === true;
            record = this.store.updateContact(id, data, decision.expectedVersion!, by);
          } else record = this.store.updateDeal(id, data, decision.expectedVersion!, by);
          result.updated++;
        } else {
          if (preview.kind === "companies")
            record = this.store.createCompany(data as Parameters<CrmStore["createCompany"]>[0], by);
          else if (preview.kind === "contacts")
            record = this.store.createContact(data as Parameters<CrmStore["createContact"]>[0], by);
          else record = this.store.createDeal(data as Parameters<CrmStore["createDeal"]>[0], by);
          result.created++;
        }
        result.ids.push(record.id);
      }
      this.store.db
        .query("INSERT INTO crm_csv_commits VALUES (?,?,?)")
        .run(preview.id, resolutionHash, JSON.stringify(result));
      return result;
    });
  }
  export(kind: CsvKind): { filename: string; csv: string; count: number } {
    const s = this.store.snapshot();
    let headers: string[], rows: unknown[][];
    if (kind === "companies") {
      headers = ["id", ...HEADERS.companies, "source", "version"];
      rows = s.companies
        .filter((c) => !c.mergedInto)
        .map((c) => [
          c.id,
          c.name,
          c.industry,
          c.website,
          c.locality,
          c.timezone,
          c.emails.join(";"),
          c.phone,
          c.owner,
          c.tags.join(";"),
          c.notes,
          c.doNotContact,
          c.source.kind,
          c.version,
        ]);
    } else if (kind === "contacts") {
      headers = ["id", ...HEADERS.contacts, "version"];
      rows = s.contacts.map((c) => [
        c.id,
        c.companyId,
        c.name,
        c.role,
        c.email,
        c.phone,
        c.primary,
        c.preferences,
        c.doNotContact,
        c.version,
      ]);
    } else if (kind === "deals") {
      headers = ["id", ...HEADERS.deals, "currency", "version"];
      rows = s.deals.map((d) => [
        d.id,
        d.companyId,
        d.title,
        d.owner,
        d.service,
        d.scope,
        d.pipelineId,
        d.stageId,
        d.commercialBasis === "pending" ? "" : d.oneOffCents,
        d.commercialBasis === "pending" ? "" : d.recurringCents,
        d.gstTreatment,
        d.expectedClose,
        d.nextAction,
        d.nextActionDue,
        d.closeReason,
        d.commercialBasis,
        d.catalogueId,
        d.currency,
        d.version,
      ]);
    } else throw new CsvError("Unknown CSV export type.");
    return { filename: `crm-${kind}.csv`, csv: serialiseCsv(headers, rows), count: rows.length };
  }
}

function csvConflicts(
  snapshot: CrmSnapshot,
  kind: CsvKind,
  values: Record<string, string>,
  recordId = "",
): CsvConflict[] {
  const conflicts: CsvConflict[] = [];
  const emails = (values.email ?? "").split(";").map(normal).filter(Boolean);
  if (kind === "companies")
    for (const c of snapshot.companies.filter((c) => !c.mergedInto)) {
      const reason =
        recordId && c.id === recordId
          ? "same record ID"
          : emails.length && c.emails.some((e) => emails.includes(normal(e)))
            ? "same email"
            : values.phone && phone(c.phone) && phone(c.phone) === phone(values.phone)
              ? "same phone"
              : normal(c.name) === normal(values.name || "") &&
                  (!values.locality || normal(c.locality) === normal(values.locality))
                ? "same name and locality"
                : "";
      if (reason) conflicts.push({ id: c.id, version: c.version, label: c.name, reason });
    }
  if (kind === "contacts")
    for (const c of snapshot.contacts)
      if (
        c.companyId === values.companyId &&
        (normal(c.name) === normal(values.name || "") ||
          (!!values.email && normal(c.email) === normal(values.email)))
      )
        conflicts.push({
          id: c.id,
          version: c.version,
          label: c.name,
          reason: "same company and contact",
        });
  if (kind === "deals")
    for (const d of snapshot.deals)
      if (d.companyId === values.companyId && normal(d.title) === normal(values.title || ""))
        conflicts.push({
          id: d.id,
          version: d.version,
          label: d.title,
          reason: "same company and opportunity title",
        });

  return conflicts;
}
