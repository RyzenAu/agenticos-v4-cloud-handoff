// Finance destination: owner-dropped NAB CSV → the authoritative shared business ledger
// (finance-manual.sqlite) → read-only aggregates, with review and correction.
// Data: /__finance_manual (scripts/finance/manual-plugin.ts). Nothing is read until someone drops or
// picks a file; no folder is watched. Cash flow only — never accounting profit.
//
// UI truth rules: the source is always "NAB CSV imported, as of <date>", shown separately from
// "Live bank feed: not connected"; a period no import covers shows Unknown, never $0.00; a failed
// read never shows success; nothing is imported without a preview and an explicit click.
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, FileUp, History, Landmark, Plug, Repeat, Scale, Trash2, Wrench } from "lucide-react";
import { Badge, Button, EmptyState, KeyValueList, Notice, PageHeader, Section, Segmented, Sparkline, StatusDot, Surface, Widget, WidgetGrid } from "@/components/ds";
import { FoldCard } from "@/components/shell/calm";
import { NAB_ONE_STEP } from "./signals";
import { cn } from "@/lib/utils";
import { formatAud } from "@/lib/receptionist-packages";
import type { ManualSummary, VendorLine } from "../../../scripts/finance/manual-summary";
import type { ReceptionistPaymentCandidates } from "../../../scripts/finance/manual-receptionist";
import type { AuditEntry, ImportResult, PreviewResult, Scope, TxField } from "../../../scripts/finance/manual-store";
import type { TxFilter, TxView } from "../../../scripts/finance/manual-plugin";
import type { ManualKind, NabCsvIssue } from "../../../scripts/finance/manual-nab-csv";
import type { BasiqLiveStatus } from "../../../scripts/nab/basiq-live";
import type { LegacyMigrationResult } from "../../../scripts/finance/legacy-migration";
import { fmtDateTime } from "@/lib/format";

export type ManualFinanceStatus = {
  owner: string; source: "nab-csv-manual"; rowCount: number; lastImportAt: string | null; audit: AuditEntry[];
  /** "NAB CSV imported, as of 26 Sep 2026" / "No NAB CSV imported" (server wording). */
  sourceLabel?: string; liveFeedLabel?: string; actor?: string;
  /** Latest posting date across all imported rows, and whether that is older than 7 days. */
  asOf?: string | null; stale?: boolean; daysSinceAsOf?: number | null;
  review?: ManualSummary["review"];
  legacyStore?: { present: boolean; migratedAt: string | null };
  basiq: BasiqLiveStatus; legacyNab: { admitted: boolean }; maxBytes: number;
};
export type PeriodKey = "this-month" | "last-month" | "last-90-days" | "all";
export type IssueView = NabCsvIssue & { text: string };
export type TxList = { filter: TxFilter; total: number; rows: TxView[] };
export type ManualFinanceApi = {
  status(): Promise<ManualFinanceStatus>;
  summary(period: PeriodKey): Promise<ManualSummary>;
  /** Credits equal to an approved receptionist package price: possible matches only, never a confirmed payment. Optional. */
  receptionistPayments?(period: PeriodKey): Promise<ReceptionistPaymentCandidates>;
  preview(text: string, via: "drop" | "picker"): Promise<Omit<PreviewResult, "issues"> & { issues: IssueView[] }>;
  importCsv(text: string, via: "drop" | "picker", acceptWarnings?: boolean): Promise<ImportResult>;
  clear(): Promise<{ deleted: number; backup?: string | null }>;
  transactions?(period: PeriodKey, filter: TxFilter): Promise<TxList>;
  correct?(txId: string, patch: Partial<Record<TxField, string | null>>): Promise<unknown>;
  vendorRule?(vendorId: string, patch: Partial<Record<"label" | "category" | "scope" | "kind", string | null>>): Promise<unknown>;
  migrateLegacy?(): Promise<LegacyMigrationResult>;
};

/** Fired on window after an import, correction or clear, so page-level tiles re-read the status. */
export const FINANCE_MANUAL_CHANGED = "finance-manual:changed";
/** Anchor of the import drop zone (recovery actions scroll here). */
export const NAB_IMPORT_ANCHOR = "nab-csv-import";
export const LIVE_FEED_TEXT = "Live bank feed: not connected";
const announceChange = () => { try { window.dispatchEvent(new Event(FINANCE_MANUAL_CHANGED)); } catch { /* no window (tests) */ } };

export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly line?: number | null, readonly issues: IssueView[] = []) { super(message); }
}

/** Default transport: same-origin /__finance_manual with the per-run token for mutations. */
export function httpManualFinanceApi(base = "/__finance_manual"): ManualFinanceApi {
  const read = async (res: Response) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(typeof body?.error === "string" ? body.error : "Request failed", body?.code, body?.line, Array.isArray(body?.issues) ? body.issues : []);
    return body;
  };
  const token = async () => {
    const res = await fetch("/__token", { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body?.token !== "string") throw new ApiError("This page can't authorise changes from here.");
    return body.token as string;
  };
  const post = async (path: string, body: string, type: string) => read(await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": type, "X-Claude-OS-Token": await token() }, body }));
  // Memory keeps a sourced summary of these totals; refresh it after a change (best effort).
  const refreshMemory = async () => { try { await fetch("/__operator/memory/business/sync", { method: "POST", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() }, body: "{}" }); } catch { /* memory refresh is best effort */ } };
  const changed = async <T,>(p: Promise<T>) => { const r = await p; void refreshMemory(); return r; };
  return {
    status: () => fetch(`${base}/status`, { cache: "no-store" }).then(read),
    summary: (period) => fetch(`${base}/summary?period=${encodeURIComponent(period)}`, { cache: "no-store" }).then(read),
    receptionistPayments: (period) => fetch(`${base}/receptionist-payments?period=${encodeURIComponent(period)}`, { cache: "no-store" }).then(read),
    preview: (text, via) => post(`/preview?via=${via}`, text, "text/csv; charset=utf-8"),
    importCsv: (text, via, accept) => changed(post(`/import?via=${via}${accept ? "&accept=warnings" : ""}`, text, "text/csv; charset=utf-8")),
    clear: () => changed(post("/clear", JSON.stringify({ confirm: "clear-all-imported-data" }), "application/json")),
    transactions: async (period, filter) => read(await fetch(`${base}/transactions?period=${encodeURIComponent(period)}&filter=${filter}`, { cache: "no-store", headers: { "X-Claude-OS-Token": await token() } })),
    correct: (txId, patch) => changed(post("/correct", JSON.stringify({ txId, patch }), "application/json")),
    vendorRule: (vendorId, patch) => changed(post("/vendor-rule", JSON.stringify({ vendorId, patch }), "application/json")),
    migrateLegacy: () => changed(post("/migrate-legacy", JSON.stringify({ confirm: "migrate-legacy-finance" }), "application/json")),
  };
}

const PERIODS: readonly { value: PeriodKey; label: string }[] = [
  { value: "this-month", label: "This month" }, { value: "last-month", label: "Last month" },
  { value: "last-90-days", label: "90 days" }, { value: "all", label: "All" },
];
const FILTERS: readonly { value: TxFilter; label: string }[] = [
  { value: "review", label: "To review" }, { value: "transfers", label: "Transfers" }, { value: "refunds", label: "Refunds" },
  { value: "corrected", label: "Edited" }, { value: "all", label: "All" },
];
const KIND_LABEL: Record<ManualKind, string> = { ordinary: "Spending / income", transfer: "Transfer", refund: "Refund", "bank-fee": "Bank fee", "fx-fee": "FX fee" };
const SCOPE_LABEL: Record<Scope, string> = { business: "Business", personal: "Personal", unreviewed: "Not decided" };
/** Always "A$…": en-AU currency formatting prints a bare "$". */
const aud = (cents: number) => formatAud(Math.round(cents));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-26" → "26 Sep 2026" (locale-independent). */
export const day = (iso: string | null | undefined) => { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const when = (iso: string | null) => (iso ? fmtDateTime(new Date(iso)) : "—");
/** The one wording for the data source. A CSV import is never a live feed. */
export const csvStatement = (asOf: string | null | undefined) => (asOf ? `NAB CSV imported, as of ${day(asOf)}` : "No NAB CSV imported");
const CATEGORY_LABEL: Record<string, string> = {
  "ai-models": "AI models", "voice-telephony": "Voice & telephony", "hosting-database": "Hosting & database", "creative-tools": "Creative tools",
  "payments-income": "Stripe payouts", "bank-fees": "Bank & FX fees", income: "Incoming payments", "uncategorised-in": "Other money in", "uncategorised-out": "Other spending", transfers: "Transfers",
};
const catLabel = (c: string) => CATEGORY_LABEL[c] ?? c;
/** A person id as a name: "usman" → "Usman" (F2 FIN-5). */
const person = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
const REJECT_HINT: Record<string, string> = {
  HEADER_MISMATCH: "That isn't a NAB CSV export — the header row doesn't match.",
  TOO_LARGE: "That file is larger than 4 MB. Export a shorter date range.",
  EMPTY: "The file has no transactions.",
};

type Message = { tone: "success" | "danger" | "info" | "warn"; text: string; issues?: IssueView[] };

/**
 * F2 FIN-2: only a CSV problem (a code or line issues) is the file's fault; any other refusal (a 403
 * token, a 409 read-only copy, a 500) shows the server's own reason, never "The file was rejected".
 */
export function rejectionMessage(e: unknown): Message {
  const err = e as ApiError;
  const issues = err?.issues ?? [];
  const first = issues[0];
  const fileProblem = (err?.code && REJECT_HINT[err.code]) || (first ? `${issues.length} ${issues.length === 1 ? "problem" : "problems"} found.` : err?.code ? "The file was rejected." : null);
  const text = fileProblem ?? `The server refused the request: ${(err instanceof Error && err.message) || "no reason given"}.`;
  return { tone: "danger", text: `${text} Nothing was imported.`, issues };
}
type Pending = { text: string; via: "drop" | "picker"; preview: Omit<PreviewResult, "issues"> & { issues: IssueView[] } };

export function FinanceDestination({ api: injected, embedded = false }: { api?: ManualFinanceApi; embedded?: boolean } = {}) {
  const [api] = useState(() => injected ?? httpManualFinanceApi());
  const [period, setPeriod] = useState<PeriodKey>("this-month");
  const [filter, setFilter] = useState<TxFilter>("review");
  const [status, setStatus] = useState<ManualFinanceStatus | null>(null);
  const [data, setData] = useState<ManualSummary | null>(null);
  const [txs, setTxs] = useState<TxList | null>(null);
  const [payments, setPayments] = useState<ReceptionistPaymentCandidates | null | "failed">(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const load = useCallback(async (p: PeriodKey, f: TxFilter) => {
    try {
      const [s, d, t] = await Promise.all([api.status(), api.summary(p), api.transactions ? api.transactions(p, f) : Promise.resolve(null)]);
      setStatus(s); setData(d); setTxs(t); setLoadError(null);
      // A separate, optional read: if it fails the panel says so; it never changes the figures above.
      if (api.receptionistPayments) setPayments(await api.receptionistPayments(p).catch(() => "failed" as const)); else setPayments(null);
    } catch (e) { setLoadError(e instanceof Error ? e.message : "Finance data unavailable"); }
  }, [api]);
  useEffect(() => { void load(period, filter); }, [load, period, filter]);
  const reload = () => load(period, filter);

  const rejected = rejectionMessage;
  const chooseFile = async (file: File, via: "drop" | "picker") => {
    setMessage(null); setPending(null);
    if (!/\.csv$/i.test(file.name)) return setMessage({ tone: "danger", text: "Choose the .csv file NAB exported. Nothing was imported." });
    if (file.size < 1 || file.size > (status?.maxBytes ?? 4 * 1024 * 1024)) return setMessage({ tone: "danger", text: REJECT_HINT.TOO_LARGE });
    setBusy(true);
    try {
      const text = await file.text();
      const preview = await api.preview(text, via) as Pending["preview"];
      setPending({ text, via, preview });
    } catch (e) { setMessage(rejected(e)); }
    finally { setBusy(false); }
  };
  const confirmImport = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await api.importCsv(pending.text, pending.via, pending.preview.warnings > 0);
      const parts = [`${r.inserted} new`, `${r.unchanged + r.stalePendingSkipped} already imported`];
      if (r.reconciled) parts.push(`${r.reconciled} pending now posted`);
      if (r.upgraded) parts.push(`${r.upgraded} earlier rows completed`);
      setMessage({ tone: "success", text: `${csvStatement(r.asOf)}. ${r.rowsInFile} rows (${day(r.firstDate)} – ${day(r.lastDate)}): ${parts.join(", ")}.` });
      setPending(null);
      await reload(); announceChange();
    } catch (e) { setMessage(rejected(e)); setPending(null); await reload(); }
    finally { setBusy(false); }
  };
  const clearAll = async () => {
    setBusy(true);
    try { const r = await api.clear(); setMessage({ tone: "info", text: `Deleted ${r.deleted} imported rows.${r.backup ? " A backup copy was kept on this PC first." : ""}` }); await reload(); announceChange(); }
    catch { setMessage({ tone: "danger", text: "Couldn't clear the imported data. Nothing was deleted." }); }
    finally { setBusy(false); }
  };
  const correct = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try { await run(); await reload(); announceChange(); return true; }
    catch (e) { setMessage({ tone: "danger", text: `${e instanceof Error ? e.message : "That change wasn't saved."} Nothing was changed.` }); return false; }
    finally { setBusy(false); }
  };
  const migrate = async () => {
    if (!api.migrateLegacy) return;
    setBusy(true);
    try {
      const r = await api.migrateLegacy();
      setMessage({ tone: "success", text: `Old finance store: ${r.found.csv + r.found.basiq} NAB rows found, ${r.inserted} brought in, ${r.unchanged} already here. A backup was made first; the old file is unchanged.` });
      await reload(); announceChange();
    } catch { setMessage({ tone: "danger", text: "Couldn't bring in the old finance store. Nothing was changed." }); }
    finally { setBusy(false); }
  };
  return <ManualFinanceView embedded={embedded} period={period} onPeriod={setPeriod} status={status} data={data} loadError={loadError} busy={busy} message={message}
    pending={pending} onFile={chooseFile} onConfirm={() => void confirmImport()} onCancel={() => setPending(null)} onClear={clearAll} onRetry={() => void reload()}
    txs={txs} filter={filter} onFilter={setFilter} payments={payments}
    onCorrect={api.correct ? (id, patch) => correct(() => api.correct!(id, patch)) : undefined}
    onVendorRule={api.vendorRule ? (id, patch) => correct(() => api.vendorRule!(id, patch)) : undefined}
    onMigrate={api.migrateLegacy ? () => void migrate() : undefined} />;
}

type Correct = (txId: string, patch: Partial<Record<TxField, string | null>>) => Promise<boolean>;
type VendorRule = (vendorId: string, patch: Partial<Record<"label" | "category" | "scope" | "kind", string | null>>) => Promise<boolean>;

export function ManualFinanceView({ period, onPeriod, status, data, loadError, busy, message, pending, onFile, onConfirm, onCancel, onClear, onRetry, embedded = false,
  txs, filter = "review", onFilter, onCorrect, onVendorRule, onMigrate, payments = null }: {
  period: PeriodKey; onPeriod: (p: PeriodKey) => void; status: ManualFinanceStatus | null; data: ManualSummary | null; loadError: string | null;
  busy: boolean; message: Message | null; pending?: Pending | null;
  onFile: (file: File, via: "drop" | "picker") => void; onConfirm?: () => void; onCancel?: () => void; onClear: () => void; onRetry?: () => void;
  /** Inside the /finance destination: no second page header (the shell page owns the title). */
  embedded?: boolean;
  txs?: TxList | null; filter?: TxFilter; onFilter?: (f: TxFilter) => void; onCorrect?: Correct; onVendorRule?: VendorRule; onMigrate?: () => void;
  payments?: ReceptionistPaymentCandidates | null | "failed";
}) {
  const hasData = !!status && status.rowCount > 0;
  const loading = !status && !loadError;
  const asOf = data?.asOf ?? status?.asOf ?? null;
  const description = "Cash flow from the NAB CSV you import here. Stored on this PC only.";
  // One plain status line, not a wall of pills: the source, whether it is current, the live feed
  // (a separate fact) and the last import. Each part is its own span so none can read as the other.
  const meta = <>
    <span className={asOf ? "text-foreground" : undefined}>{status?.sourceLabel ?? csvStatement(asOf)}</span>
    {/* "Recent" only when the latest read succeeded; a failed read never shows success. */}
    {asOf && (data?.stale ? <span className="text-warn">Stale · {data.daysSinceAsOf} days old</span> : loadError ? <span className="text-warn">Last loaded values</span> : <span>Recent</span>)}
    <span>{status?.liveFeedLabel ?? LIVE_FEED_TEXT}</span>
    {status?.lastImportAt && <span>Last import {when(status.lastImportAt)}</span>}
  </>;
  const actions = hasData ? <Segmented ariaLabel="Period" value={period} options={PERIODS} onChange={onPeriod} /> : undefined;
  return (
    <div className="min-w-0">
      {embedded ? (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">Bank cash flow (NAB CSV)</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
          {actions}
        </div>
      ) : (
        <PageHeader title="Finance" description={description} meta={meta} actions={actions} />
      )}
      {embedded && <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground [&>span+span]:before:mr-3 [&>span+span]:before:content-['·']" data-finance-status>{meta}</div>}
      {loadError && <Notice tone="danger" className="mb-6" title="Finance data unavailable"
        action={onRetry ? <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>Retry</Button> : undefined}>
        {loadError}. Your imported data is unchanged.{data ? " The figures below are the last ones loaded." : ""}
      </Notice>}
      {status?.legacyStore?.present && !status.legacyStore.migratedAt && onMigrate && (
        <Notice tone="info" className="mb-6" title="An older finance store is on this PC"
          action={<Button size="sm" variant="outline" disabled={busy} onClick={onMigrate}>Bring its NAB rows in</Button>}>
          NAB CSV now has one importer. Bringing the old rows in backs both stores up first, leaves the old file unchanged, and never double-counts rows a newer CSV already has.
        </Notice>
      )}
      {/* Nothing imported yet: one friendly step with the drop zone in it (W-E, owner feedback 29 Sep). */}
      <ImportZone busy={busy} message={message} pending={pending ?? null} onFile={onFile} onConfirm={onConfirm} onCancel={onCancel} rowCount={status?.rowCount ?? 0} onClear={onClear}
        compact={hasData} first={!!status && !hasData} />
      {loading && <p className="mb-10 text-sm text-muted-foreground" role="status">Loading your imported NAB data…</p>}
      {hasData && data && <Aggregates data={data} failed={!!loadError} />}
      {hasData && payments && <PackagePayments payments={payments} />}
      {hasData && txs && onFilter && <Review txs={txs} filter={filter} onFilter={onFilter} busy={busy} onCorrect={onCorrect} onVendorRule={onVendorRule} />}
      <FoldCard id="finance-sources" summary="Where the numbers come from"
        meta={`${status?.audit?.length ? `${status.audit.length} ${status.audit.length === 1 ? "import" : "imports"}` : "No imports yet"} · live bank feed not connected`}>
        <p className="mb-4 text-sm text-muted-foreground">Imported files and the live-feed status, kept separate.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          <ImportHistory status={status} />
          <BasiqCard status={status} />
        </div>
      </FoldCard>
    </div>
  );
}

function IssueList({ issues }: { issues: IssueView[] }) {
  if (!issues.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs" aria-label="Problems by row">
      {issues.slice(0, 12).map((i, n) => <li key={`${i.line}-${i.code}-${n}`}><span className="font-medium">{i.line ? `Line ${i.line}` : "File"}{i.column ? ` · ${i.column}` : ""}:</span> {i.text}</li>)}
      {issues.length > 12 && <li>…and {issues.length - 12} more.</li>}
    </ul>
  );
}

function ImportZone({ busy, message, pending, onFile, onConfirm, onCancel, onClear, rowCount, compact, first = false }: {
  busy: boolean; message: Message | null; pending: Pending | null; onFile: (f: File, via: "drop" | "picker") => void; onConfirm?: () => void; onCancel?: () => void;
  onClear: () => void; rowCount: number; compact: boolean;
  /** Nothing imported yet: the zone is the page's one friendly step. */
  first?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [over, setOver] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Arriving from Finance's "Import a NAB CSV" (...#nab-csv-import): bring the zone into view and
  // focus its button. Choosing the file stays the owner's click.
  useEffect(() => {
    try {
      if (window.location.hash !== `#${NAB_IMPORT_ANCHOR}`) return;
      zoneRef.current?.scrollIntoView({ block: "center" });
      zoneRef.current?.querySelector<HTMLElement>("[data-nab-import-button]")?.focus({ preventScroll: true });
    } catch { /* no window (tests) */ }
  }, []);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f && !busy) onFile(f, "drop"); };
  const p = pending?.preview;
  const warnings = p?.issues.filter((i) => i.severity === "warning") ?? [];
  return (
    <div className={cn("mb-8 scroll-mt-24", first && "calm-card")} id={NAB_IMPORT_ANCHOR} ref={zoneRef} data-first-import={first || undefined}>
      {first && (
        <div className="mb-4">
          <p className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground"><Landmark className="h-4 w-4" aria-hidden="true" />No NAB data imported yet</p>
          <h3 className="mt-2 text-xl font-semibold leading-tight tracking-[-0.01em] text-foreground">One step: bring in your NAB transactions</h3>
          <p className="mt-2 max-w-[62ch] text-base leading-relaxed text-foreground/90">{NAB_ONE_STEP}</p>
          <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-muted-foreground">Nothing is read until you do, and nothing is connected to your bank. Until then, bank figures are unknown, not zero.</p>
        </div>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
        className={cn("flex flex-col gap-4 rounded-2xl border border-dashed border-border-strong sm:flex-row sm:items-center sm:justify-between",
          first ? "p-6 sm:p-8" : "p-5 sm:p-6", over && "border-brand bg-brand-soft", compact || first ? "" : "py-8")}
      >
        <div className="flex min-w-0 items-start gap-4">
          <span className={cn("grid shrink-0 place-items-center rounded-full bg-inset text-muted-foreground", first ? "h-14 w-14" : "h-11 w-11")}><FileUp className={first ? "h-6 w-6" : "h-5 w-5"} aria-hidden="true" /></span>
          <div className="min-w-0">
            <div className="text-base font-semibold text-foreground">{busy ? "Checking…" : first ? "Drop the NAB CSV here" : "Import a NAB CSV"}</div>
            <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-muted-foreground">{first ? "Or choose the file. " : ""}You'll see a preview first. Re-importing an overlapping export never double-counts, and account numbers and descriptions aren't stored.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <input ref={input} id={`${id}-file`} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f, "picker"); }} />
          <Button variant="accent" size={first ? "default" : "sm"} disabled={busy} data-nab-import-button onClick={() => input.current?.click()}>Choose NAB CSV</Button>
          {rowCount > 0 && !confirming && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Clear all</Button>}
        </div>
      </div>
      {p && (
        <Notice tone={warnings.length ? "warn" : "info"} className="mt-3" title={`Preview: ${p.rowsInFile} rows, ${day(p.firstDate)} – ${day(p.lastDate)}`}
          action={<><Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
            <Button size="sm" variant="accent" disabled={busy} data-nab-confirm onClick={onConfirm}>{warnings.length ? "Import anyway" : p.inserted + p.reconciled + p.upgraded ? `Import ${p.inserted} new ${p.inserted === 1 ? "row" : "rows"}` : "Record this import"}</Button></>}>
          <span>{p.inserted} new · {p.unchanged + p.stalePendingSkipped} already imported{p.reconciled ? ` · ${p.reconciled} pending now posted` : ""}{p.upgraded ? ` · ${p.upgraded} earlier rows completed` : ""}. {csvStatement(p.asOf)} once imported.</span>
          {warnings.length > 0 && <><p className="mt-2 text-xs font-medium">Running-balance check: {warnings.length} {warnings.length === 1 ? "row doesn't" : "rows don't"} follow from the row before. A row may be missing from the export.</p><IssueList issues={warnings} /></>}
        </Notice>
      )}
      {confirming && (
        <Notice tone="warn" className="mt-3" title={`Delete all ${rowCount} imported rows from this PC?`}
          action={<><Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button><Button size="sm" variant="destructive" onClick={() => { setConfirming(false); onClear(); }}>Delete</Button></>}>
          This deletes the rows and their corrections for both founders (a backup copy is kept on this PC first). Your NAB account is not affected; you can import the CSV again later.
        </Notice>
      )}
      {message && <Notice tone={message.tone} className="mt-3">{message.text}{message.issues && <IssueList issues={message.issues} />}</Notice>}
    </div>
  );
}

function Aggregates({ data, failed = false }: { data: ManualSummary; failed?: boolean }) {
  const ins = data.daily.map((d) => d.inCents), outs = data.daily.map((d) => d.outCents);
  const none = data.periodCoverage === "none";
  // Unknown is never zero: a period no import covers shows "Unknown", not $0.00.
  const money = (cents: number) => (none ? "Unknown" : aud(cents));
  // Gaps between imports, or an account whose exports stopped, make a period partial, never a quiet $0.
  const coverageHint = none ? `No imported NAB data covers ${data.period.label.toLowerCase()}.` : data.periodCoverage === "partial" ? `Partial: ${data.coverageNote ?? "imported data doesn't cover all of this period."}` : null;
  const importedRanges = (data.coverage.ranges ?? []).map((r) => (r.from === r.to ? day(r.from) : `${day(r.from)} – ${day(r.to)}`)).join(", ") || "nothing yet";
  return (<>
    {data.stale && data.asOf && <Notice tone="warn" className="mb-6" title={`Your latest import only runs to ${day(data.asOf)}`}>Export a fresh CSV from NAB Internet Banking and import it above to bring this up to date.</Notice>}
    {none && <EmptyState variant="row" className="mb-10" icon={Landmark} title={`Unknown for ${data.period.label.toLowerCase()}`} body={`Your imports cover ${importedRanges}. These figures are unknown, not zero: import an export that covers this period.`} />}
    <Section title="Cash flow" description={`${data.period.label}. Cash flow, not accounting profit — GST is not inferred.${coverageHint ? ` ${coverageHint}` : ""}`}>
      <WidgetGrid>
        <Widget icon={ArrowDownLeft} title="Cash in" value={money(data.cashInCents)} tone={!none && data.cashInCents > 0 && !failed ? "success" : "default"} line={coverageHint ?? "Excludes transfers, refunds and Stripe payouts"}>
          {!none && ins.length > 1 && <Sparkline values={ins} className="text-muted-foreground/80" />}
        </Widget>
        <Widget icon={ArrowUpRight} title="Cash out" value={money(data.cashOutCents)} line={coverageHint ?? "Includes bank and FX fees"}>
          {!none && outs.length > 1 && <Sparkline values={outs} className="text-muted-foreground/80" />}
        </Widget>
        <Widget icon={Scale} title="Net operating cash" value={money(data.netOperatingCents)} tone={!none && data.netOperatingCents < 0 ? "danger" : "default"} line={none ? coverageHint : `All posted movement incl. transfers: ${aud(data.netCashMovementCents)}`} />
        <Widget icon={Wrench} title="Tools & subscriptions" value={money(data.tools.totalCents)} line={none ? coverageHint : `Incl. ${aud(data.tools.fxFeeCents)} NAB international fees`} />
        {!none && (
          <>
            <MiniStat icon={Repeat} label="Transfers" value={`${aud(data.transfers.outCents)} out · ${aud(data.transfers.inCents)} in`}
              note={["Kept separate", `${data.transfers.count} posted`, data.ownAccountTransfers?.pairs ? `${data.ownAccountTransfers.pairs} between your own accounts` : "", data.stripePayouts?.count ? `incl. ${aud(data.stripePayouts.inCents)} Stripe payouts (counted in Stripe revenue)` : ""].filter(Boolean).join(" · ")} />
            <MiniStat icon={ArrowDownLeft} label="Refunds" value={`${aud(data.refunds.inCents)} received`}
              note={`Kept separate · ${data.refundMatches ? `${data.refundMatches.matched} matched to a charge${data.refundMatches.unmatched ? ` · ${data.refundMatches.unmatched} not matched` : ""}` : `${data.refunds.count} posted`}`} />
            <MiniStat icon={History} label="Pending" value={`${aud(data.pending.outCents)} out${data.pending.inCents ? ` · ${aud(data.pending.inCents)} in` : ""}`} note={`Not counted · ${data.pending.count} waiting to post${data.pending.stale ? ` · ${data.pending.stale} older than 10 days` : ""}`} />
            <MiniStat icon={Scale} label="Business / personal spend" value={`${aud(data.byScope?.business.outCents ?? 0)} · ${aud(data.byScope?.personal.outCents ?? 0)}`}
              note={data.byScope?.unreviewed.outCents ? `${aud(data.byScope.unreviewed.outCents)} not decided yet` : "All spending decided"} />
          </>
        )}
      </WidgetGrid>
    </Section>
    {!none && <FoldCard id="finance-vendors" summary="Vendor costs" meta={`${data.byVendor.filter((v) => v.outCents || v.fxFeeCents || v.refundCents).length} vendors`}>
      <p className="mb-4 max-w-[70ch] text-sm text-muted-foreground">Spending by vendor, with NAB international fees attributed to the charge they were levied on and refunds matched to their charge.</p>
      {data.byVendor.length ? <VendorTable vendors={data.byVendor} /> : <EmptyState variant="row" title="No spending in this period" />}
    </FoldCard>}
    {!none && <FoldCard id="finance-categories" summary="By category" meta={`${data.byCategory.filter((r) => r.outCents > 0).length} categories`} className="mb-12">
      <CategoryBars rows={data.byCategory} />
    </FoldCard>}
  </>);
}

/**
 * Credits in the period whose amount equals an approved receptionist package price (ex GST or plus 10%). A hint to reconcile
 * against invoices: the ledger keeps no payer name, so an amount match is a POSSIBLE match and never says a client paid.
 */
function PackagePayments({ payments }: { payments: ReceptionistPaymentCandidates | "failed" }) {
  if (payments === "failed") return <Notice tone="warn" className="mb-6" title="Package payment matches unavailable">Couldn't read the package match. Nothing above changed, and no match is implied.</Notice>;
  const c = payments.candidates;
  const source = `${payments.source.statement} · not a live bank feed${payments.source.lastImportAt ? ` · last import ${when(payments.source.lastImportAt)}` : ""}`;
  const meta = c ? `${c.count} possible ${c.count === 1 ? "match" : "matches"}` : "UNKNOWN";
  return (
    <FoldCard id="finance-package-payments" summary="Possible receptionist package payments" meta={meta} className="mb-6">
      <div data-package-payments data-state={c ? "possible" : "unknown"}>
        <p className="mb-2 text-xs text-muted-foreground">Source: {source}. Period: {payments.period.label}. Approved monthly prices only (catalogue {payments.catalogue.version}); setup fees are not approved and are never matched.</p>
        {!c ? (
          <p className="text-sm"><strong className="font-semibold">UNKNOWN.</strong> No NAB CSV import covers {payments.period.label.toLowerCase()}, so this is not zero: import an export that covers it.</p>
        ) : c.count === 0 ? (
          <p className="text-sm">No credit in this period has the same amount as an approved package price.{payments.coverage === "partial" && payments.note ? ` Partial: ${payments.note}` : ""}</p>
        ) : (
          <>
            <ul className="mb-2 space-y-1 text-sm">
              {c.byPackage.map((p) => <li key={p.packageId}>{p.count} × {p.shortName}: possible match ({p.exGst ? `${p.exGst} ex GST` : ""}{p.exGst && p.incGst ? ", " : ""}{p.incGst ? `${p.incGst} incl. GST` : ""}), {aud(p.cents)}</li>)}
            </ul>
            {payments.coverage === "partial" && payments.note && <p className="text-xs text-warn">Partial: {payments.note}</p>}
          </>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{payments.caveat}</p>
      </div>
    </FoldCard>
  );
}

/** A secondary figure in the cash-flow grid: a widget whose figure is a short phrase, not one number. */
function MiniStat({ label, value, note, icon }: { label: string; value: string; note: string; icon?: typeof Repeat }) {
  return (
    <Widget icon={icon} title={label} line={note}>
      <p className="ds-num text-xl font-semibold leading-snug text-foreground">{value}</p>
    </Widget>
  );
}

function VendorTable({ vendors }: { vendors: VendorLine[] }) {
  const rows = vendors.filter((v) => v.outCents || v.fxFeeCents || v.refundCents);
  return (
    <Surface padding="none" className="overflow-hidden">
      <table className="hidden w-full text-sm md:table">
        <caption className="sr-only">Vendor costs for the selected period</caption>
        <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th scope="col" className="px-4 py-2.5 font-medium">Vendor</th><th scope="col" className="px-4 py-2.5 font-medium">Category</th>
          <th scope="col" className="px-4 py-2.5 text-right font-medium">Charges</th><th scope="col" className="px-4 py-2.5 text-right font-medium">Spend</th>
          <th scope="col" className="px-4 py-2.5 text-right font-medium">FX fees</th><th scope="col" className="px-4 py-2.5 text-right font-medium">Refunds</th>
          <th scope="col" className="px-4 py-2.5 text-right font-medium">Net cost</th>
        </tr></thead>
        <tbody>{rows.map((v) => (
          <tr key={v.vendorId} className="border-b border-border last:border-0">
            <th scope="row" className="px-4 py-2.5 text-left font-medium text-foreground"><span className="inline-flex items-center gap-2">{v.label}{v.tool && <Badge tone="accent">Tool</Badge>}</span></th>
            <td className="px-4 py-2.5 text-muted-foreground">{catLabel(v.category)}</td>
            <td className="ds-num px-4 py-2.5 text-right">{v.count}</td>
            <td className="ds-num px-4 py-2.5 text-right">{aud(v.outCents)}</td>
            <td className="ds-num px-4 py-2.5 text-right text-muted-foreground">{v.fxFeeCents ? aud(v.fxFeeCents) : "—"}</td>
            <td className="ds-num px-4 py-2.5 text-right text-muted-foreground">{v.refundCents ? `−${aud(v.refundCents)}` : "—"}</td>
            <td className="ds-num px-4 py-2.5 text-right font-semibold">{aud(v.netCostCents)}</td>
          </tr>))}
        </tbody>
      </table>
      <ul className="divide-y divide-border md:hidden">{rows.map((v) => (
        <li key={v.vendorId} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground"><span className="truncate">{v.label}</span>{v.tool && <Badge tone="accent">Tool</Badge>}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{catLabel(v.category)} · {v.count} {v.count === 1 ? "charge" : "charges"}{v.fxFeeCents ? ` · FX ${aud(v.fxFeeCents)}` : ""}{v.refundCents ? ` · refund ${aud(v.refundCents)}` : ""}</div>
          </div>
          <div className="ds-num shrink-0 text-sm font-semibold">{aud(v.netCostCents)}</div>
        </li>))}
      </ul>
    </Surface>
  );
}

function CategoryBars({ rows }: { rows: ManualSummary["byCategory"] }) {
  const outs = rows.filter((r) => r.outCents > 0), max = Math.max(1, ...outs.map((r) => r.outCents));
  if (!outs.length) return <EmptyState variant="row" title="No spending in this period" />;
  return (
    <Surface>
      <ul className="space-y-3">{outs.map((r) => (
        <li key={r.category} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[12rem_1fr_7rem]">
          <span className="truncate text-muted-foreground">{catLabel(r.category)}</span>
          <span className="h-2 rounded-full bg-inset" aria-hidden="true"><span className="block h-2 rounded-full bg-chart-1" style={{ width: `${Math.max(2, Math.round((r.outCents / max) * 100))}%` }} /></span>
          <span className="ds-num text-right">{aud(r.outCents)}</span>
        </li>))}
      </ul>
    </Surface>
  );
}

// ---- Review and correction ------------------------------------------------------------------
function Review({ txs, filter, onFilter, busy, onCorrect, onVendorRule }: { txs: TxList; filter: TxFilter; onFilter: (f: TxFilter) => void; busy: boolean; onCorrect?: Correct; onVendorRule?: VendorRule }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Section title="Review and correct" description="Mark spending business or personal, fix a transfer or refund, or recategorise. Corrections record who made them and survive every re-import."
      actions={<Segmented ariaLabel="Show" value={filter} options={FILTERS} onChange={onFilter} />}>
      {!txs.rows.length ? <EmptyState variant="row" title={filter === "review" ? "Nothing needs review in this period" : "No rows in this view"} /> : (
        <Surface padding="none" className="overflow-hidden">
          <ul className="divide-y divide-border" aria-label="Transactions">
            {txs.rows.map((t) => (
              <li key={t.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                      <span className="truncate">{t.vendorLabel}</span>
                      <Badge tone={t.kind === "transfer" ? "neutral" : t.kind === "refund" ? "info" : "neutral"}>{KIND_LABEL[t.kind]}</Badge>
                      <Badge tone={t.scope === "unreviewed" ? "warn" : "neutral"}>{SCOPE_LABEL[t.scope]}</Badge>
                      {t.status === "pending" && <Badge tone="warn">Pending</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {day(t.date)} · {catLabel(t.category)}
                      {t.ownAccountPair ? " · between your own accounts" : ""}
                      {t.kind === "refund" && t.amountCents > 0 ? (t.matchedCharge ? " · matched to its charge" : " · not matched to a charge") : ""}
                      {t.origin !== "csv" ? " · from the old finance store" : ""}
                    </div>
                    <Provenance t={t} />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={cn("ds-num text-sm font-semibold", t.amountCents > 0 && "text-success")}>{t.amountCents > 0 ? "+" : "−"}{aud(Math.abs(t.amountCents))}</span>
                    {onCorrect && <Button size="sm" variant="ghost" disabled={busy} aria-expanded={editing === t.id} onClick={() => setEditing(editing === t.id ? null : t.id)}>{editing === t.id ? "Close" : "Correct"}</Button>}
                  </div>
                </div>
                {editing === t.id && onCorrect && <CorrectionForm t={t} busy={busy} onCorrect={onCorrect} onVendorRule={onVendorRule} onDone={() => setEditing(null)} />}
              </li>
            ))}
          </ul>
          {txs.total > txs.rows.length && <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Showing {txs.rows.length} of {txs.total}. Choose a shorter period to see the rest.</p>}
        </Surface>
      )}
    </Section>
  );
}

function Provenance({ t }: { t: TxView }) {
  const edits = Object.entries(t.edited ?? {});
  if (!edits.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <History className="h-3 w-3" aria-hidden="true" />
      {edits.map(([field, p]) => <span key={field}>{field === "refundOf" ? "refund link" : field} set by {person(p!.by)}{p!.source === "vendor" ? " (vendor rule)" : ""}, {when(p!.at)}</span>).reduce<ReactNode[]>((a, e, i) => (i ? [...a, " · ", e] : [e]), [])}
    </div>
  );
}

function CorrectionForm({ t, busy, onCorrect, onVendorRule, onDone }: { t: TxView; busy: boolean; onCorrect: Correct; onVendorRule?: VendorRule; onDone: () => void }) {
  const id = useId();
  const [kind, setKind] = useState<ManualKind>(t.kind);
  const [scope, setScope] = useState<Scope>(t.scope);
  const [category, setCategory] = useState(t.category);
  const [allFromVendor, setAllFromVendor] = useState(false);
  const generic = /^(other-|incoming-payments|transfer-|nab-)/.test(t.vendorId);
  const save = async () => {
    const patch: Partial<Record<TxField, string | null>> = {};
    if (kind !== t.kind) patch.kind = kind;
    if (scope !== t.scope) patch.scope = scope;
    if (category.trim() && category.trim() !== t.category) patch.category = category.trim();
    if (!Object.keys(patch).length) return onDone();
    const ok = allFromVendor && onVendorRule && !generic ? await onVendorRule(t.vendorId, patch as Record<string, string>) : await onCorrect(t.id, patch);
    if (ok) onDone();
  };
  const revert = async () => { if (await onCorrect(t.id, { kind: null, scope: null, category: null, refundOf: null })) onDone(); };
  const field = "min-h-9 rounded-md border border-border bg-background px-2 text-sm";
  return (
    <form className="mt-3 grid gap-3 rounded-lg bg-inset p-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${id}-kind`}>Type
        <select id={`${id}-kind`} className={field} value={kind} onChange={(e) => setKind(e.target.value as ManualKind)}>
          {(Object.keys(KIND_LABEL) as ManualKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${id}-scope`}>Business or personal
        <select id={`${id}-scope`} className={field} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          {(Object.keys(SCOPE_LABEL) as Scope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${id}-cat`}>Category
        <input id={`${id}-cat`} className={field} value={category} maxLength={40} onChange={(e) => setCategory(e.target.value)} />
      </label>
      {onVendorRule && !generic && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-3">
          <input type="checkbox" checked={allFromVendor} onChange={(e) => setAllFromVendor(e.target.checked)} />
          Apply to every {t.vendorLabel} row, now and in future imports (a row's own correction still wins)
        </label>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-3">
        <Button type="submit" size="sm" variant="accent" disabled={busy}>Save correction</Button>
        {Object.keys(t.edited ?? {}).some((k) => t.edited[k as TxField]?.source === "row") && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void revert()}>Undo my corrections</Button>}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

// ---- Sources -------------------------------------------------------------------------------
function BasiqCard({ status }: { status: ManualFinanceStatus | null }) {
  const b = status?.basiq;
  return (
    <Surface className="min-w-0">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-inset text-muted-foreground"><Plug className="h-4 w-4" aria-hidden="true" /></span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{b?.headline ?? `${LIVE_FEED_TEXT} (deferred by owner decision)`}</h3>
          <StatusDot className="mt-1" tone="neutral" label={b?.decision?.kind === "deferred-by-owner" ? "Not connected: deferred by your decision (NAB CSV is the route)" : "Not connected"} />
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{b?.reason ?? "Your NAB CSV import is the data source for now."}</p>
      {b && <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">{b.requirements.map((r) => <li key={r}>{r}</li>)}</ol>}
      <p className="mt-3 text-xs text-muted-foreground">Old NAB/Basiq sync routes: {status?.legacyNab.admitted ? "admitted by a reviewed authorisation" : "switched off (fail-closed)"}. This app never asks for your NAB password.</p>
    </Surface>
  );
}

/** One line per import: "NAB CSV imported, as of 26 Sep 2026 · 24 rows · 24 new · by usman". */
export function describeAudit(a: AuditEntry): string {
  const by = a.actor ? ` · by ${person(a.actor)}` : "";
  if (a.action === "import") return `${csvStatement(a.asOf)} · ${a.rowsInFile} rows · ${a.inserted} new${a.reconciled ? ` · ${a.reconciled} settled` : ""}${a.upgraded ? ` · ${a.upgraded} completed` : ""}${a.warnings ? ` · ${a.warnings} balance warnings accepted` : ""}${by}`;
  if (a.action === "migrate-legacy") return `Old finance store brought in · ${a.rowsInFile} rows · ${a.inserted} new${by}`;
  if (a.action === "clear") return `Cleared ${a.deleted} rows${by}`;
  return `Rejected (${a.code ?? "invalid"}) · nothing imported${by}`;
}

function ImportHistory({ status }: { status: ManualFinanceStatus | null }) {
  const audit = status?.audit ?? [];
  return (
    <Surface className="min-w-0">
      <h3 className="text-sm font-semibold text-foreground">{status?.sourceLabel ?? csvStatement(status?.asOf)}</h3>
      <p className="mt-1 text-xs text-muted-foreground">Import history. Counts and dates only — no file names or transaction details are kept.</p>
      {audit.length ? <KeyValueList dense className="mt-2" items={audit.slice(0, 6).map((a) => ({ key: String(a.id), label: when(a.at), value: describeAudit(a) }))} />
        : <p className="mt-3 text-sm text-muted-foreground">No imports yet.</p>}
    </Surface>
  );
}
