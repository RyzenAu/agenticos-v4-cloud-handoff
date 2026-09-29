/**
 * A FAKE Hindsight v0.10.1 REST server for tests: loopback only, in-process, synthetic data.
 * It mimics the parts the connector uses — retain with document_id replace, tag-filtered
 * recall, document get/delete (404 when absent), /health, Bearer API-key auth — and lets a
 * test take it down (connection refused), make it answer 503, or apply a retain and then
 * "lose" the response (500) to prove replay creates no duplicates.
 *
 * Proxy behaviour (scripts/hindsight/proxy.py) when `approvalSecret` is given: a document DELETE
 * needs a valid, unexpired, single-use `X-MU-Approval` HMAC for that exact path, and
 * `setProxyWrites(false)` answers writes with the proxy's "memory writes are OFF" 403.
 * `llm-requests` returns one synthetic receipt per retain (provider/model set by `setModels`, a
 * failed primary first when a fallback is configured), filtered by document_id like Hindsight.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeDoc = { document_id: string; content: string; tags: string[]; metadata: Record<string, string>; timestamp: string | null; retains: number; invalidated?: boolean };
export type FakeCall = { method: string; path: string; status: number; auth: boolean; approval?: string };
export type FakeReceipt = { id: string; document_id: string; operation: "retain"; provider: string; model: string; status: "success" | "error"; started_at: string; total_tokens: number | null };

const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2);

/**
 * `writerCapability` (Track 6) plays the proxy's writer capability: undefined = an old proxy (no
 * registration route, 404); false = the route exists but writes aren't enforced; true = enforced (a write
 * needs X-MU-Writer matching the registered capability). The fake can't see PIDs, so "the listener" is
 * whoever registers with a valid proof; the PID rule is covered by the proxy's own Python tests.
 */
export async function startFakeHindsight(options: { apiKey?: string; approvalSecret?: string; writerCapability?: boolean } = {}) {
  const banks = new Map<string, Map<string, FakeDoc>>();
  const calls: FakeCall[] = [];
  const receipts: FakeReceipt[] = [];
  const usedApprovals = new Set<string>();
  let proxyWrites = true;
  let writerEnforced = options.writerCapability === true;
  let writer: { capSha: string } | null = null;
  const writerLog: { event: "registered" | "refused" | "unregistered" | "wrong-capability" | "ok"; at: number }[] = [];
  /** null if the write may go ahead; else the 403 payload the proxy would send. */
  const writerRefusal = (req: IncomingMessage): { error: string; code: string } | null => {
    if (!writerEnforced) return null;
    const got = String(req.headers["x-mu-writer"] ?? "");
    if (!writer) return writerLog.push({ event: "unregistered", at: Date.now() }), { error: "refused: the OS has not registered its writer capability", code: "writer-unregistered" };
    if (!got || createHash("sha256").update(got).digest("hex") !== writer.capSha)
      return writerLog.push({ event: "wrong-capability", at: Date.now() }), { error: "refused: the writer capability does not match", code: "writer-refused" };
    writerLog.push({ event: "ok", at: Date.now() });
    return null;
  };
  let docDeleteLimit: number | null = null;
  let tagging: "document" | "memory" = "document";
  let deletesAllowed = Infinity;
  let chain: { provider: string; model: string; fails?: boolean }[] = [{ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" }];
  const approvalRefusal = (token: string, path: string): string | null => {
    if (!options.approvalSecret) return null;
    if (!token) return "approval token required";
    const [id, exp, mac] = token.split(".");
    if (!id || !exp || !mac || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) return "malformed approval token";
    if (Number(exp) < Date.now() / 1000 || Number(exp) > Date.now() / 1000 + 3600) return "approval token expired or too long-lived";
    const want = createHmac("sha256", options.approvalSecret).update(`${id}|${exp}|DELETE|${path}`).digest("hex");
    if (want.length !== mac.length || !timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return "approval token does not match this exact request";
    if (usedApprovals.has(id)) return "approval token already used";
    usedApprovals.add(id);
    return null;
  };
  let mode: "up" | "503" = "up";
  let loseNextRetainResponses = 0;
  let server: Server | null = null;
  let port = 0;

  const bank = (id: string) => {
    let b = banks.get(id);
    if (!b) banks.set(id, (b = new Map()));
    return b;
  };

  async function body(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, payload: unknown) => {
      const approval = String(req.headers["x-mu-approval"] ?? "");
      calls.push({ method: req.method ?? "GET", path: url.pathname, status, auth: !!req.headers.authorization, ...(approval ? { approval: approval.split(".")[0] } : {}) });
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/health") return send(mode === "up" ? 200 : 503, { status: mode === "up" ? "healthy" : "unhealthy" });
    if (url.pathname === "/_mu/writer/register") {
      if (options.writerCapability === undefined || !options.approvalSecret) return send(404, { detail: "Not Found" });
      const j = await body(req);
      const ts = Number(j.ts);
      const cap = String(j.capability_sha256 ?? "");
      const nonce = typeof j.nonce === "string" ? j.nonce : "";
      const want = createHmac("sha256", options.approvalSecret).update(`mu-writer-register-v1|${ts}|${cap}${nonce ? `|${nonce}` : ""}`).digest("hex");
      if (!/^[0-9a-f]{64}$/.test(cap) || Math.abs(Date.now() / 1000 - ts) > 60 || want !== String(j.proof ?? "")) {
        writerLog.push({ event: "refused", at: Date.now() });
        return send(403, { error: "refused: registration proof does not verify", code: "writer-refused" });
      }
      writer = { capSha: cap };
      writerLog.push({ event: "registered", at: Date.now() });
      return send(200, { ok: true, enforced: writerEnforced });
    }
    // The rev 3 proxy's canonical rules: plain query characters only (no '%', no ':').
    if (options.approvalSecret && url.search && !/^[A-Za-z0-9_.,=&-]*$/.test(url.search.slice(1))) return send(403, { error: "query string not allowed on this route" });
    if (mode === "503") return send(503, { detail: "Service unavailable" });
    if (options.apiKey) {
      const auth = String(req.headers.authorization ?? "");
      const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
      if (key !== options.apiKey) return send(401, { detail: "Invalid API key" });
    }
    const m = /^\/v1\/default\/banks\/([^/]+)\/(memories\/recall|memories\/list|memories\/u-(.+)|memories|llm-requests|documents\/(.+))$/.exec(url.pathname);
    if (!m) return send(404, { detail: "Not Found" });
    const b = bank(decodeURIComponent(m[1]));
    if (m[2] === "memories/list" && req.method === "GET") {
      const doc = url.searchParams.get("document_id") ?? "";
      return send(200, { items: b.has(doc) ? [{ id: `u-${doc}`, document_id: doc }] : [] });
    }
    if (m[3] && req.method === "PATCH") {
      // A fact's curation: { state: "invalidated" } hides the document's facts from recall.
      const doc = b.get(decodeURIComponent(m[3]));
      if (!doc) return send(404, { detail: "Memory not found" });
      const payload = await body(req);
      if (!proxyWrites) return send(403, { error: "memory writes are OFF (enabled by the lead after acceptance)" });
      if (payload.state === "invalidated") doc.invalidated = true;
      return send(200, { success: true });
    }
    if (m[2] === "llm-requests" && req.method === "GET") {
      // Real Hindsight 0.10.1 tags retain receipts with the memory units produced, not the document.
      if (tagging === "memory") {
        const unit = url.searchParams.get("memory_id") ?? "";
        const items = unit.startsWith("u-") ? receipts.filter((r) => r.document_id === unit.slice(2)).reverse() : [];
        return send(200, { bank_id: m[1], total: items.length, limit: 50, offset: 0, items });
      }
      const doc = url.searchParams.get("document_id");
      const from = url.searchParams.get("start_date");
      const items = receipts.filter((r) => (!doc || r.document_id === doc) && (!from || r.started_at >= from)).reverse();
      return send(200, { bank_id: m[1], total: items.length, limit: 50, offset: 0, items });
    }
    if (!proxyWrites && req.method !== "GET" && m[2] !== "memories/recall") return send(403, { error: "memory writes are OFF (enabled by the lead after acceptance)" });
    if (req.method !== "GET" && m[2] !== "memories/recall" && m[2] !== "memories/list") {
      const wr = writerRefusal(req);
      if (wr) return send(403, wr);
    }
    if (m[2] === "memories" && req.method === "POST") {
      const payload = await body(req);
      const items = Array.isArray(payload.items) ? payload.items : [];
      let tokens = 0;
      for (const it of items) {
        const id = String(it.document_id ?? `auto-${b.size + 1}`);
        const prev = b.get(id);
        b.set(id, {
          document_id: id,
          content: String(it.content ?? ""),
          tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
          metadata: it.metadata ?? {},
          timestamp: it.timestamp ?? null,
          retains: (prev?.retains ?? 0) + 1,
        });
        // Stamped with the sender's clock (its synced_at), so tests with a fixed clock line up.
        const at = typeof it.metadata?.synced_at === "string" ? it.metadata.synced_at : new Date().toISOString();
        for (const c of chain) {
          receipts.push({ id: `r${receipts.length + 1}`, document_id: id, operation: "retain", provider: c.provider, model: c.model, status: c.fails ? "error" : "success", started_at: at, total_tokens: c.fails ? null : 420 });
          if (!c.fails) break;
        }
        tokens += Math.ceil(String(it.content ?? "").length / 4);
      }
      if (loseNextRetainResponses > 0) {
        loseNextRetainResponses--;
        return send(500, { detail: "Internal error after apply (simulated lost response)" });
      }
      return send(200, { success: true, bank_id: m[1], items_count: items.length, async: false, usage: { input_tokens: tokens, output_tokens: 12, total_tokens: tokens + 12 } });
    }
    if (m[2] === "memories/recall" && req.method === "POST") {
      const payload = await body(req);
      const q = new Set(words(String(payload.query ?? "")));
      const tags: string[] = Array.isArray(payload.tags) ? payload.tags : [];
      const strict = String(payload.tags_match ?? "any").includes("strict");
      const results: unknown[] = [];
      const scored = [...b.values()]
        .filter((d) => !d.invalidated)
        .filter((d) => !tags.length || (strict ? d.tags.some((t) => tags.includes(t)) : d.tags.length === 0 || d.tags.some((t) => tags.includes(t))))
        .map((d) => ({ d, score: words(d.content).filter((w) => q.has(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b2) => b2.score - a.score)
        .slice(0, 8);
      for (const { d } of scored) {
        const sentence = d.content.split(/(?<=[.!?])\s+|\n+/).find((s) => words(s).some((w) => q.has(w))) ?? d.content.slice(0, 120);
        results.push({ id: `${d.document_id}:u1`, text: sentence.trim(), type: "world", document_id: d.document_id, metadata: d.metadata, tags: d.tags, mentioned_at: d.timestamp });
      }
      return send(200, { results });
    }
    if (m[4]) {
      const id = decodeURIComponent(m[4]);
      if (req.method === "GET") return b.has(id) ? send(200, { id, original_text: b.get(id)!.content }) : send(404, { detail: "Document not found" });
      if (req.method === "DELETE") {
        if (options.approvalSecret && docDeleteLimit !== null && deletesAllowed <= 0) return send(403, { error: `document-delete rate limit reached (${docDeleteLimit} an hour)` });
        const refused = approvalRefusal(String(req.headers["x-mu-approval"] ?? ""), decodeURIComponent(url.pathname));
        if (!refused && docDeleteLimit !== null) deletesAllowed--;
        if (refused) return send(403, { error: `refused: ${refused}` });
        if (!b.has(id)) return send(404, { detail: "Document not found" });
        b.delete(id);
        return send(200, { success: true, message: "deleted", document_id: id, memory_units_deleted: 1 });
      }
    }
    return send(405, { detail: "Method Not Allowed" });
  }

  function listen(p: number) {
    return new Promise<void>((resolve, reject) => {
      const s = createServer((req, res) => {
        handle(req, res).catch(() => {
          res.statusCode = 500;
          res.end("{}");
        });
      });
      s.once("error", reject);
      s.listen(p, "127.0.0.1", () => {
        server = s;
        port = (s.address() as AddressInfo).port;
        resolve();
      });
    });
  }
  function close() {
    return new Promise<void>((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = null;
      s.closeAllConnections?.();
      s.close(() => resolve());
    });
  }

  await listen(0);
  return {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    calls,
    receipts,
    bank: (id: string) => bank(id),
    /** The failover chain the next retains report (a member with `fails` records an error receipt first). */
    setModels: (c: { provider: string; model: string; fails?: boolean }[]) => void (chain = c),
    /** How receipts are tagged: "memory" behaves like Hindsight 0.10.1 (memory_id filter only). */
    setReceiptTagging: (t: "document" | "memory") => void (tagging = t),
    /** The rev 3 proxy's document-delete rate limit (null = none). */
    setDeleteLimit: (n: number | null) => void ((docDeleteLimit = n), (deletesAllowed = n ?? Infinity)),
    /** The proxy's own write gate (hindsightctl writes). */
    setProxyWrites: (on: boolean) => void (proxyWrites = on),
    /** Track 6: enforce the writer capability (the route exists whenever `writerCapability` was given). */
    setWriterCapability: (on: boolean) => void (writerEnforced = on),
    /** A proxy restart: the registered capability is forgotten (memory only). */
    forgetWriter: () => void (writer = null),
    writerLog,
    /** Connection refused until `up()`. */
    down: () => close(),
    up: () => (server ? Promise.resolve() : listen(port)),
    setMode: (m: "up" | "503") => void (mode = m),
    loseRetainResponses: (n: number) => void (loseNextRetainResponses = n),
    stop: () => close(),
  };
}
export type FakeHindsight = Awaited<ReturnType<typeof startFakeHindsight>>;
