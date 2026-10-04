// One-tap "Mark as business" for money that landed in the NAB ledger without a decision.
// It uses the ledger's own correction route (POST /__finance_manual/correct, page token, recorded
// against the person who tapped, undoable from Finance > Edited); nothing new on the server.
// Only offered when exactly ONE incoming payment is undecided: with several, a blanket tap could
// mislabel a personal transfer, so the owner is sent to Finance to decide row by row.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { httpManualFinanceApi, type ManualFinanceApi } from "@/components/finance/manual-finance";
import type { TxView } from "../../../scripts/finance/manual-plugin";

/** Undecided money IN (posted, ordinary income) from the review list. */
export function undecidedIncoming(rows: readonly Pick<TxView, "id" | "amountCents" | "kind" | "scope" | "status" | "vendorLabel">[]) {
  return rows.filter((r) => r.scope === "unreviewed" && r.amountCents > 0 && r.kind === "ordinary" && r.status !== "pending");
}

export type MarkBusinessDeps = { api?: ManualFinanceApi };

const defaultApi = httpManualFinanceApi();

export function MarkBusiness({ api = defaultApi }: MarkBusinessDeps) {
  const qc = useQueryClient();
  const [state, setState] = useState<"idle" | "saving" | "done" | string>("idle");
  const list = useQuery({
    queryKey: ["business-facts", "nab-undecided-in"],
    queryFn: () => api.transactions!("this-month", "review"),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (state === "done") return <span className="ml-1 text-sm text-success">Marked as business.</span>;
  if (list.isLoading || list.isError || !list.data) return null;
  const rows = undecidedIncoming(list.data.rows);
  if (rows.length === 0) return null;
  if (rows.length > 1)
    return (
      <Link to="/finance" className="ml-1 text-sm font-medium text-foreground underline underline-offset-4">
        Decide {rows.length} payments on Finance
      </Link>
    );
  const only = rows[0];
  return (
    <>
      <button
        type="button"
        className="ml-1 rounded-full border border-border px-3 py-1 text-sm font-medium text-foreground hover:bg-white/[0.06] disabled:opacity-60"
        disabled={state === "saving"}
        aria-label={`Mark the ${only.vendorLabel || "incoming"} payment as business`}
        onClick={async () => {
          setState("saving");
          try {
            await api.correct!(only.id, { scope: "business" });
            setState("done");
            await qc.invalidateQueries({ queryKey: ["business-facts"] });
            try { window.dispatchEvent(new Event("finance-manual:changed")); } catch { /* no window */ }
          } catch (e) {
            setState((e as Error).message || "Couldn't save that");
          }
        }}
      >
        {state === "saving" ? "Saving…" : "Mark as business"}
      </button>
      {state !== "idle" && state !== "saving" && state !== "done" && <span className="ml-1 text-sm text-danger">{state}</span>}
    </>
  );
}
