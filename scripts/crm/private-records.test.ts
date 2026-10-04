// Gaps closed for private, imported records (round 8): a pending price, external keys, task dependencies/evidence and private attachments.
// Synthetic businesses only.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CrmStore } from "./store";
import { CrmCsv } from "./csv";
import { withholdPrivate } from "./redact";
import { openCrm } from "../leads/crm";
import { createCrmOperations, matchesCrmSearch } from "./ops";
import { createCrmMiddleware } from "./plugin";
import { pageTokenFor, type Principal } from "../identity/principal";
import { CrmError, type Attribution } from "./types";

const by: Attribution = { personId: "usman" };
const agent: Attribution = { agent: "import", jobId: "batch-1" };
const dirs: string[] = [];
const dbs: Database[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "crm-private-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  dbs.push(db);
  const store = new CrmStore(db, { attachmentsDir: join(dir, "crm-files") });
  return { dir, db, store };
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const company = (store: CrmStore, name = "Harbourline Bakery") => store.createCompany({ name }, by);

describe("pricing pending", () => {
  test("a pending deal holds no price and never falls back to the catalogue figure", () => {
    const { store } = fresh();
    const c = company(store);
    const deal = store.createDeal(
      { companyId: c.id, title: "Website opportunity", commercialBasis: "pending" },
      agent,
    );
    expect(deal.commercialBasis).toBe("pending");
    expect([deal.oneOffCents, deal.recurringCents, deal.catalogueId]).toEqual([0, 0, null]);
    const normal = store.createDeal({ companyId: c.id, title: "Another" }, by);
    expect(normal.commercialBasis).toBe("catalogue");
    expect(normal.oneOffCents).toBeGreaterThan(0);
  });
  test("amounts cannot be mixed into a pending price, and a pending deal cannot be won", () => {
    const { store } = fresh();
    const c = company(store);
    expect(() =>
      store.createDeal(
        { companyId: c.id, title: "X", commercialBasis: "pending", oneOffCents: 500 },
        by,
      ),
    ).toThrow(/pending price holds no amounts/);
    const deal = store.createDeal({ companyId: c.id, title: "Y", commercialBasis: "pending" }, by);
    expect(() => store.moveDeal(deal.id, "won", deal.version, by)).toThrow(
      /Confirm the agreed price/,
    );
    const agreed = store.updateDeal(
      deal.id,
      { commercialBasis: "agreed", oneOffCents: 120000 },
      deal.version,
      by,
    );
    expect(store.moveDeal(agreed.id, "won", agreed.version, by).stageId).toBe("won");
  });
  test("no proposal can be drafted from a pending price", () => {
    const { store } = fresh();
    const ops = createCrmOperations({ store });
    const c = company(store);
    const deal = store.createDeal({ companyId: c.id, title: "Z", commercialBasis: "pending" }, by);
    const result = ops.run(
      "crm.proposal.draft",
      { dealId: deal.id, expectedVersion: deal.version },
      {
        personId: "usman",
        via: "paired-session",
        actor: "human",
        sessionId: "s",
        displayName: "Usman",
      } as Principal,
    ) as { ok: boolean; text: string };
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Pricing is pending/);
  });
});

describe("external keys", () => {
  test("creating again with a known key returns the same record, for every create", () => {
    const { store } = fresh();
    const c1 = store.createCompany({ name: "Quillon Plumbing", externalKey: "k:company" }, agent);
    const c2 = store.createCompany({ name: "Something else", externalKey: "k:company" }, agent);
    expect(c2.id).toBe(c1.id);
    expect(store.snapshot().companies).toHaveLength(1);
    const p1 = store.createContact(
      { companyId: c1.id, name: "Ana", externalKey: "k:contact" },
      agent,
    );
    expect(
      store.createContact({ companyId: c1.id, name: "Ana B", externalKey: "k:contact" }, agent).id,
    ).toBe(p1.id);
    const d1 = store.createDeal({ companyId: c1.id, title: "D", externalKey: "k:deal" }, agent);
    expect(
      store.createDeal({ companyId: c1.id, title: "D2", externalKey: "k:deal" }, agent).id,
    ).toBe(d1.id);
    const t1 = store.createTask({ companyId: c1.id, title: "T", externalKey: "k:task" }, agent);
    expect(
      store.createTask({ companyId: c1.id, title: "T2", externalKey: "k:task" }, agent).id,
    ).toBe(t1.id);
    const o1 = store.createDocument(
      { companyId: c1.id, title: "Doc", content: "body", externalKey: "k:doc" },
      agent,
    );
    const o2 = store.createDocument(
      { companyId: c1.id, title: "Doc again", content: "body 2", externalKey: "k:doc" },
      agent,
    );
    expect(o2.id).toBe(o1.id);
    expect(store.snapshot().documents).toHaveLength(1);
    expect(store.snapshot().deals).toHaveLength(1);
    expect(store.snapshot().tasks).toHaveLength(1);
  });
  test("a key used for one kind of record cannot be reused for another", () => {
    const { store } = fresh();
    const c = store.createCompany({ name: "Quillon Plumbing", externalKey: "shared-key" }, agent);
    expect(() =>
      store.createContact({ companyId: c.id, name: "Ana", externalKey: "shared-key" }, agent),
    ).toThrow(CrmError);
  });
  test("keys are plain text and cannot be changed by an edit", () => {
    const { store } = fresh();
    expect(() => store.createCompany({ name: "A", externalKey: " padded " }, agent)).toThrow(
      /plain text/,
    );
    const c = company(store);
    expect(() => store.updateCompany(c.id, { externalKey: "x" } as any, c.version, by)).toThrow(
      /Unsupported field/,
    );
  });
});

describe("task dependencies and evidence", () => {
  test("saved, listed, preserved by an unrelated edit, and absent on older records", () => {
    const { store } = fresh();
    const c = company(store);
    const t = store.createTask(
      {
        companyId: c.id,
        title: "Owner review",
        dependsOn: ["Confirm no later SMS"],
        evidence: ["pack.json#case"],
      },
      agent,
    );
    expect(t.dependsOn).toEqual(["Confirm no later SMS"]);
    const edited = store.updateTask(t.id, { description: "changed" }, t.version, by);
    expect(edited.evidence).toEqual(["pack.json#case"]);
    const legacy = store.createTask({ companyId: c.id, title: "Plain" }, by);
    expect(legacy.dependsOn).toEqual([]);
  });
});

describe("private attachments", () => {
  test("stored in the data folder, linked to the document, idempotent and tamper-evident", () => {
    const { dir, store } = fresh();
    const c = company(store);
    const doc = store.createDocument(
      { companyId: c.id, title: "Meeting pack", content: "see file" },
      agent,
    );
    const bytes = new TextEncoder().encode("synthetic docx bytes");
    const first = store.attachFile(doc.id, "pack.docx", bytes, agent);
    expect(first.created).toBe(true);
    expect(store.attachFile(doc.id, "pack.docx", bytes, agent).created).toBe(false);
    expect(store.getDocument(doc.id)!.attachments).toHaveLength(1);
    expect(store.snapshot({ documentSummaries: true }).documents[0].attachments![0].name).toBe(
      "pack.docx",
    );
    expect(new TextDecoder().decode(store.openAttachment(first.attachment.id).body)).toBe(
      "synthetic docx bytes",
    );
    const stored = readdirSync(join(dir, "crm-files"), { recursive: true }).map(String);
    expect(stored.some((f) => f.length > 60)).toBe(true);
    // tamper: same size, different bytes -> refused
    const file = join(
      dir,
      "crm-files",
      first.attachment.sha256.slice(0, 2),
      first.attachment.sha256,
    );
    expect(statSync(file).size).toBe(bytes.byteLength);
    Bun.write(file, new TextEncoder().encode("synthetic docx byteX"));
    return Bun.sleep(30).then(() =>
      expect(() => store.openAttachment(first.attachment.id)).toThrow(/fingerprint/),
    );
  });
  test("file names cannot carry a path, and ids that are not attachment ids are refused", () => {
    const { store } = fresh();
    const c = company(store);
    const doc = store.createDocument({ companyId: c.id, title: "D", content: "x" }, agent);
    const { attachment } = store.attachFile(
      doc.id,
      "..\\..\\evil/../notes.txt",
      new Uint8Array([1, 2, 3]),
      agent,
    );
    expect(attachment.name).toBe("notes.txt");
    expect(() => store.openAttachment("../../etc/passwd")).toThrow(CrmError);
    expect(() => store.attachFile("document-missing", "a.txt", new Uint8Array([1]), agent)).toThrow(
      CrmError,
    );
  });
});

describe("attachment route", () => {
  const token = "t";
  const founder: Principal = {
    personId: "usman",
    via: "paired-session",
    actor: "human",
    sessionId: "s",
    displayName: "Usman",
  };
  const pending: Principal = {
    personId: "usman",
    via: "loopback-owner",
    actor: "process",
    displayName: "Usman",
  };
  const bare: Principal = {
    personId: "usman",
    via: "tailnet-person",
    actor: "process",
    displayName: "Usman",
  };
  let server: Server,
    origin = "",
    db: Database,
    dir = "",
    htmlId = "",
    pdfId = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "crm-route-"));
    db = new Database(":memory:");
    const store = new CrmStore(db, { attachmentsDir: join(dir, "crm-files") });
    const c = store.createCompany({ name: "Harbourline Bakery" }, by);
    const doc = store.createDocument(
      { companyId: c.id, title: "D", content: "Private body text" },
      by,
    );
    store.createContact(
      {
        companyId: c.id,
        name: "Ana",
        email: "ana@example.com",
        preferences: "Private preference note",
      },
      by,
    );
    store.addActivity(
      {
        ref: { kind: "company", id: c.id },
        eventId: "d-1",
        kind: "draft-reply",
        title: "UNSENT",
        note: "Private draft body",
        communicationState: "drafted",
      },
      by,
    );
    htmlId = store.attachFile(
      doc.id,
      "concept.html",
      new TextEncoder().encode("<script>alert(1)</script>"),
      by,
    ).attachment.id;
    pdfId = store.attachFile(doc.id, "note.pdf", new TextEncoder().encode("%PDF-1.4"), by)
      .attachment.id;
    const middleware = createCrmMiddleware({
      root: process.cwd(),
      token,
      principal: (req) =>
        req.headers["x-who"] === "founder"
          ? founder
          : req.headers["x-who"] === "bare"
            ? bare
            : req.headers["x-who"] === "pending"
              ? pending
              : null,
      service: () => ({
        snapshot: () => store.snapshot(),
        resolveLegacyLead: () => null,
        operations: { list: () => [], run: () => ({ ok: true }) },
        file: (id) => store.openAttachment(id),
      }),
    });
    server = createServer(
      (req, res) =>
        void middleware.handle(req, res, () => {
          res.statusCode = 404;
          res.end();
        }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = (id: string, who?: string) =>
    fetch(`${origin}/__crm/file?id=${encodeURIComponent(id)}`, {
      headers: who ? { "x-who": who } : {},
    });
  test("refused without a session, and without a confirmed founder session", async () => {
    expect((await open(htmlId)).status).toBe(401);
    expect((await open(htmlId, "bare")).status).toBe(403);
    // a browser at the hub's own PC that has not been confirmed yet is still not a person
    expect((await open(htmlId, "pending")).status).toBe(403);
  });
  test("opens for a confirmed session; HTML is a sandboxed download, never shown in place", async () => {
    const res = await open(htmlId, "founder");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toStartWith("attachment");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("alert(1)");
    const pdf = await open(pdfId, "founder");
    expect(pdf.headers.get("content-disposition")).toStartWith("inline");
  });
  test("private text is withheld from a pending or bare caller, and shown to a confirmed person", async () => {
    const read = async (who: string) =>
      JSON.stringify(
        await (await fetch(origin + "/__crm/snapshot", { headers: { "x-who": who } })).json(),
      );
    const confirmed = await read("founder");
    for (const secret of [
      "Private body text",
      "Private draft body",
      "Private preference note",
      "concept.html",
    ])
      expect(confirmed).toContain(secret);
    expect(confirmed).not.toContain("privateTextWithheld");
    for (const who of ["pending", "bare"]) {
      const text = await read(who);
      for (const secret of [
        "Private body text",
        "Private draft body",
        "Private preference note",
        "concept.html",
        "note.pdf",
      ])
        expect(text).not.toContain(secret);
      expect(text).toContain("Confirm this browser");
      expect(text).toContain("Harbourline Bakery"); // names and structure stay visible
    }
  });
  test("a proposal, invoice or package quote cannot be drafted by an unconfirmed caller", async () => {
    const draft = (who: string, principal: Principal, name = "crm.proposal.draft") =>
      fetch(origin + "/__crm/ops", {
        method: "POST",
        headers: {
          "x-who": who,
          "content-type": "application/json",
          "x-claude-os-token": pageTokenFor(principal, token),
        },
        body: JSON.stringify({
          name,
          input: { dealId: "d", expectedVersion: 1 },
        }),
      });
    for (const name of ["crm.proposal.draft", "crm.invoice.draft", "crm.quote.package"])
      for (const [who, principal] of [
        ["pending", pending],
        ["bare", bare],
      ] as const) {
        const res = await draft(who, principal, name);
        expect(res.status).toBe(403);
        expect(JSON.stringify(await res.json())).toContain(
          "Confirm this browser to draft a proposal",
        );
      }
    expect((await draft("founder", founder)).status).toBe(200);
  });
  test("CSV export is refused to an unconfirmed caller and allowed to a confirmed one", async () => {
    const exportCsv = async (who: string, principal: Principal) =>
      fetch(origin + "/__crm/ops", {
        method: "POST",
        headers: {
          "x-who": who,
          "content-type": "application/json",
          "x-claude-os-token": pageTokenFor(principal, token),
        },
        body: JSON.stringify({ name: "crm.csv.export", input: { kind: "contacts" } }),
      });
    for (const [who, principal] of [
      ["pending", pending],
      ["bare", bare],
    ] as const) {
      const res = await exportCsv(who, principal);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toContain("Confirm this browser to export");
    }
    expect((await exportCsv("founder", founder)).status).toBe(200);
  });
  test("unknown and malformed ids are 404, never a file read", async () => {
    expect((await open("attachment-" + "0".repeat(32), "founder")).status).toBe(404);
    expect((await open("../../package.json", "founder")).status).toBe(404);
    expect((await open("", "founder")).status).toBe(404);
  });
  test("the route is read only: POST to it is not an operation", async () => {
    const res = await fetch(`${origin}/__crm/file?id=${htmlId}`, {
      method: "POST",
      headers: {
        "x-who": "founder",
        "content-type": "application/json",
        "x-claude-os-token": pageTokenFor(founder, token),
      },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

describe("no reply can be sent from the CRM", () => {
  test("no registered operation sends, and a draft cannot become sent without provider evidence", () => {
    const { store } = fresh();
    const ops = createCrmOperations({ store });
    const names = (ops.list() as { name: string }[]).map((o) => o.name);
    expect(names.filter((n) => /send|publish|dispatch|email\.out|sms/i.test(n))).toEqual([]);
    const c = company(store);
    const draft = store.addActivity(
      {
        ref: { kind: "company", id: c.id },
        eventId: "draft-1",
        kind: "draft-reply",
        title: "UNSENT draft",
        communicationState: "drafted",
      },
      agent,
    );
    expect(draft.communicationState).toBe("drafted");
    expect(() =>
      store.addActivity(
        {
          ref: { kind: "company", id: c.id },
          eventId: "draft-2",
          kind: "draft-reply",
          title: "x",
          communicationState: "sent",
        },
        agent,
      ),
    ).toThrow(/provider evidence/);
  });
});

describe("pending price edge cases", () => {
  test("a won deal cannot be switched to pending", () => {
    const { store } = fresh();
    const c = company(store);
    const deal = store.createDeal(
      { companyId: c.id, title: "W", oneOffCents: 100000, commercialBasis: "agreed" },
      by,
    );
    const won = store.moveDeal(deal.id, "won", deal.version, by);
    expect(() =>
      store.updateDeal(
        won.id,
        { commercialBasis: "pending", oneOffCents: 0, recurringCents: 0 },
        won.version,
        by,
      ),
    ).toThrow(/won deal has an agreed price/);
  });
  test("a legacy-linked deal that goes pending leaves the legacy price columns alone", () => {
    const db = openCrm(":memory:");
    dbs.push(db);
    db.query(
      "INSERT INTO leads(id,place_id,vertical,source,name,phone,website,field_sources,owner) VALUES(1,'osm:node/1','dental','osm','Synthetic One','0299990000','https://one.example','{\"name\":\"osm\"}','usman')",
    ).run();
    const store = new CrmStore(db);
    db.query(
      "INSERT INTO lead_deals(lead_id,offer,setup_cents,monthly_cents) VALUES(1,'website',150000,69900) ON CONFLICT(lead_id) DO UPDATE SET setup_cents=150000,monthly_cents=69900",
    ).run();
    const deal = store.snapshot().deals[0];
    store.updateDeal(
      deal.id,
      { commercialBasis: "pending", oneOffCents: 0, recurringCents: 0 },
      deal.version,
      by,
    );
    const row = db.query("SELECT setup_cents,monthly_cents FROM lead_deals WHERE lead_id=1").get();
    expect(row).toEqual({ setup_cents: 150000, monthly_cents: 69900 });
  });
  test("the deals CSV export leaves a pending price blank, not 0", () => {
    const { store } = fresh();
    const c = company(store);
    store.createDeal({ companyId: c.id, title: "P", commercialBasis: "pending" }, by);
    const lines = new CrmCsv(store).export("deals").csv.split(/\r?\n/);
    const cols = lines[0].split(",").map((s) => s.replace(/"/g, ""));
    const cells = lines[1].split(",").map((s) => s.replace(/"/g, ""));
    expect(cells[cols.indexOf("oneOffCents")]).toBe("");
    expect(cells[cols.indexOf("commercialBasis")]).toBe("pending");
  });
});

describe("all client free text is private to an unconfirmed caller", () => {
  const build = () => {
    const { store } = fresh();
    const c = store.createCompany({ name: "Harbourline Bakery", notes: "SECRET company note" }, by);
    const contact = store.createContact(
      { companyId: c.id, name: "Ana", email: "ana@example.com", preferences: "SECRET preference" },
      by,
    );
    const deal = store.createDeal(
      {
        companyId: c.id,
        title: "Website",
        scope: "SECRET scope",
        nextAction: "SECRET next action",
        contactIds: [contact.id],
      },
      by,
    );
    store.createTask(
      { companyId: c.id, dealId: deal.id, title: "Review", description: "SECRET task text" },
      by,
    );
    store.addActivity(
      {
        ref: { kind: "deal", id: deal.id },
        eventId: "e1",
        kind: "email",
        title: "Correspondence",
        note: "SECRET correspondence",
      },
      by,
    );
    return store.snapshot();
  };
  test("company notes, task descriptions, activity notes, deal scope and next action are withheld; names, stages and dates stay", () => {
    const text = JSON.stringify(withholdPrivate(build()));
    for (const secret of [
      "SECRET company note",
      "SECRET preference",
      "SECRET scope",
      "SECRET next action",
      "SECRET task text",
      "SECRET correspondence",
    ])
      expect(text).not.toContain(secret);
    for (const visible of [
      "Harbourline Bakery",
      "Website",
      "Review",
      "Correspondence",
      "privateTextWithheld",
      "stageId",
    ])
      expect(text).toContain(visible);
    // and a confirmed person's copy is untouched
    expect(JSON.stringify(build())).toContain("SECRET scope");
  });
  test("search does not match withheld fields for an unconfirmed caller", () => {
    const snap = build();
    const company = snap.companies[0];
    const deal = snap.deals[0];
    const contact = snap.contacts[0];
    expect(matchesCrmSearch(company, "SECRET company", true)).toBe(true);
    expect(matchesCrmSearch(company, "SECRET company", false)).toBe(false);
    expect(matchesCrmSearch(deal, "SECRET next", true)).toBe(true);
    expect(matchesCrmSearch(deal, "SECRET next", false)).toBe(false);
    expect(matchesCrmSearch(deal, "SECRET scope", false)).toBe(false);
    expect(matchesCrmSearch(contact, "SECRET preference", false)).toBe(false);
    expect(matchesCrmSearch(company, "Harbourline", false)).toBe(true);
  });
  test("the query operation applies that rule to the caller's session", () => {
    const { store } = fresh();
    store.createCompany({ name: "Harbourline Bakery", notes: "SECRET company note" }, by);
    const ops = createCrmOperations({ store });
    const run = (actor: "human" | "process") =>
      (
        ops.run("crm.companies.query", { search: "SECRET" }, {
          personId: "usman",
          via: actor === "human" ? "paired-session" : "tailnet-person",
          actor,
          displayName: "Usman",
        } as Principal) as { data: { total: number } }
      ).data.total;
    expect(run("human")).toBe(1);
    expect(run("process")).toBe(0);
  });
});

describe("project free text", () => {
  test("scope and milestone notes are withheld from an unconfirmed caller and left whole for a confirmed one", () => {
    const { store } = fresh();
    const c = company(store);
    store.createProject(
      {
        companyId: c.id,
        name: "Delivery",
        scope: "SECRET project scope",
        milestones: [
          {
            id: "m1",
            name: "Kick-off",
            status: "pending",
            dueAt: null,
            completedAt: null,
            note: "SECRET milestone note",
          },
        ],
      },
      by,
    );
    const snap = store.snapshot();
    const hidden = JSON.stringify(withholdPrivate(snap));
    expect(hidden).not.toContain("SECRET project scope");
    expect(hidden).not.toContain("SECRET milestone note");
    expect(hidden).toContain("Kick-off");
    expect(hidden).toContain("Delivery");
    const whole = JSON.stringify(snap);
    expect(whole).toContain("SECRET project scope");
    expect(whole).toContain("SECRET milestone note");
  });
});

describe("restrictions, dependencies, evidence and reasons are private to an unconfirmed caller", () => {
  const build = () => {
    const { store } = fresh();
    const c = store.createCompany({ name: "Harbourline Bakery", excludedReason: "SECRET exclusion" }, by);
    const contact = store.createContact(
      { companyId: c.id, name: "Ana", email: "ana@example.com", restrictions: ["SECRET restriction"] },
      by,
    );
    const deal = store.createDeal({ companyId: c.id, title: "Website", contactIds: [contact.id] }, by);
    const lost = store.moveDeal(deal.id, "lost", deal.version, by, "SECRET lost reason");
    store.createTask(
      {
        companyId: c.id,
        title: "Review",
        dependsOn: ["SECRET dependency"],
        evidence: ["SECRET evidence"],
      },
      by,
    );
    return { snap: store.snapshot(), lostId: lost.id };
  };
  test("withheld for an unconfirmed caller; names, stages and structure stay; confirmed copy untouched", () => {
    const { snap } = build();
    const hidden = withholdPrivate(snap);
    const text = JSON.stringify(hidden);
    for (const secret of [
      "SECRET restriction",
      "SECRET dependency",
      "SECRET evidence",
      "SECRET lost reason",
      "SECRET exclusion",
    ])
      expect(text).not.toContain(secret);
    for (const visible of ["Harbourline Bakery", "Website", "Review", "stageId", "stageHistory"])
      expect(text).toContain(visible);
    // structure stays: the task still shows it is waiting, the contact still has one restriction
    expect(hidden.tasks[0].dependsOn?.length).toBe(1);
    expect(hidden.contacts[0].restrictions.length).toBe(1);
    expect(hidden.deals[0].stageHistory.length).toBeGreaterThan(0);
    const confirmed = JSON.stringify(snap);
    for (const secret of ["SECRET restriction", "SECRET dependency", "SECRET evidence", "SECRET lost reason", "SECRET exclusion"])
      expect(confirmed).toContain(secret);
  });
  test("search does not match the withheld reasons for an unconfirmed caller", () => {
    const { snap } = build();
    expect(matchesCrmSearch(snap.deals[0], "SECRET lost", true)).toBe(true);
    expect(matchesCrmSearch(snap.deals[0], "SECRET lost", false)).toBe(false);
    expect(matchesCrmSearch(snap.companies[0], "SECRET exclusion", true)).toBe(true);
    expect(matchesCrmSearch(snap.companies[0], "SECRET exclusion", false)).toBe(false);
  });
});
