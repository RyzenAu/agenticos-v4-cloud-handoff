// The Agents workspace's memory port against the REAL memory API (synthetic vault and a fake Hindsight): what a bot recalls is the pool's own source-linked
// facts; what a result saves goes through the same screen as every save; with writes off nothing is saved and the reason comes back.
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, setup } from "../memory/testing/harness";
import { memoryPortFrom } from "./memory-port";
import { buildBrief } from "./brief";
import { seedBots } from "./types";

afterEach(cleanup);

describe("the memory port on the real memory API", () => {
  test("a result's outcome is saved once (screened like any save, with the artifact reference), then recalled for the next job with its source", async () => {
    const h = await setup({ writes: true, hindsight: false });
    const port = memoryPortFrom(() => h.api);
    const jobId = "5d1f0c7e-2b4a-4c3d-9e8f-0a1b2c3d4e5f";
    const text = `Research finished "Bondi Dental": Complete report: 4 cited facts from 2 sources. The saved result is artifact:${jobId}.`;
    const saved = await port.remember("usman", { text, title: "Research result: Bondi Dental" });
    expect(saved.ok).toBe(true);
    // The same outcome again is the pool's own duplicate answer, not a second memory.
    const again = await port.remember("usman", { text, title: "Research result: Bondi Dental" });
    expect(again.ok).toBe(true);
    expect(again.message).toMatch(/Already remembered/);
    const recalled = await port.recall("usman", "Bondi Dental report", 5);
    expect(recalled.facts.length).toBeGreaterThan(0);
    expect(recalled.facts[0].text).toContain("Bondi Dental");
    expect(recalled.facts[0].source).toMatch(/^Jarvis memory mem-/);
    const bot = seedBots(1)[0];
    const brief = await buildBrief(bot, "profile Bondi Dental", "usman", port);
    expect(brief.facts.length).toBeGreaterThan(0);
    expect(brief.context).toContain("Jarvis memory mem-");
  });

  test("writes off: nothing is saved, the pool's own words come back, and recall still answers", async () => {
    const h = await setup({ writes: false, hindsight: false });
    const port = memoryPortFrom(() => h.api);
    const r = await port.remember("usman", { text: "Research finished \"x\": a short result.", title: "Research result: x" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("MU_MEMORY_WRITES");
    expect((await port.recall("usman", "anything", 3)).facts).toBeInstanceOf(Array);
  });

  test("a result that is screened out (a secret in it) is refused by the pool, not saved", async () => {
    const h = await setup({ writes: true, hindsight: false });
    const port = memoryPortFrom(() => h.api);
    const r = await port.remember("usman", { text: "Research finished \"x\": the password is hunter2 and the card 4111 1111 1111 1111.", title: "Research result: x" });
    expect(r.ok).toBe(false);
  });
});
