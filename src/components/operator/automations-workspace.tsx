// The Automations page: read-only view of Hermes' cron jobs (see scripts/automations.ts) plus
// run-now/pause/resume, allowed only from this PC. Every action is confirmed first: a run can
// message the founders on Telegram, and a pause silently stops a job (e.g. the Jarvis watchdog) until
// someone resumes it (audit F3-14). Paused jobs and test copies sit in their own group (F3-37).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, CheckCircle2, CircleAlert, Loader2, Pause, PauseCircle, Play, RefreshCw, Zap } from "lucide-react";
import { operatorRequest } from "@/lib/operator";
import { Empty, Notice } from "./ui";
import { Button } from "@/components/ui/button";
import { Disclosure, PageFoot, PageHeader, PageSkeleton, Widget, WidgetGrid, type WidgetTone } from "@/components/ds";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fmtDateTime, fmtDay, fmtTime } from "@/lib/format";
import { TriggersPanel } from "./triggers-panel";

type Automation = {
  id: string;
  name: string;
  schedule: string;
  scheduleText: string;
  active: boolean;
  lastRunAt: string | null;
  lastStatus: string;
  nextRunAt: string | null;
  deliver: string;
  mode: string;
  dot: "green" | "amber" | "red";
};

/** A job's state as one short word, never a sentence. */
const DOT_WORD: Record<Automation["dot"], string> = { green: "Healthy", amber: "Paused", red: "Failing" };
const DOT_TONE: Record<Automation["dot"], WidgetTone> = { green: "success", amber: "muted", red: "danger" };

/** Owner-facing names for Hermes' job slugs; unknown jobs get a tidied slug. */
const JOB_NAMES: Record<string, string> = {
  "jarvis-watchdog": "Jarvis watchdog",
  "morning-brief": "Morning brief",
  "founders-weekly": "Founders' weekly digest",
  "site-monitor": "Website monitor",
  "lead-calls": "Today's call list",
  "lead-hunt": "Nightly lead hunt",
  "business-dream": "Business Dream (overnight ideas)",
  "business-dream-test": "Business Dream (test copy)",
  "call-coach-usman": "Call coaching for Usman",
  "daily-log": "Daily log",
  "meeting-sync": "Meeting sync",
  "meeting-sync-test": "Meeting sync (test copy)",
  "os-refresh": "Dashboard data refresh",
};
export function jobName(slug: string) {
  return JOB_NAMES[slug] || slug.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}
/** "telegram:8550678495" → "Telegram"; chat IDs stay out of the page. */
function deliveryText(deliver: string) {
  if (!deliver) return "delivers nowhere";
  if (deliver === "local") return "saved on this PC only (no message sent)";
  const targets = deliver.split(",").map((part) => part.trim().split(":")[0]).filter(Boolean);
  const names = [...new Set(targets.map((t) => (t === "telegram" ? "Telegram" : t === "local" ? "this PC" : t[0].toUpperCase() + t.slice(1))))];
  return `messages ${names.join(" and ")}`;
}
/** A test copy of a job ("business-dream-test"): kept out of the main list unless it's failing. */
export function isTestCopy(slug: string) {
  return /(^|[-_])test$/i.test(slug);
}

/**
 * Main list (problems first, then running jobs) and a separate group for paused jobs and test copies
 * that aren't failing (audit F3-37). Pure; keeps each group's original order within a rank.
 */
export function groupAutomations<T extends { automation: Pick<Automation, "name" | "active" | "dot"> }>(entries: T[]) {
  const RANK: Record<Automation["dot"], number> = { red: 0, amber: 1, green: 2 };
  const ordered = entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => RANK[a.automation.dot] - RANK[b.automation.dot] || a.index - b.index);
  const aside = (e: T) => e.automation.dot !== "red" && (!e.automation.active || isTestCopy(e.automation.name));
  return { main: ordered.filter((e) => !aside(e)), aside: ordered.filter(aside) };
}

type Confirm = { action: "run" | "pause" | "resume"; automation: Automation };

/** What the confirmation says for each action. Pure. */
export function confirmCopy(c: Confirm): { title: string; body: string; action: string } {
  const name = jobName(c.automation.name);
  if (c.action === "run")
    return {
      title: `Run "${name}" now?`,
      body: "This runs the job immediately, on top of its normal schedule. If it delivers to Telegram, it will message the founders now.",
      action: "Run now",
    };
  if (c.action === "pause")
    return {
      title: `Pause "${name}"?`,
      body: `It won't run again until someone resumes it${c.automation.nextRunAt ? ` (its next run was ${when(c.automation.nextRunAt)})` : ""}. Nothing is deleted.`,
      action: "Pause",
    };
  return {
    title: `Resume "${name}"?`,
    body: `It runs on its schedule again (${c.automation.scheduleText}) and ${deliveryText(c.automation.deliver)}.`,
    action: "Resume",
  };
}

type Hunt = { status: "ok" | "partial" | "failed" | "never"; ranAt: string | null; problem?: string; ownerAction?: string };

function when(iso: string | null) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return fmtDateTime(date);
}

/** "7:50 am" and "29 Sept" halves of a run time, for the stat card. */
function clock(iso: string | null) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? fmtTime(d) : "—";
}
function day(iso: string | null) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? fmtDay(d) : "";
}

export function AutomationsWorkspace() {
  const qc = useQueryClient();
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [done, setDone] = useState<Confirm | null>(null);
  const [error, setError] = useState("");

  const query = useQuery<{ automations: Automation[] }>({
    queryKey: ["automations"],
    queryFn: () => operatorRequest<{ automations: Automation[] }>("/automations", undefined, "GET"),
    refetchInterval: 30_000,
    // No retries: with the library default a scheduler that is down showed grey rows for ~8 s (audit P1-4).
    // The 30 s refresh is the retry; the error card appears straight away.
    retry: 0,
  });

  async function act(action: "run" | "pause" | "resume", automation: Automation) {
    setBusyName(automation.name);
    setError("");
    setDone(null);
    try {
      await operatorRequest(`/automations/${action === "run" ? "run" : action}`, { name: automation.name }, "POST");
      setDone({ action, automation: { ...automation, active: action === "pause" ? false : action === "resume" ? true : automation.active } });
      await qc.invalidateQueries({ queryKey: ["automations"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyName(null);
    }
  }

  // Hermes only knows the script exited. The hunt's own report knows whether Google answered.
  const hunt = useQuery<{ hunt?: Hunt }>({
    queryKey: ["leads-summary"],
    queryFn: () => operatorRequest<{ hunt?: Hunt }>("/leads/summary", undefined, "GET"),
    refetchInterval: 60_000,
  }).data?.hunt;
  const automations = (query.data?.automations ?? []).map((automation) => {
    if (automation.name !== "lead-hunt" || !hunt || (hunt.status !== "failed" && hunt.status !== "partial"))
      return { automation, problem: undefined as string | undefined, ownerAction: undefined as string | undefined };
    return {
      automation: { ...automation, dot: "red" as const, lastStatus: hunt.status === "failed" ? "failed" : "partly failed" },
      problem: hunt.problem,
      ownerAction: hunt.ownerAction,
    };
  });

  const groups = groupAutomations(automations);
  const count = (dot: Automation["dot"]) => automations.filter(({ automation }) => automation.dot === dot).length;
  const failing = count("red");
  const healthy = count("green");
  const paused = count("amber");
  // The soonest next run among running jobs: the page's "what happens next".
  const upcoming = automations
    .map(({ automation }) => automation)
    .filter((a) => a.active && a.nextRunAt && !Number.isNaN(Date.parse(a.nextRunAt)))
    .sort((x, y) => Date.parse(x.nextRunAt!) - Date.parse(y.nextRunAt!))[0];

  function renderRow({ automation, problem, ownerAction }: (typeof groups.main)[number]) {
    const busy = busyName === automation.name;
    return (
      <Widget
        key={automation.id}
        icon={Zap}
        title={<span title={automation.name}>{jobName(automation.name)}</span>}
        badge={automation.dot === "green" ? undefined : DOT_WORD[automation.dot]}
        value={automation.active ? clock(automation.nextRunAt) : "Paused"}
        tone={automation.dot === "red" ? "danger" : automation.active ? "default" : "muted"}
        data-job={automation.name}
        data-state={automation.dot}
        action={
          <>
            <Button variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={busyName !== null} onClick={() => setConfirm({ action: "run", automation })}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} Run now
            </Button>
            {automation.active ? (
              <Button variant="ghost" size="sm" className="h-9 rounded-full px-3" disabled={busyName !== null} onClick={() => setConfirm({ action: "pause", automation })}>
                <Pause size={15} /> Pause
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={busyName !== null} onClick={() => setConfirm({ action: "resume", automation })}>
                <Play size={15} /> Resume
              </Button>
            )}
          </>
        }
      >
        <p className="text-sm leading-snug text-muted-foreground">
          {automation.scheduleText}
          {automation.active && automation.nextRunAt ? ` · next ${when(automation.nextRunAt)}` : ""}
        </p>
        {problem && (
          <p className="mt-3 text-sm" role="alert">
            <span className="font-medium text-danger">{problem}.</span>{" "}
            {ownerAction && <span className="text-foreground">What to do: {ownerAction}</span>}
          </p>
        )}
        <Disclosure className="mt-2 -mb-2" triggerClassName="-mx-3" summary={<span className="text-muted-foreground">Details</span>}>
          <dl className="grid grid-cols-1 gap-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Last run</dt>
              <dd className="text-foreground">
                {when(automation.lastRunAt)}
                {automation.lastStatus ? ` (${automation.lastStatus})` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Next run</dt>
              <dd className="text-foreground">{automation.active ? when(automation.nextRunAt) : "— (paused)"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Delivers</dt>
              <dd className="text-foreground">{deliveryText(automation.deliver)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Runs as</dt>
              <dd className="text-foreground">
                {automation.mode === "no-agent" ? "no AI (script only)" : "uses the AI agent"} · <span className="font-mono text-sm">{automation.name}</span>
              </dd>
            </div>
          </dl>
        </Disclosure>
      </Widget>
    );
  }

  return (
    <div className="op-page">
      <PageHeader
        title="Automations"
        className="mb-3"
        actions={
          <Button variant="outline" className="h-10 rounded-full px-4" disabled={query.isFetching} aria-busy={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCw size={15} className={query.isFetching ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden="true" /> {query.isFetching ? "Refreshing" : "Refresh"}
          </Button>
        }
      />

      {error && <Notice error>{error}</Notice>}
      {done && done.action !== "run" && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-success-soft px-5 py-4 text-base" data-testid="automations-done">
          <span>
            {done.action === "pause" ? "Paused" : "Resumed"} "{jobName(done.automation.name)}".
          </span>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            disabled={busyName !== null}
            onClick={() => void act(done.action === "pause" ? "resume" : "pause", done.automation)}
          >
            Undo
          </Button>
        </div>
      )}
      {done && done.action === "run" && (
        <div role="status" className="mb-4 rounded-2xl bg-success-soft px-5 py-4 text-base">
          Started "{jobName(done.automation.name)}". Its result shows under Last run when it finishes.
        </div>
      )}
      {query.isError && query.data && <Notice error>{String((query.error as Error).message).replace(/[.\s]+$/, "")}. Showing the last jobs read.</Notice>}

      {query.isLoading ? (
        <PageSkeleton variant="list" rows={5} label="Loading scheduled jobs" />
      ) : query.isError && !query.data ? (
        // The scheduler didn't answer: say so straight away. "No scheduled jobs found" would claim the jobs are gone.
        <Empty title="Couldn't reach the scheduler">
          <span role="alert">{String((query.error as Error).message).replace(/[.\s]+$/, "")}. </span>
          The jobs are unknown, not missing. Check that the Hermes gateway is running, then press Refresh.
        </Empty>
      ) : !automations.length ? (
        <Empty title="No scheduled jobs found">Hermes isn't reporting any cron jobs right now. Check that the Hermes gateway is running.</Empty>
      ) : (
        <>
          {/* Owner direction (29 Sep): the Inbox's structure. One plain headline, four equal widgets
              across the width with one big number and one line each, then one widget per job. */}
          <p className="mb-6 text-xl font-semibold text-foreground" data-testid="automations-headline">
            {failing
              ? `${failing} job${failing === 1 ? " is" : "s are"} failing. Fix ${failing === 1 ? "it" : "them"} first: ${failing === 1 ? "it's" : "they're"} at the top with what to do.`
              : healthy
                ? `All ${healthy} running job${healthy === 1 ? " is" : "s are"} healthy.${upcoming ? ` Next up: ${jobName(upcoming.name)}, ${when(upcoming.nextRunAt)}.` : ""}`
                : "Every job is paused. Nothing runs until one is resumed."}
          </p>
          <WidgetGrid mobile={2} className="mb-6 lg:mb-8" aria-label="Job summary">
            <Widget icon={CheckCircle2} title="Healthy" value={healthy} line="healthy, running on schedule" />
            <Widget icon={CircleAlert} title="Failing" value={failing} tone={failing ? "danger" : "default"} line={failing ? "failing, need you" : "failing"} />
            <Widget icon={PauseCircle} title="Paused" value={paused} line="paused, won't run until resumed" />
            <Widget
              icon={AlarmClock}
              title="Next run"
              value={upcoming ? clock(upcoming.nextRunAt) : null}
              line={upcoming ? `next: ${jobName(upcoming.name)}, ${day(upcoming.nextRunAt)}` : "nothing scheduled next"}
            />
          </WidgetGrid>
          <WidgetGrid aria-label="Scheduled jobs">{groups.main.map(renderRow)}</WidgetGrid>
          {groups.aside.length > 0 && (
            <div className="mt-6 rounded-2xl border border-border px-2 py-1" data-testid="automations-aside">
              <Disclosure summary={<span className="text-base font-medium">Paused and test copies · {groups.aside.length}</span>}>
                <WidgetGrid className="pt-2">{groups.aside.map(renderRow)}</WidgetGrid>
              </Disclosure>
            </div>
          )}
          <PageFoot>Hermes' cron jobs, refreshed every 30 seconds. Run now, pause and resume work from this PC only, and each asks first.</PageFoot>
        </>
      )}
      <TriggersPanel />
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm ? confirmCopy(confirm).title : ""}</AlertDialogTitle>
            <AlertDialogDescription>{confirm ? confirmCopy(confirm).body : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) void act(confirm.action, confirm.automation);
                setConfirm(null);
              }}
            >
              {confirm ? confirmCopy(confirm).action : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
