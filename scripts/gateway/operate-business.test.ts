import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCrmRuntime, crmRuntime } from "../crm/runtime";
import { SHARED_LEDGER, openManualFinanceStore, type ManualFinanceStore } from "../finance/manual-store";
import { syntheticSeptemberCsv } from "../finance/manual-fixtures";
import { pageTokenFor, type Principal } from "../identity/principal";
import { listDeals } from "../leads/deal-desk-store";
import { mailArchive } from "../mail-archive";
import { runCli } from "./cli";
import { GATEWAY_CRM_FOUNDER_ONLY, GATEWAY_CRM_RESTRICTIONS, GATEWAY_CRM_WRITES } from "./crm-policy";
import { createGatewayFinance } from "./finance";
import { createGatewayRoutes } from "./hub-plugin";
import { createGatewayMail } from "./mail";
import { CAPABILITIES } from "./policy";
import { pathTemplate } from "./server";
import { ControlFile } from "./store";

/**
 * Business capabilities through Dot's hub routes, over real HTTP, in front of the REAL CRM runtime (with the deal desk),
 * the REAL manual finance ledger and the REAL mail archive, all on synthetic data in a temp folder:
 *   - CRM drafting (proposal, invoice, quote) under crm.write, and what stays founder-only;
 *   - business finance (finance.read, finance.write): business rows only, never personal ones;
 *   - founder-authorised mailboxes (mail.read, mail.draft): nothing authorised by default, drafts are CRM records, nothing sent.
 */

setDefaultTimeout(60_000);

const TOKEN = "operate-business-internal-token";
const SID = "ab".repeat(12);
const root = mkdtempSync(join(tmpdir(), "gw-business-"));
const dir = join(root, ".operator-data", "gateway");
mkdirSync(dir, { recursive: true });
const by = { personId: "usman" as const };
let server: Server;
let base = "";
let ledger: ManualFinanceStore;
let archive: ReturnType<typeof mailArchive>;
const stripeSnapshot = { configured: true, revenueThisMonthAud: 1650, invoices: { paidCount: 1, paidAud: 825, outstandingCount: 1, outstandingAud: 825 }, overdueInvoices: [], nextPayout: { amount: 800, arrivalDate: "2026-10-06" }, mrrAud: null, lastSyncedAt: "2026-10-04T00:00:00.000Z" };

const principalOf = (req: IncomingMessage): Principal | null => {
  const who = String(req.headers["x-test-who"] ?? "");
  if (who === "usman") return { personId: "usman", via: "paired-session", actor: "human", sessionId: "sk-usman", displayName: "Usman" };
  if (!who.startsWith("dot:")) return null;
  return { personId: "dot" as never, via: "gateway", actor: "process", sessionId: `gw:${SID}`, displayName: "Dot", capabilities: ["view", ...who.slice(4).split(",").filter(Boolean)], delegatedBy: "usman" };
};
async function call(caps: string[] | "usman", method: string, path: string, body?: unknown) {
  const label = caps === "usman" ? "usman" : `dot:${caps.join(",")}`;
  const headers: Record<string, string> = { "x-test-who": label };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-claude-os-token"] = pageTokenFor(principalOf({ headers } as unknown as IncomingMessage)!, TOKEN);
  }
  const res = await fetch(`${base}/__gateway${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text || "{}") as any };
}
const ALL = CAPABILITIES.filter((c) => c !== "view");
const FOUNDER_WORDS = "FOUNDER-UTTERANCE-MARKER";
const uiJobRows = [
  { id: "11111111-1111-4111-8111-111111111111", kind: "command", state: "done", title: FOUNDER_WORDS, steps: [{ text: FOUNDER_WORDS }], principal: { personId: "usman", via: "paired-session", actor: "human" }, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:01Z" },
  { id: "22222222-2222-4222-8222-222222222222", kind: "command", state: "done", title: "Dot's own job", steps: [], principal: { personId: "dot", via: "gateway", actor: "process", gatewayIdentityId: "gwid_x" }, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:01Z" },
];
// Dot's running job (Stop on the Jarvis page) and a founder's running job (never Dot's to stop).
const DOT_RUNNING = { id: "33333333-3333-4333-8333-333333333333", kind: "memory", state: "running", title: "Dot's research", steps: [], principal: { personId: "dot", via: "gateway", actor: "process" }, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:01Z" };
const FOUNDER_RUNNING = { ...DOT_RUNNING, id: "44444444-4444-4444-8444-444444444444", title: FOUNDER_WORDS, principal: { personId: "usman", via: "paired-session", actor: "human" } };
const allJobs = () => [...uiJobRows, DOT_RUNNING, FOUNDER_RUNNING] as Array<Record<string, unknown> & { id: string; state: string }>;
const uiJobs = {
  list: () => uiJobRows,
  get: (id: string) => allJobs().find((j) => j.id === id) ?? null,
  cancel: async (id: string) => {
    const j = allJobs().find((x) => x.id === id);
    if (!j || j.state !== "running") return { ok: false, state: j?.state ?? null };
    j.state = "cancelled";
    return { ok: true, state: "cancelled" };
  },
  events: () => ({ events: [{ jobId: uiJobRows[0].id, seq: 1, text: FOUNDER_WORDS }, { jobId: uiJobRows[1].id, seq: 2, text: "ok" }], last: 2 }),
};
// Dot's command service as the gateway sees it: a plain answer ("command" record) or a research job it started; threadSay records what is saved.
const said: Array<{ personId: string; requestId: string; part: string; role: string; text: string }> = [];
const threadStore = new Map<string, { id: string; updatedAt: string; messages: Array<{ role: string; text: string; via?: string }> }>();
const dotCommands = {
  run: async (input: { principal: { personId: string }; body: { utterance: string; eventId?: string } }) => {
    if (/research/i.test(input.body.utterance)) return { type: "done", ok: true, jobId: DOT_RUNNING.id, said: "Started research." };
    const cmd = { id: `55555555-5555-4555-8555-${String(said.length).padStart(12, "0")}`, kind: "command", state: "succeeded", title: input.body.utterance, steps: [], principal: input.principal, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:01Z" };
    uiJobRows.push(cmd as never);
    return { type: "done", ok: true, jobId: cmd.id, said: "QA DOT 1" };
  },
  cancel: async () => ({ ok: false, state: null }),
  threadSay: (principal: { personId: string }, input: { requestId: string; part: string; role: string; text: string }) => {
    said.push({ personId: principal.personId, ...input });
    return "dot-thread";
  },
};
let rt: ReturnType<typeof crmRuntime>;
let company: { id: string };
let agreed: { id: string; version: number };
let rx: { id: string; version: number };

beforeAll(async () => {
  delete process.env.MU_DATA_DIR;
  rt = crmRuntime(root);
  company = rt.store.createCompany({ name: "Synthetic Orchard Dental", emails: ["front@orchard.example"] }, by);
  agreed = rt.store.createDeal({ companyId: company.id, title: "Orchard website", service: "website", oneOffCents: 150_000, recurringCents: 10_000, gstTreatment: "exclusive", commercialBasis: "agreed" }, by);
  rx = rt.store.createDeal({ companyId: company.id, title: "Orchard receptionist", service: "receptionist", commercialBasis: "pending" }, by);
  ledger = openManualFinanceStore(":memory:", { now: () => new Date("2026-09-27T09:00:00Z") });
  ledger.importCsv(SHARED_LEDGER, syntheticSeptemberCsv(), "test", { actor: "usman" });
  archive = mailArchive(root);
  const msg = (id: string, thread: string, subject: string, from: string, to: string, text: string, when: string) => ({
    id, thread_id: thread, internal_date: String(Date.parse(when)), label_ids: ["INBOX"],
    payload: { mime_type: "text/plain", headers: [{ name: "Subject", value: subject }, { name: "From", value: from }, { name: "To", value: to }], body: { data: Buffer.from(text).toString("base64url") } },
  });
  archive.import("gmail", "hello@business.example", [msg("b1", "t-biz", "Quote for Orchard", "Dana <dana@orchard.example>", "hello@business.example", "Can you send the quote?", "2026-10-01T01:00:00Z"), msg("b2", "t-biz", "Re: Quote for Orchard", "hello@business.example", "dana@orchard.example", "Working on it.", "2026-10-01T02:00:00Z")]);
  archive.import("gmail", "founder.personal@example.com", [msg("p1", "t-personal", "PERSONAL-MAIL-MARKER", "family@example.com", "founder.personal@example.com", "PERSONAL-BODY-MARKER", "2026-10-02T01:00:00Z")]);
  const control = new ControlFile(dir);
  const handle = createGatewayRoutes({
    root,
    internalToken: () => TOKEN,
    dir,
    principal: principalOf,
    operate: {
      env: () => ({}),
      readOnly: () => false,
      crm: () => rt.operations as never,
      finance: () => createGatewayFinance({ store: () => ledger, invoices: () => [{ id: "inv-1", reference: "INV-0001", amount: 825, currency: "AUD", issuedAt: "2026-08-25" }], stripe: () => ({ summary: () => stripeSnapshot }), today: () => "2026-09-27" }),
      mail: () => createGatewayMail({ archive: () => archive, authorised: () => (control.read().mailboxes ?? []).map((m) => m.address) }),
      release: () => null,
      ledger: () => ledger,
      jobs: () => uiJobs as never,
      commands: () => dotCommands as never,
      jarvisThreads: () => ({ get: (id: string) => threadStore.get(id) ?? null }),
      taskWaitMs: 2_000,
      computers: () => ({ list: () => [{ name: "bot-1", kind: "cloud-computer", owner: "shared" }, { name: "usman-laptop", kind: "device", owner: "usman" }] }) as never,
    },
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  ledger?.close();
  archive?.close();
  closeCrmRuntime(root);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows may hold a handle briefly */
  }
});

describe("CRM drafting under crm.write: drafts only, nothing issued, sent or charged", () => {
  test("a proposal, an invoice and a receptionist quote are drafted as Dot; each is a draft", async () => {
    const proposal = await call(["crm.write"], "POST", "/crm/ops", { name: "crm.proposal.draft", input: { dealId: agreed.id, expectedVersion: agreed.version } });
    expect(proposal.status).toBe(200);
    expect(proposal.json.data.status).toBe("draft");
    expect(proposal.json.data.kind).toBe("proposal");
    const invoice = await call(["crm.write"], "POST", "/crm/ops", { name: "crm.invoice.draft", input: { dealId: agreed.id, expectedVersion: agreed.version } });
    expect(invoice.status).toBe(200);
    expect(invoice.json.data.document.status).toBe("draft");
    expect([invoice.json.data.subtotalCents, invoice.json.data.gstCents, invoice.json.data.totalCents]).toEqual([150_000, 15_000, 165_000]);
    expect(invoice.json.text).toContain("not issued or sent");
    const quote = await call(["crm.write"], "POST", "/crm/ops", { name: "crm.quote.package", input: { dealId: rx.id, expectedVersion: rx.version, packageId: "receptionist-professional" } });
    expect(quote.status).toBe(200);
    expect(quote.json.text).toContain("not sent");
    // The deal desk records who drafted the workbook: Dot, never a founder.
    const workbook = listDeals(root).deals[0] as { updatedBy?: string };
    expect(workbook.updatedBy).toBe("dot");
    // Every draft record says Dot; no document is issued or accepted.
    const snap = rt.store.snapshot();
    expect(snap.documents.every((d) => d.status === "draft")).toBe(true);
    expect(JSON.stringify(snap)).toContain(`"agent":"dot"`);
  });

  test("the receptionist launch hold and a pending price still refuse an invoice draft; crm.read alone drafts nothing", async () => {
    const hold = await call(["crm.write"], "POST", "/crm/ops", { name: "crm.invoice.draft", input: { dealId: rx.id, expectedVersion: rx.version } });
    expect([hold.status, hold.json.code]).toEqual([403, "restricted"]);
    for (const name of ["crm.proposal.draft", "crm.invoice.draft", "crm.quote.package"]) {
      expect(GATEWAY_CRM_WRITES).toContain(name);
      expect((await call(["crm.read"], "POST", "/crm/ops", { name, input: { dealId: agreed.id, expectedVersion: agreed.version } })).status).toBe(403);
    }
  });

  test("what remains refused is a send or what would bypass a send's approval, each with its one reason", async () => {
    expect(GATEWAY_CRM_FOUNDER_ONLY).toEqual([]);
    const issue = await call(ALL, "POST", "/crm/ops", { name: "crm.document.create", input: { companyId: company.id, title: "Invoice", status: "issued" } });
    expect([issue.status, issue.json.code]).toEqual([403, "restricted"]);
    expect(issue.json.text).toContain(GATEWAY_CRM_RESTRICTIONS.documentIssued);
    const loosen = await call(ALL, "POST", "/crm/ops", { name: "crm.company.update", input: { id: company.id, expectedVersion: rt.store.getCompany(company.id)!.version, patch: { emailAllowed: true } } });
    expect(loosen.status).toBe(403);
    expect(loosen.json.text).toContain("Spam Act");
    const sent = await call(ALL, "POST", "/crm/ops", { name: "crm.activity.add", input: { ref: { kind: "company", id: company.id }, eventId: "gw-sent-1", kind: "email", title: "Sent", communicationState: "sent" } });
    expect(sent.json.text).toBe(GATEWAY_CRM_RESTRICTIONS.communicationClaim);
    for (const reason of Object.values(GATEWAY_CRM_RESTRICTIONS)) expect(reason).toMatch(/send|approval|outbound|consent|Spam Act|founder/i);
  });

  test("business workflows are Dot's: views, pipelines, workflows, automations, duplicates, CSV, winning a deal; nothing is sent", async () => {
    const w = (name: string, input: unknown) => call(["crm.write"], "POST", "/crm/ops", { name, input });
    const r = (name: string, input: unknown = {}) => call(["crm.read"], "POST", "/crm/read", { name, input });
    // Saved views.
    expect((await w("crm.views.save", { name: "Dot: dental prospects", kind: "companies", filters: { search: "dental" } })).status).toBe(200);
    expect(JSON.stringify((await r("crm.views.list")).json)).toContain("Dot: dental prospects");
    // A pipeline, created and updated.
    const stages = [{ id: "s-new", name: "New", category: "open", probability: 0.1, archived: false }, { id: "s-won", name: "Won", category: "won", probability: 1, archived: false }, { id: "s-lost", name: "Lost", category: "lost", probability: 0, archived: false }];
    const pipe = await w("crm.pipeline.create", { name: "Dot's pipeline", stages });
    expect(pipe.status).toBe(200);
    expect((await w("crm.pipeline.update", { id: pipe.json.data.id, expectedVersion: pipe.json.data.version, patch: { name: "Dot's renamed pipeline", stages } })).status).toBe(200);
    // Workflow templates: update one, apply one (internal tasks and a DRAFT document).
    const templates = (await r("crm.workflow.templates")).json.data as Array<{ id: string; version: number; title: string; appliesTo: string[] }>;
    const t = templates.find((x) => x.appliesTo.includes("company"))!;
    const updated = await w("crm.workflow.update", { id: t.id, expectedVersion: t.version, patch: { summary: "Adjusted by Dot (synthetic)" } });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.json.data.provenance)).toContain(`"agent":"dot"`);
    const applied = await w("crm.workflow.apply", { templateId: t.id, expectedVersion: updated.json.data.version, ref: { kind: "company", id: company.id }, requestId: "gw-workflow-1" });
    expect(applied.status).toBe(200);
    // Automations: list and configure (every rule is internal CRM work).
    const rules = (await r("crm.automations.list")).json.data as Array<{ id: string; enabled: boolean }>;
    expect(rules.length).toBeGreaterThan(0);
    expect((await w("crm.automations.configure", { id: "proposal.inactive", enabled: false })).json.data.enabled).toBe(false);
    expect((await w("crm.automations.configure", { id: "proposal.inactive", enabled: true })).json.data.enabled).toBe(true);
    // Duplicates: list, merge (history kept).
    const a = await w("crm.company.create", { name: "Twin Synthetic Clinic", website: "https://twin.example" });
    const b = await w("crm.company.create", { name: "Twin Synthetic Clinic", website: "https://twin.example" });
    expect(JSON.stringify((await r("crm.duplicates.list")).json)).toContain("Twin Synthetic Clinic");
    const merged = await w("crm.duplicates.merge", { keepId: a.json.data.id, mergeId: b.json.data.id, expectedKeepVersion: a.json.data.version, expectedMergeVersion: b.json.data.version });
    expect(merged.status).toBe(200);
    expect(merged.json.text).toContain("history retained");
    // CSV: preview, commit, export; an opted-out company stays opted out whatever the file says.
    const optedOut = await w("crm.company.create", { name: "Opted Out Synthetic", doNotContact: true });
    expect(optedOut.status).toBe(200);
    const preview = await w("crm.csv.preview", { kind: "companies", csv: "name,optedOut\nCSV Synthetic Practice,false\nOpted Out Synthetic,false\n" });
    expect(preview.status).toBe(200);
    // The opted-out company is a duplicate: Dot chooses to UPDATE it from a file that says optedOut=false.
    const resolutions = (preview.json.data.rows as Array<{ row: number; conflicts: Array<{ id: string; version: number }> }>).filter((x) => x.conflicts.length).map((x) => ({ row: x.row, action: "update", recordId: x.conflicts[0].id, expectedVersion: x.conflicts[0].version }));
    const committed = await w("crm.csv.commit", { previewId: preview.json.data.id, resolutions });
    expect(committed.status).toBe(200);
    const imported = rt.store.snapshot().companies.find((c) => c.name === "CSV Synthetic Practice")!;
    expect(imported).toBeTruthy();
    // Labelled as Dot's import, never as founder-reviewed.
    expect(JSON.stringify(imported.source)).toContain("reviewed by dot (agent)");
    expect(JSON.stringify(imported.source)).not.toContain("Founder-reviewed");
    expect(rt.store.getCompany(optedOut.json.data.id)!.doNotContact).toBe(true);
    const exported = await w("crm.csv.export", { kind: "companies" });
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.json.data)).toContain("Synthetic Orchard Dental");
    // Winning a deal: internal onboarding work only. No document is issued and nothing is sent.
    const pipeline = rt.store.snapshot().pipelines[0];
    const won = pipeline.stages.find((s) => s.category === "won")!;
    const deal = rt.store.getDeal(agreed.id)!;
    const moved = await w("crm.deal.move", { id: deal.id, expectedVersion: deal.version, stageId: won.id });
    expect(moved.status).toBe(200);
    expect(moved.json.text).toContain("not a payment receipt");
    // The deal.won automation opened the delivery project and onboarding task, recorded as Dot's.
    expect(moved.json.text).toContain("Delivery project and onboarding task created");
    expect(rt.store.snapshot().projects.length).toBeGreaterThan(0);
    const snap = rt.store.snapshot();
    expect(snap.documents.every((d) => d.status === "draft")).toBe(true);
    expect(snap.activities.some((x) => x.communicationState === "sent" || x.communicationState === "queued")).toBe(false);
  });
});

describe("business finance: business rows only", () => {
  test("reads return business rows, receivables, match suggestions and the Stripe snapshot; never personal rows", async () => {
    const all = ledger.rows(SHARED_LEDGER);
    const vercel = all.find((r) => r.vendorLabel.toLowerCase().includes("vercel") && r.kind === "ordinary")!;
    expect(vercel.scope).toBe("business");
    // A founder marks one row personal (the ledger's own scope); the transfer and the deposit are unreviewed.
    const openai = all.find((r) => r.vendorLabel.toLowerCase().includes("openai") && r.kind === "ordinary")!;
    ledger.setTxOverride(SHARED_LEDGER, openai.id, { scope: "personal" }, "usman");
    const tx = await call(["finance.read"], "GET", "/finance/transactions?period=all");
    expect(tx.status).toBe(200);
    const ids = tx.json.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(vercel.id);
    expect(ids).not.toContain(openai.id);
    const nonBusiness = ledger.rows(SHARED_LEDGER).filter((r) => r.scope !== "business").map((r) => r.id);
    expect(nonBusiness.length).toBeGreaterThan(1);
    for (const id of nonBusiness) expect(ids).not.toContain(id);
    expect(tx.text).not.toContain("accountAlias");
    const summary = await call(["finance.read"], "GET", "/finance/summary?period=all");
    expect(summary.json.scope).toBe("business");
    expect(summary.json.outCents).toBeGreaterThan(0);
    expect(summary.text).not.toContain("personal\":");
    const recv = await call(["finance.read"], "GET", "/finance/receivables");
    expect(recv.json.openInvoices).toEqual([expect.objectContaining({ id: "inv-1", reference: "INV-0001" })]);
    expect(Array.isArray(recv.json.suggestedMatches)).toBe(true);
    const stripe = await call(["finance.read"], "GET", "/finance/stripe");
    expect(stripe.json.snapshot).toEqual(stripeSnapshot);
    expect((await call(["finance.write"], "GET", "/finance/summary")).status).toBe(403);
    expect((await call(["crm.read", "crm.write"], "GET", "/finance/transactions")).status).toBe(403);
  });

  test("categorise a business row as Dot; a personal row does not exist; scope, imports and vendor rules are not routes", async () => {
    const vercel = ledger.rows(SHARED_LEDGER).find((r) => r.vendorLabel.toLowerCase().includes("vercel") && r.kind === "ordinary")!;
    const done = await call(["finance.write"], "POST", "/finance/categorise", { txId: vercel.id, category: "Hosting" });
    expect(done.status).toBe(200);
    expect(done.json.row.category).toBe("Hosting");
    expect(ledger.editLog(SHARED_LEDGER, 5).find((e) => e.targetId === vercel.id && e.field === "category")?.actor).toBe("dot");
    // Undo restores the founders' value.
    expect((await call(["finance.write"], "POST", "/finance/categorise", { txId: vercel.id, category: null })).json.row.category).not.toBe("Hosting");
    const personal = ledger.rows(SHARED_LEDGER).find((r) => r.scope === "personal")!;
    expect((await call(["finance.write"], "POST", "/finance/categorise", { txId: personal.id, category: "Hosting" })).status).toBe(404);
    expect(ledger.row(SHARED_LEDGER, personal.id)!.category).not.toBe("Hosting");
    // Scope is never the gateway's to change, in either direction.
    expect((await call(["finance.write"], "POST", "/finance/categorise", { txId: vercel.id, scope: "personal" })).status).toBe(400);
    expect(ledger.row(SHARED_LEDGER, vercel.id)!.scope).toBe("business");
    // A refund links only to a business charge.
    const refund = ledger.rows(SHARED_LEDGER).find((r) => r.amountCents > 0 && /refund/i.test(r.vendorLabel + r.typeLabel));
    if (refund && refund.scope === "business") expect((await call(["finance.write"], "POST", "/finance/categorise", { txId: refund.id, refundOf: personal.id })).status).toBe(404);
    for (const path of ["/finance/import", "/finance/vendor-rule", "/finance/clear", "/finance/notes", "/finance/match", "/finance/refund", "/finance/payout"]) expect([path, (await call(ALL, "POST", path, {})).status]).toEqual([path, 404]);
    expect((await call(["finance.read"], "POST", "/finance/categorise", { txId: vercel.id, category: "X" })).status).toBe(403);
  });
});

describe("mail: founder-authorised mailboxes only", () => {
  test("nothing is authorised by default; a founder authorises one mailbox at the console and can take it back", async () => {
    expect((await call(["mail.read"], "GET", "/mail/mailboxes")).json.mailboxes).toEqual([]);
    expect((await call(["mail.read"], "GET", "/mail/threads?mailbox=hello@business.example")).status).toBe(403);
    const lines: string[] = [];
    expect(runCli(["authorise-mailbox", "hello@business.example"], dir, (l) => lines.push(l))).toBe(1); // a founder must be named
    expect(runCli(["authorise-mailbox", "Hello@Business.example", "--by", "usman"], dir, (l) => lines.push(l))).toBe(0);
    expect((await call(["mail.read"], "GET", "/mail/mailboxes")).json.mailboxes).toEqual(["hello@business.example"]);
  });

  test("threads and a thread from the authorised mailbox; another mailbox never, by name or by message", async () => {
    const threads = await call(["mail.read"], "GET", "/mail/threads?mailbox=hello@business.example");
    expect(threads.status).toBe(200);
    expect(threads.json.threads).toEqual([expect.objectContaining({ threadId: "t-biz", messages: 2 })]);
    const thread = await call(["mail.read"], "GET", "/mail/thread?mailbox=hello@business.example&threadId=t-biz");
    expect(thread.json.messages.map((m: { subject: string }) => m.subject)).toEqual(["Quote for Orchard", "Re: Quote for Orchard"]);
    expect(thread.json.messages[0].body).toContain("Can you send the quote?");
    expect(thread.text).not.toContain("bcc");
    // The founder's personal mailbox is not authorised: refused by name, and its thread is not reachable through the authorised one.
    expect((await call(["mail.read"], "GET", "/mail/threads?mailbox=founder.personal@example.com")).status).toBe(403);
    expect((await call(["mail.read"], "GET", "/mail/thread?mailbox=hello@business.example&threadId=t-personal")).status).toBe(404);
    for (const r of [threads, thread]) for (const marker of ["PERSONAL-MAIL-MARKER", "PERSONAL-BODY-MARKER"]) expect(r.text).not.toContain(marker);
    expect((await call(["mail.draft"], "GET", "/mail/threads?mailbox=hello@business.example")).status).toBe(403);
  });

  test("a reply draft is the CRM's draft-reply record (drafted, as Dot); nothing is sent; mail.draft is enough", async () => {
    const draft = await call(["mail.draft"], "POST", "/mail/drafts", { mailbox: "hello@business.example", messageId: (await call(["mail.read"], "GET", "/mail/thread?mailbox=hello@business.example&threadId=t-biz")).json.messages[0].id, ref: { kind: "company", id: company.id }, body: "Hi Dana, the quote is attached as a draft for Usman to send." });
    expect(draft.status).toBe(200);
    expect(draft.json.sent).toBe(false);
    const activity = rt.store.snapshot().activities.find((a) => a.kind === "draft-reply")!;
    expect(activity).toMatchObject({ communicationState: "drafted" });
    expect(JSON.stringify(activity)).toContain(`"agent":"dot"`);
    // It shows where the OS lists drafts.
    const listed = rt.operations.run("crm.drafts.list", {}, { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" } as never);
    expect(JSON.stringify(listed)).toContain("Reply draft");
    // A message in a mailbox that is not authorised: refused, nothing saved.
    const personalId = archive.search("", 50).items.find((m) => m.account === "founder.personal@example.com")!.id;
    expect((await call(["mail.draft"], "POST", "/mail/drafts", { mailbox: "founder.personal@example.com", messageId: personalId, ref: { kind: "company", id: company.id }, body: "x" })).status).toBe(403);
    expect((await call(["mail.draft"], "POST", "/mail/drafts", { mailbox: "hello@business.example", messageId: personalId, ref: { kind: "company", id: company.id }, body: "x" })).status).toBe(404);
    // Sending is not a route; a "sent" claim is refused by the CRM guard; mail.draft does not open other CRM writes.
    for (const path of ["/mail/send", "/mail/drafts/send", "/mail/gmail-draft"]) expect([path, (await call(ALL, "POST", path, {})).status]).toEqual([path, 404]);
    expect((await call(["mail.draft"], "POST", "/crm/ops", { name: "crm.activity.add", input: { ref: { kind: "company", id: company.id }, eventId: "gw-x-1", kind: "draft-reply", title: "Sent", communicationState: "sent" } })).status).toBe(403);
    expect((await call(["mail.draft"], "POST", "/crm/ops", { name: "crm.company.create", input: { name: "Not allowed" } })).status).toBe(403);
    expect(rt.store.snapshot().activities.filter((a) => a.kind === "draft-reply")).toHaveLength(1);
  });

  test("an authorised mailbox is filtered before the limit: hundreds of newer messages elsewhere never hide its mail", () => {
    const rows = [...Array.from({ length: 600 }, (_, i) => ({ id: `o${i}`, account: "busy@other.example", threadId: `ot${i}`, subject: "other", receivedAt: `2026-10-03T00:${String(i % 60).padStart(2, "0")}:00Z` })), { id: "mine-1", account: "quiet@business.example", threadId: "qt", subject: "Quiet mailbox", receivedAt: "2026-01-01T00:00:00Z" }];
    const asked: Array<string | undefined> = [];
    const fake = { search: (_q?: string, limit = 50, _o?: number, _p?: string, account?: string) => (asked.push(account), { items: rows.filter((r) => !account || r.account === account).slice(0, limit), total: rows.length }), get: (id: string) => rows.find((r) => r.id === id) };
    const m = createGatewayMail({ archive: () => fake, authorised: () => ["quiet@business.example"] });
    expect(m.threads("quiet@business.example", "", 30).threads).toEqual([expect.objectContaining({ threadId: "qt", subject: "Quiet mailbox" })]);
    expect(asked).toEqual(["quiet@business.example"]);
    // The real archive honours the account filter too.
    expect(archive.search("", 500, 0, "", "hello@business.example").items.every((x) => x.account === "hello@business.example")).toBe(true);
    expect(archive.search("", 500, 0, "", "HELLO@business.example").items.length).toBe(2);
  });

  test("revoking the mailbox refuses it from the next request", async () => {
    expect(runCli(["revoke-mailbox", "hello@business.example"], dir, () => undefined)).toBe(0);
    expect((await call(["mail.read"], "GET", "/mail/threads?mailbox=hello@business.example")).status).toBe(403);
  });
});

describe("the OS pages' adapters (/__gateway/ui/*): the founder routes' shape, filtered as /__gateway is", () => {
  test("CRM snapshot, record and a company's finance links: the same data as /__gateway/crm/read, under crm.read / finance.read", async () => {
    const snap = await call(["crm.read"], "GET", "/ui/crm/snapshot");
    expect(snap.status).toBe(200);
    expect(snap.json.companies.map((c: { id: string }) => c.id)).toContain(company.id);
    const read = await call(["crm.read"], "POST", "/crm/read", { name: "crm.snapshot", input: {} });
    expect(snap.json.companies.length).toBe(read.json.data.companies.length);
    const rec = await call(["crm.read"], "GET", `/ui/crm/record?ref=${encodeURIComponent(`crm:company:${company.id}`)}`);
    expect([rec.status, rec.json.data.id]).toEqual([200, company.id]);
    expect((await call(["crm.read"], "GET", "/ui/crm/record?ref=nonsense")).status).toBe(400);
    const links = await call(["crm.read", "finance.read"], "GET", `/ui/crm/finance?companyId=${company.id}`);
    expect([links.status, links.json.source, Array.isArray(links.json.links)]).toEqual([200, "finance-stripe-snapshot", true]);
    expect((await call(["crm.read", "finance.read"], "GET", "/ui/crm/finance?companyId=no-such-company")).status).toBe(404);
    for (const path of ["/ui/crm/snapshot", `/ui/crm/record?ref=crm:company:${company.id}`]) expect([path, (await call(["finance.read", "ops.read"], "GET", path)).status]).toEqual([path, 403]);
    expect((await call(["crm.read"], "GET", `/ui/crm/finance?companyId=${company.id}`)).status).toBe(403);
  });

  test("the Finance page reads business rows only, through the founders' own handler; it cannot write", async () => {
    const tx = await call(["finance.read"], "GET", "/ui/finance/transactions?period=all");
    expect(tx.status).toBe(200);
    const nonBusiness = ledger.rows(SHARED_LEDGER).filter((r) => r.scope !== "business").map((r) => r.id);
    expect(nonBusiness.length).toBeGreaterThan(0);
    for (const id of nonBusiness) expect(tx.text.includes(id)).toBe(false);
    expect((await call(["finance.read"], "GET", "/ui/finance/summary?period=all")).status).toBe(200);
    expect((await call(["finance.read"], "GET", "/ui/finance/status")).status).toBe(200);
    expect((await call(["crm.read", "ops.read"], "GET", "/ui/finance/summary")).status).toBe(403);
    expect((await call(ALL, "POST", "/ui/finance/transactions", {})).status).not.toBe(200);
    expect((await call(ALL, "GET", "/ui/finance/import")).status).not.toBe(200);
  });

  test("the job log (B1): Dot's own jobs in full, a founder's as shape only; events for Dot's jobs only; under ops.read", async () => {
    const list = await call(["ops.read"], "GET", "/ui/jobs");
    expect(list.status).toBe(200);
    expect(list.text.includes(FOUNDER_WORDS)).toBe(false);
    expect(list.json.jobs.find((j: { id: string }) => j.id === uiJobRows[1].id)).toMatchObject({ title: "Dot's own job", yours: true });
    expect(list.json.jobs.find((j: { id: string }) => j.id === uiJobRows[0].id)).toMatchObject({ state: "done", steps: [] });
    const one = await call(["ops.read"], "GET", `/ui/jobs/${uiJobRows[0].id}`);
    expect([one.status, one.text.includes(FOUNDER_WORDS)]).toEqual([200, false]);
    const events = await call(["ops.read"], "GET", "/ui/jobs/events?after=0");
    expect(events.json.events.map((e: { seq: number }) => e.seq)).toEqual([2]);
    expect((await call(["crm.read", "bots.operate"], "GET", "/ui/jobs")).status).toBe(403);
  });

  test("the computers list: shared bot computers only, no targets, under bots.operate", async () => {
    const c = await call(["bots.operate"], "GET", "/ui/computers");
    expect(c.json).toEqual({ computers: [{ name: "bot-1", kind: "cloud-computer", owner: "shared" }], targets: [] });
    expect((await call(["ops.read"], "GET", "/ui/computers")).status).toBe(403);
  });
});

describe("the audit's path template for a refused, unlisted route", () => {
  test("ids, numbers, emails and odd segments become *; no query is ever part of it", () => {
    expect(pathTemplate("/__crm/record/3f2c9a51-0b7e-4d2a-9c1e-7a6b5c4d3e2f/notes")).toBe("/__crm/record/*/notes");
    expect(pathTemplate("/__jobs/12345/cancel")).toBe("/__jobs/*/cancel");
    expect(pathTemplate("/__mail/hello%40business.example")).toBe("/__mail/*");
    expect(pathTemplate("/__x/abc12345def")).toBe("/__x/*");
    expect(pathTemplate("/__operator/state")).toBe("/__operator/state");
    expect(pathTemplate("/a/b/c/d/e/f/g/h/i/j").split("/").length).toBeLessThanOrEqual(9);
  });
});

describe("/jarvis in Dot's browser: Dot's OWN Jarvis (tasks.run)", () => {
  test("a request and its plain reply are saved into Dot's own thread, once; a started job's reply is left to the thread watcher", async () => {
    said.length = 0;
    const r = await call(["tasks.run"], "POST", "/tasks", { text: "Reply with QA DOT 1", eventId: "jr-test-0001" });
    expect([r.status, r.json.said]).toEqual([200, "QA DOT 1"]);
    await Bun.sleep(50);
    expect(said).toEqual([
      { personId: "dot", requestId: "jr-test-0001", part: "user", role: "user", text: "Reply with QA DOT 1" },
      { personId: "dot", requestId: "jr-test-0001", part: "reply", role: "assistant", text: "QA DOT 1" },
    ]);
    said.length = 0;
    await call(["tasks.run"], "POST", "/tasks", { text: "Research three clinics", eventId: "jr-test-0002" });
    await Bun.sleep(50);
    expect(said.map((s) => s.part)).toEqual(["user"]);
    expect((await call(["crm.read", "ops.read"], "POST", "/tasks", { text: "x" })).status).toBe(403);
  });

  test("the thread read is Dot's fixed thread only: no id from the request is used, and it needs tasks.run", async () => {
    const { jarvisThreadId } = await import("../conversations");
    const dotId = jarvisThreadId("dot");
    const founderId = jarvisThreadId("usman");
    threadStore.set(dotId, { id: dotId, updatedAt: "2026-10-05T00:00:00Z", messages: [{ role: "user", text: "Reply with QA DOT 1", via: "say:jr-test-0001:user" }, { role: "oracle", text: "QA DOT 1", via: "say:jr-test-0001:reply" }] });
    threadStore.set(founderId, { id: founderId, updatedAt: "2026-10-05T00:00:00Z", messages: [{ role: "user", text: FOUNDER_WORDS }] });
    for (const q of ["", `?conversation=${founderId}`, `?after=0&conversation=${founderId}`]) {
      const t = await call(["tasks.run"], "GET", `/ui/jarvis/thread${q}`);
      expect(t.status).toBe(200);
      expect(t.text.includes(FOUNDER_WORDS)).toBe(false);
      expect(t.json.conversationId).toBe(dotId);
      expect(t.json.conversations.map((c: { id: string }) => c.id)).toEqual([dotId]);
      expect(t.json.conversations[0].messages.map((m: { text: string }) => m.text)).toEqual(["Reply with QA DOT 1", "QA DOT 1"]);
    }
    expect((await call(["ops.read", "crm.read"], "GET", "/ui/jarvis/thread")).status).toBe(403);
  });

  test("Stop on the page: Dot's own running job stops; a founder's job does not exist here; an ended job says so", async () => {
    expect((await call(["ops.read"], "POST", "/ui/jarvis/stop", { jobId: DOT_RUNNING.id })).status).toBe(403);
    const founder = await call(["tasks.run"], "POST", "/ui/jarvis/stop", { jobId: FOUNDER_RUNNING.id });
    expect([founder.status, founder.json.outcome]).toEqual([404, "no-job"]);
    expect(FOUNDER_RUNNING.state).toBe("running");
    const stopped = await call(["tasks.run"], "POST", "/ui/jarvis/stop", { jobId: DOT_RUNNING.id });
    expect([stopped.status, stopped.json]).toEqual([200, { outcome: "stopped", state: "cancelled" }]);
    const again = await call(["tasks.run"], "POST", "/ui/jarvis/stop", { jobId: DOT_RUNNING.id });
    expect([again.status, again.json.outcome]).toEqual([409, "already-ended"]);
    expect((await call(["tasks.run"], "POST", "/ui/jarvis/stop", { eventId: "x" })).status).toBe(400);
  });
});
