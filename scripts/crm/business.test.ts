// Business lookups and drafts through the CRM's own typed operations (synthetic records only, in a temporary hub folder).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { listDeals } from "../leads/deal-desk-store";
import { closeCrmRuntime, crmRuntime } from "./runtime";
import { pickFromHits, searchBusiness, foldWords } from "./business";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const pending: Principal = { personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" };
const by = { personId: "usman" as const };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeCrmRuntime(root);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* locked until GC on Windows */
    }
  }
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), "crm-business-"));
  roots.push(root);
  const rt = crmRuntime(root);
  const s = rt.store;
  const company = s.createCompany({ name: "Synthetic Orchard Dental", notes: "SECRETNOTE alpha", emails: ["front@orchard.example"] }, by);
  const contact = s.createContact({ companyId: company.id, name: "Dana Orchard", email: "dana@orchard.example", restrictions: ["send not authorised"] }, by);
  const agreed = s.createDeal(
    { companyId: company.id, title: "Orchard website", service: "website", scope: "SECRETSCOPE beta", oneOffCents: 150_000, recurringCents: 10_000, gstTreatment: "exclusive", commercialBasis: "agreed" },
    by,
  );
  const catalogue = s.createDeal(
    { companyId: company.id, title: "Orchard catalogue site", service: "website", oneOffCents: 165_000, recurringCents: 0, gstTreatment: "inclusive", commercialBasis: "catalogue", catalogueId: "website" },
    by,
  );
  const rx = s.createDeal({ companyId: company.id, title: "Orchard receptionist", service: "receptionist", commercialBasis: "pending" }, by);
  const task = s.createTask({ companyId: company.id, dealId: agreed.id, title: "Send revised scope", dueAt: "2026-09-01", owner: "usman" }, by);
  const waiting = s.createTask({ companyId: company.id, title: "Book the shoot", dependsOn: ["crm:deal:x"] }, by);
  const project = s.createProject({ companyId: company.id, name: "Orchard build", scope: "SECRETPROJECT gamma" }, by);
  const doc = s.createDocument({ companyId: company.id, dealId: agreed.id, title: "Proposal — Orchard website", kind: "proposal", content: "PRIVATECONTENT delta" }, by);
  return { root, rt, company, contact, agreed, catalogue, rx, task, waiting, project, doc };
}
const run = (r: ReturnType<typeof rig>, name: string, input: unknown, p: Principal = usman) =>
  r.rt.operations.run(name, input, p) as { ok: boolean; text: string; code?: string; data?: any };

test("search spans every record kind and finds the client by a spoken name", () => {
  const r = rig();
  const out = run(r, "crm.search", { query: "orchard" });
  expect(out.ok).toBe(true);
  const kinds = new Set(out.data.hits.map((h: any) => h.kind));
  for (const k of ["company", "contact", "deal", "project", "task", "quote"]) expect(kinds.has(k)).toBe(true);
  const company = run(r, "crm.search", { query: "synthetic orchard dental", kinds: ["company"] });
  expect(company.data.hits).toHaveLength(1);
  expect(company.data.hits[0].href).toContain(encodeURIComponent(`crm:company:${r.company.id}`));
});

test("private text is not searchable or shown to an unconfirmed browser, and is for a confirmed one", () => {
  const r = rig();
  for (const word of ["SECRETNOTE", "SECRETSCOPE", "SECRETPROJECT", "PRIVATECONTENT"]) {
    expect(run(r, "crm.search", { query: word }, pending).data.hits).toHaveLength(0);
    expect(run(r, "crm.search", { query: word }, usman).data.hits.length).toBeGreaterThan(0);
  }
  // What an unconfirmed caller does get back carries no private text at all.
  const seen = JSON.stringify(run(r, "crm.search", { query: "orchard" }, pending));
  for (const word of ["SECRETNOTE", "SECRETSCOPE", "SECRETPROJECT", "PRIVATECONTENT", "send not authorised"]) expect(seen).not.toContain(word);
});

test("linked files are found only by a confirmed person (a file name says who the client is)", () => {
  const data = {
    companies: [{ id: "c1", name: "Synthetic Co", industry: "", website: "", locality: "", address: "", phone: "", emails: [], tags: [], status: "client", notes: "", mergedInto: null, excluded: false, doNotContact: false }],
    contacts: [], deals: [], tasks: [], projects: [], pipelines: [],
    documents: [{ id: "d1", companyId: "c1", title: "Brief", kind: "brief", status: "draft", currentVersion: 1, externalUrl: null, versions: [], attachments: [{ id: "a1", documentId: "d1", companyId: "c1", name: "synthetic-floorplan.pdf", mime: "application/pdf", bytes: 1, sha256: "x", addedAt: "" }] }],
  } as never;
  expect(searchBusiness(data, "floorplan", { includePrivate: false }).hits).toHaveLength(0);
  const found = searchBusiness(data, "floorplan", { includePrivate: true }).hits;
  expect(found.map((h) => h.kind)).toEqual(["file"]);
  expect(found[0].ref).toEqual({ kind: "document", id: "d1" });
});

test("a name resolves to one record, or asks; an exact title wins over a longer match", () => {
  const hit = (title: string) => ({ kind: "deal" as const, id: title, ref: { kind: "deal" as const, id: title }, title, detail: "", href: "/x", companyId: "c", score: 1 });
  expect(pickFromHits([], "x").status).toBe("none");
  expect(pickFromHits([hit("Acme website"), hit("Acme")], "acme").status).toBe("one");
  expect(pickFromHits([hit("Acme website"), hit("Acme receptionist")], "acme").status).toBe("many");
  expect(foldWords("Café Nero's")).toBe("cafe nero");
});

test("the next real action is the soonest ready task; waiting work is named with its dependency count", () => {
  const r = rig();
  const out = run(r, "crm.next.list", { companyId: r.company.id });
  expect(out.data.next.title).toBe("Send revised scope");
  expect(out.data.next.overdue).toBe(true);
  expect(out.data.next.owner).toBe("usman");
  expect(out.data.waiting.map((w: any) => [w.title, w.dependsOnCount])).toEqual([["Book the shoot", 1]]);
  // The deal's own next-action text is private.
  r.rt.store.updateDeal(r.agreed.id, { nextAction: "SECRETNEXT call Dana" }, r.agreed.version, by);
  expect(JSON.stringify(run(r, "crm.next.list", {}, pending))).not.toContain("SECRETNEXT");
  expect(JSON.stringify(run(r, "crm.next.list", {}, usman))).toContain("SECRETNEXT");
});

test("an invoice draft has exact GST arithmetic, is saved once per deal version, and sends nothing", () => {
  const r = rig();
  const first = run(r, "crm.invoice.draft", { dealId: r.agreed.id, expectedVersion: r.agreed.version });
  expect(first.ok).toBe(true);
  expect([first.data.subtotalCents, first.data.gstCents, first.data.totalCents]).toEqual([150_000, 15_000, 165_000]);
  expect(first.data.recurring).toEqual({ exGstCents: 10_000, gstCents: 1_000, totalCents: 11_000 });
  const doc = first.data.document;
  expect(doc.status).toBe("draft");
  expect(doc.versions.at(-1).content).toContain("NOT A VALID TAX INVOICE");
  expect(doc.versions.at(-1).content).toContain("No invoice or payment request has been sent");
  // Not one dollar of the recurring fee is in the total.
  expect(doc.versions.at(-1).content).toContain("Recurring fee: not invoiced by this draft");
  const again = run(r, "crm.invoice.draft", { dealId: r.agreed.id, expectedVersion: r.agreed.version });
  expect(again.data.document.id).toBe(doc.id);
  expect(r.rt.store.snapshot().documents.filter((d) => /^Invoice draft/.test(d.title))).toHaveLength(1);
});

test("the approved website deposit is exact; other deposits, pending prices, stale versions and the receptionist hold are refused", () => {
  const r = rig();
  const dep = run(r, "crm.invoice.draft", { dealId: r.catalogue.id, expectedVersion: r.catalogue.version, portion: "deposit" });
  expect([dep.data.subtotalCents, dep.data.gstCents, dep.data.totalCents]).toEqual([75_000, 7_500, 82_500]);
  const noDeposit = run(r, "crm.invoice.draft", { dealId: r.agreed.id, expectedVersion: r.agreed.version, portion: "deposit" });
  expect(noDeposit.ok).toBe(false);
  expect(noDeposit.text).toMatch(/only drafted for the approved website offer/);
  const hold = run(r, "crm.invoice.draft", { dealId: r.rx.id, expectedVersion: r.rx.version });
  expect(hold.ok).toBe(false);
  expect(hold.code).toBe("restricted");
  const stale = run(r, "crm.invoice.draft", { dealId: r.agreed.id, expectedVersion: r.agreed.version + 5 });
  expect(stale.code).toBe("conflict");
  const pendingDeal = r.rt.store.createDeal({ companyId: r.company.id, title: "No price yet", service: "website", commercialBasis: "pending" }, by);
  const missing = run(r, "crm.invoice.draft", { dealId: pendingDeal.id, expectedVersion: pendingDeal.version });
  expect(missing.ok).toBe(false);
  expect(missing.text).toMatch(/Pricing is pending/);
  expect(r.rt.store.snapshot().documents.filter((d) => /^Invoice draft/.test(d.title))).toHaveLength(1);
});

test("a package quote uses the approved catalogue price through the deal desk, flags the pending setup fee, links back and is made once", () => {
  const r = rig();
  const out = run(r, "crm.quote.package", { dealId: r.rx.id, expectedVersion: r.rx.version, packageId: "receptionist-professional" });
  expect(out.ok).toBe(true);
  expect(out.data.created).toBe(true);
  expect(out.data.monthly).toEqual({ exGstCents: 109_900, gstCents: 10_990, inclGstCents: 120_890 });
  expect(out.data.setupPending).toBe(true);
  expect(out.data.linked).toBe(true);
  expect(out.data.openDecisions.length).toBeGreaterThan(0);
  const rows = listDeals(r.root).deals;
  expect(rows).toHaveLength(1);
  expect(rows[0].status === "damaged" ? null : rows[0].crmDealRef).toBe(`crm:deal:${r.rx.id}`);
  const again = run(r, "crm.quote.package", { dealId: r.rx.id, expectedVersion: r.rx.version, packageId: "receptionist-professional" });
  expect(again.data.created).toBe(false);
  expect(listDeals(r.root).deals).toHaveLength(1);
  // The workbook is searchable by name, with no private text involved.
  const found = run(r, "crm.search", { query: "professional", kinds: ["workbook"] }, pending);
  expect(found.data.hits).toHaveLength(1);
  expect(found.data.hits[0].ref).toEqual({ kind: "deal", id: r.rx.id });
  const three = ["essential", "premium"].map((p) => run(r, "crm.quote.package", { dealId: r.rx.id, expectedVersion: r.rx.version, packageId: `receptionist-${p}` }).data.monthly.exGstCents);
  expect(three).toEqual([69_900, 199_900]);
});

test("existing draft outreach and meeting packs show with their recipient and restriction gaps, and never as sent", () => {
  const r = rig();
  const bare = r.rt.store.createCompany({ name: "Synthetic Nobody Bakery" }, by);
  r.rt.store.createDocument({ companyId: bare.id, title: "Unsent outreach pack [OUT-9]", kind: "other", content: "Hello" }, by);
  r.rt.store.createDocument({ companyId: r.company.id, title: "Meeting pack [MEET-9]", kind: "brief", content: "Agenda" }, by);
  r.rt.store.addActivity({ ref: { kind: "company", id: r.company.id }, eventId: "draft-1", kind: "draft-reply", title: "Reply draft", note: "Hi", communicationState: "drafted" }, by);
  const out = run(r, "crm.drafts.list", {});
  const items = out.data.items as { kind: string; title: string; gaps: string[]; state: string }[];
  expect(items.map((i) => i.kind).sort()).toEqual(["meeting-pack", "outreach", "reply-draft"]);
  const outreach = items.find((i) => i.kind === "outreach")!;
  expect(outreach.gaps.join(" ")).toContain("No recipient email on file");
  expect(outreach.gaps.join(" ")).toContain("nothing has been sent");
  expect(items.every((i) => /not sent/.test(i.state))).toBe(true);
  expect(items.find((i) => i.kind === "meeting-pack")!.gaps.join(" ")).toContain("Pricing is pending");
  const seen = JSON.stringify(run(r, "crm.drafts.list", {}, pending));
  expect(seen).not.toContain("send not authorised");
  expect(seen).toContain("confirm this browser to read them");
  expect(JSON.stringify(run(r, "crm.drafts.list", {}, usman))).toContain("send not authorised");
});
