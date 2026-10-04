/**
 * The only code that talks to Hindsight (v0.10.1 REST, tenant "default"):
 *
 *   POST   /v1/default/banks/{bank}/memories            retain one document (document_id upsert, update_mode replace)
 *   POST   /v1/default/banks/{bank}/memories/recall     recall, filtered to this connector's tag
 *   GET    /v1/default/banks/{bank}/documents/{id}      does Hindsight hold this document?
 *   DELETE /v1/default/banks/{bank}/documents/{id}      hard delete (cascades to facts + embeddings)
 *   GET    /v1/default/banks/{bank}/llm-requests        which model processed a document (receipts, no text)
 *   GET    /health
 *
 * It is pointed at the client proxy (scripts/hindsight/proxy.py, 127.0.0.1:8878), which holds the
 * Hindsight key and checks this process's Windows account, so no key is sent. A document DELETE
 * carries `X-MU-Approval`: an HMAC over `id|expiry|DELETE|path` with the proxy's approval secret
 * (docs/HINDSIGHT-OPS.md section 13), minted here ONLY for a delete the connector's own approval
 * path decided: a routine retract (a correction, a note removed from the vault, "remove from the
 * index") or an approved forget (the token id then carries the approval id). Never for a bank or a
 * clear; this client has no such call. The secret is read at delete time and never kept or logged.
 *
 * Deliberately absent: bank delete/clear, bulk memory delete, reflect, export. Nothing in
 * AgenticOS can clear a bank through this client.
 *
 * The API key is read from the environment by NAME on each call and sent as a Bearer token;
 * it is never stored, logged, put in a receipt or returned. Every call writes a usage receipt.
 *
 * The writer capability (Track 6, the bun.exe bypass fix): when this process is the memory WRITER, it
 * makes one random capability per process (memory only), registers its sha256 with the proxy before its
 * first write (POST /_mu/writer/register, proved with the same document-delete secret, from this process,
 * which owns the OS's listening port), and sends `X-MU-Writer` on every write. A proxy that restarted
 * answers `writer-unregistered`: this registers again and retries once. A proxy without the route (404,
 * the old one) is written to as before, so the OS can be deployed first. Nothing here logs the capability.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IndexDoc, ModelRef, ProcessedBy, UsageReceipt } from "./types";

export const CONNECTOR_TAG = "src:agenticos";

export class HindsightError extends Error {
  constructor(
    /**
     * writes-off: the proxy's own write gate is off (the lead's `hindsightctl writes`), so nothing
     * can land until it is on; approval-refused: the proxy refused a delete's approval token;
     * rate-limited: the proxy's document-delete limit (rev 3: 20 an hour) is reached, retry later.
     */
    public readonly kind: "unavailable" | "auth-failed" | "rejected" | "writes-off" | "approval-refused" | "rate-limited" | "writer-refused" | "writer-unregistered",
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export type HindsightRecallHit = { id: string; text: string; document_id: string | null; metadata: Record<string, string>; tags: string[]; date: string | null };

export type HindsightClientOptions = {
  url: string;
  bank: string;
  apiKeyEnv: string;
  /**
   * The proxy's document-delete secret(s), first readable wins (rev 3 `*-docdelete.key`, then rev 2
   * `*-approval.key`). None readable: deletes go unsigned (a direct test instance needs none; the proxy refuses them).
   */
  approvalSecretFile?: string | string[];
  /** This process is the memory writer: register the per-process writer capability and send it on writes. */
  writer?: boolean;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  onReceipt?: (r: UsageReceipt) => void;
  now?: () => Date;
  timeouts?: { retain?: number; recall?: number; other?: number };
};

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** ONE writer capability per process (memory only): every client in this process presents the same one. */
let processCapability: string | null = null;
const capability = () => (processCapability ??= randomBytes(32).toString("hex"));
export const WRITER_REGISTER_DOMAIN = "mu-writer-register-v1";
type Registration = { state: "registered" | "unsupported"; at: number };
/** Per proxy URL: registered (send the header) or unsupported (an old proxy: write as before, check again later). */
const registrations = new Map<string, Registration>();
/** Tests: forget registrations (a new process). */
export function resetWriterRegistrations(opts: { newCapability?: boolean } = {}) {
  registrations.clear();
  if (opts.newCapability) processCapability = null;
}

export function retainItem(doc: IndexDoc, syncedAt: string) {
  const src = doc.source;
  const metadata: Record<string, string> = {
    doc_id: doc.id,
    kind: doc.kind,
    origin: doc.origin,
    bucket: doc.bucket,
    title: doc.title,
    version: String(doc.version),
    version_hash: doc.version_hash,
    updated: doc.updated,
    synced_at: syncedAt,
    source_kind: src.kind,
    ...(src.kind === "vault" ? { source_path: src.path, note_id: src.note_id, obsidian_link: src.link, obsidian_uri: src.uri } : { memory_id: src.id }),
    ...(doc.actor ? { actor: doc.actor } : {}),
    ...(doc.chain ? { chain: doc.chain } : {}),
  };
  return {
    content: `${doc.title}\n\n${doc.content}`,
    timestamp: doc.updated,
    context: src.kind === "vault" ? `Obsidian vault note ${src.path}` : `Jarvis memory ${doc.id}`,
    document_id: doc.id,
    tags: [CONNECTOR_TAG, `bucket:${doc.bucket}`, `kind:${doc.kind}`, `origin:${doc.origin}`],
    metadata,
    update_mode: "replace" as const,
  };
}

export function createHindsightClient(options: HindsightClientOptions) {
  const base = `${options.url.replace(/\/+$/, "")}/v1/default/banks/${encodeURIComponent(options.bank)}`;
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const t = { retain: 180_000, recall: 20_000, other: 15_000, ...options.timeouts };

  function headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    if (json) h["Content-Type"] = "application/json";
    const key = env[options.apiKeyEnv];
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  async function call(
    op: UsageReceipt["op"],
    docId: string | null,
    url: string,
    init: { method: string; body?: unknown; timeout: number; notFoundOk?: boolean; headers?: Record<string, string> },
  ): Promise<{ status: number; body: any }> {
    const started = Date.now();
    const receipt = (outcome: UsageReceipt["outcome"], status: number | null, tokens: UsageReceipt["tokens"] = null) =>
      options.onReceipt?.({
        at: now().toISOString(),
        op,
        bank: options.bank,
        doc_id: docId,
        latency_ms: Date.now() - started,
        outcome,
        http_status: status,
        tokens,
        cost: { basis: "see-processing", cash_usd: null },
      });
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method,
        headers: headers(init.body !== undefined, init.headers),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeout),
      });
    } catch (e) {
      receipt("unavailable", null);
      throw new HindsightError("unavailable", null, `Hindsight is unreachable (${(e as Error)?.name === "TimeoutError" ? "timed out" : "connection failed"}).`);
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 404 && init.notFoundOk) {
      receipt("not-found", 404);
      return { status: 404, body };
    }
    if (res.status === 401 || res.status === 403) {
      // The proxy says why in `error`; a direct Hindsight says `detail`. Only the reason is kept.
      const why = String(body?.error ?? body?.detail ?? "").slice(0, 200);
      if (res.status === 403 && body?.code === "writer-unregistered") {
        receipt("error", 403);
        throw new HindsightError("writer-unregistered", 403, "The Hindsight proxy doesn't know this OS as the writer yet (it restarted); registering again.");
      }
      if (res.status === 403 && body?.code === "writer-refused") {
        receipt("error", 403);
        throw new HindsightError("writer-refused", 403, `The Hindsight proxy refused this process as the memory writer (${why.replace(/^refused:\s*/i, "")}); saves wait in the queue.`);
      }
      if (res.status === 403 && /memory writes are OFF/i.test(why)) {
        receipt("error", 403);
        throw new HindsightError("writes-off", 403, "The Hindsight proxy's write gate is off (hindsightctl writes -State on), so this stays queued.");
      }
      if (res.status === 403 && /rate limit/i.test(why)) {
        receipt("error", 403);
        throw new HindsightError("rate-limited", 403, `The Hindsight proxy's document-delete limit is reached (${why}); the removal waits and retries.`);
      }
      if (res.status === 403 && /approval/i.test(why)) {
        receipt("error", 403);
        throw new HindsightError("approval-refused", 403, `The Hindsight proxy refused the delete's approval (${why.replace(/^refused:\s*/i, "")}).`);
      }
      if (res.status === 403 && /(read-only|not available through the proxy|route not allowed|query string not allowed|non-canonical|encoded characters)/i.test(why)) {
        receipt("error", 403);
        throw new HindsightError("rejected", 403, `The Hindsight proxy refused this (${why}).`);
      }
      receipt("auth-failed", res.status);
      throw new HindsightError(
        "auth-failed",
        res.status,
        /caller identity/i.test(why)
          ? "The Hindsight proxy did not accept this process (it must run as the same Windows user as the proxy)."
          : `Hindsight refused this request (HTTP ${res.status}). Through the proxy no key is needed; directly, check ${options.apiKeyEnv}.`,
      );
    }
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      receipt("unavailable", res.status);
      throw new HindsightError("unavailable", res.status, `Hindsight is unavailable (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      receipt("error", res.status);
      throw new HindsightError("rejected", res.status, `Hindsight rejected the request (HTTP ${res.status}).`);
    }
    const u = body?.usage;
    const tokens =
      u && typeof u === "object" && [u.input_tokens, u.output_tokens, u.total_tokens].every((n: unknown) => typeof n === "number")
        ? { input: u.input_tokens as number, output: u.output_tokens as number, total: u.total_tokens as number }
        : null;
    receipt("ok", res.status, tokens);
    return { status: res.status, body };
  }

  const bankPath = `/v1/default/banks/${options.bank}`;
  /** The proxy's document-delete secret, read at use and never kept (first readable file wins). */
  function secretNow(): string {
    const files = Array.isArray(options.approvalSecretFile) ? options.approvalSecretFile : options.approvalSecretFile ? [options.approvalSecretFile] : [];
    for (const f of files) {
      try {
        const v = readFileSync(f, "utf8").trim();
        if (v) return v;
      } catch {
        /* next */
      }
    }
    return "";
  }
  /** The proxy verifies the DECODED path it receives; document ids here are [A-Za-z0-9#._-] anyway. */
  function approvalToken(tokenId: string, method: string, path: string): string | null {
    const secret = secretNow();
    if (!secret) return null;
    // Wall-clock expiry (the proxy checks real time), 5 minutes: well inside its 1-hour ceiling.
    const expiry = Math.floor(Date.now() / 1000) + 300;
    return `${tokenId}.${expiry}.${createHmac("sha256", secret).update(`${tokenId}|${expiry}|${method}|${path}`).digest("hex")}`;
  }

  // ── the writer capability ──────────────────────────────────────────────────────────
  const proxyUrl = options.url.replace(/\/+$/, "");
  const UNSUPPORTED_RECHECK_MS = 10 * 60_000;
  /** Register this process's capability with the proxy (once; `force` after the proxy forgot it). */
  async function ensureWriter(force = false): Promise<void> {
    if (!options.writer) return;
    // Straight to Hindsight with a key (a test instance, not the proxy): there is no proxy to register with.
    if (env[options.apiKeyEnv]) return;
    const reg = registrations.get(proxyUrl);
    if (!force && reg && (reg.state === "registered" || Date.now() - reg.at < UNSUPPORTED_RECHECK_MS)) return;
    const secret = secretNow();
    // No secret: this copy can't prove itself. An enforcing proxy then refuses its writes (visible as
    // "writer-refused"); an old one takes them as before.
    if (!secret) return;
    const ts = Math.floor(Date.now() / 1000);
    const capSha = createHash("sha256").update(capability()).digest("hex");
    // A fresh nonce: two registrations in the same second are two proofs, not a replay (REVIEW-T6 nit).
    const nonce = randomBytes(16).toString("hex");
    const proof = createHmac("sha256", secret).update(`${WRITER_REGISTER_DOMAIN}|${ts}|${capSha}|${nonce}`).digest("hex");
    let res: Response;
    const started = Date.now();
    const receipt = (outcome: UsageReceipt["outcome"], status: number | null) =>
      options.onReceipt?.({ at: now().toISOString(), op: "register", bank: options.bank, doc_id: null, latency_ms: Date.now() - started, outcome, http_status: status, tokens: null, cost: { basis: "see-processing", cash_usd: null } });
    try {
      res = await doFetch(`${proxyUrl}/_mu/writer/register`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ capability_sha256: capSha, ts, nonce, proof }),
        signal: AbortSignal.timeout(t.other),
      });
    } catch (e) {
      receipt("unavailable", null);
      throw new HindsightError("unavailable", null, `Hindsight is unreachable (${(e as Error)?.name === "TimeoutError" ? "timed out" : "connection failed"}).`);
    }
    receipt(res.ok ? "ok" : res.status === 404 ? "not-found" : "error", res.status);
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) return void registrations.set(proxyUrl, { state: "registered", at: Date.now() });
    // An old proxy (no route: a 404, or a route-table refusal): write as before; look again later.
    if (res.status === 404 || (res.status === 403 && /route not allowed/i.test(String(body?.error ?? "")))) return void registrations.set(proxyUrl, { state: "unsupported", at: Date.now() });
    throw new HindsightError("writer-refused", res.status, `The Hindsight proxy refused this process as the memory writer (${String(body?.error ?? `HTTP ${res.status}`).replace(/^refused:\s*/i, "").slice(0, 200)}); saves wait in the queue.`);
  }
  const writerHeaders = (): Record<string, string> => (options.writer && registrations.get(proxyUrl)?.state === "registered" ? { "X-MU-Writer": capability() } : {});
  /** A write: registered first; a proxy that restarted (writer-unregistered) gets one re-registration and one retry. */
  async function writeCall(op: UsageReceipt["op"], docId: string | null, url: string, init: Parameters<typeof call>[3]) {
    await ensureWriter();
    try {
      return await call(op, docId, url, { ...init, headers: { ...(init.headers ?? {}), ...writerHeaders() } });
    } catch (e) {
      if (!(e instanceof HindsightError) || e.kind !== "writer-unregistered" || !options.writer) throw e;
      if (!secretNow())
        throw new HindsightError(
          "writer-refused",
          403,
          "The Hindsight proxy needs this OS to register as the memory writer, but it has no document-delete secret to prove itself with (HINDSIGHT_APPROVAL_SECRET_FILE); saves wait in the queue.",
        );
      registrations.delete(proxyUrl);
      await ensureWriter(true);
      return call(op, docId, url, { ...init, headers: { ...(init.headers ?? {}), ...writerHeaders() } });
    }
  }

  const basisOf = (provider: string): ProcessedBy["basis"] =>
    /^openrouter$/i.test(provider) ? "metered" : /^groq$/i.test(provider) ? "free" : /codex|claude/i.test(provider) ? "subscription" : "unknown";

  return {
    bank: options.bank,
    /** Upsert one document: same document_id replaces what Hindsight held for it. */
    async retain(doc: IndexDoc, syncedAt: string) {
      await writeCall("retain", doc.id, `${base}/memories`, { method: "POST", timeout: t.retain, body: { items: [retainItem(doc, syncedAt)], async: false } });
    },
    async recall(query: string, maxTokens = 2048): Promise<HindsightRecallHit[]> {
      const r = await call("recall", null, `${base}/memories/recall`, {
        method: "POST",
        timeout: t.recall,
        body: { query: query.slice(0, 500), max_tokens: maxTokens, budget: "mid", tags: [CONNECTOR_TAG], tags_match: "any_strict" },
      });
      const results = Array.isArray(r.body?.results) ? r.body.results : [];
      return results.map((x: any) => ({
        id: str(x?.id),
        text: str(x?.text),
        document_id: typeof x?.document_id === "string" ? x.document_id : null,
        metadata: x?.metadata && typeof x.metadata === "object" ? x.metadata : {},
        tags: Array.isArray(x?.tags) ? x.tags.map(str) : [],
        date: typeof x?.mentioned_at === "string" ? x.mentioned_at : typeof x?.occurred_start === "string" ? x.occurred_start : null,
      }));
    },
    /**
     * "deleted" or "not-found" (already gone counts as done). `authority` says which approval path
     * decided it: a routine retract, or an approved forget (its approval id goes into the token id,
     * so the proxy's single-use record ties back to it).
     */
    async deleteDocument(id: string, authority: { kind: "routine" } | { kind: "forget"; approvalId: string } = { kind: "routine" }): Promise<"deleted" | "not-found"> {
      const tag = randomBytes(4).toString("hex");
      const tokenId =
        authority.kind === "forget" && /^[A-Za-z0-9_-]{1,60}$/.test(authority.approvalId) ? `${authority.approvalId}-${tag}` : `rt-${now().getTime().toString(36)}-${tag}`;
      const token = approvalToken(tokenId, "DELETE", `${bankPath}/documents/${id}`);
      const r = await writeCall("delete", id, `${base}/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
        timeout: t.other,
        notFoundOk: true,
        headers: token ? { "X-MU-Approval": token } : {},
      });
      return r.status === 404 ? "not-found" : "deleted";
    },
    /**
     * Which model processed a document's retain since `since` (Hindsight's llm_requests receipts:
     * provider, model, status and tokens; prompt and response are cut to one character server-side).
     * null while there are no receipts yet (Hindsight writes them just after the retain returns).
     */
    async processedBy(docId: string, since: string): Promise<ProcessedBy | null> {
      // Plain query characters only: the rev 3 proxy refuses '%' and ':' in a query, so the time
      // window is applied here, not with start_date. Newest first; one document's recent calls.
      const plain = (q: string) => /^[A-Za-z0-9_.,=&-]+$/.test(q);
      const receipts = async (q: string): Promise<any[]> => {
        if (!plain(q)) return [];
        const r = await call("receipts", docId, `${base}/llm-requests?${q}`, { method: "GET", timeout: t.other, notFoundOk: true });
        return Array.isArray(r.body?.items) ? r.body.items : [];
      };
      let items = await receipts(`document_id=${docId}&operation=retain&limit=50`);
      if (!items.length) {
        // Hindsight 0.10.1 tags a retain's receipts with the memory units it produced, not the
        // document id: find one of this document's units, then the run that produced it.
        const lq = `document_id=${docId}&limit=1`;
        const units = plain(lq) ? await call("receipts", docId, `${base}/memories/list?${lq}`, { method: "GET", timeout: t.other, notFoundOk: true }) : null;
        const unit = Array.isArray(units?.body?.items) ? str(units!.body.items[0]?.id) : "";
        if (unit) items = await receipts(`memory_id=${unit}&operation=retain&limit=50`);
      }
      const from = Date.parse(since);
      const rows = items
        .map((x) => ({ provider: str(x?.provider), model: str(x?.model), status: str(x?.status), at: str(x?.started_at), tokens: typeof x?.total_tokens === "number" ? (x.total_tokens as number) : null }))
        .filter((x) => x.provider && (!Number.isFinite(from) || !x.at || Date.parse(x.at) >= from))
        .sort((a, b) => a.at.localeCompare(b.at));
      const ok = rows.filter((x) => x.status === "success");
      const last = ok[ok.length - 1];
      if (!last) return null;
      const key = (m: ModelRef) => `${m.provider}/${m.model}`;
      const fallback = new Map<string, ModelRef>();
      for (const x of rows) if (x.status !== "success" && key(x) !== key(last)) fallback.set(key(x), { provider: x.provider, model: x.model });
      const known = rows.filter((x) => x.tokens !== null);
      return {
        provider: last.provider,
        model: last.model,
        fallback_from: [...fallback.values()],
        basis: basisOf(last.provider),
        calls: rows.length,
        tokens: known.length ? known.reduce((n, x) => n + (x.tokens ?? 0), 0) : null,
        at: last.at || now().toISOString(),
      };
    },
    /**
     * While a document's delete waits (the proxy's rate limit), mark its facts invalidated so recall
     * stops returning them to every reader. Best effort; the delete still follows. Returns how many.
     */
    async invalidateDocument(docId: string): Promise<number> {
      const lq = `document_id=${docId}&limit=100`;
      if (!/^[A-Za-z0-9_.,=&-]+$/.test(lq)) return 0;
      const list = await call("get", docId, `${base}/memories/list?${lq}`, { method: "GET", timeout: t.other, notFoundOk: true });
      const units: string[] = (Array.isArray(list.body?.items) ? list.body.items : []).map((x: any) => str(x?.id)).filter(Boolean);
      let n = 0;
      for (const u of units) {
        await writeCall("get", docId, `${base}/memories/${encodeURIComponent(u)}`, { method: "PATCH", timeout: t.other, notFoundOk: true, body: { state: "invalidated", reason: "removed in AgenticOS; delete pending" } });
        n++;
      }
      return n;
    },
    async hasDocument(id: string): Promise<boolean> {
      const r = await call("get", id, `${base}/documents/${encodeURIComponent(id)}`, { method: "GET", timeout: t.other, notFoundOk: true });
      return r.status !== 404;
    },
    async health(): Promise<boolean> {
      try {
        await call("health", null, `${options.url.replace(/\/+$/, "")}/health`, { method: "GET", timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    },
  };
}
export type HindsightClient = ReturnType<typeof createHindsightClient>;
