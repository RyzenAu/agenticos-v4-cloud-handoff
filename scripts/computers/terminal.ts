/**
 * A real terminal into a SHARED BOT COMPUTER (round 10, owner's addition). Nothing here is a second way in: a terminal is one more kind of person input,
 * held to the same control lease as the live viewer's mouse and keyboard.
 *
 *   who      a confirmed person (browser session or paired device, never a program) who HOLDS the computer's control lease in THIS window. Taking the
 *            controls (Take over) is what pauses the agent at its next safe step; the terminal does not take them by itself.
 *   where    only computers this service manages (the bot desktops on a Linux host: WSL, the LAN host). The hub and a person's own PC are never computers
 *            here, so they can never be reached this way.
 *   as whom  the computer's OWN unprivileged Linux user, inside its own working folder (computer-ctl.sh `term`). A computer that runs as the host's login
 *            user (no user of its own) is refused: a shell there could read every other computer's files.
 *   ends     on Close, on idle (default 10 minutes with no input), when the controls go back to the agent or move to another window or person, and when the
 *            computer stops. Every open, every command line and every close is written to the computer's log and to the paused job's history.
 *
 * Output is buffered per session (bounded) and read with a sequence number, so a reload or a second poll never shows a chunk twice and a gap is said.
 */

export type TerminalProcess = {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null) => void): void;
};
export type TerminalOpen = (computer: string, size: { cols: number; rows: number }) => Promise<TerminalProcess | { refused: string }>;
export type TerminalPerson = { personId: string; session: string };
/** `job`: the agent job the person paused by taking the controls (when there was one), so its own history says what happened while it waited. */
export type TerminalLog = (computer: string, kind: "terminal-open" | "terminal-command" | "terminal-close", text: string, who: string, job: string | null) => void;

export type TerminalDeps = {
  /** The person holding this computer's lease in THIS window, or a refusal sentence (no lease, someone else's, a program). */
  holds(computer: string, who: TerminalPerson): string | null;
  open: TerminalOpen;
  log: TerminalLog;
  /** The agent job paused on this computer right now (read when the terminal opens), or null. */
  pausedJob?: (computer: string) => string | null;
  now?: () => number;
  idleMs?: number;
  /** Bytes of output kept per session for reading back (oldest dropped first). */
  keepBytes?: number;
};

type Chunk = { seq: number; data: string };
type Session = {
  id: string;
  computer: string;
  who: TerminalPerson;
  job: string | null;
  proc: TerminalProcess;
  chunks: Chunk[];
  kept: number;
  seq: number;
  lastInput: number;
  line: string;
  closed: { reason: string; at: number } | null;
  waiters: Set<() => void>;
};

export type TerminalEvents = { id: string; chunks: Chunk[]; next: number; gap: boolean; closed: { reason: string } | null };

const MAX_INPUT = 4096;
const decoder = () => new TextDecoder("utf-8", { fatal: false });
/** A command line as the log keeps it: control sequences out, digit runs that look like codes or numbers masked, at most 200 characters. */
export function commandForLog(line: string): string {
  const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
  return plain.replace(/\b\d{6,}\b/g, "[number]").replace(/((?:password|passwd|token|secret|key)\s*[=:]\s*)\S+/gi, "$1[hidden]").slice(0, 200);
}

export function createTerminals(deps: TerminalDeps) {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? 10 * 60_000;
  const keepBytes = deps.keepBytes ?? 256 * 1024;
  const sessions = new Map<string, Session>();
  let counter = 0;
  const newId = () => `t${now().toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const byComputer = (computer: string) => [...sessions.values()].find((s) => s.computer === computer && !s.closed) ?? null;
  const sameWho = (a: TerminalPerson, b: TerminalPerson) => a.personId === b.personId && a.session === b.session;

  function push(s: Session, data: string) {
    if (!data) return;
    s.chunks.push({ seq: ++s.seq, data });
    s.kept += data.length;
    while (s.kept > keepBytes && s.chunks.length > 1) s.kept -= s.chunks.shift()!.data.length;
    for (const w of [...s.waiters]) w();
  }

  function close(s: Session, reason: string) {
    if (s.closed) return;
    s.closed = { reason, at: now() };
    try { s.proc.close(); } catch { /* already gone */ }
    deps.log(s.computer, "terminal-close", `terminal closed: ${reason}`, s.who.personId, s.job);
    for (const w of [...s.waiters]) w();
  }

  /** The session this person may use: theirs, open, and they still hold the computer. A lost lease closes it on the spot. */
  function mine(computer: string, id: string, who: TerminalPerson): { ok: true; s: Session } | { ok: false; status: number; reason: string } {
    const s = sessions.get(id);
    if (!s || s.computer !== computer || !sameWho(s.who, who)) return { ok: false, status: 404, reason: "No such terminal on this computer for you." };
    if (s.closed) return { ok: false, status: 410, reason: `This terminal is closed (${s.closed.reason}).` };
    const refused = deps.holds(computer, who);
    if (refused) {
      close(s, "you no longer hold the computer's controls");
      return { ok: false, status: 409, reason: refused };
    }
    return { ok: true, s };
  }

  type StartResult = { ok: true; id: string; attached: boolean } | { ok: false; status: number; reason: string };
  /**
   * Round 11: an open in progress, per computer. Two opens arriving together (the terminal panel's mount effect runs twice in the dev build, or a
   * double click) used to start two shells, so the log said "terminal-open" twice and later "terminal-close" twice for what the person saw as one
   * terminal. A second start while one is opening waits for it and re-attaches to the same session.
   */
  const opening = new Map<string, Promise<StartResult>>();

  const api = {
    /** Open (or re-attach to) this person's terminal on a computer they hold. One terminal per computer. */
    async start(computer: string, who: TerminalPerson, size: { cols?: number; rows?: number } = {}): Promise<StartResult> {
      // Wait out every open in progress (one after a failed one too): only one caller ever starts the next, so two waiters can't start two shells.
      for (let inFlight = opening.get(computer); inFlight; inFlight = opening.get(computer)) {
        await inFlight.catch(() => null);
        const open = byComputer(computer);
        if (open && sameWho(open.who, who) && !deps.holds(computer, who)) return { ok: true, id: open.id, attached: true };
      }
      const run = api.open(computer, who, size);
      opening.set(computer, run);
      try {
        return await run;
      } finally {
        if (opening.get(computer) === run) opening.delete(computer);
      }
    },
    /** The open itself (call start, which keeps one open per computer at a time). */
    async open(computer: string, who: TerminalPerson, size: { cols?: number; rows?: number } = {}): Promise<StartResult> {
      const refused = deps.holds(computer, who);
      if (refused) return { ok: false, status: 409, reason: refused };
      const open = byComputer(computer);
      if (open && sameWho(open.who, who)) return { ok: true, id: open.id, attached: true };
      if (open) close(open, "the controls moved to another window or person");
      const cols = Math.min(400, Math.max(20, Math.floor(Number(size.cols) || 100)));
      const rows = Math.min(200, Math.max(5, Math.floor(Number(size.rows) || 30)));
      const proc = await deps.open(computer, { cols, rows }).catch((e: Error) => ({ refused: `The terminal didn't open: ${String(e?.message ?? e).slice(0, 160)}` }));
      if ("refused" in proc) return { ok: false, status: 409, reason: proc.refused };
      // Held again after the (slow) open: the controls may have gone back meanwhile.
      const still = deps.holds(computer, who);
      if (still) {
        try { proc.close(); } catch { /* nothing to close */ }
        return { ok: false, status: 409, reason: still };
      }
      const s: Session = { id: newId(), computer, who, job: deps.pausedJob?.(computer) ?? null, proc, chunks: [], kept: 0, seq: 0, lastInput: now(), line: "", closed: null, waiters: new Set() };
      sessions.set(s.id, s);
      const text = decoder();
      proc.onData((chunk) => push(s, text.decode(chunk, { stream: true })));
      proc.onExit((code) => close(s, code === 0 || code === null ? "the shell ended" : `the shell ended (exit ${code})`));
      deps.log(computer, "terminal-open", `terminal opened by ${who.personId} (${cols}x${rows}), as the computer's own user`, who.personId, s.job);
      return { ok: true, id: s.id, attached: false };
    },
    /** Keystrokes. Each finished line (Enter) is logged as a command. */
    input(computer: string, id: string, who: TerminalPerson, data: string): { ok: true } | { ok: false; status: number; reason: string } {
      const m = mine(computer, id, who);
      if (!m.ok) return m;
      const text = String(data ?? "").slice(0, MAX_INPUT);
      if (!text) return { ok: true };
      m.s.lastInput = now();
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          const cmd = commandForLog(m.s.line);
          if (cmd) deps.log(computer, "terminal-command", `terminal: ${cmd}`, who.personId, m.s.job);
          m.s.line = "";
        } else if (ch === "\x7f" || ch === "\b") m.s.line = m.s.line.slice(0, -1);
        else if (ch === "\x03") m.s.line = ""; // Ctrl+C abandons the line
        else if (ch >= " " || ch === "\t") m.s.line = (m.s.line + ch).slice(-1000);
      }
      m.s.proc.write(new TextEncoder().encode(text));
      return { ok: true };
    },
    resize(computer: string, id: string, who: TerminalPerson, cols: number, rows: number): { ok: true } | { ok: false; status: number; reason: string } {
      const m = mine(computer, id, who);
      if (!m.ok) return m;
      m.s.proc.resize(Math.min(400, Math.max(20, Math.floor(cols) || 80)), Math.min(200, Math.max(5, Math.floor(rows) || 24)));
      return { ok: true };
    },
    /** Output after `after` (long-polls up to `waitMs` when there is none yet). `gap`: older output was dropped before it could be read. */
    async events(computer: string, id: string, who: TerminalPerson, after: number, waitMs = 0): Promise<({ ok: true } & TerminalEvents) | { ok: false; status: number; reason: string }> {
      const s = sessions.get(id);
      // A closed session's last output and its reason stay readable for its own person.
      if (!s || s.computer !== computer || !sameWho(s.who, who)) return { ok: false, status: 404, reason: "No such terminal on this computer for you." };
      if (!s.closed) {
        const m = mine(computer, id, who);
        if (!m.ok && m.status !== 409) return m;
      }
      const ready = () => s.chunks.some((c) => c.seq > after) || !!s.closed;
      if (!ready() && waitMs > 0) {
        const waiters = s.waiters;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(t);
            waiters.delete(done);
            resolve();
          };
          const t = setTimeout(done, Math.min(waitMs, 25_000));
          waiters.add(done);
        });
      }
      const chunks = s.chunks.filter((c) => c.seq > after);
      return { ok: true, id, chunks, next: chunks.at(-1)?.seq ?? Math.max(after, 0), gap: !!s.chunks.length && s.chunks[0].seq > after + 1 && after > 0, closed: s.closed ? { reason: s.closed.reason } : null };
    },
    close(computer: string, id: string, who: TerminalPerson): { ok: true } | { ok: false; status: number; reason: string } {
      const s = sessions.get(id);
      if (!s || s.computer !== computer || !sameWho(s.who, who)) return { ok: false, status: 404, reason: "No such terminal on this computer for you." };
      close(s, "closed by you");
      return { ok: true };
    },
    /** The computer's controls changed (returned, expired, moved): any terminal whose person no longer holds it closes now. */
    leaseChanged(computer: string) {
      for (const s of sessions.values()) if (s.computer === computer && !s.closed && deps.holds(computer, s.who)) close(s, "the controls went back to the agent or to someone else");
    },
    /** The computer stopped, was destroyed or recovered: its terminal ends with it. */
    computerStopped(computer: string, why: string) {
      for (const s of sessions.values()) if (s.computer === computer && !s.closed) close(s, why);
    },
    /** Idle terminals close; closed ones are forgotten after 10 minutes. */
    sweep() {
      const t = now();
      for (const s of [...sessions.values()]) {
        if (!s.closed && t - s.lastInput > idleMs) close(s, `idle for ${Math.round(idleMs / 60_000)} minutes`);
        else if (s.closed && t - s.closed.at > 10 * 60_000) sessions.delete(s.id);
      }
    },
    /** For the page: this person's open terminal on a computer, if any. */
    openFor(computer: string, who: TerminalPerson): { id: string } | null {
      const s = byComputer(computer);
      return s && sameWho(s.who, who) ? { id: s.id } : null;
    },
    closeAll(why = "the hub is stopping") {
      for (const s of sessions.values()) close(s, why);
    },
  };
  return api;
}

export type Terminals = ReturnType<typeof createTerminals>;

/**
 * The frames the hub writes to the bridge in the computer (computer-ctl.sh `term`): 1 type byte, a 4-byte big-endian length, the payload.
 * 'd' keystrokes, 'r' a resize (2-byte columns, 2-byte rows), 'q' end. Output comes back as raw terminal bytes.
 */
export function frame(type: "d" | "r" | "q", payload: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}
export const resizeFrame = (cols: number, rows: number) => {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint16(0, cols);
  new DataView(p.buffer).setUint16(2, rows);
  return frame("r", p);
};
