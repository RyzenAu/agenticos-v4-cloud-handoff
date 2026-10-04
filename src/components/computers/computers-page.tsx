// Computers (System): your PCs, and the shared computers agents work on. Everything shown is something a
// service reported; what isn't reported says so. Buttons appear only for what the computer's state and its
// control lease allow this person to do.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { streamRefetchInterval, useStreamInvalidate } from "@/lib/use-activity";
import { Cloud, Monitor } from "lucide-react";
import { Badge, Button, ConnectionState, Disclosure, EmptyState, Notice, PageHeader, Section, Surface, type ConnectionPhase, type Tone, Details } from "@/components/ds";
import {
  STATE_WORD,
  computerAction,
  controllerText,
  hostProblem,
  personalFromDevice,
  readComputers,
  readHosts,
  screenFailing,
  screenSentence,
  stateChip,
  viewActions,
  type ComputerAction,
  type ComputerView,
  type PersonalPc,
} from "@/lib/computers-client";
import { AddComputer } from "@/components/computers/add-computer";
import { AssignForm, ComputerDetails, ComputerWork, WaitingNotice } from "@/components/agents/workspace-parts";
import { JOB_STATE_WORD, agentDisplay, computerSummary, jobIsFinished, readComputerJob } from "@/lib/agent-workspace";
import { useDevices, useMe } from "@/lib/use-devices";
import { PreviewPanel } from "@/components/agents/computer/viewer";
import { botForComputer, readBots } from "@/components/agents/workspace/bots";
import { screenPhase, type ScreenState } from "@/components/agents/computer/viewer-state";

// The viewer pieces moved to components/agents/computer/ (the Agents workspace's Computer tab uses them too); these names stay importable from here.
export { LiveViewer, PreviewPanel, SnapshotPanel } from "@/components/agents/computer/viewer";
export { parseViewerMessage, screenPhase, viewerStatusText, type ScreenState, type ViewerMessage } from "@/components/agents/computer/viewer-state";

const TONE: Record<string, Tone> = { online: "success", busy: "info", starting: "info", asleep: "neutral", offline: "neutral", failed: "danger" };
const ACTION_LABEL: Record<ComputerAction, string> = { preview: "Preview", "take-control": "Take control", "request-control": "Request control", return: "Return to agent", stop: "Stop", start: "Start", "restart-display": "Restart display", "take-here": "Take them here" };
const pct = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)}%` : "not reported");
const mb = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)} MB` : "not reported");
const nameOf = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** Pure: the empty state only points at a control that is really on the page. */
export function emptyComputersBody(canAdd: boolean): string {
  return canAdd ? "Use Add a shared computer above to create one. It then appears here with its job and who controls it." : "None can be added until this hub has a computer host. They appear here, with their job and who controls them, once they exist.";
}

/** Pure: the "Doing" line. A job, a paused job waiting for the controls back, or nothing. */
export function doingText(c: Pick<ComputerView, "assigned" | "paused">, agentName: (id: string) => string = agentDisplay): string {
  if (c.assigned) return `${c.assigned.title || c.assigned.jobId} · ${agentName(c.assigned.agent)}`;
  if (c.paused) return `Paused: ${agentName(c.paused.agent)}'s job is waiting for the controls back`;
  return "Nothing assigned";
}

/** The newest job on this computer (the one running, the paused one, or the last one), re-read every 2 s while it runs. */
export function useComputerJob(c: Pick<ComputerView, "assigned" | "paused" | "lastJob">) {
  const id = c.assigned?.jobId ?? c.paused?.jobId ?? c.lastJob?.jobId ?? null;
  const q = useQuery({
    queryKey: ["computer-job", id],
    queryFn: () => readComputerJob(id!),
    enabled: !!id,
    staleTime: 1_000,
    refetchInterval: (query) => (query.state.data && jobIsFinished(query.state.data.state) ? false : 2_000),
    refetchIntervalInBackground: false,
    retry: false,
  });
  return id ? q.data ?? null : null;
}

export function ComputerRow({ c, me, nameOf: nameFor = nameOf, onAct, busy, onNote, workspaceBotId, agentName = agentDisplay }: { c: ComputerView; me: string | null; /** A bot's name for an agent id (the paused job is the bot's, not "research's"). */ agentName?: (id: string) => string; /** The agent this computer belongs to: shows "Open in workspace". */ workspaceBotId?: string | null; nameOf?: (id: string) => string; onAct?: (name: string, a: Exclude<ComputerAction, "preview">) => void; busy?: boolean; onNote?: (n: { ok: boolean; message: string }) => void }) {
  const client = useQueryClient();
  const [confirmStop, setConfirmStop] = useState(false);
  const viewer = c.viewer ?? { snapshot: false, vnc: false };
  // A computer with a screen opens it: seeing what it is doing is the point of this page.
  const [previewing, setPreviewing] = useState(() => (viewer.vnc || viewer.snapshot) && (c.state === "online" || c.state === "busy"));
  const [screen, setScreen] = useState<ScreenState>({ connected: null, canControl: null });
  const [assigning, setAssigning] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const workRef = useRef<HTMLDivElement | null>(null);
  const job = useComputerJob(c);
  const actions = viewActions(c, me);
  const holding = c.controller.kind === "person" && c.controller.who === me;
  const up = c.state === "online" || c.state === "busy";
  const shows = previewing && viewer.vnc && up;
  const summary = computerSummary(c, me, nameFor, job, agentName);
  const hasWork = !!(c.assigned ?? c.lastJob);
  // Work is not assigned to a computer whose screen is down: it is not shown as usable until the screen is back.
  const canAssign = c.state === "online" && c.controller.kind === null && !screenFailing(c);
  const openResult = () => {
    setWorkOpen(true);
    requestAnimationFrame(() => workRef.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  };
  const returnAction = actions.includes("return") ? (
    <Button variant="accent" disabled={busy} onClick={() => onAct?.(c.name, "return")}>Return to agent</Button>
  ) : undefined;
  return (
    <Surface id={`computer-${c.name}`} className="flex scroll-mt-4 flex-col gap-4" data-computer={c.name} data-state={c.state}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Cloud className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 basis-[calc(100%-2rem)] text-lg font-medium leading-snug sm:basis-0" data-testid="workspace-headline">{screenFailing(c) && c.controller.kind === null && !c.takeoverPending ? `${c.label || c.name} is online, but its screen isn't ready` : summary.headline}</h3>
        <Badge tone={stateChip(c).tone} data-testid="computer-state">{stateChip(c).word}</Badge>
        {shows && <ConnectionState {...(() => { const x = screenPhase(screen, false); return { state: x.phase, label: x.label }; })()} className="text-sm" />}
      </div>
      {c.failure && <Notice tone="warn" title="It failed">{c.failure.reason}</Notice>}
      {!c.failure && screenSentence(c) && <Notice tone="warn" title="Its screen isn't ready"><span data-testid="computer-screen-issue">{screenSentence(c)}</span></Notice>}
      {summary.waiting && !c.failure && <WaitingNotice text={summary.waiting} action={returnAction} />}
      <p className="text-[15px] text-muted-foreground">
        Shared agent computer · controls: <span className="font-medium text-foreground" data-fact="controller">{controllerText(c, me, nameFor)}</span>
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Actions for ${c.label || c.name}`}>
        {canAssign && !assigning && <Button variant="accent" onClick={() => setAssigning(true)}>Assign work</Button>}
        {workspaceBotId && <Button asChild variant="outline"><Link to="/agents/workspace/$botId" params={{ botId: workspaceBotId }} search={{ tab: "computer" }}>Open in workspace</Link></Button>}
        {hasWork && <Button variant="outline" aria-expanded={workOpen} onClick={() => (workOpen ? setWorkOpen(false) : openResult())}>{c.assigned ? "View progress" : "Open result"}</Button>}
        {actions.map((a) =>
          a === "stop" && confirmStop ? (
            <span key={a} role="group" aria-label="Confirm stop" className="inline-flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{c.assigned ? "Stop this computer and cancel its job?" : "Stop this computer?"}</span>
              <Button variant="destructive" disabled={busy} onClick={() => { setConfirmStop(false); onAct?.(c.name, "stop"); }}>Yes, stop it</Button>
              <Button variant="ghost" onClick={() => setConfirmStop(false)}>Keep it</Button>
            </span>
          ) : a === "preview" ? (
            <Button key={a} variant="outline" aria-expanded={previewing} onClick={() => setPreviewing((v) => !v)}>
              {previewing ? "Hide computer" : "Open computer"}
            </Button>
          ) : a === "return" ? (
            summary.waiting ? null : <Button key={a} variant="accent" disabled={busy} onClick={() => onAct?.(c.name, a)}>{ACTION_LABEL[a]}</Button>
          ) : (
            <Button key={a} variant={a === "take-control" || a === "request-control" ? "accent" : "outline"} disabled={busy} onClick={() => (a === "stop" ? setConfirmStop(true) : onAct?.(c.name, a))}>
              {ACTION_LABEL[a]}
            </Button>
          ),
        )}
      </div>
      {assigning && canAssign && (
        <AssignForm
          c={c}
          me={me}
          nameOf={nameFor}
          onDone={(r) => {
            setAssigning(false);
            setWorkOpen(true);
            onNote?.(r);
            void client.invalidateQueries({ queryKey: ["computers"] });
          }}
        />
      )}
      {previewing && !up && <Notice tone="info" title="No screen right now">{c.state === "starting" ? "This computer is starting. Its screen appears when it is online." : "This computer is not running. Start it to see its screen."}</Notice>}
      {previewing && up && <PreviewPanel name={c.name} holding={holding} viewer={viewer} online={up} nudge={`${c.controller.kind}:${c.controller.who}:${c.controller.epoch}:${c.takeoverPending ? 1 : 0}`} onState={setScreen} />}
      <div ref={workRef} className="-mx-3 scroll-mt-4">
        <Disclosure summary={<span className="font-medium">Work and result</span>} meta={job ? JOB_STATE_WORD[job.state] : hasWork ? "Reading…" : "Nothing yet"} open={workOpen} onOpenChange={setWorkOpen}>
          <ComputerWork c={c} job={job} />
        </Disclosure>
        <Disclosure summary={<span className="font-medium">Agent, model and routines</span>}>
          <ComputerDetails c={c} job={job} />
        </Disclosure>
      </div>
    </Surface>
  );
}

export function PersonalRow({ p }: { p: PersonalPc }) {
  return (
    <Surface className="flex flex-col gap-2" data-personal-pc={p.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Monitor className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-base font-medium">{p.name}</h3>
        <span className="text-sm text-muted-foreground">{p.owner ? `${nameOf(p.owner)}'s PC` : "Personal PC"}</span>
        {p.state ? <Badge tone={TONE[p.state]}>{STATE_WORD[p.state]}</Badge> : <span className="text-sm text-muted-foreground">Status not reported</span>}
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">Can: </span>
        {p.capabilities ? (p.capabilities.length ? p.capabilities.join(", ") : "nothing reported") : "not reported"}
      </p>
    </Surface>
  );
}

export function ComputersPage() {
  const client = useQueryClient();
  const devices = useDevices();
  const meQ = useMe();
  const me = meQ.data?.id ?? null;
  const cloud = useQuery({ queryKey: ["computers"], queryFn: readComputers, staleTime: 2_000, refetchInterval: streamRefetchInterval(30_000, 4_000), refetchIntervalInBackground: false, retry: false });
  // The live stream says when a computer, a lease or a device changed; the timer is the safety net (4 s when there is no stream).
  useStreamInvalidate([["computers"]], ["computer", "lease", "device"], { debounceMs: 100 });
  const bots = useQuery({ queryKey: ["agent-bots"], queryFn: readBots, staleTime: 10_000, retry: false });
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (name: string, a: Exclude<ComputerAction, "preview">) => {
    setBusy(true);
    setNote(await computerAction(name, a));
    setBusy(false);
    void client.invalidateQueries({ queryKey: ["computers"] });
  };
  // Owner-bound: you see your own PCs here (the other founder's are theirs to see).
  const mine = (devices.data ?? []).filter((d) => d.kind !== "hub" && (d.mine || !me || d.owner === me)).map(personalFromDevice);
  // The signed-in founder is named as their profile names them; the other founder by their id.
  const nameFor = (id: string) => (meQ.data && id === meQ.data.id ? meQ.data.name : nameOf(id));
  const shared = cloud.data?.status === "ok" ? cloud.data.computers : [];
  // The same read the Add form makes: the empty state only points at a control that is really there.
  const hostsQ = useQuery({ queryKey: ["computers-hosts"], queryFn: readHosts, staleTime: 10_000, retry: false });
  const canAdd = hostsQ.data?.status === "ok" && hostsQ.data.hosts.some((h) => !hostProblem(h));
  // "Open computer" from a coding job lands on that computer: scroll to its card once the list is here.
  const sharedCount = shared.length;
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, "");
    if (!id || !sharedCount) return;
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [sharedCount]);
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="Computers" description="Your PCs, and the shared computers agents work on." />
      {note && <Notice className="mb-6" tone={note.ok ? "success" : "warn"} title={note.ok ? "Done" : "Didn't work"}>{note.message}</Notice>}
      <Section title="Your PCs">
        {devices.isLoading ? (
          <p className="text-sm text-muted-foreground">Reading your devices…</p>
        ) : devices.isError ? (
          <Notice tone="warn" title="Couldn't read your devices">The device registry didn't answer. Nothing is shown rather than a guess.</Notice>
        ) : mine.length === 0 ? (
          <EmptyState variant="row" title="No PC is paired yet" body="Pair a computer with the companion and it appears here with its state." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">{mine.map((p) => <PersonalRow key={p.id} p={p} />)}</div>
        )}
      </Section>
      <Section title="Shared agent computers" description="Both founders see these. Taking the controls pauses the agent at a safe step.">
        <AddComputer existing={shared.map((c) => c.name)} onCreated={() => void client.invalidateQueries({ queryKey: ["computers"] })} />
        {cloud.isLoading ? (
          <p className="text-sm text-muted-foreground">Reading shared computers…</p>
        ) : cloud.data?.status === "unavailable" ? (
          <Notice tone="info" title="Not available">{cloud.data.reason} Nothing is listed until it reports.</Notice>
        ) : shared.length === 0 ? (
          <EmptyState variant="row" title="No shared computers yet" body={canAdd ? emptyComputersBody(canAdd) : undefined} />
        ) : (
          <div className="grid gap-4 min-[1500px]:grid-cols-2">{shared.map((c) => <ComputerRow key={c.name} c={c} me={me} nameOf={nameFor} onAct={act} busy={busy} onNote={setNote} workspaceBotId={botForComputer(bots.data?.status === "ok" ? bots.data.bots : [], c.name)?.id ?? null} agentName={(id) => (bots.data?.status === "ok" ? bots.data.bots.find((b) => b.id === id)?.name : undefined) ?? agentDisplay(id)} />)}</div>
        )}
      </Section>
      <Details summary="Where this comes from" className="mt-6">PCs come from the device registry (/__devices); shared computers from /__computers. Cost shows "not reported" until a service reports it. The preview is a snapshot, refreshed every few seconds.</Details>
    </div>
  );
}
