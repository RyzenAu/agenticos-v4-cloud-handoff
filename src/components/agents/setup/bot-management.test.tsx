// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STALE_MESSAGE, createAgentBotsClient, createFakeAgentBots, seedBots, type BotView, type WorkItem } from "@/lib/agent-bots";
import { botForComputer, botFromService, isArchivedBot, sortActiveFirst, type Bot as WorkspaceBot } from "../workspace/bots";
import { BotSelector, visibleBots } from "../workspace/bot-selector";
import { deriveBotStatus } from "../workspace/status";
import { ArchivedBotsPanel, archivedLine, unarchiveBot } from "./archived-list";
import { ArchivedNotice, ManageSection, provenance } from "./manage-section";
import { stopQuestion } from "../computer/computer-controls";
import { createNewBotController, inputOf, localErrors, EMPTY_DRAFT } from "./new-bot";
import { NewBotPanel } from "./new-bot-form";
import { ComputerSection, PurposeSection, SkillsSection } from "./sections";
import { createSetupController, type ManageState } from "./setup-controller";
import { fixtureSources, computer, SKILLS } from "./setup-fixtures";

const NOW = 1_759_500_000_000;
const dom = (el: ReactElement) => {
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>).replace(/<!-- -->/g, "");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return { html, document, text: document.body.textContent ?? "" };
};
const buttons = (d: Document) => [...d.querySelectorAll("button")].map((b) => b.textContent?.trim());
const isDisabled = (el: Element | null | undefined) => !!el && el.hasAttribute("disabled");
const work: WorkItem[] = [{ jobId: "job-1", title: "Find clinics in Parramatta", kind: "computer", phase: "running" }];

async function ready(opts: Parameters<typeof createFakeAgentBots>[0] = {}, id = "research") {
  const fake = createFakeAgentBots({ now: () => NOW, ...opts });
  const c = createSetupController({ botId: id, client: fake.client, now: () => 1000 });
  await c.load();
  return { fake, c };
}
const posts = (fake: ReturnType<typeof createFakeAgentBots>) => fake.calls.filter((x) => x.method === "POST");
const idle: ManageState = { confirming: null, busy: null, blocked: null, error: null, duplicated: null };
const research = seedBots()[0]! as BotView;

// ── the Setup controller: duplicate, archive, unarchive ──────────────────────────────────────────────────────────────────────────

describe("archiving from Setup", () => {
  test("Archive asks first; confirming sends the rev it was looking at and adopts the archived bot", async () => {
    const { fake, c } = await ready();
    c.askArchive();
    expect(c.getState().manage.confirming).toBe("archive");
    expect(posts(fake)).toHaveLength(0); // nothing is sent by asking
    expect(await c.archive()).toBe(true);
    expect(posts(fake)).toEqual([{ method: "POST", id: "research", rev: 1, action: "archive" }]);
    const s = c.getState();
    expect(s.bot).toMatchObject({ lifecycle: "archived", rev: 2 });
    expect(s.manage).toEqual(idle);
    expect(s.savedAt.manage).toBe(1000);
  });

  test("Cancel sends nothing and closes the confirmation", async () => {
    const { fake, c } = await ready();
    c.askArchive();
    c.cancelArchive();
    expect(c.getState().manage.confirming).toBeNull();
    expect(posts(fake)).toHaveLength(0);
  });

  test("with work open it is refused with the list; 'after current work' is then one click, and the bot reads as archiving", async () => {
    const { fake, c } = await ready({ workOf: () => work });
    c.askArchive();
    expect(await c.archive()).toBe(false);
    let s = c.getState();
    expect(s.bot!.lifecycle).toBe("active");
    expect(s.manage.confirming).toBe("archive");
    expect(s.manage.blocked).toMatchObject({ code: "has-running-work", work });
    expect(await c.archive({ afterCurrentWork: true })).toBe(true);
    s = c.getState();
    expect(s.bot).toMatchObject({ lifecycle: "archiving", archived: { afterCurrentWork: true } });
    expect(posts(fake).map((p) => [p.action, p.afterCurrentWork])).toEqual([["archive", undefined], ["archive", true]]);
    expect(s.manage).toEqual(idle);
  });

  test("the last active bot can't be archived: it says so, and nothing changes", async () => {
    const { fake, c } = await ready();
    fake.client.archive("builder", 1, { archived: true });
    await Promise.resolve();
    c.askArchive();
    expect(await c.archive()).toBe(false);
    expect(c.getState().manage.error).toContain("only active bot");
    expect(c.getState().manage.confirming).toBeNull();
    expect(c.getState().bot!.lifecycle).toBe("active");
  });

  test("a stale rev is 'Changed elsewhere': the conflict is raised, the bot isn't archived, and writes stop until reload", async () => {
    const { fake, c } = await ready();
    fake.editElsewhere("research", { purpose: "Edited by Mehroz." });
    c.askArchive();
    expect(await c.archive()).toBe(false);
    const s = c.getState();
    expect(s.conflict).toMatchObject({ section: "manage", current: { rev: 2 } });
    expect(s.bot!.lifecycle).toBe("active");
    expect(await c.duplicate()).toBeNull(); // locked
    expect(await c.save("memory", { memory: { recall: false, saveResults: false } })).toBe(false);
    await c.reload();
    expect(c.getState().conflict).toBeNull();
    expect(c.getState().bot!.rev).toBe(2);
    expect(await c.archive()).toBe(true);
  });

  test("unarchive restores it, against the current rev", async () => {
    const { fake, c } = await ready();
    await c.archive();
    expect(c.getState().bot!.lifecycle).toBe("archived");
    expect(await c.unarchive()).toBe(true);
    expect(c.getState().bot).toMatchObject({ lifecycle: "active", rev: 3 });
    expect(posts(fake).map((p) => [p.action, p.rev])).toEqual([["archive", 1], ["unarchive", 2]]);
  });

  test("a dropped connection is said, nothing changes, and the person can try again", async () => {
    const { fake, c } = await ready();
    fake.failNextWrite();
    c.askArchive();
    expect(await c.archive()).toBe(false);
    expect(c.getState().manage.error).toContain("couldn't be reached");
    expect(c.getState().bot!.lifecycle).toBe("active");
    expect(await c.archive()).toBe(true);
  });

  test("only one change at a time: a second click while one is in flight is ignored", async () => {
    const { fake, c } = await ready({ latencyMs: 15 });
    const first = c.archive();
    expect(await c.duplicate()).toBeNull();
    await first;
    expect(posts(fake)).toHaveLength(1);
  });
});

describe("duplicating from Setup", () => {
  test("makes '<name> copy' and offers it; the original is untouched; a second copy is 'copy 2'", async () => {
    const { fake, c } = await ready();
    const copy = await c.duplicate();
    expect(copy).toMatchObject({ id: "research-copy", name: "Research copy", rev: 1, lifecycle: "active", computer: "research", routines: [] });
    expect(c.getState().manage.duplicated?.id).toBe("research-copy");
    expect(c.getState().bot).toMatchObject({ id: "research", rev: 1 });
    expect(await c.duplicate()).toBeNull(); // the notice is still up: a second click makes nothing
    c.dismissDuplicated();
    expect(c.getState().manage.duplicated).toBeNull();
    expect((await c.duplicate())?.name).toBe("Research copy 2"); // dismissed: the deliberate second copy
    expect(posts(fake).map((p) => p.action)).toEqual(["duplicate", "duplicate"]);
  });

  test("a refusal is said and no copy is offered", async () => {
    const { fake, c } = await ready();
    fake.failNextWrite();
    expect(await c.duplicate()).toBeNull();
    expect(c.getState().manage.error).toContain("couldn't be reached");
    expect(c.getState().manage.duplicated).toBeNull();
  });
});

describe("renaming", () => {
  test("a name draft is validated, saved with the rev, and shown", async () => {
    const { fake, c } = await ready();
    c.setDraft("name", "   ");
    expect(await c.savePurpose()).toBe(false);
    expect(c.getState().errors.purpose).toContain("name");
    c.setDraft("name", "Researcher  Two");
    expect(await c.savePurpose()).toBe(true);
    expect(fake.calls.find((x) => x.method === "PATCH")).toMatchObject({ rev: 1, patch: { name: "Researcher Two" } });
  });
});

// ── the pieces on the page ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Copy or archive (the section)", () => {
  const section = (bot: BotView = research, manage: ManageState = idle, locked = false) =>
    dom(<ManageSection bot={bot} manage={manage} locked={locked} status={{ saving: false, savedAt: null, error: null }} onDuplicate={() => {}} onAskArchive={() => {}} onCancel={() => {}} onArchive={() => {}} onUnarchive={() => {}} onOpen={() => {}} onDismissCopy={() => {}} />);

  test("an active bot offers Duplicate and Archive…, says what each does, and who made it", () => {
    const r = section();
    expect(buttons(r.document)).toEqual(["Duplicate", "Archive…"]);
    expect(r.text).toContain("Makes “Research copy”");
    expect(r.text).toContain("no routines, conversations, tasks or results");
    expect(r.text).toContain("nothing it is running is stopped");
    expect(r.document.querySelector('[data-testid="manage-provenance"]')).toBeNull(); // nothing recorded, nothing said
    expect(provenance({ ...research, createdBy: "mehroz", createdAt: Date.parse("2026-10-03T01:00:00Z"), duplicatedFrom: "research" }, () => "Research")).toMatch(/^Copied from Research by Mehroz on 3 Oct 2026\.$/);
  });

  test("the confirmation says what archiving does, and offers Archive and Cancel", () => {
    const r = section(research, { ...idle, confirming: "archive" });
    expect(r.document.querySelector('[data-testid="archive-confirm"]')).not.toBeNull();
    expect(r.text).toContain("Archive Research?");
    expect(r.text).toContain("Jarvis will say it is archived");
    expect(r.text).toContain("stay readable");
    expect(buttons(r.document)).toEqual(["Duplicate", "Archive Research", "Cancel"]);
  });

  test("work in the way is listed, and 'Archive after current work' says that nothing is stopped", () => {
    const r = section(research, { ...idle, confirming: "archive", blocked: { code: "has-running-work", message: "x", work } });
    expect(r.document.querySelector('[data-testid="archive-work"]')?.textContent).toContain("Find clinics in Parramatta");
    expect(r.text).toContain("computer task, running");
    expect(r.text).toContain("Nothing was archived.");
    expect(r.text).toContain("Nothing is stopped.");
    expect(buttons(r.document)).toEqual(["Duplicate", "Archive after current work", "Cancel"]);
  });

  test("an archived bot offers Unarchive; one still finishing says so", () => {
    const done = section({ ...research, lifecycle: "archived", archived: { at: NOW, by: "usman", afterCurrentWork: false } });
    expect(buttons(done.document)).toEqual(["Duplicate", "Unarchive"]);
    expect(done.document.querySelector('[data-testid="manage-archived"]')?.textContent).toContain("stay readable");
    const finishing = section({ ...research, lifecycle: "archiving", archived: { at: NOW, by: "usman", afterCurrentWork: true } });
    expect(finishing.document.querySelector('[data-testid="manage-archived"]')?.textContent).toContain("finishing; nothing is stopped");
  });

  test("a copy that was just made is offered; an error is shown; a conflict or a write in flight disables the buttons with the reason", () => {
    const made = section(research, { ...idle, duplicated: { ...research, id: "research-copy", name: "Research copy" } });
    expect(made.text).toContain("Made “Research copy”");
    expect(buttons(made.document)).toContain("Open it");
    expect(section(research, { ...idle, error: "The Agents service couldn't be reached." }).document.querySelector('[data-testid="manage-error"]')?.textContent).toContain("couldn't be reached");
    const locked = section(research, idle, true);
    expect([...locked.document.querySelectorAll("button")].every(isDisabled)).toBe(true);
    expect(locked.text).toContain("Reload the latest first");
    const busy = section(research, { ...idle, busy: "duplicate" });
    expect(busy.text).toContain("Copying…");
    expect([...busy.document.querySelectorAll("button")].every(isDisabled)).toBe(true);
  });

  test("an archived bot's Setup says so at the top, and its settings are read-only with the reason", () => {
    const notice = dom(<ArchivedNotice bot={{ ...research, lifecycle: "archived" }} busy={false} onUnarchive={() => {}} />);
    expect(notice.text).toContain("Research is archived");
    expect(notice.document.querySelector('[data-testid="archived-notice"]')?.textContent).toContain("read-only");
    const purpose = dom(<PurposeSection bot={research} busy={false} locked="Archived: unarchive this bot to change its settings." status={{ saving: false, savedAt: null, error: null }} drafts={{ purpose: "x" }} onDraft={() => {}} onDiscard={() => {}} onSave={() => {}} />);
    expect(isDisabled(purpose.document.querySelector("#bot-purpose"))).toBe(true);
    expect(isDisabled(purpose.document.querySelector("#bot-name"))).toBe(true);
    expect(purpose.text).toContain("Archived: unarchive this bot");
  });
});

describe("shared computers and honest skills", () => {
  test("Setup names who else uses the computer, and says they share one control lease: one task at a time, no queue", () => {
    const r = dom(<ComputerSection bot={{ ...research, sharesComputerWith: [{ id: "scout", name: "Scout", archived: false }, { id: "old", name: "Old", archived: true }] }} busy={false} locked={false} status={{ saving: false, savedAt: null, error: null }} save={() => {}} computers={{ status: "ok", computers: [computer("research")] }} navigate={() => {}} />);
    const line = r.document.querySelector('[data-testid="computer-shared"]')!;
    expect(line.textContent).toContain("Shared with Scout and Old (archived).");
    expect(line.textContent).toContain("one task at a time");
    expect(line.textContent).not.toMatch(/control lease|waits its turn|one queue/);
    const alone = dom(<ComputerSection bot={research} busy={false} locked={false} status={{ saving: false, savedAt: null, error: null }} save={() => {}} computers={{ status: "ok", computers: [computer("research")] }} navigate={() => {}} />);
    expect(alone.document.querySelector('[data-testid="computer-shared"]')).toBeNull();
  });

  test("skills stay read-only and Setup says why; coding is shown as unable when the hub has no account for it", () => {
    const r = dom(<SkillsSection bot={{ ...research, coding: { enabled: true, accountSlot: "claude:max-9", model: null }, abilities: [] }} status={{ saving: false, savedAt: null, error: null }} skills={{ status: "ok", skills: SKILLS }} computers={{ status: "ok", computers: [computer("research")] }} />);
    expect(r.document.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
    expect(r.document.querySelector('[data-testid="coding-abilities"]')?.textContent).toContain("claude:max-9 isn't configured on this hub");
  });
});

// ── New bot ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("New bot", () => {
  test("a draft with no name or purpose is stopped before anything is asked, with the words for each field", async () => {
    const fake = createFakeAgentBots();
    const c = createNewBotController({ client: fake.client });
    expect(await c.submit()).toBeNull();
    expect(c.getState().errors).toMatchObject({ name: "Give the bot a name.", purpose: "Say what this bot is for, in a sentence." });
    expect(fake.calls).toHaveLength(0);
    expect(localErrors({ ...EMPTY_DRAFT, name: "x".repeat(41), purpose: "p", instructions: "i".repeat(8001) })).toMatchObject({ name: expect.stringContaining("40"), instructions: expect.stringContaining("8,000") });
  });

  test("a good draft creates the bot with exactly what was chosen; coding settings travel only when coding is on", async () => {
    const fake = createFakeAgentBots({ known: { computers: ["research", "builder"] } });
    const c = createNewBotController({ client: fake.client });
    c.setField("name", "  Scout  ");
    c.setField("purpose", "Finds suppliers.");
    c.setField("computer", "research");
    c.setField("accountSlot", "claude:max-2"); // chosen, then coding left off: not sent
    const bot = await c.submit();
    expect(bot).toMatchObject({ id: "scout", name: "Scout", computer: "research", rev: 1 });
    expect(inputOf(c.getState().draft)).toEqual({ name: "Scout", purpose: "Finds suppliers.", computer: "research", coding: { enabled: false, accountSlot: null, model: null }, modelPreference: { route: "auto" } });
    c.setField("coding", true);
    expect(inputOf(c.getState().draft).coding).toEqual({ enabled: true, accountSlot: "claude:max-2", model: null });
    expect(c.getState().created?.id).toBe("scout");
  });

  test("the hub's refusals land on the field they name and keep everything typed; a name already used is said", async () => {
    const fake = createFakeAgentBots({ known: { computers: ["research"] } });
    const c = createNewBotController({ client: fake.client });
    c.setField("name", "Research");
    c.setField("purpose", "Duplicates a name.");
    expect(await c.submit()).toBeNull();
    expect(c.getState().errors.name).toContain('"Research"');
    expect(c.getState().draft.purpose).toBe("Duplicates a name.");
    c.setField("name", "Scout");
    c.setField("computer", "ghost");
    expect(await c.submit()).toBeNull();
    expect(c.getState().errors.computer).toContain("ghost");
    expect(c.getState().errors.name).toBeUndefined();
  });

  test("a dropped connection is a form-level message; submitting twice sends once", async () => {
    const fake = createFakeAgentBots({ latencyMs: 15 });
    const c = createNewBotController({ client: fake.client });
    c.setField("name", "Scout");
    c.setField("purpose", "Finds suppliers.");
    fake.failNextWrite();
    expect(await c.submit()).toBeNull();
    expect(c.getState().formError).toContain("couldn't be reached");
    const first = c.submit();
    expect(await c.submit()).toBeNull();
    await first;
    expect(fake.calls.filter((x) => x.action === "create")).toHaveLength(2);
  });

  test("the form renders its fields with labels; coding is off by default and says why it can't be on until the accounts are read", () => {
    const r = dom(<NewBotPanel bots={[{ id: "research", name: "Research", computer: "research" }]} client={createFakeAgentBots().client} sources={fixtureSources()} onCreated={() => {}} onCancel={() => {}} />);
    for (const id of ["new-bot-name", "new-bot-purpose", "new-bot-computer", "new-bot-route", "new-bot-instructions", "new-bot-coding"]) expect(r.document.getElementById(id)).not.toBeNull();
    expect(buttons(r.document)).toContain("Create bot");
    expect(r.text).toContain("Making one never makes a computer");
    expect(r.text).toContain("can't be switched on or off from Setup later");
    expect(r.document.querySelector("#new-bot-coding")?.getAttribute("aria-checked")).toBe("false");
  });
});

// ── the selector and the archived list ───────────────────────────────────────────────────────────────────────────────────────

const wb = (id: string, over: Partial<WorkspaceBot> = {}): WorkspaceBot => ({ id, name: id[0]!.toUpperCase() + id.slice(1), purpose: "p", computer: id, coding: { enabled: false, accountSlot: null, model: null }, ...over });
const ARCHIVED = { lifecycle: "archived" as const, archived: { at: NOW, by: "mehroz", afterCurrentWork: false }, rev: 4 };

describe("the selector", () => {
  const select = (bots: WorkspaceBot[], value: string) => dom(<BotSelector bots={bots} value={value} kinds={{}} onChange={() => {}} client={createFakeAgentBots().client} sources={fixtureSources()} />);

  test("archived bots are not in the row; New bot and Show archived (n) are", () => {
    const r = select([wb("research"), wb("builder"), wb("old", ARCHIVED)], "research");
    expect([...r.document.querySelectorAll('[role="radio"]')].map((b) => b.textContent?.trim())).toEqual(["Research", "Builder"]);
    expect(buttons(r.document).filter((b) => b && !["Research", "Builder"].includes(b))).toEqual(["New bot", "Show archived (1)"]);
  });

  test("with nothing archived the toggle still exists (the empty state is inside it)", () => {
    expect(buttons(select([wb("research")], "research").document)).toContain("Show archived");
  });

  test("an archived bot that is open stays in the row, marked archived, so it can be seen and left", () => {
    const bots = [wb("research"), wb("old", ARCHIVED)];
    expect(visibleBots(bots, "old").map((b) => b.id)).toEqual(["research", "old"]);
    expect(visibleBots(bots, "research").map((b) => b.id)).toEqual(["research"]);
    const r = select(bots, "old");
    expect([...r.document.querySelectorAll('[role="radio"]')].map((b) => b.textContent?.trim())).toEqual(["Research", "Oldarchived"]);
    expect(r.document.querySelector('[aria-checked="true"]')?.textContent).toContain("archived");
  });

  test("New bot and Show archived are real toggles with aria-expanded and a controlled region", () => {
    const r = select([wb("research")], "research");
    const toggles = [...r.document.querySelectorAll("button[aria-controls]")];
    expect(toggles.map((b) => [b.getAttribute("aria-controls"), b.getAttribute("aria-expanded")])).toEqual([["new-bot", "false"], ["archived-bots", "false"]]);
  });
});

describe("the archived list", () => {
  const fake = () => createFakeAgentBots().client;
  test("empty: says what archiving is and how to bring a bot back", () => {
    const r = dom(<ArchivedBotsPanel bots={[]} client={fake()} onOpen={() => {}} onChanged={() => {}} />);
    expect(r.document.querySelector('[data-testid="archived-empty"]')?.textContent).toContain("appears here, and can be brought back");
  });

  test("each row says who archived it and when, with Open and Unarchive; one still finishing says so", () => {
    const r = dom(<ArchivedBotsPanel bots={[{ id: "old", name: "Old", purpose: "p", rev: 4, archived: { at: Date.parse("2026-10-03T01:00:00Z"), by: "mehroz" } }, { id: "busy", name: "Busy", purpose: "p", rev: 2, lifecycle: "archiving", archived: { at: NOW, by: "usman" } }]} client={fake()} onOpen={() => {}} onChanged={() => {}} />);
    expect(buttons(r.document)).toEqual(["Open", "Unarchive", "Open", "Unarchive"]);
    expect(r.text).toContain("Archived 3 Oct 2026 by Mehroz.");
    expect(r.text).toContain("Its earlier jobs are still finishing.");
    expect(archivedLine({ id: "x", name: "X", purpose: "", archived: null })).toBe("Archived.");
  });

  test("unarchiving sends the rev shown: ok brings it back; a stale rev is the 'Changed elsewhere' message, nothing is overwritten", async () => {
    const f = createFakeAgentBots();
    await f.client.archive("builder", 1, { archived: true });
    const row = { id: "builder", name: "Builder", purpose: "p", rev: 2 };
    f.editElsewhere("builder", { purpose: "Changed." });
    const stale = await unarchiveBot(f.client, row);
    expect(stale).toEqual({ ok: false, stale: true, message: STALE_MESSAGE });
    expect(f.snapshot("builder")!.lifecycle).toBe("archived");
    const fresh = await unarchiveBot(f.client, { ...row, rev: f.snapshot("builder")!.rev });
    expect(fresh).toEqual({ ok: true });
    expect(f.snapshot("builder")!.lifecycle).toBe("active");
    expect(await unarchiveBot(f.client, { ...row, rev: undefined })).toMatchObject({ ok: false, stale: true });
  });
});

describe("what the workspace data helpers do with archiving", () => {
  test("the service's row carries lifecycle, rev and who shares the computer; active bots sort first", () => {
    const b = botFromService({ id: "scout", name: "Scout", purpose: "p", computer: "research", rev: 3, coding: { enabled: false }, archived: { at: 5, by: "mehroz", afterCurrentWork: true }, lifecycle: "archiving", sharesComputerWith: [{ id: "research", name: "Research", archived: false }, { nope: 1 }] })!;
    expect(b).toMatchObject({ rev: 3, lifecycle: "archiving", archived: { by: "mehroz", afterCurrentWork: true }, sharesComputerWith: [{ id: "research", name: "Research", archived: false }] });
    expect(isArchivedBot(b)).toBe(true);
    expect(botFromService({ id: "x", name: "X" })!.lifecycle).toBe("active"); // an older hub: active
    expect(botFromService({ id: "y", name: "Y", archived: { at: 1, by: "u" } })!.lifecycle).toBe("archived");
    expect(sortActiveFirst([wb("a", ARCHIVED), wb("b"), wb("c", ARCHIVED), wb("d")]).map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });

  test("'Open in workspace' for a computer prefers the active bot that uses it", () => {
    const bots = [wb("old", { ...ARCHIVED, computer: "research" }), wb("scout", { computer: "research" })];
    expect(botForComputer(bots, "research")?.id).toBe("scout");
    expect(botForComputer([wb("old", { ...ARCHIVED, computer: "research" })], "research")?.id).toBe("old");
  });

  test("the status line: an archived bot says so; a job on a shared computer that belongs to another bot is not this bot's work", () => {
    const base = { me: "usman", now: NOW };
    expect(deriveBotStatus({ ...base, bot: wb("old", ARCHIVED), computer: null })).toMatchObject({ kind: "offline", text: expect.stringContaining("Archived") });
    expect(deriveBotStatus({ ...base, bot: wb("busy", { lifecycle: "archiving" }), computer: null })).toMatchObject({ kind: "working", text: expect.stringContaining("earlier jobs are finishing") });
    const busyComputer = computer("research", { state: "busy", controller: { kind: "agent", who: "research", jobId: "j1", expiresAt: null, epoch: null }, assigned: { agent: "research", jobId: "j1", by: "usman" as never, title: "Find clinics" } });
    const mine = deriveBotStatus({ ...base, bot: wb("research", { computer: "research", sharesComputerWith: [{ id: "scout", name: "Scout", archived: false }] }), computer: busyComputer });
    expect(mine).toMatchObject({ kind: "working", text: "Working on find clinics" });
    const theirs = deriveBotStatus({ ...base, bot: wb("scout", { computer: "research", sharesComputerWith: [{ id: "research", name: "Research", archived: false }] }), computer: busyComputer });
    expect(theirs).toMatchObject({ kind: "working", text: "Busy with Research's task; ask again when it finishes" });
    expect(theirs.text).not.toMatch(/queue|waits its turn/i);
  });
});

// ── the client against the hub's routes ─────────────────────────────────────────────────────────────────────────────────────────

describe("the client speaks the hub's routes", () => {
  type Call = { url: string; init?: RequestInit };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  function clientWith(respond: (c: Call) => Response) {
    const calls: Call[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/__token") return json(200, { token: "tok-1" });
      calls.push({ url, init });
      return respond({ url, init });
    }) as unknown as typeof globalThis.fetch;
    return { client: createAgentBotsClient({ fetch }), calls };
  }
  const view = { ...seedBots()[0]!, id: "scout", name: "Scout", rev: 1 };

  test("create: POST /__agents/bots with the page token; 201 is the bot", async () => {
    const { client, calls } = clientWith(() => json(201, view));
    const r = await client.create({ name: "Scout", purpose: "Finds suppliers." });
    expect(calls[0]!.url).toBe("/__agents/bots");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>)["x-claude-os-token"]).toBe("tok-1");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: "Scout", purpose: "Finds suppliers." });
    expect(r.kind === "ok" && r.bot.id).toBe("scout");
  });

  test("create: 400 carries each field's message; 409 is 'taken'; 403 is refused; a dev server's HTML is 'unavailable'", async () => {
    const bad = await clientWith(() => json(400, { error: "Give the bot a name.", errors: [{ field: "name", message: "Give the bot a name." }] })).client.create({ name: "", purpose: "" });
    expect(bad).toMatchObject({ kind: "invalid", errors: [{ field: "name" }] });
    const taken = await clientWith(() => json(409, { error: "x", code: "id-taken", errors: [{ field: "id", message: "used" }] })).client.create({ name: "A", purpose: "b" });
    expect(taken).toMatchObject({ kind: "taken", code: "id-taken", errors: [{ field: "id" }] });
    expect((await clientWith(() => json(403, { error: "Making a bot needs a confirmed sign-in." })).client.create({ name: "A", purpose: "b" }))).toMatchObject({ kind: "refused", message: "Making a bot needs a confirmed sign-in." });
    expect((await clientWith(() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })).client.create({ name: "A", purpose: "b" })).kind).toBe("unavailable");
  });

  test("duplicate: POST /bots/:id/duplicate", async () => {
    const { client, calls } = clientWith(() => json(201, { ...view, id: "research-copy" }));
    const r = await client.duplicate("research");
    expect(calls[0]!.url).toBe("/__agents/bots/research/duplicate");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(r.kind === "ok" && r.bot.id).toBe("research-copy");
  });

  test("archive: sends rev, archived and afterCurrentWork only when chosen; 422 lists the work; 409 is stale with the current bot", async () => {
    const ok = clientWith(() => json(200, { ...view, lifecycle: "archived", archived: { at: 5, by: "usman", afterCurrentWork: false } }));
    const a = await ok.client.archive("scout", 3, { archived: true });
    expect(ok.calls[0]!.url).toBe("/__agents/bots/scout/archive");
    expect(JSON.parse(String(ok.calls[0]!.init?.body))).toEqual({ rev: 3, archived: true });
    expect(a.kind === "ok" && a.bot.lifecycle).toBe("archived");
    const after = clientWith(() => json(200, view));
    await after.client.archive("scout", 3, { archived: true, afterCurrentWork: true });
    expect(JSON.parse(String(after.calls[0]!.init?.body))).toEqual({ rev: 3, archived: true, afterCurrentWork: true });
    const blocked = await clientWith(() => json(422, { code: "has-running-work", error: "Scout has 1 job open.", work })).client.archive("scout", 3, { archived: true });
    expect(blocked).toMatchObject({ kind: "blocked", code: "has-running-work", work });
    const last = await clientWith(() => json(422, { code: "last-active", error: "only active bot" })).client.archive("scout", 3, { archived: true });
    expect(last).toMatchObject({ kind: "blocked", code: "last-active", work: [] });
    const stale = await clientWith(() => json(409, { error: "stale", current: { ...view, rev: 8 } })).client.archive("scout", 3, { archived: true });
    expect(stale).toMatchObject({ kind: "stale", message: STALE_MESSAGE, current: { rev: 8 } });
    expect((await clientWith(() => json(403, { error: "no" })).client.archive("scout", 3, { archived: false })).kind).toBe("refused");
  });
});

// ── the independent review's findings ────────────────────────────────────────────────────────────────────────────────────────

describe("review 7: Stop on a shared computer names whose task it cancels", () => {
  const bots = [{ id: "research", name: "Research", computer: "research" }, { id: "scout", name: "Scout", computer: "research" }, { id: "builder", name: "Builder", computer: "builder" }];
  const on = (name: string, agent: string, title = "Find clinics in Parramatta") => ({ name, assigned: { agent, jobId: "j1", by: "usman" as never, title } });
  test("a shared computer's question names the bot and the task, whichever bot's panel it is opened from", () => {
    expect(stopQuestion(on("research", "research"), bots)).toBe("Stop Research's task “Find clinics in Parramatta” on this shared computer? Nothing runs after this.");
    expect(stopQuestion(on("research", "scout", "Find suppliers"), bots)).toBe("Stop Scout's task “Find suppliers” on this shared computer? Nothing runs after this.");
  });
  test("a computer one bot uses, or a job nobody made for a bot, or nothing running, keeps the plain question", () => {
    expect(stopQuestion(on("builder", "builder"), bots)).toBe("Stop this computer and cancel its job? Nothing runs after this.");
    expect(stopQuestion(on("research", "someone-else"), bots)).toBe("Stop this computer and cancel its job? Nothing runs after this.");
    expect(stopQuestion({ name: "research", assigned: null }, bots)).toBe("Stop this computer?");
    expect(stopQuestion(on("research", "research"), [])).toBe("Stop this computer and cancel its job? Nothing runs after this.");
  });
});

describe("review 3: the archive confirmation lists the routines it releases", () => {
  const section = (manage: ManageState, routines: string[], bot: BotView = research) =>
    dom(<ManageSection bot={bot} manage={manage} locked={false} status={{ saving: false, savedAt: null, error: null }} routines={routines} onDuplicate={() => {}} onAskArchive={() => {}} onCancel={() => {}} onArchive={() => {}} onUnarchive={() => {}} onOpen={() => {}} onDismissCopy={() => {}} />);
  test("named in the confirmation and in the 'after current work' step; absent when there are none", () => {
    const one = section({ ...idle, confirming: "archive" }, ["Morning lead check"]);
    expect(one.document.querySelector('[data-testid="archive-releases"]')?.textContent).toContain("Archiving also releases this routine: Morning lead check.");
    expect(one.text).toContain("unarchiving does not link it again");
    const two = section({ ...idle, confirming: "archive", blocked: { code: "has-running-work", message: "x", work } }, ["A routine", "Inbox sweep"]);
    expect(two.document.querySelector('[data-testid="archive-releases"]')?.textContent).toContain("these 2 routines: A routine, Inbox sweep");
    expect(section({ ...idle, confirming: "archive" }, []).document.querySelector('[data-testid="archive-releases"]')).toBeNull();
  });
  test("an archived bot says which routines it released, and that they are not linked again", () => {
    const r = section(idle, [], { ...research, lifecycle: "archived", archived: { at: NOW, by: "usman", afterCurrentWork: false }, releasedRoutines: ["daily-leads"] });
    expect(r.document.querySelector('[data-testid="manage-released"]')?.textContent).toContain("released a routine when it was archived.");
  });
  test("a released routine that has since been deleted is said so, never shown as a raw id; with the routines unknown only the count shows", () => {
    const bot = { ...research, lifecycle: "archived" as const, archived: { at: NOW, by: "usman", afterCurrentWork: false }, releasedRoutines: ["daily-leads", "trig-gone-99"] };
    const known = dom(<ManageSection bot={bot} manage={idle} locked={false} status={{ saving: false, savedAt: null, error: null }} releasedNames={["Morning lead check", "a routine that no longer exists"]} onDuplicate={() => {}} onAskArchive={() => {}} onCancel={() => {}} onArchive={() => {}} onUnarchive={() => {}} onOpen={() => {}} onDismissCopy={() => {}} />);
    const line = known.document.querySelector('[data-testid="manage-released"]')!.textContent!;
    expect(line).toContain("2 routines");
    expect(line).toContain("(Morning lead check, a routine that no longer exists)");
    expect(line).not.toContain("trig-gone-99");
    const unknown = dom(<ManageSection bot={bot} manage={idle} locked={false} status={{ saving: false, savedAt: null, error: null }} onDuplicate={() => {}} onAskArchive={() => {}} onCancel={() => {}} onArchive={() => {}} onUnarchive={() => {}} onOpen={() => {}} onDismissCopy={() => {}} />);
    expect(unknown.document.querySelector('[data-testid="manage-released"]')!.textContent).not.toMatch(/\(|trig-gone/);
  });
  test("the client keeps releasedRoutines and the other bot a reason names", () => {
    const b = createAgentBotsClient({ fetch: (async () => new Response(JSON.stringify({ bots: [{ ...research, releasedRoutines: ["daily-leads"], readiness: { state: "working", reasons: [{ code: "computer-busy-other-bot", text: "busy", bot: { id: "research", name: "Research" } }] } }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
    return b.list().then((l) => {
      expect(l.kind === "ok" && l.bots[0]).toMatchObject({ releasedRoutines: ["daily-leads"], readiness: { reasons: [{ code: "computer-busy-other-bot", bot: { id: "research", name: "Research" } }] } });
    });
  });
});
