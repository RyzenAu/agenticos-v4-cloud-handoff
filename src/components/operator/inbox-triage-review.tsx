// /inbox-triage — today's inbox triage log and the Jev shadow review. Read-only: this page only
// shows what scripts/inbox-triage logged (masked metadata and one-line summaries). Switching live
// alerts on stays a deliberate command at the PC (bun scripts/inbox-triage/cli.ts alerts on).
// R12 rollout: page anatomy — compact header with one primary action (Open inbox), one toolbar (search, the Needs you / Everything
// else filter, the counts), one table, and a detail drawer per email held in the URL (?mail=<id>). Jev's shadow review stays folded.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { Button, DataTable, DetailDrawer, Details, EmptyState, Notice, PageHeader, Segmented, Skeleton, StatusLabel, Toolbar, type Column, type StatusState } from "@/components/ds";
import { operatorRequest } from "@/lib/operator";
import { fmtDateTime } from "@/lib/format";

type Importance = "urgent" | "today" | "fyi" | "ignore";
type Row = {
  messageId: string;
  receivedAt: string;
  senderName: string;
  senderDomain: string;
  subject: string;
  summary: string;
  category: string;
  importance: Importance;
  reason: string;
  rulesCategory: string;
  rulesImportance: Importance;
  jevCategory: string | null;
  jevImportance: Importance | null;
  jev: { categoryConfidence: number; importanceConfidence: number; manipulation: number } | null;
  jevError: string | null;
  wouldAlert: boolean;
  alertBasis: string;
  alertStatus: string;
};
type Overview = {
  alerts: { enabled: boolean; telegram: boolean; voice: boolean };
  call: { enabled: boolean; ready: boolean; missing: string[] };
  jev: { mode: string; shadowTarget: number; shadowDone: number; keyPresent: boolean };
  counts: { total: number; withJev: number; lastLoggedAt: string | null };
  shadow: { withJev: number; agreeCategory: number; agreeImportance: number; jevHigher: number; jevLower: number; jevErrors: number; disagreements: Row[] };
  digest: { total: number; urgent: number; today: number; fyi: number; ignore: number; clients: number; lines: string[] };
  rows: Row[];
};

/** Importance in the shared status language. Urgent is amber ("needs you"), never red: red is only for a real failure. */
const IMPORTANCE: Record<Importance, { state: StatusState; label: string }> = {
  urgent: { state: "needs-you", label: "Urgent" },
  today: { state: "pending", label: "Today" },
  fyi: { state: "idle", label: "FYI" },
  ignore: { state: "idle", label: "Ignore" },
};
const time = (iso: string) => fmtDateTime(new Date(iso), { weekday: true });
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
type Filter = "important" | "rest" | "all";

export function InboxTriageReview() {
  const { data, error, isLoading } = useQuery<Overview>({
    queryKey: ["inbox-triage"],
    queryFn: () => operatorRequest<Overview>("/inbox/triage"),
    refetchInterval: 60_000,
  });
  const navigate = useNavigate();
  const mail = (useSearch({ strict: false }) as { mail?: unknown }).mail;
  const openId = typeof mail === "string" ? mail : null;
  const open = (id: string | null) => void navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, mail: id ?? undefined }) } as never);
  const [filter, setFilter] = useState<Filter>("important");
  const [q, setQ] = useState("");
  const important = useMemo(() => data?.rows.filter((r) => r.importance === "urgent" || r.importance === "today" || r.category === "client") ?? [], [data]);
  const rest = useMemo(() => data?.rows.filter((r) => !important.includes(r)) ?? [], [data, important]);
  const base = filter === "important" ? important : filter === "rest" ? rest : (data?.rows ?? []);
  const needle = q.trim().toLowerCase();
  const rows = needle ? base.filter((r) => `${r.senderName} ${r.senderDomain} ${r.subject} ${r.summary}`.toLowerCase().includes(needle)) : base;
  const all = [...(data?.rows ?? []), ...(data?.shadow.disagreements ?? [])];
  const sel = openId ? all.find((r) => r.messageId === openId) : undefined;

  const columns: Column<Row>[] = [
    {
      key: "email",
      header: "Email",
      cell: (r) => (
        <span className="block" data-triage-row={r.messageId}>
          <span className="block font-medium text-foreground">{r.subject}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {r.senderName} · {r.senderDomain}
          </span>
        </span>
      ),
    },
    { key: "importance", header: "Importance", width: "9rem", cell: (r) => <StatusLabel {...IMPORTANCE[r.importance]} size="sm" bare /> },
    { key: "category", header: "Category", width: "8rem", hideBelow: "md", cell: (r) => <span className="capitalize">{r.category}</span> },
    { key: "received", header: "Received", width: "11rem", hideBelow: "lg", align: "right", cell: (r) => <span className="text-muted-foreground">{time(r.receivedAt)}</span> },
  ];

  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader
        title="Inbox triage"
        description="Every new email, logged and labelled. Nothing here replies, sends, archives or deletes."
        meta={data?.counts.lastLoggedAt ? `Last email logged ${time(data.counts.lastLoggedAt)}` : undefined}
        spacing="tight"
        primaryAction={
          <Button variant="accent" asChild>
            <Link to="/inbox">Open inbox</Link>
          </Button>
        }
      />
      {error && <Notice tone="danger" title="Couldn't read the triage log">{(error as Error).message}</Notice>}
      {isLoading && <Skeleton className="h-40 w-full" />}
      {data && (
        <>
          {!data.alerts.enabled && (
            <Notice tone="info" className="mb-4" title="Alerts are armed but off">
              Urgent mail is logged, not sent anywhere. Ask Jarvis to switch Telegram and spoken alerts on.
            </Notice>
          )}
          {/* R11: with nothing logged at all, one empty state (not three headed boxes saying nothing). */}
          {!data.rows.length ? (
            <EmptyState icon={Inbox} title="No email logged in the last day" body="Client emails, security alerts and payment problems show up here once mail arrives." />
          ) : (
            <>
              <Toolbar
                label="Triage filters"
                search={{ value: q, onChange: setQ, placeholder: "Search sender or subject" }}
                filters={
                  <Segmented
                    ariaLabel="Show"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "important", label: `Needs you · ${important.length}` },
                      { value: "rest", label: `Everything else · ${rest.length}` },
                      { value: "all", label: "All" },
                    ]}
                  />
                }
                summary={`${data.digest.total} in the last 24 h · ${data.digest.urgent} urgent · ${data.digest.clients} from clients`}
              />
              <DataTable
                caption="Triaged email"
                data-testid="triage-table"
                columns={columns}
                rows={rows}
                rowKey={(r) => r.messageId}
                onRowClick={(r) => open(r.messageId)}
                rowLabel={(r) => `Open ${r.subject}`}
                selectedKey={openId}
                empty={<EmptyState variant="row" icon={Inbox} title={filter === "important" ? "Nothing important in the last day" : "Nothing matches"} />}
              />
            </>
          )}
          <div className="mt-8">
            <Details summary="Jev's second opinion (shadow mode)" meta={`${data.jev.shadowDone}/${data.jev.shadowTarget} checked`}>
              <p>
                Agrees with the rules on importance {pct(data.shadow.agreeImportance, data.shadow.withJev)} and category {pct(data.shadow.agreeCategory, data.shadow.withJev)}. Where it differs ({data.shadow.jevHigher} higher, {data.shadow.jevLower} lower) the rules win while in {data.jev.mode} mode.
              </p>
              {data.shadow.disagreements.length > 0 ? (
                <ul className="mt-2 divide-y divide-border">
                  {data.shadow.disagreements.slice(0, 25).map((r) => (
                    <li key={r.messageId} className="py-2">
                      <button type="button" className="ds-interactive rounded text-left text-sm hover:underline" onClick={() => open(r.messageId)}>
                        {r.subject}
                      </button>
                      <span className="block text-xs text-muted-foreground">
                        Rules {r.rulesCategory}/{r.rulesImportance} · Jev {r.jevCategory}/{r.jevImportance}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2">No disagreements yet.</p>
              )}
            </Details>
          </div>
        </>
      )}
      <DetailDrawer
        open={!!sel}
        onOpenChange={(o) => !o && open(null)}
        title={sel?.subject ?? ""}
        status={sel ? <StatusLabel {...IMPORTANCE[sel.importance]} /> : undefined}
        description={sel ? `${sel.senderName} · ${sel.senderDomain} · ${time(sel.receivedAt)}` : undefined}
        actions={
          <Button variant="accent" asChild>
            <Link to="/inbox">Open inbox to reply</Link>
          </Button>
        }
      >
        {sel && (
          <div className="space-y-4 text-sm" data-triage-drawer={sel.messageId}>
            {sel.summary && <p className="leading-relaxed text-foreground">{sel.summary}</p>}
            <p className="text-muted-foreground">{sel.reason}</p>
            {sel.wouldAlert && <p className="text-muted-foreground">Alert: {sel.alertStatus || "would alert"} ({sel.alertBasis})</p>}
            <Details
              items={[
                { label: "Category", value: sel.category },
                { label: "Rules", value: `${sel.rulesCategory} / ${sel.rulesImportance}` },
                { label: "Jev", value: sel.jevImportance ? `${sel.jevCategory} / ${sel.jevImportance}${sel.jev ? ` (${Math.round(sel.jev.importanceConfidence * 100)}% sure, manipulation ${Math.round(sel.jev.manipulation * 100)}%)` : ""}` : (sel.jevError ?? "Not checked") },
                { label: "Message", value: sel.messageId, mono: true },
              ]}
            />
          </div>
        )}
      </DetailDrawer>
    </div>
  );
}
