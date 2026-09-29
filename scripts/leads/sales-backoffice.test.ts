import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, logActivity, openCrm, upsertLead, type Lead } from "./crm";
import { BILLING_PENDING, BOOKING_DISCLOSURE, draftFiles, draftInvoice, draftProposal, invoiceData, OWNER_DECISION_B, offerForPitch, proposalText, readDraft } from "./sales-backoffice";
import { formatAud, getReceptionistPackage, RECEPTIONIST_PACKAGES } from "../../src/lib/receptionist-packages";
import { leadPipeline, pipelineSummary, STAGES } from "./lead-pipeline";
import { createLeadsApi } from "./api";

const fixture = (db: ReturnType<typeof openCrm>, pitch = "website") => {
  upsertLead(db, { placeId: `osm:node/${Math.random()}`, source: "osm", attribution: "© OpenStreetMap contributors", vertical: "dental", area: "Parramatta NSW", name: "A & B <Dental>", phone: "", address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 0, pitch, reasons: [] });
  return db.query("SELECT max(id) as id FROM leads").get() as { id: number };
};
const withFixture = (run: (root: string, db: ReturnType<typeof openCrm>, lead: Lead) => void | Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "sales-backoffice-"));
  const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
  const { id } = fixture(db);
  const lead = findLead(db, id)!;
  return Promise.resolve(run(root, db, lead)).finally(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
};

describe("sales back-office", () => {
  test("all pitch choices and deposit tax breakdown", () => {
    expect(["website", "redesign", "receptionist", "both", "audit_pending"].map(offerForPitch)).toEqual(["website", "redesign", "receptionist", "both", "website"]);
    const lead = { id: 1, pitch: "both", name: "Example" } as Lead;
    const d = invoiceData(lead, new Date("2026-09-25T00:00:00Z"), "receptionist-essential");
    const essential = getReceptionistPackage("receptionist-essential").pricing;
    // Only approved catalogue prices are invoiced, ex GST with 10% added: the first month's fee, and a
    // setup fee only once the owner approves it (catalogue setupStatus).
    const rxCents = (p: typeof essential) => (p.status === "approved" ? p.monthly.cents : 0) + ((p.setupStatus ?? p.status) === "approved" ? p.setup.cents : 0);
    const rxEx = rxCents(essential);
    // Due on issue: the website deposit only, A$825 incl. GST (A$75 GST). The approved receptionist
    // fee is an illustration with the decision (b) placeholder, outside the total due, never issued.
    expect([d.total, d.subtotal, d.gst, d.due]).toEqual([82500, 75000, 7500, "2026-10-09"]);
    expect(d.receptionistIllustration?.subtotal).toBe(rxEx);
    const rx = invoiceData({ ...lead, pitch: "receptionist" } as Lead, new Date("2026-09-25T00:00:00Z"), "receptionist-essential");
    expect([rx.subtotal, rx.due, rx.receptionistIllustration?.subtotal, rx.receptionistIllustration?.issue]).toEqual([0, null, rxEx, false]);
    if ((essential.setupStatus ?? essential.status) !== "approved") expect(rx.notInvoiced[0]).toContain("not invoiced; the setup fee is proposed, not yet approved");
    const premium = getReceptionistPackage("receptionist-premium").pricing;
    expect(invoiceData({ ...lead, pitch: "receptionist" } as Lead, new Date("2026-09-25T00:00:00Z"), "receptionist-premium").receptionistIllustration?.subtotal).toBe(rxCents(premium));
    expect(proposalText({ ...lead, pitch: "receptionist" } as Lead, "receptionist-essential")).not.toContain("A$1,650");
    // Essential's cover is an open owner decision (audit A3 #1): its proposal carries the placeholder, never a guess.
    expect(proposalText({ ...lead, pitch: "both" } as Lead, "receptionist-essential")).toContain("[OWNER DECISION (a) PENDING:");
    expect(proposalText({ ...lead, pitch: "both" } as Lead, "receptionist-premium")).toContain("Answers calls in business hours, after hours, alongside your team or as overflow");
    expect(proposalText({ ...lead, pitch: "redesign" } as Lead)).toContain("Redesign a business website");
    expect(proposalText({ ...lead, pitch: "website" } as Lead)).not.toContain("receptionist");
  });
  test("receptionist proposals quote each catalogue package, ex GST and proposed, with the booking disclosure", () => {
    const lead = { id: 1, pitch: "receptionist", name: "Example" } as Lead;
    for (const pkg of RECEPTIONIST_PACKAGES) {
      const text = proposalText(lead, pkg.id);
      for (const cents of [pkg.pricing.monthly.cents, pkg.pricing.overagePerMinute.cents]) expect(text).toContain(formatAud(cents));
      // An unapproved setup figure is never quoted to a customer.
      if ((pkg.pricing.setupStatus ?? pkg.pricing.status) !== "approved") { expect(text).not.toContain(formatAud(pkg.pricing.setup.cents)); expect(text).toContain("Setup: quoted separately once approved."); }
      expect(text).toContain(`${pkg.pricing.includedMinutes.toLocaleString("en-AU")} call minutes`);
      expect(text).toContain(pkg.name);
      expect(text).toContain("ex GST");
      // The label follows the catalogue's approval status (owner approved all tiers 28 Sep 2026).
      expect(text).toContain(pkg.pricing.status === "approved" ? "(catalogue " : "proposed, not yet approved");
      // An approved monthly price is never labelled proposed (a proposed setup fee still is).
      if (pkg.pricing.status === "approved") expect(text).not.toContain(", proposed, not yet approved):");
      expect(text).toContain(BOOKING_DISCLOSURE);
      expect(text).toContain("Pilot terms: not approved; no pilot is offered.");
      expect(text).toContain("The live demo line does not book yet");
      expect(text).toContain("DRAFT — NOT FOR ISSUE OR SIGNATURE");
      expect(text).not.toMatch(/paid pilot|300 minutes|A\$549|A\$490/);
    }
    expect(proposalText(lead, "receptionist-essential")).toContain(formatAud(getReceptionistPackage("receptionist-essential").pricing.monthly.cents));
    expect(() => proposalText(lead, "receptionist-pilot")).toThrow("Unknown package");
  });
  // Review T5 R6: no receptionist draft can price as Essential by omission.
  test("receptionist drafts need an explicit package: no Essential default", () => withFixture((root, _db, website) => {
    for (const pitch of ["receptionist", "both"]) {
      const lead = { ...website, pitch } as Lead;
      expect(() => proposalText(lead)).toThrow("Choose the receptionist package");
      expect(() => invoiceData(lead)).toThrow("Choose the receptionist package");
      expect(() => draftProposal(root, lead)).toThrow("Choose the receptionist package");
      expect(() => draftInvoice(root, lead)).toThrow("Choose the receptionist package");
      expect(() => proposalText(lead, "")).toThrow("Choose the receptionist package");
    }
    // Nothing was written by a refused draft.
    expect(draftFiles(root, website.id)).toHaveLength(0);
    // A website-only draft never needs a package.
    expect(proposalText(website)).toContain("Build a business website");
    expect(invoiceData(website).receptionistIllustration).toBeNull();
  }));
  // Review T5 R6: billing timing is open owner decision (b); the invoice draft never decides it.
  test("the receptionist fee is an illustration with the (b) placeholder, never 'to issue' or timed", () => withFixture((root, _db, website) => {
    expect(OWNER_DECISION_B).toBe("[OWNER DECISION (b) PENDING: is the monthly fee billed in advance from Acceptance, or in arrears after each billing period? Not decided.]");
    expect(BILLING_PENDING).toBe(`${OWNER_DECISION_B} Billing terms are confirmed in your agreement.`);
    const lead = { ...website, pitch: "both" } as Lead;
    draftInvoice(root, lead, new Date("2026-09-28T00:00:00Z"), "receptionist-professional");
    const md = readDraft(root, lead.id, "deposit-invoice.md");
    expect(md).toContain(BILLING_PENDING);
    expect(md).toContain("Illustration only: A$1,099.00 ex GST + A$109.90 GST = A$1,208.90");
    expect(md).toContain("not an invoice line, not due, not for issue");
    // The website deposit is unchanged and is the only amount due.
    expect(md).toContain("TOTAL DUE: A$825.00");
    expect(md).toContain("Due date: 2026-10-12");
    // No timing claim for the receptionist fee: nothing "at Acceptance", "in advance" or "first month".
    for (const banned of [/to issue at acceptance/i, /at acceptance/i, /in advance/i, /first month/i, /not payable until/i])
      expect(md.replace(OWNER_DECISION_B, "")).not.toMatch(banned);
    const stripe = JSON.parse(readDraft(root, lead.id, "deposit-invoice.stripe-draft.json"));
    expect(stripe.line_items).toHaveLength(1);
    expect(stripe.line_items[0].price_data.unit_amount).toBe(82500);
    expect(stripe.to_issue_at_acceptance).toBeUndefined();
    expect(stripe.receptionist_fee_illustration).toMatchObject({ issue: false, total_cents: 120890, gst_cents: 10990 });
    expect(stripe.receptionist_fee_illustration.note).toContain(OWNER_DECISION_B);
    // Receptionist-only: nothing due, no due date, and the same placeholder.
    const rxOnly = { ...website, pitch: "receptionist" } as Lead;
    draftInvoice(root, rxOnly, new Date("2026-09-28T00:00:00Z"), "receptionist-professional");
    const rxMd = readDraft(root, rxOnly.id, "deposit-invoice.md");
    expect(rxMd).toContain("Nothing is due on issue.");
    expect(rxMd).toContain("Due date: none (nothing is due from this draft)");
    expect(rxMd).not.toContain("TOTAL DUE");
    expect(rxMd).toContain(BILLING_PENDING);
    // The receptionist proposal carries the same placeholder.
    expect(proposalText(rxOnly, "receptionist-professional")).toContain(BILLING_PENDING);
    expect(proposalText(website)).not.toContain("OWNER DECISION (b)");
  }));
  test("drafts are escaped, local and never Stripe calls", () => withFixture((root, _db, lead) => {
    draftProposal(root, lead); draftInvoice(root, lead);
    expect(draftFiles(root, lead.id)).toHaveLength(5);
    expect(readDraft(root, lead.id, "proposal.html")).toContain("A &amp; B &lt;Dental&gt;");
    expect(readDraft(root, lead.id, "proposal.md")).toContain("A$825");
    const invoice = readDraft(root, lead.id, "deposit-invoice.md");
    expect(invoice).toContain("ABN: [REQUIRED");
    expect(invoice).toContain("GST (10%): A$75.00");
    const stripe = JSON.parse(readFileSync(join(root, ".operator-data", "drafts", String(lead.id), "deposit-invoice.stripe-draft.json"), "utf8"));
    expect(stripe.create.auto_advance).toBe(false);
    expect(stripe.line_items[0].price_data.unit_amount).toBe(82500);
    expect(stripe.line_items[0].price_data.tax_behavior).toBe("inclusive");
    expect(() => readDraft(root, lead.id, "../crm.sqlite")).toThrow();
  }));
  test("pipeline evidence, closed gate and summary", () => withFixture((root, db, lead) => {
    expect(leadPipeline(root, db, lead).stage).toBe("found");
    draftProposal(root, lead);
    expect(leadPipeline(root, db, lead).stage).toBe("proposal");
    expect(leadPipeline(root, db, lead).owner).toBe("founder approval");
    const closed = logActivity(db, lead, { kind: "note", outcome: "do_not_contact" });
    expect(leadPipeline(root, db, closed).closed).toBe(true);
    expect(pipelineSummary(root, db).counts.proposal).toBe(1);
    expect(STAGES).toHaveLength(14);
  }));
  test("API creates and reads an explicit file only", () => withFixture(async (root, db, lead) => {
    const api = createLeadsApi(root, { db });
    const p = new URLSearchParams(`id=${lead.id}`);
    const made = await api.handle("/leads/proposal", "POST", { lead: lead.id }, new URLSearchParams(), false) as { files: string[] };
    expect(made.files).toContain("proposal.html");
    expect((await api.handle("/leads/pipeline", "GET", {}, p, false) as { stage: string }).stage).toBe("proposal");
    const file = await api.handle("/leads/draft-file", "GET", {}, new URLSearchParams(`id=${lead.id}&file=proposal.md`), false) as { content: string };
    expect(file.content).toContain("DRAFT");
  }));
});
