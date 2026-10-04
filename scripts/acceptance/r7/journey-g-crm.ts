#!/usr/bin/env bun
/**
 * Round 7 acceptance, journey G: CRM create, edit, deal and task progression, imports, conflicting edits, result/job linking.
 *
 * Baseline 491b8ee0 has no /crm page and no /__crm mount (Dot's CRM is worker E's branch, crm/integration-20261003), so this script runs the
 * LEADS subset that exists today (edit → reload → API; conflicting edit from a second tab; stage progression; a logged call written once under
 * a double click) and records the CRM-only steps as BLOCKED until the integrated candidate mounts /__crm. Phase 2 extends the CRM half once the
 * candidate's API is frozen (worker E's AGENTS-CRM-CONTRACTS.md: crm.activity.add with an idempotent eventId, subjects on jobs).
 *
 *   bun scripts/acceptance/r7/journey-g-crm.ts [--hub http://127.0.0.1:8128]
 */
import { api, closeAll, DATA, expect, flat, HUB, pageHealth, record, session, shot, SIZES, until, writeResults } from "./lib";

const ROW = "G crm";
type Lead = { id: number; name: string; area?: string; status?: string; editVersion?: string };

async function main() {
  const s = await session(SIZES[0]);
  const p = s.page;
  await p.goto(`${HUB}/leads`, { waitUntil: "domcontentloaded" });
  const crmMount = await api(p, "GET", "/__crm/snapshot");
  const crmPage = await p.request.get(`${HUB}/crm`).then((r) => r.status()).catch(() => 0);
  const hasCrm = crmMount.status !== 404 && crmMount.status !== 403 && crmMount.status < 500;
  record(ROW, "CRM mount present on this build", hasCrm ? "PASS" : "BLOCKED", { "/__crm/snapshot": crmMount.status, "/crm": crmPage, note: hasCrm ? "run the CRM half (phase 2)" : "baseline has no /__crm: CRM create, deals, tasks, imports and job linking are BLOCKED until the candidate mounts it" });

  // ---- Leads subset: edit a lead in the drawer, reload, API
  const leads = ((await api(p, "GET", "/__operator/leads/list")).json?.leads ?? []) as Lead[];
  const lead = leads.find((l) => /Synthetic Dental Studio/.test(l.name)) ?? leads[0];
  if (!lead) return record(ROW, "a synthetic lead exists", "BLOCKED", { leads: leads.length });
  const detail = async () => ((await api(p, "GET", `/__operator/leads/detail?id=${lead.id}`)).json ?? {}) as { lead?: Lead; activities?: { kind?: string; note?: string; event?: string }[]; pipeline?: { stage: string } };
  await p.goto(`${HUB}/leads?lead=${lead.id}`, { waitUntil: "domcontentloaded" });
  const editBtn = p.getByRole("button", { name: "Edit lead" });
  await editBtn.waitFor({ timeout: 30_000 });
  await editBtn.click();
  const form = p.getByRole("form", { name: "Edit lead details" });
  const area = form.getByLabel("Area");
  const newArea = `Acceptville NSW ${Date.now().toString(36).slice(-3)}`;
  await area.fill(newArea);
  await form.getByRole("button", { name: "Save lead" }).click();
  await until("saved", async () => ((await detail()).lead?.area === newArea ? true : null), 15_000);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  const drawerText = flat(await p.locator('[role="dialog"]').first().innerText().catch(() => ""));
  expect(ROW, "leads: edit a field in the drawer → Save → reload shows it; the API has it", (await detail()).lead?.area === newArea && drawerText.includes(newArea), { area: (await detail()).lead?.area, inDrawerAfterReload: drawerText.includes(newArea) });
  await shot(p, "g-1-lead-edited");

  // ---- Conflicting edit: tab B opened the editor before tab A saved
  const p2 = await s.ctx.newPage();
  await p2.goto(`${HUB}/leads?lead=${lead.id}`, { waitUntil: "domcontentloaded" });
  await p2.getByRole("button", { name: "Edit lead" }).click({ timeout: 30_000 });
  await p.getByRole("button", { name: "Edit lead" }).click({ timeout: 30_000 });
  await p.getByRole("form", { name: "Edit lead details" }).getByLabel("Area").fill("Tab A NSW");
  await p.getByRole("form", { name: "Edit lead details" }).getByRole("button", { name: "Save lead" }).click();
  await until("A saved", async () => ((await detail()).lead?.area === "Tab A NSW" ? true : null), 15_000);
  const f2 = p2.getByRole("form", { name: "Edit lead details" });
  await f2.getByLabel("Area").fill("Tab B NSW (stale)");
  await f2.getByRole("button", { name: "Save lead" }).click();
  await p2.waitForTimeout(2500);
  const bText = flat((await p2.locator('[role="dialog"] [role="alert"], [role="dialog"] [role="status"]').allInnerTexts().catch(() => [])).join(" | "));
  expect(ROW, "leads: a stale second tab's save is refused in words and does not overwrite the newer value", (await detail()).lead?.area === "Tab A NSW" && /changed|newer|reload|someone|since you/i.test(bText), { server: (await detail()).lead?.area, staleTabSays: (bText.match(/[^.]*(changed|newer|reload|since you)[^.]*\./i) ?? [""])[0] });
  await shot(p2, "g-2-stale-tab");
  await p2.close();

  // ---- Logged call under a double click: one activity (Call tab → "No answer"). The form sends no idempotency key (CLOUD-RECONCILIATION-R7 §2).
  const acts0 = (await detail()).activities?.length ?? 0;
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.getByRole("tab", { name: /^Call/ }).first().click({ timeout: 20_000 }).catch(() => undefined);
  const logCall = p.getByRole("button", { name: /^No answer$/ }).first();
  await logCall.waitFor({ timeout: 15_000 }).catch(() => undefined);
  if ((await logCall.count()) === 0) {
    record(ROW, "leads: a logged call under a double click is written once", "BLOCKED", { why: "no 'No answer' outcome button in the Call tab", tabText: flat(await p.locator('[role="dialog"]').first().innerText().catch(() => "")).slice(0, 200) });
  } else {
    await logCall.dblclick({ delay: 30 });
    await p.waitForTimeout(3000);
    const acts1 = (await detail()).activities ?? [];
    expect(ROW, "leads: a logged call under a double click (No answer) is written once", acts1.length - acts0 === 1, { before: acts0, after: acts1.length, newest: acts1.slice(0, 3).map((a) => JSON.stringify(a).slice(0, 120)) });
  }

  // ---- The server half of the same rule: two requests with the same event key log one call
  {
    const n0 = (await detail()).activities?.length ?? 0;
    const event = `r7h-${Date.now().toString(36)}`;
    const r1 = await api(p, "POST", "/__operator/leads/log", { lead: lead.id, outcome: "voicemail", kind: "call", by: "usman", note: "", next: null, event });
    const r2 = await api(p, "POST", "/__operator/leads/log", { lead: lead.id, outcome: "voicemail", kind: "call", by: "usman", note: "", next: null, event });
    const n1 = (await detail()).activities?.length ?? 0;
    expect(ROW, "leads: /leads/log with the same event key twice writes one activity (server dedupe)", r1.status === 200 && n1 - n0 === 1, { first: r1.status, second: r2.status, added: n1 - n0 });
  }

  // ---- Layout of the drawer at 390
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${HUB}/leads?lead=${lead.id}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  const h = await pageHealth(p);
  expect(ROW, "leads drawer at 390: no overflow, no crash", !h.overflow && !h.crashed, h);
  await shot(p, "g-3-drawer-390");

  if (!hasCrm) {
    for (const step of ["CRM: create a company and contact", "CRM: edit, conflicting edit (409) and reload", "CRM: deal stage and task progression", "CRM: CSV import preview, conflicts and re-run = no-op", "CRM: saved result linked once (eventId <jobId>:result twice)"])
      record(ROW, step, "BLOCKED", "no /__crm on this build");
  } else await crmHalf(s.ctx, p);
}

type Snap = {
  companies: { id: string; name: string; notes: string; version: number }[];
  contacts: { id: string; companyId: string; name: string }[];
  deals: { id: string; companyId: string; title: string; stageId: string; version: number; owner: string; scope: string }[];
  tasks: { id: string; companyId: string; title: string; status: string; version: number }[];
  activities: { id: string; ref?: unknown; eventId?: string; title: string; artifact?: string | null }[];
};

/**
 * The CRM half (candidate): every write through the mounted UI where the UI has it, every effect re-read from /__crm/snapshot (the app's own
 * read) after a reload. Operations the UI drives through /__crm/ops (deal move, task complete, CSV, activity) are also sent directly to prove
 * the server-side rules: a stale expectedVersion is a 409 and changes nothing; the same eventId twice is one activity.
 */
async function crmHalf(ctx: import("playwright-core").BrowserContext, p: import("playwright-core").Page) {
  const snap = async () => (await api(p, "GET", "/__crm/snapshot")).json as Snap;
  const op = async (name: string, input: unknown) => api(p, "POST", "/__crm/ops", { name, input });
  const prefix = `R7H Synthetic ${Date.now().toString(36)}`;
  await p.setViewportSize({ width: 1440, height: 900 });

  // ---- Create (Cancel and Escape write nothing; a double-clicked Add company makes one)
  await p.goto(`${HUB}/crm?view=companies`, { waitUntil: "domcontentloaded" });
  await p.getByRole("heading", { name: "CRM", exact: true }).waitFor({ timeout: 30_000 });
  const before = await snap();
  await p.getByRole("button", { name: "Add company", exact: true }).first().click();
  const dialog = p.getByRole("dialog");
  await dialog.getByLabel("Business name", { exact: true }).fill(`${prefix} escaped`);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(600);
  const escapeClosed = !(await dialog.isVisible().catch(() => false));
  if (!escapeClosed) await dialog.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => undefined);
  await p.getByRole("button", { name: "Add company", exact: true }).first().click();
  await dialog.getByLabel("Business name", { exact: true }).fill(prefix);
  await dialog.getByLabel("Internal notes", { exact: true }).fill("Synthetic company made by the R7 acceptance run.");
  await dialog.getByRole("button", { name: "Add company", exact: true }).dblclick();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  const made = (await snap()).companies.filter((c) => c.name.startsWith(prefix));
  expect(ROW, "CRM: Escape (or Cancel) on the Add company dialog writes nothing; Add company double-clicked makes exactly one", made.length === 1 && made[0].name === prefix, { escapeClosed, made: made.map((c) => c.name), companiesBefore: before.companies.length });
  const company = made[0];
  if (!company) return;
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.getByPlaceholder("Name, phone, email or company ID").fill(prefix);
  await p.getByRole("button", { name: prefix, exact: true }).click({ timeout: 20_000 });
  await p.getByRole("button", { name: "Edit company", exact: true }).waitFor({ timeout: 20_000 });
  record(ROW, "CRM: after reload the company is found by search and opens", "PASS", { id: company.id });
  await shot(p, "g-4-crm-company");

  // ---- Edit, and a conflicting edit from a stale second tab
  const p2 = await ctx.newPage();
  await p2.goto(p.url(), { waitUntil: "domcontentloaded" });
  await p2.getByRole("button", { name: "Edit company", exact: true }).click({ timeout: 30_000 });
  await p.getByRole("button", { name: "Edit company", exact: true }).click();
  await dialog.getByLabel("Internal notes", { exact: true }).fill("Tab A wins (R7).");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  const afterA = (await snap()).companies.find((c) => c.id === company.id);
  const d2 = p2.getByRole("dialog");
  await d2.getByLabel("Internal notes", { exact: true }).fill("Tab B is stale (R7).");
  await d2.getByRole("button", { name: "Save changes", exact: true }).click();
  await p2.waitForTimeout(2500);
  const staleSays = flat((await p2.locator('[role="alert"], [role="status"]').allInnerTexts().catch(() => [])).join(" | "));
  const afterB = (await snap()).companies.find((c) => c.id === company.id);
  const bDraft = await d2.getByLabel("Internal notes", { exact: true }).inputValue().catch(() => "(dialog closed)");
  expect(ROW, "CRM: edit persists with a higher version; a stale tab's save is refused in words, keeps its text, and does not overwrite", afterA?.notes === "Tab A wins (R7)." && (afterA?.version ?? 0) > company.version && afterB?.notes === "Tab A wins (R7)." && /changed|newer|refresh|reload|someone/i.test(staleSays), { versions: [company.version, afterA?.version, afterB?.version], server: afterB?.notes, staleSays: staleSays.slice(0, 200), bDraft });
  await shot(p2, "g-5-crm-stale");
  await p2.close();

  // ---- Contact, deal, deal stage, task
  const companyUrl = `${HUB}/crm?view=companies&ref=${encodeURIComponent(`crm:company:${company.id}`)}&tab=overview`;
  await p.goto(companyUrl, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: "Edit company", exact: true }).waitFor({ timeout: 20_000 });
  await p.getByRole("tabpanel").getByRole("button", { name: "Add contact", exact: true }).last().click({ timeout: 20_000 });
  await dialog.getByLabel("Full name", { exact: true }).fill("Synthetic Contact R7");
  await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  const contactDialogStayed = await dialog.isVisible().catch(() => false);
  if (contactDialogStayed) record(ROW, "CRM: the Add contact dialog closes after a save", "FAIL", { said: flat(await dialog.innerText().catch(() => "")).slice(0, 300) });
  await p.goto(companyUrl, { waitUntil: "domcontentloaded" });
  await p.getByRole("tab", { name: "Deals", exact: true }).click({ timeout: 20_000 }).catch(async (e) => {
    await shot(p, "g-debug-deals-tab");
    throw new Error(`Deals tab not reachable at ${p.url().replace(HUB, "")}; dialogs ${await p.getByRole("dialog").count()}; tabs ${await p.getByRole("tab").evaluateAll((t) => t.map((x) => x.textContent?.trim()).join(","))}: ${String(e).slice(0, 60)}`);
  });
  await p.getByRole("tabpanel").getByRole("button", { name: "Add deal", exact: true }).last().click();
  await dialog.getByLabel("Title", { exact: true }).fill(`${prefix} website`);
  await dialog.getByLabel("Responsible founder", { exact: true }).selectOption("usman");
  await dialog.getByLabel("Sales stage", { exact: true }).selectOption("qualified");
  await dialog.getByLabel("Service and scope", { exact: true }).fill("Synthetic scope (R7)");
  await dialog.getByRole("button", { name: "Add deal", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await p.reload({ waitUntil: "domcontentloaded" });
  let s1 = await snap();
  const contact = s1.contacts.find((c) => c.companyId === company.id);
  const deal = s1.deals.find((d) => d.companyId === company.id);
  expect(ROW, "CRM: a contact and a deal (owner, stage, scope) made in the UI are stored under the company", contact?.name === "Synthetic Contact R7" && deal?.owner === "usman" && deal?.stageId === "qualified" && deal?.scope === "Synthetic scope (R7)", { contact: contact?.name, deal: deal && { stage: deal.stageId, owner: deal.owner, scope: deal.scope } });
  if (deal) {
    const moved = await op("crm.deal.move", { id: deal.id, expectedVersion: deal.version, stageId: "proposal" });
    const stale = await op("crm.deal.move", { id: deal.id, expectedVersion: deal.version, stageId: "won" });
    s1 = await snap();
    const now = s1.deals.find((d) => d.id === deal.id);
    expect(ROW, "CRM: deal stage progression persists; the same move with a stale version is a 409 and changes nothing", moved.status === 200 && stale.status === 409 && now?.stageId === "proposal", { move: moved.status, staleMove: [stale.status, stale.json?.code], stage: now?.stageId });
  }
  const t = await op("crm.task.create", { companyId: company.id, title: `${prefix} follow up`, owner: "usman" });
  s1 = await snap();
  const task = s1.tasks.find((x) => x.companyId === company.id && x.title === `${prefix} follow up`);
  const done = task ? await op("crm.task.complete", { id: task.id, expectedVersion: task.version }) : null;
  const again = task ? await op("crm.task.complete", { id: task.id, expectedVersion: task.version }) : null;
  const taskAfter = (await snap()).tasks.find((x) => x.id === task?.id);
  expect(ROW, "CRM: task create → complete persists; completing again with the old version is refused", t.status === 200 && done?.status === 200 && taskAfter?.status !== "open" && (again?.status ?? 0) >= 400, { create: t.status, complete: done?.status, again: again?.status, status: taskAfter?.status });

  // ---- CSV import: preview, commit, the same file again creates nothing new
  // Unique per run: a re-run must not collide with the last run's import (that is a duplicate, correctly held for a decision).
  const tail = String(Date.now()).slice(-4);
  const csv = `name,website,phone\n${prefix} Import Co,https://import-r7-${tail}.example,025550${tail}\n`;
  const count = async () => (await snap()).companies.filter((c) => c.name === `${prefix} Import Co`).length;
  const pv = await op("crm.csv.preview", { csv, kind: "companies" });
  const previewId = pv.json?.data?.id;
  const cm = previewId ? await op("crm.csv.commit", { previewId }) : null;
  const cm2 = previewId ? await op("crm.csv.commit", { previewId }) : null; // the same commit twice
  const afterFirst = await count();
  const pv2 = await op("crm.csv.preview", { csv, kind: "companies" });
  const pv2Id = pv2.json?.data?.id;
  const cm3 = pv2Id ? await op("crm.csv.commit", { previewId: pv2Id }) : null;
  const afterRerun = await count();
  expect(ROW, "CRM: CSV import commits once; committing the same preview again and re-importing the same file add nothing", pv.status === 200 && cm?.status === 200 && afterFirst === 1 && afterRerun === 1, { preview: pv.status, commit: [cm?.status, cm?.json?.text], commitAgain: [cm2?.status, cm2?.json?.code], rerunPreview: pv2.status, rerunCommit: [cm3?.status, cm3?.json?.code], rerunConflicts: JSON.stringify(pv2.json?.result ?? pv2.json ?? {}).slice(0, 200), count: [afterFirst, afterRerun] });

  // ---- A saved result linked to the company once (eventId <jobId>:result, sent twice), and the link opens the artifact
  const marker = JSON.parse(await Bun.file(`${process.env.R7_DATA ?? DATA}\\.gate-seed.json`).text()) as { jobs: { key: string; jobId: string }[] };
  const jobId = marker.jobs.find((j) => j.key === "result-research")?.jobId;
  const input = { ref: { kind: "company", id: company.id }, eventId: `${jobId}:result`, kind: "result", title: "Research result (R7 synthetic)", artifact: `artifact:${jobId}` };
  const a1 = await op("crm.activity.add", input);
  const a2 = await op("crm.activity.add", input);
  const acts = (await snap()).activities.filter((a) => a.eventId === `${jobId}:result`);
  const art = await p.request.get(`${HUB}/__computers/artifacts/${jobId}`); // where artifact:<jobId> opens
  expect(ROW, "CRM: the same result event twice is one activity, and its artifact opens", a1.status === 200 && acts.length === 1 && art.status() === 200, { first: [a1.status, a1.json?.text], second: [a2.status, a2.json?.code, a2.json?.text], activities: acts.length, artifact: art.status() });
  // The op answers with the place it is shown (href): the company timeline. Open it fresh, as a person following that link would.
  await p.goto(`${HUB}${a1.json?.href ?? `/crm?ref=${encodeURIComponent(`crm:company:${company.id}`)}&tab=timeline`}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  const timeline = flat(await p.locator("main").innerText());
  record(ROW, "CRM: the linked result appears on the company page after reload", timeline.includes("Research result (R7 synthetic)") ? "PASS" : "FAIL", { onPage: timeline.includes("Research result (R7 synthetic)") });

  // ---- Layouts and the migrated (Google-sourced) companies
  for (const size of SIZES) {
    await p.setViewportSize({ width: size.w, height: size.h });
    await p.goto(`${HUB}/crm?view=companies`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);
    const h = await pageHealth(p);
    expect(ROW, `CRM companies at ${size.tag}: no overflow, no crash`, !h.overflow && !h.crashed, h);
    await shot(p, `g-6-crm-${size.tag}`);
  }
  // A phone shows the company page without its tab row: Deals and Delivery must still be reachable.
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${HUB}/crm?view=companies&ref=${encodeURIComponent(`crm:company:${company.id}`)}&tab=overview`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: "Edit company", exact: true }).waitFor({ timeout: 20_000 });
  const phoneDeals = await p.getByRole("tab", { name: "Deals", exact: true }).count() + await p.getByRole("button", { name: "Add deal", exact: true }).count() + await p.getByRole("link", { name: /deals/i }).count() + await p.getByRole("combobox").count();
  expect(ROW, "CRM company page at 390: deals and delivery are reachable (tab, select or button)", phoneDeals > 0, { reachableControls: phoneDeals });
  await shot(p, "g-7-crm-company-390");
  await p.setViewportSize({ width: 1440, height: 900 });
  const unnamed = await p.evaluate(() => [...document.querySelectorAll("main button")].filter((b) => (b as HTMLElement).offsetParent !== null && !(b.getAttribute("aria-label") || b.textContent || "").trim()).length);
  const nameless = (await snap()).companies.filter((c) => !c.name).length;
  expect(ROW, "CRM: every company row has an accessible name (migrated leads with no independently sourced name included)", unnamed === 0, { unnamedButtons: unnamed, companiesWithNoName: nameless });
  // Identity: a program without a session cannot write
  const program = await fetch(`${HUB}/__crm/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "crm.company.create", input: { name: "Intruder Co" } }) });
  expect(ROW, "CRM: a program with no session cannot write (401/403), nothing created", [401, 403].includes(program.status) && !(await snap()).companies.some((c) => c.name === "Intruder Co"), { status: program.status });
}

try {
  await main();
} catch (e) {
  record(ROW, "journey ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults("journey-g-crm");
  await closeAll();
}
