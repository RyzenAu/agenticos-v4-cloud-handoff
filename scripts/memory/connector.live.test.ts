// OPTIONAL live run against a REAL local Hindsight (the repair agent's synthetic instance), with a
// TEMP synthetic vault and a fresh synthetic bank `syn-connector-live-…`. Skipped unless
//   MEMORY_LIVE_HINDSIGHT_URL=http://127.0.0.1:8889   (loopback only)
// is set; the API key is read from the env var NAMED by MEMORY_LIVE_KEY_ENV (default
// HINDSIGHT_API_KEY) and never printed; through the synthetic proxy (8879) no key is needed and
// MEMORY_LIVE_APPROVAL_SECRET_FILE names the synthetic approval secret for deletes. It never uses the mu-pilot bank, and it deletes every
// document it created. Retain runs through Hindsight's configured LLM, so it is slow and uses
// that route's allowance; assertions check document state, not LLM wording.
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi } from "./api";
import { loopbackUrl, resolveMemorySettings } from "./settings";
import { FIXTURE, usman } from "./testing/harness";

const URL_ = loopbackUrl(process.env.MEMORY_LIVE_HINDSIGHT_URL);
const KEY_ENV = process.env.MEMORY_LIVE_KEY_ENV || "HINDSIGHT_API_KEY";
const BANK = `syn-connector-live-${randomBytes(3).toString("hex")}`;
const LIVE = !!URL_;
const T = { timeout: 15 * 60_000 };

const base = LIVE ? mkdtempSync(join(tmpdir(), "mu-memory-live-")) : "";
const vault = join(base, "vault");
if (LIVE) cpSync(FIXTURE, vault, { recursive: true });
const env: Record<string, string | undefined> = {
  MU_MEMORY_WRITES: "on",
  HINDSIGHT_URL: URL_ ?? "",
  // Through the synthetic proxy: its approval secret (read by the client at delete time only).
  HINDSIGHT_APPROVAL_SECRET_FILE: process.env.MEMORY_LIVE_APPROVAL_SECRET_FILE,
  HINDSIGHT_BANK: BANK,
  HINDSIGHT_API_KEY: process.env[KEY_ENV],
  MU_WIKI_ROOT: vault,
  MU_WIKI_VAULT_NAME: "mini-wiki",
  MEMORY_STATE_DIR: join(base, "state"),
};
const make = () => createMemoryApi({ settings: resolveMemorySettings(env, base), env, indexWaitMs: 10 * 60_000, timeouts: { retain: 5 * 60_000, recall: 60_000, other: 30_000 } });
const api = LIVE ? make() : null!;
const headers = (): Record<string, string> => (env.HINDSIGHT_API_KEY ? { Authorization: `Bearer ${env.HINDSIGHT_API_KEY}` } : {});
const docText = async (id: string) => {
  const r = await fetch(`${URL_}/v1/default/banks/${BANK}/documents/${encodeURIComponent(id)}`, { headers: headers() });
  return r.status === 404 ? null : String((await r.json())?.original_text ?? "");
};

afterAll(async () => {
  if (!LIVE) return;
  if (!BANK.startsWith("syn-")) throw new Error("refusing to clean a non-synthetic bank");
  const ids = new Set([...Object.keys(api.connector.store.readIndex()), ...api.connector.desired().keys()]);
  for (const id of ids) await api.connector.client!.deleteDocument(id).catch(() => undefined);
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("live Hindsight (synthetic bank)", () => {
  test("health", async () => {
    expect(await api.connector.client!.health()).toBe(true);
  });

  test("1+4 · sync, remember, save to vault, recall with sources", async () => {
    const s = await api.sync({ force: true, waitMs: 10 * 60_000 });
    expect(s.status.pending).toBe(0);
    expect(await docText("n-proposal-terms")).toContain("21 days");
    const m = await api.remember(usman, { text: "The synthetic Kestrel clinic parking is behind gate B.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    expect(m.destination.indexed).toBe("confirmed");
    const rec = await api.recall(usman, "Where is the Kestrel clinic parking?");
    expect(rec.hindsight).toBe("ok");
    expect(rec.facts.map((f) => f.id)).toContain(m.memory.id);
    const v = await api.saveToVault(usman, { text: "Synthetic Osprey invoices are due within 14 days.", bucket: "business", channel: "voice" });
    if (!v.ok) throw new Error(v.message);
    expect(v.destination.indexed).toBe("confirmed");
  }, T);

  test("2 · restart", async () => {
    const again = make();
    const rec = await again.recall(usman, "Kestrel clinic parking");
    expect(rec.facts.length).toBeGreaterThan(0);
  }, T);

  test("3 · an Obsidian edit replaces the document", async () => {
    const rel = "wiki/topics/business/proposal-terms.md";
    writeFileSync(join(vault, rel), readFileSync(join(vault, rel), "utf8").replace("21 days", "30 days"));
    await api.sync({ force: true, waitMs: 10 * 60_000 });
    const t = await docText("n-proposal-terms");
    expect(t).toContain("30 days");
    expect(t).not.toContain("21 days");
  }, T);

  test("5 · correction retracts the old document", async () => {
    const m = await api.remember(usman, { text: "The synthetic Heron studio opens at 8am.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    const c = await api.correct(usman, m.memory.id, { text: "The synthetic Heron studio opens at 9am.", channel: "voice" });
    if (!c.ok) throw new Error(c.message);
    expect(await docText(m.memory.id)).toBeNull();
    expect(await docText(c.id)).toContain("9am");
    const rec = await api.recall(usman, "When does the Heron studio open?");
    expect(rec.facts.map((f) => f.id)).not.toContain(m.memory.id);
  }, T);

  test("6 · rename keeps one document", async () => {
    const id = api.connector.store.readNotes()["wiki/topics/business/receptionist-playbook.md"].id;
    renameSync(join(vault, "wiki/topics/business/receptionist-playbook.md"), join(vault, "wiki/topics/business/kestrel-playbook.md"));
    const s = await api.sync({ force: true, waitMs: 10 * 60_000 });
    expect(s.renames.map((r) => r.id)).toContain(id);
    expect(await docText(id)).not.toBeNull();
  }, T);

  test("7 · the three forget kinds", async () => {
    const un = await api.forget(usman, { kind: "unindex", target: "n-proposal-terms" });
    expect(un.ok).toBe(true);
    expect(await docText("n-proposal-terms")).toBeNull();
    const m = await api.remember(usman, { text: "The synthetic Finch account renews in March.", channel: "voice" });
    if (!m.ok) throw new Error(m.message);
    const ask = await api.forget(usman, { kind: "memory", target: m.memory.id });
    if (ask.ok || !ask.approval) throw new Error("expected approval");
    api.approvals.grant(ask.approval.id, usman);
    expect((await api.forget(usman, { kind: "memory", target: m.memory.id, approval_id: ask.approval.id })).ok).toBe(true);
    expect(await docText(m.memory.id)).toBeNull();
    const ask2 = await api.forget(usman, { kind: "full", target: "mf-00000000a1" });
    if (ask2.ok || !ask2.approval) throw new Error("expected approval");
    api.approvals.grant(ask2.approval.id, usman);
    expect((await api.forget(usman, { kind: "full", target: "mf-00000000a1", approval_id: ask2.approval.id })).ok).toBe(true);
    expect(await docText("mf-00000000a1")).toBeNull();
  }, T);

  test("9 · a wrong key fails closed and queues", async () => {
    const bad = createMemoryApi({ settings: resolveMemorySettings({ ...env, HINDSIGHT_API_KEY: "synthetic-wrong-key", MEMORY_STATE_DIR: join(base, "state-bad") }, base), env: { ...env, HINDSIGHT_API_KEY: "synthetic-wrong-key" } });
    const r = await bad.remember(usman, { text: "The synthetic Skua clinic opens Saturdays.", channel: "voice" });
    // Only meaningful when the server enforces a key.
    if (env.HINDSIGHT_API_KEY) expect(r.ok && r.destination.indexed).toBe("queued");
  }, T);

  test("11 · usage receipts", async () => {
    const rs = api.connector.store.readReceipts();
    expect(rs.some((r) => r.op === "retain" && r.outcome === "ok")).toBe(true);
    expect(rs.every((r) => typeof r.latency_ms === "number")).toBe(true);
    expect(JSON.stringify(rs)).not.toContain(String(env.HINDSIGHT_API_KEY || "\u0000"));
  }, T);
});
