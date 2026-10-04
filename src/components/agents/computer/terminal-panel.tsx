// A terminal on a shared bot computer, for the person who holds its controls in this window. Offered only where Take over's result is
// (computer-tab.tsx); the hub checks the lease on every call, and closes the terminal when the controls move. A refusal is shown as the
// hub said it. There is no terminal emulator dependency: a readable log (colour and cursor sequences dropped) and one input line.
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, Notice } from "@/components/ds";
import { plainTerminalText, terminalApi, type TerminalApi } from "@/lib/terminal-client";

/** Output kept in the page (older text is dropped first). */
export const KEEP_CHARS = 120_000;
const COLS = 100;
const ROWS = 24;
const POLL_WAIT_MS = 20_000;

type Phase = { kind: "opening" } | { kind: "open"; id: string; attached: boolean } | { kind: "refused"; message: string } | { kind: "closed"; reason: string };

export function TerminalPanel({ computerName, label, api, onClose, initialLine = "" }: { computerName: string; label: string; api?: TerminalApi; onClose: () => void; /** A line to start with (a test, or a restored draft). */ initialLine?: string }) {
  const client = useRef<TerminalApi>(api ?? terminalApi()).current;
  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const [raw, setRaw] = useState("");
  const [gap, setGap] = useState(false);
  const [line, setLine] = useState(initialLine);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const log = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLInputElement>(null);

  // Open (or re-attach to) this person's terminal, then read its output until it closes or this panel goes away.
  useEffect(() => {
    const stop = new AbortController();
    let alive = true;
    (async () => {
      const opened = await client.open(computerName, { cols: COLS, rows: ROWS });
      if (!alive) return;
      if (!opened.ok) return setPhase({ kind: "refused", message: opened.message });
      setPhase({ kind: "open", id: opened.id, attached: opened.attached });
      input.current?.focus();
      let after = 0;
      while (alive) {
        const r = await client.events(computerName, opened.id, after, POLL_WAIT_MS, stop.signal);
        if (!alive) return;
        if (!r.ok) {
          // The hub ended it (the controls moved, the computer stopped) or could not be reached: say so, and stop asking.
          return setPhase({ kind: "closed", reason: r.message });
        }
        after = r.next;
        if (r.gap) setGap(true);
        if (r.chunks.length) setRaw((prev) => (prev + r.chunks.map((c) => c.data).join("")).slice(-KEEP_CHARS));
        if (r.closed) return setPhase({ kind: "closed", reason: r.closed.reason });
      }
    })();
    return () => {
      alive = false;
      stop.abort();
    };
  }, [client, computerName]);

  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [raw]);

  const send = useCallback(
    async (data: string) => {
      if (phase.kind !== "open") return;
      const r = await client.input(computerName, phase.id, data);
      setSendNote(r.ok ? null : r.message);
    },
    [client, computerName, phase],
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (phase.kind !== "open") return;
    const text = line;
    setLine("");
    void send(`${text}\n`);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+C reaches the program, as in any terminal (an empty selection: nothing to copy).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      e.preventDefault();
      void send("\u0003");
    }
  };
  const close = async () => {
    if (phase.kind === "open") await client.close(computerName, phase.id);
    onClose();
  };

  const text = plainTerminalText(raw);
  const live = phase.kind === "open";
  return (
    <section aria-label={`Terminal on ${label}`} className="flex flex-col gap-2 rounded-2xl bg-inset p-3" data-terminal={computerName} data-terminal-phase={phase.kind}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="min-w-0 flex-1 text-[15px] font-medium">Terminal on {label}</h4>
        <Button type="button" variant="ghost" size="sm" onClick={() => void close()}>{live ? "Close terminal" : "Hide"}</Button>
      </div>
      {phase.kind === "opening" && <p role="status" className="text-sm text-muted-foreground">Opening a terminal…</p>}
      {phase.kind === "refused" && <Notice tone="warn" title="No terminal"><span data-testid="terminal-refusal">{phase.message}</span></Notice>}
      {phase.kind === "closed" && <Notice tone="info" title="The terminal has ended"><span data-testid="terminal-closed">{phase.reason}</span></Notice>}
      {gap && <p className="text-sm text-muted-foreground" data-testid="terminal-gap">Some earlier output was missed while this page wasn't reading.</p>}
      {(live || (phase.kind === "closed" && text)) && (
        <pre
          ref={log}
          role="log"
          aria-label="Terminal output"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="m-0 max-h-[min(24rem,50dvh)] min-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-background p-3 font-mono text-[13px] leading-relaxed text-foreground [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="terminal-log"
        >
          {text || (live ? "Waiting for output…" : "")}
        </pre>
      )}
      {live && (
        <form onSubmit={submit} className="flex items-center gap-2" aria-label="Send to the terminal">
          <label className="sr-only" htmlFor={`term-in-${computerName}`}>Type a command</label>
          <span aria-hidden="true" className="font-mono text-sm text-muted-foreground">$</span>
          <input
            id={`term-in-${computerName}`}
            ref={input}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={key}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={2000}
            placeholder="Type a command and press Enter"
            className="h-11 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 font-mono text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" variant="outline" className="h-11" disabled={!line}>Send</Button>
          <Button type="button" variant="ghost" className="h-11" onClick={() => void send("\u0003")} title="Send Ctrl+C: stop the running program">Ctrl+C</Button>
        </form>
      )}
      {sendNote && <p role="status" className="text-sm text-foreground" data-testid="terminal-send-note">Didn't send: {sendNote}</p>}
      {live && <p className="text-sm text-muted-foreground" data-testid="terminal-limits">A command line with plain-text output, not a full terminal: editors and other full-screen programs won't display. Every command line is logged on the computer. It closes when you return the controls.</p>}
    </section>
  );
}
