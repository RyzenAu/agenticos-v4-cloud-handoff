/**
 * The Obsidian ⇄ Hindsight sync connector.
 *
 * Desired state  = documents from permitted vault notes (scan) + current Hindsight-only memories,
 *                  minus exclusions ("remove from index") and tombstones (forgotten).
 * Confirmed state = what Hindsight is known to hold (index.json), written only after Hindsight
 *                  answers, with an `inflight` write-ahead mark before each upsert.
 * The outbox is the durable journal of the difference: upserts (document_id = note id, fact
 * ref or mem- id; same id replaces) and retracts (document delete; 404 counts as done).
 *
 * Why nothing is lost or duplicated across an outage or crash: desired and confirmed state are
 * both on disk, the outbox is recomputed from them, upserts are idempotent per document_id,
 * a retract of an absent document is a no-op, and an interrupted upsert is retried (or
 * retracted if its source went away) because its inflight mark survives the crash.
 *
 * No circular writes: the connector never writes to the vault. Only an explicit "save to the
 * vault", a correction of a vault fact, or an approved full forget (api.ts) edit a note.
 */
import { sha256 } from "./derived";
import { HindsightError, createHindsightClient, type HindsightRecallHit } from "./hindsight-client";
import type { MemorySettings } from "./settings";
import { createStore, type IndexEntry } from "./store";
import { assignNoteIds, extractDocs, scanVault, type Skip } from "./vault";
import type { HindsightState, IndexDoc, IndexState, MemoryRecord, OutboxOp, ProcessedBy, SyncStatus } from "./types";

export type ConnectorOptions = {
  settings: MemorySettings;
  now?: () => Date;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeouts?: { retain?: number; recall?: number; other?: number };
  /** Hindsight health probe (L2): how long a result is reused, and the probe's own timeout. */
  health?: { ttlMs?: number; timeoutMs?: number };
};

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
/**
 * More documents than this vanishing from the vault at once (not forgotten, not unindexed, not a
 * correction) is held instead of retracted: a deleted folder, a moved vault or a wrong MU_WIKI_ROOT
 * must never become a bulk delete in Hindsight. Released only through an approval (api.releaseHeld).
 */
export const BULK_RETRACT_LIMIT = 20;
/** A rate-limited delete waits this long before any retry (the proxy's window is an hour). */
export const RATE_LIMIT_WAIT_MS = 10 * 60_000;
/** How long to keep looking for a save's model receipt (Hindsight writes it just after the retain). */
const MODEL_LOOKUP_MS = 15 * 60_000;

/** A change to any of these re-sends the document (a rename re-sends with the new path). */
export function syncKey(doc: IndexDoc) {
  const path = doc.source.kind === "vault" ? doc.source.path : doc.source.id;
  return sha256([doc.version_hash, path, doc.title, doc.bucket, doc.kind, String(doc.version)].join("|"));
}

export function memoryDoc(m: MemoryRecord): IndexDoc {
  return {
    id: m.id,
    kind: "memory",
    origin: m.origin,
    title: m.title,
    content: m.text,
    bucket: m.bucket,
    version: m.version,
    version_hash: sha256(`${m.title}\n${m.text}`),
    updated: m.created,
    source: { kind: "memory", id: m.id },
    actor: m.actor.name,
    chain: m.chain,
  };
}

export function createConnector(options: ConnectorOptions) {
  const { settings } = options;
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const store = createStore(settings.stateDir, settings.vaultRoot);
  const hs = settings.hindsight;
  const client =
    hs.enabled && hs.url
      ? createHindsightClient({
          url: hs.url,
          bank: hs.bank,
          apiKeyEnv: hs.apiKeyEnv,
          approvalSecretFile: hs.approvalSecretFile,
          // Only the writer registers the per-process writer capability with the proxy (Track 6).
          writer: settings.writes,
          env: options.env,
          fetch: options.fetch,
          now,
          onReceipt: store.appendReceipt,
          timeouts: options.timeouts,
        })
      : null;
  let hsLast: HindsightState | null = null;

  // ── Hindsight health (L2, 29 Sep) ───────────────────────────────────────────────────
  // Nothing used to probe Hindsight, so until a recall or a save ran the status said "not checked
  // yet" even while the pilot was up. status() now starts a GET <hindsight_url>/health in the
  // background (through the proxy when that's the URL), reuses the answer for ~60 s, and never waits
  // for it: before the first probe completes the answer is "not-checked". No receipt is written.
  const healthTtl = options.health?.ttlMs ?? 60_000;
  const healthTimeout = options.health?.timeoutMs ?? 2_500;
  let health: { state: "connected" | "down"; at: string } | null = null;
  let healthProbe: Promise<void> | null = null;
  function probeHealth(): Promise<void> {
    if (!hs.enabled || !hs.url) return Promise.resolve();
    if (healthProbe) return healthProbe;
    if (health && now().getTime() - Date.parse(health.at) < healthTtl) return Promise.resolve();
    const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const url = `${hs.url.replace(/\/+$/, "")}/health`;
    healthProbe = (async () => {
      let ok = false;
      try {
        // Same auth as every other Hindsight call (a direct instance may want the key; the proxy doesn't).
        const key = (options.env ?? process.env)[hs.apiKeyEnv];
        const headers: Record<string, string> = { Accept: "application/json" };
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(healthTimeout) });
        ok = res.ok;
        await res.body?.cancel().catch(() => undefined);
      } catch {
        ok = false;
      }
      health = { state: ok ? "connected" : "down", at: iso() };
    })().finally(() => {
      healthProbe = null;
    });
    return healthProbe;
  }
  function hindsightHealth(): "connected" | "down" | "not-checked" | "disabled" {
    if (!hs.enabled || !hs.url) return "disabled";
    void probeHealth();
    return health?.state ?? "not-checked";
  }
  const baseState = (): HindsightState => (hs.enabled ? "ok" : settings.mode === "off" || /HINDSIGHT_URL is off/.test(hs.reason ?? "") ? "disabled" : "misconfigured");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ── mass-removal hold ─────────────────────────────────────────────────────────────────
  /** Retracts nobody decided: the document simply vanished from the vault (not forgotten, unindexed, corrected or a memory). */
  function vanishedRetracts(outbox: OutboxOp[]): string[] {
    const stones = new Set(store.readTombstones().map((t) => t.id));
    const excluded = new Set(store.readExclusions().map((e) => e.id));
    const memories = new Set(store.readMemories().map((m) => m.id));
    const vault = new Set(store.readVaultDocs().map((d) => d.id));
    return outbox.filter((o) => o.op === "retract" && !stones.has(o.doc_id) && !excluded.has(o.doc_id) && !memories.has(o.doc_id) && !vault.has(o.doc_id)).map((o) => o.doc_id);
  }
  function heldNow(outbox: OutboxOp[] = store.readOutbox()) {
    const ids = vanishedRetracts(outbox).sort();
    // Held: more than the limit at once, or (for a small vault) at least half of what is indexed.
    const indexedVault = Object.keys(store.readIndex()).filter((id) => !id.startsWith("mem-")).length;
    if (ids.length <= BULK_RETRACT_LIMIT && !(ids.length >= 3 && ids.length * 2 >= indexedVault)) return null;
    const digest = sha256(`bulk-retract|${ids.join("|")}`);
    if (store.readHeld().released_digest === digest) return null;
    const since = outbox.filter((o) => ids.includes(o.doc_id)).map((o) => o.enqueued_at).sort()[0] ?? iso();
    return { ids, digest, since };
  }
  /** Why a retract is allowed: a routine retract, or the approved forget that tombstoned it. */
  function authorityFor(docId: string): { kind: "routine" } | { kind: "forget"; approvalId: string } {
    const stone = store.readTombstones().find((t) => t.id === docId && t.approval_id);
    return stone?.approval_id ? { kind: "forget", approvalId: stone.approval_id } : { kind: "routine" };
  }

  /** The per-model count lives in status.json, so nothing (log rotation, failed retries) can wipe it. */
  function tally(key: string) {
    const st = store.readStatus();
    store.writeStatus({ ...st, models: { ...(st.models ?? {}), [key]: (st.models?.[key] ?? 0) + 1 } });
  }

  // ── which model processed a save ─────────────────────────────────────────────────────
  async function lookUpModel(docId: string, since: string, waits: number[]): Promise<ProcessedBy | null> {
    if (!client) return null;
    // A second of slack either side of the retain; receipts are written just after it returns.
    const from = new Date(Date.parse(since) - 2000).toISOString();
    for (const w of waits) {
      if (w) await sleep(w);
      try {
        const m = await client.processedBy(docId, from);
        if (m) return m;
      } catch {
        return null; // the receipt read is best-effort; the save itself already succeeded
      }
    }
    return null;
  }
  /** Retry receipt reads for recent saves that didn't have one yet. */
  async function resolvePendingModels() {
    if (!client) return;
    const t = now().getTime();
    for (const [id, entry] of Object.entries(store.readIndex())) {
      if (!entry.model_pending) continue;
      const stale = t - Date.parse(entry.model_pending) > MODEL_LOOKUP_MS;
      const m = stale ? null : await lookUpModel(id, entry.model_pending, [0]);
      if (!m && !stale) continue;
      const after = store.readIndex();
      if (!after[id]) continue;
      after[id] = { ...after[id], processed_by: m, model_pending: null };
      store.writeIndex(after);
      tally(m ? `${m.provider}/${m.model}` : "unknown");
    }
  }

  // ── mutation lock (state files are read-modify-write) ────────────────────────────────
  let lock: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  }

  // ── desired state ────────────────────────────────────────────────────────────────────
  function desired(): Map<string, IndexDoc> {
    const exclusions = store.readExclusions();
    const excluded = new Set(exclusions.map((e) => e.id));
    // Also by path, so an "unindex" decision survives whatever happens to the note's id.
    const excludedPaths = new Set(exclusions.flatMap((e) => (e.path ? [e.path] : [])));
    const stones = store.readTombstones();
    const deadIds = new Set(stones.map((t) => t.id));
    const deadHashes = new Set(stones.map((t) => t.content_hash));
    const out = new Map<string, IndexDoc>();
    const add = (d: IndexDoc) => {
      if (out.has(d.id) || deadIds.has(d.id) || excluded.has(d.id)) return;
      if (d.source.kind === "vault" && (excluded.has(d.source.note_id) || (d.kind === "note" && excludedPaths.has(d.source.path)))) return;
      out.set(d.id, d);
    };
    for (const d of store.readVaultDocs()) add(d);
    for (const m of store.readMemories()) if (m.status === "current" && !deadHashes.has(m.content_hash)) add(memoryDoc(m));
    return out;
  }

  // ── scan (vault → desired vault documents) ───────────────────────────────────────────
  let lastRenames: { from: string; to: string; id: string }[] = [];
  function scan() {
    const { notes, skipped } = scanVault(settings.vaultRoot, settings.sync);
    const previous = store.readNotes();
    // A vault that looks empty (unmounted drive, branch switch, sync glitch) is not "every note was
    // deleted": keep what was known and change nothing until notes are back.
    if (!notes.length && Object.values(previous).some((e) => !e.missing_since)) {
      store.writeStatus({ ...store.readStatus(), last_scan_at: iso(), last_error: "The vault looks empty (no notes found), so nothing was removed. Check MU_WIKI_ROOT or the drive." });
      return { notes: 0, docs: store.readVaultDocs().length, renames: [], skipped };
    }
    const { map, renames } = assignNoteIds(notes, previous, now(), new Set(Object.keys(store.readIndex())));
    const stones = store.readTombstones();
    const docs: IndexDoc[] = [];
    const seen = new Set<string>();
    const skips: Skip[] = [...skipped];
    for (const n of notes) {
      const r = extractDocs(n, map[n.path], settings.vaultName, stones);
      skips.push(...r.skipped);
      for (const d of r.docs) {
        if (seen.has(d.id)) {
          skips.push({ path: `${n.path}#${d.id}`, reason: "duplicate id (copied block)" });
          continue;
        }
        seen.add(d.id);
        docs.push(d);
      }
    }
    store.writeNotes(map);
    store.writeVaultDocs(docs);
    const status = store.readStatus();
    store.writeStatus({ ...status, last_scan_at: iso(), skipped: skips });
    lastRenames = renames;
    return { notes: notes.length, docs: docs.length, renames, skipped: skips };
  }

  // ── reconcile (desired vs confirmed → outbox) ────────────────────────────────────────
  function reconcile(): OutboxOp[] {
    const want = desired();
    const index = store.readIndex();
    const previous = new Map(store.readOutbox().map((o) => [`${o.op}:${o.doc_id}`, o]));
    const at = iso();
    const keep = (op: OutboxOp["op"], doc_id: string, version_hash: string | null): OutboxOp => {
      const prev = previous.get(`${op}:${doc_id}`);
      const same = prev && prev.version_hash === version_hash;
      return {
        doc_id,
        op,
        version_hash,
        enqueued_at: prev?.enqueued_at ?? at,
        attempts: same ? prev.attempts : 0,
        last_error: same ? prev.last_error : null,
        next_attempt_at: same ? prev.next_attempt_at : null,
        hold_until: same ? (prev.hold_until ?? null) : null,
      };
    };
    const retracts: OutboxOp[] = [];
    const upserts: OutboxOp[] = [];
    for (const [id, entry] of Object.entries(index)) if (!want.has(id) || entry.purge) retracts.push(keep("retract", id, null));
    for (const [id, doc] of want) {
      const entry: IndexEntry | undefined = index[id];
      if (entry?.purge) continue; // re-sent once the purge (delete) has gone through
      if (!entry || entry.inflight || entry.sync_key !== syncKey(doc)) upserts.push(keep("upsert", id, doc.version_hash));
    }
    const byAge = (a: OutboxOp, b: OutboxOp) => a.enqueued_at.localeCompare(b.enqueued_at) || a.doc_id.localeCompare(b.doc_id);
    // Retracts first: an obsolete or forgotten fact leaves Hindsight before anything new lands.
    const outbox = [...retracts.sort(byAge), ...upserts.sort(byAge)];
    store.writeOutbox(outbox);
    return outbox;
  }

  // ── drain (outbox → Hindsight) ───────────────────────────────────────────────────────
  const backoff = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

  async function drainOnce(force: boolean) {
    if (!client || !settings.writes) return;
    const status = store.readStatus();
    store.writeStatus({ ...status, last_drain_at: iso() });
    const skipRound = new Set<string>();
    const held = heldNow(reconcile());
    for (const id of held?.ids ?? []) skipRound.add(`retract:${id}`);
    for (;;) {
      const outbox = reconcile();
      const t = now().getTime();
      const op = outbox.find(
        (o) =>
          !skipRound.has(`${o.op}:${o.doc_id}`) &&
          !(o.hold_until && Date.parse(o.hold_until) > t) &&
          (force || !o.next_attempt_at || Date.parse(o.next_attempt_at) <= t),
      );
      if (!op) break;
      const doc = op.op === "upsert" ? desired().get(op.doc_id) : undefined;
      const started = Date.now();
      const attempt = op.attempts + 1;
      const authority = op.op === "retract" ? authorityFor(op.doc_id) : null;
      try {
        if (op.op === "upsert" && doc) {
          const index = store.readIndex();
          index[doc.id] = { ...index[doc.id], sync_key: index[doc.id]?.sync_key ?? null, synced_at: index[doc.id]?.synced_at ?? null, inflight: true };
          store.writeIndex(index); // write-ahead: a crash from here on is replayed, never lost
          const syncedAt = iso();
          await client.retain(doc, syncedAt);
          const after = store.readIndex();
          // A new version: never show the previous version's model (REVIEW-STAGE-D S3).
          after[doc.id] = { ...after[doc.id], sync_key: syncKey(doc), synced_at: syncedAt, inflight: false, model_pending: syncedAt, processed_by: null }; // keeps a purge set meanwhile
          store.writeIndex(after);
          hsLast = "ok";
          // Which model processed it: Hindsight's receipt, read through the proxy (never a guess).
          const model = await lookUpModel(doc.id, syncedAt, [0, 300, 900]);
          if (model) {
            const withModel = store.readIndex();
            if (withModel[doc.id]) (withModel[doc.id] = { ...withModel[doc.id], processed_by: model, model_pending: null }), store.writeIndex(withModel);
          }
          store.appendProcessing({ at: iso(), doc_id: doc.id, op: "retain", outcome: "ok", attempt, error: null, processed_by: model, latency_ms: Date.now() - started });
          if (model) tally(`${model.provider}/${model.model}`);
        } else if (op.op === "retract") {
          await client.deleteDocument(op.doc_id, authority ?? { kind: "routine" });
          const after = store.readIndex();
          delete after[op.doc_id];
          store.writeIndex(after);
          hsLast = "ok";
          store.appendProcessing({ at: iso(), doc_id: op.doc_id, op: "retract", outcome: "ok", attempt, error: null, processed_by: null, authority: authority?.kind ?? "routine", latency_ms: Date.now() - started });
        }
      } catch (e) {
        const err = e instanceof HindsightError ? e : new HindsightError("unavailable", null, "Hindsight call failed.");
        const outboxNow = store.readOutbox();
        const entry = outboxNow.find((o) => o.op === op.op && o.doc_id === op.doc_id);
        if (entry) {
          entry.attempts += 1;
          entry.last_error = err.message;
          entry.next_attempt_at = new Date(now().getTime() + backoff(entry.attempts)).toISOString();
          // Refusals that a quick retry can't change wait, even for a forced sync: the delete rate
          // limit clears within the hour; a refused approval needs a person.
          if (err.kind === "rate-limited" || err.kind === "approval-refused")
            entry.hold_until = new Date(now().getTime() + (err.kind === "rate-limited" ? RATE_LIMIT_WAIT_MS : BACKOFF_MAX_MS)).toISOString();
          store.writeOutbox(outboxNow);
        }
        if (err.kind === "rate-limited" && op.op === "retract") {
          const idx = store.readIndex();
          if (idx[op.doc_id] && !idx[op.doc_id].invalidated_at) {
            // Until the delete lands, no reader should get the removed or superseded version back.
            const n = await client.invalidateDocument(op.doc_id).catch(() => 0);
            if (n) {
              const after = store.readIndex();
              if (after[op.doc_id]) (after[op.doc_id] = { ...after[op.doc_id], invalidated_at: iso() }), store.writeIndex(after);
            }
          }
          hsLast = "removals-waiting";
        }
        store.writeStatus({ ...store.readStatus(), last_error: err.message });
        store.appendProcessing({
          at: iso(),
          doc_id: op.doc_id,
          op: op.op === "upsert" ? "retain" : "retract",
          outcome: "failed",
          attempt,
          error: err.message,
          processed_by: null,
          ...(authority ? { authority: authority.kind } : {}),
          latency_ms: Date.now() - started,
        });
        if (err.kind === "rejected" || err.kind === "approval-refused" || err.kind === "rate-limited") {
          skipRound.add(`${op.op}:${op.doc_id}`);
          continue;
        }
        hsLast = err.kind === "writes-off" ? "proxy-writes-off" : err.kind === "writer-unregistered" ? "writer-refused" : err.kind;
        return; // unavailable / auth / the proxy's write gate: stop in order; everything stays queued
      }
    }
    await resolvePendingModels();
    if (!reconcile().length) store.writeStatus({ ...store.readStatus(), last_success_at: iso(), last_error: null });
  }

  let draining: Promise<void> | null = null;
  let again = false;
  let againForce = false;
  function kick(force = false): Promise<void> {
    if (draining) {
      again = true;
      againForce ||= force;
      return draining;
    }
    draining = (async () => {
      let f = force;
      do {
        again = false;
        await drainOnce(f);
        f = againForce;
        againForce = false;
      } while (again);
    })().finally(() => {
      draining = null;
    });
    return draining;
  }
  /** Try to index now; give up waiting (not trying) after `waitMs`. */
  async function drainSoon(waitMs = 30_000, force = true) {
    const run = kick(force);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run, new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
    if (timer) clearTimeout(timer);
  }

  /** Scan the vault, recompute the outbox, and push it to Hindsight. */
  async function sync(opts: { force?: boolean; waitMs?: number } = {}) {
    const result = await serial(() => {
      const r = scan();
      reconcile();
      return r;
    });
    await drainSoon(opts.waitMs ?? 120_000, opts.force ?? false);
    return { ...result, status: status() };
  }

  function hindsightState(): HindsightState {
    if (!hs.enabled) return baseState();
    if (hsLast === null) {
      // No recall or save yet: the health probe answers whether Hindsight is up.
      if (health?.state === "down") return "unavailable";
      if (health?.state === "connected") return settings.writes ? "ok" : "writes-off";
      return settings.writes ? "unknown" : "writes-off";
    }
    if (hsLast === "ok" && store.readOutbox().some((o) => o.hold_until && Date.parse(o.hold_until) > now().getTime())) return "removals-waiting";
    return hsLast !== "ok" ? hsLast : settings.writes ? "ok" : "writes-off";
  }

  function indexState(id: string): IndexState {
    const doc = desired().get(id);
    if (!hs.enabled) return "disabled";
    const entry = store.readIndex()[id];
    // Indexed is indexed, whatever the switch says now (read mode used to call it "not sent").
    if (doc && entry && !entry.inflight && !entry.purge && entry.sync_key === syncKey(doc)) return "confirmed";
    if (!settings.writes) return "writes-off";
    if (doc && entry?.inflight && draining) return "sending";
    if (store.readOutbox().some((o) => o.doc_id === id)) return "queued";
    return doc ? "queued" : "not-indexed";
  }

  async function recallHindsight(query: string): Promise<{ state: HindsightState; hits: HindsightRecallHit[] }> {
    if (!client) return { state: baseState(), hits: [] };
    try {
      const hits = await client.recall(query);
      if (hsLast === null || hsLast === "unavailable") hsLast = "ok";
      return { state: "ok", hits };
    } catch (e) {
      const kind = e instanceof HindsightError && e.kind === "auth-failed" ? "auth-failed" : "unavailable";
      hsLast = kind;
      return { state: kind, hits: [] };
    }
  }

  function status(): SyncStatus {
    const st = store.readStatus();
    const outbox = store.readOutbox();
    const indexNow = store.readIndex();
    // A model found after the save was logged shows on that log line too.
    const processing = store.readProcessing().map((r) =>
      r.op === "retain" && r.outcome === "ok" && !r.processed_by && indexNow[r.doc_id]?.processed_by && (indexNow[r.doc_id].synced_at ?? "") <= r.at
        ? { ...r, processed_by: indexNow[r.doc_id].processed_by ?? null }
        : r,
    );
    const models: Record<string, number> = { ...(st.models ?? {}) };
    const held = heldNow(outbox);
    const byReason = new Map<string, string[]>();
    for (const s of st.skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.path]);
    const index = store.readIndex();
    const want = desired();
    return {
      settings: {
        mode: settings.mode,
        retired: settings.retired,
        writer: settings.writer ?? null,
        writes: settings.writes,
        hindsight_enabled: hs.enabled,
        hindsight_url: hs.url,
        bank: hs.bank,
        api_key: (options.env ?? process.env)[hs.apiKeyEnv] ? "set" : "missing",
        reason: hs.reason,
      },
      hindsight_health: hindsightHealth(),
      hindsight_checked_at: health?.at ?? null,
      hindsight: hindsightState(),
      last_scan_at: st.last_scan_at,
      last_drain_at: st.last_drain_at,
      last_success_at: st.last_success_at,
      pending: outbox.length,
      pending_ops: outbox.slice(0, 50),
      errors: outbox.filter((o) => o.last_error).map((o) => ({ doc_id: o.doc_id, error: o.last_error!, attempts: o.attempts })),
      counts: {
        notes: Object.values(store.readNotes()).filter((e) => !e.missing_since).length,
        docs: want.size,
        memories: store.readMemories().filter((m) => m.status === "current").length,
        indexed: [...want].filter(([id, d]) => index[id] && !index[id].inflight && !index[id].purge && index[id].sync_key === syncKey(d)).length,
        excluded: store.readExclusions().length,
        tombstones: store.readTombstones().length,
      },
      skipped: [...byReason].map(([reason, paths]) => ({ reason, count: paths.length, examples: paths.slice(0, 5) })),
      recent: processing.slice(-40).reverse(),
      models,
      as_of: iso(),
      held: held ? { count: held.ids.length, digest: held.digest, examples: held.ids.slice(0, 5), ids: held.ids, since: held.since } : null,
    };
  }

  /** Release a held mass removal after its approval (api.releaseHeld checks the approval). */
  function releaseHeld(digest: string, by: string, approvalId: string) {
    const held = heldNow();
    if (!held || held.digest !== digest) return false;
    store.writeHeld({ released_digest: digest, released_by: by, released_at: iso(), approval_id: approvalId });
    return true;
  }

  return {
    settings,
    store,
    client,
    now,
    iso,
    serial,
    desired,
    scan,
    reconcile,
    kick,
    drainSoon,
    sync,
    status,
    indexState,
    hindsightState,
    /** Probe Hindsight's health now (reuses a result younger than the TTL); resolves when done. */
    probeHealth,
    recallHindsight,
    lastRenames: () => lastRenames,
    heldNow,
    releaseHeld,
    processedBy: (id: string) => store.readIndex()[id]?.processed_by ?? null,
    /** Wait for any running drain (tests, shutdown). */
    idle: () => draining ?? Promise.resolve(),
  };
}
export type Connector = ReturnType<typeof createConnector>;
