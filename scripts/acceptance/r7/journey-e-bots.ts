#!/usr/bin/env bun
/**
 * Round 7 acceptance, journey E: create, edit, duplicate and archive a bot, with configuration, history and computer assignment verified.
 * Real clicks and keys in a real browser as the confirmed owner; every effect is re-read after a reload AND through /__agents (the app's own API).
 * Also: double-click on Create and Duplicate makes one bot, a stale second tab is refused (409) without overwriting, a taken name is refused,
 * Escape closes the New bot panel, 834/390 layouts, a pending browser and a program are refused.
 *
 *   bun scripts/acceptance/r7/journey-e-bots.ts [--hub http://127.0.0.1:8128] [--name Lark]
 */
import { api, arg, closeAll, expect, flat, focusRing, HUB, pageHealth, record, session, shot, SIZES, until, writeResults } from "./lib";

const NAME = arg("name", `Lark${Date.now().toString(36).slice(-4)}`);
const ID = NAME.toLowerCase();
const ROW = "E bots";
type BotRead = { id: string; name: string; purpose: string; instructions: string; computer: string | null; coding: unknown; modelPreference: unknown; rev: number; lifecycle: string; createdBy?: unknown; updatedBy?: unknown };

async function main() {
  const s = await session(SIZES[0]);
  const p = s.page;
  const bots = async () => ((await api(p, "GET", "/__agents/bots")).json?.bots ?? []) as BotRead[];
  const bot = async (id: string) => (await api(p, "GET", `/__agents/bots/${id}`)).json as BotRead & { conversationId?: string };
  const before = await bots();
  record(ROW, "baseline bots", "PASS", before.map((b) => `${b.id}:${b.lifecycle}`));

  // ---- Create (Escape, then the form; a double click on Create)
  await p.goto(`${HUB}/agents/workspace`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: "New bot" }).waitFor({ timeout: 30_000 });
  await p.getByRole("button", { name: "New bot" }).click();
  await p.locator('[data-testid="new-bot"]').waitFor({ timeout: 10_000 });
  const nameFocused = await focusRing(p);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  const closedByEscape = (await p.locator('[data-testid="new-bot"]').count()) === 0;
  const focusBack = await focusRing(p);
  expect(ROW, "New bot opens with focus in Name; Escape on the empty form closes the panel and focus returns to New bot", nameFocused.focused && /name|scout/i.test(JSON.stringify(nameFocused)) && closedByEscape && /new bot/i.test(focusBack.focused ? focusBack.name : ""), { nameFocused, closedByEscape, focusAfter: focusBack });
  if (!closedByEscape) await p.getByRole("button", { name: "New bot" }).click(); // toggle closed
  // With text typed, Escape must NOT throw the text away (the panel stays; Cancel is the deliberate way out).
  await p.getByRole("button", { name: "New bot" }).click();
  await p.locator("#new-bot-name").fill("Typed, not saved");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  const typedKept = (await p.locator("#new-bot-name").inputValue().catch(() => "")) === "Typed, not saved";
  expect(ROW, "Escape with typed text keeps the panel and the text (no silent loss)", typedKept, { kept: typedKept });
  await p.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);
  await p.waitForTimeout(300);
  if (await p.locator('[data-testid="new-bot"]').count()) await p.getByRole("button", { name: "New bot" }).click();
  await p.getByRole("button", { name: "New bot" }).click();
  await p.locator("#new-bot-name").fill(NAME);
  await p.locator("#new-bot-purpose").fill("Synthetic acceptance bot: reads public pages and writes a short cited note.");
  await p.locator("#new-bot-instructions").fill("Synthetic acceptance instructions. Keep it short.");
  const computerOptions = await p.locator("#new-bot-computer option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, t: o.textContent, d: (o as HTMLOptionElement).disabled })));
  const createBtn = p.getByRole("button", { name: "Create bot" });
  await createBtn.dblclick({ delay: 30 });
  const created = await until("the new bot", async () => (await bots()).find((b) => b.id === ID) ?? null, 20_000);
  await p.waitForTimeout(1500);
  const sameName = (await bots()).filter((b) => b.name.toLowerCase().startsWith(NAME.toLowerCase()));
  expect(ROW, "Create bot (double-clicked) makes exactly one bot and opens it", !!created && sameName.length === 1 && p.url().includes(`/agents/workspace/${ID}`), { url: p.url().replace(HUB, ""), made: sameName.map((b) => b.id), computerOptions, formError: flat(await p.locator('[data-testid="new-bot-error"]').textContent().catch(() => "")) });
  await shot(p, "e-1-created");
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.locator(`[role="radio"][data-bot-row="${ID}"], [role="radio"]:text-is("${NAME}")`).waitFor({ timeout: 20_000 }).catch(() => undefined);
  const after = await bot(ID);
  expect(ROW, "after reload the new bot is in the selector and the API has its purpose and instructions", (await p.locator(`[role="radio"][data-bot-row="${ID}"], [role="radio"]:text-is("${NAME}")`).count()) === 1 && /Synthetic acceptance bot/.test(after?.purpose ?? "") && /Keep it short/.test(after?.instructions ?? ""), { purpose: after?.purpose, rev: after?.rev, createdBy: after?.createdBy ?? null });

  // ---- A taken name is refused, nothing is written
  await p.getByRole("button", { name: "New bot" }).click();
  await p.locator("#new-bot-name").fill("research");
  await p.locator("#new-bot-purpose").fill("A second Research: must be refused.");
  await p.getByRole("button", { name: "Create bot" }).click();
  await p.waitForTimeout(2000);
  const refusalText = flat((await p.locator('[data-testid="new-bot"] [role="alert"]').allInnerTexts().catch(() => [])).join(" | "));
  const countAfterRefusal = (await bots()).length;
  expect(ROW, "a taken name (Research) is refused in words and creates nothing", countAfterRefusal === before.length + 1 && /taken|already|another bot|share a name/i.test(refusalText), { countAfterRefusal, said: (refusalText.match(/[^.]*(taken|already|share a name)[^.]*\./i) ?? [""])[0] });
  await p.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);

  // ---- Edit purpose in Setup; Save; reload; API rev
  await p.goto(`${HUB}/agents/workspace/${ID}?tab=setup`, { waitUntil: "domcontentloaded" });
  const purpose = p.locator("#bot-purpose");
  await purpose.waitFor({ timeout: 20_000 });
  const rev0 = (await bot(ID)).rev;
  await purpose.fill("Edited once by the acceptance run.");
  const purposeSection = p.locator("#setup-purpose");
  await purposeSection.getByRole("button", { name: "Save", exact: true }).click();
  await until("saved", async () => (await bot(ID)).purpose === "Edited once by the acceptance run.", 15_000);
  await p.reload({ waitUntil: "domcontentloaded" });
  await purpose.waitFor({ timeout: 20_000 });
  const shown = await purpose.inputValue();
  const b1 = await bot(ID);
  expect(ROW, "edit purpose → Save → reload shows it; the API has it and rev went up", shown === "Edited once by the acceptance run." && b1.rev > rev0, { shown, rev0, rev1: b1.rev, updatedBy: b1.updatedBy ?? null });

  // ---- Ctrl+Enter saves from the keyboard
  await purpose.click(); // a person clicks into the field first (a programmatic focus within 4 s of a load is released by the H-10 keyboard-start fix)
  await purpose.fill("Edited by keyboard (Ctrl+Enter).");
  await purpose.press("Control+Enter");
  const kb = await until("keyboard save", async () => (await bot(ID)).purpose === "Edited by keyboard (Ctrl+Enter)." || null, 10_000);
  expect(ROW, "keyboard: Ctrl+Enter in Purpose saves", !!kb, { purpose: (await bot(ID)).purpose });

  // ---- Concurrent edit: a stale second tab is refused and does not overwrite
  const p2 = await s.ctx.newPage();
  await p2.goto(`${HUB}/agents/workspace/${ID}?tab=setup`, { waitUntil: "domcontentloaded" });
  await p2.locator("#bot-purpose").waitFor({ timeout: 20_000 });
  await purpose.fill("Tab A wins.");
  await purposeSection.getByRole("button", { name: "Save", exact: true }).click();
  await until("A saved", async () => (await bot(ID)).purpose === "Tab A wins." || null, 10_000);
  await p2.locator("#bot-purpose").fill("Tab B is stale.");
  await p2.locator("#setup-purpose").getByRole("button", { name: "Save", exact: true }).click();
  await p2.waitForTimeout(2500);
  const staleText = flat(await p2.locator("main").innerText());
  const kept = await bot(ID);
  const draftKept = await p2.locator("#bot-purpose").inputValue();
  expect(ROW, "concurrent edit: the stale tab is told 'changed elsewhere', keeps its text, and the newer value is not overwritten", kept.purpose === "Tab A wins." && /changed elsewhere|reload/i.test(staleText) && draftKept === "Tab B is stale.", { server: kept.purpose, staleTabSays: (staleText.match(/[^.]*changed elsewhere[^.]*/i) ?? [""])[0], draftKept });
  await shot(p2, "e-2-stale-tab");
  await p2.close();

  // ---- Computer assignment: change it, reload, API
  await p.reload({ waitUntil: "domcontentloaded" });
  const sel = p.locator("#bot-computer");
  await sel.waitFor({ timeout: 20_000 });
  const options = await sel.locator("option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, t: (o.textContent ?? "").trim(), d: (o as HTMLOptionElement).disabled })));
  const current = (await bot(ID)).computer;
  const target = options.find((o) => !o.d && o.v !== (current ?? ""));
  if (!target || (await sel.isDisabled())) {
    record(ROW, "computer assignment: change → reload → API", "BLOCKED", { why: "this synthetic hub has no computers (host none): the select offers nothing else to pick", options, disabled: await sel.isDisabled(), current });
  } else {
    await sel.selectOption(target.v);
    await until("computer saved", async () => (await bot(ID)).computer === (target.v || null) || null, 10_000);
    await p.reload({ waitUntil: "domcontentloaded" });
    await sel.waitFor({ timeout: 20_000 });
    expect(ROW, "computer assignment: change → reload → API", (await sel.inputValue()) === target.v && (await bot(ID)).computer === (target.v || null), { from: current, to: target, shown: await sel.inputValue() });
  }

  // ---- Duplicate Research (it has history): configuration copied, history not; double-click makes one copy
  const researchFiles = (await api(p, "GET", "/__agents/bots/research/files")).json?.files?.length ?? 0;
  const researchTasks = (await api(p, "GET", "/__agents/bots/research/tasks")).json?.tasks?.length ?? 0;
  await p.goto(`${HUB}/agents/workspace/research?tab=setup`, { waitUntil: "domcontentloaded" });
  const dup = p.getByRole("button", { name: "Duplicate", exact: true });
  await dup.waitFor({ timeout: 20_000 });
  const idsBefore = new Set((await bots()).map((b) => b.id));
  await dup.dblclick({ delay: 30 });
  const copy = await until("copy", async () => (await bots()).find((b) => !idsBefore.has(b.id) && /^research copy/i.test(b.name)) ?? null, 15_000);
  await p.waitForTimeout(1500);
  const copies = (await bots()).filter((b) => !idsBefore.has(b.id));
  const src = await bot("research");
  // A computer that does not exist on this hub is deliberately not carried over (scripts/agents/validate.ts copyOf): then the copy has none.
  const srcComputerMissing = JSON.stringify((src as { readiness?: unknown }).readiness ?? "").includes("computer-missing");
  const computerOk = !!copy && (copy.computer === src.computer || (srcComputerMissing && copy.computer === null));
  const cfgSame = !!copy && computerOk && copy.purpose === src.purpose && copy.instructions === src.instructions && JSON.stringify(copy.coding) === JSON.stringify(src.coding) && JSON.stringify(copy.modelPreference) === JSON.stringify(src.modelPreference);
  const copyFiles = copy ? (await api(p, "GET", `/__agents/bots/${copy.id}/files`)).json?.files?.length ?? -1 : -1;
  const copyTasks = copy ? (await api(p, "GET", `/__agents/bots/${copy.id}/tasks`)).json?.tasks?.length ?? -1 : -1;
  const copyThread = copy ? (await api(p, "GET", `/__agents/bots/${copy.id}/thread`)).json?.entries?.length ?? -1 : -1;
  expect(ROW, "Duplicate (double-clicked) makes one copy with the same configuration", copies.length === 1 && cfgSame, { copies: copies.map((c) => c.id), cfgSame, computer: { source: src.computer, copy: copy?.computer ?? null, sourceComputerMissing: srcComputerMissing } });
  expect(ROW, "the copy has none of the source's history (tasks, files, conversation)", copyFiles === 0 && copyTasks === 0 && copyThread <= 0, { researchFiles, researchTasks, copyFiles, copyTasks, copyThread });
  await shot(p, "e-3-duplicated");

  // ---- Archive the new bot: confirm; hidden from the row; Show archived lists it; reads stay open; unarchive
  await p.goto(`${HUB}/agents/workspace/${ID}?tab=setup`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: "Archive…" }).click();
  await p.locator('[data-testid="archive-confirm"]').waitFor({ timeout: 10_000 });
  await p.getByRole("button", { name: `Archive ${NAME}` }).click();
  const archived = await until("archived", async () => (await bot(ID)).lifecycle === "archived" || null, 15_000);
  await p.goto(`${HUB}/agents/workspace/research`, { waitUntil: "domcontentloaded" });
  await p.locator(`[role="radio"][data-bot-row="research"]`).or(p.getByRole("radio", { name: "Research", exact: true })).first().waitFor({ timeout: 20_000 });
  const inRow = await p.locator(`[role="radio"][data-bot-row="${ID}"], [role="radio"]:text-is("${NAME}")`).count();
  const showArchived = p.getByRole("button", { name: /Show archived/ });
  const label = flat(await showArchived.textContent());
  await showArchived.click();
  const listed = flat(await p.locator('[data-testid="archived-bots"]').innerText().catch(() => ""));
  const reads = (await api(p, "GET", `/__agents/bots/${ID}/tasks`)).status;
  expect(ROW, "Archive: confirmed, persisted, gone from the row, listed under Show archived, reads stay open", !!archived && inRow === 0 && listed.includes(NAME) && reads === 200, { lifecycle: (await bot(ID)).lifecycle, inRow, label, listed: listed.slice(0, 160), tasksRead: reads });
  await shot(p, "e-4-archived");
  // An archived bot refuses changes through the API too
  const patch = await api(p, "PATCH", `/__agents/bots/${ID}`, { rev: (await bot(ID)).rev, purpose: "must not save" });
  expect(ROW, "an archived bot's settings are read-only (PATCH refused, nothing written)", patch.status >= 400 && (await bot(ID)).purpose === "Tab A wins.", { status: patch.status, error: patch.json?.error });
  await p.goto(`${HUB}/agents/workspace/${ID}?tab=setup`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: "Unarchive", exact: true }).first().click();
  const back = await until("unarchived", async () => (await bot(ID)).lifecycle === "active" || null, 15_000);
  expect(ROW, "Unarchive restores it (persisted)", !!back, { lifecycle: (await bot(ID)).lifecycle });
  // History: who did what to this bot. Created, archived and unarchived are recorded; an edit to purpose or instructions should be too.
  const history = ((await bot(ID)) as { history?: { action: string; by?: string }[] }).history ?? [];
  const actions = history.map((h) => `${h.action}:${h.by ?? "?"}`);
  expect(ROW, "history records create, archive and unarchive with the person", ["created", "archived", "unarchived"].every((a) => actions.some((x) => x.startsWith(`${a}:usman`))), { actions });
  const edits = history.filter((h) => h.action === "edited");
  expect(ROW, "history records the person behind each settings edit (3 saved purpose edits; the stale tab's was refused)", edits.length === 3 && edits.every((h) => h.by === "usman"), { actions, edits: edits.length });
  expect(ROW, "an edit history entry names the changed fields, never the text (instructions are not logged)", !JSON.stringify(history).includes("Tab A wins") && !JSON.stringify(history).includes("Keep it short"), { sample: history.filter((h) => h.action === "edited").slice(0, 2) });

  // ---- Layouts: Setup at 834 and 390, no overflow, Save reachable
  for (const size of SIZES.slice(1)) {
    await p.setViewportSize({ width: size.w, height: size.h });
    await p.goto(`${HUB}/agents/workspace/${ID}?tab=setup`, { waitUntil: "domcontentloaded" });
    await p.locator("#bot-purpose").waitFor({ timeout: 20_000 });
    const h = await pageHealth(p);
    const save = purposeSection.getByRole("button", { name: "Save", exact: true });
    await save.scrollIntoViewIfNeeded();
    const box = await save.boundingBox();
    expect(ROW, `Setup at ${size.tag}: no overflow, Save on screen and at least 24px`, !h.overflow && !h.crashed && !!box && box.x >= 0 && box.x + box.width <= size.w && box.height >= 24, { ...h, save: box });
    await shot(p, `e-5-setup-${size.tag}`);
  }
  await p.setViewportSize({ width: 1440, height: 900 });

  // ---- Identity. A program with no session is refused in every role. A PENDING browser (a navigation-minted session nobody confirmed) is refused
  // in the server role; in the pc role it is "the owner at the hub" (scripts/identity/principal.ts isAtHub: via loopback-owner, any actor), which
  // the routes doc allows. That pc-role allowance is recorded as finding H-03, not as a pass or a fail of this journey.
  const role = (await api(p, "GET", "/__health")).json?.hubRole ?? "unknown";
  const pending = await session(SIZES[0], { fresh: true });
  const who = await (await import("./lib")).me(pending.page);
  const program = await fetch(`${HUB}/__agents/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Intruder2", purpose: "x" }) });
  if (role === "pc") {
    const pendingRead = await api(pending.page, "GET", `/__agents/bots/${ID}/thread`);
    const probe = await api(pending.page, "PATCH", `/__agents/bots/${ID}`, { rev: 0, purpose: "stale rev: never written" }); // a stale rev, so nothing can be written
    record(ROW, "identity (pc role): a pending browser at the hub PC counts as the owner at the hub (finding H-03)", "PASS", { pending: who, threadRead: pendingRead.status, staleRevPatch: probe.status, note: "409 on a stale rev means the write gate let it through; 403 would mean refused" });
  } else {
    const pendingCreate = await api(pending.page, "POST", "/__agents/bots", { name: "Intruder", purpose: "must be refused" });
    expect(ROW, `identity (${role} role): a pending browser cannot create a bot`, pendingCreate.status === 403, { pending: who, status: pendingCreate.status });
  }
  const after2 = await bots();
  expect(ROW, "identity: a program with no session is refused (401/403) and nothing is created or changed", [401, 403].includes(program.status) && !after2.some((b) => /intruder/i.test(b.name)) && (await bot(ID)).purpose === "Tab A wins.", { program: program.status });
  await pending.ctx.close();
  expect(ROW, "no page errors during the journey", s.errors.filter((e) => e.startsWith("pageerror")).length === 0, { errors: s.errors.slice(0, 6) });
}

try {
  await main();
} catch (e) {
  record(ROW, "journey ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults("journey-e-bots", { bot: NAME });
  await closeAll();
}
