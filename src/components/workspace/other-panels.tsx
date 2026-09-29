import { Link } from "@tanstack/react-router";
import { Badge, Disclosure, EmptyState, Notice, ProgressRing, fmtCount, fmtRelative, type Tone } from "@/components/ds";
import { leadDate } from "@/lib/call-queue";
import { aud } from "@/lib/leads";
import { useWorkspacePanel, type SiteCheck } from "./api";
import { Metric, PanelShell, Row } from "./panel-shell";
import { CallingWindow, sydneyTime } from "./today-panel";
import { fmtDay } from "@/lib/format";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── Call queue ──────────────────────────────────────────────────────────────────────────────────
export function CallQueuePanel({ now }: { now: number }) {
  const query = useWorkspacePanel("callQueue");
  return (
    <PanelShell id="ws-calls" title="Calls to make" link={{ to: "/leads", label: "Leads" }} query={query} now={now} className="rounded-2xl p-5 sm:p-6">
      {(data) => (
        <div className="space-y-3">
          <CallingWindow now={now} />
          {data.items.length === 0 ? (
            <EmptyState variant="row" title="No calls due" body="Schedule a call on a lead to add it here." />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{fmtCount(data.total)} due today or overdue · callbacks first, then score{data.total > data.items.length ? ` · top ${data.items.length} shown` : ""}</p>
              <ul className="space-y-2">
                {data.items.map((l) => (
                  <Row key={l.id}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-medium text-foreground">{l.name}</span>
                        {l.callback && <Badge tone="accent">Call back</Badge>}
                        {l.overdue && <Badge tone="warn">Overdue</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{[l.vertical && cap(l.vertical.replace("-", " ")), l.area, l.phone].filter(Boolean).join(" · ")}</div>
                      {l.nextAction && <div className="mt-1 text-sm text-foreground/90">{l.nextAction}</div>}
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      <div className="ds-num">{leadDate(l.nextAt)}</div>
                      {l.score !== null && <div className="ds-num">Score {l.score}</div>}
                    </div>
                  </Row>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </PanelShell>
  );
}

// ── Websites ────────────────────────────────────────────────────────────────────────────────────
const siteTone = (t: SiteCheck["tone"]): Tone => (t === "ok" ? "success" : t === "warn" ? "warn" : "danger");
const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function SiteRow({ s }: { s: SiteCheck }) {
  return (
    <Row>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <a href={s.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-foreground hover:underline">{s.name}</a>
          {s.noindex === true && <Badge tone={s.expectNoindex === false ? "danger" : "neutral"}>noindex</Badge>}
          {s.noindex === false && s.expectNoindex === true && <Badge tone="warn">indexable</Badge>}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{host(s.url)}{s.finalUrl ? ` → ${host(s.finalUrl)}` : ""}</div>
        {s.note && <div className={`mt-0.5 truncate text-xs ${s.tone === "bad" ? "text-danger" : "text-warn"}`} title={s.note}>{s.note}</div>}
      </div>
      <div className="shrink-0 text-right">
        <Badge tone={siteTone(s.tone)}>{s.status !== null ? `HTTP ${s.status}` : "Down"}</Badge>
        <div className="ds-num mt-1 text-xs text-muted-foreground">{s.ms !== null ? `${fmtCount(s.ms)} ms` : "—"}</div>
      </div>
    </Row>
  );
}

export function WebsitesPanel({ now }: { now: number }) {
  const query = useWorkspacePanel("websites");
  return (
    <PanelShell id="ws-sites" title="Websites" link={{ to: "/websites", label: "Websites" }} query={query} now={now} asOf={(d) => d.checkedAt} loadingRows={5} className="rounded-2xl p-5 sm:p-6">
      {(data) => {
        // W-B: sites that need a look stay visible; healthy ones fold behind one line (nothing removed).
        const attention = data.sites.filter((s) => s.tone !== "ok");
        const healthy = data.sites.filter((s) => s.tone === "ok");
        const down = data.sites.filter((s) => s.tone === "bad").length;
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <ProgressRing value={data.sites.length ? healthy.length : null} max={data.sites.length} size="sm" tone={attention.length ? "warn" : "success"} label={`${healthy.length} of ${data.sites.length} sites answering normally`} />
              <p className="text-sm text-muted-foreground" title="Checked from this PC every 5 min · no deploys from here">
                {down ? <span className="font-medium text-danger">{down} of {data.sites.length} down</span> : data.sites.length ? `All ${data.sites.length} public sites answering` : "No public sites listed, so none were checked"}
              </p>
            </div>
            {attention.length > 0 && <ul className="space-y-2" aria-label="Sites that need a look">{attention.map((s) => <SiteRow key={s.id} s={s} />)}</ul>}
            {healthy.length > 0 && (
              <div className="-mx-3">
                <Disclosure summary={<span className="font-medium">{healthy.length} answering normally</span>} meta="Status and speed">
                  <ul className="space-y-2">{healthy.map((s) => <SiteRow key={s.id} s={s} />)}</ul>
                </Disclosure>
              </div>
            )}
            {data.local.length > 0 && (
              <div className="-mx-3">
                <Disclosure summary={<span className="font-medium">Local previews ({data.local.length})</span>}>
                  <ul className="space-y-2">{data.local.map((s) => <SiteRow key={s.id} s={s} />)}</ul>
                </Disclosure>
              </div>
            )}
            {data.localNotRunning.length > 0 && (
              <p className="text-xs text-muted-foreground">Not running: {data.localNotRunning.map((p) => `${p.name.replace(/ \(local\)$/, "")} (${p.port})`).join(", ")}</p>
            )}
          </div>
        );
      }}
    </PanelShell>
  );
}

// ── Email ───────────────────────────────────────────────────────────────────────────────────────
const IMPORTANCE_TONE: Record<string, Tone> = { urgent: "danger", today: "warn", fyi: "neutral", ignore: "neutral" };
const PROVIDER: Record<string, string> = { gmail: "Gmail", google: "Gmail", outlook: "Outlook" };

export function EmailPanel({ now }: { now: number }) {
  const query = useWorkspacePanel("email");
  return (
    <PanelShell id="ws-email" title="Email" link={{ to: "/inbox", label: "Inbox" }} query={query} now={now}>
      {(data) => {
        if (!data.connected)
          return <EmptyState variant="row" title="Inbox not connected" body={data.reason} action={<Link to="/inbox" className="text-xs font-medium text-foreground underline">Connect on Inbox</Link>} />;
        const stale = data.lastTriagedAt && now - Date.parse(data.lastTriagedAt) > 6 * 3_600_000;
        return (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {data.sources.map((s) => `${PROVIDER[s.id] ?? s.id}${s.lastSync ? ` synced ${fmtRelative(s.lastSync, now)}` : ""}`).join(" · ")}
              {data.lastTriagedAt ? ` · triaged ${fmtRelative(data.lastTriagedAt, now)}` : " · not triaged yet"}
            </p>
            {stale && <Notice tone="warn">Triage hasn't logged anything for over 6 hours. Run triage from Inbox triage to catch up.</Notice>}
            {data.mailboxes && (
              <p className="text-xs text-muted-foreground" data-mailbox-check>
                Mailbox list checked {data.mailboxes.checkedAt ? fmtRelative(data.mailboxes.checkedAt, now) : "not yet"}
                {data.mailboxes.refreshing ? " · re-checking" : ""}
              </p>
            )}
            {data.mailboxes?.error && <Notice tone="warn">The mailbox list couldn't be re-checked ({data.mailboxes.error}); showing the last list.</Notice>}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Urgent" value={fmtCount(data.window.urgent)} tone={(data.window.urgent ?? 0) > 0 ? "danger" : undefined} />
              <Metric label="Today" value={fmtCount(data.window.today)} tone={(data.window.today ?? 0) > 0 ? "warn" : undefined} />
              <Metric label="FYI" value={fmtCount(data.window.fyi)} />
              <Metric label="Noise" value={fmtCount(data.window.ignore)} />
            </div>
            <p className="text-xs text-muted-foreground">Last {data.window.hours} h · {fmtCount(data.window.total)} logged</p>
            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">Needs a reply{data.needsReplyCount > 5 ? ` · top 5 of ${data.needsReplyCount}` : ""}</h3>
              {data.needsReply.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing from the last {data.window.hours} h is waiting on a reply.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.needsReply.map((m, i) => (
                    <Row key={`${m.receivedAt}-${i}`}>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">{m.sender}</div>
                        <div className="truncate text-xs text-muted-foreground">{m.subject}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge tone={IMPORTANCE_TONE[m.importance] ?? "neutral"}>{cap(m.importance === "today" ? "for today" : m.importance)}</Badge>
                        <div className="mt-1 text-xs text-muted-foreground">{m.receivedAt ? fmtRelative(m.receivedAt, now) : "—"}</div>
                      </div>
                    </Row>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Sender, subject and age only. Open the inbox to read or reply; nothing sends from here.</p>
          </div>
        );
      }}
    </PanelShell>
  );
}

// ── Leads & pipeline ────────────────────────────────────────────────────────────────────────────
export function PipelinePanel({ now }: { now: number }) {
  const query = useWorkspacePanel("pipeline");
  return (
    <PanelShell id="ws-pipeline" title="Leads & pipeline" link={{ to: "/leads", label: "Leads" }} query={query} now={now} loadingRows={4} className="rounded-2xl p-5 sm:p-6">
      {(data) => {
        const max = Math.max(1, ...data.stages.map((s) => s.count));
        // W-B: stages with leads stay visible as bars; empty stages are named in one line (nothing removed).
        const filled = data.stages.filter((s) => s.count > 0);
        const empty = data.stages.filter((s) => s.count === 0);
        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Demos" value={fmtCount(data.demosBooked)} hint="Booked (meeting)" />
              <Metric label="Follow-ups" value={fmtCount(data.followUps.dueToday)} hint={`${fmtCount(data.followUps.overdue)} overdue`} tone={(data.followUps.overdue ?? 0) > 0 ? "warn" : undefined} />
              <Metric label="Proposals" value={fmtCount(data.proposals.count)} hint={data.proposals.valueCents ? aud(data.proposals.valueCents) : undefined} />
              <Metric label="New · 7d" value={fmtCount(data.newLeads7d)} hint={data.newLeads7d === null ? (data.newLeads7dNote ?? undefined) : data.stuck ? `${fmtCount(data.stuck)} stuck` : undefined} />
            </div>
            <div>
              <h3 className="mb-3 text-sm font-medium text-foreground">
                {data.open !== null ? `Open leads by stage · ${fmtCount(data.open)} open` : "Stages"}
                {data.total !== null ? ` · ${fmtCount(data.total)} records in the CRM` : ""}
              </h3>
              <ul className="space-y-2" aria-label="Open leads by stage">
                {filled.map((s) => (
                  <li key={s.stage} className="grid grid-cols-[6.5rem_minmax(0,1fr)_2.5rem] items-center gap-3 text-sm">
                    <span className="text-muted-foreground">{cap(s.stage)}</span>
                    <span className="h-2.5 rounded-full bg-inset" aria-hidden="true">
                      <span className="block h-2.5 rounded-full bg-brand" style={{ width: `${Math.max(4, (s.count / max) * 100)}%` }} />
                    </span>
                    <span className="ds-num text-right text-foreground">{fmtCount(s.count)}</span>
                  </li>
                ))}
              </ul>
              {empty.length > 0 && <p className="mt-3 text-xs text-muted-foreground">No leads in: {empty.map((s) => cap(s.stage)).join(", ")}</p>}
            </div>
            {data.upcomingMeetings.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-foreground">Upcoming meetings</h3>
                <ul className="space-y-2">
                  {data.upcomingMeetings.map((m) => (
                    <Row key={`${m.leadId}-${m.at}`}>
                      <span className="text-sm text-foreground">{m.name}</span>
                      <span className="ds-num shrink-0 text-xs text-muted-foreground">{m.at ? `${fmtDay(new Date(m.at), { weekday: true, timeZone: "Australia/Sydney" })} ${sydneyTime(m.at)}` : "—"}</span>
                    </Row>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      }}
    </PanelShell>
  );
}
