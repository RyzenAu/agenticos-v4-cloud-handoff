import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlows, type CalendarPort } from "../flows/service";
import { freeVoice } from "../free-voice";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const root = () => { const r = mkdtempSync(join(tmpdir(), "f1-flows-")); roots.push(r); return r; };
const human = { id: "usman", name: "Usman", actor: "human", via: "voice" };
const program = { ...human, actor: "program" };
const now = new Date("2026-09-29T02:00:00.000Z");

describe("F1 email and calendar flows on synthetic ports", () => {
  test("the actual Jarvis voice turn routes a draft before any model call", async () => {
    const dir = root();
    const flows = createFlows({ root: dir, now: () => now });
    const voice = freeVoice(dir, {
      key: () => "",
      fetch: (async () => { throw new Error("model must not run"); }) as typeof fetch,
      flows: (utterance, turn) => flows.handle(utterance, { ...turn, caller: turn.caller as typeof human }),
    });
    const result = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: "draft an email to Brooke saying the site preview is ready" }] }, human) as { tool_calls?: Array<{ function: { name: string; arguments: string } }> };
    expect(result.tool_calls?.[0]?.function.name).toBe("navigate");
    expect(JSON.parse(result.tool_calls![0].function.arguments)).toMatchObject({ path: expect.stringMatching(/^\/inbox\?draft=/), say: expect.stringContaining("Nothing was sent") });
    expect(flows.recent().emailDrafts).toHaveLength(1);
  });

  test("an email is saved as an unsent draft with an inbox address, then can be discarded", async () => {
    const flows = createFlows({ root: root(), now: () => now, contacts: async () => [{ name: "Brooke", email: "brooke@example.invalid" }] });
    const reply = await flows.handle("draft an email to Brooke saying the site preview is ready", { caller: human });
    expect(reply?.say).toContain("Nothing was sent");
    const drafts = flows.recent().emailDrafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ to: { email: "brooke@example.invalid" }, state: "draft", by: "usman" });
    expect(drafts[0].body).toContain("site preview is ready");
    const edited = flows.updateDraft(drafts[0].id, "usman", { email: "new@example.invalid", subject: "Revised subject", body: "Revised body" });
    expect(edited).toMatchObject({ subject: "Revised subject", body: "Revised body", to: { email: "new@example.invalid" }, state: "draft" });
    expect(flows.updateDraft(drafts[0].id, "mehroz", { email: null, subject: "No", body: "No" })).toBeNull();
    expect(flows.recent().emailDrafts[0].subject).toBe("Revised subject");
    expect(flows.discardDraft(drafts[0].id)?.state).toBe("discarded");
    expect(flows.recent().emailDrafts).toHaveLength(0);
  });

  test("an explicit Google destination never writes to the OS calendar when Google is unavailable, including after a time clarification", async () => {
    let localWrites = 0;
    const port: CalendarPort = {
      addLocal: async () => { localWrites++; return { id: "unexpected" }; }, readLocal: async () => null, removeLocal: async () => false,
      provider: async () => null, prepare: async () => { throw new Error("unexpected"); }, create: async () => { throw new Error("unexpected"); },
    };
    const flows = createFlows({ root: root(), now: () => now, calendar: port });
    const ask = await flows.handle("add a meeting with Mehroz tomorrow to my Google Calendar", { caller: human });
    expect(ask?.say).toBe("What time?");
    const answer = await flows.handle("3 pm", { caller: human });
    expect(answer?.say).toContain("Google Calendar isn't connected with write access");
    expect(localWrites).toBe(0);
    expect(flows.recent().events).toHaveLength(0);
  });

  test("a local event is added and read back; undo removes only that event; programs cannot add", async () => {
    const records = new Map<string, { id: string; title: string; start: string; end: string }>();
    const port: CalendarPort = {
      addLocal: async (e) => { const value = { id: "evt-1", ...e }; records.set(value.id, value); return { id: value.id }; },
      readLocal: async (id) => records.get(id) ?? null,
      removeLocal: async (id) => records.delete(id),
      provider: async () => null,
      prepare: async () => { throw new Error("unexpected provider write"); },
      create: async () => { throw new Error("unexpected provider write"); },
    };
    const flows = createFlows({ root: root(), now: () => now, calendar: port });
    const said = await flows.handle("add a meeting with Mehroz tomorrow at 3 to my calendar", { caller: human });
    expect(said?.say).toBe("Added: Meeting with Mehroz, tomorrow 3:00 pm");
    expect(records.size).toBe(1);
    const event = flows.recent().events[0];
    expect(event).toMatchObject({ where: "os", state: "added", undoable: true });
    expect(await flows.undoEvent(event.id)).toEqual({ ok: true, title: "Meeting with Mehroz" });
    expect(records.size).toBe(0);
    expect(flows.recent().events[0].state).toBe("undone");
    const refused = await flows.handle("add a meeting with Mehroz tomorrow at 3 to my calendar", { caller: program });
    expect(refused?.say).toContain("Nothing was added");
    expect(records.size).toBe(0);
  });

  test("a connected calendar gets an exact review before one confirmed create", async () => {
    const calls: unknown[] = [];
    const port: CalendarPort = {
      addLocal: async () => { throw new Error("unexpected local write"); },
      readLocal: async () => null,
      removeLocal: async () => false,
      provider: async () => ({ provider: "google", account: "owner@example.invalid", calendarId: "primary", calendarName: "Primary" }),
      prepare: async (body) => { calls.push({ prepare: body }); return { reviewId: "review-1", expiresAt: "2026-09-29T02:10:00Z", provider: "google", account: "owner@example.invalid", calendar: { id: "primary", name: "Primary" }, event: { title: body.title, start: body.start, end: body.end, timeZone: body.timeZone } }; },
      create: async (body) => { calls.push({ create: body }); return { status: "created" }; },
    };
    const flows = createFlows({ root: root(), now: () => now, calendar: port });
    const asked = await flows.handle("add a meeting with Mehroz tomorrow at 3 to my calendar", { caller: human });
    expect(asked?.say).toContain("Say yes to add it");
    expect(calls).toHaveLength(1);
    const stale = await flows.handle("yes", { caller: human, previousAssistant: "A different question." });
    expect(stale?.say).toContain("Nothing was added");
    expect(calls).toHaveLength(1);
    const askedAgain = await flows.handle("add a meeting with Mehroz tomorrow at 3 to my calendar", { caller: human });
    const done = await flows.handle("yes", { caller: human, previousAssistant: askedAgain?.say });
    expect(done?.say).toContain("Added: Meeting with Mehroz");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({ create: { provider: "google", reviewId: "review-1", confirm: true } });
    expect(flows.recent().events[0].where).toBe("google");
    expect((await flows.handle("yes", { caller: human }))?.say).toBeUndefined();
  });
});
