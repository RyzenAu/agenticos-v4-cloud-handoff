// Finance tiles as pure data: what each tile says for each state of its source. No fetch, no
// JSX, no wall clock (callers pass `now`). The page renders these with SignalTile, so zero,
// unknown, stale and failed never look alike, and nothing shows a success tone it hasn't earned.
//
// Sources:
//   AI spend       /__ai_usage snapshot (scripts/ai-usage/snapshot.ts)
//   NAB CSV data   /__finance_manual/status (scripts/finance/manual-plugin.ts)
//   Live bank feed basiqLiveStatus() (scripts/nab/basiq-live.ts): code-owned, fail-closed, no network
import type { SignalState, SignalTone } from "@/components/shell/page-parts";
import type { BasiqLiveStatus } from "../../../scripts/nab/basiq-live";
import { fmtDay, fmtMoney } from "../../lib/format";

export type FinanceRecovery = "import" | "retry";

export type FinanceTile = {
  id: string;
  label: string;
  value: string | number | null;
  hint?: string;
  state?: SignalState;
  tone?: SignalTone;
  loading?: boolean;
  /** Last-update time for the Freshness line (ISO), with its staleness threshold. */
  updatedAt?: string | null;
  staleAfterMs?: number;
  recovery?: { label: string; action: FinanceRecovery };
};

/** What a react-query style read looks like to these functions. */
export type Read<T> = { data: T | null | undefined; loading: boolean; failed: boolean };

// ---- NAB CSV import ------------------------------------------------------------------------
export type CsvStatus = { rowCount: number; lastImportAt: string | null; asOf?: string | null; stale?: boolean; daysSinceAsOf?: number | null };

const day = (iso: string) => fmtDay(new Date(`${iso.slice(0, 10)}T00:00:00`), { year: true });
export const IMPORT_STALE_MS = 7 * 86_400_000;

/** "CSV data: imported, as of <date>" or "none imported". Never a live-feed claim. */
export function csvDataTile(read: Read<CsvStatus>): FinanceTile {
  const base = { id: "nab-csv", label: "NAB CSV data" } as const;
  const s = read.data;
  if (!s && read.loading) return { ...base, value: null, loading: true };
  if (!s) return { ...base, value: null, state: "failed", hint: "Couldn't read the import status. Imported data is unchanged.", recovery: { label: "Retry", action: "retry" } };
  // A status with no row count says nothing about the import: Unknown, never "Imported · null rows" (REVIEW-T1 B5).
  if (typeof s.rowCount !== "number" || !Number.isFinite(s.rowCount)) return { ...base, value: null, state: "unknown", hint: "The import status didn't say how many rows were imported.", recovery: { label: "Retry", action: "retry" } };
  const rows = `${s.rowCount} ${s.rowCount === 1 ? "row" : "rows"}`;
  if (read.failed) return { ...base, value: s.rowCount ? "Imported" : null, state: "stale", hint: "Last status read; the latest check failed.", updatedAt: s.lastImportAt, staleAfterMs: IMPORT_STALE_MS, recovery: { label: "Retry", action: "retry" } };
  if (s.rowCount === 0) return { ...base, value: null, state: "unknown", hint: "None imported. No bank figures until you import one.", recovery: { label: "Import a NAB CSV", action: "import" } };
  const asOf = s.asOf ? `As of ${day(s.asOf)}` : "No posted rows yet";
  if (s.stale) return { ...base, value: "Imported", state: "stale", hint: `${asOf}${s.daysSinceAsOf !== null && s.daysSinceAsOf !== undefined ? ` · ${s.daysSinceAsOf} days old` : ""} · ${rows}`, updatedAt: s.lastImportAt, staleAfterMs: IMPORT_STALE_MS, recovery: { label: "Import a newer NAB CSV", action: "import" } };
  return { ...base, value: "Imported", state: "ok", hint: `${asOf} · ${rows}`, updatedAt: s.lastImportAt, staleAfterMs: IMPORT_STALE_MS };
}

// ---- Live bank feed (Basiq) ----------------------------------------------------------------
/** "Live bank feed: not connected (deferred by owner decision)". Never inferred from CSV data. */
export function liveFeedTile(b: BasiqLiveStatus): FinanceTile {
  const base = { id: "live-feed", label: "Live bank feed" } as const;
  const deferred = b.decision?.kind === "deferred-by-owner";
  switch (b.phase) {
    case "not-connected":
      return { ...base, value: "Not connected", state: "setup-required", hint: deferred ? "Deferred by owner decision. The NAB CSV import is the route." : "Not set up." };
    case "awaiting-consent":
      return { ...base, value: "Awaiting consent", state: "setup-required", hint: "Consent happens on NAB's and Basiq's own screens." };
    case "revoked":
      return { ...base, value: "Revoked", state: "setup-required", hint: "Access was withdrawn; nothing is synced." };
    case "error":
      return { ...base, value: null, state: "failed", hint: "The live feed reported an error." };
    case "stale":
      return { ...base, value: "Connected", state: "stale", hint: "Last sync is out of date.", updatedAt: b.lastSuccessAt, staleAfterMs: 86_400_000 };
    case "fresh":
      return { ...base, value: "Connected", state: "ok", tone: "success", updatedAt: b.lastSuccessAt, staleAfterMs: 86_400_000 };
  }
}

// ---- AI spend -------------------------------------------------------------------------------
export type AiTotals = {
  generatedAt: string;
  month: { label: string; daysInMonth: number };
  totals: { fixedAud: number; meteredAud: number; monthAud: number; projectedAud: number; unknown: string[] };
  /** Metered sources (the snapshot's apiKeys). A source whose spend couldn't be read makes "metered" unknown, not A$0.00. */
  apiKeys?: { id: string; provider?: string; spend: unknown | null; status: string; note?: string }[];
};
/** F2 FIN-4: metered sources that failed or aren't set up, so their spend is unknown. */
export function unreadMeteredSources(s: AiTotals): string[] {
  // Review T5: a source whose spend is null is unknown whatever its status ("ok" with no spend too).
  // A provider that isn't set up at all ("No … key configured") has no spend to miss.
  return (s.apiKeys ?? []).filter((k) => !k.id.startsWith("router:") && k.spend === null && !/\bno\b.*\bkey configured\b/i.test(k.note ?? "")).map((k) => k.provider ?? k.id);
}
const aud = (n: number) => fmtMoney(n);
export const AI_STALE_MS = 30 * 60_000;

/**
 * Exactly how the month-end figure is made (scripts/ai-usage/parsers.ts projectMonth): fixed
 * subscription fees count in full; metered spend so far is extended at its month-to-date daily
 * rate across every day of the month. Unpriced items are not in it.
 */
export function monthEndHint(s: AiTotals): string {
  const unpriced = s.totals.unknown.length;
  return `Subscriptions ${aud(s.totals.fixedAud)} in full, plus metered use at its daily rate so far for all ${s.month.daysInMonth} days of ${s.month.label}${unpriced ? `. Leaves out ${unpriced} unpriced ${unpriced === 1 ? "item" : "items"}` : ""}.`;
}

export function aiSpendTiles(read: Read<AiTotals>): FinanceTile[] {
  const s = read.data;
  const ids = [
    { id: "ai-spend", label: "AI spend, month to date" },
    { id: "ai-month-end", label: "Month end (estimate)" },
    { id: "ai-unpriced", label: "Not in the total" },
  ] as const;
  if (!s && read.loading) return ids.map((b) => ({ ...b, value: null, loading: true }));
  if (!s) return ids.map((b) => ({ ...b, value: null, state: "failed" as const, hint: "Usage couldn't be read.", recovery: { label: "Retry", action: "retry" as const } }));
  const t = s.totals;
  // Totals with no numbers are unknown, never "A$0.00" (REVIEW-T1 B5).
  const known = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!t || !known(t.monthAud) || !known(t.projectedAud) || !Array.isArray(t.unknown))
    return ids.map((b) => ({ ...b, value: null, state: "unknown" as const, hint: "The usage snapshot has no totals yet.", updatedAt: s.generatedAt, staleAfterMs: AI_STALE_MS }));
  // A failed refresh keeps the last snapshot on screen, marked stale, with a retry.
  const lastGood = read.failed ? { state: "stale" as const, recovery: { label: "Retry", action: "retry" as const } } : null;
  const fresh = { updatedAt: s.generatedAt, staleAfterMs: AI_STALE_MS };
  const unread = unreadMeteredSources(s);
  const metered = unread.length ? `metered ${aud(t.meteredAud)} known, ${unread.length} ${unread.length === 1 ? "source" : "sources"} unreadable (${unread.slice(0, 3).join(", ")}${unread.length > 3 ? "…" : ""})` : `metered ${aud(t.meteredAud)}`;
  return [
    { ...ids[0], ...fresh, value: `${unread.length ? "≥ " : ""}${aud(t.monthAud)}`, state: lastGood?.state ?? (t.monthAud === 0 && !unread.length ? "zero" : "ok"), recovery: lastGood?.recovery, hint: `Subscriptions ${aud(t.fixedAud)} + ${metered}` },
    // A projection, not a measured figure: "simulated" in the honest-state vocabulary.
    { ...ids[1], ...fresh, value: `≈ ${aud(t.projectedAud)}`, state: lastGood?.state ?? (t.projectedAud === 0 ? "zero" : "simulated"), hint: monthEndHint(s) },
    { ...ids[2], ...fresh, value: t.unknown.length, state: lastGood?.state ?? (t.unknown.length ? "ok" : "zero"), tone: t.unknown.length ? "warn" : undefined, hint: t.unknown.length ? "Items without a readable price" : "Every item priced" },
  ];
}

// ---- Next steps (the Finance page's "what do I do next") ------------------------------------
export type StripeLink = "connected" | "not-connected" | "key-problem" | "unknown";
export type FinanceStep = {
  id: "nab-retry" | "nab-import" | "nab-refresh" | "ai-retry" | "ai-price" | "stripe-connect";
  tone: "attention" | "info";
  title: string;
  body: string;
  /** What the step's button does: open the import, retry a read, open a page. */
  action?: { label: string; kind: "import" | "retry-nab" | "retry-ai" | "link"; to?: string; hash?: string };
};

/** The one wording for the first import (owner's words, 29 Sep 2026). */
export const NAB_ONE_STEP = "Export a CSV from NAB Internet Banking → Accounts → Export, then drop it here.";

/**
 * Derived only from the tiles' own states (nothing invented): what needs attention first, then
 * plain next steps. An empty list means nothing needs the owner on this page.
 */
export function financeNextSteps(input: { csv: FinanceTile; unpriced: FinanceTile; aiSpend: FinanceTile; stripe: StripeLink; stripeNote?: string | null }): FinanceStep[] {
  const steps: FinanceStep[] = [];
  const { csv, unpriced, aiSpend, stripe } = input;
  if (!csv.loading) {
    if (csv.state === "failed") steps.push({ id: "nab-retry", tone: "attention", title: "The bank import status couldn't be read", body: "Imported data is unchanged. Try the read again.", action: { label: "Retry", kind: "retry-nab" } });
    else if (csv.state === "stale") steps.push({ id: "nab-refresh", tone: "attention", title: "Bring the bank figures up to date", body: `${csv.hint ?? "The latest import is more than a week old"}. Import a newer NAB CSV export.`, action: { label: "Import a newer NAB CSV", kind: "import" } });
    else if (csv.state === "unknown" && csv.recovery?.action === "import") steps.push({ id: "nab-import", tone: "info", title: "Import your first NAB CSV (one step)", body: `${NAB_ONE_STEP.replace(/ here\.$/, " on Finances.")} Until then bank figures are unknown, not zero.`, action: { label: "Import a NAB CSV", kind: "import" } });
  }
  if (!aiSpend.loading && aiSpend.state === "failed") steps.push({ id: "ai-retry", tone: "attention", title: "AI usage couldn't be read", body: "The AI spend figures are unknown until it answers.", action: { label: "Retry", kind: "retry-ai" } });
  const n = typeof unpriced.value === "number" ? unpriced.value : 0;
  if (!unpriced.loading && unpriced.state !== "failed" && n > 0)
    steps.push({ id: "ai-price", tone: "attention", title: `${n} AI ${n === 1 ? "item isn't" : "items aren't"} in the total`, body: "They have no price the OS can read. Set a price on AI usage & spend to include them.", action: { label: "Set prices", kind: "link", to: "/usage", hash: "prices" } });
  if (stripe === "not-connected" || stripe === "key-problem")
    steps.push({ id: "stripe-connect", tone: "info", title: "Connect Stripe to see revenue", body: stripe === "key-problem" && input.stripeNote ? input.stripeNote : "Add a restricted, read-only Stripe key (rk_…). Nothing here moves money." });
  return steps.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "attention" ? -1 : 1));
}

/**
 * The page's one headline sentence, from the same tiles as the widgets (nothing invented): the AI
 * spend first (the one figure that is always readable), then what is missing. Unknown stays unknown:
 * a bank or Stripe that isn't connected is said, never turned into a zero.
 */
export function financeHeadline(input: { aiSpend: FinanceTile; csv: FinanceTile; stripe: StripeLink }): string {
  const { aiSpend, csv, stripe } = input;
  const head = aiSpend.loading
    ? "Reading where money stands"
    : aiSpend.state === "failed" || aiSpend.value === null
      ? "AI spend couldn't be read"
      : `AI spend is ${aiSpend.value} so far this month`;
  const gaps: string[] = [];
  if (!csv.loading) {
    if (csv.state === "failed") gaps.push("the bank status couldn't be read");
    else if (csv.state === "stale") gaps.push("the bank import is out of date");
    else if (csv.state === "unknown") gaps.push("no bank data is imported");
  }
  if (stripe === "not-connected" || stripe === "key-problem") gaps.push("Stripe isn't connected");
  return gaps.length ? `${head}; ${gaps.join(" and ")}.` : `${head}.`;
}
