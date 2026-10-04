// Importer tests. Everything here is SYNTHETIC: fictional businesses, invented files, a temporary database and folders.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CrmStore } from "./store";
import {
  decide,
  duplicateReasons,
  importDeliverables,
  keysOfCompany,
  normName,
  resolveStaged,
  type Decision,
  type ImportReport,
} from "./import-deliverables";
import type { Attribution } from "./types";

const BATCH = "synthetic-20260101";
const founder: Attribution = { personId: "usman" };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Rec = Record<string, any>;
function companyRec(key: string, name: string, locality: string, extra: Rec = {}): Rec {
  return {
    stageRef: `stage:company:${key}`,
    externalKey: key,
    fields: {
      name,
      industry: "Bakery",
      website: extra.website ?? "",
      locality,
      address: "",
      timezone: "Australia/Sydney",
      phone: extra.phone ?? "",
      emails: extra.emails ?? [],
      owner: "",
      tags: [`import:${BATCH}`, `dot:${key}`, "consent:not-established"],
      status: "prospect",
      notes: extra.notes ?? "Synthetic note.",
      doNotContact: false,
      emailAllowed: false,
      source: {
        kind: "csv",
        reference: "<previewId assigned by crm.csv.preview>",
        attribution: "x",
      },
    },
  };
}
function plan(overrides: Partial<Record<string, Rec[]>> = {}): Record<string, any> {
  const companies = overrides.companies ?? [
    companyRec("HB-001", "Harbourline Bakery", "Parramatta", {
      phone: "0298765432",
      emails: ["hello@harbourline.example"],
      website: "https://harbourline.example/",
    }),
    companyRec("QP-002", "Quillon Plumbing", "Blacktown", { phone: "0287654321" }),
    companyRec("WG-003", "Wattle Grove Florist", "Liverpool"),
    companyRec("BIZ-FERN-CAFE", "Fernhill Cafe", "Penrith", { emails: ["owner@fernhill.example"] }),
  ];
  const deal = (key: string, company: string, extra: Rec = {}) => ({
    stageRef: `stage:deal:${key}`,
    externalKey: `${key}:deal`,
    companyRef: `stage:company:${company}`,
    fields: {
      title: `Website opportunity (${key})`,
      owner: "",
      service: "website",
      scope: "Fix the contact links.",
      pipelineId: "sales",
      stageId: "qualified",
      nextAction: "Agree the phone number.",
      nextActionDue: null,
      expectedClose: null,
      ...(extra.fields ?? {}),
    },
    pricing: {
      status: "pending-unverified",
      oneOffCents: null,
      recurringCents: null,
      ...(extra.pricing ?? {}),
    },
  });
  const task = (key: string, company: string, dealKey: string, description: string) => ({
    stageRef: `stage:task:${key}`,
    externalKey: key,
    companyRef: `stage:company:${company}`,
    dealRef: `stage:deal:${dealKey}`,
    fields: {
      title: `Owner review [${key}]`,
      kind: "other",
      status: "open",
      owner: "",
      dueAt: null,
      description,
    },
    provenance: {
      file: "extracted/pack-a/records/actions.json",
      fileSha256: "ab".repeat(32),
      locator: `actions[${key}]`,
    },
  });
  return {
    companies,
    contacts: overrides.contacts ?? [
      {
        stageRef: "stage:contact:BIZ-FERN-CAFE",
        externalKey: "BIZ-FERN-CAFE:contact",
        companyRef: "stage:company:BIZ-FERN-CAFE",
        fields: {
          name: "Fern",
          role: "",
          email: "owner@fernhill.example",
          phone: "",
          primary: true,
          preferences: "Thread only.",
          doNotContact: false,
          restrictions: ["send not authorised"],
          owner: "",
          source: { kind: "manual", reference: `${BATCH}:fern`, attribution: "Synthetic" },
          fieldSources: {},
        },
      },
    ],
    deals: overrides.deals ?? [
      deal("HB-001", "HB-001"),
      deal("QP-002", "QP-002"),
      {
        ...deal("BIZ-FERN-CAFE", "BIZ-FERN-CAFE", {
          pricing: { historicalQuote: "Quoted A$100 once (historical)." },
        }),
        fields: {
          title: "Website conversation",
          owner: "",
          contactIds: ["stage:contact:BIZ-FERN-CAFE"],
          service: "website",
          scope: "Ask if still wanted.",
          pipelineId: "sales",
          stageId: "contacted",
          nextAction: "Review the draft.",
          nextActionDue: null,
          expectedClose: null,
        },
      },
    ],
    tasks: overrides.tasks ?? [
      task(
        "ACTION-FERN",
        "BIZ-FERN-CAFE",
        "BIZ-FERN-CAFE",
        "Source status: ready.\nDependencies: Confirm no later SMS | Check suppression list.\nClosure: when sent.",
      ),
      task("MEET-HB-001", "HB-001", "HB-001", "Decide whether to book a meeting."),
    ],
    documents: overrides.documents ?? [
      {
        stageRef: "stage:document:OUT-HB-001",
        externalKey: "OUT-HB-001",
        companyRef: "stage:company:HB-001",
        fields: {
          title: "Unsent outreach pack [OUT-HB-001]",
          kind: "other",
          status: "draft",
          externalUrl: null,
          content: "UNSENT - REVIEW ONLY.\nSubject: hello",
        },
      },
      {
        stageRef: "stage:document:MEET-HB-001",
        externalKey: "MEET-HB-001",
        companyRef: "stage:company:HB-001",
        dealRef: "stage:deal:HB-001",
        fields: {
          title: "Meeting pack [MEET-HB-001]",
          kind: "brief",
          status: "draft",
          externalUrl: null,
          content:
            "Editable DOCX stays in staging: meeting-packs/HB-001-harbourline-meeting-pack.docx.\nStatus: unsent.",
        },
      },
      {
        stageRef: "stage:document:CONCEPT-harbourline",
        externalKey: "CONCEPT-harbourline",
        companyRef: "stage:company:HB-001",
        fields: {
          title: "Private concept [CONCEPT-harbourline]",
          kind: "deliverable",
          status: "draft",
          externalUrl: null,
          content:
            "Staging path: extracted/pack-b/.../packages/sales/concepts/harbourline-bakery/index.html",
        },
      },
    ],
    activities: overrides.activities ?? [
      {
        eventId: `dot:${BATCH}:import:HB-001`,
        ref: "stage:company:HB-001",
        fields: {
          kind: "note",
          title: "Imported (HB-001)",
          note: "provenance",
          communicationState: null,
          at: "2026-10-02T01:00:00.000Z",
        },
      },
      {
        eventId: `dot:${BATCH}:draft:DRAFT-FERN`,
        ref: "stage:deal:BIZ-FERN-CAFE",
        fields: {
          kind: "draft-reply",
          title: "UNSENT draft reply [DRAFT-FERN]",
          note: "Body.",
          communicationState: "drafted",
          at: "2026-10-02T02:00:00.000Z",
        },
      },
      {
        eventId: `dot:${BATCH}:corr:FERN:1`,
        ref: "stage:deal:BIZ-FERN-CAFE",
        fields: {
          kind: "email",
          title: "Last correspondence",
          note: "x",
          communicationState: "unknown",
          at: "2026-08-31T10:29:00.000Z",
        },
      },
    ],
    dedup: [],
    held: {
      identityBlockedCases: [{ holdId: "HOLD-1" }, { holdId: "HOLD-2" }],
      supersededV1Only: [{}],
    },
  };
}
function world(p = plan(), seed?: (store: CrmStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "crm-import-"));
  dirs.push(dir);
  const writePreview = (value: Record<string, any>) => {
    const previewDir = join(dir, "preview");
    mkdirSync(previewDir, { recursive: true });
    for (const [name, data] of Object.entries({
      companies: value.companies,
      contacts: value.contacts,
      deals: value.deals,
      tasks: value.tasks,
      documents: value.documents,
      activities: value.activities,
      "dedup-keys": value.dedup,
      "held-not-imported": value.held,
      summary: { importBatch: BATCH },
    }))
      writeFileSync(join(previewDir, `${name}.json`), JSON.stringify(data));
  };
  writePreview(p);
  const extracted = join(dir, "extracted");
  mkdirSync(join(extracted, "pack-a", "pack-a", "meeting-packs"), { recursive: true });
  writeFileSync(
    join(extracted, "pack-a", "pack-a", "meeting-packs", "HB-001-harbourline-meeting-pack.docx"),
    "synthetic docx body",
  );
  const concept = join(
    extracted,
    "pack-b",
    "pack-b",
    "packages",
    "sales",
    "concepts",
    "harbourline-bakery",
  );
  mkdirSync(concept, { recursive: true });
  writeFileSync(join(concept, "index.html"), "<html>synthetic concept</html>");
  writeFileSync(join(concept, "sources.html"), "<html>synthetic sources</html>");
  const dbFile = join(dir, "crm.sqlite");
  const seedDb = new Database(dbFile);
  const store = new CrmStore(seedDb, { attachmentsDir: join(dir, "crm-files") });
  seed?.(store);
  seedDb.close();
  const args = (extra: Record<string, unknown> = {}) => ({
    db: dbFile,
    preview: join(dir, "preview"),
    extracted,
    apply: false,
    ...extra,
  });
  let backups = 0;
  const apply = (extra: Record<string, unknown> = {}): ImportReport =>
    importDeliverables(
      args({ apply: true, backup: join(dir, `backup-${++backups}.sqlite`), ...extra }) as any,
    );
  const dry = (extra: Record<string, unknown> = {}): ImportReport =>
    importDeliverables(args(extra) as any);
  const read = <T>(fn: (store: CrmStore) => T): T => {
    const db = new Database(dbFile);
    const store = new CrmStore(db, { attachmentsDir: join(dir, "crm-files") });
    try {
      return fn(store);
    } finally {
      db.close();
    }
  };
  const dump = () => {
    const db = new Database(dbFile, { readonly: true });
    try {
      const tables = (
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((t) => t.name);
      return JSON.stringify(tables.map((t) => [t, db.query(`SELECT * FROM ${t}`).all()]));
    } finally {
      db.close();
    }
  };
  return { dir, dbFile, writePreview, apply, dry, read, dump, args };
}
const count = (
  r: ImportReport,
  kind: keyof ImportReport["counts"],
  action: keyof ImportReport["counts"]["company"],
) => r.counts[kind][action];

describe("dry run", () => {
  test("reports what would happen and leaves the real database and storage untouched", () => {
    const w = world();
    const before = w.dump();
    const report = w.dry();
    expect(report.mode).toBe("dry-run");
    expect(count(report, "company", "create")).toBe(4);
    expect(count(report, "deal", "create")).toBe(3);
    expect(count(report, "document", "create")).toBe(3);
    expect(count(report, "task", "create")).toBe(2);
    expect(count(report, "activity", "create")).toBe(3);
    expect(report.files.added).toBe(3);
    expect(report.held).toEqual({ identityBlockedCases: 2, supersededV1Only: 1 });
    expect(w.dump()).toBe(before);
    expect(existsSync(join(w.dir, "crm-files"))).toBe(false);
  });
  test("apply needs a brand-new backup path and refuses an existing one", () => {
    const w = world();
    expect(() => importDeliverables(w.args({ apply: true }) as any)).toThrow(/--backup/);
    writeFileSync(join(w.dir, "exists.sqlite"), "x");
    expect(() =>
      importDeliverables(w.args({ apply: true, backup: join(w.dir, "exists.sqlite") }) as any),
    ).toThrow(/NEW file/);
  });
  test("refuses a database that has not had its one-time upgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-import-raw-"));
    dirs.push(dir);
    const raw = new Database(join(dir, "crm.sqlite"));
    raw.exec("CREATE TABLE leads(id INTEGER PRIMARY KEY)");
    raw.close();
    const w = world();
    expect(() =>
      importDeliverables({
        db: join(dir, "crm.sqlite"),
        preview: join(w.dir, "preview"),
        extracted: join(w.dir, "extracted"),
        apply: false,
      }),
    ).toThrow();
  });
});

describe("apply", () => {
  test("writes the records, with pending prices, unsent drafts, linked tasks and private files", () => {
    const w = world();
    const report = w.apply();
    expect(count(report, "company", "create")).toBe(4);
    expect(report.lines.filter((l) => l.action === "error" || l.action === "conflict")).toEqual([]);
    w.read((store) => {
      const snap = store.snapshot();
      expect(snap.companies).toHaveLength(4);
      const deals = snap.deals;
      expect(deals).toHaveLength(3);
      for (const d of deals)
        expect([d.commercialBasis, d.oneOffCents, d.recurringCents, d.catalogueId]).toEqual([
          "pending",
          0,
          0,
          null,
        ]);
      const fern = snap.companies.find((c) => c.name === "Fernhill Cafe")!;
      const fernDeal = deals.find((d) => d.companyId === fern.id)!;
      expect(fernDeal.scope).toContain("Historical quote (not a current offer");
      expect(fernDeal.stageId).toBe("contacted");
      expect(fernDeal.contactIds).toHaveLength(1);
      const task = snap.tasks.find((t) => t.title.includes("ACTION-FERN"))!;
      expect(task.dependsOn).toEqual(["Confirm no later SMS", "Check suppression list."]);
      expect(task.evidence![0]).toContain("actions.json");
      expect(task.dealId).toBe(fernDeal.id);
      expect(task.owner).toBe("");
      const drafts = snap.activities.filter((a) => a.kind === "draft-reply");
      expect(drafts).toHaveLength(1);
      expect(drafts[0].communicationState).toBe("drafted");
      expect(drafts[0].at).toBe("2026-10-02T02:00:00.000Z");
      expect(snap.activities.find((a) => a.kind === "email")!.communicationState).toBe("unknown");
      const meet = snap.documents.find((d) => d.title.includes("MEET-HB-001"))!;
      expect(meet.attachments!.map((a) => a.name)).toEqual([
        "HB-001-harbourline-meeting-pack.docx",
      ]);
      expect(new TextDecoder().decode(store.openAttachment(meet.attachments![0].id).body)).toBe(
        "synthetic docx body",
      );
      const concept = snap.documents.find((d) => d.title.includes("CONCEPT"))!;
      expect(concept.attachments!.map((a) => a.name).sort()).toEqual([
        "index.html",
        "sources.html",
      ]);
    });
    // files live next to the database, never in the repository
    expect(readdirSync(join(w.dir, "crm-files")).length).toBeGreaterThan(0);
  });
  test("a second apply changes nothing at all", () => {
    const w = world();
    w.apply();
    const after = w.dump();
    const again = w.apply();
    expect(w.dump()).toBe(after);
    for (const kind of ["company", "contact", "deal", "task", "document", "activity"] as const) {
      expect(count(again, kind, "create")).toBe(0);
      expect(count(again, kind, "update")).toBe(0);
    }
    expect(again.files.added).toBe(0);
    expect(again.files.unchanged).toBe(3);
    expect(w.dry().lines.every((l) => l.action === "unchanged")).toBe(true);
  });
  test("the same activity is a skip even when a different founder runs it again", () => {
    const w = world();
    w.apply();
    w.read((store) => {
      // simulate the key being known under a different actor: re-adding by a person with identical details would conflict in the store
      const a = store.snapshot().activities.find((x) => x.kind === "draft-reply")!;
      expect(() =>
        store.addActivity(
          {
            ref: a.ref,
            eventId: a.eventId,
            kind: a.kind,
            title: a.title,
            note: a.note,
            at: a.at,
            communicationState: "drafted",
          },
          founder,
        ),
      ).toThrow(/different activity details|already used/);
    });
    const again = w.apply();
    expect(count(again, "activity", "conflict")).toBe(0);
    expect(count(again, "activity", "unchanged")).toBe(3);
  });
  test("refuses to import a message as sent or received", () => {
    const p = plan();
    p.activities[1].fields.communicationState = "sent";
    const w = world(p);
    const report = w.apply();
    expect(count(report, "activity", "error")).toBe(1);
    w.read((store) =>
      expect(store.snapshot().activities.filter((a) => a.kind === "draft-reply")).toHaveLength(0),
    );
  });
});

describe("a person's correction wins", () => {
  test("edited fields are kept, untouched fields still follow the plan, added tags stay, removed tags stay removed", () => {
    const w = world();
    w.apply();
    w.read((store) => {
      const c = store.snapshot().companies.find((x) => x.name === "Harbourline Bakery")!;
      store.updateCompany(
        c.id,
        {
          phone: "0211112222",
          tags: [...c.tags.filter((t) => t !== "consent:not-established"), "warm-lead"],
        },
        c.version,
        founder,
      );
      const d = store.snapshot().deals.find((x) => x.title.includes("HB-001"))!;
      store.updateDeal(
        d.id,
        { commercialBasis: "agreed", oneOffCents: 150000 },
        d.version,
        founder,
      );
      const t = store.snapshot().tasks.find((x) => x.title.includes("MEET-HB-001"))!;
      store.updateTask(t.id, { status: "done" }, t.version, founder);
    });
    const p = plan();
    p.companies[0].fields.phone = "0299990000"; // plan changes a field the person edited
    p.companies[0].fields.industry = "Artisan bakery"; // plan changes a field nobody touched
    p.deals[0].fields.nextAction = "New next action.";
    w.writePreview(p);
    const report = w.apply();
    expect(report.lines.find((l) => l.kind === "company" && l.key === "HB-001")).toMatchObject({
      action: "update",
      fields: ["industry"],
    });
    expect(report.lines.find((l) => l.kind === "company" && l.key === "HB-001")!.reason).toContain(
      "phone",
    );
    w.read((store) => {
      const c = store.snapshot().companies.find((x) => x.name === "Harbourline Bakery")!;
      expect(c.phone).toBe("0211112222");
      expect(c.industry).toBe("Artisan bakery");
      expect(c.tags).toContain("warm-lead");
      expect(c.tags).not.toContain("consent:not-established");
      const d = store.snapshot().deals.find((x) => x.title.includes("HB-001"))!;
      expect([d.commercialBasis, d.oneOffCents]).toEqual(["agreed", 150000]);
      expect(d.nextAction).toBe("New next action.");
      expect(store.snapshot().tasks.find((x) => x.title.includes("MEET-HB-001"))!.status).toBe(
        "done",
      );
    });
    // and a further run settles: nothing new to write
    const settled = w.dump();
    w.apply();
    expect(w.dump()).toBe(settled);
  });
  test("a changed document body becomes a new version unless a person already added one", () => {
    const w = world();
    w.apply();
    const p = plan();
    p.documents[0].fields.content = "UNSENT - REVIEW ONLY.\nSubject: hello again";
    w.writePreview(p);
    const updated = w.apply();
    expect(updated.lines.find((l) => l.key === "OUT-HB-001")).toMatchObject({ action: "update" });
    w.read((store) =>
      expect(
        store.snapshot().documents.find((d) => d.title.includes("OUT-HB-001"))!.versions,
      ).toHaveLength(2),
    );
    w.read((store) => {
      const doc = store.snapshot().documents.find((d) => d.title.includes("OUT-HB-001"))!;
      store.addDocumentVersion(
        doc.id,
        { content: "Hand-edited by a founder." },
        doc.version,
        founder,
      );
    });
    p.documents[0].fields.content = "UNSENT - REVIEW ONLY.\nSubject: a third wording";
    w.writePreview(p);
    const kept = w.apply();
    expect(kept.lines.find((l) => l.key === "OUT-HB-001")).toMatchObject({ action: "kept" });
    w.read((store) => {
      const doc = store.getDocument(
        store.snapshot().documents.find((d) => d.title.includes("OUT-HB-001"))!.id,
      )!;
      expect(doc.versions.at(-1)!.content).toBe("Hand-edited by a founder.");
      expect(doc.versions).toHaveLength(3);
    });
  });
});

describe("duplicates are reported, never auto-merged", () => {
  const seed = (store: CrmStore) => {
    store.createCompany(
      { name: "Harbourline Bakery Pty Ltd", locality: "Parramatta", phone: "02 9876 5432" },
      founder,
    );
    store.createCompany(
      {
        name: "Totally Different Name",
        locality: "Elsewhere",
        website: "https://quillon.example/about",
        emails: ["x@quillon.example"],
      },
      founder,
    );
  };
  test("probable duplicates are held with their reasons, and their dependants wait", () => {
    const p = plan();
    p.companies[1].fields.website = "https://www.quillon.example/";
    const w = world(p, seed);
    const report = w.apply();
    const hb = report.lines.find((l) => l.kind === "company" && l.key === "HB-001")!;
    expect(hb.action).toBe("duplicate");
    expect(hb.matches![0].reasons).toEqual(
      expect.arrayContaining(["same phone", "same name and locality"]),
    );
    expect(
      report.lines.find((l) => l.kind === "company" && l.key === "QP-002")!.matches![0].reasons,
    ).toContain("same website domain");
    expect(count(report, "company", "create")).toBe(2);
    expect(count(report, "deal", "waiting")).toBe(2);
    expect(count(report, "document", "waiting")).toBe(3);
    w.read((store) => {
      expect(store.snapshot().companies).toHaveLength(2 + 2);
      expect(store.snapshot().companies.filter((c) => c.mergedInto)).toHaveLength(0);
    });
    // nothing was linked or created for the held company
    expect(
      w.apply().lines.filter((l) => l.kind === "company" && l.key === "HB-001")[0].action,
    ).toBe("duplicate");
  });
  test("decisions: create anyway, attach to the existing company, or skip", () => {
    const w = world(plan(), seed);
    const existingId = w.read(
      (s) => s.snapshot().companies.find((c) => c.name.startsWith("Harbourline"))!.id,
    );
    const decisions: Record<string, Decision> = {
      "HB-001": { action: "attach", companyId: existingId },
    };
    const report = w.apply({ decisions });
    expect(report.lines.find((l) => l.kind === "company" && l.key === "HB-001")!.action).toBe(
      "attached",
    );
    w.read((store) => {
      const snap = store.snapshot();
      const existing = snap.companies.find((c) => c.id === existingId)!;
      expect(existing.version).toBe(1); // unchanged: attach never edits the company
      expect(snap.documents.filter((d) => d.companyId === existingId)).toHaveLength(3);
      expect(snap.deals.filter((d) => d.companyId === existingId)).toHaveLength(1);
    });
    const again = w.apply({ decisions });
    expect(count(again, "document", "create")).toBe(0);
    const skipped = world(plan(), seed).apply({ decisions: { "HB-001": { action: "skip" } } });
    expect(count(skipped, "company", "skipped")).toBe(1);
    expect(count(skipped, "deal", "waiting")).toBe(1);
    const forced = world(plan(), seed).apply({ decisions: { "HB-001": { action: "create" } } });
    expect(count(forced, "company", "create")).toBe(4);
  });
  test("a company already carrying the plan's tag is adopted, not duplicated", () => {
    const w = world(plan(), (store) =>
      store.createCompany(
        { name: "Quillon Plumbing", locality: "Blacktown", tags: ["dot:QP-002"] },
        founder,
      ),
    );
    const report = w.apply();
    expect(report.lines.find((l) => l.kind === "company" && l.key === "QP-002")!.action).toBe(
      "adopted",
    );
    w.read((store) =>
      expect(store.snapshot().companies.filter((c) => c.name === "Quillon Plumbing")).toHaveLength(
        1,
      ),
    );
  });
});

describe("held and orphaned records are never invented", () => {
  test("a deal whose company is not in the plan is reported as an orphan, with no company created", () => {
    const p = plan();
    p.deals.push({
      stageRef: "stage:deal:GHOST",
      externalKey: "GHOST:deal",
      companyRef: "stage:company:GHOST",
      fields: { title: "Ghost", stageId: "new" },
      pricing: { status: "pending-unverified" },
    });
    p.activities.push({
      eventId: "ghost-1",
      ref: "stage:deal:GHOST",
      fields: { kind: "note", title: "x" },
    });
    const w = world(p);
    const report = w.apply();
    expect(count(report, "deal", "orphan")).toBe(1);
    expect(count(report, "activity", "orphan")).toBe(1);
    w.read((store) => expect(store.snapshot().companies.map((c) => c.name)).not.toContain("Ghost"));
  });
  test("a missing staged file is reported and the rest of the import carries on", () => {
    const p = plan();
    p.documents[1].fields.content = "Editable DOCX stays in staging: meeting-packs/not-there.docx.";
    const report = world(p).apply();
    expect(report.files.missing[0]).toContain("not-there.docx");
    expect(count(report, "document", "create")).toBe(3);
  });
});

describe("helpers", () => {
  test("decide: the plan, the last plan, the last save and the current value", () => {
    expect(decide("", "a", "a", "z")).toBe("blank");
    expect(decide("a", undefined, undefined, "a")).toBe("match");
    expect(decide("b", "b", "a", "a")).toBe("plan-same");
    expect(decide("b", "b", "a", "x")).toBe("kept-edited");
    expect(decide("b", "a", "a", "a")).toBe("update");
    expect(decide("b", "a", "a", "x")).toBe("kept-conflict");
    expect(decide("b", undefined, undefined, "")).toBe("update");
  });
  test("names and keys normalise the way the plan does", () => {
    expect(normName("The Harbourline Bakery (NSW) Pty Ltd")).toBe("harbourline bakery");
    expect(normName("Smith & Sons")).toBe("smith and sons");
    const a = keysOfCompany({
      name: "A Cafe / B Cafe",
      locality: "Penrith",
      phone: "+61 2 9876 5432",
      emails: ["X@gmail.com", "y@a-cafe.example"],
      website: "https://www.a-cafe.example/menu",
    });
    expect(a.phones).toEqual(["0298765432"]);
    expect(a.domains).toEqual(["a-cafe.example"]);
    expect(a.nameLocality).toEqual(["a cafe b cafe|penrith", "a cafe|penrith", "b cafe|penrith"]);
    expect(
      duplicateReasons(
        a,
        keysOfCompany({
          name: "B Cafe",
          locality: "Elsewhere",
          phone: "",
          emails: [],
          website: "",
        }),
      ),
    ).toEqual(["same name (locality differs or blank), review"]);
  });
  test("staged paths cannot leave the extracted folder", () => {
    const w = world();
    const root = join(w.dir, "extracted");
    expect(resolveStaged(root, "../preview/summary.json")).toBeNull();
    expect(
      resolveStaged(root, "meeting-packs/HB-001-harbourline-meeting-pack.docx"),
    ).not.toBeNull();
    expect(
      readFileSync(
        resolveStaged(root, "packages/sales/concepts/harbourline-bakery/index.html")!,
        "utf8",
      ),
    ).toContain("synthetic concept");
  });
});

describe("which documents carry files", () => {
  test("an outreach pack that merely mentions a concept path gets no files; only the concept document and the meeting DOCX do", () => {
    const p = plan();
    p.documents[0].fields.content +=
      "\nDemo reference: extracted/pack-b/.../packages/sales/concepts/harbourline-bakery/index.html";
    const w = world(p);
    const report = w.apply();
    expect(report.files.added).toBe(3);
    w.read((store) =>
      expect(
        store.snapshot().documents.find((d) => d.title.includes("OUT-HB-001"))!.attachments,
      ).toEqual([]),
    );
  });
});

describe("review fixes", () => {
  test("attaching to an existing company never edits it, on this run or the next", () => {
    const w = world(
      plan(),
      (store) =>
        void store.createCompany(
          { name: "Harbourline Bakery Pty Ltd", locality: "Parramatta", phone: "02 9876 5432" },
          founder,
        ),
    );
    const id = w.read(
      (s2) => s2.snapshot().companies.find((c) => c.name.startsWith("Harbourline"))!.id,
    );
    const decisions: Record<string, Decision> = { "HB-001": { action: "attach", companyId: id } };
    w.apply({ decisions });
    w.apply({ decisions });
    w.apply({ decisions });
    w.read((store) => {
      const c = store.getCompany(id)!;
      expect(c.version).toBe(1);
      expect(c.tags).toEqual([]);
      expect(c.industry).toBe("");
    });
  });
  test("one error aborts the whole apply: nothing is written, and the report says so", () => {
    const p = plan();
    p.activities[1].fields.communicationState = "sent";
    const w = world(p);
    const report = w.apply();
    expect(report.aborted).toMatch(/Nothing was written/);
    w.read((store) => {
      expect(store.snapshot().companies).toHaveLength(0);
      expect(store.snapshot().documents).toHaveLength(0);
    });
    const stored = existsSync(join(w.dir, "crm-files"))
      ? readdirSync(join(w.dir, "crm-files"), { recursive: true }).filter(
          (f) => String(f).length > 60,
        )
      : [];
    expect(stored).toEqual([]);
  });
  test("a revised body under the same eventId is reported as changed at source and not overwritten", () => {
    const w = world();
    w.apply();
    const p = plan();
    p.activities[1].fields.note = "A revised draft body.";
    w.writePreview(p);
    const again = w.apply();
    expect(again.lines.find((l) => l.key.endsWith("DRAFT-FERN"))).toMatchObject({
      action: "changed",
    });
    expect(again.aborted).toBeUndefined();
    w.read((store) =>
      expect(store.snapshot().activities.find((a) => a.kind === "draft-reply")!.note).toBe("Body."),
    );
  });
});
