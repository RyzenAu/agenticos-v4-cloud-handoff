/** Disposable, provider-free CRM measurements. No listener, browser or real data is opened.
 * bun scripts/crm/performance.ts [--sizes=50,500,2000] [--runs=5]
 * Measures server/store and pure UI selectors, not browser paint or network latency.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CrmStore } from "./store";
import type { Versioned } from "./types";
import { createCrmOperations } from "./ops";
import { insertRecord } from "./migrations";
import { filterCompanies, EMPTY_FILTERS } from "../../src/components/crm/selectors";
import type { Principal } from "../identity/principal";

const at = "2026-10-02T12:00:00.000Z";
const by = { personId: "usman" as const };
const principal: Principal = {
  ...by,
  via: "paired-session",
  actor: "human",
  displayName: "Synthetic founder",
};

function seed(db: Database, count: number) {
  const store = new CrmStore(db, { now: () => at });
  const c = store.createCompany(
    {
      name: "Synthetic clinic 0",
      locality: "Parramatta",
      phone: "0299990000",
      emails: ["contact0@example.test"],
      owner: "usman",
    },
    by,
  );
  const contact = store.createContact(
    { companyId: c.id, name: "Synthetic contact 0", email: "person0@example.test" },
    by,
  );
  const deal = store.createDeal(
    {
      companyId: c.id,
      title: "Website 0",
      contactIds: [contact.id],
      service: "website",
      nextAction: "Confirm requirements",
      owner: "usman",
    },
    by,
  );
  const project = store.createProject(
    {
      companyId: c.id,
      dealId: deal.id,
      name: "Website delivery 0",
      scope: "Synthetic five-page website",
    },
    by,
  );
  const task = store.createTask(
    {
      companyId: c.id,
      dealId: deal.id,
      projectId: project.id,
      title: "Review synthetic content",
      kind: "delivery",
      owner: "mehroz",
      dueAt: "2026-10-05T00:00:00.000Z",
    },
    by,
  );
  let document = store.createDocument(
    {
      companyId: c.id,
      dealId: deal.id,
      projectId: project.id,
      title: "Website brief 0",
      kind: "brief",
      content: "Synthetic requirements. ".repeat(40),
    },
    by,
  );
  document = store.addDocumentVersion(
    document.id,
    { content: "Reviewed synthetic requirements. ".repeat(40) },
    document.version,
    by,
  );
  const activity = store.addActivity(
    {
      ref: { kind: "project", id: project.id },
      eventId: "synthetic-0:result",
      kind: "note",
      title: "Synthetic requirements saved",
      note: "No client contact or provider action.",
    },
    by,
  );
  const insert = <T extends Versioned>(
    table: string,
    record: T,
    columns: Record<string, string | number | null> = {},
  ) => insertRecord(db, table, record, columns);
  db.transaction(() => {
    for (let i = 1; i < count; i++) {
      const companyId = `perf-company-${i}`,
        contactId = `perf-contact-${i}`,
        dealId = `perf-deal-${i}`,
        projectId = `perf-project-${i}`,
        documentId = `perf-document-${i}`;
      insert("crm_companies", {
        ...c,
        id: companyId,
        name: i === 49 ? "Synthetic benchmarkneedle clinic" : `Synthetic clinic ${i}`,
        emails: [`contact${i}@example.test`],
      });
      insert(
        "crm_contacts",
        {
          ...contact,
          id: contactId,
          companyId,
          name: `Synthetic contact ${i}`,
          email: `person${i}@example.test`,
        },
        { company_id: companyId },
      );
      insert(
        "crm_deals",
        { ...deal, id: dealId, companyId, title: `Website ${i}`, contactIds: [contactId] },
        { company_id: companyId, pipeline_id: deal.pipelineId, stage_id: deal.stageId },
      );
      db.query("INSERT INTO crm_deal_contacts(deal_id,contact_id) VALUES(?,?)").run(
        dealId,
        contactId,
      );
      insert(
        "crm_projects",
        { ...project, id: projectId, companyId, dealId, name: `Website delivery ${i}` },
        { company_id: companyId, deal_id: dealId },
      );
      insert(
        "crm_tasks",
        { ...task, id: `perf-task-${i}`, companyId, dealId, projectId },
        { company_id: companyId, deal_id: dealId, project_id: projectId, contact_id: null },
      );
      insert(
        "crm_documents",
        {
          ...document,
          id: documentId,
          companyId,
          dealId,
          projectId,
          title: `Website brief ${i}`,
          versions: [],
        },
        { company_id: companyId, deal_id: dealId, project_id: projectId },
      );
      for (const version of document.versions) {
        const v = { ...version, id: `perf-version-${i}-${version.number}`, documentId };
        db.query(
          "INSERT INTO crm_document_versions(id,document_id,number,data) VALUES(?,?,?,?)",
        ).run(v.id, documentId, v.number, JSON.stringify(v));
        db.query(
          "INSERT INTO crm_document_statuses(document_id,version_number,status,at,actor) VALUES(?,?,?,?,?)",
        ).run(documentId, v.number, "draft", at, JSON.stringify(by));
      }
      const a = {
        ...activity,
        id: `perf-activity-${i}`,
        companyId,
        ref: { kind: "project", id: projectId },
        eventId: `synthetic-${i}:result`,
      };
      db.query(
        "INSERT INTO crm_activities(id,event_id,company_id,ref_kind,ref_id,at,data) VALUES(?,?,?,?,?,?,?)",
      ).run(a.id, a.eventId, companyId, a.ref.kind, a.ref.id, a.at, JSON.stringify(a));
    }
  })();
  if (db.query("PRAGMA foreign_key_check").all().length)
    throw new Error("Invalid synthetic fixture");
  return store;
}

export function measureCrmPerformance(sizes = [50, 500, 2000], runs = 5) {
  const results = [];
  for (const count of sizes) {
    const directory = mkdtempSync(join(tmpdir(), "crm-performance-"));
    const db = new Database(join(directory, "crm.sqlite"));
    try {
      const store = seed(db, count),
        ops = createCrmOperations({ store });
      const query = db.query.bind(db);
      let queries = 0;
      db.query = ((sql: string) => {
        const statement = query(sql);
        return new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (["all", "get", "run", "values", "iterate"].includes(String(key))) queries++;
              return value.apply(target, args);
            };
          },
        });
      }) as typeof db.query;
      const measure = (fn: () => unknown) => {
        fn(); // Warm prepared statements, JIT and filesystem caches; excluded from reported samples.
        const samples = [];
        let bytes = 0,
          statements = 0;
        for (let run = 0; run < runs; run++) {
          queries = 0;
          const start = performance.now(),
            value = fn();
          samples.push(performance.now() - start);
          statements = queries;
          bytes = Buffer.byteLength(JSON.stringify(value));
        }
        samples.sort((a, b) => a - b);
        return {
          medianMs: +samples[Math.floor(samples.length / 2)].toFixed(3),
          p95Ms:
            +samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)].toFixed(3),
          queryCount: statements,
          jsonBytes: bytes,
          runs,
        };
      };
      const snapshot = measure(() => store.snapshot());
      const summarySnapshot = measure(() => store.snapshot({ documentSummaries: true }));
      const list = measure(() => ops.run("crm.companies.query", { limit: 50 }, principal));
      const search = measure(() =>
        ops.run("crm.companies.query", { search: "benchmarkneedle", limit: 50 }, principal),
      );
      const loaded = store.snapshot();
      const uiSearch = measure(() =>
        filterCompanies(loaded, { ...EMPTY_FILTERS, search: "benchmarkneedle" }),
      );
      results.push({
        companies: count,
        contacts: count,
        deals: count,
        tasks: count,
        projects: count,
        documents: count,
        documentVersions: count * 2,
        activities: count,
        snapshot,
        summarySnapshot,
        list,
        search,
        uiSearch,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return {
    at: new Date().toISOString(),
    runtime: `Bun ${Bun.version}`,
    scope:
      "Warm local SQLite + operations + pure selector timings. No HTTP, browser paint, network or provider measurements. queryCount counts executed prepared statements, excluding transaction BEGIN/COMMIT/PRAGMA and seeding.",
    results,
  };
}

if (import.meta.main) {
  const arg = (key: string) => process.argv.find((a) => a.startsWith(`--${key}=`))?.split("=")[1];
  const sizes = arg("sizes")?.split(",").map(Number) ?? [50, 500, 2000];
  const runs = Number(arg("runs") ?? 5);
  if (
    sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 10000) ||
    !Number.isSafeInteger(runs) ||
    runs < 1 ||
    runs > 30
  )
    throw new Error("Use sizes 1–10000 and runs 1–30.");
  console.log(JSON.stringify(measureCrmPerformance(sizes, runs), null, 2));
}
