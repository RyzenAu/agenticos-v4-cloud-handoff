// Ordinary URLs through the whole memory lifecycle (1 Oct 2026). Disposable data only: a temp vault copy and the fake Hindsight bank.
// Save, recall with source, duplicate, correction, Obsidian edit, rename, deletion, forget, restart. Credential URLs stay refused throughout.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, setup, usman } from "./testing/harness";

afterAll(cleanup);
const T = 30_000;
const NOTE = "wiki/topics/business/receptionist-playbook.md";
const RENAMED = "wiki/topics/business/receptionist-playbook-renamed.md";
const LICENSING = "https://www.fairtrading.nsw.gov.au/trades-and-businesses/licensing-and-registrations";
const rd = (v: string, rel: string) => readFileSync(join(v, rel), "utf8");
const wr = (v: string, rel: string, text: string) => (mkdirSync(join(v, rel, ".."), { recursive: true }), writeFileSync(join(v, rel), text));

describe("ordinary URLs survive the whole memory lifecycle", () => {
  test("save, recall with source, duplicate, correct, edit, rename, delete, forget and restart", async () => {
    const h = await setup();
    await h.api.sync({ force: true });

    // Save (with a URL in the fact and a URL as the source reference) and recall with its source.
    const m = await h.api.remember(usman, { text: `The synthetic Wren plumbing client checks licences at ${LICENSING} before each booking.`, note: "https://docs.example.com/v2/api/reference?tab=auth" });
    if (!m.ok) throw new Error(m.message);
    expect(h.bankDocs().has(m.memory.id)).toBe(true);
    const rec = await h.api.recall(usman, "Wren plumbing licences booking");
    const hit = rec.facts.find((f) => f.id === m.memory.id)!;
    expect(hit.text).toContain(LICENSING);
    expect(hit.source).toEqual({ kind: "memory", id: m.memory.id });

    // Duplicate prevention.
    const dup = await h.api.remember(usman, { text: m.memory.text });
    expect(dup.ok && dup.duplicate).toBe(true);

    // Correction retracts the old version and indexes the new.
    const c = await h.api.correct(usman, m.memory.id, { text: `The synthetic Wren plumbing client checks licences at ${LICENSING} and rotates the API key in settings each quarter.` });
    if (!c.ok) throw new Error(c.message);
    expect(h.bankDocs().has(m.memory.id)).toBe(false);
    expect(h.bankDocs().has(c.id)).toBe(true);

    // Obsidian edit with an ordinary URL reaches the shared pool, and a credential URL retracts it.
    await h.api.sync({ force: true });
    const id = h.api.connector.store.readNotes()[NOTE].id;
    const original = rd(h.vault, NOTE);
    wr(h.vault, NOTE, original + "\nSee https://github.com/org/repo/blob/main/src/a.ts for the handler.\n");
    await h.api.sync({ force: true });
    expect(h.bankDocs().get(id)?.content ?? "").toContain("https://github.com/org/repo/blob/main/src/a.ts");
    wr(h.vault, NOTE, original + "\nDatabase: postgres://admin:hunter2pass@db.example.com/app\n");
    await h.api.sync({ force: true });
    expect(h.bankDocs().has(id)).toBe(false);
    wr(h.vault, NOTE, original + "\nSee https://github.com/org/repo/blob/main/src/a.ts for the handler.\n");
    await h.api.sync({ force: true });
    expect(h.bankDocs().has(id)).toBe(true);

    // Rename keeps the identity (one document, no duplicate).
    const before = [...h.bankDocs().keys()].filter((k) => k.startsWith("n-")).length;
    renameSync(join(h.vault, NOTE), join(h.vault, RENAMED));
    await h.api.sync({ force: true });
    expect(h.api.connector.store.readNotes()[RENAMED].id).toBe(id);
    expect([...h.bankDocs().keys()].filter((k) => k.startsWith("n-")).length).toBe(before);

    // Restart: a new process over the same store still recalls, and still refuses a credential URL.
    const restarted = h.make();
    const after = await restarted.recall(usman, "Wren plumbing licences booking");
    expect(after.facts.map((f) => f.id)).toContain(c.id);
    const bad = await restarted.remember(usman, { text: "Staging is https://svc:Sup3rS3cret@staging.example.com/app" });
    expect(bad.ok).toBe(false);

    // Deletion of the note retracts it; forgetting the memory is an approved act.
    rmSync(join(h.vault, RENAMED));
    await restarted.sync({ force: true });
    expect(h.bankDocs().has(id)).toBe(false);
    const ask = await restarted.forget(usman, { kind: "memory", target: c.id });
    if (ask.ok || !ask.approval) throw new Error("expected approval-required");
    const g = await h.approveUi(restarted, ask.approval.id, usman);
    expect(g.ok && g.result.ok).toBe(true);
    expect(h.bankDocs().has(c.id)).toBe(false);
  }, T);
});
