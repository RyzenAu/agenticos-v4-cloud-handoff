// Read-only Stripe summary (see docs/STRIPE-FINANCE.md), on Finance → Finances. Independent of the
// NAB CSV ledger and of the demo toggle: a business can have Stripe income with no bank data yet,
// and vice versa. Stripe payouts that land in NAB are counted as transfers there, never twice.
// W-E (29 Sep 2026): the calm rounded-2xl card and large figures; `useStripeFinance` is shared
// with the Finance overview's revenue card so both read the same query.
import { useState } from "react";
import { formatAud } from "@/lib/receptionist-packages";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Receipt, RefreshCw, Repeat, ReceiptText } from "lucide-react";
import { operatorRequest } from "@/lib/operator";
import { Button, Widget, WidgetGrid, WidgetList, WidgetRow } from "@/components/ds";
import type { StripeLink } from "@/components/finance/signals";
import { fmtDay } from "@/lib/format";
import { recordedLine } from "./finance-snapshot-state";

type StripeStatus = { configured: boolean; keyStatus: { present: boolean; ok: boolean; message: string | null } };
export type StripeSummary = {
  configured: boolean;
  revenueThisMonthAud: number;
  invoices: { paidCount: number; paidAud: number; outstandingCount: number; outstandingAud: number };
  overdueInvoices: Array<{ id: string; number: string; customerName: string; amountDue: number; daysOverdue: number }>;
  nextPayout: { amount: number; arrivalDate: string } | null;
  mrrAud: number | null;
  lastSyncedAt: string | null;
};

/** Dollars → "A$1,234.50" (always "A$"; en-AU currency formatting prints a bare "$"). */
export const stripeAud = (n: number) => formatAud(Math.round(n * 100));
const dateLabel = (iso: string) => fmtDay(new Date(iso));

/** Both Stripe reads, shared by the Finances panel and the Finance overview. */
export function useStripeFinance() {
  const status = useQuery<StripeStatus>({
    queryKey: ["business-finance-stripe-status"],
    queryFn: () => operatorRequest("/business/finance/stripe/status"),
    staleTime: 60_000,
    retry: false,
  });
  const summary = useQuery<StripeSummary>({
    queryKey: ["business-finance-stripe-summary"],
    queryFn: () => operatorRequest("/business/finance/stripe/summary"),
    staleTime: 60_000,
    retry: false,
  });
  const configured = !!status.data?.configured;
  const keyProblem = !configured && !!status.data?.keyStatus.present && !status.data.keyStatus.ok;
  const link: StripeLink = status.isLoading ? "unknown" : status.error ? "unknown" : configured ? "connected" : keyProblem ? "key-problem" : "not-connected";
  return { status, summary, configured, link, keyMessage: keyProblem ? status.data?.keyStatus.message ?? null : null };
}

export function StripeFinancePanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { summary, configured, link, keyMessage } = useStripeFinance();

  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operatorRequest("/business/finance/stripe/sync", {});
      await qc.invalidateQueries({ queryKey: ["business-finance-stripe-summary"] });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const data = summary.data;
  return (
    <section className="mb-6 min-w-0" aria-label="Stripe revenue" data-stripe={link}>
      <WidgetGrid>
        {configured && data ? (
          <>
            <Widget
              icon={Receipt}
              title="Revenue this month"
              badge="Read-only"
              value={stripeAud(data.revenueThisMonthAud)}
              line={data.lastSyncedAt ? recordedLine("Last synced", data.lastSyncedAt) : undefined}
              action={
                <Button type="button" variant="outline" className="h-10 rounded-full px-5" disabled={busy} onClick={() => void refresh()}>
                  <RefreshCw className={busy ? "animate-spin" : undefined} aria-hidden="true" />
                  {busy ? "Syncing…" : "Sync Stripe"}
                </Button>
              }
            />
            <Widget
              icon={ReceiptText}
              title="Invoices"
              value={data.invoices.outstandingCount}
              line={`outstanding (${stripeAud(data.invoices.outstandingAud)}) · ${data.invoices.paidCount} paid (${stripeAud(data.invoices.paidAud)})`}
            />
            <Widget
              icon={CalendarClock}
              title="Next payout"
              value={data.nextPayout ? stripeAud(data.nextPayout.amount) : "None"}
              line={data.nextPayout ? `Arrives ${dateLabel(data.nextPayout.arrivalDate)}` : "None scheduled"}
            />
            {data.mrrAud !== null ? <Widget icon={Repeat} title="MRR" value={stripeAud(data.mrrAud)} line="Monthly recurring revenue" /> : null}
            {data.overdueInvoices.length > 0 && (
              <WidgetList icon={ReceiptText} title="Overdue" badge={data.overdueInvoices.length} span={2}>
                {data.overdueInvoices.slice(0, 8).map((inv) => (
                  <WidgetRow key={inv.id} title={inv.customerName || inv.number || inv.id} meta={`${inv.daysOverdue}d overdue`} aside={<span className="ds-num text-base font-semibold text-foreground">{stripeAud(inv.amountDue)}</span>} />
                ))}
              </WidgetList>
            )}
          </>
        ) : (
          <Widget
            icon={Receipt}
            title="Revenue this month"
            badge={configured ? undefined : link === "unknown" ? "Checking…" : undefined}
            value={configured ? null : link === "unknown" ? null : "Not connected"}
            line={
              configured
                ? summary.isPending
                  ? "Reading Stripe…"
                  : "Stripe hasn't answered with a summary yet."
                : link === "unknown"
                  ? undefined
                  : `${keyMessage ?? "No Stripe key on the hub PC yet."} Create a restricted, read-only key in Stripe and add it on the hub PC (keys are not entered in this app). Revenue is unknown until then, not zero. Nothing here moves money.`
            }
            span={2}
          />
        )}
      </WidgetGrid>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}