// A bot's own shared computer, live: the Computer view of the Agents workspace, and the body of the conversation's side panel. Watch is
// view-only; Take over asks for the control lease (an agent pauses at a safe step first); only the lease holder can act; Return hands it
// back and stays "held" until the hub confirms; Stop asks once. The controls and their action calls live in computer-controls.tsx, so every
// surface uses the same command path. Personal PCs never appear here: the bot's computer must be a shared one.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Badge, Button, ConnectionState, EmptyState, Notice, Surface } from "@/components/ds";
import { stateChip, type ComputerView } from "@/lib/computers-client";
import { PreviewPanel } from "./viewer";
import { CONNECT_DEADLINE_MS, screenPhase, type ScreenState } from "./viewer-state";
import { agentWords, canSendInput, computerPanel } from "./control-state";
import { ComputerControlsBar, useComputerControls } from "./computer-controls";
import { TerminalPanel } from "./terminal-panel";
import { canOfferTerminal } from "@/lib/terminal-client";

export function ComputerTab({ botName, botId, computerName, computer, me, nameOf, onNote, unavailable, context, compact }: { botName: string; /** This bot's id: its paused job is then called by the bot's name, not its id. */ botId?: string; computerName: string | null; computer: ComputerView | null; me: string | null; nameOf?: (id: string) => string; onNote?: (n: { ok: boolean; message: string }) => void; /** The computers service said it is unavailable: that reason, instead of guessing the computer is missing. */ unavailable?: string | null; /** Extra lines under the headline (the task and the next blocker, in the side panel). */ context?: ReactNode; /** The side panel: the screen is not capped to the viewport and the surface is quieter. */ compact?: boolean }) {
  const [watching, setWatching] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [screen, setScreen] = useState<ScreenState>({ connected: null, canControl: null });
  const state = useComputerControls({ computer, me, onNote });
  const { controls, note, handBackFailed, mine } = state;

  const holder = computer ? `${computer.controller.kind}:${computer.controller.who}:${computer.controller.epoch}:${computer.takeoverPending ? 1 : 0}` : "";
  // A screen from a computer that isn't up says nothing; start over when the computer changes.
  useEffect(() => setScreen({ connected: null, canControl: null }), [computerName]);

  const showLive = !!computer && controls.watch && watching && !!computer.viewer?.vnc;
  const panel = computerPanel(computer, me, { screen: showLive ? screen : undefined, handBackFailed, nameOf, agentName: (id) => (botId && id === botId ? botName : agentWords(id)) });
  const canTerminal = canOfferTerminal(computer, me);
  // Returning the controls (or moving them) ends the terminal on the hub; the panel goes with it.
  useEffect(() => {
    if (!canTerminal) setTerminalOpen(false);
  }, [canTerminal]);
  const up = !!computer && (computer.state === "online" || computer.state === "busy");

  if (unavailable) return <Notice tone="info" title="Computers aren't available">{unavailable} Nothing is shown rather than a guess.</Notice>;
  if (!computerName || !computer) {
    // R11: in the side panel the page's status line already says the computer is missing and offers the fix: say nothing twice.
    if (compact) return <p className="px-1 py-2 text-sm text-muted-foreground" data-testid="computer-missing">No screen to show.</p>;
    return (
      <EmptyState
        title={computerName ? `${computerName} isn't on this hub` : `${botName} has no computer yet`}
        body={computerName ? "The shared computer this bot is set to use isn't listed. Check Computers, or pick another in Setup." : "A bot works on a shared computer you can watch. Add one in Computers, then assign it in Setup."}
        action={<Button asChild variant="outline"><Link to="/computers">Open Computers</Link></Button>}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4" data-computer-tab={computer.name} data-mode={panel.mode} data-input={canSendInput(computer, me) ? "yours" : "view-only"}>
      <Surface className={compact ? "flex flex-col gap-2 border-0 bg-transparent" : "flex flex-col gap-3"} padding={compact ? "none" : "sm"}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 title={panel.headline} className={`min-w-0 flex-1 font-medium leading-snug [overflow-wrap:anywhere] ${compact ? "basis-full text-base" : "basis-full text-lg sm:basis-0"}`} data-testid="computer-headline">{panel.headline}</h3>
          <Badge tone={stateChip(computer).tone} data-testid="computer-state">{stateChip(computer).word}</Badge>
          {showLive && up && <ConnectionState {...(() => { const x = screenPhase(screen, false); return { state: x.phase, label: x.label }; })()} className="text-sm" />}
        </div>
        {panel.handBackFailed ? (
          <Notice tone="warn" title="Still yours" role="alert"><span data-testid="computer-detail">{panel.detail}</span></Notice>
        ) : (
          panel.detail && <p className="text-[15px] text-muted-foreground" data-testid="computer-detail">{panel.detail}</p>
        )}
        {panel.screenIssue && panel.mode !== "screen-down" && <Notice tone="warn" title="Its screen isn't ready"><span data-testid="computer-screen-issue">{panel.screenIssue}</span></Notice>}
        {context}
        <ComputerControlsBar computer={computer} state={state} watching={watching} onWatching={setWatching} terminal={canTerminal ? { open: terminalOpen, onToggle: () => setTerminalOpen((v) => !v) } : undefined} />
        {note && <p role="status" className={`text-sm ${note.ok ? "text-muted-foreground" : "text-foreground"}`} data-testid="computer-note">{note.ok ? note.message : `Didn't work: ${note.message}`}</p>}
      </Surface>
      {canTerminal && terminalOpen && <TerminalPanel key={computer.name} computerName={computer.name} label={computer.label || computer.name} onClose={() => setTerminalOpen(false)} />}
      {up && controls.watch && watching && (
        <div className={compact ? "[&_iframe]:max-h-[max(220px,calc(100dvh_-_24rem))]" : undefined}>
          <PreviewPanel name={computer.name} holding={mine} viewer={computer.viewer} online={up} nudge={holder} onState={setScreen} deadlineMs={CONNECT_DEADLINE_MS} />
        </div>
      )}
      {up && !controls.watch && computer.viewer && !(computer.viewer.vnc || computer.viewer.snapshot) && (
        <Notice tone="info" title="No screen">This computer has no desktop yet, so there is nothing to watch. It still runs steps and saves results.</Notice>
      )}
    </div>
  );
}
