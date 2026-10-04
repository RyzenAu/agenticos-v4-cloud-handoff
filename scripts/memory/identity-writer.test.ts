// REVIEW-STAGE-D B5: a note keeps its identity across delete-then-restore (no duplicates, no
// re-processing, unindex decisions kept), an empty-looking vault removes nothing, and only ONE process
// may write the real memory. TEMP synthetic vault + FAKE Hindsight only.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BULK_RETRACT_LIMIT } from "./connector";
import { createMemoryService } from "./plugin";
import { cleanup, setup, usman } from "./testing/harness";
import { writerDecision } from "./writer";

afterEach(cleanup);
const T = { timeout: 60_000 };
const retains = (h: Awaited<ReturnType<typeof setup>>) => h.fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/memories")).length;

describe("note identity survives a delete and a restore", () => {
  test(
    "a deleted folder restored (partly, then fully): same ids, no duplicates, no re-processing; the hold shrinks",
    async () => {
      const h = await setup({ proxy: true });
      const dir = join(h.vault, "wiki", "topics", "business", "bulk");
      const stash = mkdtempSync(join(tmpdir(), "mu-stash-"));
      mkdirSync(dir, { recursive: true });
      const n = BULK_RETRACT_LIMIT + 5;
      for (let i = 0; i < n; i++) writeFileSync(join(dir, `synthetic-bulk-${i}.md`), `---\ntitle: Synthetic bulk ${i}\n---\n\nSynthetic bulk note ${i} for the Dotterel test account.\n`);
      await h.api.sync({ force: true });
      const docs = h.bankDocs().size;
      const idsBefore = new Set(h.bankDocs().keys());
      const sent = retains(h);
      cpSync(dir, stash, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
      await h.api.sync({ force: true });
      expect(h.api.status().held?.count).toBe(n);
      // Six come back: they keep their ids, so the hold shrinks and nothing new is sent.
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 6; i++) cpSync(join(stash, `synthetic-bulk-${i}.md`), join(dir, `synthetic-bulk-${i}.md`));
      await h.api.sync({ force: true });
      expect(h.api.status().held?.count).toBe(n - 6);
      expect(h.bankDocs().size).toBe(docs);
      // All back: nothing held, nothing duplicated, nothing re-processed.
      for (let i = 6; i < n; i++) cpSync(join(stash, `synthetic-bulk-${i}.md`), join(dir, `synthetic-bulk-${i}.md`));
      await h.api.sync({ force: true });
      expect(h.api.status().held).toBeNull();
      expect(new Set(h.bankDocs().keys())).toEqual(idsBefore);
      expect(retains(h)).toBe(sent);
      rmSync(stash, { recursive: true, force: true });
    },
    T,
  );

  test(
    "a vault that looks empty removes nothing; notes that vanish and return keep their ids and their 'unindex'",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      const un = await h.api.forget(usman, { kind: "unindex", target: "n-proposal-terms" });
      expect(un.ok).toBe(true);
      const kept = new Set(h.bankDocs().keys());
      const wiki = join(h.vault, "wiki");
      const aside = join(h.base, "wiki-aside");
      renameSync(wiki, aside); // e.g. a branch switch or a sync glitch
      mkdirSync(wiki);
      await h.api.sync({ force: true });
      expect(new Set(h.bankDocs().keys())).toEqual(kept); // nothing retracted
      expect(h.api.status().pending).toBe(0);
      rmSync(wiki, { recursive: true, force: true });
      renameSync(aside, wiki);
      const sent = retains(h);
      await h.api.sync({ force: true });
      expect(new Set(h.bankDocs().keys())).toEqual(kept);
      expect(retains(h)).toBe(sent);
      expect(h.bankDocs().has("n-proposal-terms")).toBe(false); // still unindexed
      // A note deleted for real (under the hold's threshold) and restored gets its old id back.
      const playbook = h.api.list({ kind: "note" }).find((r) => r.title === "Receptionist Playbook")!;
      const file = join(h.vault, "wiki", "topics", "business", "receptionist-playbook.md");
      const copy = join(h.base, "playbook.md");
      cpSync(file, copy);
      rmSync(file);
      await h.api.sync({ force: true });
      expect(h.bankDocs().has(playbook.id)).toBe(false);
      cpSync(copy, file);
      await h.api.sync({ force: true });
      expect(h.api.list({ kind: "note" }).find((r) => r.title === "Receptionist Playbook")!.id).toBe(playbook.id);
      expect([...h.bankDocs().keys()].filter((k) => k.startsWith("n-")).length).toBe([...kept].filter((k) => k.startsWith("n-")).length);
    },
    T,
  );
});

describe("one writer for the real memory", () => {
  const base = (over: Partial<Parameters<typeof writerDecision>[0]> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "mu-writer-"));
    const env = { MU_MEMORY_WRITER_ROOT: join(dir, "main"), MU_MEMORY_REAL_VAULT: join(dir, "vault"), MU_MEMORY_WRITER_LOCK: join(dir, "writer.lock.json") };
    return { dir, input: { env, appRoot: join(dir, "main"), port: 8081, vaultRoot: join(dir, "vault"), stateDir: join(dir, "state"), hindsightUrl: "http://127.0.0.1:8878", explicit: false, ...over } };
  };
  test("only the main tree on 8081, holding the lock, writes the real vault or pool", () => {
    const { dir, input } = base();
    expect(writerDecision(input).ok).toBe(true);
    expect(writerDecision({ ...input, appRoot: join(dir, "worktree") })).toMatchObject({ ok: false });
    expect(writerDecision({ ...input, port: 8095 })).toMatchObject({ ok: false });
    expect(writerDecision({ ...input, pid: process.ppid })).toMatchObject({ ok: false }); // a live process holds it
    // A synthetic vault pointed at the REAL pool is still the real memory.
    expect(writerDecision({ ...input, appRoot: join(dir, "worktree"), vaultRoot: join(dir, "synthetic"), explicit: true })).toMatchObject({ ok: false });
    // A fully synthetic copy (own vault, own store, own Hindsight) may write.
    expect(writerDecision({ ...input, appRoot: join(dir, "worktree"), port: 8095, vaultRoot: join(dir, "synthetic"), hindsightUrl: "http://127.0.0.1:8883", explicit: true }).ok).toBe(true);
    expect(writerDecision({ ...input, appRoot: join(dir, "worktree"), port: 8095, vaultRoot: join(dir, "synthetic"), hindsightUrl: "http://127.0.0.1:8883", explicit: false })).toMatchObject({ ok: false });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a dev server in another worktree with the switch on is read-only, and says why", () => {
    const { dir, input } = base();
    const svc = createMemoryService({
      root: join(dir, "worktree"),
      port: 8081,
      env: { ...input.env, MU_MEMORY_WRITES: "on", MU_WIKI_ROOT: join(dir, "vault"), MEMORY_STATE_DIR: join(dir, "state"), HINDSIGHT_URL: "off" },
    });
    mkdirSync(join(dir, "vault", "wiki"), { recursive: true });
    const st = svc.api().status();
    expect(st.settings.writes).toBe(false);
    expect(st.settings.writer).toContain("Read-only copy");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("REVIEW-STAGE-D R2 minor: a hold left for more than 30 days", () => {
  test(
    "a mass removal held for 31+ days, then restored, keeps its ids: no duplicates",
    async () => {
      const h = await setup({ proxy: true });
      const dir = join(h.vault, "wiki", "topics", "business", "bulk");
      const stash = mkdtempSync(join(tmpdir(), "mu-stash-"));
      mkdirSync(dir, { recursive: true });
      const n = BULK_RETRACT_LIMIT + 5;
      for (let i = 0; i < n; i++) writeFileSync(join(dir, `synthetic-old-${i}.md`), `---\ntitle: Synthetic old ${i}\n---\n\nSynthetic old note ${i} for the Stilt test account.\n`);
      await h.api.sync({ force: true });
      const ids = new Set(h.bankDocs().keys());
      cpSync(dir, stash, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
      await h.api.sync({ force: true });
      expect(h.api.status().held?.count).toBe(n);
      h.advance(31 * 24 * 3600_000); // nobody approved it for a month
      await h.api.sync({ force: true });
      cpSync(stash, dir, { recursive: true });
      await h.api.sync({ force: true });
      expect(new Set(h.bankDocs().keys())).toEqual(ids);
      expect(h.api.status().held).toBeNull();
      rmSync(stash, { recursive: true, force: true });
    },
    T,
  );
});
