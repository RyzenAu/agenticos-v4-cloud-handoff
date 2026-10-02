// System > Models: every model route the OS can use, labelled honestly (free / subscription /
// metered), with health, last probe, usage, cost and failures from the model router, plus the
// provider balances and plan windows /usage already reads. There is deliberately no cap setting:
// when a provider's funds or limits run out, this page shows the balance, the usage and the failure.
// L3 (29 Sep 2026): a widget grid. One headline sentence; four widgets (free, subscription, metered,
// needing attention, with the failures in one plain line); funds and limits as one list widget when a
// provider has run out; then one widget per provider (its calls in 30 days) that opens to its limits
// and model table. Quiet providers stay closed; a provider that needs a look opens by itself. Nothing
// is removed: every model row is still on the page (hidden until its provider opens).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Gauge, Gift, RefreshCw, Search, ShieldAlert, WalletCards } from "lucide-react";
import {
  Badge,
  Button,
  Disclosure,
  EmptyState,
  Notice,
  PageFoot,
  PageHeader,
  Segmented,
  Skeleton,
  StatusDot,
  Surface,
  WidgetGrid,
  WidgetList,
  WidgetRow,
} from "@/components/ds";
import { useNow } from "@/components/workspace/panel-shell";
import { honestFromQuery } from "@/lib/honest-state";
import { useAiUsage } from "@/lib/ai-usage";
import type { ModelRouterView } from "../../../../scripts/model-router/api";
import { useInspectorFacts } from "../inspector";
import { SignalWidget, WidgetButton, WidgetDeck, agoText, type DeckItem } from "../widgets";
import {
  catalogueHollow,
  failureLine,
  filterModels,
  lastCheckText,
  modelsFacts,
  modelsHeadline,
  modelsSummary,
  providerIsQuiet,
  type ModelsFilter,
  type ProviderFacts,
} from "../models-facts";
import { fmtDataProse, fmtDateTime } from "@/lib/format";

async function token(): Promise<string | null> {
  const r = await fetch("/__token").catch(() => null);
  if (!r?.ok) return null; // a remote (tailnet) session has no page token; the server checks its identity instead
  const t = (await r.json().catch(() => null))?.token;
  return typeof t === "string" ? t : null;
}

export async function routerRequest(
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<ModelRouterView> {
  const t = await token();
  const res = await fetch(`/__operator${path}`, {
    method,
    // The operator API refuses a POST that is not declared JSON (415 "JSON required"), so Check now said it failed.
    headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...(t ? { "X-Claude-OS-Token": t } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error)
    throw new Error(
      typeof body?.error === "string" ? body.error : `${path} answered HTTP ${res.status}`,
    );
  return body as ModelRouterView;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-AU");
const fmtWhen = (iso: string | null | undefined) =>
  iso
    ? fmtDateTime(new Date(iso))
    : "never";

const FILTERS: readonly { value: ModelsFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "free", label: "Free" },
  { value: "subscription", label: "Subscription" },
  { value: "metered", label: "Metered" },
  { value: "attention", label: "Needing attention" },
];

// Column headers never wrap; the model id may break anywhere (it's one long token). The rest wrap at
// spaces only: the page used to set overflow-wrap:anywhere on everything, which let the table squeeze
// narrow columns until words split ("Co st", "Fre e"; audit F3-09/F3-36).
const TH = "whitespace-nowrap px-3 py-2 font-medium";

/** What a provider's widget says in one line: how many models and whether any were used. */
function providerLine(p: ProviderFacts): string {
  const quiet = providerIsQuiet(p);
  const count = `${p.models.length} model${p.models.length === 1 ? "" : "s"}`;
  if (!p.models.length) return "Gateway only: its models are listed under the provider it runs on.";
  return quiet ? `${count}, none used in the last 30 days.` : `${count} · ${p.route.label}`;
}

/** The provider's limits, balances and model table: what its widget opens to. */
export function ProviderDetail({ p }: { p: ProviderFacts }) {
  return (
    <div data-provider={p.provider.id} data-quiet={providerIsQuiet(p) || undefined}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground" title={fmtDataProse(p.route.title)}>{p.route.label}</span>
        {p.alert && <Badge tone="danger">{p.alert.title}</Badge>}
      </div>
      {p.provider.limits && <p className="mb-3 max-w-[80ch] text-sm leading-relaxed text-muted-foreground">{fmtDataProse(p.provider.limits)}</p>}
      {p.alert && (
        <Notice tone="danger" title={`${p.alert.title}`} className="mb-3">
          <span className="block">
            {p.balance.length
              ? `Balance: ${p.balance.map((b) => b.text).join(" · ")}.`
              : p.windows.length
                ? `Plan: ${
                    p.windows
                      .filter((w) => w.tone !== "neutral")
                      .map((w) => w.text)
                      .join(" · ") || p.windows.map((w) => w.text).join(" · ")
                  }.`
                : "Balance: not readable from this provider."}
          </span>
          {p.alert.failure && <span className="block">Failure: {p.alert.failure}.</span>}
          <span className="block text-muted-foreground">
            Calls that go through the model router fall back automatically along the task's chain
            (free or paid, as configured); the receipts record which model ran.
          </span>
        </Notice>
      )}
      {(p.balance.length > 0 || p.windows.length > 0 || p.lastProbe) && (
        <div className="mb-3 flex flex-col gap-1 text-sm text-muted-foreground">
          {p.balance.map((b, i) => (
            <span key={`b${i}`}>
              <StatusDot tone={b.tone} label={b.text} />{" "}
              <span>
                ({b.source}
                {b.checkedAt ? `, ${fmtWhen(b.checkedAt)}` : ""})
              </span>
            </span>
          ))}
          {p.windows.map((w, i) => (
            <span key={`w${i}`}>
              <StatusDot tone={w.tone} label={w.text} />
            </span>
          ))}
          {p.lastProbe && (
            <span>
              Last check: {p.lastProbe.method}, {fmtWhen(p.lastProbe.at)} — {fmtDataProse(p.lastProbe.result)}
            </span>
          )}
        </div>
      )}
      {p.models.length > 0 && (
        <Surface className="overflow-x-auto p-0" tabIndex={0} role="region" aria-label={`${p.provider.label} models`}>
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className={TH}>Model</th>
                <th className={TH}>Route</th>
                <th className={TH}>Health</th>
                <th className={TH}>Last check</th>
                <th className={TH}>Usage (30 days)</th>
                <th className={TH}>Cost</th>
                <th className={TH}>Failures</th>
              </tr>
            </thead>
            <tbody>
              {p.models.map((m) => {
                const check = lastCheckText(m, fmtWhen);
                return (
                  <tr key={m.model.id} className="border-t border-border align-top">
                    <td className="px-3 py-2.5">
                      <span className="block font-mono text-xs [overflow-wrap:anywhere]">{m.model.providerModel}</span>
                      <span className="block text-xs text-muted-foreground">
                        {m.model.modality.in.join("+")} → {m.model.modality.out.join("+")}
                        {m.model.tools ? " · tools" : ""}
                        {m.tasks.length ? ` · ${m.tasks.join(", ")}` : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {/* L10: the route is a category in its own column, so plain text, not a chip per row. */}
                      <span title={fmtDataProse(m.route.title)}>{m.route.label}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusDot tone={m.health.tone} label={m.health.label} />
                      {m.health.detail && <span className="mt-0.5 block text-xs text-muted-foreground">{fmtDataProse(m.health.detail)}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground" title={fmtDataProse(check.title)}>
                      {check.text}
                    </td>
                    <td className="ds-num px-3 py-2.5 text-xs">
                      {m.usage?.calls ? (
                        <>
                          {fmtInt(m.usage.calls)} call{m.usage.calls === 1 ? "" : "s"}
                          <span className="block text-muted-foreground">
                            {fmtInt(m.usage.inputTokens)} in / {fmtInt(m.usage.outputTokens)} out
                            {m.usage.fallbacksInto ? ` · ${m.usage.fallbacksInto} as fallback` : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">none recorded</span>
                      )}
                    </td>
                    <td className="min-w-[7rem] px-3 py-2.5 text-xs">{fmtDataProse(m.cost)}</td>
                    <td className="min-w-[7rem] px-3 py-2.5 text-xs text-muted-foreground">{m.failures ?? "none"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Surface>
      )}
    </div>
  );
}

export function ModelsPage() {
  const now = useNow(30_000);
  const client = useQueryClient();
  const router = useQuery({
    queryKey: ["system", "model-router"],
    queryFn: () => routerRequest("/model-router"),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  const usage = useAiUsage();
  const [probing, setProbing] = useState<string | null>(null);
  const [filter, setFilter] = useState<ModelsFilter>("all");
  const [query, setQuery] = useState("");

  const facts = router.data ? modelsFacts(router.data, usage.data, now) : [];
  const summary = modelsSummary(facts);
  // The data's own times, not the fetch (REVIEW-T1 B6, B7): the catalogue's date for the counts, the latest
  // health probe for "needing attention". No model ever probed means that count is unknown, not a green 0.
  const catalogueAt = router.data ? Date.parse(router.data.catalogue.updatedAt) || null : null;
  const probeTimes = facts.flatMap((p) => p.models).map((m) => (m.lastProbe ? Date.parse(m.lastProbe.at) : NaN)).filter(Number.isFinite);
  const lastProbeAt = probeTimes.length ? Math.max(...probeTimes) : null;
  // A catalogue that lists no usable model is Unknown, never a Live 0 / 0 / 0 (REVIEW-T1 R2).
  const hollow = Boolean(router.data) && catalogueHollow(summary);
  const countState = router.data ? (hollow ? ("unknown" as const) : router.error ? ("stale" as const) : ("live" as const)) : honestFromQuery(router, now);
  const attentionState = !router.data ? honestFromQuery(router, now) : !lastProbeAt && !summary.attention ? ("unknown" as const) : countState;
  const alerts = facts.filter((p) => p.alert);
  const shown = filterModels(facts, filter, query);
  const narrowed = filter !== "all" || query.trim() !== "";
  const shownModels = shown.reduce((n, p) => n + p.models.length, 0);

  useInspectorFacts("Models sources", {
    Catalogue: router.data
      ? `scripts/model-router/catalogue.json, updated ${fmtWhen(router.data.catalogue.updatedAt)}`
      : router.error
        ? `failed: ${(router.error as Error).message}`
        : "loading",
    Receipts: router.data?.receiptSource ?? "not loaded",
    Health: router.data?.health.updatedAt
      ? `health.json, updated ${fmtWhen(router.data.health.updatedAt)}`
      : "no health recorded yet",
    "Balances and plan windows": usage.data
      ? `/usage snapshot ${fmtWhen(usage.data.generatedAt)}`
      : usage.error
        ? `unavailable: ${(usage.error as Error).message}`
        : "loading",
  });

  const probe = async () => {
    setProbing("Checking provider model lists…");
    try {
      const next = await routerRequest("/model-router/probe", "POST");
      client.setQueryData(["system", "model-router"], next);
      const skipped = (next.probes ?? []).filter((p) => p.skipped).length;
      setProbing(
        skipped
          ? `Checked. ${skipped} provider${skipped === 1 ? " was" : "s were"} checked in the last 5 minutes and skipped.`
          : "Checked.",
      );
    } catch (error) {
      setProbing(`Check failed: ${(error as Error).message}`);
    }
  };

  // One widget per provider: its calls in the last 30 days as the one big value.
  // Providers with no calls in 30 days (and gateways with no models of their own) are one compact list,
  // not a wall of empty widgets; a provider that needs a look, or any in a narrowed list, gets its widget.
  const isQuietRow = (p: ProviderFacts) => !p.alert && !narrowed && (providerIsQuiet(p) || !p.models.length);
  const quietRows = shown.filter(isQuietRow);
  const providerItems: DeckItem[] = shown.filter((p) => !isQuietRow(p)).map((p) => {
    const calls = p.models.reduce((n, m) => n + (m.usage?.calls ?? 0), 0);
    const quiet = providerIsQuiet(p);
    return {
      id: `provider-${p.provider.id}`,
      icon: Cpu,
      title: p.provider.label,
      value: p.models.length ? (
        <span className="ds-num">
          {fmtInt(calls)}
          <span className="ml-2 text-base font-normal text-muted-foreground">{calls === 1 ? "call" : "calls"}</span>
        </span>
      ) : null,
      tone: p.alert ? "danger" : quiet ? "muted" : "default",
      line: p.alert ? `${p.alert.title}. ${providerLine(p)}` : providerLine(p),
      // A provider that needs a look, and every provider in a narrowed list, opens by itself.
      defaultOpen: !!p.alert || narrowed,
      keepMounted: true,
      detail: <ProviderDetail p={p} />,
    };
  });

  const foot = [
    router.data ? `Catalogue ${fmtWhen(router.data.catalogue.updatedAt)}` : null,
    router.data ? `read ${agoText(router.dataUpdatedAt, now) ?? "just now"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="min-w-0 break-words">
      <PageHeader
        title="Models"
        description={router.data ? modelsHeadline(summary, hollow) : "Every model route the OS can use, and how each one is doing."}
        actions={
          <Button
            variant="outline"
            className="h-10 rounded-full px-5"
            onClick={() => void probe()}
            disabled={probing === "Checking provider model lists…"}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Check now
          </Button>
        }
      />
      {probing && (
        <p className="mb-4 text-sm text-muted-foreground" role="status">
          {probing} Checks read free model lists only; they never run a model.
        </p>
      )}

      <WidgetGrid className="mb-6" aria-label="Models at a glance">
        <SignalWidget
          icon={Gift}
          title="Free"
          loading={router.isLoading}
          state={countState}
          lastSuccess={catalogueAt}
          staleAfterMs={7 * 86_400_000}
          now={now}
          value={router.data && !hollow ? summary.free : null}
          line={
            hollow
              ? "The catalogue lists no models yet"
              : router.data
              ? `Verified no charge · plus ${summary.freeUnverified} free tier, billing unverified`
              : undefined
          }
        />
        <SignalWidget
          icon={Gauge}
          title="Subscription"
          loading={router.isLoading}
          state={countState}
          lastSuccess={catalogueAt}
          staleAfterMs={7 * 86_400_000}
          now={now}
          value={router.data && !hollow ? summary.subscription : null}
          line="Use plan allowance"
        />
        <SignalWidget
          icon={WalletCards}
          title="Metered"
          loading={router.isLoading}
          state={countState}
          lastSuccess={catalogueAt}
          staleAfterMs={7 * 86_400_000}
          now={now}
          value={router.data && !hollow ? summary.metered : null}
          line="Charged per use"
        />
        <SignalWidget
          icon={ShieldAlert}
          title="Attention"
          loading={router.isLoading}
          state={attentionState}
          lastSuccess={lastProbeAt}
          staleAfterMs={24 * 3_600_000}
          now={now}
          // A stale read with no recorded calls has nothing behind its zero: show "—", not "0 need attention".
          value={router.data && attentionState !== "unknown" && !((!lastProbeAt || now - lastProbeAt > 24 * 3_600_000) && !summary.calls && !summary.attention) ? summary.attention : null}
          tone={summary.attention ? "danger" : lastProbeAt ? "success" : undefined}
          line={
            router.data
              ? attentionState === "unknown"
                ? "No model has been health-checked yet"
                : failureLine(facts, summary)
              : undefined
          }
          action={router.data && summary.attention ? <WidgetButton onClick={() => setFilter("attention")}>Show them</WidgetButton> : undefined}
        />
      </WidgetGrid>

      {router.isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : router.error ? (
        <EmptyState
          icon={Cpu}
          title="Model router unavailable"
          body={(router.error as Error).message}
        />
      ) : (
        <>
          {alerts.length > 0 && (
            <WidgetGrid className="mb-6" aria-label="Funds and limits">
              <WidgetList icon={ShieldAlert} title="Funds and limits" span={4} badge={alerts.length}>
                {alerts.map((p) => (
                  <WidgetRow
                    key={p.provider.id}
                    title={`${p.provider.label}: ${p.alert!.title}`}
                    meta={`${p.balance.length ? `Balance ${p.balance.map((b) => b.text).join(" · ")}. ` : ""}${p.alert!.failure ? `Failure: ${p.alert!.failure}.` : ""}`}
                  />
                ))}
              </WidgetList>
            </WidgetGrid>
          )}
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-testid="models-filters">
            <Segmented ariaLabel="Show models" value={filter} onChange={setFilter} options={FILTERS} />
            <label className="flex min-h-11 items-center gap-2 rounded-full border border-border bg-background px-4 text-sm sm:w-80">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Search models</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search model, provider or task"
                className="min-w-0 flex-1 bg-transparent outline-none"
              />
            </label>
          </div>
          {narrowed && (
            <p className="mb-4 text-sm text-muted-foreground" role="status">
              {`Showing ${shownModels} model${shownModels === 1 ? "" : "s"} from ${shown.length} provider${shown.length === 1 ? "" : "s"}.`}
            </p>
          )}
          {shown.length === 0 ? (
            <EmptyState variant="row" icon={Cpu} title="No models match" body="Try another filter or clear the search." />
          ) : (
            // Keyed by the filter so a narrowed list opens its providers, and clearing it closes them again.
            <>
              {providerItems.length > 0 && <WidgetDeck key={`${filter}|${query.trim() ? "q" : ""}`} items={providerItems} className="mb-6" />}
              {quietRows.length > 0 && (
                <WidgetGrid className="mb-2" aria-label="Providers with no calls">
                  <WidgetList icon={Cpu} title="No calls in 30 days" span={4} badge={quietRows.length}>
                    {quietRows.map((p) => (
                      <li key={p.provider.id} className="min-w-0 py-1 first:pt-0 last:pb-0">
                        <Disclosure
                          className="-mx-1"
                          triggerClassName="min-h-14 px-3 py-3"
                          panelClassName="px-3 pb-3"
                          summary={
                            <span className="block min-w-0">
                              <span className="text-base font-medium text-foreground">{p.provider.label}</span>
                              <span className="mt-0.5 block text-sm text-muted-foreground" data-testid="provider-collapsed">{providerLine(p)}</span>
                            </span>
                          }
                        >
                          <ProviderDetail p={p} />
                        </Disclosure>
                      </li>
                    ))}
                  </WidgetList>
                </WidgetGrid>
              )}
            </>
          )}
        </>
      )}
      <PageFoot title="Router receipts (plus the older MiMo and Cline ledgers) and the providers' own figures from AI usage & spend.">
        {foot ? `${foot}. ` : ""}
        Usage and cost are router receipts, so a floor: calls outside the router aren't counted, and unknown cost stays unknown. Balances and plan limits are the providers' own figures.
      </PageFoot>
    </div>
  );
}
