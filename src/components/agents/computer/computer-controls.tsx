// The computer's controls, shared by the Computer view and the conversation's side panel so there is exactly one command path:
// Watch is view-only, Take over asks for the control lease (an agent pauses at a safe step first), Return hands it back and stays "held"
// until the hub confirms, Stop asks once. The hub's lease is the authority; this only reports it and calls the existing action API.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ds";
import { computerAction, type ComputerAction, type ComputerView } from "@/lib/computers-client";
import { computerControls, type ComputerControls } from "./control-state";

export type ControlNote = { ok: boolean; message: string };

/** The bots as the workspace read them (`["agent-bots"]`): enough to say whose task is on a shared computer. */
type BotsCache = { status?: string; bots?: Array<{ id: string; name: string; computer?: string | null }> } | undefined;

/**
 * What Stop asks. A computer several bots share holds ONE bot's task at a time, and Stop would cancel it: the question names that bot and the task, so
 * a person looking at another bot's panel never stops someone else's work by mistake. A computer only one bot uses keeps the plain question.
 */
export function stopQuestion(computer: Pick<ComputerView, "name" | "assigned"> & Partial<Pick<ComputerView, "state" | "paused">>, bots: ReadonlyArray<{ id: string; name: string; computer?: string | null }>): string {
  const a = computer.assigned;
  // Round 8: a job started from outside the page is running before this view names it (the hub's computer sampler is 2 s). Busy (or a paused job)
  // without a named job still says that whatever is running stops too; the confirmation also re-reads the computer, so the job's name follows.
  if (!a) return computer.state === "busy" || computer.paused ? "Stop this computer and what's running on it? Nothing runs after this." : "Stop this computer?";
  const owner = bots.find((b) => b.id === a.agent);
  const shared = bots.filter((b) => b.computer === computer.name).length > 1;
  if (owner && shared) return `Stop ${owner.name}'s task ${a.title ? `“${a.title}” ` : ""}on this shared computer? Nothing runs after this.`;
  return "Stop this computer and cancel its job? Nothing runs after this.";
}

export function useComputerControls({ computer, me, onNote }: { computer: ComputerView | null; me: string | null; onNote?: (n: ControlNote) => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ControlNote | null>(null);
  const [handBackFailed, setHandBackFailed] = useState(false);
  const mine = !!computer && computer.controller.kind === "person" && computer.controller.who === me;
  // The hub confirmed the controls moved: whatever a failed hand-back said no longer applies.
  useEffect(() => {
    if (!mine) setHandBackFailed(false);
  }, [mine]);
  const controls = computerControls(computer, me);

  const act = async (a: Exclude<ComputerAction, "preview">) => {
    if (!computer || busy) return;
    setBusy(true);
    const r = await computerAction(computer.name, a);
    // The panel already says "you have the controls" or "ready"; only a refusal, or news the panel can't show, becomes a line of its own.
    setNote(r.ok && (a === "take-control" || a === "request-control") ? null : r);
    onNote?.(r);
    // A failed hand-back is never shown as returned: the controls stay yours until the hub says otherwise.
    if (a === "return") setHandBackFailed(!r.ok);
    setBusy(false);
    await client.refetchQueries({ queryKey: ["computers"] });
  };
  return { controls, busy, note, handBackFailed, mine, act };
}

export type ComputerControlState = ReturnType<typeof useComputerControls>;

export function ComputerControlsBar({ computer, state, watching, onWatching, terminal }: { computer: ComputerView; state: ComputerControlState; watching: boolean; onWatching: (v: boolean) => void; /** Offered only to the person holding the controls of a shared bot computer; the hub checks again on every call. */ terminal?: { open: boolean; onToggle: () => void } }) {
  const { controls, busy, act } = state;
  const [confirmStop, setConfirmStop] = useState(false);
  const client = useQueryClient();
  const bots = (client.getQueryData(["agent-bots"]) as BotsCache)?.bots ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Controls for ${computer.label || computer.name}`}>
      {controls.watch && (
        <Button variant="outline" aria-pressed={watching} onClick={() => onWatching(!watching)}>
          {watching ? "Hide screen" : "Watch"}
        </Button>
      )}
      {controls.takeOver && (
        <Button variant="accent" disabled={busy} onClick={() => void act(controls.takeOver!.ask ? "request-control" : "take-control")}>
          {controls.takeOver.label}
        </Button>
      )}
      {terminal && (
        <Button variant="outline" aria-pressed={terminal.open} onClick={terminal.onToggle}>
          {terminal.open ? "Hide terminal" : "Terminal"}
        </Button>
      )}
      {controls.returnToAgent && (
        <Button variant="accent" disabled={busy} onClick={() => void act("return")}>
          Return to agent
        </Button>
      )}
      {controls.start && (
        <Button variant="accent" disabled={busy} onClick={() => void act("start")}>
          {busy && controls.start.label === "Reconnect" ? "Reconnecting…" : controls.start.label}
        </Button>
      )}
      {controls.takeHere && (
        <Button variant="accent" disabled={busy} onClick={() => void act("take-here")}>
          {controls.takeHere.label}
        </Button>
      )}
      {controls.restartDisplay && (
        <Button variant="accent" disabled={busy} onClick={() => void act("restart-display")}>
          {controls.restartDisplay.label}
        </Button>
      )}
      {controls.stop &&
        (confirmStop ? (
          <span role="group" aria-label="Confirm stop" className="inline-flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{stopQuestion(computer, bots)}</span>
            <Button variant="destructive" disabled={busy} onClick={() => { setConfirmStop(false); void act("stop"); }}>Yes, stop it</Button>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>Keep it</Button>
          </span>
        ) : (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setConfirmStop(true);
              // The question names the job it stops: read the computer now rather than wait for the next sample.
              void client.refetchQueries({ queryKey: ["computers"] });
            }}
          >
            Stop
          </Button>
        ))}
    </div>
  );
}

export type { ComputerControls };
