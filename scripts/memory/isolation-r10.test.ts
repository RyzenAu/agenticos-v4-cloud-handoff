// Round 10 (owner requirement): a research step on a SYNTHETIC hub recalled facts from the owner's real vault, with memory writes and Hindsight off.
//   1. memory off means no READS: recall returns nothing from the vault, the local index or Hindsight, and says so;
//   2. a synthetic hub never reads a vault (or an index) outside its own data folder, whatever MU_WIKI_ROOT or the home default says: refused loudly.
// Each check FAILS on the code before round 10. Synthetic temp vaults only (the harness's fixture); the real vault is never touched or read.
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBrief, type MemoryPort } from "../agents/brief";
import { memoryPortFrom } from "../agents/memory-port";
import { resolveMemorySettings } from "./settings";
import { guardVaultRoot } from "./synthetic-guard";
import { cleanup, setup, usman } from "./testing/harness";

afterEach(async () => {
  await cleanup();
});
const T = { timeout: 30_000 };
const HOME_VAULT = join(homedir(), "source", "repos", "mu-ventures-obsidian-wiki");

describe("a synthetic hub never reads a vault outside its own data folder", () => {
  test("no MU_WIKI_ROOT: the synthetic vault inside the data folder, never the home default; an outside MU_WIKI_ROOT or index is refused loudly", () => {
    const data = join("D:", "AgenticOS-r9-data", "iso-test", "hub");
    const lines: string[] = [];
    const s = resolveMemorySettings({ MU_SYNTHETIC_HUB: "1", MU_DATA_DIR: data, MU_MEMORY_WRITES: "off" }, "C:/app");
    expect(s.vaultRoot).toBe(join(data, "synthetic-vault"));
    expect(s.vaultRoot.toLowerCase()).not.toBe(HOME_VAULT.toLowerCase());
    const outside = guardVaultRoot("C:/Users/someone/real-vault", { MU_SYNTHETIC_HUB: "1", MU_DATA_DIR: data }, "C:/app", (l) => lines.push(l));
    expect(outside).toEqual({ root: join(data, "synthetic-vault"), synthetic: true, refused: expect.stringContaining("was refused") });
    expect(lines[0]).toMatch(/^\[memory\] REFUSED: /);
    const idx = resolveMemorySettings({ MU_SYNTHETIC_HUB: "1", MU_DATA_DIR: data, MEMORY_STATE_DIR: "C:/Users/someone/state" }, "C:/app");
    expect(idx.stateDir).toBe(join(data, "memory"));
    // A real hub is unchanged.
    expect(resolveMemorySettings({ MU_MEMORY_WRITES: "on" }, "C:/app").vaultRoot).toBe(HOME_VAULT);
  });

  test(
    "through the memory API: a synthetic hub pointed at a vault outside its data folder recalls nothing from it (the same vault answers on a real hub)",
    async () => {
      const h = await setup({ writes: false });
      // Control: the fixture vault (standing in for the owner's) answers on an ordinary hub.
      await h.api.sync({ force: true });
      expect((await h.api.recall(usman, "Osprey proposals valid")).facts.map((f) => f.id)).toContain("n-proposal-terms");
      // The same environment on a synthetic hub whose data folder is elsewhere: the vault is refused, nothing of it is read.
      const api = h.make({ MU_SYNTHETIC_HUB: "1", MU_DATA_DIR: join(h.base, "synthetic-data") });
      await api.sync({ force: true }).catch(() => undefined);
      const r = await api.recall(usman, "Osprey proposals valid");
      expect(r.facts).toEqual([]);
    },
    T,
  );
});

describe("memory off means no reads", () => {
  test(
    "MU_MEMORY_WRITES=off: recall reads nothing (no vault, no index, no Hindsight call) and says memory is off; 'read' still recalls",
    async () => {
      const h = await setup({ writes: true });
      await h.api.sync({ force: true });
      const read = h.make({ MU_MEMORY_WRITES: "read" });
      expect((await read.recall(usman, "Osprey proposals valid")).facts.length).toBeGreaterThan(0);
      const calls = h.fake.calls.length;
      const off = h.make({ MU_MEMORY_WRITES: "off" });
      const r = await off.recall(usman, "Osprey proposals valid");
      expect(r.facts).toEqual([]);
      expect(r.off).toMatch(/memory is off/);
      expect(h.fake.calls.length).toBe(calls);
    },
    T,
  );

  test("the bot's job step says 'memory off: no recall', and no fact reaches the prompt", async () => {
    const port = memoryPortFrom(() => ({ recall: async () => ({ ok: true, query: "q", facts: [], facts_used: [], spoken: "", hindsight: "disabled", suppressed: 0, off: "memory is off (MU_MEMORY_WRITES=off): no recall from the vault, the local index or Hindsight" }) as never, remember: async () => ({ ok: false }) as never }));
    const bot = { name: "Research", instructions: "", memory: { recall: true, saveResults: false } } as never;
    const b = await buildBrief(bot, "research Acme", "usman", port);
    expect(b.facts).toEqual([]);
    expect(b.notes).toEqual(["memory off: no recall (memory is off (MU_MEMORY_WRITES=off): no recall from the vault, the local index or Hindsight)."]);
    expect(b.context).toBe("");
    // A port that would answer with facts is never consulted for them when it says off.
    const lying: MemoryPort = { recall: async () => ({ facts: [{ text: "x", source: "vault note wiki/x.md" }], note: null, off: "off" }), remember: async () => ({ ok: true, message: "" }) };
    expect((await buildBrief(bot, "q", "usman", lying)).facts).toEqual([]);
  });
});
