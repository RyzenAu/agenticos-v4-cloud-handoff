import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Notice, StatusDot, fmtCount, fmtRelative, type Tone as DsTone } from "@/components/ds";
import { FLAG_LABEL } from "@/lib/receptionist";
import { useWorkspacePanel, type ReceptionistPanel as Data, type UrgentAlert } from "./api";
import { Metric, PanelShell, Row } from "./panel-shell";

const SEEN_KEY = "agentic-os.workspace.urgent-seen.v1";
const tone = (t: string): DsTone => (t === "ok" ? "success" : t === "bad" ? "danger" : t === "warn" ? "warn" : "neutral");
const flagLabel = (code: string) => (FLAG_LABEL as Record<string, string>)[code] ?? code.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const aud = (v: number | null, digits = 2) => (v === null ? null : `A$${v.toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);

const GATE: Record<string, { tone: DsTone; label: string }> = {
  pass: { tone: "success", label: "Pass" },
  fail: { tone: "danger", label: "Fail" },
  "not-tested": { tone: "warn", label: "Not tested" },
  open: { tone: "info", label: "Needs sign-off" },
  "evidence-missing": { tone: "warn", label: "Evidence missing" },
  // A gate that needs a real call while calls couldn't be read (F2 RX-8): unknown, not a verdict.
  unknown: { tone: "neutral", label: "Unknown" },
};

function readSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Urgent alerts the owner hasn't acknowledged on this browser. Acknowledging is local only. */
export function useUnseenUrgent(alerts: UrgentAlert[] | undefined) {
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  useEffect(() => setSeen(readSeen()), []);
  const unseen = (alerts ?? []).filter((a) => !seen.has(a.id));
  const markSeen = useCallback(() => {
    const next = new Set([...readSeen(), ...(alerts ?? []).map((a) => a.id)]);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...next].slice(-200))); } catch { /* storage blocked: keep in memory */ }
    setSeen(next);
  }, [alerts]);
  return { unseen, markSeen };
}

export function UrgentBanner({ alerts, onSeen, now }: { alerts: UrgentAlert[]; onSeen: () => void; now: number }) {
  if (!alerts.length) return null;
  return (
    <Notice
      tone="danger"
      role="alert"
      title={`${alerts.length} new life-safety or urgent flag${alerts.length === 1 ? "" : "s"} on receptionist calls`}
      action={<Button variant="outline" size="sm" onClick={onSeen}>Mark seen</Button>}
    >
      {alerts.slice(0, 3).map((a) => `${a.codes.map(flagLabel).join(", ")} · ${a.from ?? "caller unavailable"} · ${a.startedAt ? fmtRelative(a.startedAt, now) : "time unavailable"} (${a.source})`).join(" — ")}
      {alerts.length > 3 ? ` and ${alerts.length - 3} more.` : "."} Review on the Receptionist page.
    </Notice>
  );
}

function Body({ data, now }: { data: Data; now: number }) {
  const health = data.health.filter((h) => ["webhook", "feed", "agent", "number"].includes(h.id));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Badge tone={tone(data.verdict.tone)}>{data.verdict.decision}</Badge>
        {data.urgent.length > 0 && <Badge tone="danger">{data.urgent.length} urgent flag{data.urgent.length === 1 ? "" : "s"}</Badge>}
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          {data.verdict.facts.join(" · ")}
          {data.verdict.next && <p className="mt-1 text-sm text-foreground">Next: {data.verdict.next}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Today" value={data.calls.ok ? fmtCount(data.calls.today.count) : null} hint={data.calls.ok ? `${fmtCount(data.calls.today.flagged)} flagged` : "Calls unavailable"} />
        <Metric label="7 days" value={data.calls.ok ? fmtCount(data.calls.week.count) : null} hint={data.calls.ok ? `${fmtCount(data.calls.week.flagged)} flagged` : undefined} tone={data.calls.ok && (data.calls.week.flagged ?? 0) > 0 ? "warn" : undefined} />
        <Metric label="Incidents" value={fmtCount(data.incidents.length)} hint="Flagged, not followed up" tone={data.incidents.length ? "danger" : "success"} />
        <Metric label="Cost / min" value={aud(data.cost.audPerMinute, 3)} hint={data.cost.measuredCalls !== null ? `Measured · ${fmtCount(data.cost.measuredCalls)} calls` : "Not measured yet"} />
      </div>
      {!data.calls.ok && <Notice tone="warn">{data.calls.reason}</Notice>}

      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">Gates · {data.gatesPassed} of {data.gates.length} passed</h3>
        <ul className="space-y-1.5">
          {data.gates.map((g) => (
            <Row key={g.id}>
              <div className="min-w-0">
                <div className="text-sm text-foreground">{g.title}</div>
                {g.note && g.note.toLowerCase() !== (GATE[g.state]?.label ?? "").toLowerCase() && <div className="text-xs text-muted-foreground">{g.note}</div>}
              </div>
              <Badge tone={GATE[g.state]?.tone ?? "neutral"}>{GATE[g.state]?.label ?? g.state}</Badge>
            </Row>
          ))}
        </ul>
        {data.ownerRetestCalls && <p className="mt-2 text-xs text-muted-foreground">Owner retests: {data.ownerRetestCalls.count} of {data.ownerRetestCalls.target}{data.cleanStreak ? ` · clean streak ${data.cleanStreak.count} of ${data.cleanStreak.target}` : ""}</p>}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">Flagged calls to follow up</h3>
        {data.incidents.length === 0 ? (
          <p className="text-xs text-muted-foreground">None open. Flag codes appear here as soon as a real call is flagged.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.incidents.slice(0, 5).map((i) => (
              <Row key={i.callId}>
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-1">{i.flags.map((f) => <Badge key={f} tone={/DANGER|URGENT/.test(f) ? "danger" : "warn"}>{flagLabel(f)}</Badge>)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{i.from ?? "Caller unavailable"} · {i.startedAt ? fmtRelative(i.startedAt, now) : "time unavailable"}</div>
                </div>
              </Row>
            ))}
          </ul>
        )}
        {data.feed.ok && data.feed.flaggedCalls.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Production QA: {fmtCount(data.feed.qaFlagged)} flagged · {fmtCount(data.feed.qaCriticalOpen)} critical open · {fmtCount(data.feed.triagePending)} callbacks pending
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3">
        {health.map((h) => (
          <StatusDot key={h.id} tone={tone(h.tone)} label={<span title={h.headline ?? undefined}>{h.label}{h.asOf ? ` · ${fmtRelative(h.asOf, now)}` : ""}</span>} />
        ))}
        {!data.feed.ok && <StatusDot tone="danger" label={`Feed: ${data.feed.reason}`} />}
      </div>
    </div>
  );
}

export function ReceptionistPanel({ now }: { now: number }) {
  const query = useWorkspacePanel("receptionist");
  return (
    <PanelShell id="ws-receptionist" title="Receptionist" link={{ to: "/receptionist", label: "Receptionist" }} query={query} now={now} asOf={(d) => d.generatedAt} loadingRows={5}>
      {(data) => <Body data={data} now={now} />}
    </PanelShell>
  );
}
