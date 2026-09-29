import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotes, createNotesReader, hermesVaultPath, lastNotes, noteLine, noteRefusal, NOTED, notesIntent, spokenNoteDay } from "./notes";
import { screenFact } from "../memory/guard";

const NOW = Date.UTC(2026, 8, 24, 5, 42); // 3:42 pm Sydney
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-notes-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("note phrases", () => {
  test("adding keeps his casing; reading", () => {
    expect(notesIntent("note: call the bank about the fee")).toEqual({ skill: "notes", action: "add", text: "call the bank about the fee" });
    expect(notesIntent("Jarvis, take a note: Brooke prefers Tuesdays.")).toEqual({ skill: "notes", action: "add", text: "Brooke prefers Tuesdays." });
    expect(notesIntent("add to my notes send Mehroz the Aldergate deck")).toMatchObject({ text: "send Mehroz the Aldergate deck" });
    expect(notesIntent("add buy milk to my notes")).toMatchObject({ text: "buy milk" });
    expect(notesIntent("make a note that the meeting moved to 4")).toMatchObject({ text: "the meeting moved to 4" });
    expect(notesIntent("read my notes")).toEqual({ skill: "notes", action: "read" });
    expect(notesIntent("read me my last three notes")).toEqual({ skill: "notes", action: "read" });
  });
  test("J3: every note phrasing, including 'that', lands as a note with the leading 'that' dropped", () => {
    const text = "the receptionist needs a go-live date";
    for (const say of [
      `note: ${text}`,
      `write that down: ${text}`,
      `write this down ${text}`,
      `write it down ${text}`,
      `jot this down ${text}`,
      `jot that down ${text}`,
      `note down that ${text}`,
      `note this down: ${text}`,
      `add to my notes ${text}`,
      `add this to my notes ${text}`,
      `write down ${text}`,
    ])
      expect([say, notesIntent(say)]).toEqual([say, { skill: "notes", action: "add", text }]);
  });
  test("not notes", () => {
    for (const phrase of ["open my notes", "take notes of the meeting", "note", "open notepad", "notepad", "what notes do you have on Brooke", "write an email to Brooke", "read my emails"])
      expect(notesIntent(phrase)).toBeNull();
  });
});

describe("the notes file", () => {
  test("creates Inbox/Jarvis notes.md, appends timestamped lines, reads back the last three", () => {
    const vault = temp();
    let now = NOW;
    const notes = createNotes({ vault: () => vault, now: () => now });
    expect(notes.handle({ skill: "notes", action: "read" })).toBe("You haven't any Jarvis notes yet, sir.");
    for (const text of ["first", "second", "third", "fourth"]) {
      expect(notes.handle({ skill: "notes", action: "add", text })).toBe("Added to your Jarvis notes in the vault.");
      now += 60_000;
    }
    const file = join(vault, "Inbox", "Jarvis notes.md");
    const content = readFileSync(file, "utf8");
    expect(content).toStartWith("# Jarvis notes\n");
    expect(content).toContain("- 2026-09-24 15:42 — first\n");
    expect(notes.handle({ skill: "notes", action: "read" })).toBe("Latest, today: fourth. Before that, today: third. And before that, today: second.");
    expect(NOTED).toBe("Added to your Jarvis notes in the vault.");
  });
  test("secrets are neither saved nor read", () => {
    const vault = temp();
    const notes = createNotes({ vault: () => vault, now: () => NOW });
    expect(notes.handle({ skill: "notes", action: "add", text: "wifi password: hunter2" })).toBe("That looks like a password, key or token. Secrets are never stored in memory.");
    expect(existsSync(join(vault, "Inbox", "Jarvis notes.md"))).toBe(false);
    mkdirSync(join(vault, "Inbox"), { recursive: true });
    writeFileSync(join(vault, "Inbox", "Jarvis notes.md"), `${noteLine("buy milk", NOW)}\n${noteLine("sk-proj-abcdefghijklmnopqrstuvwxyz", NOW)}\n`);
    expect(notes.handle({ skill: "notes", action: "read" })).toBe("Latest, today: buy milk. I've skipped one that looks like a password or key.");
  });
  test("J3: the notes lane refuses what `remember that` refuses, in the same words, and writes nothing", () => {
    const vault = temp();
    const notes = createNotes({ vault: () => vault, now: () => NOW });
    const refused: [string, string][] = [
      ["BSB 062-000 account number 1234 5678", "bank account or card details"],
      ["my TFN is 123 456 782", "tax file number"],
      ["my one time code is 482913", "password, key or token"], // the guard files a spoken code under credentials, as `remember that` does
      ["the router login is admin slash Sunflower99", "password, key or token"],
      ["the Netflix account is usman@example.com with Sunflower99!", "password, key or token"],
      ["login for Stripe is usman at example dot com and Sunflower99", "password, key or token"],
      ["my card is 4111 1111 1111 1111", "bank account or card details"],
      ["the API key is kQ9zX2mB7vR4tY1w", "password, key or token"],
      ["wifi password: hunter2", "password, key or token"],
      // J3 review F1 and F3: the same variants the guard refuses for `remember that`.
      ["my TFN is 123​456​782", "tax file number"],
      ["BSB 062​000 acct 1234​5678", "bank account or card details"],
      ["router: admin / Sunflower99", "password, key or token"],
      ["cred: jane/Winter-Is-Coming", "password, key or token"],
      ["log in as jane, Sunflower99", "password, key or token"],
      ["the router login is admin forward slash Sunflower99", "password, key or token"],
    ];
    for (const [text, category] of refused) {
      const said = notes.handle({ skill: "notes", action: "add", text });
      const guard = screenFact(text);
      // The words are the memory guard's own: what `remember that …` says for the same text.
      expect([text, guard.ok ? "" : guard.message]).toEqual([text, said]);
      expect([text, said.includes(category)]).toEqual([text, true]);
      expect(said).not.toBe(NOTED);
      expect(noteRefusal(text)).toBe(said);
    }
    expect(existsSync(join(vault, "Inbox", "Jarvis notes.md"))).toBe(false);
    // Ordinary notes still land.
    for (const text of ["call Brooke about the demo", "the login page needs a redesign", "Mehroz prefers calls after 2", "the account is Bianca and the DentalDemo pilot"]) {
      expect(noteRefusal(text)).toBeNull();
      expect(notes.handle({ skill: "notes", action: "add", text })).toBe(NOTED);
    }
  });
  test("J3: a secret already in the file (written before the guard) is skipped when reading and never offered by the reader", () => {
    const vault = temp();
    mkdirSync(join(vault, "Inbox"), { recursive: true });
    const lines = [noteLine("Bianca needs a new hero", NOW), noteLine("my TFN is 123 456 782", NOW), noteLine("the router login is admin slash Sunflower99 for Bianca", NOW)];
    writeFileSync(join(vault, "Inbox", "Jarvis notes.md"), `${lines.join("\n")}\n`);
    const notes = createNotes({ vault: () => vault, now: () => NOW });
    const said = notes.handle({ skill: "notes", action: "read" });
    expect(said).toContain("Bianca needs a new hero");
    expect(said).not.toContain("123 456 782");
    expect(said).not.toContain("Sunflower99");
    const reader = createNotesReader({ vault: () => vault });
    expect(reader.search("what did I tell you about Bianca").hits.map((h) => h.text)).toEqual(["Bianca needs a new hero"]);
    expect(reader.latest(5).hits).toHaveLength(1);
    expect(reader.latest(5).skipped).toBe(2);
  });
  test("J3: the notes reader is read-only, ranks by matching words and names the day", () => {
    const vault = temp();
    mkdirSync(join(vault, "Inbox"), { recursive: true });
    const file = join(vault, "Inbox", "Jarvis notes.md");
    const lines = [noteLine("buy milk", NOW - 3 * 86_400_000), noteLine("Bianca prefers a darker hero image", NOW - 86_400_000), noteLine("the dental demo needs a new logo", NOW)];
    writeFileSync(file, `${lines.join("\n")}\n`);
    const before = readFileSync(file, "utf8");
    const reader = createNotesReader({ vault: () => vault });
    expect(reader.search("Bianca").hits.map((h) => h.text)).toEqual(["Bianca prefers a darker hero image"]);
    expect(reader.search("the dental demo").hits.map((h) => h.text)).toEqual(["the dental demo needs a new logo"]);
    expect(reader.search("what did I tell you about groceries").hits).toEqual([]);
    expect(reader.search("").hits).toEqual([]);
    expect(reader.latest(2).hits.map((h) => h.text)).toEqual(["the dental demo needs a new logo", "Bianca prefers a darker hero image"]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(spokenNoteDay("2026-09-24", NOW)).toBe("today");
    expect(spokenNoteDay("2026-09-23", NOW)).toBe("yesterday");
    expect(spokenNoteDay("2026-09-01", NOW)).toBe("1 Sept");
    expect(createNotesReader({ vault: () => null }).latest().hits).toEqual([]);
  });
  test("no vault, said plainly", () => {
    expect(createNotes({ vault: () => null }).handle({ skill: "notes", action: "read" })).toContain("can't find your Obsidian vault");
  });
  test("parsing and the vault variable", () => {
    expect(lastNotes("# x\n- 2026-09-23 09:00 — a\nnot a note\n- 2026-09-24 10:00 — b\n", 3)).toEqual([
      { date: "2026-09-24", time: "10:00", text: "b" },
      { date: "2026-09-23", time: "09:00", text: "a" },
    ]);
    const local = temp();
    const vault = temp();
    mkdirSync(join(local, "hermes"));
    writeFileSync(join(local, "hermes", ".env"), `SOME_KEY=secret\nOBSIDIAN_VAULT_PATH="${vault}"\n`);
    expect(hermesVaultPath({ LOCALAPPDATA: local } as any)).toBe(vault);
    writeFileSync(join(local, "hermes", ".env"), `OBSIDIAN_VAULT_PATH=${join(vault, "missing")}\n`);
    expect(hermesVaultPath({ LOCALAPPDATA: local } as any)).not.toBe(join(vault, "missing"));
  });
});
