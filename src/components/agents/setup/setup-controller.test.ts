// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { createFakeAgentBots, type AgentBotsClient } from "@/lib/agent-bots";
import { createSetupController } from "./setup-controller";

async function ready(opts: Parameters<typeof createFakeAgentBots>[0] = {}, id = "research") {
  const fake = createFakeAgentBots(opts);
  const c = createSetupController({ botId: id, client: fake.client, now: () => 1000 });
  await c.load();
  return { fake, c };
}
const patches = (fake: ReturnType<typeof createFakeAgentBots>) => fake.calls.filter((x) => x.method === "PATCH");

describe("loading", () => {
  test("a missing bot and an unavailable service are different states with their own words", async () => {
    const fake = createFakeAgentBots();
    const a = createSetupController({ botId: "nope", client: fake.client });
    await a.load();
    expect(a.getState().load).toBe("missing");
    const down: AgentBotsClient = {
      list: async () => ({ kind: "unavailable", message: "x" }),
      get: async () => ({ kind: "unavailable", message: "The Agents service isn't available on this hub." }),
      patch: async () => ({ kind: "unavailable", message: "x" }),
      create: async () => ({ kind: "unavailable", message: "x" }),
      duplicate: async () => ({ kind: "unavailable", message: "x" }),
      archive: async () => ({ kind: "unavailable", message: "x" }),
    };
    const b = createSetupController({ botId: "research", client: down });
    await b.load();
    expect(b.getState()).toMatchObject({ load: "unavailable", loadError: "The Agents service isn't available on this hub." });
  });
});

describe("every write carries rev", () => {
  test("a save sends the rev it was looking at and adopts the answer's new rev", async () => {
    const { fake, c } = await ready();
    expect(await c.save("computer", { computer: "builder" })).toBe(true);
    expect(patches(fake)[0]).toMatchObject({ id: "research", rev: 1, patch: { computer: "builder" } });
    expect(c.getState().bot?.rev).toBe(2);
    expect(c.getState().savedAt.computer).toBe(1000);
    await c.save("routines", { routines: ["seo"] });
    expect(patches(fake).map((x) => x.rev)).toEqual([1, 2]);
  });

  test("only one write is in flight: a second is refused, not queued behind a stale rev", async () => {
    const { fake, c } = await ready({ latencyMs: 15 });
    const first = c.save("computer", { computer: "builder" });
    const second = await c.save("routines", { routines: ["x"] });
    expect(second).toBe(false);
    await first;
    expect(patches(fake)).toHaveLength(1);
  });
});

describe("stale edits are refused honestly", () => {
  test("409 keeps the server's copy aside, leaves the shown bot and the typed text alone, and blocks further writes", async () => {
    const { fake, c } = await ready();
    c.setDraft("instructions", "My new instructions, not saved yet.");
    fake.editElsewhere("research", { computer: null, instructions: "Someone else's." });
    const ok = await c.savePurpose();
    const s = c.getState();
    expect(ok).toBe(false);
    expect(s.conflict?.section).toBe("purpose");
    expect(s.conflict?.current?.computer).toBeNull();
    expect(s.conflict?.current?.rev).toBe(2);
    expect(s.bot?.rev).toBe(1);
    expect(s.bot?.computer).toBe("research");
    expect(s.drafts.instructions).toBe("My new instructions, not saved yet.");
    const sent = patches(fake).length;
    expect(await c.save("memory", { memory: { recall: false, saveResults: false } })).toBe(false);
    expect(patches(fake)).toHaveLength(sent);
    expect(fake.snapshot("research")?.instructions).toBe("Someone else's.");
  });

  test("reload adopts the latest and its rev, keeps the typed text, and a deliberate Save then lands", async () => {
    const { fake, c } = await ready();
    c.setDraft("purpose", "My purpose.");
    fake.editElsewhere("research", { purpose: "Their purpose." });
    await c.savePurpose();
    expect(c.getState().conflict).not.toBeNull();
    await c.reload();
    const s = c.getState();
    expect(s.conflict).toBeNull();
    expect(s.bot?.purpose).toBe("Their purpose.");
    expect(s.bot?.rev).toBe(2);
    expect(s.drafts.purpose).toBe("My purpose.");
    expect(await c.savePurpose()).toBe(true);
    expect(fake.snapshot("research")?.purpose).toBe("My purpose.");
    expect(patches(fake).at(-1)?.rev).toBe(2);
  });

  test("a stale answer with no current bot makes the page read it for the notice", async () => {
    const fake = createFakeAgentBots();
    const client: AgentBotsClient = { ...fake.client, patch: async () => ({ kind: "stale", current: null, message: "x" }) };
    const c = createSetupController({ botId: "research", client });
    await c.load();
    fake.editElsewhere("research", { computer: null });
    await c.save("computer", { computer: "builder" });
    expect(c.getState().conflict?.current?.computer).toBeNull();
  });

  test("a text draft that equals the reloaded copy is no longer unsaved", async () => {
    const { fake, c } = await ready();
    c.setDraft("purpose", "Same text.");
    fake.editElsewhere("research", { purpose: "Same text." });
    await c.savePurpose();
    await c.reload();
    expect(c.getState().drafts.purpose).toBeUndefined();
  });
});

describe("errors keep the form intact", () => {
  test("a dropped connection leaves the drafts and the shown bot, says so, and the same Save can be retried", async () => {
    const { fake, c } = await ready();
    c.setDraft("purpose", "Edited purpose.");
    fake.failNextWrite();
    expect(await c.savePurpose()).toBe(false);
    expect(c.getState().errors.purpose).toContain("couldn't be reached");
    expect(c.getState().drafts.purpose).toBe("Edited purpose.");
    expect(c.getState().saving).toBeNull();
    expect(await c.savePurpose()).toBe(true);
    expect(c.getState().errors.purpose).toBeUndefined();
  });

  test("a server validation refusal is shown on its section and changes nothing", async () => {
    const { c } = await ready({ known: { computers: ["research"] } });
    expect(await c.save("computer", { computer: "ghost" })).toBe(false);
    expect(c.getState().errors.computer).toContain("ghost");
    expect(c.getState().bot?.computer).toBe("research");
  });

  test("invalid text is refused before anything is sent", async () => {
    const { fake, c } = await ready();
    c.setDraft("purpose", "   ");
    expect(await c.savePurpose()).toBe(false);
    expect(c.getState().errors.purpose).toContain("Say what");
    expect(patches(fake)).toHaveLength(0);
  });

  test("Save with no change sends nothing", async () => {
    const { fake, c } = await ready();
    expect(await c.savePurpose()).toBe(false);
    c.setDraft("purpose", c.getState().bot!.purpose);
    expect(c.getState().drafts).toEqual({});
    expect(await c.savePurpose()).toBe(false);
    expect(patches(fake)).toHaveLength(0);
  });

  test("editing text clears the section's Saved receipt", async () => {
    const { c } = await ready();
    c.setDraft("purpose", "One.");
    await c.savePurpose();
    expect(c.getState().savedAt.purpose).toBe(1000);
    c.setDraft("purpose", "Two.");
    expect(c.getState().savedAt.purpose).toBeUndefined();
  });
});

describe("readiness refreshes after a save", () => {
  test("the answer's readiness is shown at once", async () => {
    const { c } = await ready({}, "builder");
    expect(c.getState().bot?.readiness.state).toBe("needs-you");
    await c.save("model", { coding: { enabled: true, accountSlot: "codex:a", model: null } });
    expect(c.getState().bot?.readiness).toEqual({ state: "ready", reasons: [] });
  });

  test("when the PATCH answer carries none, the bot is read again for it and its reasons change", async () => {
    const { fake, c } = await ready({ patchReturnsReadiness: false }, "research");
    expect(c.getState().bot?.readiness.state).toBe("ready");
    await c.save("computer", { computer: null });
    const s = c.getState();
    expect(fake.calls.filter((x) => x.method === "GET").length).toBeGreaterThanOrEqual(2);
    expect(s.bot?.readiness.state).toBe("unconfigured");
    expect(s.bot?.readiness.reasons[0]?.text).toContain("No computer is assigned");
    expect(s.readinessStale).toBe(false);
  });

  test("if the re-read fails the last readiness stays and is flagged as not refreshed", async () => {
    const fake = createFakeAgentBots({ patchReturnsReadiness: false });
    let reads = 0;
    const client: AgentBotsClient = { ...fake.client, get: async (id) => (++reads > 1 ? { kind: "unavailable", message: "x" } : fake.client.get(id)) };
    const c = createSetupController({ botId: "research", client });
    await c.load();
    await c.save("computer", { computer: null });
    expect(c.getState().readinessStale).toBe(true);
  });

  test("a re-read never hides a conflict: it adopts readiness only, not the other editor's fields", async () => {
    const fake = createFakeAgentBots({ patchReturnsReadiness: false });
    const c = createSetupController({ botId: "research", client: fake.client });
    await c.load();
    const origGet = fake.client.get;
    fake.client.get = async (id) => {
      fake.editElsewhere("research", { purpose: "Elsewhere." });
      return origGet(id);
    };
    await c.save("computer", { computer: null });
    expect(c.getState().bot?.purpose).not.toBe("Elsewhere.");
    expect(c.getState().readinessStale).toBe(true);
  });
});
