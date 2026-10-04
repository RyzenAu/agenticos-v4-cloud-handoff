// The business forms through the real command service (the one controller typed and spoken words share): a CRM request that says "site" or
// "website" is the CRM's, not the coding entry's; an opened record navigates; an ambiguous name is an ask. Synthetic records, no model, no device.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { closeCrmRuntime, crmRuntime } from "../crm/runtime";
import { createCommandService, type Delegates } from "./service";
import { runCrmIntent } from "./crm";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const by = { personId: "usman" as const };
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "business-service-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  const rt = crmRuntime(dir);
  cleanups.push(() => {
    try { jobs.close(); } catch { /* closing */ }
    closeCrmRuntime(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked until GC on Windows */ }
  });
  const company = rt.store.createCompany({ name: "Synthetic Orchard Dental" }, by);
  rt.store.createCompany({ name: "Synthetic Orchard Cafe" }, by);
  const deal = rt.store.createDeal({ companyId: company.id, title: "Orchard site", service: "website", oneOffCents: 150_000, recurringCents: 0, gstTreatment: "exclusive", commercialBasis: "agreed" }, by);
  const codingCalls: string[] = [];
  const delegates: Delegates = {
    // A coding entry that would claim anything: if a business request reaches it, the test sees it.
    coding: async (utterance) => (codingCalls.push(utterance), { say: "Drafted. Start it?", navigate: "/coding" }),
    crm: (intent, principal, pageContext, eventId) =>
      runCrmIntent({ operations: () => rt.operations, role: () => "pc", readOnly: () => false }, intent, principal, pageContext as never, eventId ? { eventId } : {}),
  };
  const service = createCommandService({ jobs: () => jobs, entry: () => null, hubDeviceId: "usman-pc", resolveTarget: () => ({ ok: false, reason: "no device in this test" }), delegates, graceMs: 50, dedupeMs: 0 });
  const say = (utterance: string) => service.run({ principal: usman, body: { utterance, source: "typed" } });
  return { rt, company, deal, codingCalls, say };
}

test("a business request that says 'site' goes to the CRM, never the coding entry", async () => {
  const r = rig();
  const task = await r.say("create a task for the Orchard site deal: send the revised scope due 2026-10-20");
  expect(task.ok).toBe(true);
  expect(task.said).toContain("Saved the task");
  const quote = await r.say("draft a quote for the Orchard site deal");
  expect(quote.ok).toBe(true);
  expect(quote.said).toContain("A$1,500.00");
  expect(r.codingCalls).toEqual([]);
  expect(r.rt.store.snapshot().tasks.filter((t) => t.dealId === r.deal.id)).toHaveLength(1);
  // Coding words still reach the coding entry.
  const code = await r.say("assign a builder to fix the header on the Orchard site and a reviewer to check it");
  expect(r.codingCalls).toHaveLength(1);
  expect(code.said).toContain("Start it?");
});

test("an opened record navigates, and an ambiguous name is one question with no navigation", async () => {
  const r = rig();
  const open = await r.say("open the Orchard site deal");
  expect(open.ok).toBe(true);
  expect(open.navigate?.path).toBe(`/crm?ref=${encodeURIComponent(`crm:deal:${r.deal.id}`)}&tab=overview`);
  const ask = await r.say("open client Synthetic Orchard");
  expect(ask.ok).toBe(false);
  expect(ask.kind).toBe("ask");
  expect(ask.navigate).toBeUndefined();
  expect(ask.said).toMatch(/Which one\?/);
});
