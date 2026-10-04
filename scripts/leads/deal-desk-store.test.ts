import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDeals, type Deal } from "../../src/lib/deal-desk/deal";
import { createLeadsApi } from "./api";
import { DealDeskError, MAX_DEAL_BYTES } from "./deal-desk-store";
import { listLeads, logActivity, openCrm, upsertLead } from "./crm";
import { draftFiles } from "./sales-backoffice";

// Quote workbooks: endpoint-level tests. Founder separation here is by the `by` field the plugin forces to
// the signer; there are no browser sessions in this file.
const P = (q = "") => new URLSearchParams(q);
let dir: string;
let api: ReturnType<typeof createLeadsApi>;
let db: ReturnType<typeof openCrm>;
const savedEnv = process.env.MU_DATA_DIR;
const seed = (i = 0): Deal => structuredClone(seedDeals()[i]);
const deskDir = () => join(dir, "deal-desk");
/** A body naming an owner stands for a REMOTE request, where the plugin has already set body.by to the verified signer. */
const post = (path: string, body: any) => api.handle(`/leads/deal-desk/${path}`, "POST", body, P(), Boolean(body?.by)) as Promise<any> | any;
/** The lead's own deal, saved the way the Leads page saves it. */
const leadPackage = (leadId: number, packageId: string) => api.handle("/leads/deal", "POST", { lead: leadId, offer: "receptionist", packageId }, P(), false);
const get = (path: string, q = "") => api.handle(`/leads/deal-desk/${path}`, "GET", {}, P(q), false) as any;
const fail = async (fn: () => unknown): Promise<DealDeskError> => {
  try { await fn(); } catch (e) { expect(e).toBeInstanceOf(DealDeskError); return e as DealDeskError; }
  throw new Error("expected a DealDeskError");
};
const lead = (name: string, extra: Record<string, unknown> = {}) => {
  upsertLead(db, { placeId: `p-${name}`, vertical: "dental", area: "Mount Druitt NSW", name, phone: "0299990000", address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: true, score: 50, pitch: "website", reasons: [], googleAt: null, ...extra } as any);
  return listLeads(db, { includeExcluded: true, limit: 100 }).find((l) => l.name === name)!.id;
};

const made: string[] = [];
afterAll(() => {
  if (savedEnv === undefined) delete process.env.MU_DATA_DIR; else process.env.MU_DATA_DIR = savedEnv;
  for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch { /* a still-locked sqlite file in the OS temp dir is harmless */ }
});
beforeEach(() => {
  try { api?.close(); } catch { /* already closed */ }
  dir = mkdtempSync(join(tmpdir(), "deal-desk-")); made.push(dir); process.env.MU_DATA_DIR = dir;
  db = openCrm(join(dir, "crm.sqlite"));
  api = createLeadsApi(dir, { db });
});

describe("quote workbooks", () => {
  test("create, list and get", async () => {
    expect((await get("list")).deals).toEqual([]);
    const { record } = await post("save", { deal: seed(0), baseRev: 0, by: "usman" });
    expect(record).toMatchObject({ schemaVersion: 1, id: "seed-dental-pro", rev: 1, updatedBy: "usman", problem: null, draft: null, leadId: null, archived: false, crmDealRef: null });
    expect(record.deal.id).toBe("seed-dental-pro");
    const list = (await get("list")).deals;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "seed-dental-pro", rev: 1, status: "ready", updatedBy: "usman", leadId: null, archived: false, crmDealRef: null });
    expect(list[0].name).toContain("Dental");
    expect(await get("get", "id=seed-dental-pro")).toEqual(record);
    expect((await fail(() => get("get", "id=nope"))).status).toBe(404);
  });

  test("local writes are recorded as local; newest first", async () => {
    await post("save", { deal: seed(0), baseRev: 0 });
    await new Promise((r) => setTimeout(r, 5));
    await post("save", { deal: seed(1), baseRev: 0, by: "mehroz" });
    const list = (await get("list")).deals;
    expect(list.map((d: any) => d.id)).toEqual(["seed-legal-web", "seed-dental-pro"]);
    expect(list.map((d: any) => d.updatedBy)).toEqual(["mehroz", "local"]);
  });

  test("a deal that cannot be calculated stays a draft and the last valid deal survives", async () => {
    const good = (await post("save", { deal: seed(1), baseRev: 0, by: "usman" })).record;
    const bad = seed(1);
    bad.name = "Half finished";
    bad.website.stages = bad.website.stages.map((s, i) => ({ ...s, shareBps: i === 0 ? 3000 : 0 }));
    const { record } = await post("save", { deal: bad, baseRev: 1, by: "usman" });
    expect(record.rev).toBe(2);
    expect(record.problem).toBeTruthy();
    expect(record.draft.name).toBe("Half finished");
    expect(record.deal).toEqual(good.deal);
    expect((await get("list")).deals[0]).toMatchObject({ status: "draft", name: "Half finished" });
    // a later valid save clears the draft and the problem
    const fixed = (await post("save", { deal: seed(1), baseRev: 2, by: "usman" })).record;
    expect(fixed).toMatchObject({ rev: 3, draft: null, problem: null });
  });

  test("the previous version is kept as <id>.prev.json", async () => {
    const first = (await post("save", { deal: seed(0), baseRev: 0 })).record;
    expect(existsSync(join(deskDir(), "seed-dental-pro.prev.json"))).toBe(false);
    const edited = seed(0); edited.name = "Renamed";
    await post("save", { deal: edited, baseRev: 1 });
    expect(JSON.parse(readFileSync(join(deskDir(), "seed-dental-pro.prev.json"), "utf8"))).toEqual(first);
    expect(readdirSync(deskDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // the prev file is not listed as a workbook
    expect((await get("list")).deals).toHaveLength(1);
  });

  test("409 on a stale baseRev, and on baseRev 0 for an existing id, returning the current record", async () => {
    const { record } = await post("save", { deal: seed(0), baseRev: 0, by: "usman" });
    const stale = await fail(() => post("save", { deal: seed(0), baseRev: 0, by: "mehroz" }));
    expect(stale.status).toBe(409);
    expect(stale.payload.current).toEqual(record);
    expect(String(stale.payload.error)).toContain("usman");
    await post("save", { deal: seed(0), baseRev: 1 });
    const old = await fail(() => post("save", { deal: seed(0), baseRev: 1 }));
    expect(old.status).toBe(409);
    expect((old.payload.current as any).rev).toBe(2);
    expect((await fail(() => post("save", { deal: seed(1), baseRev: 5 }))).status).toBe(409);
    expect(existsSync(join(deskDir(), "seed-legal-web.json"))).toBe(false);
  });

  test("two founders (endpoint-level, no browser sessions): correct baseRev chain wins, the stale write is rejected", async () => {
    const a = (await post("save", { deal: seed(0), baseRev: 0, by: "usman" })).record;
    const edit = seed(0); edit.name = "Mehroz edit";
    const b = (await post("save", { deal: edit, baseRev: a.rev, by: "mehroz" })).record;
    expect([b.rev, b.updatedBy]).toEqual([2, "mehroz"]);
    const stale = seed(0); stale.name = "Usman on the old copy";
    const err = await fail(() => post("save", { deal: stale, baseRev: a.rev, by: "usman" }));
    expect(err.status).toBe(409);
    expect((err.payload.current as any).updatedBy).toBe("mehroz");
    const c = (await post("save", { deal: seed(0), baseRev: b.rev, by: "usman" })).record;
    expect([c.rev, c.updatedBy]).toEqual([3, "usman"]);
    expect((await get("get", "id=seed-dental-pro")).deal.name).toBe(seed(0).name);
  });

  test("damaged files are listed, returned raw, refused for writes and never rewritten", async () => {
    mkdirSync(deskDir(), { recursive: true });
    const files: Record<string, string> = {
      "bad-json": "{ not json", "wrong-shape": JSON.stringify({ hello: 1 }),
      "id-mismatch": JSON.stringify({ schemaVersion: 1, id: "someone-else", rev: 1, updatedAt: "x", updatedBy: "usman", deal: null, draft: null, problem: null, leadId: null, archived: false, crmDealRef: null }),
    };
    for (const [id, text] of Object.entries(files)) writeFileSync(join(deskDir(), `${id}.json`), text);
    const list = (await get("list")).deals;
    expect(list.map((d: any) => [d.id, d.status]).sort()).toEqual([["bad-json", "damaged"], ["id-mismatch", "damaged"], ["wrong-shape", "damaged"]]);
    expect(list[0].error).toBeTruthy();
    expect(await get("get", "id=bad-json")).toEqual({ id: "bad-json", status: "damaged", raw: "{ not json" });
    const d = seed(0); d.id = "bad-json";
    expect((await fail(() => post("save", { deal: d, baseRev: 0 }))).status).toBe(409);
    expect((await fail(() => post("archive", { id: "bad-json", baseRev: 1 }))).status).toBe(409);
    for (const [id, text] of Object.entries(files)) expect(readFileSync(join(deskDir(), `${id}.json`), "utf8")).toBe(text);
    expect(readdirSync(deskDir()).filter((f) => f.includes("prev") || f.endsWith(".tmp"))).toEqual([]);
  });

  test("a malformed deal is rejected with 400 and nothing is written", async () => {
    for (const deal of [{ schemaVersion: 1, id: "oops", rx: { packageId: "no-such-package" } }, { id: "oops" }, "text", null, [1]]) {
      expect((await fail(() => post("save", { deal, baseRev: 0 }))).status).toBe(400);
    }
    expect((await fail(() => post("save", { deal: seed(0), baseRev: "x" }))).status).toBe(400);
    expect(existsSync(deskDir())).toBe(false);
  });

  test("bad ids are rejected", async () => {
    for (const id of ["../x", "a/b", "a\\b", "", "x".repeat(81), "dot.json", "with space", ".."]) {
      const d = seed(0); d.id = id;
      expect([id, (await fail(() => post("save", { deal: d, baseRev: 0 }))).status]).toEqual([id, 400]);
      expect([id, (await fail(() => get("get", `id=${encodeURIComponent(id)}`))).status]).toEqual([id, 400]);
    }
    expect((await fail(() => get("get"))).status).toBe(400);
    expect((await fail(() => post("archive", { id: "../x", baseRev: 1 }))).status).toBe(400);
    expect(existsSync(deskDir())).toBe(false);
    expect(existsSync(join(dir, "x.json"))).toBe(false);
  });

  test("archive sets the flag with a rev check and deletes nothing", async () => {
    await post("save", { deal: seed(0), baseRev: 0, by: "usman" });
    expect((await fail(() => post("archive", { id: "seed-dental-pro", baseRev: 9 }))).status).toBe(409);
    expect((await fail(() => post("archive", { id: "ghost", baseRev: 0 }))).status).toBe(404);
    const { record } = await post("archive", { id: "seed-dental-pro", baseRev: 1, by: "mehroz" });
    expect(record).toMatchObject({ archived: true, rev: 2, updatedBy: "mehroz" });
    expect(record.deal).not.toBeNull();
    expect((await get("list")).deals[0].archived).toBe(true);
    expect(existsSync(join(deskDir(), "seed-dental-pro.json"))).toBe(true);
    // a later save keeps it archived
    expect((await post("save", { deal: seed(0), baseRev: 2 })).record.archived).toBe(true);
  });

  test("link stores a CRM reference only, with a rev check, and save keeps it", async () => {
    await post("save", { deal: seed(0), baseRev: 0 });
    const { record } = await post("link", { id: "seed-dental-pro", baseRev: 1, crmDealRef: "crm:deal:abc_12-X", by: "usman" });
    expect(record).toMatchObject({ rev: 2, crmDealRef: "crm:deal:abc_12-X", updatedBy: "usman" });
    expect((await get("list")).deals[0].crmDealRef).toBe("crm:deal:abc_12-X");
    expect((await get("get", "id=seed-dental-pro")).crmDealRef).toBe("crm:deal:abc_12-X");
    expect((await post("save", { deal: seed(0), baseRev: 2 })).record.crmDealRef).toBe("crm:deal:abc_12-X");
    expect((await fail(() => post("link", { id: "seed-dental-pro", baseRev: 1, crmDealRef: "crm:deal:zzz" }))).status).toBe(409);
    for (const crmDealRef of ["deal:abc", "crm:deal:", "crm:deal:a b", "crm:deal:../x", 5, undefined, "crm:deal:" + "a".repeat(81)])
      expect([crmDealRef, (await fail(() => post("link", { id: "seed-dental-pro", baseRev: 3, crmDealRef }))).status]).toEqual([crmDealRef, 400]);
    expect((await post("link", { id: "seed-dental-pro", baseRev: 3, crmDealRef: null })).record.crmDealRef).toBeNull();
    expect((await fail(() => post("link", { id: "ghost", baseRev: 0, crmDealRef: "crm:deal:a" }))).status).toBe(404);
  });

  test("attach writes the three files into the lead's drafts folder and draftFiles lists them", async () => {
    const leadId = lead("Smile Dental"); await leadPackage(leadId, "receptionist-professional");
    await post("save", { deal: seed(0), baseRev: 0 });
    expect((await fail(() => post("attach", { id: "seed-dental-pro", lead: leadId, baseRev: 9, by: "usman" }))).status).toBe(409); // stale revision
    const out = await post("attach", { id: "seed-dental-pro", lead: leadId, baseRev: 1, by: "usman" });
    expect(out.files).toEqual(["deal-desk-quote.html", "deal-desk-agreement.html", "deal-desk-deal.json"]);
    expect(out.record).toMatchObject({ leadId, rev: 2, updatedBy: "usman" });
    expect(draftFiles(dir, leadId)).toEqual(expect.arrayContaining(out.files));
    const folder = join(dir, "drafts", String(leadId));
    expect(readFileSync(join(folder, "deal-desk-quote.html"), "utf8")).toContain("<html");
    expect(readFileSync(join(folder, "deal-desk-agreement.html"), "utf8")).toContain("<html");
    expect(JSON.parse(readFileSync(join(folder, "deal-desk-deal.json"), "utf8")).id).toBe("seed-dental-pro");
    const read = await api.handle("/leads/draft-file", "GET", {}, P(`id=${leadId}&file=deal-desk-deal.json`), false) as any;
    expect(read.mime).toBe("application/json");
    const html = await api.handle("/leads/draft-file", "GET", {}, P(`id=${leadId}&file=deal-desk-quote.html`), false) as any;
    expect(html.mime).toBe("text/html");
    const detail = await api.handle("/leads/detail", "GET", {}, P(`id=${leadId}`), false) as any;
    expect(detail.drafts).toEqual(expect.arrayContaining(out.files));
  });

  test("attach is refused for a draft, a missing workbook, a missing lead, an excluded lead and a closed lead", async () => {
    const leadId = lead("Smile Dental");
    // never valid: only a draft exists
    const bad = seed(1); bad.website.stages = bad.website.stages.map((s, i) => ({ ...s, shareBps: i === 0 ? 3000 : 0 }));
    await post("save", { deal: bad, baseRev: 0 });
    const e = await fail(() => post("attach", { id: "seed-legal-web", lead: leadId, baseRev: 1 }));
    expect(e.status).toBe(409);
    expect(e.message).toContain("unfinished changes");
    // valid with a pending unfinished draft on top
    await post("save", { deal: seed(0), baseRev: 0 });
    const half = seed(0); half.include = { website: true, receptionist: true }; half.website.stages = half.website.stages.map((s, i) => ({ ...s, shareBps: i === 0 ? 3000 : 0 }));
    const pending = (await post("save", { deal: half, baseRev: 1 })).record;
    expect(pending.draft).not.toBeNull();
    expect((await fail(() => post("attach", { id: "seed-dental-pro", lead: leadId, baseRev: pending.rev }))).status).toBe(409);
    await post("save", { deal: seed(0), baseRev: pending.rev });
    expect((await fail(() => post("attach", { id: "ghost", lead: leadId, baseRev: 0 }))).status).toBe(404);
    await expect(Promise.resolve().then(() => post("attach", { id: "seed-dental-pro", lead: 9999, baseRev: 3 }))).rejects.toThrow("Lead not found.");
    const excluded = lead("Council Dental", { excluded: true, excludedReason: "government" });
    await expect(Promise.resolve().then(() => post("attach", { id: "seed-dental-pro", lead: excluded, baseRev: 3 }))).rejects.toThrow("Excluded leads");
    const closed = lead("Closed Dental");
    logActivity(db, (await api.handle("/leads/detail", "GET", {}, P(`id=${closed}`), false) as any).lead, { kind: "call", outcome: "not_interested" });
    await expect(Promise.resolve().then(() => post("attach", { id: "seed-dental-pro", lead: closed, baseRev: 3 }))).rejects.toThrow("closed");
    for (const id of [excluded, closed]) expect(draftFiles(dir, id)).toEqual([]);
    expect(draftFiles(dir, leadId)).toEqual([]);
  });

  test("the size limit rejects an oversized deal and writes nothing", async () => {
    const big = seed(0); big.name = "x".repeat(MAX_DEAL_BYTES + 10);
    const e = await fail(() => post("save", { deal: big, baseRev: 0 }));
    expect(e.status).toBe(400);
    expect(e.message).toContain("512 KB");
    expect(existsSync(deskDir())).toBe(false);
  });

  test("review fixes: the author comes from the verified principal, and attach needs the lead's package to match", async () => {
    const local = await api.handle("/leads/deal-desk/save", "POST", { deal: seed(0), baseRev: 0, by: "usman" }, P(), false) as any;
    expect(local.record.updatedBy).toBe("local"); // a local request cannot claim to be a founder
    expect((await post("save", { deal: seed(0), baseRev: 1, by: "mehroz" })).record.updatedBy).toBe("mehroz"); // remote: the signer
    const leadId = lead("Package Dental");
    expect((await fail(() => post("attach", { id: "seed-dental-pro", lead: leadId, baseRev: 2 }))).message).toContain("Choose the receptionist package");
    await leadPackage(leadId, "receptionist-essential");
    const e = await fail(() => post("attach", { id: "seed-dental-pro", lead: leadId, baseRev: 2 }));
    expect(e.status).toBe(409); expect(e.message).toContain("saved as Essential but this workbook prices Professional");
    await leadPackage(leadId, "receptionist-professional");
    expect((await post("attach", { id: "seed-dental-pro", lead: leadId, baseRev: 2 })).record.leadId).toBe(leadId);
  });
});
