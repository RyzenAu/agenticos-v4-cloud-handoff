// Track 8 (UI truth): memory replies say what really happened (audit F2 MEM-3, MEM-4, MEM-6, MEM-11).
// TEMP copies of the synthetic mini-wiki and the FAKE Hindsight only; storage semantics are unchanged.
import { afterEach, describe, expect, test } from "bun:test";
import { deriveTitle, TITLE_MAX } from "./api";
import { cleanup, setup, usman } from "./testing/harness";

afterEach(cleanup);

describe("MEM-3: replies are worded from the real Hindsight state", () => {
  test("Hindsight off: remember, correct and delete never claim Hindsight did anything", async () => {
    const h = await setup({ hindsight: false });
    await h.api.sync({ force: true });
    const m = await h.api.remember(usman, { text: "The synthetic Kea clinic review call is on Thursday at 10am.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    expect(m.message).toContain("Hindsight is off");
    expect(m.message).not.toContain("Remembered in Hindsight");
    expect(m.message).toBe(`Remembered as ${m.memory.id} ("The synthetic Kea clinic review call is on Thursday at 10am"): only in this app's local index (Hindsight is off). Not written to the vault.`);

    const c = await h.api.correct(usman, m.memory.id, { text: "The synthetic Kea clinic review call is on Friday at 10am.", channel: "voice" });
    if (!c.ok) throw new Error(c.message);
    expect(c.message).not.toMatch(/retract(ed|ion) from Hindsight/);
    // The old broken sentence was "The new version is Hindsight is off, so only the local index has it."
    expect(c.message).not.toContain("is Hindsight is off");
    expect(c.message).toContain("The new version is only in this app's local index (Hindsight is off).");
    expect(c.message).toContain("Hindsight is off, so nothing was sent there");

    const ask = await h.api.forget(usman, { kind: "memory", target: c.id });
    if (ask.ok || !ask.approval) throw new Error("expected an approval request");
    // Track 6: a UI grant needs the card nonce the Memory page rendered, and runs the forget itself.
    const g = await h.approveUi(h.api, ask.approval.id, usman);
    if (!g.ok) throw new Error("grant refused");
    const f = g.result as any;
    if (!f.ok) throw new Error(f.message);
    expect(f.hindsight).toBe("disabled");
    expect(f.message).not.toMatch(/deleted from Hindsight|queued for deletion/);
    expect(f.message).toContain("Hindsight is off here, so nothing of it was stored there");
  });

  test("Hindsight on: the same replies still say indexed / retracted / deleted in Hindsight", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    const m = await h.api.remember(usman, { text: "The synthetic Robin clinic opens at 7am.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    expect(m.message).toContain(": indexed in Hindsight. Not written to the vault.");
    const c = await h.api.correct(usman, m.memory.id, { text: "The synthetic Robin clinic opens at 7:30am.", channel: "voice" });
    if (!c.ok) throw new Error(c.message);
    expect(c.message).toContain("retracted from Hindsight");
    expect(c.message).toContain("The new version is indexed in Hindsight.");
    const v = await h.api.saveToVault(usman, { text: "The synthetic Osprey account renews in March." });
    if (!v.ok) throw new Error(v.message);
    expect(v.message).toMatch(/\. It is indexed in Hindsight\.$/);
  });
});

describe("MEM-4: titles keep the key fact", () => {
  test("a short first sentence is kept whole; a long one is cut on a word boundary with an ellipsis", () => {
    expect(deriveTitle("The Harbourview Dental review call is on Thursday at 10am. Bring the pack.")).toBe("The Harbourview Dental review call is on Thursday at 10am");
    const long = deriveTitle(
      "the synthetic Harbourview Dental practice wants every reminder text sent at exactly eight in the morning on the day before each appointment",
    );
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(TITLE_MAX + 1);
    expect(long.startsWith("The synthetic Harbourview")).toBe(true);
    // Cut between words, never inside one.
    expect("the synthetic Harbourview Dental practice wants every reminder text sent at exactly eight in the morning".split(" ")).toContain(long.slice(0, -1).split(" ").pop());
  });

  test("correcting a memory titled by the old nine-word rule re-derives the title from the new text", async () => {
    const h = await setup({ hindsight: false });
    const m = await h.api.remember(usman, { text: "The synthetic Kea clinic review call is on Thursday at 10am.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    // Simulate a record saved before MEM-4 (title = first nine words).
    const store = h.api.connector.store;
    store.writeMemories(store.readMemories().map((r) => (r.id === m.memory.id ? { ...r, title: "The synthetic Kea clinic review call is on Thursday" } : r)));
    const c = await h.api.correct(usman, m.memory.id, { text: "The synthetic Kea clinic review call is on Friday at 11am.", channel: "voice" });
    if (!c.ok) throw new Error(c.message);
    expect(h.api.item(c.id)?.row.title).toBe("The synthetic Kea clinic review call is on Friday at 11am");
  });
});

describe("MEM-6: an unscanned index is not an empty one", () => {
  test("before the first scan recall says the index isn't built; after it, 'nothing saved' is a real answer", async () => {
    const h = await setup({ writes: false, hindsight: false });
    const before = await h.api.recall(usman, "zebra quokka xylophone");
    expect(before.index_built).toBe(false);
    expect(before.spoken).toContain("isn't built yet");
    expect(before.spoken).not.toContain("I don't have anything saved about that");
    await h.api.sync({ force: true });
    const after = await h.api.recall(usman, "zebra quokka xylophone");
    expect(after.index_built).toBe(true);
    expect(after.spoken).toBe("I don't have anything saved about that.");
  });
});

describe("MEM-11: removing from the index says how to undo it", () => {
  test("the unindex reply names the note and the way back", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    const r = await h.api.forget(usman, { kind: "unindex", target: "n-proposal-terms" });
    if (!r.ok) throw new Error(r.message);
    expect(r.message).toContain("Re-include in index");
    expect(h.api.item("n-proposal-terms")?.row.status).toBe("excluded");
  });
});
