// Computers (System): your PCs, and the shared computers agents work on. Everything shown is something a
// service reported; what isn't reported says so. Buttons appear only for what the computer's state and its
// control lease allow this person to do.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { streamRefetchInterval, useStreamInvalidate } from "@/lib/use-activity";
import { Cloud, Monitor } from "lucide-react";
import { Badge, Button, ConnectionState, Disclosure, EmptyState, Notice, PageFoot, PageHeader, Section, Surface, type ConnectionPhase, type Tone } from "@/components/ds";
import {
  STATE_WORD,
  computerAction,
  controllerText,
  personalFromDevice,
  readComputers,
  readSnapshot,
  renewLease,
  NO_SCREEN,
  viewActions,
  type ComputerAction,
  type ComputerView,
  type PersonalPc,
} from "@/lib/computers-client";
import { AddComputer } from "@/components/computers/add-computer";
import { AssignForm, ComputerDetails, ComputerWork, WaitingNotice } from "@/components/agents/workspace-parts";
import { JOB_STATE_WORD, computerSummary, jobIsFinished, readComputerJob } from "@/lib/agent-workspace";
import { useDevices, useMe } from "@/lib/use-devices";
import { useDocumentVisible } from "@/lib/ui-motion";

const TONE: Record<string, Tone> = { online: "success", busy: "info", starting: "info", asleep: "neutral", offline: "neutral", failed: "danger" };
const ACTION_LABEL: Record<ComputerAction, string> = { preview: "Preview", "take-control": "Take control", "request-control": "Request control", return: "Return to agent", stop: "Stop", start: "Start" };
const pct = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)}%` : "not reported");
const mb = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)} MB` : "not reported");
const nameOf = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** What the embedded viewer page reports to its parent (scripts/computers/novnc.ts). */
export type ViewerMessage = { source: "mu-computer-viewer"; name: string; connected?: boolean; canControl?: boolean };

/** Pure: the plain sentence for the live viewer's state. View-only unless this person holds the lease. */
export function viewerStatusText(m: { connected: boolean | null; canControl: boolean | null }): string {
  if (m.connected === null) return "Connecting to the screen…";
  if (!m.connected) return "The screen disconnected. It reconnects when you reopen the preview.";
  return m.canControl ? "Live view. You hold the controls: your keyboard and mouse reach the computer." : "Live view, view-only. Take control to use the keyboard and mouse.";
}

/** Pure: accept a message only from the viewer frame of this computer on this origin. */
export function parseViewerMessage(data: unknown, name: string): ViewerMessage | null {
  const m = data as Partial<ViewerMessage> | null;
  return m && typeof m === "object" && m.source === "mu-computer-viewer" && m.name === name ? (m as ViewerMessage) : null;
}

/** What the embedded viewer last reported: unknown until it says. */
export type ScreenState = { connected: boolean | null; canControl: boolean | null };

/** Pure: the connection chip for the screen (connected, connecting, trying again, or given up). */
export function screenPhase(s: ScreenState, retrying: boolean): { phase: ConnectionPhase; label: string } {
  if (s.connected === true) return { phase: "live", label: s.canControl ? "Screen live, you can act" : "Screen live, view-only" };
  if (s.connected === null || retrying) return { phase: "reconnecting", label: s.connected === null ? "Connecting to the screen…" : "Reconnecting to the screen…" };
  return { phase: "offline", label: "Screen disconnected" };
}

const MAX_RETRIES = 5;

/**
 * The live screen: the hub's own noVNC viewer page in a same-origin frame. The hub decides who may act; this only reports it.
 * A dropped screen (the desktop restarted, the network blipped) is retried with a growing pause, then offered as a button.
 * `nudge` changes when who holds the controls changes, so the frame re-reads the lease at once instead of on its next poll.
 */
export function LiveViewer({ name, online = true, nudge, onState }: { name: string; online?: boolean; nudge?: string; onState?: (s: ScreenState) => void }) {
  const [state, setState] = useState<ScreenState>({ connected: null, canControl: null });
  const [tries, setTries] = useState(0); // retries since the last good connection
  const [reload, setReload] = useState(0); // the frame is remounted only when this changes
  const frame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const m = parseViewerMessage(e.data, name);
      if (m) {
        const next = { connected: typeof m.connected === "boolean" ? m.connected : null, canControl: typeof m.canControl === "boolean" ? m.canControl : null };
        setState(next);
        onState?.(next);
        if (next.connected === true) setTries(0);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [name, onState]);
  const dropped = state.connected === false;
  const retrying = dropped && online && tries < MAX_RETRIES;
  useEffect(() => {
    if (!retrying) return;
    const t = window.setTimeout(() => {
      setState({ connected: null, canControl: null });
      setTries((n) => n + 1);
      setReload((n) => n + 1);
    }, 2000 * (tries + 1));
    return () => window.clearTimeout(t);
  }, [retrying, tries]);
  useEffect(() => {
    if (nudge !== undefined) frame.current?.contentWindow?.postMessage({ target: "mu-computer-viewer", type: "refresh" }, window.location.origin);
  }, [nudge]);
  return (
    <div className="flex flex-col gap-2">
      {dropped && !retrying && (
        <div>
          <Button variant="outline" size="sm" onClick={() => { setState({ connected: null, canControl: null }); setTries(0); setReload((n) => n + 1); }}>
            Reconnect
          </Button>
        </div>
      )}
      <p role="status" className="text-sm text-muted-foreground">{viewerStatusText(state)}</p>
      <iframe
        key={reload}
        ref={frame}
        title={`Screen of ${name}`}
        src={`/__computers/${encodeURIComponent(name)}/viewer?bare=1`}
        sandbox="allow-scripts allow-same-origin"
        style={{ aspectRatio: "16 / 10" }}
        className="max-h-[78vh] min-h-[260px] w-full rounded-xl border border-border bg-black"
      />
    </div>
  );
}

/** The computer's screen, as a JPEG snapshot refreshed every 3 s while this is open and the tab is visible. */
export function SnapshotPanel({ name, holding }: { name: string; holding: boolean }) {
  const visible = useDocumentVisible();
  const [shot, setShot] = useState<{ url: string } | { reason: string } | null>(null);
  useEffect(() => {
    if (!visible) return;
    let stop = false;
    let last: string | null = null;
    const tick = async () => {
      const s = await readSnapshot(name);
      if (stop) return;
      if ("url" in s && last) URL.revokeObjectURL(last);
      if ("url" in s) last = s.url;
      setShot(s);
    };
    void tick();
    const t = window.setInterval(() => void tick(), 3000);
    // A held lease expires unless the viewer keeps it alive.
    const renew = holding ? window.setInterval(() => void renewLease(name), 25_000) : undefined;
    return () => {
      stop = true;
      window.clearInterval(t);
      if (renew) window.clearInterval(renew);
      if (last) URL.revokeObjectURL(last);
    };
  }, [name, visible, holding]);
  if (!shot) return <p className="text-sm text-muted-foreground">Looking at the screen…</p>;
  if ("reason" in shot) return <Notice tone="info" title="No preview">{shot.reason}</Notice>;
  return <img src={shot.url} alt={`Screen of ${name}, a snapshot refreshed every few seconds`} className="w-full rounded-xl border border-border" />;
}

/** Live viewer when the hub says VNC is up, else the snapshot, else a plain "no screen yet". */
export function PreviewPanel({ name, holding, viewer, online, nudge, onState }: { name: string; holding: boolean; viewer: { snapshot: boolean; vnc: boolean }; online?: boolean; nudge?: string; onState?: (s: ScreenState) => void }) {
  if (viewer.vnc) return <LiveViewer name={name} online={online} nudge={nudge} onState={onState} />;
  if (viewer.snapshot) return <SnapshotPanel name={name} holding={holding} />;
  return <Notice tone="info" title="No preview">{NO_SCREEN}</Notice>;
}

/** Pure: the "Doing" line. A job, a paused job waiting for the controls back, or nothing. */
export function doingText(c: Pick<ComputerView, "assigned" | "paused">): string {
  if (c.assigned) return `${c.assigned.title || c.assigned.jobId} · ${c.assigned.agent}`;
  if (c.paused) return `Paused: ${c.paused.agent}'s job is waiting for the controls back`;
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

export function ComputerRow({ c, me, nameOf: nameFor = nameOf, onAct, busy, onNote }: { c: ComputerView; me: string | null; nameOf?: (id: string) => string; onAct?: (name: string, a: Exclude<ComputerAction, "preview">) => void; busy?: boolean; onNote?: (n: { ok: boolean; message: string }) => void }) {
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
  const summary = computerSummary(c, me, nameFor, job);
  const hasWork = !!(c.assigned ?? c.lastJob);
  const canAssign = c.state === "online" && c.controller.kind === null;
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
        <h3 className="min-w-0 flex-1 basis-[calc(100%-2rem)] text-lg font-medium leading-snug sm:basis-0" data-testid="workspace-headline">{summary.headline}</h3>
        <Badge tone={TONE[c.state]}>{STATE_WORD[c.state]}</Badge>
        {shows && <ConnectionState {...(() => { const x = screenPhase(screen, false); return { state: x.phase, label: x.label }; })()} className="text-sm" />}
      </div>
      {c.failure && <Notice tone="warn" title="It failed">{c.failure.reason}</Notice>}
      {summary.waiting && !c.failure && <WaitingNotice text={summary.waiting} action={returnAction} />}
      <p className="text-[15px] text-muted-foreground">
        Shared agent computer · controls: <span className="font-medium text-foreground" data-fact="controller">{controllerText(c, me, nameFor)}</span>
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Actions for ${c.label || c.name}`}>
        {canAssign && !assigning && <Button variant="accent" onClick={() => setAssigning(true)}>Assign work</Button>}
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
          <EmptyState title="No PC is paired yet" body="Pair a computer with the companion and it appears here with its state." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">{mine.map((p) => <PersonalRow key={p.id} p={p} />)}</div>
        )}
      </Section>
      <Section title="Shared agent computers" description="Both founders see these. Whoever holds the controls is named; an agent pauses at a safe step when you ask for them.">
        <AddComputer existing={shared.map((c) => c.name)} onCreated={() => void client.invalidateQueries({ queryKey: ["computers"] })} />
        {cloud.isLoading ? (
          <p className="text-sm text-muted-foreground">Reading shared computers…</p>
        ) : cloud.data?.status === "unavailable" ? (
          <Notice tone="info" title="Not available">{cloud.data.reason} Nothing is listed until it reports.</Notice>
        ) : shared.length === 0 ? (
          <EmptyState title="No shared computers yet" body="Use Add a shared computer above to create one. It then appears here with its job and who controls it." />
        ) : (
          <div className="grid gap-4 min-[1500px]:grid-cols-2">{shared.map((c) => <ComputerRow key={c.name} c={c} me={me} nameOf={nameFor} onAct={act} busy={busy} onNote={setNote} />)}</div>
        )}
      </Section>
      <PageFoot>PCs come from the device registry (/__devices); shared computers from /__computers. Cost shows "not reported" until a service reports it. The preview is a snapshot, refreshed every few seconds.</PageFoot>
    </div>
  );
}
