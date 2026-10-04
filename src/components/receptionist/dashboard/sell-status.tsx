// Top of the Receptionist dashboard: is it safe to sell (from /__receptionist), the flagged calls
// to follow up, and the go-live gates. Kept until the recorded go-live tests pass (owner, 28 Sep).
// Metadata only: flags, consequence, time, masked caller and the Retell link; never transcript text.
//
// D1 (29 Sep, owner): "easy to read, cool on the eyes, smooth and circular", then "the design is
// good, but the structure, the size, and a lot of blah blah". Four big tiles (status, calls today,
// flagged, go-live), one next step, the rest in tabs. Short labels in the reading path; provenance
// behind (i). Nothing true is removed; red is kept for the verdict and truly urgent calls.
import { useState, type MouseEvent, type ReactNode } from "react";
import { ExternalLink, Flag, PhoneCall } from "lucide-react";
import { usePageContext } from "@/components/shell/page-context";
import { AttentionCard, Badge, Button, ChecklistRow, Disclosure, InfoTip, NextStep, Notice, Section, Skeleton, SummaryTile, VerdictCard, WidgetGrid, fmtRelative, type AttentionSeverity, type ChecklistStatus, type SummaryTone } from "@/components/ds";
import { FLAG_LABEL, type Incident, type ReceptionistSnapshot, type Verdict } from "@/lib/receptionist";
import { qaLabel } from "../../../../scripts/receptionist/qa-codes";
import { callTime, maskedCaller } from "../format";
import { GATES_SECTION_ID } from "../gates";
import { FollowUpDialog } from "../incidents";
import { attributionNote, extraQaCodes, type SellSource } from "./sell-exceptions";
import { fmtDateTime } from "@/lib/format";

/** "Agency feed connected, read 2 min ago" / "Agency feed unavailable (reason), last good read …". */
export function feedReadLine(snapshot: ReceptionistSnapshot): string | null {
  // An older/partial snapshot without the feed block: say nothing rather than guess.
  if (!snapshot.feed) return null;
  const read = snapshot.feedRead;
  const at = read?.at ?? snapshot.generatedAt;
  if (snapshot.feed.ok) return `Agency feed connected, read ${fmtRelative(at)}`;
  const lastOk = read?.lastOkAt ? `last good read ${fmtRelative(read.lastOkAt)}` : "no successful read yet";
  return `Agency feed unavailable (${snapshot.feed.reason}), read ${fmtRelative(at)}, ${lastOk}`;
}

/** A local follow-up can only be recorded against a Retell call id. */
const canFollowUp = (incident: Incident) => /^call_[A-Za-z0-9]{6,64}$/.test(incident.callId) && !incident.followedUp;

export const FLAGGED_SECTION_ID = "rx-flagged-calls";
export const REQUIREMENTS_ID = "rx-requirements";

/** The dashboard's tabs (index.tsx); tiles and the next step open them. */
export type RxTab = "overview" | "calls" | "golive" | "clients" | "economics" | "health";
export type OpenTab = (tab: RxTab, anchor?: string) => void;

/**
 * Scroll to a section and move focus to its heading (keyboard users land where they asked to go).
 * Smooth only when the viewer hasn't asked for reduced motion.
 */
export function jumpTo(id: string, event?: MouseEvent) {
  const el = typeof document !== "undefined" ? document.getElementById(id) : null;
  if (!el) return;
  event?.preventDefault();
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  const heading = el.matches("h2, h3") ? el : el.querySelector<HTMLElement>("h2, h3");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

/** The requirements behind the verdict, counted the way the old "Required to sell · N of M met" line did. */
export function requirementCounts(verdict: Verdict) {
  const required = (verdict.checks ?? []).filter((c) => !c.informational);
  const met = required.filter((c) => c.ok).length;
  const unknown = required.filter((c) => !c.ok && c.unknown).length;
  return { total: required.length, met, unknown, open: required.length - met };
}

/** "Not safe to sell" → "Not safe" for the big tile; the full decision stays in its accessible name. */
export function shortDecision(decision: string): string {
  if (/^not safe to sell$/i.test(decision)) return "Not safe";
  if (/^safe to sell$/i.test(decision)) return "Safe";
  if (/^(sell )?status unknown$/i.test(decision)) return "Unknown";
  return decision;
}

/**
 * The verdict's facts as short chips ("Draft v0", "1 call today", "0/5 gates"). Only known server
 * phrasings are shortened; anything else is shown as written. The full fact stays in the title.
 */
export function shortFact(fact: string): string {
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^Answering on unpublished draft(?: (v\S+))?$/, (m) => (m[1] ? `Draft ${m[1]}` : "Unpublished draft")],
    [/^Answering on published (v\S+|agent)$/, (m) => (m[1] === "agent" ? "Published" : `Published ${m[1]}`)],
    [/^(\d+) real calls? today · (none flagged|\d+ flagged)$/, (m) => `${m[1]} ${m[1] === "1" ? "call" : "calls"} today · ${m[2]}`],
    [/^No real calls today$/, () => "No calls today"],
    [/^(\d+) of (\d+) gates passed(?: · (\d+) failing)?$/, (m) => `${m[1]}/${m[2]} gates${m[3] ? ` · ${m[3]} failing` : ""}`],
    [/^(\d+) callers? may be expecting a booking or text$/, (m) => `${m[1]} may expect a booking or text`],
    [/^(\d+) flagged calls? to follow up$/, (m) => `${m[1]} to follow up`],
  ];
  for (const [re, fn] of rules) {
    const m = re.exec(fact);
    if (m) return fn(m);
  }
  return fact;
}

const checkStatus = (check: NonNullable<Verdict["checks"]>[number]): ChecklistStatus =>
  check.informational ? "info" : check.unknown ? "unknown" : check.ok ? "met" : "not-met";

/** The requirements: open ones first, informational next, the met ones folded into one line. */
function Requirements({ verdict }: { verdict: Verdict }) {
  const checks = verdict.checks ?? [];
  const { total, met } = requirementCounts(verdict);
  const row = (check: (typeof checks)[number]) => (
    <ChecklistRow
      key={check.id}
      status={checkStatus(check)}
      label={check.label}
      detail={check.detail}
      data-sell-check={check.id}
      data-ok={check.ok}
      statusTitle={check.informational ? "Shown for the owner; doesn't decide the verdict" : check.unknown ? "Couldn't be evaluated: its source wasn't read" : undefined}
    />
  );
  const open = checks.filter((c) => !c.informational && !c.ok);
  const info = checks.filter((c) => c.informational);
  const done = checks.filter((c) => !c.informational && c.ok);
  return (
    <div id={REQUIREMENTS_ID} className="scroll-mt-6 px-2 sm:px-3">
      <h3 className="flex items-baseline justify-between gap-3 pt-3 text-base font-medium text-foreground">
        Requirements to sell <span className="ds-num text-sm font-normal text-muted-foreground">{met} of {total} met</span>
      </h3>
      <ul className="divide-y divide-border">
        {open.map(row)}
        {info.map(row)}
      </ul>
      {done.length > 0 && (
        <Disclosure id="rx-requirements-met" className="-mx-3 mt-1" summary={<span className="text-muted-foreground">{done.length} met</span>}>
          <ul className="divide-y divide-border">{done.map(row)}</ul>
        </Disclosure>
      )}
    </div>
  );
}

/** Where the verdict's next step is done on this page: the flagged calls, else the gates. */
function nextTarget(data: ReceptionistSnapshot): { tab: RxTab; anchor: string; label: string } {
  if (data.incidents.length || data.awaitingRetest?.length) return { tab: "calls", anchor: FLAGGED_SECTION_ID, label: "Open flagged calls" };
  return { tab: "golive", anchor: data.readiness.blockers.some((b) => b.state !== "pass") ? GATES_SECTION_ID : REQUIREMENTS_ID, label: "Open go-live" };
}

const SOURCE = "/__receptionist (Retell calls, flags and go-live gates)";

/** The source note for the sell status: behind (i), never in the reading path. */
function SellSourceNote({ data }: { data: ReceptionistSnapshot }) {
  const feedLine = feedReadLine(data);
  return (
    <InfoTip label="Sources" align="start">
      <span title={fmtDateTime(new Date(data.generatedAt), { year: true })}>
        Source: {SOURCE} · Updated {fmtRelative(data.generatedAt)}
        {/* The verdict's OWN agency-feed read and its time (RX-1): the dashboard reads the feed separately. */}
        {feedLine && <>{" · "}{feedLine}</>}
      </span>
    </InfoTip>
  );
}

/** The sell verdict with its requirements (Go-live tab). Loading and failure are "unknown", never green. */
export function SellVerdict({ sell, onRetry }: { sell: SellSource; onRetry?: () => void }) {
  if (sell.isLoading && !sell.data)
    return <Skeleton className="h-56 w-full rounded-2xl animate-none" aria-label="Loading sell status" />;
  if (!sell.data)
    return (
      <VerdictCard
        tone="neutral"
        titleId="rx-sell-verdict"
        title="Sell status unknown"
        why={<>The receptionist status (/__receptionist) couldn't be read{sell.error ? `: ${sell.error.message}` : ""}. Don't treat the line as safe to sell until it can be.</>}
        primary={onRetry && <Button variant="outline" className="h-10 rounded-full px-5" onClick={onRetry}>Retry</Button>}
      />
    );
  const data = sell.data;
  const { verdict } = data;
  const counts = requirementCounts(verdict);
  const hasChecks = (verdict.checks ?? []).length > 0;
  const why = !hasChecks
    ? null
    : counts.open === 0
      ? `All ${counts.total} requirements met.`
      : `${counts.open} of ${counts.total} requirements not met${counts.unknown ? ` (${counts.unknown} unknown)` : ""}.`;
  // L10 (29 Sep 2026): a plain big number, not a ring. The ring drew the same fraction the number states.
  const tally = hasChecks && (
    <p className="text-left sm:text-right" data-requirements-tally="">
      <span className="ds-num block text-4xl font-semibold leading-none tracking-[-0.02em] text-foreground sm:text-5xl">{counts.met}/{counts.total}</span>
      <span className="mt-1 block text-sm text-muted-foreground">requirements met</span>
    </p>
  );
  return (
    <VerdictCard
      tone={verdict.tone}
      titleId="rx-sell-verdict"
      title={verdict.decision}
      why={why}
      facts={verdict.facts.map((f) => <span key={f} title={f}>{shortFact(f)}</span>)}
      ring={tally}
      primary={verdict.next ? <p className="text-base text-foreground"><span className="font-medium">Next:</span> {verdict.next}</p> : undefined}
      secondary={<SellSourceNote data={data} />}
    >
      {hasChecks && <Requirements verdict={verdict} />}
    </VerdictCard>
  );
}

/** The page-context label for a call: time and masked caller only (never transcript text). */
export const incidentLabel = (incident: Incident) => `Flagged call ${callTime(incident.startedAt)} · ${maskedCaller(incident.from)}`;
export const incidentAnchor = (incident: Incident) => `rx-call-${incident.callId.replace(/[^A-Za-z0-9_-]/g, "")}`;

/**
 * Truly urgent: life-safety or urgent language with no 000 advice (a Retell flag or the matching
 * production-QA code). Only these take the danger colour; every other flagged call is "Follow up".
 */
export function isUrgentIncident(incident: Incident): boolean {
  return incident.flags.some((f) => f === "URGENT_NO_000" || f === "DANGER_LANGUAGE") || (incident.qaCodes ?? []).includes("LIFE_SAFETY_NOT_ROUTED");
}

const sourceText = (incident: Incident) =>
  !incident.sources?.length
    ? null
    : incident.sources.includes("retell") && incident.sources.includes("production QA")
      ? "Retell flags + production QA"
      : incident.sources.includes("production QA")
        ? "production QA"
        : "Retell flags";

/**
 * One flagged call in one line: its first label as the summary (e.g. "Urgent, no 000"), the time
 * and masked caller, and its actions. The consequence, the other labels, the source, client and QA
 * review are behind "Details". Each label appears once (RX-10).
 */
export function IncidentCard({ incident, retest = false, anchor = true, onFocus }: { incident: Incident; retest?: boolean; anchor?: boolean; onFocus?: (callId: string) => void }) {
  const attribution = attributionNote(incident);
  const severity: AttentionSeverity = retest ? "waiting" : isUrgentIncident(incident) ? "urgent" : incident.qaCritical ? "critical" : "attention";
  // Urgent labels first, so an urgent call's summary says why it is urgent.
  const labels = [
    ...incident.flags.map((flag) => ({ key: flag, text: FLAG_LABEL[flag] ?? flag, title: undefined as string | undefined, urgent: flag === "URGENT_NO_000" || flag === "DANGER_LANGUAGE" })),
    ...extraQaCodes(incident).map((code) => ({ key: `qa-${code}`, text: qaLabel(code), title: `Production QA code ${code}`, urgent: code === "LIFE_SAFETY_NOT_ROUTED" })),
  ].sort((a, b) => Number(b.urgent) - Number(a.urgent));
  const [first, ...rest] = labels;
  const source = sourceText(incident);
  const more = rest.length ? ` · ${rest.length} more ${rest.length === 1 ? "flag" : "flags"}` : "";
  return (
    <AttentionCard
      id={anchor ? incidentAnchor(incident) : undefined}
      onFocusCapture={() => onFocus?.(incident.callId)}
      onPointerDown={() => onFocus?.(incident.callId)}
      data-flagged-call={anchor && !retest ? incident.callId : undefined}
      data-retest-call={anchor && retest ? incident.callId : undefined}
      data-overview-call={anchor ? undefined : incident.callId}
      severity={severity}
      severityText={retest ? "Awaiting retest" : undefined}
      title={first ? <span title={first.title}>{first.text}</span> : "Flagged call"}
      meta={
        <>
          {callTime(incident.startedAt)} · {maskedCaller(incident.from)}
          {incident.followedUp && <span className="block">Followed up by {incident.followedUp.by} · {fmtRelative(incident.followedUp.at)} — {retest ? "awaiting recorded retests" : "production QA review still open"}</span>}
        </>
      }
      actions={
        <>
          {incident.retellUrl && (
            <Button variant="ghost" size="sm" className="h-10 rounded-full px-4" asChild>
              <a href={incident.retellUrl} target="_blank" rel="noreferrer">Open in Retell <ExternalLink aria-hidden="true" /></a>
            </Button>
          )}
          {canFollowUp(incident) && <FollowUpDialog incident={incident} />}
        </>
      }
      detailsLabel={`Details${more}`}
      details={
        <div className="space-y-3 pl-5">
          <p className="max-w-[70ch] text-sm leading-relaxed text-foreground">{incident.consequence}</p>
          {rest.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Other flags on this call">
              {rest.map((l) => <li key={l.key}><Badge tone="neutral" title={l.title}>{l.text}</Badge></li>)}
            </ul>
          )}
          <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[max-content_1fr]">
            {source && <><dt className="text-muted-foreground">Flagged by</dt><dd className="text-foreground">{source}</dd></>}
            {attribution && <><dt className="text-muted-foreground">Client</dt><dd className="text-foreground">{attribution.replace(/^client: /, "")}</dd></>}
            {incident.qaCritical && <><dt className="text-muted-foreground">Production QA</dt><dd className="text-foreground">Critical, not yet reviewed</dd></>}
            {incident.qaCodes?.length ? <><dt className="text-muted-foreground">QA review</dt><dd className="text-foreground">{incident.qaReview ? incident.qaReview.toLowerCase().replace(/_/g, " ") : "status not reported"}</dd></> : null}
            {!incident.retellUrl && <><dt className="text-muted-foreground">Retell</dt><dd className="text-foreground">No Retell call id in the feed, so it can't be opened or marked followed up here</dd></>}
          </dl>
        </div>
      }
    />
  );
}

const FLAGGED_NOTE = "Real calls flagged by Retell transcript checks or MU-Receptionist production QA (every code, attributed to a client or not), one card per call. Metadata only; open the call in Retell for detail.";

/** Every flagged call (Calls tab). */
export function FlaggedCalls({ incidents, awaitingRetest = [], callsUnread = null, onFocusCall }: { incidents: Incident[]; awaitingRetest?: Incident[]; callsUnread?: string | null; onFocusCall?: (callId: string) => void }) {
  const count = incidents.length + awaitingRetest.length;
  return (
    <Section
      id={FLAGGED_SECTION_ID}
      className="scroll-mt-6"
      title={
        <span className="inline-flex items-center gap-3">
          Flagged calls
          {(count > 0 || !callsUnread) && (
            <span className="ds-num grid h-7 min-w-7 place-items-center rounded-full bg-inset px-2 text-sm font-semibold text-foreground">{count}<span className="sr-only"> {count === 1 ? "call" : "calls"}</span></span>
          )}
        </span>
      }
      actions={<InfoTip label="About flagged calls">{FLAGGED_NOTE}</InfoTip>}
    >
      {callsUnread && (
        <Notice tone="warn" title="Unknown · couldn't read calls" className="mb-4 rounded-2xl">
          {callsUnread}. Flagged calls from Retell can't be listed, so this can't say none are open.
        </Notice>
      )}
      {incidents.length === 0 ? (
        callsUnread ? null : <p className="rounded-2xl bg-inset px-5 py-4 text-base text-muted-foreground">No flagged calls waiting for follow-up.</p>
      ) : (
        <ul className="space-y-3">
          {incidents.map((incident) => <IncidentCard key={incident.callId} incident={incident} onFocus={onFocusCall} />)}
        </ul>
      )}
      {awaitingRetest.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-3 text-base font-medium text-foreground">Awaiting retest <span className="font-normal text-muted-foreground">· still blocks selling</span></h3>
          <ul className="space-y-3">
            {awaitingRetest.map((incident) => <IncidentCard key={incident.callId} incident={incident} retest onFocus={onFocusCall} />)}
          </ul>
        </div>
      )}
    </Section>
  );
}

/** Overview: the top two things that need attention, and a way to the rest. */
export function TopAttention({ sell, onOpen }: { sell: SellSource; onOpen: OpenTab }) {
  const data = sell.data;
  if (!data) return null;
  const all = [...data.incidents.map((i) => ({ i, retest: false })), ...(data.awaitingRetest ?? []).map((i) => ({ i, retest: true }))];
  const callsUnread = data.calls.ok ? null : data.calls.reason;
  return (
    <section aria-labelledby="rx-attention-title">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="rx-attention-title" className="text-lg font-semibold tracking-[-0.01em] text-foreground">Needs attention</h2>
        {all.length > 2 && (
          <Button variant="ghost" className="h-10 rounded-full px-4" onClick={() => onOpen("calls", FLAGGED_SECTION_ID)}>See all {all.length}</Button>
        )}
      </div>
      {callsUnread && <Notice tone="warn" title="Unknown · couldn't read calls" className="mb-3 rounded-2xl">{callsUnread}.</Notice>}
      {all.length === 0
        ? (callsUnread ? null : <p className="rounded-2xl bg-inset px-5 py-4 text-base text-muted-foreground">No flagged calls waiting for follow-up.</p>)
        : <ul className="space-y-3">{all.slice(0, 2).map(({ i, retest }) => <IncidentCard key={i.callId} incident={i} retest={retest} anchor={false} />)}</ul>}
    </section>
  );
}

const VERDICT_TONE: Record<"ok" | "warn" | "bad" | "neutral", SummaryTone> = { ok: "success", warn: "warn", bad: "danger", neutral: "muted" };

const IconMark = ({ children }: { children: ReactNode }) => (
  <span aria-hidden="true" className="grid size-11 place-items-center rounded-full bg-inset text-muted-foreground">{children}</span>
);

/** The four big tiles: status, calls today, flagged, go-live. Each opens its tab. */
export function SummaryTiles({ sell, onOpen, controls }: { sell: SellSource; onOpen: OpenTab; controls?: (tab: RxTab) => string }) {
  const data = sell.data;
  const loading = sell.isLoading && !data;
  const counts = data ? requirementCounts(data.verdict) : null;
  const hasChecks = !!data && (data.verdict.checks ?? []).length > 0;
  const today = data?.calls.ok ? data.calls.windows[0] : null;
  const flagged = data ? data.incidents.length + (data.awaitingRetest?.length ?? 0) : null;
  const urgent = data ? data.incidents.filter(isUrgentIncident).length : 0;
  const retests = data?.awaitingRetest?.length ?? 0;
  const blockers = data?.readiness.blockers ?? [];
  const passed = blockers.filter((b) => b.state === "pass").length;
  const failing = blockers.filter((b) => b.state === "fail").length;
  const callsUnread = data && !data.calls.ok ? data.calls.reason : null;
  const dash = loading ? "…" : "—";
  const flaggedUnknown = flagged === null || (!!callsUnread && flagged === 0);
  return (
    // L1 (29 Sep 2026): the shared widget grid (full width, even gutters, equal heights, 2-up on a phone).
    <WidgetGrid mobile={2} data-rx-tiles="">
      <SummaryTile
        // On a phone the verdict and the gates take a full row each (a big word never breaks mid-word).
        className="col-span-2 md:col-span-1"
        data-tile="status"
        label="Safe to sell?"
        value={data ? <span title={data.verdict.decision}>{shortDecision(data.verdict.decision)}<span className="sr-only"> ({data.verdict.decision})</span></span> : dash}
        valueTone={data ? VERDICT_TONE[data.verdict.tone] : "muted"}
        sub={data ? (hasChecks && counts ? `${counts.met} of ${counts.total} met` : "No checks reported") : loading ? "Loading" : "Couldn't read status"}
        subTone={!data && !loading ? "warn" : "muted"}
        onClick={() => onOpen("golive", REQUIREMENTS_ID)}
        controls={controls?.("golive")}
      />
      <SummaryTile
        data-tile="calls"
        label="Calls today"
        value={today ? today.count : dash}
        valueTone={today ? "default" : "muted"}
        sub={today ? `${today.answered} answered` : callsUnread ? "Unknown · calls unread" : loading ? "Loading" : "Unknown"}
        subTone={callsUnread ? "warn" : "muted"}
        visual={<IconMark><PhoneCall className="size-5" strokeWidth={1.75} /></IconMark>}
        onClick={() => onOpen("calls")}
        controls={controls?.("calls")}
      />
      {/* R11: with the calls unreadable, "Flagged" would say the same "Unknown · calls unread" as "Calls today" (and "Needs attention" below). */}
      {!(flaggedUnknown && callsUnread) && <SummaryTile
        data-tile="flagged"
        label="Flagged"
        value={flaggedUnknown ? dash : flagged}
        valueTone={flaggedUnknown || !flagged ? "muted" : "default"}
        sub={
          flagged === null ? (loading ? "Loading" : "Unknown")
            : flaggedUnknown ? "Unknown · calls unread"
            : urgent ? `${urgent} urgent${retests ? ` · ${retests} retest` : ""}`
            : flagged ? `To follow up${retests ? ` · ${retests} retest` : ""}` : "None open"
        }
        subTone={urgent ? "danger" : flaggedUnknown && callsUnread ? "warn" : "muted"}
        visual={<IconMark><Flag className="size-5" strokeWidth={1.75} /></IconMark>}
        onClick={() => onOpen("calls", FLAGGED_SECTION_ID)}
        controls={controls?.("calls")}
      />}
      <SummaryTile
        className="col-span-2 md:col-span-1"
        data-tile="golive"
        label="Go-live gates"
        value={data ? `${passed}/${blockers.length}` : dash}
        valueTone={data ? "default" : "muted"}
        sub={data ? (failing ? `${failing} failing` : passed === blockers.length ? "All passed" : `${passed} of ${blockers.length} passed`) : loading ? "Loading" : "Unknown"}
        subTone={failing ? "warn" : "muted"}
        onClick={() => onOpen("golive", GATES_SECTION_ID)}
        controls={controls?.("golive")}
      />
    </WidgetGrid>
  );
}

/** One sentence and one gold button: the verdict's next step, or a retry when the status is unread. */
export function NextStepBar({ sell, onOpen, onRetry, className }: { sell: SellSource; onOpen: OpenTab; onRetry?: () => void; className?: string }) {
  const data = sell.data;
  if (!data) {
    if (sell.isLoading) return null;
    return (
      <NextStep className={className} action={onRetry && <Button variant="accent" className="h-11 rounded-full px-6 text-base" onClick={onRetry}>Retry</Button>}>
        Sell status couldn't be read. Don't sell until it can be.
      </NextStep>
    );
  }
  const target = nextTarget(data);
  return (
    <NextStep className={className} action={<Button variant="accent" className="h-11 rounded-full px-6 text-base" onClick={() => onOpen(target.tab, target.anchor)}>{target.label}</Button>}>
      {data.verdict.next || "Nothing to do right now"}
    </NextStep>
  );
}

/** Page context for Jarvis (src/lib/page-context.ts): the calls on screen, the one last touched, the source's honest state. */
export function useSellPageContext(sell: SellSource) {
  const data: ReceptionistSnapshot | undefined = sell.data;
  const [focusedCall, setFocusedCall] = useState<string | null>(null);
  const calls = data ? [...data.incidents, ...(data.awaitingRetest ?? [])] : [];
  const item = (i: Incident) => ({ kind: "call" as const, id: i.callId, label: incidentLabel(i), to: "/receptionist", focus: incidentAnchor(i), source: "/__receptionist" });
  const focused = calls.find((i) => i.callId === focusedCall);
  usePageContext("receptionist:sell-status", {
    visible: calls.map(item),
    focused: focused ? item(focused) : null,
    sources: [
      {
        id: "receptionist-status",
        label: "Receptionist sell status and flagged calls",
        state: !data ? (sell.isLoading ? "unknown" : "failed") : sell.error ? "stale" : data.calls.ok ? "live" : "stale",
        source: "/__receptionist (Retell calls, flags, go-live gates)",
        lastSuccess: data?.generatedAt ?? null,
        ...(sell.error ? { reason: sell.error.message } : data && !data.calls.ok ? { reason: data.calls.reason } : {}),
      },
    ],
  });
  return setFocusedCall;
}
