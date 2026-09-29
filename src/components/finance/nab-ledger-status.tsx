// Operations → NAB: the real state of the ONE finance route (the shared NAB CSV ledger), read from
// /__finance_manual/status. Loading, a failed read and "nothing imported" are three different
// states; a failed read never looks like "no data" or success. Not a live bank feed.
import { useEffect, useState } from "react";
import { asOfText } from "@/components/receptionist/dashboard/economics-by-basis";

export type NabLedgerStatusData = {
  sourceLabel?: string; liveFeedLabel?: string; rowCount: number; lastImportAt: string | null;
  asOf?: string | null; stale?: boolean; daysSinceAsOf?: number | null;
};
export type NabLedgerState =
  | { kind: "loading" }
  | { kind: "failed"; reason: string }
  | { kind: "loaded"; data: NabLedgerStatusData };

export const LIVE_FEED_LINE = "Live bank feed: not connected (deferred by owner decision)";

export async function readNabLedgerStatus(request: typeof fetch = fetch): Promise<NabLedgerStatusData> {
  const res = await request("/__finance_manual/status", { cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body.rowCount !== "number") throw new Error(typeof body?.error === "string" ? body.error : `Finance status unavailable (HTTP ${res.status})`);
  return body as NabLedgerStatusData;
}

/** Sydney time, fixed month names ("28 Sep 2026, 1:25 pm"): ICU versions print "Sep" or "Sept". */
const when = (iso: string | null) => (iso ? asOfText(iso) : "Never");

/** Pure view of one state (server-rendered in tests). */
export function NabLedgerStatusView({ state }: { state: NabLedgerState }) {
  return (
    <section aria-labelledby="nab-ledger-title" className="min-w-0 rounded-xl border border-border bg-card p-5 text-card-foreground sm:p-6" data-state={state.kind}>
      <h2 id="nab-ledger-title" className="text-xl font-semibold">NAB ledger</h2>
      <p className="mt-2 max-w-prose text-sm leading-6 text-muted-foreground">
        Finance's one route for bank data: a NAB CSV export that a founder imports on the Finance page, into one shared ledger on this PC.
      </p>
      {state.kind === "loading" && <p role="status" className="mt-4 text-sm">Reading the ledger status…</p>}
      {state.kind === "failed" && (
        <div role="alert" className="mt-4 text-sm leading-6">
          <p className="font-medium">Couldn't read the ledger status: {state.reason}</p>
          <p className="text-muted-foreground">This is a failed read, not "no data". Open Finance to check the ledger, or reload this page.</p>
        </div>
      )}
      {state.kind === "loaded" && (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Source</dt><dd className="font-medium">{state.data.sourceLabel ?? (state.data.rowCount ? "NAB CSV imported" : "No NAB CSV imported")}{state.data.stale ? ` · Stale${state.data.daysSinceAsOf != null ? ` (${state.data.daysSinceAsOf} days old)` : ""}` : ""}</dd></div>
          <div><dt className="text-muted-foreground">Transactions stored</dt><dd className="tabular-nums">{state.data.rowCount ? state.data.rowCount.toLocaleString("en-AU") : "None: figures are unknown, not zero"}</dd></div>
          <div><dt className="text-muted-foreground">Last import</dt><dd>{when(state.data.lastImportAt)}</dd></div>
          <div><dt className="text-muted-foreground">Live bank feed</dt><dd>{(state.data.liveFeedLabel ?? LIVE_FEED_LINE).replace(/^Live bank feed: /, "")}</dd></div>
        </dl>
      )}
      <a href="/finance" className="mt-4 inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-accent">
        {state.kind === "loaded" && state.data.rowCount ? "Review the ledger in Finance" : "Import a NAB CSV in Finance"}
      </a>
    </section>
  );
}

export function NabLedgerStatus({ request }: { request?: typeof fetch } = {}) {
  const [state, setState] = useState<NabLedgerState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    readNabLedgerStatus(request).then(
      (data) => live && setState({ kind: "loaded", data }),
      (e) => live && setState({ kind: "failed", reason: e instanceof Error ? e.message : "unknown error" }),
    );
    return () => { live = false; };
  }, [request]);
  return <NabLedgerStatusView state={state} />;
}
