// Finance: a grid of widgets (L3, 29 Sep 2026, owner: "too small, not good on the eyes", and the
// widget-grid direction from the Inbox). One headline sentence, then four widgets that say where
// money stands (AI spend, bank, Stripe revenue, live feed), then what needs you and the package
// margins side by side; the margin table and margins by basis are folded underneath. Freshness and
// sources are one line at the foot. The NAB CSV ledger itself lives on Finance → Finances
// (/business?view=finance); the bank widget links there.
//
// Authorised aggregates only, each figure derived from its source (src/components/finance/
// signals.ts), never hard-coded:
//   - AI spend: /__ai_usage snapshot (provider-reported, estimates marked).
//   - NAB CSV data: /__finance_manual/status (imported rows, latest posting date, last import).
//   - Live bank feed: basiqLiveStatus() — code-owned, fail-closed, no network; deferred by owner.
//   - Stripe revenue: read-only. Stripe payouts landing in NAB are reported with transfers there,
//     so the same money is never counted as both NAB cash in and Stripe revenue.
//   - Package margins: ESTIMATES from src/lib/business-economics.ts, shown once, here.
//   - Margins by basis: per tier, estimated / measured / reconciled from actual usage
//     (scripts/receptionist/usage-economics.ts via /__receptionist/dashboard), never mixed.
import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Landmark, ListChecks, Percent, Receipt, Wallet } from "lucide-react";
import { Badge, EmptyState, PageFoot, PageHeader, Surface, WidgetGrid, WidgetList, WidgetRow } from "@/components/ds";
import { stripeAud, useStripeFinance } from "@/components/business/stripe-finance-panel";
import { FINANCE_MANUAL_CHANGED, NAB_IMPORT_ANCHOR, type ManualFinanceStatus } from "@/components/finance/manual-finance";
import { aiSpendTiles, csvDataTile, financeHeadline, financeNextSteps, liveFeedTile, type FinanceStep, type FinanceTile } from "@/components/finance/signals";
import { useNow } from "@/components/workspace/panel-shell";
import { ECONOMICS_AS_OF, packageEconomicsMatrix } from "@/lib/business-economics";
import { RECEPTIONIST_PACKAGES, formatAud } from "@/lib/receptionist-packages";
import { useAiUsage } from "@/lib/ai-usage";
import { basiqLiveStatus } from "../../../../scripts/nab/basiq-live";
import { useReceptionistDashboard } from "@/lib/receptionist-dashboard";
import { TierBasisTable, asOfText } from "@/components/receptionist/dashboard/economics-by-basis";
import { useInspectorFacts } from "../inspector";
import { MOUNT_FILES, hasMount } from "../mounts";
import { DrilldownList } from "../page-parts";
import { FoldCard } from "../calm";
import { SignalWidget, WidgetButton, WidgetLink, agoText } from "../widgets";
import { fmtProse } from "@/lib/format";

const pct = (bps: number | null) => (bps === null ? "—" : `${Math.round(bps / 100)}%`);
/** Where the NAB CSV import lives (the Finances tab) and its drop zone. */
const FINANCES = { to: "/business", search: { view: "finance" }, hash: NAB_IMPORT_ANCHOR } as const;

/**
 * The one package-margin presentation in the OS outside the workbench: base-case estimate at 5
 * clients per tier, straight from packageEconomicsMatrix(). Prices ex GST; status from the catalogue.
 */
function usePackageRows() {
  return useMemo(
    () =>
      packageEconomicsMatrix([5]).map((p) => {
        const base = p.scenarios.find((s) => s.scenarioId === "base") ?? p.scenarios[0];
        const high = p.scenarios.find((s) => s.scenarioId === "high");
        return {
          id: p.packageId,
          name: p.name,
          status: RECEPTIONIST_PACKAGES.find((k) => k.id === p.packageId)?.pricing.status === "approved" ? "Approved" : "Proposed",
          price: p.monthlyExGstCents,
          minutes: Math.round(base.minutesPerClient),
          margin: base.byClients[0].estimated.operatingMarginBps,
          highMargin: high?.byClients[0].estimated.operatingMarginBps ?? null,
          incomplete: base.byClients[0].estimated.incomplete,
        };
      }),
    [],
  );
}
type PackageRow = ReturnType<typeof usePackageRows>[number];

/** The package margins as one list widget: name and price, the estimate at the right. */
function MarginList({ rows }: { rows: PackageRow[] }) {
  return (
    <WidgetList
      icon={Percent}
      title="Package margins (estimate)"
      span={4}
      id="package-margins-widget"
      data-testid="package-margin-rings"
      action={<WidgetLink to="/operations">Open the economics workbench</WidgetLink>}
    >
      {rows.map((r) => (
        <WidgetRow
          key={r.id}
          title={r.name}
          meta={`${formatAud(r.price)} / month ex GST`}
          aside={
            <>
              <Badge>{r.status}</Badge>
              <span className="ds-num min-w-[3.5ch] text-right text-xl font-semibold text-foreground" aria-label={`Estimated operating margin about ${pct(r.margin)}${r.incomplete ? ", known costs only" : ""}`}>
                ≈{pct(r.margin)}
              </span>
            </>
          }
        />
      ))}
      <li className="pt-3 text-sm text-muted-foreground">Estimates at 5 clients per package, known costs only: real margins will be lower.</li>
    </WidgetList>
  );
}

/** The margin table behind the estimate, folded: minutes, the high-usage case and the method. */
function MarginTable({ rows }: { rows: PackageRow[] }) {
  return (
    <FoldCard id="package-margins-table" summary="See the margin numbers" meta="Minutes, high-usage case and the method">
      <p className="mb-4 max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
        Operating margin (after support time and the shared platform), a model: catalogue prices ex GST, public provider rates checked {fmtProse(ECONOMICS_AS_OF)}, base usage, 5 clients per package. Unknown costs (database, alerts, concurrency) are not in it, so real margins will be lower. Nothing here is measured or invoiced.
      </p>
      <Surface className="min-w-0 overflow-hidden p-0">
        <table className="hidden w-full text-sm md:table" data-testid="package-margins">
          <caption className="sr-only">Estimated operating margin by package, 5 clients, ex GST</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-3 font-medium">Package</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Price / month ex GST</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Base usage scenario minutes</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Est. operating margin</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Est. at high usage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <th scope="row" className="px-4 py-3.5 text-left font-medium">
                  {r.name} <Badge className="ml-1">{r.status}</Badge>
                </th>
                <td className="ds-num px-4 py-3.5 text-right">{formatAud(r.price)}</td>
                <td className="ds-num px-4 py-3.5 text-right text-muted-foreground">{r.minutes}</td>
                <td className="ds-num px-4 py-3.5 text-right">
                  ≈ {pct(r.margin)}
                  {r.incomplete && <span className="block text-xs font-normal text-muted-foreground">known costs only</span>}
                </td>
                <td className="ds-num px-4 py-3.5 text-right text-muted-foreground">
                  ≈ {pct(r.highMargin)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="divide-y divide-border md:hidden" aria-label="Estimated operating margin by package, 5 clients, ex GST">
          {rows.map((r) => (
            <li key={r.id} className="flex min-w-0 items-start justify-between gap-3 px-4 py-3.5 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-foreground">
                  {r.name} <Badge className="ml-1">{r.status}</Badge>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {formatAud(r.price)} / month ex GST · {r.minutes} min base usage scenario · high usage ≈ {pct(r.highMargin)}
                </div>
              </div>
              <div className="ds-num shrink-0 text-right font-semibold">
                ≈ {pct(r.margin)}
                <div className="text-xs font-normal text-muted-foreground">est. operating margin</div>
                {/* Same caveat as the table (it was missing from the phone list, Track 8 at 390 px). */}
                {r.incomplete && <div className="text-xs font-normal text-muted-foreground">known costs only</div>}
              </div>
            </li>
          ))}
        </ul>
      </Surface>
    </FoldCard>
  );
}

/**
 * Per-tier margins from ACTUAL usage on three bases (estimated / measured / reconciled), each figure
 * with its source and date. The same view as the Receptionist dashboard's "Economics by basis".
 * Folded: the summary line says whether usage could be read at all.
 */
function MarginsByBasis() {
  const { data, error, isLoading } = useReceptionistDashboard();
  const block = data?.usageEconomics;
  const meta = isLoading ? "Reading usage…" : !block ? "Couldn't read usage" : !block.ok ? "Usage unknown" : `${block.tiers.length} ${block.tiers.length === 1 ? "tier" : "tiers"} · estimated, measured, reconciled`;
  return (
    <FoldCard id="margins-by-basis" summary="Margins by basis (this month)" meta={meta}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
          Contribution margin (before support time and the shared platform, so higher than the operating margin above) from actual usage: estimated (list rates × usage), measured (what Retell, Twilio and the model router report) and reconciled (paid, from the NAB CSV). Never added together. A ≤ margin is a ceiling: some cost lines aren't measured yet. Ex GST.
        </p>
        <Link to="/receptionist" className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Per client, on the Receptionist dashboard
        </Link>
      </div>
      {isLoading && (
        <p className="text-sm text-muted-foreground" role="status">Reading usage and costs…</p>
      )}
      {!isLoading && !block && (
        <EmptyState variant="row" icon={Landmark} title="Couldn't read usage" body={`${error instanceof Error ? error.message : "The receptionist dashboard didn't answer."} Margins by basis are unknown, not zero.`} />
      )}
      {block && !block.ok && (
        <EmptyState variant="row" icon={Landmark} title="Usage unknown" body={`${block.reason}. Margins by basis are unknown, not zero.`} />
      )}
      {block && block.ok && (
        <>
          <TierBasisTable tiers={block.tiers} caption="Margin per tier by basis, this month, ex GST" />
          <p className="mt-3 text-xs text-muted-foreground">
            Catalogue {block.catalogue} · list rates checked {fmtProse(block.ratesCheckedAt)} · USD at the RBA rate of {fmtProse(block.fx.date)} · reconciled:{" "}
            {block.portfolio.reconciled.statement ?? "No NAB CSV imported"} · built{" "}
            {asOfText(block.generatedAt)}
          </p>
        </>
      )}
    </FoldCard>
  );
}

async function readManualStatus(): Promise<ManualFinanceStatus> {
  const res = await fetch("/__finance_manual/status", { cache: "no-store" });
  if (!res.ok) throw new Error("Finance status unavailable");
  return res.json();
}

/** One short line under a tile's value: its hint, or its state word when it has none. */
const short = (t: FinanceTile) => t.hint;

export function FinancePage() {
  useInspectorFacts("Mount points", {
    Finance: hasMount("finance") ? `NAB CSV ledger mounted on Finance → Finances from ${MOUNT_FILES.finance.file}` : `fallback; waiting for ${MOUNT_FILES.finance.file} (${MOUNT_FILES.finance.track} track)`,
  });
  const now = useNow(60_000);
  const navigate = useNavigate();
  const ai = useAiUsage();
  const stripe = useStripeFinance();
  const manual = useQuery({ queryKey: ["finance-manual-status"], queryFn: readManualStatus, retry: 1, staleTime: 30_000 });
  const refetchManual = manual.refetch;
  useEffect(() => {
    const onChange = () => void refetchManual();
    window.addEventListener(FINANCE_MANUAL_CHANGED, onChange);
    return () => window.removeEventListener(FINANCE_MANUAL_CHANGED, onChange);
  }, [refetchManual]);

  const [aiSpend, monthEnd, unpriced] = aiSpendTiles({ data: ai.data, loading: ai.isLoading, failed: ai.isError });
  const csv = csvDataTile({ data: manual.data, loading: manual.isLoading, failed: manual.isError });
  // The server's copy when it answered; otherwise the same code-owned constant (no network either way).
  const liveFeed = liveFeedTile(manual.data?.basiq ?? basiqLiveStatus());
  const rows = usePackageRows();

  // The NAB import is an owner action on the Finances tab: open it at the drop zone.
  const goToImport = useCallback(() => void navigate({ ...FINANCES }), [navigate]);
  const retryAi = useCallback(() => void ai.refetch(), [ai]);
  const retryManual = useCallback(() => void refetchManual(), [refetchManual]);
  const recover = (t: FinanceTile) =>
    t.recovery ? { label: t.recovery.label, onClick: t.recovery.action === "import" ? goToImport : t.id.startsWith("ai-") ? retryAi : retryManual } : undefined;

  const s = stripe.summary.data;
  const stripeState = stripe.status.error
    ? "failed"
    : stripe.link === "connected"
      ? s ? "ok" : undefined
      : stripe.link === "unknown" ? undefined : "setup-required";
  const bankNeedsImport = !csv.loading && (csv.state === "unknown" || csv.state === "stale");
  const unpricedCount = typeof unpriced.value === "number" ? unpriced.value : 0;

  const steps: FinanceStep[] = financeNextSteps({ csv, unpriced, aiSpend, stripe: stripe.link, stripeNote: stripe.keyMessage });
  const stepAction = (step: FinanceStep) =>
    !step.action ? undefined : step.action.kind === "import" ? (
      <WidgetLink to={FINANCES.to} search={FINANCES.search} hash={FINANCES.hash} accent>
        {step.action.label}
      </WidgetLink>
    ) : step.action.kind === "stripe" ? (
      <WidgetLink to={FINANCES.to} search={FINANCES.search}>
        {step.action.label}
      </WidgetLink>
    ) : step.action.kind === "link" ? (
      <WidgetLink to={step.action.to ?? "/usage"} hash={step.action.hash}>
        {step.action.label}
      </WidgetLink>
    ) : (
      <WidgetButton onClick={step.action.kind === "retry-ai" ? retryAi : retryManual}>
        {step.action.label}
      </WidgetButton>
    );

  const headline = financeHeadline({ aiSpend, csv, stripe: stripe.link });
  const aiAt = ai.data?.generatedAt;
  const csvAt = manual.data?.lastImportAt;
  const foot = [
    `AI usage ${agoText(aiAt, now) ? `read ${agoText(aiAt, now)}` : "not read yet"}`,
    `NAB CSV ${csvAt ? `imported ${agoText(csvAt, now)}` : "none imported"}`,
    stripe.link === "connected" ? "Stripe read-only" : "Stripe not connected",
  ].join(" · ");

  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="Finance" description={headline} />

      {/* What needs you comes first (also on a phone, and in the page order for the keyboard); the tiles are the detail. */}
      <WidgetGrid className="mb-6" aria-label="What needs you">
        <WidgetList icon={ListChecks} title="What needs you" span={4} id="finance-next-steps" empty="Nothing needs you on Finance right now." data-next-steps={steps.length ? String(steps.length) : "none"}>
          {steps.map((step) => (
            <li key={step.id} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0" data-step={step.id} data-tone={step.tone}>
              {/* A 16rem basis: on a phone the action drops under the text instead of squeezing it into a sliver. */}
              <span className="min-w-0 flex-[1_1_16rem]">
                <span className="flex items-center gap-2 text-base font-medium text-foreground">
                  {step.tone === "attention" && (
                    <span className="size-2 shrink-0 rounded-full bg-warn" aria-hidden="true" />
                  )}
                  {step.title}
                </span>
                <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">
                  {step.body}
                </span>
              </span>
              {stepAction(step)}
            </li>
          ))}
        </WidgetList>
      </WidgetGrid>

      <WidgetGrid
        className="mb-6 xl:grid-cols-3"
        aria-label="Where money stands"
        data-testid="finance-signals"
      >
        <SignalWidget
          icon={Wallet}
          title="AI spend"
          data-tile={aiSpend.id}
          // "≥ A$340.00" (some metered sources unreadable) is a floor: the figure stays big, the badge says so.
          value={typeof aiSpend.value === "string" ? aiSpend.value.replace(/^≥ /, "") : aiSpend.value}
          badge={typeof aiSpend.value === "string" && aiSpend.value.startsWith("≥ ") ? "At least" : undefined}
          line={aiSpend.state === "failed" || aiSpend.loading ? short(aiSpend) : `${monthEnd.value ?? "—"} by month end${unpricedCount ? ` · ${unpricedCount} not in the total` : ""}`}
          tone={aiSpend.tone}
          state={aiSpend.state}
          loading={aiSpend.loading}
          updatedAt={aiSpend.updatedAt}
          staleAfterMs={aiSpend.staleAfterMs}
          now={now}
          recovery={recover(aiSpend)}
          link={{ to: "/usage", label: "AI usage & spend" }}
        />
        <SignalWidget
          icon={Landmark}
          title="Bank (NAB CSV)"
          data-tile={csv.id}
          value={csv.value}
          line={short(csv)}
          tone={csv.tone}
          state={csv.state}
          loading={csv.loading}
          updatedAt={csv.updatedAt}
          staleAfterMs={csv.staleAfterMs}
          now={now}
          recovery={csv.recovery?.action === "retry" ? recover(csv) : undefined}
          action={
            // The import step is already under "What needs you"; the tile does not repeat it.
            !bankNeedsImport && csv.state === "ok" ? (
              <WidgetLink to={FINANCES.to} search={FINANCES.search}>
                Open Finances
              </WidgetLink>
            ) : undefined
          }
        />
        <SignalWidget
          icon={Receipt}
          title="Revenue (Stripe)"
          data-tile="stripe-revenue"
          loading={stripe.status.isLoading || (stripe.link === "connected" && stripe.summary.isPending)}
          value={
            stripe.link === "connected"
              ? s ? stripeAud(s.revenueThisMonthAud) : null
              : stripe.link === "unknown" ? null : "Not connected"
          }
          state={stripeState}
          line={
            stripe.status.error
              ? "Stripe's status couldn't be read. Revenue is unknown, not zero."
              : stripe.link === "connected"
                ? s
                  ? `${s.invoices.outstandingCount} ${s.invoices.outstandingCount === 1 ? "invoice" : "invoices"} outstanding (${stripeAud(s.invoices.outstandingAud)})${s.overdueInvoices.length ? ` · ${s.overdueInvoices.length} overdue` : ""}`
                  : "Stripe hasn't answered with a summary yet."
                : (stripe.keyMessage ?? "Read-only once connected. Unknown until then, not zero.")
          }
          tone={s && s.overdueInvoices.length ? "warn" : undefined}
          lastSuccess={s?.lastSyncedAt ?? undefined}
          now={now}
          link={stripe.link === "connected" ? { to: FINANCES.to, search: FINANCES.search, label: "Open Finances" } : undefined}
        />
      </WidgetGrid>

      <WidgetGrid className="mb-6" aria-label="The package margins">
        <MarginList rows={rows} />
      </WidgetGrid>

      <div className="mb-10">
        <MarginTable rows={rows} />
        <MarginsByBasis />
      </div>
      <DrilldownList id="finance" />
      <PageFoot title="AI usage receipts and plan prices, the NAB CSV import, Stripe (read-only) and the package catalogue.">
        {foot}. Live bank feed: {liveFeed.value}. {liveFeed.hint} Estimates are marked; nothing here
        moves money.
      </PageFoot>
    </div>
  );
}
