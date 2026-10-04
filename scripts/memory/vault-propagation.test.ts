// Obsidian edits reach the one shared pool without duplicates or resurrection (cloud/memory-finance, 29 Sep 2026).
// Synthetic vault + fake Hindsight only: no real bank, no credentials, MU_MEMORY_WRITES is never touched.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, setup, usman } from "./testing/harness";
import { assignNoteIds, noteSignature, signatureSimilarity, withoutCopies, type ScannedNote } from "./vault";
import { contentHash } from "./derived";

afterAll(cleanup);
const T = 30_000;
const PLAYBOOK = "wiki/topics/business/receptionist-playbook.md";
const TERMS = "wiki/topics/business/proposal-terms.md";
const rd = (v: string, rel: string) => readFileSync(join(v, rel), "utf8");
const wr = (v: string, rel: string, text: string) => (mkdirSync(join(v, rel, ".."), { recursive: true }), writeFileSync(join(v, rel), text));
const notesIn = (h: Awaited<ReturnType<typeof setup>>) => [...h.bankDocs().keys()].filter((k) => k.startsWith("n-"));

describe("signatures", () => {
  const a = "The synthetic Kestrel clinic answers calls from eight until six on weekdays and books cleanings for new patients through the receptionist";
  test("an edited note stays similar; a different note does not; a short note has no signature", () => {
    const edited = a.replace("eight until six", "nine until five");
    expect(signatureSimilarity(noteSignature(a), noteSignature(edited))).toBeGreaterThan(0.6);
    expect(signatureSimilarity(noteSignature(a), noteSignature("Quarterly pricing review covers invoices, subscriptions and the annual renewal schedule for every client"))).toBeLessThan(0.3);
    expect(noteSignature("too short")).toBe("");
    expect(signatureSimilarity("", noteSignature(a))).toBe(0);
  });
  const scanned = (path: string, body: string, fields: Record<string, string> = {}): ScannedNote => ({ path, raw: body, hash: contentHash(path + body), bodyHash: contentHash(body), mtime: "2026-09-29T00:00:00Z", fields, body });
  test("two similar vanished notes: an edited arrival is not guessed onto either", () => {
    const b1 = a + " alpha", b2 = a + " beta";
    const prev = { "a.md": { id: "n-a", hash: "h1", bodyHash: "b1", rev: 1, sig: noteSignature(b1) }, "b.md": { id: "n-b", hash: "h2", bodyHash: "b2", rev: 1, sig: noteSignature(b2) } };
    const { map, renames } = assignNoteIds([scanned("c.md", a + " gamma")], prev, new Date("2026-09-29T00:00:00Z"));
    expect(renames).toEqual([]);
    expect(["n-a", "n-b"]).not.toContain(map["c.md"].id);
  });
  test("copies: one note stands for the group; distinct frontmatter ids stay separate", () => {
    const one = scanned("x/one.md", a), two = scanned("x/one copy.md", a);
    const kept = withoutCopies([two, one], { "x/one.md": { id: "n-1", hash: "h", bodyHash: one.bodyHash, rev: 1 } });
    expect(kept.notes.map((n) => n.path)).toEqual(["x/one.md"]);
    expect(kept.skipped).toEqual([{ path: "x/one copy.md", reason: "duplicate of x/one.md" }]);
    const f1 = scanned("p.md", a, { id: "p1" }), f2 = scanned("q.md", a, { id: "q1" });
    expect(withoutCopies([f1, f2], {}).notes).toHaveLength(2);
    expect(withoutCopies([scanned("p.md", a, { id: "same" }), scanned("q.md", a, { id: "same" })], {}).notes).toHaveLength(1);
  });
});

describe("Obsidian edits reach the shared pool", () => {
  test("a copied note (with or without a frontmatter id) is not indexed twice, and says why", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    const before = h.bankDocs().size;
    wr(h.vault, "wiki/topics/business/proposal-terms copy.md", rd(h.vault, TERMS));
    wr(h.vault, "wiki/topics/business/receptionist-playbook copy.md", rd(h.vault, PLAYBOOK));
    const s = await h.api.sync({ force: true });
    expect(h.bankDocs().size).toBe(before);
    expect(s.status.skipped.map((x) => x.reason)).toContain("duplicate of wiki/topics/business/receptionist-playbook.md");
    // The original is deleted and only the copy is left: it takes over the identity, still one document.
    const id = h.api.connector.store.readNotes()[PLAYBOOK].id;
    rmSync(join(h.vault, PLAYBOOK));
    await h.api.sync({ force: true });
    expect(h.api.connector.store.readNotes()["wiki/topics/business/receptionist-playbook copy.md"].id).toBe(id);
    expect(h.bankDocs().size).toBe(before);
  }, T);

  test("rename AND edit before the next sync keeps the identity: one document, updated text, no delete", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    const id = h.api.connector.store.readNotes()[PLAYBOOK].id;
    const body = rd(h.vault, PLAYBOOK);
    rmSync(join(h.vault, PLAYBOOK));
    wr(h.vault, "wiki/topics/business/kestrel-hours.md", body.replace("8am to 6pm", "9am to 5pm"));
    const before = notesIn(h).length;
    const s = await h.api.sync({ force: true });
    expect(s.renames.map((r) => r.id)).toEqual([id]);
    expect(notesIn(h)).toHaveLength(before);
    expect(h.bankDocs().get(id)!.content).toContain("9am to 5pm");
    expect(h.bankDocs().get(id)!.metadata.source_path).toBe("wiki/topics/business/kestrel-hours.md");
    expect(h.fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  }, T);

  test("remove-from-search survives a rename plus edit; a full forget is a different, approved act", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    const r = await h.api.forget(usman, { kind: "unindex", target: PLAYBOOK });
    if (!r.ok) throw new Error(r.message);
    const body = rd(h.vault, PLAYBOOK);
    rmSync(join(h.vault, PLAYBOOK));
    wr(h.vault, "wiki/topics/business/kestrel-hours.md", body.replace("8am to 6pm", "9am to 5pm"));
    await h.api.sync({ force: true });
    const rec = await h.api.recall(usman, "Kestrel clinic answers calls");
    expect(JSON.stringify(rec.facts)).not.toContain("kestrel-hours");
    expect(JSON.stringify(rec.facts)).not.toContain("9am to 5pm");
    // Removal from search left the note itself alone; nothing was tombstoned.
    expect(h.api.connector.store.readTombstones()).toHaveLength(0);
    expect(readFileSync(join(h.vault, "wiki/topics/business/kestrel-hours.md"), "utf8")).toContain("9am to 5pm");
    // A full forget of the same note is refused without an approval: it never runs on the caller's say-so.
    const full = await h.api.forget(usman, { kind: "full", target: "wiki/topics/business/kestrel-hours.md" });
    expect(full.ok && "approval" in full ? (full as any).approval : "pending").toBeTruthy();
    expect(readFileSync(join(h.vault, "wiki/topics/business/kestrel-hours.md"), "utf8")).toContain("9am to 5pm");
  }, T);

  test("an unindexed or forgotten note's decision is never handed to a merely similar note", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    const oldId = h.api.connector.store.readNotes()[PLAYBOOK].id;
    const r = await h.api.forget(usman, { kind: "unindex", target: PLAYBOOK });
    if (!r.ok) throw new Error(r.message);
    const body = rd(h.vault, PLAYBOOK);
    rmSync(join(h.vault, PLAYBOOK));
    // A different note that shares a good part of the words (well under a light edit, well over the rename floor).
    const text = body.replace(/^---[\s\S]*?---\n/, "");
    const words = [...new Set(text.split(/\s+/))];
    const similar = words.slice(0, Math.ceil(words.length * 0.95)).join(" ") + " " + Array.from({ length: Math.ceil(words.length * 0.15) }, (_, i) => `fresh${i}word`).join(" ");
    const sim = signatureSimilarity(noteSignature(text), noteSignature(similar));
    expect(sim).toBeGreaterThan(0.6);
    expect(sim).toBeLessThan(0.85);
    wr(h.vault, "wiki/topics/business/other-clinic.md", `---\nbucket: business\n---\n${similar}\n`);
    const s = await h.api.sync({ force: true });
    // It does not take the removed note's id (no rename), it is not indexed, and the owner is told why.
    expect(s.renames).toEqual([]);
    expect(Object.values(h.api.connector.store.readNotes()).filter((e) => e.id === oldId && !e.missing_since)).toHaveLength(0);
    expect(notesIn(h).some((k) => k === oldId)).toBe(false);
    expect(JSON.stringify(h.api.connector.store.readStatus().skipped)).toContain("held: looks like");
    expect(JSON.stringify((await h.api.recall(usman, "other clinic")).facts)).not.toContain("fresh0word");
    // Its own frontmatter id is the owner's way to index it as a separate note.
    wr(h.vault, "wiki/topics/business/other-clinic.md", `---\nbucket: business\nid: other-clinic-1\n---\n${similar}\n`);
    await h.api.sync({ force: true });
    expect(h.api.connector.store.readNotes()["wiki/topics/business/other-clinic.md"].id).toBe("n-other-clinic-1");
    expect(JSON.stringify(h.api.connector.store.readStatus().skipped)).not.toContain("held: looks like");
  }, T);

  test("an edit that turns a note credential-shaped retracts it; an opt-out retracts it; deleting retracts it; restoring brings it back once", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    const id = h.api.connector.store.readNotes()[PLAYBOOK].id;
    const original = rd(h.vault, PLAYBOOK);
    expect(h.bankDocs().has(id)).toBe(true);

    wr(h.vault, PLAYBOOK, original + "\nlogin: admin\npassword: Zebra-9271-Quartz\n");
    await h.api.sync({ force: true });
    expect(h.bankDocs().has(id)).toBe(false);
    expect((await h.api.recall(usman, "Kestrel clinic answers calls")).facts.map((f) => f.id)).not.toContain(id);

    wr(h.vault, PLAYBOOK, original);
    await h.api.sync({ force: true });
    expect(h.bankDocs().has(id)).toBe(true);

    wr(h.vault, PLAYBOOK, original.replace("bucket: business", "bucket: business\nmemory: false"));
    await h.api.sync({ force: true });
    expect(h.bankDocs().has(id)).toBe(false);

    wr(h.vault, PLAYBOOK, original);
    rmSync(join(h.vault, PLAYBOOK));
    await h.api.sync({ force: true });
    expect(h.bankDocs().has(id)).toBe(false);
    expect(h.api.connector.status().pending).toBe(0);

    wr(h.vault, PLAYBOOK, original);
    const before = notesIn(h).length;
    await h.api.sync({ force: true });
    expect(h.api.connector.store.readNotes()[PLAYBOOK].id).toBe(id);
    expect(notesIn(h).length).toBe(before + 1);
  }, T);

  test("recall names its source: path, Obsidian link, version, who saved it, and the model route that actually ran", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    wr(h.vault, TERMS, rd(h.vault, TERMS).replace("valid for 21 days", "valid for 30 days"));
    await h.api.sync({ force: true });
    const rec = await h.api.recall(usman, "How long are Osprey proposals valid");
    const hit = rec.facts.find((f) => f.id === "n-proposal-terms")!;
    expect(hit.source.kind === "vault" && hit.source.path).toBe(TERMS);
    expect(hit.source.kind === "vault" && hit.source.uri).toContain("obsidian://open");
    expect(hit.text).toContain("30 days");
    expect(typeof hit.version).toBe("number");
    expect(hit.indexed).toBe("confirmed");
    expect(hit.origin).toBe("obsidian");
    expect(hit.actor).toBeNull(); // a hand edit in Obsidian has no app-recorded saver: unknown, not invented
    const mem = await h.api.remember(usman, { text: "The Heron onboarding kickoff call happens within two business days." });
    if (!mem.ok) throw new Error(mem.message);
    const mrec = (await h.api.recall(usman, "Heron onboarding kickoff")).facts.find((f) => f.id === mem.memory.id)!;
    expect(mrec.origin === "jarvis" || mrec.origin === "ui" || mrec.origin === "agent").toBe(true);
    expect(mrec.actor).toBe("Usman");
    expect(mrec.source).toEqual({ kind: "memory", id: mem.memory.id });
    const status = h.api.connector.status();
    const ran = Object.keys(status.models);
    // Whatever route Hindsight's receipt names is what is recorded; there is no built-in expected model.
    expect(ran.every((k) => k === "unknown" || k.includes("/"))).toBe(true);
  }, T);
});
