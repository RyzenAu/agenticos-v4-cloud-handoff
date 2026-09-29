import { describe, expect, test } from "bun:test";
import { leadActionIn } from "../jarvis-command/intents";
import { describedLead, nameScore, resolveLead } from "../jarvis-command/lead-resolve";
import { LEAD_EVENT_WINDOW_MS, leadEventKey, runLeadAction } from "../jarvis-command/leads";
import { planRules } from "../jarvis-command/plan";

/**
 * F1 flow 3: "log a call to X as no answer", "mark X as won", by name, by a near-miss of the name and by
 * description ("the dentist in Parramatta"), on a synthetic CRM behind the leads API's shape. No real CRM.
 */

type Row = { id: number; name: string; area: string; vertical: string; status: string };
function crm(rows: Row[], opts: { stamp?: () => number } = {}) {
  const writes: unknown[] = [];
  const state = new Map(rows.map((r) => [r.id, { ...r }]));
  const activities: Array<{ id: number; leadId: number; kind: string; outcome: string; by: string; event?: string; at?: string }> = [];
  const handle = async (path: string, _method: string, body: any, params: URLSearchParams) => {
    if (path === "/leads/search") {
      const needle = (params.get("q") ?? "").toLowerCase();
      return { hits: [...state.values()].filter((l) => l.name.toLowerCase().includes(needle) || l.area.toLowerCase().includes(needle)).map((l) => ({ group: "leads", leadId: l.id, title: l.name, detail: `${l.area} · ${l.vertical}` })) };
    }
    if (path === "/leads/list") {
      const vertical = params.get("vertical");
      const status = params.get("status");
      return { leads: [...state.values()].filter((l) => (!vertical || l.vertical === vertical) && (!status || l.status === status)) };
    }
    if (path === "/leads/detail") return { lead: state.get(Number(params.get("id"))), activities: activities.filter((a) => a.leadId === Number(params.get("id"))) };
    if (path === "/leads/log") {
      writes.push(body);
      if (body.event && activities.some((a) => a.event === body.event)) return { lead: {}, duplicate: true };
      activities.push({ id: activities.length + 1, leadId: body.lead, kind: body.kind, outcome: body.outcome, by: body.by, event: body.event, ...(opts.stamp ? { at: new Date(opts.stamp()).toISOString() } : {}) });
      state.get(body.lead)!.status = body.outcome;
      return { lead: {}, duplicate: false };
    }
    throw new Error(path);
  };
  return { api: { handle }, writes, state, activities, lists: () => 0 };
}
const ROWS: Row[] = [
  { id: 1, name: "Harbour Dental Pty Ltd", area: "Parramatta", vertical: "dental", status: "to_call" },
  { id: 2, name: "Blacktown Family Dental", area: "Blacktown", vertical: "dental", status: "new" },
  { id: 3, name: "Marden Property Group", area: "Parramatta", vertical: "real-estate", status: "to_call" },
  { id: 4, name: "Lantern Smiles", area: "Rozelle", vertical: "dental", status: "won" },
  { id: 5, name: "Rozelle Smiles Studio", area: "Rozelle", vertical: "dental", status: "new" },
];
const usman = { personId: "usman" } as never;

describe("F1 flow 3: how the words are read", () => {
  test("log, status and the natural ways of saying them; pronouns and unknown outcomes are not CRM commands", () => {
    expect(leadActionIn("log a call to Harbour Dental as no answer")).toEqual({ action: "log", lead: "Harbour Dental", outcome: "no_answer" });
    expect(leadActionIn("Jarvis, log a call with Harbour Dental, voicemail")).toEqual({ action: "log", lead: "Harbour Dental", outcome: "voicemail" });
    expect(leadActionIn("log a call to the dentist in Parramatta as didn't answer")).toEqual({ action: "log", lead: "the dentist in Parramatta", outcome: "no_answer" });
    expect(leadActionIn("I called Harbour Dental, no answer")).toEqual({ action: "log", lead: "Harbour Dental", outcome: "no_answer" });
    expect(leadActionIn("just rang Blacktown Family Dental and got voicemail")).toEqual({ action: "log", lead: "Blacktown Family Dental", outcome: "voicemail" });
    expect(leadActionIn("mark Harbour Dental as won")).toEqual({ action: "status", lead: "Harbour Dental", outcome: "won" });
    expect(leadActionIn("mark the dentist in Parramatta won")).toEqual({ action: "status", lead: "the dentist in Parramatta", outcome: "won" });
    expect(leadActionIn("move Harbour Dental to not interested")).toEqual({ action: "status", lead: "Harbour Dental", outcome: "not_interested" });
    for (const text of ["mark it as won", "mark this as won", "mark that one lost", "log a call to Harbour Dental as fabulous", "mark the email as read", "I called the bank and it was closed"]) expect(leadActionIn(text)).toBeNull();
    expect(planRules("mark the dentist in Parramatta won")).toMatchObject({ lane: "delegate", to: "leads" });
  });

  test("descriptions: a role word and a place; a business name is not a description", () => {
    expect(describedLead("the dentist in Parramatta")).toEqual({ vertical: "dental", place: "parramatta" });
    expect(describedLead("that real estate agent at Blacktown")).toEqual({ vertical: "real-estate", place: "blacktown" });
    expect(describedLead("the Parramatta dentist")).toEqual({ vertical: "dental", place: "parramatta" });
    expect(describedLead("Harbour Dental in Parramatta")).toBeNull();
    expect(describedLead("Harbour Dental")).toBeNull();
  });

  test("near-misses score by words, not letters: a slip passes, a different word doesn't", () => {
    expect(nameScore("Harbor Dental", "Harbour Dental Pty Ltd")).toBeGreaterThan(0.9);
    expect(nameScore("harbour dental", "Harbour Dental Pty Ltd")).toBeGreaterThan(nameScore("harbor dental", "Harbour Dental Pty Ltd"));
    expect(nameScore("Harbour Physio", "Harbour Dental Pty Ltd")).toBeLessThan(0.5);
    expect(nameScore("dental", "Dentist")).toBeLessThan(0.75);
  });
});

describe("F1 flow 3: resolving and writing, with a one-line read-back", () => {
  test("a retry with the same event id adds one activity; a status-only read-back cannot verify a missing activity", async () => {
    const c = crm(ROWS);
    const action = { action: "log", lead: "Blacktown Family Dental", outcome: "no_answer" } as const;
    expect((await runLeadAction(c.api, action, usman, "synthetic-turn-1")).verified).toBe(true);
    expect((await runLeadAction(c.api, action, usman, "synthetic-turn-1")).verified).toBe(true);
    expect(c.activities).toHaveLength(1);
    const noActivity = { handle: async (path: string, method: string, body: any, params: URLSearchParams) => path === "/leads/log" ? { lead: {}, duplicate: false } : c.api.handle(path, method, body, params) };
    expect((await runLeadAction(noActivity, action, usman, "synthetic-turn-2")).verified).toBe(false);
  });
  test("the exact name: written, read back, said in one line with the suburb", async () => {
    const { api, writes } = crm(ROWS);
    const r = await runLeadAction(api, { action: "log", lead: "Blacktown Family Dental", outcome: "no_answer" }, usman);
    expect(r).toEqual({ ok: true, said: "Logged a call to Blacktown Family Dental (Blacktown) as no answer, confirmed in the CRM.", verified: true });
    expect(writes).toEqual([{ lead: 2, outcome: "no_answer", kind: "call", by: "usman", event: expect.stringMatching(/^jarvis-crm:/) }]);
    const s = await runLeadAction(api, { action: "status", lead: "Blacktown Family Dental", outcome: "won" }, usman);
    expect(s.said).toBe("Marked Blacktown Family Dental (Blacktown) as won, confirmed in the CRM.");
  });

  test("fuzzy: 'Harbor Dental' (a spelling slip, no Pty Ltd) finds Harbour Dental Pty Ltd and says so", async () => {
    const { api, writes } = crm(ROWS);
    const r = await runLeadAction(api, { action: "log", lead: "Harbor Dental", outcome: "voicemail" }, usman);
    expect(r).toEqual({ ok: true, said: 'I took "Harbor Dental" to be Harbour Dental Pty Ltd (Parramatta). Logged a call to Harbour Dental Pty Ltd as voicemail, confirmed in the CRM.', verified: true });
    expect(writes).toHaveLength(1);
    // A search that DOES hit (part of the name) needs no fuzzy step and says nothing about matching.
    const direct = await runLeadAction(crm(ROWS).api, { action: "status", lead: "Harbour Dental", outcome: "interested" }, usman);
    expect(direct.said).toBe("Marked Harbour Dental Pty Ltd (Parramatta) as interested, confirmed in the CRM.");
  });

  test("description: 'the dentist in Parramatta' is Harbour Dental (the only dental lead there still in play); a mis-heard suburb still lands", async () => {
    const one = crm(ROWS);
    const r = await runLeadAction(one.api, { action: "log", lead: "the dentist in Parramatta", outcome: "no_answer" }, usman);
    expect(r.ok).toBe(true);
    expect(r.said).toBe("That's Harbour Dental Pty Ltd (Parramatta). Logged a call to Harbour Dental Pty Ltd as no answer, confirmed in the CRM.");
    expect(one.writes).toEqual([{ lead: 1, outcome: "no_answer", kind: "call", by: "usman", event: expect.stringMatching(/^jarvis-crm:/) }]);
    const heard = crm(ROWS);
    const r2 = await runLeadAction(heard.api, { action: "status", lead: "the dentist in Paramatta", outcome: "interested" }, usman);
    expect(r2.said).toContain("Harbour Dental Pty Ltd");
    // The real-estate lead in the same suburb is not "the dentist".
    expect(heard.writes.map((w: any) => w.lead)).toEqual([1]);
  });

  test("description with two candidates asks one short question naming both; nothing is written", async () => {
    const { api, writes } = crm(ROWS);
    const r = await runLeadAction(api, { action: "log", lead: "the dentist in Rozelle", outcome: "no_answer" }, usman);
    // Lantern Smiles is already won, so only Rozelle Smiles Studio is in play: one match.
    expect(r.ok).toBe(true);
    expect(writes.map((w: any) => w.lead)).toEqual([5]);
    const two = crm([...ROWS, { id: 6, name: "Rozelle Dental Care", area: "Rozelle", vertical: "dental", status: "to_call" }]);
    const asked = await runLeadAction(two.api, { action: "log", lead: "the dentist in Rozelle", outcome: "no_answer" }, usman);
    expect(asked).toEqual({ ok: false, said: '2 leads could be "the dentist in Rozelle": Rozelle Smiles Studio (Rozelle), or Rozelle Dental Care (Rozelle). Which one?', verified: null });
    expect(two.writes).toEqual([]);
  });

  test("two close names ask; no name says so; nothing is written for either", async () => {
    const two = crm([...ROWS, { id: 7, name: "Harbour Dental Care", area: "Manly", vertical: "dental", status: "new" }]);
    // "Harbor Dental" fuzzy-matches both Harbour Dental Pty Ltd and Harbour Dental Care.
    const asked = await runLeadAction(two.api, { action: "log", lead: "Harbor Dental", outcome: "no_answer" }, usman);
    expect(asked.ok).toBe(false);
    expect(asked.said).toMatch(/^2 leads could be "Harbor Dental": .*\(Parramatta\).*\(Manly\).*Which one\?$/);
    expect(two.writes).toEqual([]);
    const none = await runLeadAction(crm(ROWS).api, { action: "log", lead: "Nobody Dental", outcome: "no_answer" }, usman);
    expect(none).toEqual({ ok: false, said: "I can't find a lead called Nobody Dental in the CRM, so nothing changed.", verified: null });
    // A description that matches nothing is "not found", never the nearest dentist.
    const far = await runLeadAction(crm(ROWS).api, { action: "log", lead: "the dentist in Broome", outcome: "no_answer" }, usman);
    expect(far.ok).toBe(false);
    expect(far.said).toContain("can't find a lead called the dentist in Broome");
  });

  test("a write the CRM doesn't read back is not called done", async () => {
    const { api } = crm(ROWS);
    const stubborn = { handle: async (path: string, m: string, body: any, params: URLSearchParams, remote: boolean) => (path === "/leads/log" ? { lead: {} } : api.handle(path, m, body, params)) };
    const r = await runLeadAction(stubborn, { action: "log", lead: "Blacktown Family Dental", outcome: "no_answer" }, usman);
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(r.said).toContain("doesn't read back as no answer");
    void resolveLead;
  });
});

describe("F1 flow 3: CRM retry identity (a repeated command is one event)", () => {
  const T0 = Date.UTC(2026, 8, 29, 1, 0, 0);
  const call = { action: "log", lead: "Blacktown Family Dental", outcome: "no_answer" } as const;

  test("the key is the intent: same person, action, lead id and outcome agree; anything else differs", () => {
    const k = leadEventKey("usman", "log", 2, "no_answer", T0);
    expect(leadEventKey("usman", "log", 2, "no_answer", T0 + 60_000)).toBe(k);
    expect(leadEventKey("usman", "log", 2, "voicemail", T0)).not.toBe(k);
    expect(leadEventKey("usman", "log", 1, "no_answer", T0)).not.toBe(k);
    expect(leadEventKey("usman", "status", 2, "no_answer", T0)).not.toBe(k);
    expect(leadEventKey("mehroz", "log", 2, "no_answer", T0)).not.toBe(k);
    expect(leadEventKey("usman", "log", 2, "no_answer", T0 + LEAD_EVENT_WINDOW_MS)).not.toBe(k); // a later, separate call is its own event
  });

  test("interested, won, interested again inside one window is three commands, not a dropped replay", async () => {
    let t = T0;
    const c = crm(ROWS, { stamp: () => t });
    const say = async (outcome: string) => {
      t += 60_000;
      return runLeadAction(c.api, { action: "status", lead: "Blacktown Family Dental", outcome } as never, usman, undefined, { now: () => t });
    };
    expect(await say("interested")).toMatchObject({ ok: true, verified: true });
    expect(await say("won")).toMatchObject({ ok: true, verified: true });
    expect(await say("interested")).toMatchObject({ ok: true, verified: true });
    expect(c.state.get(2)!.status).toBe("interested");
    expect(c.writes).toHaveLength(3);
  });

  test("resubmitting the same command (re-spoken, or spoken with a spelling slip) sends the same key and writes once", async () => {
    const c = crm(ROWS);
    const now = () => T0;
    const first = await runLeadAction(c.api, call, usman, undefined, { now });
    expect(first).toMatchObject({ ok: true, verified: true });
    // A NEW job would have produced a new id under the old scheme; the key now comes from the intent.
    const again = await runLeadAction(c.api, call, usman, undefined, { now: () => T0 + 30_000 });
    expect(again).toMatchObject({ ok: true, verified: true });
    expect(again.said).toContain("Already logged");
    expect(again.said).toContain("nothing was added twice");
    const slip = await runLeadAction(c.api, { ...call, lead: "Blacktown Family Dentist" }, usman, undefined, { now: () => T0 + 45_000 });
    expect(slip.verified).toBe(true);
    expect(c.activities).toHaveLength(1);
    expect(new Set(c.writes.map((w: any) => w.event)).size).toBe(1);
  });

  test("with activity timestamps, a repeat is confirmed by read-back and is not even sent again, including across a key-window edge", async () => {
    let clock = T0 + LEAD_EVENT_WINDOW_MS - 1_000;
    const c = crm(ROWS, { stamp: () => clock });
    expect((await runLeadAction(c.api, call, usman, undefined, { now: () => clock })).verified).toBe(true);
    clock += 5_000; // next key window, so the key alone would differ
    const again = await runLeadAction(c.api, call, usman, undefined, { now: () => clock });
    expect(again).toMatchObject({ ok: true, verified: true });
    expect(c.writes).toHaveLength(1);
    expect(c.activities).toHaveLength(1);
    // Once the window has passed, the same words are a new call and are written.
    clock += LEAD_EVENT_WINDOW_MS;
    expect((await runLeadAction(c.api, call, usman, undefined, { now: () => clock })).said).toStartWith("Logged a call");
    expect(c.activities).toHaveLength(2);
  });

  test("a genuinely different command gets a different key and its own write", async () => {
    const c = crm(ROWS);
    const now = () => T0;
    await runLeadAction(c.api, call, usman, undefined, { now });
    await runLeadAction(c.api, { ...call, outcome: "voicemail" }, usman, undefined, { now });
    await runLeadAction(c.api, { ...call, lead: "Harbour Dental" }, usman, undefined, { now });
    await runLeadAction(c.api, { action: "status", lead: "Blacktown Family Dental", outcome: "interested" }, usman, undefined, { now });
    const keys = c.writes.map((w: any) => w.event);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    expect(c.activities).toHaveLength(4);
  });

  test("retry after a failed read-back confirms the earlier write instead of writing again", async () => {
    const c = crm(ROWS);
    const now = () => T0;
    let failReadBack = true;
    // The write lands, but the independent read-back fails once (the CRM list is unavailable).
    const flaky = { handle: async (path: string, m: string, body: any, params: URLSearchParams, remote: boolean) => {
      if (failReadBack && path === "/leads/list") { failReadBack = false; throw new Error("CRM list unavailable"); }
      return c.api.handle(path, m, body, params);
    } };
    await expect(runLeadAction(flaky, call, usman, undefined, { now })).rejects.toThrow("CRM list unavailable");
    expect(c.activities).toHaveLength(1);
    const retry = await runLeadAction(flaky, call, usman, undefined, { now: () => T0 + 20_000 });
    expect(retry).toMatchObject({ ok: true, verified: true });
    expect(c.activities).toHaveLength(1); // still one entry: the retry confirmed, it did not re-write
    expect(new Set(c.writes.map((w: any) => w.event)).size).toBe(1);
  });

  test("a read-back that reports the status but no activity is still not called done, and the retry stays keyed to the same event", async () => {
    const c = crm(ROWS);
    const now = () => T0;
    const noActivity = { handle: async (path: string, m: string, body: any, params: URLSearchParams, remote: boolean) => path === "/leads/log" ? { lead: {}, duplicate: false } : c.api.handle(path, m, body, params) };
    expect((await runLeadAction(noActivity, call, usman, undefined, { now })).verified).toBe(false);
    // The real CRM now has the write (it was retried with the same key); one activity, verified.
    const retry = await runLeadAction(c.api, call, usman, undefined, { now: () => T0 + 10_000 });
    expect(retry.verified).toBe(true);
    expect(c.activities).toHaveLength(1);
  });
});
