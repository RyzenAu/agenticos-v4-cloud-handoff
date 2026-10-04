// System: models, tools, devices, usage and diagnostics. Each block reads one existing endpoint
// and says when it was checked; nothing here changes a setting. Raw payloads go to the Inspector.
// L3 (29 Sep 2026, owner: "everything in System" was small and hard on the eyes): a widget grid that
// fills the width. One headline sentence; four widgets (model providers, tools, the nearest plan
// limit, server restarts); the model providers and the tools that need a look as two list widgets;
// one widget per plan limit; devices and people behind one click. "N not verified" is said in one
// plain line. Version and freshness are one line at the foot.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOpenOnHash } from "../use-open-on-hash";
import { Cpu, Gauge, MonitorSmartphone, RefreshCw, Wrench } from "lucide-react";
import { Badge, Disclosure, EmptyState, Notice, PageFoot, PageHeader, Skeleton, StatusDot, Widget, WidgetEmpty, WidgetGrid, WidgetList } from "@/components/ds";
import { useNow } from "@/components/workspace/panel-shell";
import { honestFromQuery, payloadTime } from "@/lib/honest-state";
import { operatorRequest } from "@/lib/operator";
import { fmtResetIn, pressureTone, useAiUsage } from "@/lib/ai-usage";
import { useInspector, useInspectorFacts } from "../inspector";
import { DestinationMount, MOUNT_FILES, hasMount, preloadMount } from "../mounts";
import { DrilldownList } from "../page-parts";
import { MeterBar, SignalWidget, WidgetButton, WidgetDeck, WidgetLink, agoText } from "../widgets";
import {
  capabilitiesPendingText,
  distinctModelCount,
  modelCheckView,
  modelCountsByProvider,
  planWindowLine,
  providerExplain,
  providerSummary,
  providersHollow,
  providerView,
  restartTile,
  systemHeadline,
  toolAttentionLabel,
  toolCounts,
  toolRowText,
  toolsTile,
  toolStatusView,
  type Capabilities,
  type ModelSnapshot,
  type RestartState,
} from "../system-facts";
import { fmtDateTime, fmtTime } from "@/lib/format";
import { SessionStoreHealthNotice } from "./session-store-notice";
import { HostAlertsNotice, HostHealthList, useHostHealth } from "./host-health-notice";

preloadMount("devices");

type AppVersion = { version: string; date: string; hash: string };
/** GET /__version (scripts/version.ts): the running server's package version, git SHA and start time. */
type RunningVersion = { version: string; gitSha: string; buildTime: string };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok || body === null) throw new Error(typeof body?.error === "string" ? body.error : `${path} answered HTTP ${res.status}`);
  return body as T;
}

const PROVIDER: Record<string, string> = { lmstudio: "LM Studio", ollama: "Ollama", codex: "Codex", claude: "Claude Code", hermes: "Hermes", openrouter: "OpenRouter", deepseek: "DeepSeek Harness" };

export function SystemPage() {
  const hostHealth = useHostHealth();
  const now = useNow(30_000);
  const { publish } = useInspector();
  // The full model check spawns the Codex and Claude CLIs (up to ~10 s cold). `snapshot=1` answers
  // at once with the last check and its time and re-checks in the background; while a check runs
  // the page shows "checking" and asks again every 2 s. Older servers answer with a full check.
  const models = useQuery({
    queryKey: ["system", "models"],
    queryFn: () => getJson<ModelSnapshot>("/__operator/models?snapshot=1"),
    staleTime: 5 * 60_000,
    retry: false,
    refetchInterval: (q) => (q.state.data?.checking ? 2_000 : false),
  });
  const caps = useQuery({ queryKey: ["system", "capabilities"], queryFn: () => getJson<Capabilities>("/__operator/capabilities"), staleTime: 60_000, retry: false });
  const version = useQuery({ queryKey: ["app-version"], queryFn: () => getJson<AppVersion>("/__app_version"), staleTime: 5 * 60_000, retry: false });
  const running = useQuery({ queryKey: ["system", "version"], queryFn: () => getJson<RunningVersion>("/__version"), staleTime: 5 * 60_000, retry: false });
  const restart = useQuery({ queryKey: ["system", "restart"], queryFn: () => getJson<RestartState>("/__dev_restart"), staleTime: 15_000, refetchInterval: 30_000, retry: false });
  const usage = useAiUsage();
  // #system-devices (the Confirm this browser link, the pairing links in Profile) opens the section that holds Devices and people, and scrolls to it.
  // The Devices and people panel (a DeckSection) opens and scrolls on a hashchange event, which a router navigation never sends: send it once the section is open.
  const [runtimeOpen, setRuntimeOpen] = useOpenOnHash("system-devices", () => window.dispatchEvent(new Event("hashchange")));

  const check = modelCheckView(models.data, models.dataUpdatedAt);
  // Asking the providers starts Codex and Claude, so it is a click (T8c); the answer shows "checking" and polls.
  // A check that could not even start used to change nothing on screen; now it says why.
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkModels = () => {
    setCheckError(null);
    void operatorRequest<ModelSnapshot>("/models/refresh", { background: true }).then(
      () => models.refetch(),
      (e: unknown) => { setCheckError(e instanceof Error && e.message ? e.message : "The check could not start."); void models.refetch(); },
    );
  };
  const providers = check.phase === "ready" ? providerSummary(models.data?.statuses ?? []) : null;
  const perProvider = modelCountsByProvider(models.data?.models ?? []);
  const modelTotal = distinctModelCount(models.data?.models ?? []);
  // A check that read nothing (0 verified, 0 failed, 0 models) is Unknown, not a Live zero (REVIEW-T1 R2).
  const providersEmpty = providersHollow(providers, modelTotal);
  const tools = toolCounts(caps.data);
  const restartFacts = restartTile(restart.data, restart.error);
  const peak = usage.data ? [...usage.data.subscriptions].filter((s) => s.peakPercent !== null).sort((a, b) => (b.peakPercent ?? 0) - (a.peakPercent ?? 0)) : [];
  const toolsView = toolsTile(caps.data, caps.error);
  const attentionTools = [...tools.attention, ...tools.unknownItems];
  const explain = providers && !providersEmpty ? providerExplain(models.data?.statuses ?? [], (id) => PROVIDER[id] ?? id) : null;

  useInspectorFacts("System sources", {
    Models: models.isLoading
      ? "loading"
      : models.error
        ? `failed: ${(models.error as Error).message}`
        : check.phase === "checking"
          ? "checking providers (/__operator/models?snapshot=1)"
          : check.phase === "unchecked"
            ? "not checked yet (a page read never starts the providers)"
          : check.checkedAt
            ? `${modelTotal} models, checked ${fmtTime(new Date(check.checkedAt))}${check.rechecking ? ", re-checking" : ""}`
            : `no result: ${check.note ?? "unknown"}`,
    // F3-13: an answer without generatedAt is "loaded, not built yet", not "not loaded".
    Capabilities: caps.data?.generatedAt
      ? `built ${fmtDateTime(new Date(caps.data.generatedAt), { year: true })}`
      : caps.data?.note
        ? `server note: ${caps.data.note}`
        : caps.data
          ? "loaded; the registry hasn't been built yet"
          : caps.error
            ? `failed: ${(caps.error as Error).message}`
            : caps.isLoading
              ? "loading"
              : "not loaded",
    "Restart policy": restart.data
      ? `quietMs ${restart.data.quietMs ?? "not reported"} · maxDeferMs ${restart.data.maxDeferMs ?? "not reported"} (/__dev_restart)`
      : restart.error
        ? `unavailable: ${(restart.error as Error).message}`
        : "loading",
    Build: version.data ? `${version.data.version || "unversioned"} · ${version.data.hash || "no hash"}` : "not loaded",
    "Devices mount": hasMount("devices") ? `mounted from ${MOUNT_FILES.devices.file}` : `fallback; waiting for ${MOUNT_FILES.devices.file} (${MOUNT_FILES.devices.track} track)`,
    "Running version": running.data
      ? `${running.data.version} · ${running.data.gitSha} · server up since ${fmtDateTime(new Date(running.data.buildTime), { year: true })} (/__version)`
      : running.error
        ? `unavailable: ${(running.error as Error).message}`
        : "loading",
  });

  const headline = systemHeadline({
    providers,
    providersEmpty,
    toolsNeedingAttention: caps.data?.generatedAt ? tools.setup + tools.broken : null,
  });
  const versionText = running.data ? `v${running.data.version} · ${running.data.gitSha}` : version.data ? `${version.data.version ? `v${version.data.version}` : "Build"} ${version.data.hash}` : running.error ? "Version unavailable" : null;
  const foot = [
    versionText,
    check.checkedAt !== null ? `Models checked ${agoText(check.checkedAt, now) ?? "—"}` : null,
    caps.data?.generatedAt ? `Tools checked ${agoText(caps.data.generatedAt, now) ?? "—"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="System" description={headline} actions={<WidgetLink to="/system" hash="system-devices">Pair or confirm a browser</WidgetLink>} />
      <SessionStoreHealthNotice />
      <HostAlertsNotice health={hostHealth.data} />
      {hostHealth.data?.checkedAt ? (
        <WidgetGrid className="mb-6" aria-label="Hub computer">
          <HostHealthList health={hostHealth.data} />
        </WidgetGrid>
      ) : null}

      {/* Three tiles share the row: on a wide screen a fourth, empty column left a hole at the right. */}
      <WidgetGrid className="mb-6 xl:grid-cols-3" aria-label="System at a glance">
        <SignalWidget
          icon={Cpu}
          title="Model providers"
          loading={models.isLoading}
          value={providers && !providersEmpty ? `${providers.verified} of ${providers.total}` : null}
          tone={providers?.failed ? "warn" : undefined}
          line={
            providersEmpty
              ? "Nothing verified or listed yet: no provider check has answered"
              : explain
                ? explain
                : providers
                  ? `Every provider verified · ${modelTotal} models`
                  : models.error
                    ? "Catalogue unavailable"
                    : check.phase === "checking"
                      ? "Checking providers…"
                      : check.phase === "unchecked"
                        ? undefined // the Models card below says it, with the Check now button
                        : (check.note ?? undefined)
          }
          state={models.error || check.phase === "failed" ? "failed" : providersEmpty || check.phase === "unchecked" ? "unknown" : honestFromQuery(models, now)}
          updatedAt={check.checkedAt ?? undefined}
          now={now}
          staleAfterMs={30 * 60_000}
          action={<WidgetLink to="/models">Open Models</WidgetLink>}
        />
        <SignalWidget
          icon={Wrench}
          title="Tools to fix"
          loading={caps.isLoading}
          value={toolsView.value}
          tone={toolsView.tone}
          line={
            caps.data?.generatedAt
              ? `${toolAttentionLabel(tools)} · ${tools.working} of ${tools.total} working`
              : caps.error
                ? "Registry unavailable"
                : undefined // not built yet: the Tools card below says why, once
          }
          state={toolsView.state ?? honestFromQuery(caps, now)}
          updatedAt={caps.data?.generatedAt ?? undefined}
          now={now}
          staleAfterMs={24 * 3_600_000}
          action={
            caps.data?.generatedAt && attentionTools.length ? (
              <WidgetButton onClick={() => document.getElementById("system-tools")?.scrollIntoView({ block: "start" })}>See the tools</WidgetButton>
            ) : undefined
          }
        />
        <SignalWidget
          icon={Gauge}
          title="Nearest plan limit"
          loading={usage.isLoading}
          state={honestFromQuery(usage, now)}
          lastSuccess={usage.data ? (payloadTime(usage.data) ?? usage.dataUpdatedAt) : null}
          now={now}
          value={peak[0] ? `${Math.round(peak[0].peakPercent ?? 0)}%` : null}
          tone={
            peak[0]
              ? pressureTone(peak[0].peakPercent) === "danger" ? "danger" : pressureTone(peak[0].peakPercent) === "warn" ? "warn" : undefined
              : undefined
          }
          // F3-07: while usage is loading there is no answer yet, so no "No limits reported".
          line={usage.isLoading ? undefined : peak[0] ? `${peak[0].owner} · ${peak[0].plan}` : usage.error ? "Usage unavailable" : "No limits reported"}
          link={{ to: "/usage", label: "AI usage & spend" }}
        />
      </WidgetGrid>
      {(restartFacts.failed || restartFacts.tone === "warn") && (
        <p role="status" className="mb-4 text-sm text-danger">
          {restartFacts.hint}
        </p>
      )}

      <WidgetGrid className="mb-6" aria-label="Models and tools">
        {models.isLoading ? (
          <Skeleton className="col-span-full h-56 rounded-2xl md:col-span-2" />
        ) : models.error ? (
          <Widget icon={Cpu} title="Models" span={2}>
            <EmptyState variant="row" icon={Cpu} title="Model catalogue unavailable" body={(models.error as Error)?.message ?? "No answer."} />
          </Widget>
        ) : check.phase === "checking" ? (
          <Widget icon={Cpu} title="Models" span={2} data-models-state="checking">
            <WidgetEmpty title="Checking model providers…" body="Asking Codex, Claude Code, Hermes and the local model servers. Nothing is shown as ready meanwhile." />
          </Widget>
        ) : check.phase === "unchecked" ? (
          <Widget icon={Cpu} title="Models" span={2} data-models-state="unchecked" action={<WidgetButton onClick={checkModels} accent>Check now</WidgetButton>}>
            <WidgetEmpty title="Model providers not checked yet" body="Checking asks Codex, Claude Code, Hermes and the local model servers, so it only runs when you ask or on the server's own schedule." />
          </Widget>
        ) : check.phase === "failed" ? (
          <Widget icon={Cpu} title="Models" span={2} data-models-state="failed">
            <EmptyState variant="row" icon={Cpu} title="Model check failed" body={check.note ?? "No result."} />
          </Widget>
        ) : (
          <WidgetList
            icon={Cpu}
            title="Models"
            span={2}
            badge={check.rechecking ? "Re-checking…" : undefined}
            data-models-state="ready"
            action={
              check.rechecking ? undefined : (
                <WidgetButton onClick={checkModels}>Check again</WidgetButton>
              )
            }
          >
            {checkError && (
              <li className="py-3 first:pt-0">
                <Notice tone="danger" title="The model check didn't run">{checkError} Press Check again to retry.</Notice>
              </li>
            )}
            {(models.data?.statuses ?? []).map((s) => {
              const view = providerView(s);
              const count = perProvider[s.id];
              return (
                <li key={s.id} className="flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0">
                  {/* The badge beside the name carries the state in words. */}
                  <span className="shrink-0">
                    <StatusDot tone={view.tone} label={null} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-medium text-foreground">
                        {PROVIDER[s.id] ?? s.id}
                      </span>
                      <Badge tone={view.tone}>{view.label}</Badge>
                    </span>
                    <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">
                      {s.detail}
                    </span>
                  </span>
                  <span className="ds-num shrink-0 text-sm text-muted-foreground" title={count ? `${count} models` : undefined}>
                    {count ? `${count} models` : ""}
                  </span>
                </li>
              );
            })}
            {check.note && <li className="py-3 text-sm text-warn">{check.note}</li>}
          </WidgetList>
        )}

        {caps.isLoading ? (
          <Skeleton className="col-span-full h-56 rounded-2xl md:col-span-2" />
        ) : caps.data?.generatedAt ? (
          <WidgetList icon={Wrench} title="Tools" span={2} id="system-tools">
            {attentionTools.length === 0 && (
              <li className="py-3 text-base text-foreground" data-tools-none>
                No tools need setup
                <span className="mt-0.5 block text-sm text-muted-foreground">Nothing is broken or waiting on setup in the capability registry.</span>
              </li>
            )}
            {attentionTools.slice(0, 3).map((c) => (
              <ToolRow key={c.id} c={c} />
            ))}
            {attentionTools.length > 3 && (
              <li className="py-2">
                <Disclosure
                  className="-mx-3"
                  summary={
                    <span className="text-sm font-medium">
                      {attentionTools.length - 3} more{" "}
                      {attentionTools.length - 3 === 1 ? "tool needs" : "tools need"} a look
                    </span>
                  }
                >
                  <ul className="divide-y divide-border">
                    {attentionTools.slice(3, 10).map((c) => (
              <ToolRow key={c.id} c={c} />
            ))}
                  </ul>
                </Disclosure>
              </li>
            )}
            <li className="flex flex-wrap gap-x-4 gap-y-1 py-3 text-sm" data-tools-summary>
              <StatusDot tone="success" label={`${tools.working} working`} />
              <StatusDot tone="neutral" label={`${tools.available} available · not tested`} />
              <StatusDot tone={tools.setup ? "warn" : "neutral"} label={`${tools.setup} need setup`} />
              <StatusDot tone={tools.broken ? "danger" : "neutral"} label={`${tools.broken} broken`} />
              {tools.unknown > 0 && <StatusDot tone="neutral" label={`${tools.unknown} unknown`} />}
            </li>
          </WidgetList>
        ) : (
          <Widget icon={Wrench} title="Tools" span={2} id="system-tools">
            <EmptyState variant="row" icon={Wrench} title="Tool check hasn't run" body={capabilitiesPendingText(caps.data, caps.error)} />
          </Widget>
        )}
      </WidgetGrid>

      <details className="mb-6 border-t border-border py-2" open={runtimeOpen} onToggle={(e) => setRuntimeOpen(e.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
          Plan usage, devices & runtime
        </summary>
        <WidgetGrid className="my-4">
          <SignalWidget
          icon={RefreshCw}
          title="Server restarts"
          loading={restart.isLoading}
          value={restartFacts.value}
          tone={restartFacts.tone}
          line={restartFacts.hint}
          state={restartFacts.failed ? "failed" : honestFromQuery(restart, now)}
          updatedAt={restart.data ? restart.dataUpdatedAt : undefined}
          now={now}
        />
        </WidgetGrid>
        <WidgetDeck
          className="mb-10"
          lead={
            usage.isLoading ? (
            <Skeleton className="col-span-full h-44 rounded-2xl md:col-span-2" />
          ) : peak.length ? (
              peak.slice(0, 5).map((s) => {
                const top = s.status.ok ? [...s.status.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0] : null;
                const value = Math.round(s.peakPercent ?? 0);
                return (
                  <Widget
                  key={s.id}
                  icon={Gauge}
                  title={s.owner}
                  value={`${value}%`}
                  tone={pressureTone(s.peakPercent) === "danger" ? "danger" : pressureTone(s.peakPercent) === "warn" ? "warn" : "default"}
                  line={s.plan}
                  data-plan={s.id}
                >
                    {top && (
                      <MeterBar label={planWindowLine(top.label, fmtResetIn(top.resetsAt))} percent={top.usedPercent} right={`${Math.round(top.usedPercent)}%`} />
                    )}
                  </Widget>
                );
              })
            ) : (
            <Widget icon={Gauge} title="Plan limits" value={null} line={usage.error ? (usage.error as Error).message : "No plan limits reported. Connect an AI account on AI usage & spend."} action={<WidgetLink to="/usage">AI usage & spend</WidgetLink>} />
          )
          }
          items={[
          {
            id: "system-devices",
            icon: MonitorSmartphone,
            title: "Devices and people",
            line: "This device, who's online, pairing codes and paired devices",
            detail: () => (
              <DestinationMount
                area="devices"
                inspect={publish}
                fallback={
                  <EmptyState
                    variant="row"
                    icon={MonitorSmartphone}
                    title="Device routing isn't in this build"
                    body="Which PC each person's Jarvis controls, and who is signed in, arrive with the devices track. Paired phones are on OpenClaw."
                  />
                }
              />
            ),
          },
        ]}
        />
      </details>
      <DrilldownList id="system" />
      <PageFoot title="Model catalogue snapshot, capability registry, AI usage plan limits and the dev server restart policy.">
        {foot || "Reads are live; each block says when it was checked."}. Nothing here changes a setting.
      </PageFoot>
    </div>
  );
}

function ToolRow({ c }: { c: ReturnType<typeof toolCounts>["attention"][number] }) {
  const view = toolStatusView(c.status);
  const text = toolRowText(c);
  return (
    <li className="flex min-w-0 py-3 first:pt-0 last:pb-0">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-medium text-foreground">{c.name}</span>
          <Badge tone={view.tone}>{view.label}</Badge>
        </span>
        {/* R7 audit 2 item 11: a human sentence; the registry's own wording (variable names, config paths, doc files) stays inside Technical detail. */}
        {text.plain.map((line) => (
          <span key={line} className="mt-0.5 block text-sm leading-snug text-muted-foreground" data-tool-evidence>
            {line}
          </span>
        ))}
        {text.technical.length > 0 && (
          <details className="mt-1 text-sm text-muted-foreground" data-tool-technical>
            <summary className="min-h-11 cursor-pointer py-2.5">Technical detail</summary>
            {text.technical.map((line) => (
              <span key={line} className="mt-0.5 block break-words font-mono text-xs leading-snug">{line}</span>
            ))}
          </details>
        )}
      </span>
    </li>
  );
}
