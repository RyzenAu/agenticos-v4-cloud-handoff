// J3 (Jarvis audit, "Telling it things"): "remember that" alone asks what; "what did I tell you about X" and "read
// my notes" search the screened memory AND the notes file (read-only) and name where each result came from.
// TEMP synthetic vault + FAKE Hindsight; the notes file lives in another temp folder. Nothing live is touched.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotes, createNotesReader, noteLine } from "../jarvis-skills/notes";
import { cleanup, setup, snapshot, usman } from "./testing/harness";
import { handleMemoryUtterance, parseMemoryIntent } from "./voice-intents";
import { createMemoryVoiceTurn } from "./voice-turn";

const dirs: string[] = [];
afterEach(async () => {
  await cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const T = { timeout: 30_000 };
const NOW = Date.now();
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "j3-notes-"));
  dirs.push(d);
  return d;
};
/** A notes vault (a temp folder, never the real one) with these lines already in Inbox/Jarvis notes.md. */
function notesVault(texts: string[]) {
  const vault = temp();
  mkdirSync(join(vault, "Inbox"), { recursive: true });
  const file = join(vault, "Inbox", "Jarvis notes.md");
  writeFileSync(file, `# Jarvis notes\n\n${texts.map((t) => noteLine(t, NOW)).join("\n")}\n`);
  return { vault, file, reader: createNotesReader({ vault: () => vault }) };
}

describe("remember that, on its own", () => {
  test("parses as 'remember what', never as the fact 'That'", () => {
    for (const u of ["remember that", "Remember that.", "remember this", "hey Jarvis, remember that", "make a note that", "please remember it"])
      expect([u, parseMemoryIntent(u)]).toEqual([u, { intent: "remember-what" }]);
    expect(parseMemoryIntent("remember that Brooke prefers email")).toEqual({ intent: "remember", text: "Brooke prefers email." });
    expect(parseMemoryIntent("remember that this is the one thing")).toMatchObject({ intent: "remember" });
  });
  test(
    "Jarvis asks 'Remember what?' and stores nothing",
    async () => {
      const h = await setup({ proxy: true });
      const before = snapshot(h.vault);
      const r = await handleMemoryUtterance(h.api, usman, "remember that", {}, { channel: "voice" });
      expect(r.handled).toBe(true);
      expect(r.spoken).toBe("Remember what?");
      expect(r.outcome).not.toBe("remembered");
      expect(h.api.list({ kind: "memory" })).toHaveLength(0);
      expect(snapshot(h.vault)).toEqual(before);
    },
    T,
  );
});

describe("recall phrasings", () => {
  test("what did I tell you / say about, do you remember, remind me what we said", () => {
    const cases: [string, string][] = [
      ["what did I tell you about Bianca", "Bianca"],
      ["What did I say about the dental demo?", "the dental demo"],
      ["do you remember anything about Bianca", "Bianca"],
      ["what do you remember about Bianca", "Bianca"],
      ["remind me what we said about Bianca", "Bianca"],
      ["hey Jarvis, what did I tell you about the receptionist", "the receptionist"],
      ["what did we say about the premium price", "the premium price"],
    ];
    for (const [u, query] of cases) expect([u, parseMemoryIntent(u)]).toEqual([u, { intent: "recall", query }]);
    for (const u of ["do you remember to lock the door", "remind me to call Bianca", "remind me at 5 to call Bianca", "what did the receptionist say"])
      expect([u, parseMemoryIntent(u)]).toEqual([u, null]);
  });
});

describe("recall searches the memory and the notes file, and names each source", () => {
  test(
    "both have something: each is named",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      const { reader } = notesVault(["Bianca wants a darker hero image", "buy milk"]);
      const said = await handleMemoryUtterance(h.api, usman, "remember that Bianca prefers email over calls", {}, { channel: "voice", notes: reader });
      expect(said.outcome).toBe("remembered");
      const r = await handleMemoryUtterance(h.api, usman, "what did I tell you about Bianca", {}, { channel: "voice", notes: reader });
      expect(r.outcome).toBe("recalled");
      expect(r.spoken).toContain("Bianca prefers email over calls");
      expect(r.spoken).toMatch(/from the (Jarvis memory|Hindsight memory)/i);
      expect(r.spoken).toContain("From your Jarvis notes in the vault: today, Bianca wants a darker hero image");
      expect(r.spoken).not.toContain("buy milk");
      expect(r.facts_used).toHaveLength(1);
    },
    T,
  );
  test(
    "only the notes file has it: memory says nothing, the notes answer, and where from",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      const { reader } = notesVault(["Zanzibar rollout needs a go-live date"]);
      const r = await handleMemoryUtterance(h.api, usman, "what did I say about Zanzibar", {}, { channel: "voice", notes: reader });
      expect(r.outcome).toBe("recalled");
      expect(r.spoken).toBe("Nothing about that in memory. From your Jarvis notes in the vault: today, Zanzibar rollout needs a go-live date");
    },
    T,
  );
  test(
    "neither has it: says so for both; without a notes file the old answer is unchanged",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      const { reader } = notesVault(["buy milk"]);
      const none = await handleMemoryUtterance(h.api, usman, "what did I tell you about Zanzibar", {}, { channel: "voice", notes: reader });
      expect(none.outcome).toBe("not-found");
      expect(none.spoken).toContain("Nothing in your Jarvis notes in the vault either.");
      const plain = await handleMemoryUtterance(h.api, usman, "what did I tell you about Zanzibar", {}, { channel: "voice" });
      expect(plain.spoken).not.toContain("Jarvis notes");
    },
    T,
  );
  test(
    "read my notes: the notes file and the memory, each named; only when the notes file is wired in",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      const { reader } = notesVault(["call the dentist", "Bianca wants a darker hero image"]);
      await handleMemoryUtterance(h.api, usman, "remember that the synthetic Heron clinic parks behind gate C", {}, { channel: "voice" });
      const r = await handleMemoryUtterance(h.api, usman, "read my notes", {}, { channel: "voice", notes: reader });
      expect(r.outcome).toBe("recalled");
      expect(r.spoken).toContain("From your Jarvis notes in the vault:");
      expect(r.spoken).toContain("Bianca wants a darker hero image");
      expect(r.spoken).toContain("From Hindsight memory:");
      expect(r.spoken).toContain("Heron clinic parks behind gate C");
      expect(r.facts_used).toHaveLength(1);
      // No notes file wired in (the typed Memory page box): not handled here, so the notes skill answers it as before.
      const skipped = await handleMemoryUtterance(h.api, usman, "read my notes", {}, { channel: "voice" });
      expect(skipped.handled).toBe(false);
    },
    T,
  );
  test(
    "recall and reading are read-only: the notes file and the memory store are byte-for-byte unchanged",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      const { reader, file } = notesVault(["Bianca wants a darker hero image"]);
      const notesBefore = readFileSync(file, "utf8");
      const vaultBefore = snapshot(h.vault);
      for (const u of ["what did I tell you about Bianca", "read my notes", "do you remember anything about Bianca", "remind me what we said about Bianca"])
        await handleMemoryUtterance(h.api, usman, u, {}, { channel: "voice", notes: reader });
      expect(readFileSync(file, "utf8")).toBe(notesBefore);
      expect(snapshot(h.vault)).toEqual(vaultBefore);
      expect(h.api.list({ kind: "memory" })).toHaveLength(0);
    },
    T,
  );
  test(
    "the voice turn wires it: a note added by the notes lane is recallable by 'what did I tell you about X'",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      const vault = temp();
      const notes = createNotes({ vault: () => vault, now: () => NOW });
      const turn = createMemoryVoiceTurn({ api: () => h.api, spoken: h.spoken, notes: createNotesReader({ vault: () => vault }) });
      expect(notes.handle({ skill: "notes", action: "add", text: "the receptionist needs a go-live date" })).toBe("Added to your Jarvis notes in the vault.");
      const r = await turn(usman, "what did I tell you about the receptionist");
      expect(r?.outcome).toBe("recalled");
      expect(r?.content).toContain("From your Jarvis notes in the vault: today, the receptionist needs a go-live date");
      // A secret can never be in that file through the notes lane, so it can never be recalled either.
      expect(notes.handle({ skill: "notes", action: "add", text: "the router login is admin slash Sunflower99" })).toContain("password, key or token");
      const q = await turn(usman, "what did I tell you about the router login");
      expect(q?.content ?? "").not.toContain("Sunflower99");
      expect(await turn(usman, "remember that")).toMatchObject({ content: "Remember what?" });
    },
    T,
  );
});
