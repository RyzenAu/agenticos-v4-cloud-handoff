// The business OS by voice or typing: parsing, routing, and every action through the CRM's own typed operations (synthetic records only).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { closeCrmRuntime, crmRuntime } from "../crm/runtime";
import { businessIntentIn } from "./business";
import { crmIntentIn, runCrmIntent, type CrmRunDeps } from "./crm";
import { planRules } from "./plan";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const unconfirmed: Principal = { personId: "usman", via: "loopback-owner", actor: "process", displayName: "Usman" };
const bare: Principal = { personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" };
const routine: Principal = { personId: "usman", via: "routine", actor: "process", displayName: "Usman" };
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
function rig(over: Partial<CrmRunDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "crm-jarvis-biz-"));
  roots.push(root);
  const rt = crmRuntime(root);
  const s = rt.store;
  const company = s.createCompany({ name: "Synthetic Harbour Dental" }, by);
  const other = s.createCompany({ name: "Synthetic Harbour Bakery" }, by);
  const deal = s.createDeal(
    { companyId: company.id, title: "Harbour website", service: "website", oneOffCents: 150_000, recurringCents: 0, gstTreatment: "exclusive", commercialBasis: "agreed" },
    by,
  );
  const rx = s.createDeal({ companyId: company.id, title: "Harbour receptionist", service: "receptionist", commercialBasis: "pending" }, by);
  const unpriced = s.createDeal({ companyId: other.id, title: "Bakery site", service: "website", commercialBasis: "pending" }, by);
  const deps: CrmRunDeps = { operations: () => rt.operations, role: () => "pc", readOnly: () => false, ...over };
  const say = (words: string, p: Principal = usman, eventId?: string) => {
    const intent = crmIntentIn(words);
    if (!intent) throw new Error(`not recognised: ${words}`);
    return runCrmIntent(deps, intent, p, null, eventId ? { eventId } : {});
  };
  return { rt, company, other, deal, rx, unpriced, deps, say };
}

test("business forms are recognised, and ordinary speech is not", () => {
  const yes = (t: string, kind: string) => expect(businessIntentIn(t)?.kind).toBe(kind);
  yes("find client Synthetic Harbour", "search");
  yes("search the CRM for harbour", "search");
  yes("find the Harbour deal in the CRM", "search");
  yes("open client Synthetic Harbour Dental", "open");
  yes("open the Harbour website deal", "open");
  yes("Jarvis, please open Harbour in the CRM", "open");
  yes("add a note to the Harbour website deal: sent the revised scope", "named-note");
  yes("add a CRM note to Harbour Dental: called back", "named-note");
  yes("create a task for the Harbour website deal: send scope due 2026-10-10", "task");
  yes("create a crm task for Harbour Dental: book call assign to mehroz", "task");
  yes("draft a quote for Harbour", "quote");
  yes("draft a quote for Harbour with the professional package", "quote");
  yes("prepare a deposit invoice for the Harbour website deal", "invoice");
  yes("what's the next action for Harbour", "next");
  yes("next actions", "next");
  yes("show draft outreach for Harbour", "drafts");
  yes("show the meeting pack for Harbour", "drafts");
  expect(businessIntentIn("create a task for Harbour Dental: book call due 2026-10-10 assign to mehroz")).toBeNull(); // no business word: not a CRM task
  expect(businessIntentIn("create a crm task for Harbour Dental: book call due 2026-10-10 assign to mehroz")).toEqual({
    kind: "task", name: "Harbour Dental", kinds: ["company", "deal", "project", "contact"], title: "book call", dueAt: "2026-10-10", owner: "mehroz",
  });
  for (const t of [
    "open YouTube on my PC", "open Chrome", "open Google and search for harbour dental", "find files called report", "search for pizza near me",
    "find tasks about the homepage build", "create a task for the builder bot: refactor the header", "what's next", "show me the weather",
    "add a note to this deal: x", "draft an email to Harbour", "open the deal", "show drafts",
    "open the file synthetic proposal", "open my Word document quote", "open the Chrome project",
  ])
    expect(businessIntentIn(t)).toBeNull();
  // "this deal" stays the open-record note (crm.ts), never a name search.
  expect(crmIntentIn("add a note to this deal: sent the revised scope")?.kind).toBe("note");
});

test("the planner routes business words to the CRM delegate", () => {
  for (const t of ["find client Harbour", "open the Harbour deal", "draft a quote for Harbour", "what's the next action for Harbour"])
    expect(planRules(t)).toMatchObject({ lane: "delegate", to: "crm" });
  expect(planRules("open YouTube on my PC")?.lane).not.toBe("delegate");
});

test("search names what it found and never private text; open resolves one record and navigates to it", async () => {
  const r = rig();
  const search = await r.say("find deals harbour");
  expect(search.ok).toBe(true);
  expect(search.said).toContain("Harbour website");
  const open = await r.say("open the Harbour website deal");
  expect(open.ok && open.verified).toBe(true);
  expect(open.navigate?.path).toBe(`/crm?ref=${encodeURIComponent(`crm:deal:${r.deal.id}`)}&tab=overview`);
  // Two clients match: one question, no action.
  const ask = await r.say("open client Synthetic Harbour");
  expect(ask.ok).toBe(false);
  expect(ask.ask).toBe(true);
  expect(ask.navigate).toBeUndefined();
  expect(ask.said).toMatch(/Which one\?/);
  const none = await r.say("open client Zebra Quarry");
  expect(none.said).toMatch(/can't find/);
  // A confirmed person finds private text; the sentence never repeats it, and an unconfirmed caller cannot find it at all.
  const seen = await r.say("search the CRM for alpha", usman);
  r.rt.store.updateCompany(r.company.id, { notes: "SECRETNOTE alpha" }, r.company.version, by);
  const confirmed = await r.say("search the CRM for alpha", usman);
  expect(confirmed.said).toContain("Synthetic Harbour Dental");
  expect(JSON.stringify(confirmed)).not.toContain("SECRETNOTE");
  expect(seen.said).toMatch(/Nothing in the business records/);
  const blind = await r.say("search the CRM for alpha", bare);
  expect(blind.said).toMatch(/Nothing in the business records/);
  expect(JSON.stringify(blind)).not.toContain("SECRETNOTE");
});

test("a note and a task are saved against the NAMED record, persist, read back, and a repeat does not duplicate", async () => {
  const r = rig();
  const note = await r.say("add a note to the Harbour website deal: sent the revised scope", usman, "evt-note-1");
  expect(note.ok && note.verified).toBe(true);
  await r.say("add a note to the Harbour website deal: sent the revised scope", usman, "evt-note-1");
  const notes = r.rt.store.snapshot().activities.filter((a) => a.kind === "note");
  expect(notes).toHaveLength(1);
  expect(notes[0].ref).toEqual({ kind: "deal", id: r.deal.id });
  expect(notes[0].note).toBe("sent the revised scope");

  const task = await r.say("create a task for the Harbour website deal: send scope due 2026-10-10 assign to mehroz", usman, "evt-task-1");
  expect(task.ok && task.verified).toBe(true);
  expect(task.said).toContain("due 2026-10-10");
  await r.say("create a task for the Harbour website deal: send scope due 2026-10-10 assign to mehroz", usman, "evt-task-1");
  const tasks = r.rt.store.snapshot().tasks.filter((t) => t.title === "send scope");
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ companyId: r.company.id, dealId: r.deal.id, owner: "mehroz", status: "open" });
  expect(tasks[0].dueAt?.slice(0, 10)).toBe("2026-10-10");
  // It is the next real action for that deal, with its owner.
  const next = await r.say("what's the next action for the Harbour website deal");
  expect(next.said).toContain("send scope");
  expect(next.said).toContain("owner mehroz");
  // No name match, nothing written.
  const before = r.rt.store.snapshot().tasks.length;
  expect((await r.say("create a task for the Zebra deal: x y")).ok).toBe(false);
  expect(r.rt.store.snapshot().tasks.length).toBe(before);
});

test("a quote draft uses the agreed price once per deal version; an invoice draft has exact totals; pending prices stay pending", async () => {
  const r = rig();
  const quote = await r.say("draft a quote for the Harbour website deal");
  expect(quote.ok && quote.verified).toBe(true);
  expect(quote.said).toContain("A$1,500.00");
  expect(quote.said).toMatch(/Not sent/);
  const again = await r.say("draft a quote for the Harbour website deal");
  expect(again.said).toMatch(/already matches/);
  expect(r.rt.store.snapshot().documents.filter((d) => d.kind === "proposal")).toHaveLength(1);
  const invoice = await r.say("draft an invoice for the Harbour website deal");
  expect(invoice.ok && invoice.verified).toBe(true);
  expect(invoice.said).toContain("A$1,500.00 ex GST + A$150.00 GST = A$1,650.00");
  expect(invoice.said).toMatch(/Not issued or sent/);
  const pending = await r.say("draft a quote for the Bakery site deal");
  expect(pending.ok).toBe(false);
  expect(pending.said).toMatch(/Pricing is pending/);
  expect(r.rt.store.snapshot().documents.filter((d) => d.companyId === r.other.id)).toHaveLength(0);
  // The receptionist hold stays: no CRM proposal for it.
  const hold = await r.say("draft a quote for the Harbour receptionist deal");
  expect(hold.ok).toBe(false);
  expect(hold.said).toMatch(/remain on hold/);
  // An approved package is quoted through the deal desk with its catalogue price and the pending setup fee flagged.
  const pkg = await r.say("draft a quote for the Harbour receptionist deal with the professional package");
  expect(pkg.ok).toBe(true);
  expect(pkg.said).toContain("A$1,099.00 ex GST + A$109.90 GST = A$1,208.90 a month");
  expect(pkg.said).toMatch(/setup fee is pending/);
});

test("existing drafts show with their gaps and nothing is sent", async () => {
  const r = rig();
  r.rt.store.createDocument({ companyId: r.company.id, title: "Unsent outreach pack [OUT-7]", kind: "other", content: "Hello" }, by);
  const out = await r.say("show draft outreach for Synthetic Harbour Dental");
  expect(out.ok).toBe(true);
  expect(out.said).toContain("none sent");
  expect(out.said).toContain("No recipient email on file");
  const meeting = await r.say("show the meeting pack for Synthetic Harbour Dental");
  expect(meeting.said).toMatch(/No meeting packs/);
});

test("no principal gains write access: a routine, a bare tailnet login and a read-only copy write nothing; an unconfirmed browser cannot draft", async () => {
  const r = rig();
  const writes = [
    "add a note to the Harbour website deal: x y",
    "create a task for the Harbour website deal: send scope",
    "draft a quote for the Harbour website deal",
    "draft an invoice for the Harbour website deal",
  ];
  const counts = () => {
    const s = r.rt.store.snapshot();
    return [s.activities.filter((a) => a.kind === "note").length, s.tasks.length, s.documents.length];
  };
  const before = counts();
  for (const who of [routine, bare]) for (const w of writes) expect((await r.say(w, who)).ok).toBe(false);
  // At the hub but not confirmed: notes and tasks follow the CRM page's rule, drafts need a confirmed browser.
  for (const w of writes.slice(2)) expect((await r.say(w, unconfirmed)).said).toMatch(/Confirm this browser/);
  const typed = crmIntentIn(`crm.invoice.draft {"dealId":"${r.deal.id}","expectedVersion":${r.deal.version}}`)!;
  expect((await runCrmIntent(r.deps, typed, unconfirmed, null)).said).toMatch(/Confirm this browser/);
  const ro = rig({ readOnly: () => true });
  for (const w of writes) expect((await ro.say(w)).said).toMatch(/read-only/);
  expect(counts()).toEqual(before);
  // Reads are for a browser principal only: a routine reads nothing.
  expect((await r.say("find client harbour", routine)).ok).toBe(false);
});
