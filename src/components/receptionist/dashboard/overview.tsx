import { Notice, InfoTip, Section } from "@/components/ds";
import type { DashboardViewModel } from "@/lib/receptionist-dashboard";
import { CLIENT_UNREPORTED_HINT, NOT_ATTRIBUTED_HINT } from "../../../../scripts/receptionist/dashboard";
import { catalogueLabels } from "@/lib/price-status";
import { mergeSellExceptions, type MergedExceptions } from "./sell-exceptions";
import { aud, DashTile, ExceptionsList } from "./shared";

/** The always-visible readiness item the master prompt names: the live line takes a message, it
 *  does not book, until the demo line's own feed evidence proves otherwise. */
function LiveLineMismatch({ mismatch }: { mismatch: DashboardViewModel["goLive"]["liveLineMismatch"] }) {
  if (mismatch.resolved) return <Notice tone="success" title="Booking verified on the demo line" className="rounded-2xl">{mismatch.reason}</Notice>;
  return <Notice tone="warn" title="Live-line capability mismatch" className="rounded-2xl">{mismatch.message} {mismatch.reason}</Notice>;
}

const CHANNEL_TEXT = { ok: "Healthy", warn: "Needs attention", bad: "Not connected", unknown: null } as const;
const CHANNEL_TONE = { ok: "success", warn: "warn", bad: "danger", unknown: undefined } as const;
const LINE_SOURCE_NOTE = {
  options: "Line set explicitly",
  config: "Line from runtime config",
  "legacy-demo-default": "Line is the legacy demo default: set RECEPTIONIST_RETELL_AGENT_ID and RECEPTIONIST_INBOUND_NUMBER in System",
} as const;

/**
 * Retell / Twilio / webhook / agent: an unknown channel shows "Unknown", never "Healthy". A failed
 * provider read is a failed tile with the provider's own reason and its LAST GOOD read time, never
 * "Updated just now" (RX-7).
 */
function Channels({ data }: { data: DashboardViewModel }) {
  const ch = data.channelHealth;
  const ar = data.agentReadiness;
  const channel = (label: string, key: "retell" | "twilio" | "webhook", hint?: string) => {
    const v = ch.ok ? ch[key] : null;
    const reason = ch.ok ? ch.reasons[key] : null;
    // A Retell/Twilio read that failed (the webhook is read through Retell): a failed tile for THAT provider.
    const provider = key === "webhook" ? "retell" : key;
    const failedRead = ch.ok && v === "unknown" && reason !== null && ch[provider] === "unknown";
    const block = failedRead ? { ok: false as const, reason, source: ch.source, asOf: ch.lastOkAt[provider], stale: true, staleAfterMs: ch.staleAfterMs } : ch;
    return <DashTile label={label} block={block} value={v === null || v === "unknown" ? null : CHANNEL_TEXT[v]} tone={v === null ? undefined : CHANNEL_TONE[v]} hint={hint} unknownHint={reason ?? "Provider read unavailable"} />;
  };
  return (
    <div className="sh-signals mb-6">
      {channel("Retell agent", "retell", ar.ok ? `${ar.published ? "Published" : "Draft"} v${ar.version ?? "?"} · ${ar.agentEditNote}` : undefined)}
      {channel("Twilio trunk", "twilio")}
      {channel("Webhook", "webhook")}
      <DashTile
        label="Number attached"
        block={ar}
        value={ar.ok ? ar.numberAttached : null}
        tone={ar.ok && ar.numberAttached === false ? "danger" : undefined}
        unknownHint="Number read unavailable"
        hint={ar.ok && ar.lineSource ? LINE_SOURCE_NOTE[ar.lineSource] : undefined}
      />
    </div>
  );
}

/** `exceptions` = feed exceptions merged with sell-status incidents and blockers (sell-exceptions.ts). */
export function Overview({ data, exceptions }: { data: DashboardViewModel; exceptions?: MergedExceptions }) {
  const clients = data.clients.ok ? data.clients.rows : [];
  // Without the sell status the list can never claim "none" (sell-exceptions.ts truth rule).
  const merged = exceptions ?? mergeSellExceptions({ items: data.exceptions, summary: data.exceptionSummary }, { data: undefined, error: null, isLoading: false });
  const ex = merged.summary;

  return (
    <div className="mb-12">
      <div className="mb-6"><LiveLineMismatch mismatch={data.goLive.liveLineMismatch} /></div>
      <Channels data={data} />
      <div className="sh-signals mb-6">
        <DashTile label="Clients" block={data.clients} value={data.clients.ok ? clients.length : null} />
        <DashTile label="Live (booking)" block={data.clients} value={data.clients.ok ? clients.filter((c) => c.onboardingStatus === "live").length : null} />
        <DashTile
          label="Open exceptions"
          block={ex}
          value={ex.ok ? ex.count : null}
          // Success colour only when every source was read and nothing is open.
          // D1: open exceptions are "needs attention" (warn), never the alarm; the verdict carries that.
          tone={ex.ok ? (ex.count ? "warn" : merged.complete ? "success" : undefined) : undefined}
          hint={ex.ok ? [ex.critical ? `${ex.critical} critical` : "", merged.complete ? "" : `Partial: at least ${ex.count}; ${merged.missing.join(" and ")} not read`].filter(Boolean).join(" · ") || undefined : undefined}
        />
        <DashTile
          label="MRR (billed clients)"
          block={data.commercial}
          value={data.commercial.ok ? data.commercial.mrrCents : null}
          display={data.commercial.ok ? aud(data.commercial.mrrCents) : undefined}
          hint={data.commercial.ok ? `${catalogueLabels().monthly}${data.commercial.unassignedClients ? ` · ${data.commercial.unassignedClients} unassigned` : ""}` : undefined}
          unknownHint="No client has a package assigned"
        />
        <DashTile
          label="Est. provider cost / mo"
          block={data.economics}
          value={data.economics.ok ? data.economics.estimatedMonthlyCents : null}
          display={data.economics.ok ? `${data.economics.estimatedComplete ? "" : "≥ "}${aud(data.economics.estimatedMonthlyCents)}` : undefined}
          hint={data.economics.ok && data.economics.estimatedUnknownClients ? `Estimate, not measured · ${data.economics.estimatedUnknownClients} client${data.economics.estimatedUnknownClients === 1 ? "" : "s"} with unreported usage not included` : "Estimate, not measured"}
          unknownHint="No package assigned to estimate against"
        />
        <DashTile
          label="Minutes used / included"
          block={data.usage}
          value={data.usage.ok ? data.usage.usedTotal : null}
          display={data.usage.ok && data.usage.usedTotal !== null ? `${Math.round(data.usage.usedTotal)}${data.usage.includedTotal !== null ? ` / ${data.usage.includedTotal}` : ""}` : undefined}
          lowerBound={data.usage.ok && data.usage.usedIsLowerBound}
          tone={data.usage.ok && (data.usage.overageMinutesTotal ?? 0) > 0 ? "warn" : undefined}
          hint={data.usage.ok ? ((data.usage.overageMinutesTotal ?? 0) > 0 ? `${data.usage.overageMinutesTotal} min overage` : data.usage.includedTotal === null ? "Included unknown: a client has no package" : undefined) : undefined}
          unknownHint={!data.usage.ok || data.usage.attribution === "not-attributed" ? NOT_ATTRIBUTED_HINT : data.usage.attribution === "client-unreported" ? CLIENT_UNREPORTED_HINT : "The feed didn't report this month's minutes"}
          unknownNeedsSetup={data.usage.ok && data.usage.attribution === "client-unreported"}
        />
      </div>
      <Section title="Exceptions" actions={<InfoTip label="About this section">Flagged calls, open go-live gates and feed exceptions, deduplicated by call or client. Expand a row for detail.</InfoTip>}>
        <ExceptionsList items={merged.items} summary={ex} complete={merged.complete} missing={merged.missing} />
      </Section>
    </div>
  );
}
