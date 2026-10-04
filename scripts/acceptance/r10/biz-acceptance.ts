#!/usr/bin/env bun
/**
 * Round 10, business integration: acceptance rows 15 and 16 on a SYNTHETIC hub (never the live one). Every record is made here and named Synthetic.
 *
 *   bun scripts/acceptance/r10/biz-acceptance.ts --hub http://127.0.0.1:8195 --data D:\AgenticOS-r8-data\r10-biz --out D:\AgenticOS-r8-data\r10-biz-out
 *
 * Row 15: find a synthetic client, save a note and create a linked task (typed AND spoken through the same controller), refresh, confirm persistence.
 * Row 16: draft a quote and an invoice from approved inputs; exact totals and links; nothing sent. Also the redaction and refusal edges.
 * A check passes only on a PERSISTED effect read back from the CRM's own snapshot after a reload.
 */
import type { Page } from "playwright-core";
import { api, closeAll, expect, HUB, record, session, shot, SIZES, writeResults } from "../r7/lib";

const stamp = Date.now().toString(36).slice(-4);
const CO = `Synthetic R10 Orchard ${stamp}`;
const DEAL = `Orchard site ${stamp}`;
const RX = `Orchard reception ${stamp}`;
const NOTE = `acceptance note ${stamp}`;
const TASK = `send revised scope ${stamp}`;

async function say(p: Page, utterance: string, source: "typed" | "voice" = "typed", eventId?: string) {
  return p.evaluate(
    async ([u, s, e]) => {
      const t = ((await (await fetch("/__token")).json()) as { token?: string }).token ?? "";
      const res = await fetch("/__operator/screen/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...(t ? { "x-claude-os-token": t } : {}) },
        body: JSON.stringify({ utterance: u, source: s, ...(e ? { eventId: e } : {}) }),
      });
      const lines = (await res.text())
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const done = lines.filter((l) => l.type === "done").at(-1) ?? null;
      return { status: res.status, done };
    },
    [utterance, source, eventId ?? ""] as [string, string, string],
  );
}
const snap = async (p: Page) => (await api(p, "GET", "/__crm/snapshot")).json as any;
const ops = async (p: Page, name: string, input: unknown) => (await api(p, "POST", "/__crm/ops", { name, input })).json as any;

async function main() {
  const s = await session(SIZES[0]);
  const p = s.page;
  await p.goto(`${HUB}/crm`, { waitUntil: "domcontentloaded" });

  // ---- seed (synthetic): a client, a contact, an agreed website deal, a pending receptionist deal
  const company = (await ops(p, "crm.company.create", { name: CO, emails: ["front@orchard.example"], notes: `private ${stamp}` })).data;
  await ops(p, "crm.company.create", { name: `${CO} Cafe` }); // a second client with the same start: the ambiguity row
  const contact = (await ops(p, "crm.contact.add", { companyId: company.id, name: "Dana Orchard", email: "dana@orchard.example" })).data;
  const deal = (
    await ops(p, "crm.deal.create", { companyId: company.id, title: DEAL, service: "website", oneOffCents: 150_000, recurringCents: 10_000, gstTreatment: "exclusive", commercialBasis: "agreed", contactIds: [contact.id] })
  ).data;
  const rx = (await ops(p, "crm.deal.create", { companyId: company.id, title: RX, service: "receptionist", commercialBasis: "pending" })).data;
  expect("15 setup", "synthetic client, contact and two deals exist", !!(company?.id && contact?.id && deal?.id && rx?.id), { company: company?.id });

  // ---- Row 15: find, open, note, task (typed and spoken), persistence after reload
  const find = await say(p, `find client ${CO}`);
  expect("15 find", "typed: finds the synthetic client by name", !!find.done?.ok && String(find.done.said).includes(CO), { said: find.done?.said });
  const ui = await ops(p, "crm.search", { query: CO, kinds: ["company"] });
  expect("15 find", "UI path (crm.search) finds the same client with its CRM link", ui.data?.hits?.[0]?.ref?.id === company.id, { href: ui.data?.hits?.[0]?.href });
  const open = await say(p, `open the ${DEAL} deal`, "voice");
  expect("15 open", "spoken: opens the correct deal (navigate path names that deal)", !!open.done?.ok && String(open.done?.navigate?.path).includes(encodeURIComponent(`crm:deal:${deal.id}`)), { navigate: open.done?.navigate, said: open.done?.said });
  const ask = await say(p, "open client Synthetic R10 Orchard"); // matches this run's two clients (and any earlier run's): none is an exact title
  expect("15 open", "an ambiguous name asks once and opens nothing", ask.done?.ok === false && !ask.done?.navigate && /Which one/.test(String(ask.done?.said)), { said: ask.done?.said, kind: ask.done?.kind });
  const note = await say(p, `add a note to the ${DEAL} deal: ${NOTE}`, "voice", `acc-note-${stamp}`);
  expect("15 note", "spoken: note saved on the named deal", !!note.done?.ok, { said: note.done?.said });
  const task = await say(p, `create a task for the ${DEAL} deal: ${TASK} due 2026-10-20 assign to mehroz`, "typed", `acc-task-${stamp}`);
  expect("15 task", "typed: task created for the named deal and read back", !!task.done?.ok && task.done?.verified === true, { said: task.done?.said });
  await say(p, `create a task for the ${DEAL} deal: ${TASK} due 2026-10-20 assign to mehroz`, "typed", `acc-task-${stamp}`);

  await p.goto(`${HUB}/crm?ref=${encodeURIComponent(`crm:deal:${deal.id}`)}&tab=overview`, { waitUntil: "domcontentloaded" });
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  await shot(p, "row15-deal-after-reload");
  const after = await snap(p);
  const tasks = after.tasks.filter((t: any) => t.title === TASK);
  const notes = after.activities.filter((a: any) => a.kind === "note" && a.note === NOTE);
  expect("15 persist", "after reload the note is on the deal exactly once", notes.length === 1 && notes[0].ref.id === deal.id, { notes: notes.length });
  expect(
    "15 persist",
    "after reload the task is linked to the client and deal, owned, dated, open, exactly once",
    tasks.length === 1 && tasks[0].companyId === company.id && tasks[0].dealId === deal.id && tasks[0].owner === "mehroz" && tasks[0].dueAt?.startsWith("2026-10-20") && tasks[0].status === "open",
    { tasks: tasks.length, task: tasks[0] && { dealId: tasks[0].dealId, owner: tasks[0].owner, dueAt: tasks[0].dueAt } },
  );
  const pageText = await p.evaluate(() => document.body.innerText);
  expect("15 persist", "the CRM page shows the client or task after reload", pageText.includes(TASK) || pageText.includes(CO), { sawTask: pageText.includes(TASK), sawClient: pageText.includes(CO) });
  const next = await say(p, `what's the next action for the ${DEAL} deal`);
  expect("15 next", "the next real action names the task, its owner and due date", /owner mehroz/.test(String(next.done?.said)) && String(next.done?.said).includes(TASK), { said: next.done?.said });

  // ---- Row 16: quote and invoice drafts, exact totals, links, nothing sent
  const quote = await say(p, `draft a quote for the ${DEAL} deal`);
  expect("16 quote", "quote draft saved from the agreed price, not sent", !!quote.done?.ok && /A\$1,500\.00/.test(String(quote.done?.said)) && /Not sent/.test(String(quote.done?.said)), { said: quote.done?.said });
  const invoice = await say(p, `draft an invoice for the ${DEAL} deal`);
  expect("16 invoice", "invoice draft: A$1,500.00 ex GST + A$150.00 GST = A$1,650.00", !!invoice.done?.ok && /A\$1,500\.00 ex GST \+ A\$150\.00 GST = A\$1,650\.00/.test(String(invoice.done?.said)), { said: invoice.done?.said });
  const repeat = await say(p, `draft an invoice for the ${DEAL} deal`);
  const rx1 = await say(p, `draft a quote for the ${RX} deal`);
  expect("16 pending", "a receptionist deal with no price stays pending: nothing is drafted or invented", rx1.done?.ok === false, { said: rx1.done?.said });
  const pkg = await say(p, `draft a quote for the ${RX} deal with the professional package`);
  expect(
    "16 package",
    "approved package price (A$1,099 ex GST) through the deal desk, setup fee flagged pending",
    !!pkg.done?.ok && /A\$1,099\.00 ex GST \+ A\$109\.90 GST = A\$1,208\.90/.test(String(pkg.done?.said)) && /setup fee is pending/.test(String(pkg.done?.said)),
    { said: pkg.done?.said },
  );
  await p.reload({ waitUntil: "domcontentloaded" });
  const s2 = await snap(p);
  const docs = s2.documents.filter((d: any) => d.dealId === deal.id);
  const proposals = docs.filter((d: any) => d.kind === "proposal");
  const invoices = docs.filter((d: any) => /^Invoice draft/.test(d.title));
  // The snapshot defers document bodies; the record read returns the saved text.
  const full = invoices[0] ? ((await api(p, "GET", `/__crm/record?ref=${encodeURIComponent(`crm:document:${invoices[0].id}`)}`)).json?.data as any) : null;
  const inv = full?.versions?.at(-1);
  expect("16 persist", "one quote and one invoice draft saved on the deal after reload (a repeat made no duplicate)", proposals.length === 1 && invoices.length === 1, { proposals: proposals.length, invoices: invoices.length, repeat: repeat.done?.said });
  expect(
    "16 totals",
    "invoice content carries the exact totals and the draft/ABN/not-sent flags",
    /Subtotal ex GST: \$1,500\.00/.test(inv?.content ?? "") && /GST \(10%\): \$150\.00/.test(inv?.content ?? "") && /TOTAL: \$1,650\.00/.test(inv?.content ?? "") && /NOT A VALID TAX INVOICE/.test(inv?.content ?? "") && /No invoice or payment request has been sent/.test(inv?.content ?? ""),
    {},
  );
  const sent = s2.activities.filter((a: any) => ["sent", "queued"].includes(a.communicationState));
  expect("16 nothing sent", "no activity anywhere is sent or queued, and both drafts are status draft", sent.length === 0 && [...proposals, ...invoices].every((d: any) => d.status === "draft"), { sent: sent.length });
  const desk = await api(p, "GET", "/__operator/leads/deal-desk/list");
  const wb = (desk.json?.deals ?? []).find((d: any) => d.crmDealRef === `crm:deal:${rx.id}`);
  expect("16 links", "the package quote workbook is linked back to its CRM deal", !!wb, { workbook: wb?.id, status: desk.status });
  const seen = await ops(p, "crm.search", { query: `${CO} professional`, kinds: ["workbook"] });
  expect("16 links", "the workbook is found by search and resolves to the deal", seen.data?.hits?.[0]?.ref?.id === rx.id, {});
  await p.goto(`${HUB}/crm?ref=${encodeURIComponent(`crm:deal:${deal.id}`)}&tab=deals`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  await shot(p, "row16-deal-documents");

  // ---- edges: an unconfirmed (fresh, pending) browser sees no private text and cannot draft
  const f = await session(SIZES[0], { fresh: true });
  await f.page.goto(`${HUB}/crm`, { waitUntil: "domcontentloaded" });
  const blind = await api(f.page, "POST", "/__crm/ops", { name: "crm.search", input: { query: `private ${stamp}` } });
  expect("16 redaction", "an unconfirmed browser cannot find private note text through search", (blind.json?.data?.hits ?? []).length === 0 && !JSON.stringify(blind.json ?? {}).includes(`private ${stamp}`), { status: blind.status });
  const refuse = await api(f.page, "POST", "/__crm/ops", { name: "crm.invoice.draft", input: { dealId: deal.id, expectedVersion: deal.version } });
  expect("16 redaction", "an unconfirmed browser cannot draft an invoice", refuse.status === 403 || refuse.status === 401, { status: refuse.status });
  await f.ctx.close().catch(() => undefined);
  writeResults("r10-biz");
}
main()
  .catch((e) => {
    record("r10 biz", "script ran to the end", "FAIL", String(e?.message ?? e).slice(0, 300));
    writeResults("r10-biz");
    process.exitCode = 1;
  })
  .finally(() => closeAll());
