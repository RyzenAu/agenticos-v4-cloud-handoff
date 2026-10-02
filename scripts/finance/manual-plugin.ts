// /__finance_manual — HTTP surface for the owner-initiated NAB CSV import (Finance page).
//
//   GET  /__finance_manual/summary?period=this-month   → summary(ledger, period) aggregates
//   GET  /__finance_manual/receptionist-payments?period → credits equal to an approved package price (counts, no rows)
//   GET  /__finance_manual/status                      → counts, "NAB CSV imported, as of …", audit (counts only), live-feed card
//   GET  /__finance_manual/transactions?period&filter  → rows for review/correction (labels + amounts, no bank text) (token)
//   GET  /__finance_manual/edits                       → correction history (who, when, old → new) (token)
//   POST /__finance_manual/preview?via=drop|picker     → what an import would do; writes nothing (token)
//   POST /__finance_manual/import?via=drop|picker[&accept=warnings] → body = the CSV text the owner dropped/picked (token)
//   POST /__finance_manual/correct      {"txId","patch"}     → one row's kind/category/scope/refund link (token)
//   POST /__finance_manual/vendor-rule  {"vendorId","patch"} → every row of one vendor (token)
//   POST /__finance_manual/migrate-legacy {"confirm":"migrate-legacy-finance"} → legacy finance.sqlite rows, backed up first (token)
//   POST /__finance_manual/clear  {"confirm":"clear-all-imported-data"} → deletes the imported rows (token)
//   GET  /__finance_manual/ask?q=…                     → Jarvis: deterministic cost/margin answer
//
// Loopback only (Tailscale Serve also arrives on loopback). Who is asking is the verified principal
// from the one identity contract (scripts/identity/principal.ts, Stage B1) — never the request body,
// query or a relay header: a request that claims Host: localhost through x-forwarded-*, forwarded or
// tailscale-* headers is nobody. Mutations need the caller's own page token. Nothing here is
// scheduled at startup, nothing watches a folder, nothing reads a file path: the store opens on first request.
//
// V7: ONE shared business ledger. The principal is who is asking (provenance: "imported by",
// "corrected by"), never whose data: both founders see and correct the same NAB data.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { basiqLiveStatus } from "../nab/basiq-live";
import { legacyNabAdmission } from "./legacy-admission";
import { legacyNabRowCount, migrateLegacyFinance, type LegacyMigrationResult } from "./legacy-migration";
import { answerManualFinanceQuestion, matchManualFinanceQuestion } from "./manual-jarvis";
import { NAB_CSV_ISSUE_TEXT, NAB_CSV_MAX_BYTES, NabCsvRejected, type NabCsvIssue } from "./manual-nab-csv";
import { SHARED_LEDGER, closeSharedManualStores, sharedManualStore, type EffectiveRow, type ManualFinanceStore, type TxField, type VendorField } from "./manual-store";
import { receptionistPaymentCandidates } from "./manual-receptionist";
import { LIVE_FEED_LABEL, matchRefunds, ownAccountPairs, parsePeriodParam, resolvePeriod, summary, sydneyToday } from "./manual-summary";
import { pageTokenOk, requestPrincipal } from "../identity/gate";
import { authorise, isBrowserPrincipal, type Principal } from "../identity/principal";

export const CLEAR_CONFIRMATION = "clear-all-imported-data";
export const MIGRATE_CONFIRMATION = "migrate-legacy-finance";

type ReqLike = { socket?: { remoteAddress?: string | null }; headers?: Record<string, any> };

/**
 * Whose ledger. null = refuse. Never reads the body or query. Stage B1: the verified principal from
 * the one identity contract (scripts/identity/principal.ts), so a relayed request that claims
 * Host: localhost (x-forwarded-for, forwarded, tailscale-*) is nobody rather than the PC owner.
 * `principal` is a test seam. Rows stay keyed by the verified person, as before.
 */
export function resolveManualFinanceOwner(req: ReqLike, options: { root: string; principal?: (req: ReqLike) => Principal | null }): string | null {
  const principal = (options.principal ?? ((r: ReqLike) => requestPrincipal(r, { root: options.root })))(req);
  if (!isBrowserPrincipal(principal) || !authorise(principal, { kind: "business", area: "finance" }, "read").ok) return null;
  return principal.personId;
}

/** `owner` is the verified person asking: provenance only. Every request reads the shared ledger. */
export type ManualFinanceRequest = { method: string; path: string; query: URLSearchParams; owner: string | null; tokenOk: boolean; body?: string; contentType?: string };
export type ManualFinanceReply = { status: number; body: unknown };
export type TxFilter = "review" | "transfers" | "refunds" | "corrected" | "all";
export type TxView = Pick<EffectiveRow, "id" | "date" | "status" | "amountCents" | "kind" | "category" | "scope" | "vendorId" | "vendorLabel" | "known" | "refundOf" | "edited" | "base" | "origin"> & {
  /** Refund → the charge it was matched to (by the owner or automatically). */
  matchedCharge: string | null;
  /** Transfer tied to its mirror in another of the owner's accounts. */
  ownAccountPair: string | null;
  needsReview: boolean;
};
export type ManualFinanceDeps = {
  store: () => ManualFinanceStore;
  today?: () => string;
  /** Legacy finance.sqlite: present? and the migration (backed up first). Absent in isolated previews. */
  legacy?: { present: () => boolean; migrate: (actor: string) => LegacyMigrationResult };
};

const issueView = (i: NabCsvIssue) => ({ ...i, text: NAB_CSV_ISSUE_TEXT[i.code] });
const json = (body: string | undefined): any => { try { return JSON.parse(body ?? "{}"); } catch { return undefined; } };

/** Rows for the review list, with the refund/transfer links the summary uses. */
export function transactionViews(rows: EffectiveRow[], filter: TxFilter, range: { from: string | null; to: string | null }): TxView[] {
  const refunds = matchRefunds(rows), pairs = ownAccountPairs(rows);
  const pairOf = new Map<string, string>();
  for (const [credit, debit] of pairs) { pairOf.set(credit, debit); pairOf.set(debit, credit); }
  return rows
    .filter((r) => (range.from === null || r.date >= range.from) && (range.to === null || r.date <= range.to))
    .map((r): TxView => {
      const matchedCharge = refunds.get(r.id) ?? null;
      const ownAccountPair = pairOf.get(r.id) ?? null;
      const operating = r.status === "posted" && r.kind !== "transfer" && r.kind !== "refund" && !ownAccountPair;
      const needsReview = (operating && r.scope === "unreviewed") || (r.kind === "refund" && r.amountCents > 0 && !matchedCharge);
      return { id: r.id, date: r.date, status: r.status, amountCents: r.amountCents, kind: r.kind, category: r.category, scope: r.scope, vendorId: r.vendorId,
        vendorLabel: r.vendorLabel, known: r.known, refundOf: r.refundOf, edited: r.edited, base: r.base, origin: r.origin, matchedCharge, ownAccountPair, needsReview };
    })
    .filter((v) => filter === "all" || (filter === "review" && v.needsReview) || (filter === "transfers" && (v.kind === "transfer" || !!v.ownAccountPair))
      || (filter === "refunds" && v.kind === "refund") || (filter === "corrected" && Object.keys(v.edited).length > 0))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/** Transport-independent handler (used by the Vite plugin and the isolated preview). */
export function handleManualFinance(req: ManualFinanceRequest, deps: ManualFinanceDeps): ManualFinanceReply {
  const route = req.path.replace(/\/+$/, "") || "/";
  if (!req.owner) return { status: 403, body: { error: "Not allowed from here.", code: "OWNER_UNRESOLVED" } };
  const actor = req.owner, ledger = SHARED_LEDGER;
  const today = deps.today?.();
  const mutation = (fn: () => ManualFinanceReply): ManualFinanceReply => (req.tokenOk ? fn() : { status: 403, body: { error: "Forbidden", code: "TOKEN" } });
  const csvUpload = (fn: (via: "drop" | "picker") => ManualFinanceReply) => mutation(() => {
    const via = req.query.get("via");
    if (via !== "drop" && via !== "picker") return { status: 400, body: { error: "Import only from a file you dropped or picked.", code: "OWNER_ACTION_REQUIRED" } };
    if (!/^text\/(csv|plain)\b/i.test(req.contentType ?? "")) return { status: 415, body: { error: "Send the CSV as text/csv.", code: "CONTENT_TYPE" } };
    return fn(via);
  });
  try {
    if (req.method === "GET" && route === "/summary") {
      return { status: 200, body: summary(ledger, parsePeriodParam(req.query.get("period")), { store: deps.store(), today }) };
    }
    // Approved-package price matches: counts and totals per package only, no rows (same class as /summary).
    if (req.method === "GET" && route === "/receptionist-payments") {
      return { status: 200, body: receptionistPaymentCandidates(parsePeriodParam(req.query.get("period")), { store: deps.store(), today }) };
    }
    if (req.method === "GET" && route === "/status") {
      const store = deps.store();
      const legacy = legacyNabAdmission("status");
      // asOf = latest posting date across everything imported; stale after STALE_AFTER_DAYS.
      const all = summary(ledger, "all", { store, today });
      return { status: 200, body: {
        owner: ledger, ledger, actor, source: "nab-csv-manual", sourceLabel: all.sourceLabel, live: false, liveFeedLabel: LIVE_FEED_LABEL,
        rowCount: store.count(ledger), lastImportAt: store.lastImportAt(ledger), audit: store.audit(ledger, 10),
        asOf: all.asOf, stale: all.stale, daysSinceAsOf: all.daysSinceAsOf, coverage: all.coverage, review: all.review,
        basiq: basiqLiveStatus(), legacyNab: { admitted: legacy.admitted },
        legacyStore: { present: deps.legacy?.present() ?? false, migratedAt: store.legacyMigratedAt() },
        maxBytes: NAB_CSV_MAX_BYTES,
      } };
    }
    // Row-level reads need the caller's page token too (review #8): a local process with only a
    // principal (an agent with a fetch tool) gets period totals, never transaction rows.
    if (req.method === "GET" && (route === "/transactions" || route === "/edits") && !req.tokenOk) return { status: 403, body: { error: "Forbidden", code: "TOKEN" } };
    if (req.method === "GET" && route === "/transactions") {
      const filter = (req.query.get("filter") ?? "review") as TxFilter;
      if (!["review", "transfers", "refunds", "corrected", "all"].includes(filter)) return { status: 400, body: { error: "Unknown filter.", code: "FILTER" } };
      const range = resolvePeriod(parsePeriodParam(req.query.get("period")), today ?? sydneyToday());
      const limit = Math.max(1, Math.min(500, Number(req.query.get("limit") ?? 200) || 200));
      const views = transactionViews(deps.store().rows(ledger), filter, range);
      return { status: 200, body: { filter, period: range, total: views.length, rows: views.slice(0, limit) } };
    }
    if (req.method === "GET" && route === "/edits") {
      const store = deps.store();
      return { status: 200, body: { edits: store.editLog(ledger, Number(req.query.get("limit") ?? 50) || 50), vendorRules: store.vendorOverrides(ledger) } };
    }
    if (req.method === "GET" && route === "/ask") {
      const intent = matchManualFinanceQuestion(req.query.get("q") ?? "", sydneyToday());
      if (!intent) return { status: 200, body: { matched: false } };
      const s = summary(ledger, intent.period, { store: deps.store(), today });
      return { status: 200, body: { matched: true, intent, said: answerManualFinanceQuestion(intent, s) } };
    }
    if (req.method === "POST" && route === "/preview") {
      return csvUpload(() => {
        const preview = deps.store().previewCsv(ledger, req.body ?? "");
        return { status: 200, body: { ...preview, issues: preview.issues.map(issueView) } };
      });
    }
    if (req.method === "POST" && route === "/import") {
      return csvUpload((via) => {
        const result = deps.store().importCsv(ledger, req.body ?? "", via, { actor, acceptWarnings: req.query.get("accept") === "warnings" });
        return { status: 200, body: { ...result, issues: result.issues.map(issueView) } };
      });
    }
    if (req.method === "POST" && route === "/correct") {
      return mutation(() => {
        const body = json(req.body);
        if (!body || typeof body.txId !== "string" || !body.patch || typeof body.patch !== "object") return { status: 400, body: { error: "Say which row and what to change.", code: "BAD_REQUEST" } };
        return { status: 200, body: deps.store().setTxOverride(ledger, body.txId, body.patch as Partial<Record<TxField, string | null>>, actor) };
      });
    }
    if (req.method === "POST" && route === "/vendor-rule") {
      return mutation(() => {
        const body = json(req.body);
        if (!body || typeof body.vendorId !== "string" || !body.patch || typeof body.patch !== "object") return { status: 400, body: { error: "Say which vendor and what to change.", code: "BAD_REQUEST" } };
        return { status: 200, body: { vendorRules: deps.store().setVendorOverride(ledger, body.vendorId, body.patch as Partial<Record<VendorField, string | null>>, actor) } };
      });
    }
    if (req.method === "POST" && route === "/migrate-legacy") {
      return mutation(() => {
        if (json(req.body)?.confirm !== MIGRATE_CONFIRMATION) return { status: 400, body: { error: "Confirmation required.", code: "CONFIRM" } };
        if (!deps.legacy?.present()) return { status: 404, body: { error: "No legacy finance store here.", code: "NO_LEGACY" } };
        if (deps.store().legacyMigratedAt()) return { status: 409, body: { error: "The old finance store was already brought in.", code: "ALREADY_MIGRATED" } };
        return { status: 200, body: deps.legacy.migrate(actor) };
      });
    }
    if (req.method === "POST" && route === "/clear") {
      return mutation(() => {
        if (json(req.body)?.confirm !== CLEAR_CONFIRMATION) return { status: 400, body: { error: "Confirmation required.", code: "CONFIRM" } };
        return { status: 200, body: deps.store().clear(ledger, actor) };
      });
    }
    return { status: 404, body: { error: "Not found" } };
  } catch (error) {
    if (error instanceof NabCsvRejected) return { status: 422, body: { error: error.message, code: error.code, line: error.line, issues: error.issues.map(issueView) } };
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "FAILED";
    const client = ["INVALID_PERIOD", "INVALID_VALUE", "INVALID_FIELD", "INVALID_VENDOR", "INVALID_REFUND_LINK", "UNKNOWN_TRANSACTION"].includes(code);
    return { status: client ? 400 : 500, body: { error: client ? "That change isn't valid." : "Finance request failed.", code } };
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return; // drain and discard the rest so the reply can still be delivered
      size += chunk.length;
      if (size > limit) { over = true; chunks.length = 0; reject(new NabCsvRejected("TOO_LARGE")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

export function manualFinancePlugin(options: { root: string; token: string }): Plugin {
  let store: ManualFinanceStore | null = null;
  // The process-wide handle; opening it folds any per-person ledgers (the w2 design) into the
  // shared one, backing the file up first (manual-store.ts consolidateLedgers).
  const getStore = () => (store ??= sharedManualStore(options.root));
  // Only offered when the retired store still holds NAB rows (a read-only count, cached: nothing
  // writes NAB rows there any more). Unreadable → offered, so the owner can still migrate.
  let legacyRows: number | null | undefined;
  const legacy = {
    present: () => { if (legacyRows === undefined) legacyRows = legacyNabRowCount(options.root); return legacyRows === null || legacyRows > 0; },
    migrate: (actor: string) => { const r = migrateLegacyFinance({ root: options.root, apply: true, actor, store: getStore() }); legacyRows = undefined; return r; },
  };
  return {
    name: "agentic-os-finance-manual",
    configureServer(server) {
      server.httpServer?.once("close", () => { if (store) closeSharedManualStores(); store = null; });
      server.middlewares.use("/__finance_manual", (req: IncomingMessage, res: ServerResponse) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(body));
        };
        const url = new URL(req.url ?? "/", "http://local");
        const owner = resolveManualFinanceOwner(req, { root: options.root });
        // The caller's OWN page token (Stage B1): internal at this PC, person-bound remotely.
        const tokenOk = pageTokenOk(req, options.token, { root: options.root });
        const base = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, owner, tokenOk, contentType: String(req.headers["content-type"] ?? "") };
        const deps = { store: getStore, legacy };
        if (req.method !== "POST") { const r = handleManualFinance(base, deps); return send(r.status, r.body); }
        if (!owner || !tokenOk) return send(403, { error: "Forbidden" });
        if (Number(req.headers["content-length"] ?? 0) > NAB_CSV_MAX_BYTES + 1024) return send(413, { error: "Upload failed.", code: "TOO_LARGE" });
        readBody(req, NAB_CSV_MAX_BYTES + 1024).then(
          (body) => { const r = handleManualFinance({ ...base, body }, deps); send(r.status, r.body); },
          (error) => send(error instanceof NabCsvRejected ? 413 : 400, { error: "Upload failed.", code: error instanceof NabCsvRejected ? error.code : "READ" }),
        );
      });
    },
  };
}
