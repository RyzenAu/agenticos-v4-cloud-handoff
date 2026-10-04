import { useEffect, useId, useState } from "react";
import { Button } from "../ui/button";
import { formatAud } from "../../lib/receptionist-packages";
import { createNabSyntheticService, type NabScope, type NabSyntheticService, type OwnerContext } from "../../../scripts/nab/service";
import { createNabSyntheticScheduler, subscribeNabStatus, type NabTimers } from "../../../scripts/nab/lifecycle";
import { fmtDateTime } from "@/lib/format";

type NabConnectionProps = { timers?: NabTimers; syntheticService?: NabSyntheticService; ownerContext?: OwnerContext };
/** Self-contained ephemeral view. No fetch, storage, banking credentials or live consent. */
function NabConnectionView({ timers, syntheticService, ownerContext }: NabConnectionProps) {
  const id = useId();
  const [service] = useState(() => syntheticService ?? createNabSyntheticService({ now: timers?.now }));
  // A host may supply a trusted authenticated context; file contents never determine ownership.
  const [context] = useState(() => ({ ...(ownerContext ?? { tenantId: "synthetic-preview", ownerId: "synthetic-owner" }) }));
  const [scheduler] = useState(() => createNabSyntheticScheduler(service, context, timers));
  const [status, setStatus] = useState(() => service.status(context));
  const [scopes, setScopes] = useState<NabScope[]>(["accounts"]);
  const [accepted, setAccepted] = useState(false);
  const [durationDays, setDurationDays] = useState(1);
  const [message, setMessage] = useState("");
  useEffect(() => subscribeNabStatus(service, context, setStatus, window, document, timers), [service, timers, status.generation]);
  useEffect(() => () => scheduler.stop(), [scheduler, status.generation]);
  const allowed = ["awaiting-import", "fresh", "stale", "error"].includes(status.phase);
  const money = (minor: number | null) => minor === null ? "Not shared" : formatAud(Math.round(minor));
  function run(action: () => void) {
    try { action(); setStatus(service.status(context)); }
    catch { setStatus(service.status(context)); setMessage("The sample action was rejected. Review the selected permissions and try again."); }
  }
  return <section aria-labelledby={`${id}-title`} className="min-w-0 rounded-xl border border-border bg-card p-5 text-card-foreground sm:p-6">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 id={`${id}-title`} className="text-xl font-semibold">NAB connection</h2>
      <span className="text-sm font-semibold">Synthetic / not connected</span>
    </div>
    <p className="mt-3 max-w-prose text-sm leading-6 text-muted-foreground">Explore read-only cash flow with built-in sample records. Nothing connects to NAB. Sample permissions and records disappear when you leave this view.</p>
    <div className="mt-6 grid gap-8 md:grid-cols-2">
      <form onSubmit={event => { event.preventDefault(); if (!accepted) return; run(() => {
        scheduler.stop();
        service.consent(context, { acknowledgement: "synthetic-only", purpose: "cash-flow-review", scopes, accountIds: ["syn-business"], durationDays });
        setMessage(`Sample permissions enabled for ${durationDays} day${durationDays === 1 ? "" : "s"}. No bank consent was created.`);
      }); }}>
        <fieldset className="space-y-3">
          <legend className="mb-3 font-medium">Choose sample permissions</legend>
          <p className="text-sm leading-6 text-muted-foreground">Purpose: cash-flow review. Account: Synthetic business account. No payments or payee access.</p>
          <label className="flex flex-wrap items-center gap-3 text-sm">Sample permission duration
            <select className="min-h-11 rounded-md border border-border bg-background px-3" value={durationDays} onChange={event => setDurationDays(Number(event.target.value))}>
              <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option>
            </select>
          </label>
          {([['accounts', 'Account identity (required)'], ['balances', 'Account balance'], ['transactions', 'Transaction cash flow']] as const).map(([scope, label]) =>
            <label key={scope} className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" className="size-4 accent-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" checked={scopes.includes(scope)} disabled={scope === "accounts"} onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(value => value !== scope))} />{label}
            </label>)}
          <label className="flex min-h-11 items-start gap-3 text-sm leading-6">
            <input type="checkbox" className="mt-1 size-4 shrink-0 accent-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
            I understand this uses synthetic data only and does not authorise access to my bank.
          </label>
        </fieldset>
        <Button type="submit" className="mt-4 min-h-11" disabled={!accepted}>Enable sample permissions</Button>
        <p className="mt-2 text-sm text-muted-foreground">Changing permissions clears the previous sample.</p>
      </form>
      <div className="min-w-0">
        <h3 className="font-medium">Sample connection status</h3>
        <dl className="mt-3 space-y-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><dt>Permission state</dt><dd>{status.phase.replaceAll("-", " ")}</dd></div>
          <div className="flex flex-wrap justify-between gap-2"><dt>Balance · AUD</dt><dd className="tabular-nums">{money(status.balanceMinor)}</dd></div>
          <div className="flex flex-wrap justify-between gap-2"><dt>Net cash movement</dt><dd className="tabular-nums">{money(status.cashFlow?.netCashMinor ?? null)}</dd></div>
          <div><dt>Last sample refresh</dt><dd className="mt-1 break-words text-muted-foreground">{status.lastSyncAt ? fmtDateTime(new Date(status.lastSyncAt), { year: true }) : "No sample imported"}</dd></div>
          <div><dt>Next refresh eligible</dt><dd className="mt-1 break-words text-muted-foreground">{status.nextRefreshAt ? fmtDateTime(new Date(status.nextRefreshAt), { year: true }) : "Not scheduled"}</dd></div>
          <div><dt>Automatic sample refresh</dt><dd className="mt-1 text-muted-foreground">{scheduler.running() ? "On while this view is open" : "Off"}</dd></div>
        </dl>
        {status.cashFlow && <p className="mt-4 text-sm leading-6 text-muted-foreground">{status.cashFlow.pendingCount} pending and {status.cashFlow.transferCount} transfer entries excluded. Refunds shown separately in the service totals. Cash movement is not accounting profit; GST is not inferred.</p>}
        {status.insights && <div className="mt-4 space-y-2 text-sm leading-6">
          <p>{status.insights.invoiceMatches.length} invoice-match suggestion; no invoice marked paid.</p>
          {status.insights.vendorSpend.map(vendor => <p key={vendor.vendorId}>Synthetic software vendor: {money(vendor.netSpendMinor)} net spend across {vendor.count} posted debits.</p>)}
          <p>{status.insights.recurringCandidates.length} recurring-payment candidate. A repeated amount does not confirm a subscription.</p>
        </div>}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11" disabled={!allowed} onClick={() => run(() => {
            const result = service.importFixture(context, { fixtureId: "cashflow-v1", ownerInitiated: true, generation: status.generation });
            setMessage(`Sample import finished: ${result.changed} changed entries. Repeating it does not duplicate entries.`);
          })}>Import built-in sample</Button>
          <Button variant="outline" className="min-h-11" disabled={!allowed || !status.scopes.includes("transactions")} onClick={() => run(() => {
            service.importFixture(context, { fixtureId: "insights-v1", ownerInitiated: true, generation: status.generation });
            setMessage("Two synthetic monthly vendor entries imported for review. No subscription was created or confirmed.");
          })}>Add recurring sample</Button>
          <Button variant="outline" className="min-h-11" disabled={!allowed} onClick={() => run(() => {
            const result = service.refresh(context, { generation: status.generation });
            setMessage(result.skipped ? "Refresh is not due yet. No bank was contacted." : "Synthetic refresh finished. No bank was contacted.");
          })}>Check sample refresh</Button>
          <Button variant="outline" className="min-h-11" disabled={!allowed} onClick={() => run(() => {
            if (scheduler.running()) { scheduler.stop(); setMessage("Automatic sample refresh stopped."); }
            else {
              scheduler.start({ acknowledgement: "synthetic-only", generation: status.generation });
              setMessage("Automatic sample refresh enabled: imports the built-in sample when due, at most once daily. Stops on expiry, permission changes or leaving this view. No OS task or bank request is created.");
            }
          })}>{scheduler.running() ? "Stop automatic sample refresh" : "Start automatic sample refresh"}</Button>
          <Button variant="ghost" className="min-h-11" disabled={status.phase === "not-consented" || status.phase === "revoked"} onClick={() => run(() => {
            scheduler.stop(); service.revoke(context); setAccepted(false); setMessage("Sample permissions revoked and sample records removed. This does not revoke any existing bank consent.");
          })}>Revoke and clear sample</Button>
        </div>
      </div>
    </div>
    <p role="status" aria-live="polite" className="mt-5 min-h-6 text-sm leading-6">{message}</p>
    <div className="mt-4 border-t border-border pt-5 text-sm leading-6">
      <h3 className="font-medium">Your real NAB data</h3>
      <p className="mt-2 max-w-prose text-muted-foreground">Import your NAB CSV export on the Finance page. That is the one importer: it keeps your data on this PC, never double-counts an overlapping export, and shows it as "NAB CSV imported, as of" a date, never as a live bank feed.</p>
      <a href="/finance" className="mt-3 inline-flex min-h-11 items-center rounded-md border border-border px-3 font-medium hover:bg-accent">Open Finance</a>
    </div>
    <div className="mt-4 border-t border-border pt-5 text-sm leading-6">
      <h3 className="font-medium">Before a live connection</h3>
      <p className="mt-2 max-w-prose text-muted-foreground">Your account type is NAB Business. Basiq is the proposed CDR provider, subject to onboarding and a written quote. Specific product eligibility, representative access, retention terms and live consent approval remain outstanding. Authentication must happen on the provider and bank screens. This view cannot request credentials or create live consent.</p>
      <p className="mt-2 max-w-prose text-muted-foreground">The NAB CSV import on the Finance page is not a live NAB sync. No Downloads folder is scanned.</p>
    </div>
  </section>;
}

/** Owner changes remount the synthetic view so no sample state carries across people. */
export function NabConnection(props: NabConnectionProps = {}) {
  const owner = props.ownerContext ?? { tenantId: "synthetic-preview", ownerId: "synthetic-owner" };
  return <NabConnectionView key={JSON.stringify([owner.tenantId, owner.ownerId])} {...props} />;
}

export default NabConnection;
