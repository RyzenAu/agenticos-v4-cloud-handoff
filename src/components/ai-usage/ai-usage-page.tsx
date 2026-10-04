// /usage — every AI subscription and API key: this month's spend in AUD, each plan's live % of
// its limit, and where every number came from. Data: /__ai_usage (scripts/ai-usage/*).
// L3 (29 Sep 2026, owner: "good, but it gets bad towards the bottom; small overall"): the content he
// likes is unchanged, laid out as a widget grid that fills the width. One headline sentence; four
// figure widgets, the fixed-vs-metered split, one widget per plan (one big % each), the API keys as
// one list widget, and the detail (Claude tokens, data freshness, prices) as three widgets that open
// to their panels. Freshness and the exchange rate are one line at the foot. A key the provider
// rejected is one calm sentence with the next step, never the raw HTTP error in the reading path.
import { useMemo, useState } from "react";
import { keyLabel } from "./key-label";
import { CalendarClock, Clock, Cpu, Gauge, KeyRound, Layers, PieChart, RefreshCw, Tag, Wallet } from "lucide-react";
import {
  Badge,
  BrandMark,
  Button,
  Disclosure,
  EmptyState,
  Notice,
  PageFoot,
  PageHeader,
  Skeleton,
  StatusDot,
  Surface,
  Widget,
  WidgetGrid,
  WidgetList,
  fmtCompact,
  fmtCount,
  fmtDate,
  fmtRelative,
} from "@/components/ds";
import { fmtDateTime, staleNote } from "@/lib/format";
import {
  fmtAud,
  fmtMoneyOrigin,
  fmtResetIn,
  useAiUsage,
  useAiUsageActions,
  type AiUsageSnapshot,
  type ApiKeyRow,
  type PriceSetting,
  type SubscriptionCard,
} from "@/lib/ai-usage";
import { cn } from "@/lib/utils";
import { WidgetButton, WidgetDeck, WidgetLink, MeterBar, openPanel, pressureOf, type DeckItem } from "@/components/shell/widgets";
import { keyProblem, providerWords } from "./key-state";

const ClaudeIcon = () => <BrandMark agent="claude-code" size={16} />;
const CodexIcon = () => <BrandMark agent="codex" size={16} />;

/** The one sentence under the title: the month's total, or what the page is while it loads. */
export function usageHeadline(data: AiUsageSnapshot | undefined): string {
  if (!data) return "What every AI plan and key costs this month, and how close each plan is to its limit.";
  const t = data.totals;
  const open = t.unknown.length ? `; ${t.unknown.length} ${t.unknown.length === 1 ? "item isn't" : "items aren't"} priced yet` : "";
  return `${fmtAud(t.monthAud)} so far in ${data.month.label}, day ${data.month.dayOfMonth} of ${data.month.daysInMonth}${open}.`;
}

export function AiUsagePage() {
  const { data, error, isLoading } = useAiUsage();
  const actions = useAiUsageActions();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await actions.refresh();
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="min-w-0">
      <PageHeader
        title="AI usage & spend"
        description={usageHeadline(data)}
        actions={
          <Button variant="outline" className="h-10 rounded-full px-5" onClick={refresh} disabled={refreshing || isLoading}>
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden="true" />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {refreshError && (
        <Notice tone="danger" className="mb-6" title="Refresh failed">
          {refreshError}
        </Notice>
      )}
      {error && !data && (
        <Notice tone="danger" title="Usage couldn't be read">
          {error instanceof Error ? error.message : "The usage service didn't answer."} Check that Agentic OS is running, then refresh.
        </Notice>
      )}
      {isLoading && <LoadingShape />}
      {data && <Loaded data={data} />}
    </div>
  );
}

function LoadingShape() {
  return (
    <div className="space-y-3" aria-label="Loading usage">
      <WidgetGrid>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-44 rounded-2xl" />
        ))}
      </WidgetGrid>
      <p className="text-sm text-muted-foreground">Reading plan limits and API keys…</p>
    </div>
  );
}

function Loaded({ data }: { data: AiUsageSnapshot }) {
  const t = data.totals;
  const codex = data.subscriptions.filter((s) => s.provider === "openai");
  const nearest = [...codex].filter((s) => s.peakPercent !== null).sort((a, b) => (b.peakPercent ?? 0) - (a.peakPercent ?? 0))[0];
  const monthEnd = new Date(new Date(data.month.end).getTime() - 1);
  const estimatedMetered = data.apiKeys.filter((k) => k.spendEstimated && k.spend).length;
  const plans = data.subscriptions.filter((s) => s.monthly).length;
  const jump = (id: string) => () => document.getElementById(id)?.scrollIntoView({ block: "start" });
  const failedSources = data.sources.filter((s) => !s.ok).length;
  const unsetPrices = data.prices.filter((p) => p.amount === null).length;
  const c = data.claudeModels;

  const detail: DeckItem[] = [
    {
      id: "claude-models",
      icon: Cpu,
      title: "Claude tokens",
      value: "rows" in c ? c.rows.length : null,
      line: "rows" in c ? `models this month · API-equivalent ${c.totalApiEquivalent ? fmtAud(c.totalApiEquivalent.aud, true) : "—"} (est.)` : "Unavailable: the transcripts couldn't be read",
      openLabel: "Open",
      keepMounted: true,
      detail: <ClaudeModelsBody data={data} />,
    },
    {
      id: "freshness",
      icon: Clock,
      title: "Data freshness",
      value: failedSources ? `${failedSources} of ${data.sources.length}` : `All ${data.sources.length}`,
      tone: failedSources ? "warn" : "default",
      line: failedSources ? `${failedSources === 1 ? "source" : "sources"} couldn't be read` : "sources read",
      keepMounted: true,
      detail: <FreshnessBody data={data} />,
    },
    {
      id: "prices",
      icon: Tag,
      title: "Prices",
      value: data.prices.length,
      line: `${unsetPrices ? `${unsetPrices} not set` : "all set"}${data.prices.some((p) => p.edited) ? " · edited" : ""}`,
      openLabel: "Edit",
      keepMounted: true,
      detail: <PriceEditorBody prices={data.prices} />,
    },
  ];

  return (
    <>
      {!data.fx && (
        <Notice tone="warn" className="mb-6" title="No USD → AUD rate">
          US-dollar prices can't be converted, so those figures are unknown, not zero.
        </Notice>
      )}
      <WidgetGrid className="mb-6" aria-label="This month">
        <Widget
          icon={Wallet}
          title="Spent so far"
          value={fmtAud(t.monthAud)}
          line={`Fixed ${fmtAud(t.fixedAud)} + metered ${fmtAud(t.meteredAud)}`}
          action={<WidgetButton onClick={jump("subscriptions")}>See the plans</WidgetButton>}
        />
        <Widget
          icon={CalendarClock}
          title="Projected"
          value={fmtAud(t.projectedAud)}
          line={`By ${fmtDate(monthEnd)}, at this month's rate`}
        />
        <Widget
          icon={Layers}
          title="Fixed plans"
          value={fmtAud(t.fixedAud)}
          line={`${plans} ${plans === 1 ? "plan" : "plans"}, published prices`}
          action={<WidgetButton onClick={() => openPanel("prices")}>Edit prices</WidgetButton>}
        />
        <Widget
          icon={Gauge}
          title="Metered API"
          value={fmtAud(t.meteredAud)}
          line={`Provider-reported${estimatedMetered ? ` · ${estimatedMetered} free-tier keys counted at A$0 (est.)` : ""}`}
          action={<WidgetButton onClick={jump("api-keys")}>See the keys</WidgetButton>}
        />
        <SplitBar fixed={t.fixedAud} metered={t.meteredAud} />
      </WidgetGrid>
      {t.unknown.length > 0 && (
        <Notice tone="warn" className="mb-6" title="Not in the total">
          {t.unknown.join(" · ")}. These have no price or spend the OS can read; set a price below to include one.
        </Notice>
      )}

      <WidgetGrid className="mb-6" id="subscriptions" aria-label="Subscriptions">
        {data.subscriptions.map((s) => (
          <SubscriptionWidget key={s.id} sub={s} nearest={s.id === nearest?.id && (nearest.peakPercent ?? 0) > 0} />
        ))}
      </WidgetGrid>

      <WidgetGrid className="mb-6" aria-label="API keys">
        <ApiKeyList rows={data.apiKeys} />
      </WidgetGrid>

      <WidgetDeck items={detail} mobile={1} className="mb-2" />

      {/* L10 (29 Sep 2026): no routine "Updated just now"; the time is on hover and only a stale read is said out loud. */}
      <PageFoot title={`Read ${fmtDateTime(data.generatedAt)}`}>
        {staleNote(data.generatedAt, Date.now()) ? <span className="text-warn">{staleNote(data.generatedAt, Date.now())} · </span> : null}
        {data.fx ? (
          <>
            US$1 = A${data.fx.usdToAud.toFixed(4)} ({fmtDate(data.fx.asOf)}){data.fx.stale ? ", stale" : ""}
            {" · "}
          </>
        ) : null}
        Provider reads are cached for 15 minutes, the exchange rate for 12 hours. Key values are never shown.
      </PageFoot>
    </>
  );
}

/** Fixed vs metered as one slim widget: the bar and its two figures. Hidden when there is no spend. */
function SplitBar({ fixed, metered }: { fixed: number; metered: number }) {
  const total = fixed + metered;
  if (!(total > 0)) return null;
  const fixedPct = (fixed / total) * 100;
  return (
    <Widget icon={PieChart} title="Fixed vs metered" span={4} line={`${fixedPct >= 99.95 ? ">99.9" : fixedPct.toFixed(1)}% fixed · ${100 - fixedPct < 0.05 && metered > 0 ? "<0.1" : (100 - fixedPct).toFixed(1)}% metered`}>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
        <div className="h-full bg-brand" style={{ width: `${fixedPct}%` }} />
        <div className="h-full bg-info" style={{ width: `${Math.max(metered > 0 ? 0.6 : 0, 100 - fixedPct)}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-brand" /> Fixed {fmtAud(fixed)}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-info" /> Metered {fmtAud(metered)}
        </span>
      </div>
    </Widget>
  );
}

/** One plan: one big % of its nearest limit, the windows as slim bars, the price as the one line. */
function SubscriptionWidget({ sub, nearest }: { sub: SubscriptionCard; nearest: boolean }) {
  const origin = fmtMoneyOrigin(sub.monthly);
  const price = sub.monthly ? `${fmtAud(sub.monthly.aud)} / month${origin ? ` (${origin} + GST)` : ""}` : "Price not set";
  const level = pressureOf(sub.peakPercent);
  const ok = sub.status.ok;
  return (
    <Widget
      icon={sub.provider === "anthropic" ? ClaudeIcon : CodexIcon}
      title={sub.owner}
      value={ok ? <span className="ds-num">{Math.round(sub.peakPercent ?? 0)}%</span> : <span className="text-xl">Unavailable</span>}
      tone={ok ? (level === "danger" ? "danger" : level === "warn" ? "warn" : "default") : "muted"}
      line={ok ? `${sub.plan}${nearest ? " · closest to its cap" : ""}` : sub.status.reason}
      data-plan={sub.id}
    >
      {sub.status.ok && (
        <div className="flex flex-col gap-3">
          {sub.status.windows.map((w) => (
            <MeterBar key={w.label} label={w.label} percent={w.usedPercent} right={`${Math.round(w.usedPercent)}% · ${fmtResetIn(w.resetsAt)}`} />
          ))}
        </div>
      )}
      <p className="mt-3 text-sm text-muted-foreground" title={sub.priceNote}>
        {price}
      </p>
    </Widget>
  );
}

/** A key that wasn't rejected or blocked shows its own usage line; a rejected one says so once. */
function ApiKeyList({ rows }: { rows: ApiKeyRow[] }) {
  const problems = rows.filter((r) => keyProblem(r)?.kind === "rejected").length;
  return (
    <WidgetList
      icon={KeyRound}
      title="API keys"
      span={4}
      id="api-keys"
      badge={problems ? `${problems} rejected` : rows.length || undefined}
      empty="No API keys are set up yet. Keys are added on the hub PC, not in this app."
    >
      {rows.map((r) => (
        <ApiKeyRowItem key={r.id} r={r} />
      ))}
    </WidgetList>
  );
}

const STATUS_TONE: Record<ApiKeyRow["status"], "success" | "warn" | "danger" | "neutral" | "info"> = {
  ok: "success",
  warn: "warn",
  danger: "danger",
  unavailable: "neutral",
  info: "info",
};
const STATUS_LABEL: Record<ApiKeyRow["status"], string> = { ok: "OK", warn: "Near limit", danger: "Blocked", unavailable: "Unavailable", info: "Info" };

function ApiKeyRowItem({ r }: { r: ApiKeyRow }) {
  const problem = keyProblem(r);
  // A key near or at its limit opens by itself: that's the one that needs attention.
  const line = problem ? problem.line : r.usage && r.usage.trim() !== "—" ? r.usage : (r.note ?? "—");
  return (
    <li className="min-w-0 py-1 first:pt-0 last:pb-0" data-key-status={r.status} data-key-problem={problem?.kind}>
      <Disclosure
        defaultOpen={r.status === "warn" || r.status === "danger"}
        className="-mx-1"
        triggerClassName="min-h-14 px-3 py-3"
        panelClassName="px-3 pb-3"
        aside={problem?.fix ? <WidgetLink to={problem.fix.to} hash={problem.fix.hash}>{problem.fix.label}</WidgetLink> : undefined}
        summary={
          <span className="block min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-base font-medium text-foreground">{r.provider}</span>
              <Badge tone={problem ? "warn" : STATUS_TONE[r.status]}>{problem ? problem.badge : STATUS_LABEL[r.status]}</Badge>
            </span>
            {/* A key with no usage figure says why (its note) instead of a bare dash. */}
            <span className="mt-0.5 block break-words text-sm text-muted-foreground">{line}</span>
          </span>
        }
        meta={
          <span className="block text-right">
            <span className="ds-num text-base font-semibold text-foreground">
              {r.spend ? fmtAud(r.spend.aud) : "—"}
              {r.spendEstimated && r.spend && <span className="ml-1 text-xs font-normal text-muted-foreground">est.</span>}
            </span>
            {r.spend && fmtMoneyOrigin(r.spend) && <span className="ds-num block text-xs text-muted-foreground">{fmtMoneyOrigin(r.spend)}</span>}
          </span>
        }
      >
        <dl className="grid gap-3 rounded-xl bg-inset p-4 text-sm sm:grid-cols-2">
          {r.note && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted-foreground">{problem ? "What the provider said" : "Note"}</dt>
              <dd className="mt-0.5 text-foreground">{problem ? providerWords(r.note) : r.note}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted-foreground">Limit</dt>
            <dd className="mt-0.5 text-foreground">{r.limit ?? "—"}</dd>
          </div>
          <div title={r.freshness.source}>
            <dt className="text-xs text-muted-foreground">Checked</dt>
            <dd className="mt-0.5 text-foreground">
              {r.freshness.checkedAt ? fmtRelative(r.freshness.checkedAt) : "—"}
              {r.freshness.estimated && <span className="text-muted-foreground"> · local count</span>}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Key</dt>
            <dd className="mt-0.5 break-all text-sm text-muted-foreground">
              {keyLabel(r)}
              {r.keyTail ? ` · ${r.keyTail}` : ""}
            </dd>
          </div>
        </dl>
      </Disclosure>
    </li>
  );
}

/** Where every number came from: the count of sources that couldn't be read is on the widget above. */
function FreshnessBody({ data }: { data: AiUsageSnapshot }) {
  return (
    <ul className="divide-y divide-border">
      {data.sources.map((s) => (
        <li key={s.name} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
          <StatusDot tone={s.ok ? "success" : "warn"} label={<span className="text-sm text-foreground">{s.name}</span>} />
          <span className="text-sm text-muted-foreground sm:text-right">{s.ok ? `${s.freshness.source} · checked ${fmtRelative(s.freshness.checkedAt)}` : s.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function ClaudeModelsBody({ data }: { data: AiUsageSnapshot }) {
  const c = data.claudeModels;
  return (
    <>
      <p className="mb-3 max-w-[70ch] text-sm text-muted-foreground">
        This month on this PC, from Claude Code's transcripts (usage fields only). The Max plan covers these; the A$ column is what the same tokens would cost on the API.
      </p>
      {"rows" in c ? (
        <Surface padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm sm:min-w-[640px]">
              <thead className="bg-inset">
                <tr className="border-b border-border">
                  {["Model", "Requests", "Input", "Output", "Cache read", "Cache write", "API-equivalent (est.)"].map((h, i) => (
                    <th key={h} scope="col" className={cn("ds-label px-3 py-2.5 font-medium sm:px-4", i === 0 ? "text-left" : "text-right", i >= 2 && i <= 5 && "hidden sm:table-cell")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {c.rows.map((r) => (
                  <tr key={r.model}>
                    <td className="break-all px-3 py-2.5 font-mono text-xs text-foreground sm:px-4">{r.model}</td>
                    <td className="ds-num px-3 py-2.5 text-right sm:px-4">{fmtCount(r.requests)}</td>
                    <td className="ds-num hidden px-4 py-2.5 text-right sm:table-cell">{fmtCompact(r.inputTokens)}</td>
                    <td className="ds-num hidden px-4 py-2.5 text-right sm:table-cell">{fmtCompact(r.outputTokens)}</td>
                    <td className="ds-num hidden px-4 py-2.5 text-right sm:table-cell">{fmtCompact(r.cacheReadTokens)}</td>
                    <td className="ds-num hidden px-4 py-2.5 text-right sm:table-cell">{fmtCompact(r.cacheWrite5mTokens + r.cacheWrite1hTokens)}</td>
                    <td className="ds-num px-3 py-2.5 text-right font-medium sm:px-4">{r.apiEquivalent ? fmtAud(r.apiEquivalent.aud, true) : "not priced"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-inset">
                  <td className="px-3 py-2.5 text-sm font-medium sm:hidden" colSpan={2}>
                    API cost (est.)
                  </td>
                  <td className="hidden px-4 py-2.5 text-sm font-medium sm:table-cell" colSpan={6}>
                    What this would cost on the API (est.)
                  </td>
                  <td className="ds-num px-3 py-2.5 text-right font-semibold sm:px-4">
                    {c.totalApiEquivalent ? fmtAud(c.totalApiEquivalent.aud, true) : "—"}
                    {c.totalApiEquivalent && <span className="block text-xs font-normal text-muted-foreground">{fmtMoneyOrigin(c.totalApiEquivalent)}</span>}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {c.scope} Anthropic list prices; cache writes at the 5-minute (1.25×) or 1-hour (2×) rate each transcript records. Checked {fmtRelative(c.freshness.checkedAt)}.
          </p>
        </Surface>
      ) : (
        <EmptyState variant="row" title="Claude token totals unavailable" body={c.reason} />
      )}
    </>
  );
}

function PriceEditorBody({ prices }: { prices: PriceSetting[] }) {
  return (
    <>
      <p className="mb-3 max-w-[70ch] text-sm text-muted-foreground">
        Published prices the totals start from. If your invoice differs, change it here; it's saved on this PC. ChatGPT is billed in US dollars with 10% GST added.
      </p>
      <ul className="divide-y divide-border rounded-xl bg-inset">
        {prices.map((p) => (
          <PriceRow key={p.id} price={p} />
        ))}
      </ul>
    </>
  );
}

function PriceRow({ price }: { price: PriceSetting }) {
  const actions = useAiUsageActions();
  const [amount, setAmount] = useState(price.amount === null ? "" : String(price.amount));
  const [currency, setCurrency] = useState(price.currency);
  const [gst, setGst] = useState(price.gstIncluded);
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");
  const dirty = useMemo(
    () => amount !== (price.amount === null ? "" : String(price.amount)) || currency !== price.currency || gst !== price.gstIncluded,
    [amount, currency, gst, price],
  );
  const id = `price-${price.id}`;

  const save = async (reset = false) => {
    setState("saving");
    try {
      if (reset) await actions.savePrice(price.id, null);
      else await actions.savePrice(price.id, { amount: amount.trim() === "" ? null : Number(amount), currency, gstIncluded: gst });
      setState("saved");
    } catch (e) {
      setState(e instanceof Error ? e.message : "Couldn't save");
    }
  };

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 lg:max-w-[46%]">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {price.label}
        </label>
        <p className="text-xs text-muted-foreground">
          {price.edited && <Badge tone="accent" className="mr-1.5">Edited</Badge>}
          {price.source}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`${price.label} currency`}
          value={currency}
          onChange={(e) => setCurrency(e.target.value as "AUD" | "USD")}
          className="ds-interactive h-10 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
        >
          <option value="AUD">AUD</option>
          <option value="USD">USD</option>
        </select>
        <input
          id={id}
          inputMode="decimal"
          placeholder="Not set"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="ds-interactive ds-num h-10 w-28 rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground"
        />
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={gst} onChange={(e) => setGst(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--brand)]" />
          incl. GST
        </label>
        <Button size="sm" variant={dirty ? "accent" : "outline"} disabled={!dirty || state === "saving"} onClick={() => save()}>
          {state === "saving" ? "Saving…" : "Save"}
        </Button>
        {price.edited && (
          <Button size="sm" variant="ghost" onClick={() => save(true)}>
            Reset
          </Button>
        )}
        {state === "saved" && !dirty && <span className="text-xs text-success">Saved</span>}
        {state !== "idle" && state !== "saving" && state !== "saved" && <span className="text-xs text-danger">{state}</span>}
      </div>
    </li>
  );
}
