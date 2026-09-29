import { Phone } from "lucide-react";
import { Badge, Button, Notice, Skeleton, Surface, Widget, WidgetEmpty, type WidgetSpan } from "@/components/ds";
import { callingHours, honestWebsiteText, isCallAction, leadDate, selectCallQueue, websiteVerification } from "@/lib/call-queue";
import { statusLabel, statusTone, suburbOf, useCopy, type Preview, type BoardLead } from "@/lib/leads";

type Previews = ReadonlyMap<number, Pick<Preview, "status">>;
export function LeadCards({ leads, onOpen, now, previews, inset = false }: { leads: BoardLead[]; onOpen: (id: number) => void; now: number; previews?: Previews; /** Inside a widget: a well, never a card in a card. */ inset?: boolean }) {
  const [copied, copy] = useCopy();
  const hours = callingHours(now);
  return <ul className="space-y-3">
    {leads.map(lead => {
      const issue = lead.deal.issues[0];
      const verification = websiteVerification(lead);
      const callable = isCallAction(lead);
      const action = lead.deal.nextAction;
      return <li key={lead.id} className="min-w-0">
        <Surface padding="none" variant={inset ? "inset" : "default"} className={inset ? "min-w-0 rounded-xl p-4 [overflow-wrap:anywhere]" : "min-w-0 rounded-2xl p-5 [overflow-wrap:anywhere]"}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="min-w-0 text-base font-semibold">{lead.name || (lead.source === "google" ? "Google place: open the lead to load its details" : "Name not on file")}</h3>
            <span className="text-sm text-muted-foreground">{suburbOf(lead.area)}</span>
            {/* W-B: "not verified" is the common case, so it's a neutral fact, not an amber alarm on every card. */}
            <Badge tone={verification === "Website verified" ? "success" : "neutral"}>{verification}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {issue ? issue.url && /^https?:\/\//i.test(issue.url) ?
              <a className="ds-interactive inline-flex min-h-10 items-center underline underline-offset-4" href={issue.url} target="_blank" rel="noreferrer">{honestWebsiteText(issue.finding, lead)}</a> : honestWebsiteText(issue.finding, lead) : "Issue evidence not recorded — review the site before calling."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className={lead.nextAt && Date.parse(lead.nextAt) < now && callable ? "text-warn" : "text-foreground"}>{action} · {leadDate(lead.nextAt)} <span className="text-muted-foreground">Sydney</span></span>
            <Badge tone={statusTone(lead.status)}>{statusLabel(lead.status)}</Badge>
            <span>Owner: {lead.owner || "Unassigned"}</span>
            <span className="text-muted-foreground">Last touch: {lead.lastContactAt ? leadDate(lead.lastContactAt) : "None recorded"}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {callable && (hours.open ? <Button asChild variant="outline" className="min-h-10"><a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`}>Call {lead.phone}</a></Button> : <Button variant="outline" className="min-h-10" disabled>Calls closed</Button>)}
            <Button variant="ghost" className="min-h-10" onClick={() => onOpen(lead.id)}>Open lead</Button>
          </div>
          {lead.deal.stuck && <Notice tone="warn" className="mt-2">Stuck · {lead.deal.stuck.days} days in stage. {lead.deal.stuck.action}</Notice>}
          <details className="mt-2 border-t border-border text-xs text-muted-foreground">
            <summary className="ds-interactive min-h-10 cursor-pointer py-3 font-medium">Details</summary>
            <p className="py-2">Preview: {previews?.get(lead.id) ? statusLabel(previews.get(lead.id)!.status) : "Not generated"}</p>
            <div className="mb-2 flex flex-wrap gap-2">
              {lead.phone && <Button variant="outline" className="min-h-10" aria-label={`Copy phone: ${lead.phone}`} onClick={() => copy(`${lead.id}:phone`, lead.phone)}>{copied === `${lead.id}:phone` ? "Copied" : "Copy phone"}</Button>}
              {lead.emails.map(email => <Button key={email} variant="outline" className="min-h-10" aria-label={`Copy email: ${email}`} onClick={() => copy(`${lead.id}:${email}`, email)}>{copied === `${lead.id}:${email}` ? "Copied" : `Copy email: ${email}`}</Button>)}
            </div>
            <dl className="grid gap-2 pb-2 sm:grid-cols-2">
              <div><dt>Score</dt><dd className="ds-num text-foreground">{lead.score}</dd></div>
              <div><dt>Lead ID</dt><dd className="font-mono text-foreground">{lead.id}</dd></div>
              <div><dt>Source / website source</dt><dd>{lead.source || "Unknown"} / {lead.websiteSource || "Unknown"}</dd></div>
              <div><dt>Website check</dt><dd>{lead.websiteCheckedAt ? leadDate(lead.websiteCheckedAt) : "Not recorded"}</dd></div>
              <div><dt>Website on file</dt><dd>{lead.website || verification}</dd></div>
              <div><dt>Pitch / stage</dt><dd>{lead.pitch} / {lead.deal.stage}</dd></div>
            </dl>
            <ul className="space-y-1 pb-2">{lead.reasons.map((r, i) => <li key={i}>{honestWebsiteText(r, lead)}</li>)}</ul>
            <p>Open lead for crawl evidence, audit reports, drafts and activity history.</p>
          </details>
        </Surface>
      </li>;
    })}
  </ul>;
}

export function CallQueue({ leads, now, loading, error, onOpen, previews, span = 2 }: { leads: BoardLead[]; now: number; loading: boolean; error: Error | null; onOpen: (id: number) => void; previews?: Previews; span?: WidgetSpan }) {
  const queue = selectCallQueue(leads, now);
  const hours = callingHours(now);
  // L1 (29 Sep 2026): the first widget on /leads. Calls to make, in one card that fills its row.
  return <Widget span={span} icon={Phone} title="Calls to make" badge={loading || error ? undefined : queue.length} className="min-h-[16rem]" data-order="Due today or overdue · callbacks first, then score and due time">
    {hours.banner && (
      <p className="mb-4 flex items-start gap-2 rounded-xl bg-inset px-4 py-2.5 text-sm text-muted-foreground">
        <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-full bg-muted-foreground" />
        <span><span className="font-medium text-foreground">{hours.banner}</span>. Mon–Fri 9am–8pm · Sat 9am–5pm.</span>
      </p>
    )}
    {loading ? <Skeleton className="h-32 rounded-xl" /> : error ? <Notice tone="danger">Calls to make unavailable. Refresh to retry. {error.message}</Notice> : queue.length ?
      <LeadCards leads={queue} now={now} onOpen={onOpen} previews={previews} inset /> :
      <WidgetEmpty title="No calls due" body="Schedule a call on a lead to add it here." />}
  </Widget>;
}
