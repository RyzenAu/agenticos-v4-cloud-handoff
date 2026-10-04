// The bot store and what PATCH may change: seeded once, atomic, honest about concurrent edits, and every field checked against the service it
// points at (fake services here; the real wiring is exercised in routes.test.ts and the throwaway-hub run).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotsFileUnreadable, createBotStore } from "./store";
import { LIMITS, parsePatch, type ValidationDeps } from "./validate";
import { seedBots, type Bot } from "./types";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agents-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const deps: ValidationDeps = {
  computerExists: (n) => ["research", "builder", "spare"].includes(n),
  accountSlots: () => ["claude:max", "claude:max-2", "codex:openai-2"],
  modelsFor: (slot) => (slot.startsWith("claude:") ? ["claude-opus-5-5", "claude-sonnet-5-5"] : slot.startsWith("codex:") ? ["gpt-6-astra"] : []),
  allModels: () => ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra"],
  routerModels: () => ["groq/llama-3.3-70b", "openrouter/deepseek-v4-pro"],
  routineIds: () => ["trig-morning-brief"],
};
const builder = (): Bot => seedBots(1)[1];

describe("the bot store", () => {
  test("seeded once with Research (coding off) and Builder (coding on), each pointing at its own computer", () => {
    const file = join(tmp(), "agents", "bots.json");
    const store = createBotStore({ file, now: () => 1000 });
    const bots = store.list();
    expect(bots.map((b) => b.id)).toEqual(["research", "builder"]);
    expect(bots[0]).toMatchObject({ computer: "research", coding: { enabled: false, accountSlot: null, model: null }, rev: 1, createdAt: 1000 });
    expect(bots[1]).toMatchObject({ computer: "builder", coding: { enabled: true, accountSlot: null, model: null }, rev: 1 });
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(join(file, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("not seeded again: an edit survives a reopen, and a bot missing from the file is not re-created", () => {
    const file = join(tmp(), "agents", "bots.json");
    const a = createBotStore({ file });
    expect(a.patch("research", 1, (b) => ({ ...b, name: "Scout" })).ok).toBe(true);
    const b = createBotStore({ file });
    expect(b.get("research")?.name).toBe("Scout");
    expect(b.get("research")?.rev).toBe(2);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.bots = raw.bots.filter((x: Bot) => x.id !== "builder");
    writeFileSync(file, JSON.stringify(raw));
    expect(createBotStore({ file }).list().map((x) => x.id)).toEqual(["research"]);
  });

  test("rev: a stale edit writes nothing and returns the stored bot (409); a fresh one bumps rev and updatedAt but never id or createdAt", () => {
    let t = 1000;
    const store = createBotStore({ file: join(tmp(), "bots.json"), now: () => (t += 10) });
    const first = store.patch("builder", 1, (b) => ({ ...b, purpose: "one" }));
    expect(first.ok && first.bot.rev).toBe(2);
    const stale = store.patch("builder", 1, (b) => ({ ...b, purpose: "two" }));
    expect(stale).toMatchObject({ ok: false, status: 409 });
    expect(stale.ok === false && stale.bot?.purpose).toBe("one");
    expect(store.get("builder")?.purpose).toBe("one");
    const sneaky = store.patch("builder", 2, (b) => ({ ...b, id: "other", createdAt: 5, rev: 99 }));
    expect(sneaky.ok && [sneaky.bot.id, sneaky.bot.createdAt, sneaky.bot.rev]).toEqual(["builder", store.get("builder")!.createdAt, 3]);
    expect(store.patch("nobody", 1, (b) => b)).toMatchObject({ ok: false, status: 404 });
  });

  test("an unreadable file is refused and left exactly as it was (never replaced by the seed)", () => {
    const file = join(tmp(), "bots.json");
    writeFileSync(file, "{ not json");
    const store = createBotStore({ file });
    expect(() => store.list()).toThrow(BotsFileUnreadable);
    expect(() => store.patch("research", 1, (b) => b)).toThrow(BotsFileUnreadable);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("PATCH validation against the services a bot points at", () => {
  const ok = (body: unknown, current = builder()) => {
    const r = parsePatch(body, deps, current);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.apply(structuredClone(current));
  };
  const errors = (body: unknown, current = builder()) => {
    const r = parsePatch(body, deps, current);
    return r.ok ? [] : r.errors;
  };

  test("a good edit applies; rev is required, and so is at least one field", () => {
    expect(ok({ rev: 1, name: " Forge ", purpose: "Builds.", instructions: "" }).name).toBe("Forge");
    expect(errors({ name: "x" }).map((e) => e.field)).toContain("rev");
    expect(errors({ rev: 1 }).map((e) => e.field)).toEqual(["body"]);
    expect(errors("nope")[0].field).toBe("body");
    expect(errors({ rev: 1, id: "other" })[0].field).toBe("id");
  });

  test("limits: purpose is required and 300 characters at most, instructions 8,000, with a field-specific message", () => {
    expect(errors({ rev: 1, purpose: "" })).toEqual([{ field: "purpose", message: "purpose can't be empty." }]);
    expect(errors({ rev: 1, purpose: "x".repeat(LIMITS.purpose + 1) })[0]).toMatchObject({ field: "purpose" });
    expect(errors({ rev: 1, purpose: "x".repeat(LIMITS.purpose) })).toEqual([]);
    expect(errors({ rev: 1, instructions: "y".repeat(8001) })[0].message).toContain("8,000");
    expect(errors({ rev: 1, instructions: "y".repeat(8000) })).toEqual([]);
    expect(errors({ rev: 1, name: "" })[0].field).toBe("name");
  });

  test("computer: must exist in the computers store, or be null", () => {
    expect(ok({ rev: 1, computer: "spare" }).computer).toBe("spare");
    expect(ok({ rev: 1, computer: null }).computer).toBeNull();
    expect(errors({ rev: 1, computer: "ghost" })[0]).toMatchObject({ field: "computer" });
    expect(errors({ rev: 1, computer: "Bad Name" })[0].field).toBe("computer");
  });

  test("coding is replaced as a WHOLE object; the account slot and model must exist; `enabled` can't be changed from here", () => {
    const next = ok({ rev: 1, coding: { enabled: true, accountSlot: "claude:max-2", model: "claude-sonnet-5-5" } });
    expect(next.coding).toEqual({ enabled: true, accountSlot: "claude:max-2", model: "claude-sonnet-5-5" });
    expect(ok({ rev: 1, coding: { enabled: true, accountSlot: null, model: null } }).coding.accountSlot).toBeNull();
    expect(errors({ rev: 1, coding: { accountSlot: "claude:max-2" } }).map((e) => e.field)).toEqual(["coding.enabled", "coding.model"]);
    expect(errors({ rev: 1, coding: { enabled: true, accountSlot: "claude:max-7", model: null } })[0]).toMatchObject({ field: "coding.accountSlot" });
    expect(errors({ rev: 1, coding: { enabled: true, accountSlot: "claude:max", model: "gpt-6-astra" } })[0]).toMatchObject({ field: "coding.model" });
    expect(errors({ rev: 1, coding: { enabled: true, accountSlot: null, model: "claude-opus-5-5" } })).toEqual([]);
    expect(errors({ rev: 1, coding: { enabled: true, accountSlot: null, model: "mystery" } })[0]).toMatchObject({ field: "coding.model" });
    // enabled: Builder true, Research false, fixed when seeded.
    expect(errors({ rev: 1, coding: { enabled: false, accountSlot: null, model: null } })[0]).toMatchObject({ field: "coding.enabled" });
    const research = seedBots(1)[0];
    expect(errors({ rev: 1, coding: { enabled: true, accountSlot: null, model: null } }, research)[0]).toMatchObject({ field: "coding.enabled" });
    expect(errors({ rev: 1, coding: { enabled: false, accountSlot: null, model: null } }, research)).toEqual([]);
  });

  test("modelPreference.route: auto, free-only, or a router CATALOGUE MODEL id, as a whole object", () => {
    expect(ok({ rev: 1, modelPreference: { route: "free-only" } }).modelPreference).toEqual({ route: "free-only" });
    expect(ok({ rev: 1, modelPreference: { route: "groq/llama-3.3-70b" } }).modelPreference.route).toBe("groq/llama-3.3-70b");
    expect(errors({ rev: 1, modelPreference: { route: "research.web" } })[0]).toMatchObject({ field: "modelPreference.route" });
    expect(errors({ rev: 1, modelPreference: { route: "auto", extra: 1 } })[0].field).toBe("modelPreference");
    expect(errors({ rev: 1, modelPreference: "auto" })[0].field).toBe("modelPreference");
  });

  test("routines must exist; skills are read-only (a 400 whatever is sent); memory is a whole object of two booleans", () => {
    expect(ok({ rev: 1, routines: ["trig-morning-brief", "trig-morning-brief"] }).routines).toEqual(["trig-morning-brief"]);
    expect(errors({ rev: 1, routines: ["nope"] })[0].field).toBe("routines");
    for (const skills of [["dream"], [], "dream", null]) expect(errors({ rev: 1, skills })[0]).toMatchObject({ field: "skills", message: expect.stringContaining("skills are not configurable yet") });
    expect(ok({ rev: 1, memory: { recall: false, saveResults: true } }).memory).toEqual({ recall: false, saveResults: true });
    expect(errors({ rev: 1, memory: { recall: false } })[0].field).toBe("memory.saveResults");
    expect(errors({ rev: 1, memory: { recall: 1, saveResults: true } })[0].field).toBe("memory.recall");
  });

  test("several problems are all reported, none applied", () => {
    const e = errors({ rev: 1, computer: "ghost", routines: ["nope"], purpose: "" });
    expect(e.map((x) => x.field).sort()).toEqual(["computer", "purpose", "routines"]);
  });
});

describe("H-02: an edit is recorded in the bot's history", () => {
  test("who, when and the NAMES of the fields changed (never the instruction text); an edit that changes nothing records nothing; the log stays capped", () => {
    let t = 1000;
    const store = createBotStore({ file: join(tmp(), "agents", "bots.json"), now: () => t });
    const r = store.get("research")!;
    t = 2000;
    const out = store.patch("research", r.rev, (b) => ({ ...b, instructions: "SECRET INSTRUCTION TEXT", purpose: "New purpose", memory: { ...b.memory, saveResults: false } }), "mehroz");
    expect(out.ok).toBe(true);
    const bot = store.get("research")!;
    expect(bot.history!.at(-1)).toEqual({ at: 2000, by: "mehroz", action: "edited", note: "purpose, instructions, memory" });
    expect(JSON.stringify(bot.history)).not.toContain("SECRET");
    const same = store.patch("research", bot.rev, (b) => b, "mehroz");
    expect(same.ok).toBe(true);
    expect(store.get("research")!.history).toHaveLength(bot.history!.length);
    for (let i = 0; i < 40; i++) store.patch("research", store.get("research")!.rev, (b) => ({ ...b, purpose: `p${i}` }), "usman");
    expect(store.get("research")!.history!.length).toBeLessThanOrEqual(30);
  });

  test("the history entry survives next to created/archived records", () => {
    const store = createBotStore({ file: join(tmp(), "agents", "bots.json"), now: () => 5 });
    const b = store.get("builder")!;
    store.patch("builder", b.rev, (x) => ({ ...x, name: "Builder 2" }), "usman");
    expect(store.get("builder")!.history!.map((h) => h.action)).toEqual(["edited"]);
  });
});
