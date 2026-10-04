// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { INSTRUCTIONS_MAX, PURPOSE_MAX, STALE_MESSAGE, createAgentBotsClient, createFakeAgentBots, diffBots, seedBots, validateInstructions, validatePurpose } from "./agent-bots";

type Call = { url: string; init?: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status = 200) => new Response("<!doctype html><html></html>", { status, headers: { "content-type": "text/html" } });

function clientWith(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/__token") return json(200, { token: "tok-1" });
    return respond({ url, init });
  }) as unknown as typeof globalThis.fetch;
  return { client: createAgentBotsClient({ fetch }), calls, bots: () => calls.filter((c) => c.url !== "/__token") };
}
const bot = seedBots()[0]!;

describe("agent-bots client contract", () => {
  test("list and get hit the documented paths and return typed bots", async () => {
    const { client, bots } = clientWith(({ url }) => (url === "/__agents/bots" ? json(200, { bots: [bot] }) : json(200, bot)));
    const l = await client.list();
    const g = await client.get("research");
    expect(bots().map((c) => c.url)).toEqual(["/__agents/bots", "/__agents/bots/research"]);
    expect(l.kind === "ok" && l.bots[0]?.id).toBe("research");
    expect(g.kind === "ok" && g.bot.readiness.state).toBe("ready");
  });

  test("an id is encoded into the path", async () => {
    const { client, bots } = clientWith(() => json(404, { error: "no" }));
    await client.get("a/b c");
    expect(bots()[0]!.url).toBe("/__agents/bots/a%2Fb%20c");
  });

  test("PATCH sends the rev with the changed fields, as JSON, with the page token", async () => {
    const { client, bots } = clientWith(() => json(200, { ...bot, rev: 5 }));
    const r = await client.patch("research", 4, { computer: "builder" });
    const c = bots()[0]!;
    expect(c.url).toBe("/__agents/bots/research");
    expect(c.init?.method).toBe("PATCH");
    expect(JSON.parse(String(c.init?.body))).toEqual({ rev: 4, computer: "builder" });
    expect((c.init?.headers as Record<string, string>)["x-claude-os-token"]).toBe("tok-1");
    expect((c.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(r.kind === "ok" && r.bot.rev).toBe(5);
  });

  test("409 is a stale refusal carrying the server's current bot, never an ok", async () => {
    const { client } = clientWith(() => json(409, { error: "stale", current: { ...bot, rev: 9, computer: null } }));
    const r = await client.patch("research", 1, { purpose: "x" });
    expect(r.kind).toBe("stale");
    if (r.kind === "stale") {
      expect(r.message).toBe(STALE_MESSAGE);
      expect(r.current?.rev).toBe(9);
      expect(r.current?.computer).toBeNull();
    }
  });

  test("409 without a body is still stale (the page reads the bot itself)", async () => {
    const { client } = clientWith(() => json(409, {}));
    const r = await client.patch("research", 1, {});
    expect(r).toMatchObject({ kind: "stale", current: null });
  });

  test("validation, refusal, missing and unreachable are each their own honest outcome", async () => {
    expect(await clientWith(() => json(422, { error: "There is no skill called x.", field: "skills" })).client.patch("r", 1, {})).toEqual({ kind: "invalid", message: "There is no skill called x.", field: "skills" });
    expect((await clientWith(() => json(403, { error: "Only a person can." })).client.patch("r", 1, {})).kind).toBe("refused");
    expect((await clientWith(() => json(404, { error: "gone" })).client.patch("r", 1, {})).kind).toBe("missing");
    expect((await clientWith(() => html(404)).client.patch("r", 1, {})).kind).toBe("unavailable");
    const down = createAgentBotsClient({ fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, token: async () => "t" });
    expect((await down.patch("r", 1, {})).kind).toBe("unavailable");
    expect((await down.list()).kind).toBe("unavailable");
  });

  test("a hub that answers with its HTML shell is 'not there', not 'no bots'", async () => {
    const { client } = clientWith(() => html());
    expect((await client.list()).kind).toBe("unavailable");
    expect((await client.get("research")).kind).toBe("unavailable");
  });

  test("readinessReported says whether the PATCH answer carried readiness", async () => {
    const { readiness: _r, ...bare } = bot;
    expect(await clientWith(() => json(200, bot)).client.patch("research", 1, {})).toMatchObject({ kind: "ok", readinessReported: true });
    expect(await clientWith(() => json(200, bare)).client.patch("research", 1, {})).toMatchObject({ kind: "ok", readinessReported: false });
  });

  test("a body that is not a bot is refused rather than rendered", async () => {
    const { client } = clientWith(() => json(200, { id: 7 }));
    expect((await client.get("research")).kind).toBe("unavailable");
  });
});

describe("validation limits", () => {
  test("purpose is required and capped; instructions may be empty but are capped", () => {
    expect(validatePurpose("  ")).toContain("Say what");
    expect(validatePurpose("x".repeat(PURPOSE_MAX + 1))).toContain(String(PURPOSE_MAX));
    expect(validatePurpose("Reads sources.")).toBeNull();
    expect(validateInstructions("")).toBeNull();
    expect(validateInstructions("x".repeat(INSTRUCTIONS_MAX + 1))).toContain("Instructions can be up to");
  });
});

describe("the fake follows the contract", () => {
  test("a write with the current rev lands and bumps rev; a stale one is refused with the current bot", async () => {
    const fake = createFakeAgentBots();
    const a = await fake.client.patch("research", 1, { purpose: "New purpose." });
    expect(a).toMatchObject({ kind: "ok" });
    fake.editElsewhere("research", { computer: null });
    const b = await fake.client.patch("research", 2, { purpose: "Mine." });
    expect(b.kind).toBe("stale");
    expect(b.kind === "stale" && b.current?.rev).toBe(3);
    expect(fake.snapshot("research")?.purpose).toBe("New purpose.");
  });

  test("unknown computers and routines are refused, and skills and coding.enabled can't be changed, when the server knows its lists", async () => {
    const fake = createFakeAgentBots({ known: { computers: ["research"], routines: [] } });
    expect((await fake.client.patch("research", 1, { computer: "nope" })).kind).toBe("invalid");
    expect((await fake.client.patch("research", 1, { skills: ["seo"] } as never)).kind).toBe("invalid");
    expect((await fake.client.patch("research", 1, { coding: { enabled: true, accountSlot: null, model: null } })).kind).toBe("invalid");
    expect((await fake.client.patch("research", 1, { routines: ["r1"] })).kind).toBe("invalid");
  });

  test("diffBots names only what differs, in words", () => {
    const a = seedBots()[0]!;
    const b = { ...a, computer: null, memory: { recall: false, saveResults: false } };
    expect(diffBots(a, b).map((d) => d.label)).toEqual(["Computer", "Memory"]);
    expect(diffBots(a, a)).toEqual([]);
    const long = "x".repeat(200);
    expect(diffBots({ ...a, instructions: `${long}a` }, { ...a, instructions: `${long}b` }).map((d) => d.field)).toEqual(["instructions"]);
  });
});
