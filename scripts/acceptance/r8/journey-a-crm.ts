#!/usr/bin/env bun
/**
 * Round 8, track A2: CRM interface check on a SYNTHETIC hub, then the deliverables importer (dry run, apply, second apply) against that hub's database.
 *
 *   bun scripts/acceptance/r8/journey-a-crm.ts --hub http://127.0.0.1:8155 --data D:\AgenticOS-r8-data\a --out D:\AgenticOS-r8-data\a\shots [--part ui|import|all] [--preview <copy of the preview>] [--extracted <folder>]
 *
 * Screenshots go to --out (outside the repository: the import half shows private client names). Every check passes only on a persisted effect.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import {
  api,
  arg,
  closeAll,
  DATA,
  expect,
  flat,
  HUB,
  launch,
  record,
  session,
  shot,
  SIZES,
  until,
  writeResults,
} from "../r7/lib";

const ROW = "A2 crm";
const part = arg("part", "all");
const stamp = Date.now().toString(36).slice(-4);
const NAME = `Acceptance Bakery ${stamp}`;
const snap = async (p: Page) => (await api(p, "GET", "/__crm/snapshot")).json as any;
const dialog = (p: Page) => p.getByRole("dialog");
async function save(p: Page, name: string) {
  await dialog(p).getByRole("button", { name, exact: true }).click();
  await dialog(p).waitFor({ state: "hidden", timeout: 15_000 });
}
async function openCompany(p: Page, name: string) {
  await p.goto(`${HUB}/crm?view=companies`, { waitUntil: "domcontentloaded" });
  await p.getByPlaceholder("Name, phone, email or company ID").fill(name);
  await p.getByRole("button", { name, exact: true }).first().click();
  await p.getByRole("button", { name: "Edit company", exact: true }).waitFor({ timeout: 15_000 });
}

async function ui() {
  const s = await session(SIZES[0]);
  const p = s.page;
  await p.goto(`${HUB}/crm?view=companies`, { waitUntil: "domcontentloaded" });
  const before = await snap(p);
  expect(
    ROW,
    "CRM opens on the migrated synthetic hub (not the needs-upgrade state)",
    Array.isArray(before.companies) && before.companies.length >= 1,
    { companies: before.companies?.length },
  );

  // 1. search
  const search = p.getByPlaceholder("Name, phone, email or company ID");
  await search.fill("synthetic-3.example");
  await p.waitForTimeout(600);
  const hit = flat(await p.locator("main").innerText());
  await search.fill("zzzz-no-such-business");
  await p.waitForTimeout(600);
  const none = flat(await p.locator("main").innerText());
  expect(
    ROW,
    "search finds a company by its email and shows nothing for a nonsense term",
    /lead #3/.test(hit) &&
      !/lead #1\b/.test(hit) &&
      /0 companies|No companies|No matching/i.test(none),
    { hit: hit.slice(0, 200), none: none.slice(-200) },
  );
  await search.fill("");

  // 2. create a company, edit it, reload
  await p.getByRole("button", { name: "Add company", exact: true }).first().click();
  await dialog(p).getByLabel("Business name", { exact: true }).fill(NAME);
  await dialog(p)
    .getByLabel("Internal notes", { exact: true })
    .fill("Created in the browser check");
  await save(p, "Add company");
  const created = (await snap(p)).companies.filter((c: any) => c.name === NAME);
  expect(ROW, "create company persists exactly once", created.length === 1, { n: created.length });
  const company = created[0];
  await openCompany(p, NAME);
  await shot(p, "ui-1-company");
  await p.getByRole("button", { name: "Edit company", exact: true }).click();
  await dialog(p).getByLabel("Internal notes", { exact: true }).fill("Edited in the browser check");
  await save(p, "Save changes");
  await p.reload({ waitUntil: "domcontentloaded" });
  const edited = (await snap(p)).companies.find((c: any) => c.id === company.id);
  expect(
    ROW,
    "edit company persists after a refresh, same id, version bumped",
    edited?.notes === "Edited in the browser check" && edited.version > company.version,
    { version: [company.version, edited?.version] },
  );
  await p.getByRole("button", { name: "Edit company", exact: true }).waitFor({ timeout: 15_000 });
  expect(
    ROW,
    "the page shows the edited company after refresh",
    (await p.locator("main").innerText()).includes(NAME),
    {},
  );

  // 3. contact
  await p.getByRole("button", { name: "Add contact", exact: true }).click();
  await dialog(p).getByLabel("Full name", { exact: true }).fill("Acceptance Contact");
  await save(p, "Add contact");
  const contacts = (await snap(p)).contacts.filter((c: any) => c.companyId === company.id);
  expect(
    ROW,
    "create contact persists under the company (relationship)",
    contacts.length === 1 && contacts[0].name === "Acceptance Contact",
    { n: contacts.length },
  );

  // 4. deal, then a stage change
  await p.getByRole("tab", { name: /^Deals/ }).click();
  await p.getByRole("button", { name: "Add deal", exact: true }).click();
  await dialog(p).getByLabel("Title", { exact: true }).fill(`${NAME} website`);
  await dialog(p).getByLabel("Sales stage", { exact: true }).selectOption("contacted");
  await dialog(p)
    .getByLabel("Commercial basis", { exact: true })
    .selectOption("pending")
    .catch(() => undefined);
  await save(p, "Add deal");
  let deal = (await snap(p)).deals.find((d: any) => d.companyId === company.id);
  expect(
    ROW,
    "create deal persists; pending price shows no amount",
    !!deal && deal.commercialBasis === "pending" && deal.oneOffCents === 0,
    { basis: deal?.commercialBasis, cents: deal?.oneOffCents },
  );
  expect(
    ROW,
    "the deal page says 'Pricing pending', never a catalogue figure",
    /Pricing pending/.test(await p.locator("main").innerText()) &&
      !/\$699|A\$699|699\.00/.test(await p.locator("main").innerText()),
    {},
  );
  await shot(p, "ui-2-deal-pending");
  await p.goto(`${HUB}/crm?view=pipeline`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  const table = p.getByText("Table", { exact: true });
  if (await table.count()) await table.first().click();
  const stageSelect = p
    .getByRole("row")
    .filter({ hasText: `${NAME} website` })
    .locator("select")
    .first();
  await stageSelect.waitFor({ timeout: 15_000 });
  await stageSelect.selectOption("meeting");
  await until(
    "stage saved",
    async () =>
      (await snap(p)).deals.find((d: any) => d.id === deal.id)?.stageId === "meeting" ? true : null,
    15_000,
  );
  await p.reload({ waitUntil: "domcontentloaded" });
  deal = (await snap(p)).deals.find((d: any) => d.id === deal.id);
  expect(
    ROW,
    "deal stage change persists with history",
    deal.stageId === "meeting" && deal.stageHistory.length >= 2,
    { stage: deal.stageId, history: deal.stageHistory.length },
  );
  await shot(p, "ui-3-pipeline");

  // 5. a follow-up task
  await openCompany(p, NAME);
  const addTask = p.getByRole("button", { name: /^Add (task|follow-up)/ }).first();
  await addTask.click();
  await dialog(p).getByLabel("Title", { exact: true }).fill("Call about the contact links");
  await dialog(p)
    .getByLabel(/Due date/)
    .fill("2026-10-01T09:00");
  await dialog(p)
    .getByRole("button", { name: /^Add (task|follow-up)/ })
    .last()
    .click();
  await dialog(p).waitFor({ state: "hidden", timeout: 15_000 });
  await p.reload({ waitUntil: "domcontentloaded" });
  const task = (await snap(p)).tasks.find((t: any) => t.companyId === company.id);
  expect(
    ROW,
    "task / follow-up persists with its due date after refresh",
    !!task && !!task.dueAt && task.status === "open",
    { task: !!task },
  );
  await p.goto(`${HUB}/crm`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  expect(
    ROW,
    "the Today view lists the follow-up",
    /Call about the contact links/.test(await p.locator("main").innerText()),
    {},
  );

  // 6. stale edit refused: tab B opens the editor, tab A saves, tab B's save is refused and the stored value survives
  await openCompany(p, NAME);
  const b = await s.ctx.newPage();
  await openCompany(b, NAME);
  await b.getByRole("button", { name: "Edit company", exact: true }).click();
  await dialog(b).getByLabel("Internal notes", { exact: true }).fill("Stale edit from tab B");
  await p.getByRole("button", { name: "Edit company", exact: true }).click();
  await dialog(p).getByLabel("Internal notes", { exact: true }).fill("Winning edit from tab A");
  await save(p, "Save changes");
  await dialog(b).getByRole("button", { name: "Save changes", exact: true }).click();
  await b.waitForTimeout(1500);
  const bText = flat(await b.locator("body").innerText());
  const final = (await snap(p)).companies.find((c: any) => c.id === company.id);
  expect(
    ROW,
    "a stale edit is refused with a plain message, and the winning edit stays",
    final.notes === "Winning edit from tab A" &&
      /changed while you were editing|Reload|refresh/i.test(bText),
    { notes: final.notes, message: /changed while you were editing|Reload/i.exec(bText)?.[0] },
  );
  await shot(b, "ui-4-stale-edit");
  await b.close();

  // 7. unconfirmed callers cannot open a private file (the import half checks the file itself)
  const fresh = await session(SIZES[0], { fresh: true });
  const anon = await api(fresh.page, "GET", "/__crm/file?id=attachment-" + "0".repeat(32));
  expect(
    ROW,
    "a fresh, unconfirmed browser is refused the file route",
    anon.status === 401 || anon.status === 403,
    { status: anon.status },
  );
  await fresh.page.close();
  await shot(p, "ui-5-final");
}

async function importPart() {
  const preview = arg("preview", join(DATA, "preview-copy"));
  const extracted = arg("extracted", "D:\\AgenticOS-staging\\dot-deliverables-20261003\\extracted");
  const run = (extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        "scripts/crm/import-deliverables.ts",
        "--db",
        join(DATA, "crm.sqlite"),
        "--preview",
        preview,
        "--extracted",
        extracted,
        "--report",
        join(DATA, "import-report.json"),
        ...extra,
      ],
      { encoding: "utf8" },
    );
  if (!existsSync(preview))
    return record(ROW, "a copy of the staged preview exists", "BLOCKED", { preview });
  const s = await session(SIZES[0]);
  const p = s.page;
  await p.goto(`${HUB}/crm`, { waitUntil: "domcontentloaded" });
  const sizes = (x: any) =>
    JSON.stringify(
      [x.companies, x.contacts, x.deals, x.tasks, x.documents, x.activities].map(
        (l: any[]) => l.length,
      ),
    );
  const beforeDry = await snap(p);
  const dry = run([]);
  expect(
    ROW,
    "importer dry run succeeds and reports its plan",
    dry.status === 0 && /company +[0-9]+/.test(dry.stdout),
    { exit: dry.status, head: dry.stdout.split(String.fromCharCode(10)).slice(0, 10).join(" | ") },
  );
  const afterDry = await snap(p);
  expect(ROW, "the dry run wrote nothing to the hub", sizes(beforeDry) === sizes(afterDry), {
    before: sizes(beforeDry),
    after: sizes(afterDry),
  });
  const applied = run(["--apply", "--backup", join(DATA, `pre-import-${stamp}.sqlite`)]);
  expect(ROW, "importer apply succeeds", applied.status === 0, {
    exit: applied.status,
    head: (applied.stdout || applied.stderr).split("\n").slice(0, 12).join(" | "),
  });
  await p.reload({ waitUntil: "domcontentloaded" });
  const after = await snap(p);
  const imported = after.companies.filter((c: any) => c.tags?.includes("import:dot-20261002"));
  expect(ROW, "the hub shows the imported companies without a restart", imported.length === 41, {
    n: imported.length,
  });
  const importedIds = new Set(imported.map((c: any) => c.id));
  const pending = after.deals.filter(
    (d: any) => importedIds.has(d.companyId) && d.commercialBasis === "pending",
  );
  const importedDeals = after.deals.filter((d: any) => importedIds.has(d.companyId));
  expect(
    ROW,
    "every imported deal is Pricing pending with no amount",
    pending.length === 33 &&
      importedDeals.length === 33 &&
      pending.every((d: any) => d.oneOffCents === 0 && d.catalogueId === null),
    { n: pending.length },
  );
  const drafts = after.activities.filter((a: any) => a.kind === "draft-reply");
  expect(
    ROW,
    "reply drafts are all unsent drafts",
    drafts.length === 6 && drafts.every((a: any) => a.communicationState === "drafted"),
    { n: drafts.length },
  );

  // a document with files opens, and its file downloads for a confirmed session
  const doc = after.documents.find(
    (d: any) =>
      importedIds.has(d.companyId) && d.kind === "brief" && /MU-001-20261002/.test(d.title),
  );
  const company = after.companies.find((c: any) => c.id === doc?.companyId);
  expect(ROW, "the meeting-pack document is linked to its company", !!doc && !!company, {
    doc: !!doc,
  });
  await p.goto(`${HUB}/crm?ref=${encodeURIComponent(`crm:company:${company.id}`)}&tab=deals`, {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(2500);
  await shot(p, "import-1-company");
  const row = p.locator(`[id="crm-document-deals-${doc.id}"]`);
  await row.waitFor({ timeout: 15_000 });
  await row.getByRole("button", { name: /Versions and content/ }).click();
  await p.waitForTimeout(3000);
  const links = p.getByRole("list", { name: "Private files" }).getByRole("link");
  expect(ROW, "the document page lists its private file as a link", (await links.count()) >= 1, {
    links: await links.count(),
  });
  await shot(p, "import-2-document");
  const full = (
    await api(p, "GET", `/__crm/record?ref=${encodeURIComponent(`crm:document:${doc.id}`)}`)
  ).json?.data;
  const att = full?.attachments?.[0];
  const dl = await p.evaluate(async (id) => {
    const r = await fetch(`/__crm/file?id=${id}`);
    const b = await r.arrayBuffer();
    return {
      status: r.status,
      bytes: b.byteLength,
      disposition: r.headers.get("content-disposition"),
      cache: r.headers.get("cache-control"),
    };
  }, att?.id);
  expect(
    ROW,
    "the attachment opens for the confirmed session with the stored size",
    dl.status === 200 &&
      dl.bytes === att?.bytes &&
      /attachment/.test(dl.disposition ?? "") &&
      /no-store/.test(dl.cache ?? ""),
    dl,
  );
  const fresh = await session(SIZES[0], { fresh: true });
  const refused = await fresh.page.evaluate(
    async (id) => (await fetch(`/__crm/file?id=${id}`)).status,
    att?.id,
  );
  expect(
    ROW,
    "the same attachment is refused without a confirmed session",
    refused === 401 || refused === 403,
    { status: refused },
  );
  await fresh.page.close();

  // a task with its dependency, a draft on the deal timeline, a pending deal
  const task = after.tasks.find((t: any) => t.dependsOn?.length);
  const tc = after.companies.find((c: any) => c.id === task?.companyId);
  await p.goto(`${HUB}/crm?ref=${encodeURIComponent(`crm:company:${tc.id}`)}&tab=overview`, {
    waitUntil: "domcontentloaded",
  });
  await p.waitForTimeout(2500);
  const text = await p.locator("main").innerText();
  expect(
    ROW,
    "the owner-review task opens with 'Waiting on' and its evidence",
    /Waiting on:/.test(text) && /Evidence:/.test(text),
    { waiting: /Waiting on:/.test(text), evidence: /Evidence:/.test(text) },
  );
  await shot(p, "import-3-task");
  const draftActivity = drafts[0];
  await p.goto(
    `${HUB}/crm?ref=${encodeURIComponent(`crm:company:${draftActivity.companyId}`)}&tab=timeline`,
    { waitUntil: "domcontentloaded" },
  );
  await p.waitForTimeout(2500);
  expect(
    ROW,
    "the draft reply shows on the timeline as UNSENT",
    /UNSENT draft reply/.test(await p.locator("main").innerText()),
    {},
  );
  await shot(p, "import-4-draft");
  const dealRow = importedDeals[0];
  await p.goto(
    `${HUB}/crm?ref=${encodeURIComponent(`crm:company:${dealRow.companyId}`)}&tab=deals`,
    { waitUntil: "domcontentloaded" },
  );
  await p.waitForTimeout(2500);
  expect(
    ROW,
    "an imported deal shows Pricing pending",
    /Pricing pending/.test(await p.locator("main").innerText()),
    {},
  );
  await shot(p, "import-5-deal");

  // the pending deal editor: price boxes blank (not 0), a no-change save works, and the pipeline total leaves pending deals out
  await p.getByRole("button", { name: "Edit deal", exact: true }).first().click();
  const oneOff = dialog(p).getByLabel("One-off value (AUD)");
  const recurring = dialog(p).getByLabel("Monthly recurring value (AUD)");
  expect(
    ROW,
    "the pending deal editor shows blank price boxes, not 0",
    (await oneOff.inputValue()) === "" && (await recurring.inputValue()) === "",
    { oneOff: await oneOff.inputValue(), recurring: await recurring.inputValue() },
  );
  await shot(p, "import-6-pending-editor");
  await dialog(p).getByRole("button", { name: /^Save/ }).click();
  await dialog(p).waitFor({ state: "hidden", timeout: 15_000 });
  const stillPending = (await snap(p)).deals.find((d: any) => d.id === dealRow.id);
  expect(
    ROW,
    "saving the pending deal without changes keeps it pending at zero cents",
    stillPending.commercialBasis === "pending" && stillPending.oneOffCents === 0,
    { basis: stillPending.commercialBasis },
  );
  await p.goto(`${HUB}/crm?view=pipeline`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  const board = await p.locator("main").innerText();
  const pendingNow = (await snap(p)).deals.filter(
    (d: any) => d.commercialBasis === "pending" && !["won", "lost"].includes(d.stageId),
  ).length;
  expect(
    ROW,
    "the pipeline total leaves pending deals out and says how many are pending",
    new RegExp(`${pendingNow} with pricing pending`).test(board),
    { pendingNow, text: board.slice(board.indexOf("Estimated open pipeline")).slice(0, 200) },
  );
  await shot(p, "import-7-pipeline-totals");

  // persistence + second apply
  await p.reload({ waitUntil: "domcontentloaded" });
  const reloaded = await snap(p);
  expect(
    ROW,
    "everything is still there after another refresh",
    reloaded.documents.length === after.documents.length &&
      reloaded.tasks.length === after.tasks.length,
    {},
  );
  const again = run(["--apply", "--backup", join(DATA, `pre-import-again-${stamp}.sqlite`)]);
  const second = await snap(p);
  const ids = (x: any) =>
    JSON.stringify(
      [x.companies, x.contacts, x.deals, x.tasks, x.documents, x.activities].map((l: any[]) =>
        l.map((r) => [r.id, r.version ?? 0]),
      ),
    );
  expect(
    ROW,
    "a second apply changes nothing",
    again.status === 0 &&
      /unchanged/.test(again.stdout) &&
      !/\bcreate\b/.test(again.stdout) &&
      ids(second) === ids(reloaded),
    { exit: again.status, head: again.stdout.split("\n").slice(0, 10).join(" | ") },
  );
}

try {
  if (part === "ui" || part === "all") await ui();
  if (part === "import" || part === "all") await importPart();
} catch (e) {
  record(ROW, "journey ran to the end", "FAIL", {
    error: e instanceof Error ? e.message.slice(0, 400) : String(e),
  });
} finally {
  writeResults("a2-crm");
  await closeAll();
  await launch()
    .then((b) => b.close())
    .catch(() => undefined);
}
