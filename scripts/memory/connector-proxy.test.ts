// Stage D (28 Sep 2026): the connector through the client proxy's contract (scripts/hindsight/proxy.py),
// against the FAKE Hindsight in proxy mode: no key, approval-signed deletes, the proxy's own write gate,
// the per-save model record (llm_requests receipts) and the mass-removal hold. TEMP synthetic vault only.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BULK_RETRACT_LIMIT } from "./connector";
import { localApprovals } from "./approvals";
import { allText, cleanup, setup, SYNTHETIC_APPROVAL_SECRET, usman } from "./testing/harness";

afterEach(cleanup);
const T = { timeout: 30_000 };

describe("Stage D · through the proxy contract", () => {
  test(
    "no key is sent; every save records which model processed it; the UI row carries it",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      expect(h.fake.calls.every((c) => !c.auth)).toBe(true);
      const m = await h.api.remember(usman, { text: "The synthetic Plover clinic opens at 7:30am.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(m.destination.indexed).toBe("confirmed");
      const row = h.api.item(m.memory.id)!.row;
      expect(row.processed_by).toMatchObject({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", basis: "metered", fallback_from: [] });
      const st = h.api.status();
      expect(st.models["openrouter/deepseek/deepseek-v4.1-flash"]).toBeGreaterThan(1); // the initial sync + this save
      expect(st.recent[0]).toMatchObject({ doc_id: m.memory.id, op: "retain", outcome: "ok", attempt: 1 });
      expect(st.settings.mode).toBe("on");
    },
    T,
  );

  test(
    "automatic fallback is recorded: the failed primary and the model that actually processed it",
    async () => {
      const h = await setup({ proxy: true });
      h.fake.setModels([
        { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", fails: true },
        { provider: "groq", model: "openai/gpt-oss-120b" },
      ]);
      const m = await h.api.remember(usman, { text: "The synthetic Avocet account pays on the 5th.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(h.api.item(m.memory.id)!.row.processed_by).toMatchObject({
        provider: "groq",
        model: "openai/gpt-oss-120b",
        basis: "free",
        fallback_from: [{ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" }],
        calls: 2,
      });
    },
    T,
  );

  test(
    "deletes carry a proxy approval token: routine retract for a correction, the approval id for a forget; an unsigned delete is refused and stays queued",
    async () => {
      const h = await setup({ proxy: true });
      const m = await h.api.remember(usman, { text: "The synthetic Tern clinic closes at 5pm.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      const c = await h.api.correct(usman, m.memory.id, { text: "The synthetic Tern clinic closes at 6pm.", channel: "voice" });
      if (!c.ok) throw new Error(c.message);
      const retract = h.fake.calls.find((x) => x.method === "DELETE" && x.path.endsWith(`/documents/${m.memory.id}`));
      expect(retract?.status).toBe(200);
      expect(retract?.approval).toMatch(/^rt-/);
      expect(h.bankDocs().has(m.memory.id)).toBe(false);

      const ask = await h.api.forget(usman, { kind: "memory", target: c.id });
      if (ask.ok || !ask.approval) throw new Error("expected approval-required");
      const g = await h.approveUi(h.api, ask.approval.id, usman);
      expect(g.ok && g.result.ok).toBe(true);
      const del = h.fake.calls.find((x) => x.method === "DELETE" && x.path.endsWith(`/documents/${c.id}`));
      expect(del?.approval?.startsWith(`${ask.approval.id}-`)).toBe(true);
      expect(h.bankDocs().has(c.id)).toBe(false);
      expect(h.api.status().recent.find((r) => r.doc_id === c.id && r.op === "retract")?.authority).toBe("forget");

      // Without the secret the delete goes unsigned: the proxy refuses it, nothing is lost, it stays queued.
      const n = await h.api.remember(usman, { text: "The synthetic Gannet account renews in May.", channel: "voice" });
      if (!n.ok) throw new Error(n.message);
      rmSync(h.env.HINDSIGHT_APPROVAL_SECRET_FILE);
      const noSecret = h.make();
      const c2 = await noSecret.correct(usman, n.memory.id, { text: "The synthetic Gannet account renews in June.", channel: "voice" });
      expect(c2.ok).toBe(true);
      expect(h.bankDocs().has(n.memory.id)).toBe(true); // the old version is still there (refused, not lost)
      const st = noSecret.status();
      expect(st.pending_ops.some((o) => o.op === "retract" && o.doc_id === n.memory.id)).toBe(true);
      expect(st.errors.find((e) => e.doc_id === n.memory.id)?.error).toContain("refused the delete's approval");
      // Recall never shows the superseded version even while its retract is queued.
      const r = await noSecret.recall(usman, "Gannet account renews");
      expect(r.facts.map((f) => f.id)).not.toContain(n.memory.id);
      expect(allText(h.state)).not.toContain(SYNTHETIC_APPROVAL_SECRET);
    },
    T,
  );

  test(
    "the proxy's own write gate off: saves stay queued with a clear reason, then land once it is on",
    async () => {
      const h = await setup({ proxy: true });
      h.fake.setProxyWrites(false);
      const m = await h.api.remember(usman, { text: "The synthetic Shag clinic has free parking.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(m.destination.indexed).toBe("queued");
      const st = h.api.status();
      expect(st.hindsight).toBe("proxy-writes-off");
      expect(st.errors[0]?.error).toContain("write gate is off");
      expect(st.recent[0]).toMatchObject({ outcome: "failed", attempt: 1 });
      h.fake.setProxyWrites(true);
      await h.api.sync({ force: true });
      expect(h.bankDocs().get(m.memory.id)?.retains).toBe(1);
      expect(h.api.status().pending).toBe(0);
      expect(h.api.item(m.memory.id)!.row.indexed).toBe("confirmed");
    },
    T,
  );

  test(
    `a mass removal (more than ${BULK_RETRACT_LIMIT} documents vanishing at once) is held, then released only through an approval`,
    async () => {
      const h = await setup({ proxy: true });
      // A synthetic bulk: many small notes, indexed, then the whole folder vanishes.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const dir = join(h.vault, "wiki", "topics", "business", "bulk");
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < BULK_RETRACT_LIMIT + 5; i++)
        writeFileSync(join(dir, `synthetic-bulk-${i}.md`), `---\ntitle: Synthetic bulk ${i}\n---\n\nSynthetic bulk note number ${i} about the Dotterel test account.\n`);
      await h.api.sync({ force: true });
      const before = h.bankDocs().size;
      rmSync(dir, { recursive: true, force: true });
      await h.api.sync({ force: true });
      expect(h.bankDocs().size).toBe(before); // nothing deleted
      const st = h.api.status();
      expect(st.held?.count).toBe(BULK_RETRACT_LIMIT + 5);
      // Ordinary access can't remove them: release needs a server-held approval.
      const ask = await h.api.releaseHeld(usman, {});
      if (ask.ok || ask.code !== "approval-required" || !ask.approval) throw new Error("expected approval-required");
      const early = await h.api.releaseHeld(usman, { approval_id: ask.approval.id });
      expect(!early.ok && early.code).toBe("approval-required"); // not granted yet
      // The card's button: approved, and the server releases exactly the held set at once.
      const ok = await h.approveUi(h.api, ask.approval.id, usman);
      expect(ok.ok && ok.result.ok).toBe(true);
      await h.api.sync({ force: true });
      expect(h.bankDocs().size).toBe(before - (BULK_RETRACT_LIMIT + 5));
      expect(h.api.status().held).toBeNull();
      // Single use: the same approval can't release anything again.
      const again = await h.api.releaseHeld(usman, { approval_id: ask.approval.id });
      expect(again.ok).toBe(false);
    },
    T,
  );
});

describe("Stage D · approvals are durable (asked once, kept across a restart, used once)", () => {
  test(
    "B2's store: a pending approval survives a restart (a fresh card approves it); an approved one whose run was cut off is used exactly once after a restart; nothing readable is left after",
    async () => {
      const h = await setup({ proxy: true });
      // 1. Pending across a restart: the card nonce was memory-only, so the restarted page renders a new one.
      const m = await h.api.remember(usman, { text: "The synthetic Brolga account pays quarterly.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      const ask = await h.api.forget(usman, { kind: "memory", target: m.memory.id });
      if (ask.ok || !ask.approval) throw new Error("expected approval-required");
      const staleCard = h.api.approvals.card(ask.approval.id, usman)!;
      const restarted = h.make(); // a new process over the same app store
      expect(restarted.approvals.pending().map((a) => a.id)).toContain(ask.approval.id);
      expect((await restarted.approvals.grant(ask.approval.id, usman, "ui", { cardNonce: staleCard.cardNonce })).ok).toBe(false);
      const g = await h.approveUi(restarted, ask.approval.id, usman);
      expect(g.ok && g.result.ok).toBe(true);
      expect(h.bankDocs().has(m.memory.id)).toBe(false);

      // 2. Approved, then the process died before running it: after a restart the approval is still good
      // (until it expires) and is used exactly once.
      const n = await restarted.remember(usman, { text: "The synthetic Jacana account pays monthly.", channel: "voice" });
      if (!n.ok) throw new Error(n.message);
      const ask2 = await restarted.forget(usman, { kind: "memory", target: n.memory.id });
      if (ask2.ok || !ask2.approval) throw new Error("expected approval-required");
      const raw = localApprovals(h.state, { spoken: h.spoken, now: h.clock }); // the approval decided, the run never happened
      const card = raw.card(ask2.approval.id, usman)!;
      expect(raw.grant(ask2.approval.id, usman, "ui", { cardNonce: card.cardNonce }).ok).toBe(true);
      const again = h.make();
      const done = await again.forget(usman, { kind: "memory", target: n.memory.id, approval_id: ask2.approval.id });
      expect(done.ok).toBe(true);
      const replay = await h.make().forget(usman, { kind: "memory", target: n.memory.id, approval_id: ask2.approval.id });
      expect(replay.ok).toBe(false);
      expect(allText(h.state)).not.toContain("Brolga");
      expect(allText(h.state)).not.toContain("Jacana");
    },
    T,
  );
});

describe("Stage D · the rev 3 proxy contract", () => {
  test(
    "the document-delete rate limit queues removals (saves still land), and they finish once it allows",
    async () => {
      const h = await setup({ proxy: true });
      const m = await h.api.remember(usman, { text: "The synthetic Jabiru clinic opens at 10am.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      h.fake.setDeleteLimit(0);
      const c = await h.api.correct(usman, m.memory.id, { text: "The synthetic Jabiru clinic opens at 11am.", channel: "voice" });
      if (!c.ok) throw new Error(c.message);
      expect(h.bankDocs().has(c.id)).toBe(true); // the new version landed
      expect(h.bankDocs().has(m.memory.id)).toBe(true); // the old one waits (limited, not lost)
      const st = h.api.status();
      expect(st.errors.find((e) => e.doc_id === m.memory.id)?.error).toContain("document-delete limit");
      expect((await h.api.recall(usman, "Jabiru clinic opens")).facts.map((f) => f.id)).not.toContain(m.memory.id);
      // Meanwhile no reader gets the old version back: its facts are invalidated in Hindsight.
      expect(h.bankDocs().get(m.memory.id)?.invalidated).toBe(true);
      expect(h.api.status().hindsight).toBe("removals-waiting");
      // A forced sync (every save, "Sync now") doesn't hammer the limit: the removal waits its turn.
      h.fake.setDeleteLimit(20);
      const deletes = () => h.fake.calls.filter((x) => x.method === "DELETE").length;
      const before = deletes();
      for (let i = 0; i < 5; i++) await h.api.sync({ force: true });
      expect(deletes()).toBe(before);
      expect(h.bankDocs().has(m.memory.id)).toBe(true);
      h.advance(11 * 60_000);
      await h.api.sync({ force: true });
      expect(h.bankDocs().has(m.memory.id)).toBe(false);
      expect(h.api.status().pending).toBe(0);
      // Receipts are read with plain query characters (the proxy refuses '%' and ':').
      expect(h.fake.calls.filter((x) => x.path.endsWith("/llm-requests")).every((x) => x.status === 200)).toBe(true);
    },
    T,
  );
});

describe("Stage D · model receipts as Hindsight 0.10.1 tags them", () => {
  test(
    "receipts found through the document's memory unit when document_id isn't tagged",
    async () => {
      const h = await setup({ proxy: true });
      h.fake.setReceiptTagging("memory");
      const m = await h.api.remember(usman, { text: "The synthetic Ibis clinic closes at 4pm on Fridays.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      expect(h.api.item(m.memory.id)!.row.processed_by).toMatchObject({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" });
      expect(h.fake.calls.some((c) => c.path.endsWith("/memories/list"))).toBe(true);
    },
    T,
  );
});

describe("Stage D · honest model records (REVIEW-STAGE-D S1/S3)", () => {
  test(
    "a new version never shows the previous version's model; the per-model count survives log churn",
    async () => {
      const h = await setup({ proxy: true });
      await h.api.sync({ force: true });
      const file = join(h.vault, "wiki", "topics", "business", "proposal-terms.md");
      expect(h.api.item("n-proposal-terms")!.row.processed_by?.model).toBe("deepseek/deepseek-v4.1-flash");
      h.fake.setModels([]); // Hindsight records no receipt for the next save
      writeFileSync(file, readFileSync(file, "utf8").replace("21 days", "28 days"));
      await h.api.sync({ force: true });
      expect(h.api.item("n-proposal-terms")!.row.processed_by ?? null).toBeNull();
      const counted = h.api.status().models["openrouter/deepseek/deepseek-v4.1-flash"];
      expect(counted).toBeGreaterThan(0);
      // 600 failed attempts in the log (the reviewer saw 1,002 refused retries) don't wipe the count.
      for (let i = 0; i < 600; i++) h.api.connector.store.appendProcessing({ at: new Date().toISOString(), doc_id: "mem-0000000000", op: "retract", outcome: "failed", attempt: i + 1, error: "synthetic", processed_by: null, latency_ms: 1 });
      expect(h.api.status().models["openrouter/deepseek/deepseek-v4.1-flash"]).toBe(counted);
      // After the lookup window the unknown one is counted as unknown, not dropped.
      h.advance(16 * 60_000);
      await h.api.sync({ force: true });
      expect(h.api.status().models.unknown).toBe(1);
    },
    T,
  );
});
