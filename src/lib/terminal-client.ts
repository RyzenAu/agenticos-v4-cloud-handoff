// A person's terminal on a shared bot computer: the browser side of scripts/computers/routes.ts (round 10).
//   POST /__computers/:name/terminal {cols,rows}        -> { id, attached }
//   GET  /__computers/:name/terminal                    -> { terminal: { id } | null }
//   GET  /__computers/:name/terminal/:id/events?after=&wait= -> { chunks: [{seq,data}], next, gap, closed: {reason} | null }
//   POST .../:id/input {data} | .../:id/resize {cols,rows} | .../:id/close
// The hub decides who may (a confirmed person holding the control lease in this window) on every call; this client only asks and reports.
// A refusal is a 409 with a reason: it is returned as the hub's own sentence, never rewritten into a guess.
import type { ComputerView } from "../../scripts/computers/types";

export type TerminalChunk = { seq: number; data: string };
export type TerminalEvents = { chunks: TerminalChunk[]; next: number; gap: boolean; closed: { reason: string } | null };
export type Refusal = { ok: false; status: number; message: string };
export type TerminalFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Pure: may this window offer a terminal? Only a shared bot computer that is up, and only to the person who holds its controls here (the same
 * place and rule as Take over's result: input is the lease holder's). The hub checks again on every call; this keeps the button honest.
 */
export function canOfferTerminal(c: Pick<ComputerView, "kind" | "owner" | "state" | "controller"> & { heldByYouElsewhere?: boolean } | null, me: string | null): boolean {
  return !!c && !!me && c.kind === "cloud-computer" && c.owner === "shared" && (c.state === "online" || c.state === "busy") && c.controller.kind === "person" && c.controller.who === me && !c.heldByYouElsewhere;
}

const base = (name: string) => `/__computers/${encodeURIComponent(name)}/terminal`;

async function token(f: TerminalFetch): Promise<string> {
  const t = await f("/__token").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return typeof (t as { token?: unknown } | null)?.token === "string" ? (t as { token: string }).token : "";
}

async function call(f: TerminalFetch, path: string, init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal }): Promise<{ ok: true; data: Record<string, unknown> } | Refusal> {
  let r: Response;
  try {
    r = await f(path, { method: init.method, cache: "no-store", signal: init.signal, headers: { "Content-Type": "application/json", "x-claude-os-token": await token(f) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  } catch {
    if (init.signal?.aborted) return { ok: false, status: 0, message: "Stopped." };
    return { ok: false, status: 0, message: "The hub couldn't be reached." };
  }
  const data = ((await r.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
  if (r.ok) return { ok: true, data };
  const why = typeof data.error === "string" && data.error ? data.error : r.status === 403 ? "Confirm this browser to open a terminal." : `The hub answered ${r.status}.`;
  return { ok: false, status: r.status, message: why };
}

export function terminalApi(f: TerminalFetch = (i, o) => fetch(i, o)) {
  return {
    async open(name: string, size: { cols: number; rows: number }): Promise<{ ok: true; id: string; attached: boolean } | Refusal> {
      const r = await call(f, base(name), { method: "POST", body: size });
      if (!r.ok) return r;
      return typeof r.data.id === "string" ? { ok: true, id: r.data.id, attached: r.data.attached === true } : { ok: false, status: 0, message: "The hub sent something this page can't read." };
    },
    async current(name: string): Promise<{ ok: true; id: string | null } | Refusal> {
      const r = await call(f, base(name), { method: "GET" });
      if (!r.ok) return r;
      const t = r.data.terminal as { id?: unknown } | null | undefined;
      return { ok: true, id: t && typeof t.id === "string" ? t.id : null };
    },
    async events(name: string, id: string, after: number, waitMs: number, signal?: AbortSignal): Promise<({ ok: true } & TerminalEvents) | Refusal> {
      const r = await call(f, `${base(name)}/${encodeURIComponent(id)}/events?after=${Math.max(0, Math.floor(after))}&wait=${Math.max(0, Math.floor(waitMs))}`, { method: "GET", signal });
      if (!r.ok) return r;
      const d = r.data;
      const chunks = Array.isArray(d.chunks) ? d.chunks.filter((c): c is TerminalChunk => !!c && typeof (c as TerminalChunk).seq === "number" && typeof (c as TerminalChunk).data === "string") : [];
      const closed = d.closed && typeof d.closed === "object" ? { reason: String((d.closed as { reason?: unknown }).reason ?? "The terminal closed.") } : null;
      return { ok: true, chunks, next: typeof d.next === "number" ? d.next : after, gap: d.gap === true, closed };
    },
    async input(name: string, id: string, data: string) {
      return call(f, `${base(name)}/${encodeURIComponent(id)}/input`, { method: "POST", body: { data } });
    },
    async resize(name: string, id: string, size: { cols: number; rows: number }) {
      return call(f, `${base(name)}/${encodeURIComponent(id)}/resize`, { method: "POST", body: size });
    },
    async close(name: string, id: string) {
      return call(f, `${base(name)}/${encodeURIComponent(id)}/close`, { method: "POST", body: {} });
    },
  };
}
export type TerminalApi = ReturnType<typeof terminalApi>;

const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const OTHER_ESC = /\u001b[()#][0-9A-Za-z]|\u001b[=>78MDEHNOc]/g;

/**
 * Pure: terminal output as plain readable text. A simple log is not a terminal emulator: colour and cursor sequences are dropped, a carriage return
 * rewinds to the start of its line and a backspace removes one character. Full-screen programs (an editor) are not shown faithfully, and say nothing of it.
 */
export function plainTerminalText(raw: string): string {
  const s = raw.replace(OSC, "").replace(CSI, "").replace(OTHER_ESC, "").replace(/\r\n/g, "\n");
  let out = "";
  let lineStart = 0;
  for (const ch of s) {
    if (ch === "\r") out = out.slice(0, lineStart) + ""; // rewrite the line
    else if (ch === "\b" || ch === "\u007f") { if (out.length > lineStart) out = out.slice(0, -1); }
    else if (ch === "\n") { out += ch; lineStart = out.length; }
    else if (ch === "\u0007" || (ch < " " && ch !== "\t")) continue;
    else out += ch;
  }
  return out;
}
