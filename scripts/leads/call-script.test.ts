import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, logActivity, openCrm, upsertLead } from "./crm";
import { MemoryReceiptSink } from "../model-router/receipts";
import { CallScriptError, generateCallScript, hasScript, PITCH_GUIDANCE, readScript, RECEPTIONIST_CAPABILITY } from "./call-script";

const GOOD_REPLY = {
  opener: "Hi, it's Usman from M&U Ventures — I noticed your site isn't on HTTPS, is now an OK time for 30 seconds?",
  discovery: ["How are new patients finding you at the moment?", "What happens to a call when the front desk is busy?"],
  valuePitch: "A modern, HTTPS site means patients trust the booking form again — most practices see bookings back within two weeks, for a couple of hours of your time.",
  objections: {
    price: "Compare it to one missed booking a month — this pays for itself.",
    already_have_website: "Totally — this is a fix for the HTTPS warning specifically, not a rebuild.",
    send_email: "Happy to — can I also text a 15-minute time that works, so it doesn't sit in your inbox?",
    not_now: "No problem — when's a better week to have a proper look?",
    ask_partner: "Makes sense — want me to send a one-pager you can both look at first?",
  },
  close: "Can I grab 15 minutes to show you a free preview? I can even generate it while we're on the phone.",
  followupEmail: {
    subject: "A quick idea for Smile Dental",
    body: "Hi team, following up on our call... You're getting this because your address is published on your website. Reply STOP to opt out.",
  },
};

function db() {
  const dir = mkdtempSync(join(tmpdir(), "call-script-"));
  return { dir, db: openCrm(join(dir, "crm.sqlite")) };
}

function seedLead(database: ReturnType<typeof openCrm>, overrides: Partial<Parameters<typeof upsertLead>[1]> = {}) {
  const placeId = overrides.placeId ?? "osm:node/1";
  upsertLead(database, {
    placeId, vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "(02) 9621 1234",
    address: "1 Main St", website: "http://smiledental.com.au", mapsUrl: "", rating: 4.2, reviews: 3,
    emails: ["reception@smiledental.com.au"], emailOk: true, score: 80, pitch: "redesign",
    reasons: ["the site isn't on HTTPS", "4.2★ rating with only 3 reviews"], googleAt: null, source: "osm", attribution: "© OpenStreetMap contributors",
    ...overrides,
  });
  return findLead(database, placeId)!;
}

describe("call-script", () => {
  test("uses only verified facts in the prompt and never invents a claim when there are none", async () => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database);
      const prompts: any[] = [];
      const complete = async (body: any) => {
        prompts.push(body);
        return { choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] };
      };
      const script = await generateCallScript(database, lead, { root: dir, complete, now: new Date("2026-09-26T10:00:00+10:00") });
      const userMsg = prompts[0].messages.find((m: any) => m.role === "user").content as string;
      expect(userMsg).toContain("the site isn't on HTTPS");
      // The caller's real name is always given, so no model has to invent one.
      expect(userMsg).toContain("Caller: Usman from M&U Ventures");
      // The score-only signal must be labelled as such, not handed over as a verified fact.
      expect(userMsg).toContain("Directory/score-only signals");
      expect(userMsg).toContain("4.2★ rating with only 3 reviews");
      expect(script.opener).toContain("HTTPS");
      expect(script.pitch).toBe("redesign");
      expect(script.compliance.noInventedClaims).toMatch(/verified facts above are safe/);
      expect(script.objections.price).toBeTruthy();
      expect(script.objections.already_have_website).toBeTruthy();
      expect(script.objections.send_email).toBeTruthy();
      expect(script.objections.not_now).toBeTruthy();
      expect(script.objections.ask_partner).toBeTruthy();

      // Cached to disk, and readable without calling the model again.
      expect(hasScript(dir, lead.id)).toBe(true);
      expect(readScript(dir, lead.id)?.opener).toBe(script.opener);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lead with no verified facts on file gets told explicitly not to invent anything", async () => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database, { placeId: "osm:node/2", reasons: ["4.2★ rating with only 3 reviews"], pitch: "audit_pending" });
      const complete = async () => ({ choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] });
      const script = await generateCallScript(database, lead, { root: dir, complete, now: new Date() });
      expect(script.compliance.noInventedClaims).toMatch(/don't state anything about it as fact/);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws instead of caching when the model reply isn't JSON", async () => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database);
      const complete = async () => ({ choices: [{ message: { content: "sorry, I can't help with that" } }] });
      await expect(generateCallScript(database, lead, { root: dir, complete })).rejects.toBeInstanceOf(CallScriptError);
      expect(hasScript(dir, lead.id)).toBe(false);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to Cline's free models in order when Claude fails, and labels which one wrote it", async () => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database);
      const claude = async () => {
        throw new Error("Claude usage limit reached");
      };
      const tried: string[] = [];
      const free = async (body: any) => {
        tried.push(body.model);
        if (body.model === "deepseek-v4.1-flash") throw new Error("model not found");
        return { choices: [{ message: { content: "```json\n" + JSON.stringify(GOOD_REPLY) + "\n```" } }] };
      };
      const script = await generateCallScript(database, lead, { root: dir, complete: claude, free, now: new Date() });
      expect(tried).toEqual(["deepseek-v4.1-flash", "muse-spark-1.3"]);
      expect(script.model).toMatch(/^muse-spark-1\.3 \(Cline free, fallback after Claude: Claude usage limit reached\)/);
      expect(script.opener).toContain("HTTPS");
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("when Claude and every free model fail, Claude's own error is reported and nothing is cached", async () => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database);
      const claude = async () => {
        throw new Error("Not logged in");
      };
      const free = async () => ({ choices: [{ message: { content: "no json here" } }] });
      await expect(generateCallScript(database, lead, { root: dir, complete: claude, free })).rejects.toThrow("Not logged in");
      expect(hasScript(dir, lead.id)).toBe(false);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports calling hours in the compliance block", async () => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database);
      const complete = async () => ({ choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] });
      // A Sunday, Sydney time: calls are never open.
      const sunday = new Date("2026-09-27T10:00:00+10:00");
      const script = await generateCallScript(database, lead, { root: dir, complete, now: sunday });
      expect(script.compliance.callWindow.open).toBe(false);
      expect(script.compliance.callWindow.why).toMatch(/Sunday/i);
      expect(script.compliance.dncReminder).toMatch(/Do Not Call Register/);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readScript/hasScript are false before any generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "call-script-empty-"));
    try {
      expect(hasScript(dir, 999)).toBe(false);
      expect(readScript(dir, 999)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("call-script through the model router (task callscript)", () => {
  test("one route with a receipt per attempt: Claude on the subscription, then free Cline, never paid", async () => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database);
      const sink = new MemoryReceiptSink();
      const claude = async () => {
        throw new Error("Claude usage limit reached");
      };
      const free = async () => ({ choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] });
      const script = await generateCallScript(database, lead, { root: dir, complete: claude, free, sink, now: new Date() });
      expect(script.model).toMatch(/^deepseek-v4\.1-flash \(Cline free/);
      expect(sink.receipts.map((r) => [r.task, r.model, r.route, r.outcome, r.fallbackFrom])).toEqual([
        ["callscript", "claude/sonnet-5", "subscription", "rate_limited", null],
        ["callscript", "cline/deepseek-v4.1-flash", "free", "succeeded", "claude/sonnet-5"],
      ]);
      expect(sink.receipts.every((r) => r.route !== "metered")).toBe(true);
      expect(JSON.stringify(sink.receipts)).not.toContain("HTTPS");
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CRM contact history reaches the prompt (recorded business-internal); a Claude failure falls back to free Cline", async () => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database, { placeId: "osm:node/9" });
      logActivity(database, lead, { kind: "call", outcome: "", note: "PRIVATE NOTE", by: "usman" });
      const fresh = findLead(database, "osm:node/9")!;
      const sink = new MemoryReceiptSink();
      const seen: Record<string, string> = {};
      const claude = async (body: any) => {
        seen.claude = body.messages.map((m: any) => m.content).join(" | ");
        throw new Error("Not logged in");
      };
      const free = async (body: any) => {
        seen[body.model] = body.messages.map((m: any) => m.content).join(" | ");
        return { choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] };
      };
      const script = await generateCallScript(database, fresh, { root: dir, complete: claude, free, sink, now: new Date() });
      expect(seen.claude).toContain("Last contact: call on");
      expect(seen.claude).not.toContain("never contacted");
      expect(seen["deepseek-v4.1-flash"]).toBe(seen.claude);
      expect(script.model).toMatch(/^deepseek-v4\.1-flash \(Cline free, fallback after Claude: Not logged in\)/);
      expect(sink.receipts.map((r) => [r.model, r.outcome, r.fallbackFrom])).toEqual([
        ["claude/sonnet-5", "failed", null],
        ["cline/deepseek-v4.1-flash", "succeeded", "claude/sonnet-5"],
      ]);
      expect(new Set(sink.receipts.map((r) => r.requestId)).size).toBe(1);
      expect(JSON.stringify(sink.receipts)).not.toContain("PRIVATE NOTE");
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Review T5 R6: the receptionist guidance and the close are catalogue-true (configurable cover,
// booking only at go-live into a connected calendar, one CTA), never "books straight in".
describe("call-script: receptionist claims", () => {
  const BANNED = [/straight into/i, /books straight/i, /every call/i, /calls? (they|you) miss/i, /15-minute look/i, /10-minute/i];
  const prompt = async (pitch: string) => {
    const { dir, db: database } = db();
    try {
      const lead = seedLead(database, { placeId: `osm:node/${pitch}`, pitch });
      const prompts: any[] = [];
      const complete = async (body: any) => { prompts.push(body); return { choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] }; };
      await generateCallScript(database, lead, { root: dir, complete, now: new Date("2026-09-26T10:00:00+10:00") });
      return prompts[0].messages.find((m: any) => m.role === "user").content as string;
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test.each(["receptionist", "both", "redesign", "website"])("%s: one CTA, no overclaim", async (pitch) => {
    const text = await prompt(pitch);
    expect(text).toContain('"Book a 15-minute demo"');
    for (const re of BANNED) expect(text).not.toMatch(re);
    // "missed" only ever appears to rule missed-call framing out.
    for (const m of text.matchAll(/missed[- ]call/gi)) expect(text.slice(Math.max(0, m.index! - 40), m.index!)).toMatch(/never/i);
    if (pitch === "receptionist" || pitch === "both") {
      expect(text).toContain("answers calls in the cover they choose");
      expect(text).toContain("once set up and tested, books into a connected Google Calendar or Cal.com calendar");
    }
    if (pitch === "receptionist") expect(text).not.toContain("Generate website");
  });
  test("the guidance constants carry no retired claim", () => {
    for (const g of Object.values(PITCH_GUIDANCE)) for (const re of BANNED) expect(g).not.toMatch(re);
    expect(PITCH_GUIDANCE.receptionist).toContain(RECEPTIONIST_CAPABILITY);
  });
});
