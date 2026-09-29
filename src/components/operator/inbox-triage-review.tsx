// /inbox-triage — today's inbox triage log and the Jev shadow review. Read-only: this page only
// shows what scripts/inbox-triage logged (masked metadata and one-line summaries). Switching live
// alerts on stays a deliberate command at the PC (bun scripts/inbox-triage/cli.ts alerts on).
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Inbox, ShieldCheck, Users } from "lucide-react";
import { Badge, EmptyState, Notice, PageHeader, Section, Skeleton, StatTile, Surface, type Tone } from "@/components/ds";
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

const TONE: Record<Importance, Tone> = { urgent: "danger", today: "warn", fyi: "info", ignore: "neutral" };
const time = (iso: string) => fmtDateTime(new Date(iso), { weekday: true });
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

function RowLine({ row }: { row: Row }) {
  const differs = row.jevImportance && (row.jevImportance !== row.rulesImportance || row.jevCategory !== row.rulesCategory);
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-3 last:border-0 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex w-40 shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {time(row.receivedAt)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TONE[row.importance]}>{row.importance}</Badge>
          <Badge tone={row.category === "client" ? "accent" : "neutral"}>{row.category}</Badge>
          {row.wouldAlert && <Badge tone={row.alertStatus.includes("sent") ? "success" : "warn"} title={row.alertStatus}>{row.alertStatus.startsWith("telegram") ? "alerted" : row.alertStatus || "would alert"}</Badge>}
          <span className="truncate text-sm font-medium">{row.senderName}</span>
          <span className="truncate text-xs text-muted-foreground">{row.senderDomain}</span>
        </div>
        <p className="mt-1 truncate text-sm">{row.subject}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{row.reason}</p>
        {differs && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Jev: {row.jevCategory}/{row.jevImportance}
            {row.jev ? ` (${Math.round(row.jev.importanceConfidence * 100)}% sure, manipulation ${Math.round(row.jev.manipulation * 100)}%)` : ""}
          </p>
        )}
      </div>
    </li>
  );
}

export function InboxTriageReview() {
  const { data, error, isLoading } = useQuery<Overview>({
    queryKey: ["inbox-triage"],
    queryFn: () => operatorRequest<Overview>("/inbox/triage"),
    refetchInterval: 60_000,
  });
  const important = data?.rows.filter((r) => r.importance === "urgent" || r.importance === "today" || r.category === "client") ?? [];
  const rest = data?.rows.filter((r) => !important.includes(r)) ?? [];
  return (
    <div className="max-w-[1200px]">
      <PageHeader
        title="Inbox triage"
        description="Every new email, logged and labelled: rules first, Jev beside them. Nothing here replies to, sends, archives or deletes mail."
        meta={data?.counts.lastLoggedAt ? `Last email logged ${time(data.counts.lastLoggedAt)}` : undefined}
      />
      {error && <Notice tone="danger" title="Couldn't read the triage log">{(error as Error).message}</Notice>}
      {isLoading && <Skeleton className="h-40 w-full" />}
      {data && (
        <div className="flex flex-col gap-8">
          {!data.alerts.enabled && (
            <Notice tone="info" title="Alerts are armed but off">
              Would-be alerts are logged as “armed-off”. To switch Telegram DMs and spoken alerts on, run
              <code className="mx-1 rounded bg-muted px-1">bun scripts/inbox-triage/cli.ts alerts on</code>in AgenticOS-v4.
            </Notice>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Last 24 h" value={data.digest.total} hint="emails logged" icon={Inbox} />
            <StatTile label="Urgent" value={data.digest.urgent} tone={data.digest.urgent ? "danger" : "default"} hint={`${data.digest.today} more for today`} icon={AlertTriangle} />
            <StatTile label="Clients" value={data.digest.clients} hint="from known clients" icon={Users} />
            <StatTile
              label="Jev shadow"
              value={`${data.jev.shadowDone}/${data.jev.shadowTarget}`}
              hint={`agrees on importance ${pct(data.shadow.agreeImportance, data.shadow.withJev)}, category ${pct(data.shadow.agreeCategory, data.shadow.withJev)}`}
              icon={ShieldCheck}
            />
          </div>
          <Section title="Needs you" description="Urgent, for today, or from a client.">
            <Surface padding="md">
              {important.length ? <ul>{important.map((r) => <RowLine key={r.messageId} row={r} />)}</ul> : <EmptyState icon={Inbox} title="Nothing important in the last day" body="Client emails, security alerts and payment problems show up here." variant="row" />}
            </Surface>
          </Section>
          <Section title="Jev disagrees" description={`Where Jev's label differs from the rules (${data.shadow.jevHigher} higher, ${data.shadow.jevLower} lower). Rules win while in ${data.jev.mode} mode.`}>
            <Surface padding="md">
              {data.shadow.disagreements.length ? <ul>{data.shadow.disagreements.slice(0, 25).map((r) => <RowLine key={r.messageId} row={r} />)}</ul> : <EmptyState icon={ShieldCheck} title="No disagreements yet" variant="row" />}
            </Surface>
          </Section>
          <Section title="Everything else" description="FYI and noise from the last day.">
            <Surface padding="md">
              {rest.length ? <ul>{rest.map((r) => <RowLine key={r.messageId} row={r} />)}</ul> : <EmptyState icon={Inbox} title="Nothing else logged" variant="row" />}
            </Surface>
          </Section>
        </div>
      )}
    </div>
  );
}
