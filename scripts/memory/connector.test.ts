// V5 §2 acceptance, synthetic: a TEMP copy of the mini-wiki, a TEMP app store and a FAKE
// Hindsight server on loopback. Never the real vault, never the real mu-pilot bank.
// Item numbers follow V5-UPDATE.md §2 "Acceptance (synthetic)". Item 10 (credential copies at
// startup) belongs to the Hindsight repair agent.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { memoryMiddleware } from "./plugin";
import { handleMemoryUtterance, runMemoryTool } from "./voice-intents";
import { allText, cleanup, mehroz, setup, snapshot, SYNTHETIC_KEY, usman } from "./testing/harness";
import type { ForgetResult } from "./types";

afterEach(cleanup);
const T = { timeout: 30_000 };
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const write = (root: string, rel: string, text: string) => writeFileSync(join(root, rel), text, "utf8");

describe("1 · save and recall via Jarvis", () => {
  test(
    "initial sync indexes permitted notes only; 'remember that' is Hindsight-only; 'save this to the vault' writes the note and indexes it",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const ids = [...h.bankDocs().keys()];
      expect(ids).toContain("mf-00000000a1");
      expect(ids).toContain("n-proposal-terms");
      const paths = [...h.bankDocs().values()].map((d) => d.metadata.source_path);
      expect(paths).toContain("wiki/topics/business/booking-script.md"); // declared script passes
      for (const never of ["staging-setup", "tuesday-call", "draft-ideas", "raw/", "templates/", "README", "CLAUDE"])
        expect(paths.some((p) => p?.includes(never))).toBe(false);

      const before = snapshot(h.vault);
      const r1 = await handleMemoryUtterance(h.api, usman, "Remember that the synthetic Kestrel clinic parking is behind gate B");
      expect(r1.outcome).toBe("remembered");
      expect(r1.destination?.kind).toBe("hindsight");
      const memId = r1.facts_used[0];
      expect(memId).toMatch(/^mem-[0-9a-f]{10}$/);
      expect(r1.spoken).toContain("Hindsight memory");
      expect(r1.spoken).toContain("Not written to the vault");
      expect(r1.spoken).toContain("indexed in Hindsight");
      expect(h.bankDocs().get(memId)?.metadata.origin).toBe("jarvis");
      expect(h.bankDocs().get(memId)?.metadata.actor).toBe("Usman");
      expect(snapshot(h.vault)).toEqual(before); // no circular write into Obsidian
      const provenance = h.api.item(memId)!;
      expect(provenance.row.actor).toBe("Usman");
      expect(provenance.row.destination_label).toBe("Hindsight memory");

      // One shared pool: Mehroz recalls what Usman captured.
      const r2 = await handleMemoryUtterance(h.api, mehroz, "What do we know about Kestrel parking");
      expect(r2.outcome).toBe("recalled");
      expect(r2.facts_used[0]).toBe(memId);
      expect(r2.spoken).toContain(`Jarvis memory ${memId}`);
      const rec = await h.api.recall(mehroz, "Kestrel parking gate");
      expect(rec.hindsight).toBe("ok");
      expect(rec.facts[0].via).toContain("hindsight");

      const r3 = await handleMemoryUtterance(h.api, usman, "Save this to the vault: Synthetic Osprey invoices are due within 14 days");
      expect(r3.outcome).toBe("saved-to-vault");
      expect(r3.destination?.path).toBe("wiki/topics/business/memory-business-shared.md");
      expect(r3.spoken).toContain("Saved to the vault note wiki/topics/business/memory-business-shared.md");
      expect(r3.spoken).toContain("indexed in Hindsight");
      const ref = r3.facts_used[0];
      expect(read(h.vault, "wiki/topics/business/memory-business-shared.md")).toContain(`Synthetic Osprey invoices are due within 14 days. ^${ref}`);
      expect(h.bankDocs().get(ref)?.metadata.source_path).toBe("wiki/topics/business/memory-business-shared.md");

      // "save that to the vault" moves the memory just used; the Hindsight-only copy is retracted.
      const r4 = await handleMemoryUtterance(h.api, usman, "save that to the vault", { lastFactsUsed: [memId] });
      expect(r4.outcome).toBe("saved-to-vault");
      expect(h.bankDocs().has(memId)).toBe(false);
      expect(h.api.item(memId)!.row.status).toBe("promoted");
      expect(h.bankDocs().has(r4.facts_used[0])).toBe(true);
    },
    T,
  );
});

describe("2 · recall after restart", () => {
  test(
    "a fresh process reloads memories, index state and outbox from disk and re-sends nothing",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const r = await h.api.remember(usman, { text: "The synthetic Wren studio closes at 4pm on Fridays.", channel: "voice" });
      expect(r.ok).toBe(true);
      const retainsBefore = h.fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/memories")).length;

      const restarted = h.make();
      const rec = await restarted.recall(mehroz, "When does the Wren studio close");
      expect(rec.facts[0]?.id).toBe(r.ok ? r.memory.id : "");
      expect(rec.facts[0].via.sort()).toEqual(["hindsight", "local"]);
      await restarted.sync({ force: true });
      const retainsAfter = h.fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/memories")).length;
      expect(retainsAfter).toBe(retainsBefore);
      expect(restarted.status().pending).toBe(0);
      expect(restarted.status().counts.memories).toBe(1);
    },
    T,
  );
});

describe("3 · Obsidian changes appear in recall", () => {
  test(
    "an edit re-sends the same document_id; recall shows the new text, never the old",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const rel = "wiki/topics/business/proposal-terms.md";
      write(h.vault, rel, read(h.vault, rel).replace("valid for 21 days", "valid for 30 days"));
      const s = await h.api.sync({ force: true });
      expect(s.status.pending).toBe(0);
      const doc = h.bankDocs().get("n-proposal-terms")!;
      expect(doc.retains).toBe(2);
      expect(doc.content).toContain("30 days");
      expect(doc.content).not.toContain("21 days");
      const rec = await h.api.recall(usman, "How long are Osprey proposals valid");
      expect(rec.facts[0].id).toBe("n-proposal-terms");
      expect(rec.facts[0].text).toContain("30 days");
      expect(JSON.stringify(rec.facts)).not.toContain("21 days");

      // A new note appears too.
      write(h.vault, "wiki/topics/business/heron-onboarding.md", "---\ntitle: Heron Onboarding\nbucket: business\n---\n\n# Heron Onboarding\n\nSynthetic Heron clients get a kickoff call within two business days.\n");
      await h.api.sync({ force: true });
      const rec2 = await h.api.recall(usman, "Heron kickoff call");
      expect(rec2.facts[0].source.kind === "vault" && rec2.facts[0].source.path).toBe("wiki/topics/business/heron-onboarding.md");
    },
    T,
  );
});

describe("4 · source links are correct", () => {
  test(
    "recall carries vault path + Obsidian link + URI, or the mem- id, with version and date; Hindsight metadata matches",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const rec = await h.api.recall(usman, "demo line answers 7am 9pm");
      const fact = rec.facts.find((f) => f.id === "mf-00000000a1")!;
      expect(fact.source).toEqual({
        kind: "vault",
        path: "wiki/topics/business/memory-business-shared.md",
        note_id: expect.stringMatching(/^n-[0-9a-f]{10}$/),
        link: "[[memory-business-shared#^mf-00000000a1]]",
        uri: "obsidian://open?vault=mini-wiki&file=wiki%2Ftopics%2Fbusiness%2Fmemory-business-shared",
        block: "mf-00000000a1",
      });
      expect(fact.version).toBe(1);
      expect(fact.date).toBe("2026-09-20T01:00:00.000Z");
      expect(fact.version_hash).toMatch(/^[0-9a-f]{64}$/);

      const note = (await h.api.recall(usman, "Osprey proposals valid")).facts[0];
      expect(note.source.kind === "vault" && note.source.link).toBe("[[proposal-terms]]");

      const m = await h.api.remember(usman, { text: "The synthetic Plover account prefers email follow-ups.", channel: "voice" });
      const mem = (await h.api.recall(usman, "Plover follow-ups")).facts[0];
      expect(mem.source).toEqual({ kind: "memory", id: m.ok ? m.memory.id : "" });

      const meta = h.bankDocs().get("mf-00000000a1")!.metadata;
      expect(meta.source_path).toBe("wiki/topics/business/memory-business-shared.md");
      expect(meta.obsidian_link).toBe("[[memory-business-shared#^mf-00000000a1]]");
      expect(meta.version_hash).toBe(fact.version_hash);
      expect(meta.synced_at).toMatch(/^2026-09-28T/);
      expect(h.bankDocs().get("mf-00000000a1")!.tags).toContain("src:agenticos");
    },
    T,
  );
});

describe("5 · corrections suppress obsolete facts", () => {
  test(
    "memory and vault-fact corrections retract the old document; a stale Hindsight hit is suppressed",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const m = await h.api.remember(usman, { text: "The synthetic Heron studio opens at 8am.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      const c = await h.api.correct(usman, m.memory.id, { text: "The synthetic Heron studio opens at 9am.", channel: "voice" });
      if (!c.ok) throw new Error(c.message);
      expect(c.message).toContain("retracted from Hindsight");
      expect(h.bankDocs().has(m.memory.id)).toBe(false);
      expect(h.bankDocs().has(c.id)).toBe(true);
      expect(h.api.item(m.memory.id)!.row.status).toBe("superseded");
      const rec = await h.api.recall(mehroz, "When does the Heron studio open");
      expect(rec.facts[0].id).toBe(c.id);
      expect(rec.facts.map((f) => f.id)).not.toContain(m.memory.id);
      expect(JSON.stringify(rec.facts)).not.toContain("Heron studio opens at 8am");

      const v = await h.api.correct(usman, "mf-00000000a1", { text: "The synthetic demo line answers from 7am to 10pm Sydney time.", channel: "ui" });
      if (!v.ok) throw new Error(v.message);
      expect(h.bankDocs().has("mf-00000000a1")).toBe(false);
      expect(h.bankDocs().has(v.id)).toBe(true);
      const page = read(h.vault, "wiki/topics/business/memory-business-shared.md");
      expect(page).toContain("**Superseded (");
      expect(page).toContain("7am to 9pm"); // the vault keeps the superseded claim, marked
      const rec2 = await h.api.recall(usman, "demo line answers");
      expect(rec2.facts.map((f) => f.id)).toContain(v.id);
      expect(rec2.facts.map((f) => f.id)).not.toContain("mf-00000000a1");

      // Hindsight still holding an obsolete document (e.g. restored from a backup) never reaches an answer.
      h.bankDocs().set(m.memory.id, { document_id: m.memory.id, content: "The synthetic Heron studio opens at 8am.", tags: ["src:agenticos"], metadata: {}, timestamp: null, retains: 1 });
      const rec3 = await h.api.recall(usman, "Heron studio opens");
      expect(rec3.suppressed).toBeGreaterThanOrEqual(1);
      expect(rec3.facts.map((f) => f.id)).not.toContain(m.memory.id);
      expect(JSON.stringify(rec3.facts)).not.toContain("Heron studio opens at 8am");
    },
    T,
  );
});

describe("6 · renames don't duplicate", () => {
  test(
    "a moved note keeps its id (by content hash, or by frontmatter id) and its one Hindsight document",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const before = h.api.connector.store.readNotes()["wiki/topics/business/receptionist-playbook.md"].id;
      const countBefore = h.bankDocs().size;
      renameSync(join(h.vault, "wiki/topics/business/receptionist-playbook.md"), join(h.vault, "wiki/topics/business/kestrel-playbook.md"));
      mkdirSync(join(h.vault, "wiki/entities/terms"), { recursive: true });
      renameSync(join(h.vault, "wiki/topics/business/proposal-terms.md"), join(h.vault, "wiki/entities/terms/proposal-terms-v2.md"));
      const s = await h.api.sync({ force: true });
      expect(s.renames.map((r) => r.id).sort()).toEqual([before, "n-proposal-terms"].sort());
      expect(h.api.connector.store.readNotes()["wiki/topics/business/kestrel-playbook.md"].id).toBe(before);
      expect(h.bankDocs().size).toBe(countBefore);
      expect(h.bankDocs().get(before)!.metadata.source_path).toBe("wiki/topics/business/kestrel-playbook.md");
      expect(h.bankDocs().get("n-proposal-terms")!.metadata.source_path).toBe("wiki/entities/terms/proposal-terms-v2.md");
      expect(h.fake.calls.filter((c) => c.method === "DELETE").length).toBe(0);
      const rec = await h.api.recall(usman, "Kestrel clinic answers calls weekdays");
      expect(rec.facts.filter((f) => f.id === before)).toHaveLength(1);
    },
    T,
  );
});

describe("7 · deletion and forgetting", () => {
  test(
    "(a) remove from index: retracted from Hindsight, the note stays, sync never re-adds it, re-include restores it",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const r = await h.api.forget(usman, { kind: "unindex", target: "wiki/topics/business/proposal-terms.md" });
      if (!r.ok) throw new Error(r.message);
      expect(r.limits).toEqual([]);
      expect(r.message).toContain("stays in the vault");
      expect(existsSync(join(h.vault, "wiki/topics/business/proposal-terms.md"))).toBe(true);
      expect(h.bankDocs().has("n-proposal-terms")).toBe(false);
      await h.api.sync({ force: true });
      expect(h.bankDocs().has("n-proposal-terms")).toBe(false);
      expect((await h.api.recall(usman, "Osprey proposals valid")).facts.map((f) => f.id)).not.toContain("n-proposal-terms");
      expect(h.api.list().find((x) => x.id === "n-proposal-terms")?.status).toBe("excluded");
      const back = await h.api.reindex(usman, "n-proposal-terms");
      expect(back.ok).toBe(true);
      expect(h.bankDocs().has("n-proposal-terms")).toBe(true);
    },
    T,
  );

  test(
    "(b) delete a Hindsight-only memory: server-held approval only, single use, tombstone blocks re-capture",
    async () => {
      const h = await setup();
      const m = await h.api.remember(usman, { text: "The synthetic Finch account renews in March.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      const ask = await h.api.forget(usman, { kind: "memory", target: m.memory.id });
      if (ask.ok || ask.code !== "approval-required" || !ask.approval) throw new Error("expected approval-required");
      expect(ask.plan?.derived.memories).toEqual([m.memory.id]);
      expect(h.bankDocs().has(m.memory.id)).toBe(true);
      // A client can't assert approval: an invented id is denied, an ungranted real one stays pending.
      const forged = await h.api.forget(usman, { kind: "memory", target: m.memory.id, approval_id: "apr-client-says-yes" });
      expect(!forged.ok && forged.code).toBe("approval-denied");
      const early = await h.api.forget(usman, { kind: "memory", target: m.memory.id, approval_id: ask.approval.id });
      expect(!early.ok && early.code).toBe("approval-required");
      // The tool surface can ask but never approve.
      const tool = await runMemoryTool(h.api, usman, "forget_memory", { id: m.memory.id, kind: "memory", approval_id: ask.approval.id, confirm: true });
      expect(tool.ok).toBe(false);
      expect(h.bankDocs().has(m.memory.id)).toBe(true);

      // One shared pool: the other founder may approve a person's own UI request with the card in HIS
      // browser session; the server then runs exactly that forget (Track 6, B2's service).
      const g = await h.approveUi(h.api, ask.approval.id, mehroz);
      if (!g.ok) throw new Error(g.reason);
      expect(g.approval.granted_by).toBe("mehroz");
      const done = g.result as ForgetResult;
      if (!done.ok) throw new Error(done.message);
      expect(done.hindsight).toBe("confirmed");
      expect(h.bankDocs().has(m.memory.id)).toBe(false);
      expect(allText(h.state)).not.toContain("Finch account renews");
      expect(done.limits.join(" ")).toContain("backups");
      const replay = await h.api.forget(usman, { kind: "memory", target: m.memory.id, approval_id: ask.approval.id });
      expect(replay.ok).toBe(false);
      const again = await h.api.remember(usman, { text: "The synthetic Finch account renews in March.", channel: "voice" });
      expect(!again.ok && again.code).toBe("previously-forgotten");
    },
    T,
  );

  test(
    "(c) full forget of a vault fact: plan covers source + derived copies, approval is digest-bound, the note section goes, tombstones stop resurrection",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      // A derived copy: a memory later moved into the vault.
      const m = await h.api.remember(usman, { text: "Synthetic Merlin retainers are billed on the 3rd.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      const v = await h.api.saveToVault(usman, { from_memory: m.memory.id, channel: "voice" });
      if (!v.ok) throw new Error(v.message);
      const ref = v.fact.wiki_ref;
      const rel = "wiki/topics/business/memory-business-shared.md";
      const original = read(h.vault, rel);

      const ask = await h.api.forget(usman, { kind: "full", target: ref });
      if (ask.ok || !ask.approval || !ask.plan) throw new Error("expected approval-required");
      expect(ask.plan.source?.path).toBe(rel);
      expect(ask.plan.derived.hindsight_docs).toEqual([ref]);
      expect(ask.plan.derived.memories).toEqual([m.memory.id]);

      // The note changes before the approval runs: the digest no longer matches, the approval is voided
      // and nothing is removed.
      write(h.vault, rel, read(h.vault, rel) + "\nA hand edit in Obsidian.\n");
      const stale = await h.approveUi(h.api, ask.approval.id, usman);
      if (!stale.ok) throw new Error(stale.reason);
      expect(!stale.result.ok && stale.result.code).toBe("approval-denied");
      expect(h.api.approvals.get(ask.approval.id)?.state).toBe("cancelled");
      expect(read(h.vault, rel)).toContain("Merlin retainers");

      const ask2 = await h.api.forget(usman, { kind: "full", target: ref });
      if (ask2.ok || !ask2.approval) throw new Error("expected approval-required");
      const g2 = await h.approveUi(h.api, ask2.approval.id, usman);
      if (!g2.ok) throw new Error(g2.reason);
      const done = g2.result as ForgetResult;
      if (!done.ok) throw new Error(done.message);
      expect(h.api.approvals.get(ask2.approval.id)).toMatchObject({ state: "consumed", outcome: "succeeded", granted_via: "ui" });
      expect(done.removed.vault).toBe(`${rel}#^${ref}`);
      expect(done.removed.memories).toEqual([m.memory.id]);
      expect(done.hindsight).toBe("confirmed");
      expect(read(h.vault, rel)).not.toContain("Merlin retainers");
      expect(read(h.vault, rel)).toContain("A hand edit in Obsidian."); // only the section went
      expect(read(h.vault, rel)).toContain("mf-00000000a1");
      expect(h.bankDocs().has(ref)).toBe(false);
      expect(h.api.item(m.memory.id)).toBeNull();
      expect(allText(h.state)).not.toContain("Merlin retainers");
      expect(done.limits.join(" ")).toContain("Git");
      expect(done.limits.join(" ")).toContain("backups");

      // A Git revert brings the section back: tombstones keep it out of the index.
      write(h.vault, rel, original);
      const s = await h.api.sync({ force: true });
      expect(h.bankDocs().has(ref)).toBe(false);
      expect((await h.api.recall(usman, "Merlin retainers billed")).facts).toHaveLength(0);
      expect(s.status.skipped.find((x) => x.reason === "forgotten (tombstoned)")?.count).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  test(
    "(c) full forget of one heading section: the section leaves the note and Hindsight's copy is purged then re-sent",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const rel = "wiki/topics/business/receptionist-playbook.md";
      const noteId = h.api.connector.store.readNotes()[rel].id;
      expect(h.bankDocs().get(noteId)!.content).toContain("duty dentist");
      const ask = await h.api.forget(usman, { kind: "full", target: rel, heading: "Escalation" });
      if (ask.ok || !ask.approval) throw new Error("expected approval-required");
      const g = await h.approveUi(h.api, ask.approval.id, usman);
      if (!g.ok) throw new Error(g.reason);
      const done = g.result as ForgetResult;
      if (!done.ok) throw new Error(done.message);
      expect(read(h.vault, rel)).not.toContain("duty dentist");
      expect(read(h.vault, rel)).toContain("## Opening hours");
      const calls = h.fake.calls.map((c) => `${c.method} ${c.path}`);
      const del = calls.lastIndexOf(`DELETE /v1/default/banks/syn-connector/documents/${noteId}`);
      expect(del).toBeGreaterThan(-1);
      expect(calls.slice(del).some((c) => c.startsWith("POST") && c.endsWith("/memories"))).toBe(true);
      expect(h.bankDocs().get(noteId)!.content).not.toContain("duty dentist");
      // Restored section: never indexed again.
      write(h.vault, rel, read(h.vault, rel) + "\n## Escalation\n\nUrgent synthetic callers are offered a callback from the duty dentist within 15 minutes.\n");
      await h.api.sync({ force: true });
      expect(h.bankDocs().get(noteId)!.content).not.toContain("duty dentist");
    },
    T,
  );

  test("bulk forget is impossible: one target, no wildcard, no clear route", async () => {
    const h = await setup();
    for (const target of ["*", "mem-a,mem-b", "", "wiki/**"]) {
      const r = await h.api.forget(usman, { kind: "memory", target });
      expect(!r.ok && r.code).toBe("invalid");
    }
    const api = h.api as unknown as Record<string, unknown>;
    for (const name of ["clear", "clearBank", "deleteAll", "forgetAll", "bulkDelete"]) expect(api[name]).toBeUndefined();
    const client = h.api.connector.client as unknown as Record<string, unknown>;
    for (const name of ["clearBank", "deleteBank", "deleteMemories", "reflect"]) expect(client[name]).toBeUndefined();
  });
});

function call(principalFor: () => typeof usman | null, api: ReturnType<typeof Object>, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const mw = memoryMiddleware({ api: () => api as never, principalFor });
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { host: "localhost:8081", "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  });
  return new Promise<{ status: number; body: any }>((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(b: string) {
        resolve({ status: this.statusCode, body: JSON.parse(b) });
      },
    };
    mw(req as never, res as never, () => resolve({ status: 404, body: { error: "no route" } }));
  });
}

describe("8 · unauthenticated requests fail", () => {
  test("no verified principal → 401 on every route; Host headers and body names don't help", async () => {
    const h = await setup();
    const nobody = () => null;
    for (const [m, u, b] of [
      ["GET", "/status"],
      ["GET", "/items"],
      ["POST", "/remember", { text: "Synthetic fact.", principal: usman, person: "usman" }],
      ["POST", "/recall", { query: "anything" }],
      ["POST", "/forget", { kind: "memory", target: "mem-0000000000", approval_id: "x", confirm: true }],
      ["POST", "/approvals/grant", { approval_id: "x" }],
    ] as const) {
      const r = await call(nobody, h.api, m, u, b, { host: "localhost", "x-owner": "usman" });
      expect(r.status).toBe(401);
    }
    expect(h.api.status().counts.memories).toBe(0);
    const ok = await call(() => usman, h.api, "GET", "/status");
    expect(ok.status).toBe(200);
    expect(ok.body.principal.name).toBe("Usman");
    // No bulk or clear route exists.
    for (const u of ["/clear", "/bank/clear", "/forget-all", "/memories"]) expect((await call(() => usman, h.api, "POST", u, {})).status).toBe(404);
    // A client "confirm" flag never forgets anything.
    const m = await h.api.remember(usman, { text: "The synthetic Tern account uses PDF invoices.", channel: "ui" });
    const r = await call(() => usman, h.api, "POST", "/forget", { kind: "memory", target: m.ok ? m.memory.id : "", confirm: true, approved: true });
    expect(r.status).toBe(202);
    expect(r.body.code).toBe("approval-required");
    expect(h.bankDocs().has(m.ok ? m.memory.id : "")).toBe(true);
  });
});

describe("9 · outages recover without lost or duplicated changes", () => {
  test(
    "while Hindsight is down: capture, edit, delete, correct all queue; a restart keeps the queue; replay converges exactly",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      await h.fake.down();

      const a = await h.api.remember(usman, { text: "The synthetic Ibis clinic has three chairs.", channel: "voice" });
      if (!a.ok) throw new Error(a.message);
      expect(a.destination.indexed).toBe("queued");
      expect(a.message).toContain("queued for Hindsight");
      const rel = "wiki/topics/business/proposal-terms.md";
      write(h.vault, rel, read(h.vault, rel).replace("21 days", "45 days"));
      rmSync(join(h.vault, "wiki/concepts/call-recording-consent.md"));
      const c = await h.api.correct(usman, a.memory.id, { text: "The synthetic Ibis clinic has four chairs.", channel: "voice" });
      if (!c.ok) throw new Error(c.message);
      await h.api.sync({ force: true });
      const st = h.api.status();
      expect(st.hindsight).toBe("unavailable");
      expect(st.pending).toBeGreaterThanOrEqual(3);
      expect(st.errors.length).toBeGreaterThan(0);
      // Recall still answers from the local index and says Hindsight is unavailable (not "no results").
      const rec = await h.api.recall(usman, "Ibis clinic chairs");
      expect(rec.hindsight).toBe("unavailable");
      expect(rec.facts[0].id).toBe(c.id);

      // Restart while still down: the journal is on disk.
      const restarted = h.make();
      expect(restarted.status().pending).toBe(st.pending);

      await h.fake.up();
      const after = await restarted.sync({ force: true });
      expect(after.status.pending).toBe(0);
      expect(after.status.errors).toEqual([]);
      const want = [...restarted.connector.desired().keys()].sort();
      expect([...h.bankDocs().keys()].sort()).toEqual(want);
      expect(h.bankDocs().has(a.memory.id)).toBe(false);
      expect(h.bankDocs().get(c.id)?.retains).toBe(1);
      expect(h.bankDocs().get("n-proposal-terms")!.content).toContain("45 days");
      expect([...h.bankDocs().values()].some((d) => d.metadata.source_path === "wiki/concepts/call-recording-consent.md")).toBe(false);
    },
    T,
  );

  test(
    "a retain applied but whose response was lost is replayed to the same document_id (no duplicate)",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      h.fake.loseRetainResponses(1);
      const m = await h.api.remember(usman, { text: "The synthetic Gannet account pays quarterly.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(m.destination.indexed).toBe("queued");
      expect(h.api.connector.store.readIndex()[m.memory.id]?.inflight).toBe(true);
      await h.api.sync({ force: true });
      expect(h.bankDocs().get(m.memory.id)!.retains).toBe(2);
      expect([...h.bankDocs().keys()].filter((k) => k === m.memory.id)).toHaveLength(1);
      expect(h.api.connector.indexState(m.memory.id)).toBe("confirmed");
      // 503 is an outage too.
      h.fake.setMode("503");
      const n = await h.api.remember(usman, { text: "The synthetic Shag account pays monthly.", channel: "voice" });
      expect(n.ok && n.destination.indexed).toBe("queued");
      h.fake.setMode("up");
      await h.api.sync({ force: true });
      expect(n.ok && h.bankDocs().has(n.memory.id)).toBe(true);
    },
    T,
  );
});

describe("11 · usage is recorded", () => {
  test(
    "a receipt per Hindsight call: op, latency, outcome, tokens when Hindsight reports them (else null); the key never leaks",
    async () => {
      const h = await setup();
      await h.api.sync({ force: true });
      const m = await h.api.remember(usman, { text: "The synthetic Petrel account wants Monday reports.", channel: "voice" });
      await h.api.recall(usman, "Petrel reports");
      if (m.ok) {
        const ask = await h.api.forget(usman, { kind: "memory", target: m.memory.id });
        if (!ask.ok && ask.approval) await h.approveUi(h.api, ask.approval.id, usman);
      }
      const receipts = h.api.connector.store.readReceipts();
      const ops = new Set(receipts.map((r) => r.op));
      expect([...ops].sort()).toEqual(["delete", "recall", "receipts", "retain"]);
      for (const r of receipts) {
        expect(typeof r.latency_ms).toBe("number");
        expect(r.outcome).toBe("ok");
        expect(r.bank).toBe("syn-connector");
        expect(r.cost).toEqual({ basis: "see-processing", cash_usd: null });
      }
      expect(receipts.filter((r) => r.op === "retain").every((r) => r.tokens && r.tokens.total > 0)).toBe(true);
      expect(receipts.filter((r) => r.op !== "retain").every((r) => r.tokens === null)).toBe(true);
      const u = h.api.usage();
      expect(u.by_op.retain.tokens_known).toBeGreaterThan(0);
      expect(u.by_op.recall.tokens_unknown_calls).toBeGreaterThan(0);
      expect(allText(h.state)).not.toContain(SYNTHETIC_KEY);
      expect(JSON.stringify(h.api.status())).not.toContain(SYNTHETIC_KEY);
      expect(h.fake.calls.every((c) => c.auth)).toBe(true);
    },
    T,
  );

  test("outage receipts say unavailable, and an auth failure is reported, not retried blindly", async () => {
    const h = await setup();
    await h.fake.down();
    await h.api.remember(usman, { text: "The synthetic Skua clinic opens Saturdays.", channel: "voice" });
    expect(h.api.connector.store.readReceipts().some((r) => r.outcome === "unavailable" && r.http_status === null)).toBe(true);
    await h.fake.up();
    const wrong = h.make({ HINDSIGHT_API_KEY: "synthetic-wrong-key" });
    await wrong.sync({ force: true });
    expect(wrong.status().hindsight).toBe("auth-failed");
    expect(wrong.status().pending).toBeGreaterThan(0);
  });
});

describe("hardening (independent review, 28 Sep)", () => {
  test("an automated caller can't approve; the page's grant needs the page token when configured", async () => {
    const h = await setup();
    const m = await h.api.remember(usman, { text: "The synthetic Avocet account wants invoices in AUD.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    const ask = await h.api.forget(usman, { kind: "memory", target: m.memory.id });
    if (ask.ok || !ask.approval) throw new Error("expected approval");
    const bot = { id: "hermes", name: "Hermes", via: "system" as const };
    expect((await h.api.approvals.grant(ask.approval.id, bot, "ui", { cardNonce: "x" })).ok).toBe(false);
    expect(h.api.approvals.card(ask.approval.id, bot)).toBeNull();
    // With a page token configured, the card and the grant both need it; the grant also needs the card's
    // nonce (B2's uiConfirm): the page token alone approves nothing.
    const gated = memoryMiddleware({ api: () => h.api, principalFor: () => usman, grantToken: () => "synthetic-page-token" });
    const send = (url: string, body: Record<string, unknown>, headers: Record<string, string>) =>
      new Promise<{ status: number; body: any }>((resolve) => {
        const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
          method: "POST",
          url,
          headers: { host: "localhost:8081", "content-type": "application/json", ...headers },
          socket: { remoteAddress: "127.0.0.1" },
        });
        gated(
          req as never,
          { statusCode: 200, setHeader() {}, end(b: string) { resolve({ status: this.statusCode, body: JSON.parse(b || "{}") }); } } as never,
          () => resolve({ status: 404, body: null }),
        );
      });
    const tok = { "x-claude-os-token": "synthetic-page-token" };
    expect((await send("/approvals/card", { approval_id: ask.approval.id }, {})).status).toBe(403);
    expect((await send("/approvals/grant", { approval_id: ask.approval.id }, { "x-claude-os-token": "wrong" })).status).toBe(403);
    expect((await send("/approvals/grant", { approval_id: ask.approval.id }, tok)).status).toBe(403); // token, no card
    const card = await send("/approvals/card", { approval_id: ask.approval.id }, tok);
    expect(card.status).toBe(200);
    const granted = await send("/approvals/grant", { approval_id: ask.approval.id, card_nonce: card.body.card_nonce }, tok);
    expect(granted.status).toBe(200);
    expect(granted.body.result.ok).toBe(true); // the approved forget ran
    expect((await send("/approvals/grant", { approval_id: ask.approval.id, card_nonce: card.body.card_nonce }, tok)).status).not.toBe(200); // replay
  });

  test("an approval survives a background sync between the plan and the yes", async () => {
    const h = await setup();
    await h.fake.down();
    const m = await h.api.remember(usman, { text: "The synthetic Curlew clinic closes at noon on Saturdays.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    const ask = await h.api.forget(usman, { kind: "memory", target: m.memory.id });
    if (ask.ok || !ask.approval) throw new Error("expected approval");
    await h.fake.up();
    await h.api.sync({ force: true }); // the memory is now confirmed in Hindsight
    const g = await h.approveUi(h.api, ask.approval.id, usman);
    expect(g.ok && g.result.ok).toBe(true);
    expect(h.bankDocs().has(m.memory.id)).toBe(false);
  });

  test("a corrupt store file fails loudly instead of being treated as empty", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    writeFileSync(join(h.state, "tombstones.json"), "{not json");
    expect(() => h.api.connector.desired()).toThrow();
  });

  test("Hindsight state is 'unknown' until something has actually talked to it", async () => {
    const h = await setup();
    expect(h.api.status().hindsight).toBe("unknown");
    await h.api.recall(usman, "anything synthetic");
    expect(h.api.status().hindsight).toBe("ok");
  });
});
