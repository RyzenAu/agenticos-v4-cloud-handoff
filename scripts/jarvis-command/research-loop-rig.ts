// Test rig for the research loop (programme r5-conv): the REAL pieces from a job to a person's conversation, stream and voice, in one box.
//
//   JobService (SQLite)  -->  createJobThreads  -->  conversationStore (JSON on disk)  -->  wireThreadNotices
//                                                        |-- activity bus + createStream over real HTTP (SSE), person-scoped
//                                                        '-- the interjection gate (jarvis-events.json) read by a FAKE voice session
//
// Synthetic: the computer and the web are supplied by the tests, the voice session is `fakeVoice` (no microphone, no TTS), and the SSE
// consumer is a plain fetch reader. Nothing here touches the live hub, a real machine or the network beyond 127.0.0.1.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityBus } from "../events/bus";
import { startActivitySources } from "../events/sources";
import { createStream } from "../events/stream";
import { conversationStore } from "../conversations";
import { createJarvisEvents, type JarvisEvent } from "../jarvis-events";
import type { JobService } from "../jobs/service";
import { wireThreadNotices } from "./thread-notify";
import { createJobThreads } from "./threads";

export type Frame = { event: string; id?: string; data: any };

/** An SSE consumer over fetch, as stream.test.ts reads it: frames as they arrive, and a way to wait for a condition. */
export async function openEvents(base: string, person: string | null, init: { lastEventId?: string } = {}) {
  const controller = new AbortController();
  const headers: Record<string, string> = {};
  if (person) headers["x-person"] = person;
  if (init.lastEventId) headers["last-event-id"] = init.lastEventId;
  const res = await fetch(`${base}/__events`, { headers, signal: controller.signal });
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const f: Frame = { event: "message", data: null };
            for (const line of raw.split("\n")) {
              if (line.startsWith("event: ")) f.event = line.slice(7);
              else if (line.startsWith("id: ")) f.id = line.slice(4);
              else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
            }
            if (raw.startsWith("retry:") && !raw.includes("event:")) continue;
            frames.push(f);
            for (const w of waiters.splice(0)) w();
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }
  const waitFor = async (pred: (f: Frame[]) => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!pred(frames)) {
      if (Date.now() > end) throw new Error(`timed out; frames: ${JSON.stringify(frames.map((f) => f.event + (f.data?.topic ? `:${f.data.topic}/${f.data.type}` : "") + (f.data?.data?.entry ? `:${f.data.data.entry.key}` : "")))}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 25);
      });
    }
  };
  return {
    status: res.status,
    frames,
    waitFor,
    /** The thread entries this stream delivered, in order. */
    threadKeys: () => frames.filter((f) => f.data?.topic === "thread").map((f) => f.data.data.entry.key as string),
    threadEvents: () => frames.filter((f) => f.data?.topic === "thread").map((f) => f.data),
    close: () => controller.abort(),
  };
}
export type EventsClient = Awaited<ReturnType<typeof openEvents>>;

/** What localStorage is to a browser: shared by every tab of that browser, gone with the browser. */
export function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

/**
 * A voice session that is listening, as src/components/operator/voice-companion.tsx runs it: it polls the gate (a GET is what "a voice client is
 * listening" means), keeps the speak events it has not said, and asks the server to CLAIM one just before speaking (the server claims each exactly once and
 * persists it; the browser keeps no list of its own). `said` is what it would have spoken. FAKE: no audio.
 */
export function fakeVoice(gate: ReturnType<typeof createJarvisEvents>, _storage?: ReturnType<typeof memoryStorage>) {
  const waiting = new Map<string, JarvisEvent>();
  const said: string[] = [];
  let since: number | null = null;
  return {
    said,
    /** One poll-and-speak pass. `joined` true: this session has just started (a reload or another tab), so it starts from the beginning. */
    tick() {
      const data = gate.list(since ?? 0);
      for (const e of data.events) if (e.delivery === "speak" && !e.spokenAt) waiting.set(e.id, e);
      since = data.seq;
      for (const [, next] of waiting) {
        waiting.delete(next.id);
        const claim = gate.claim({ id: next.id });
        if (claim.speak && claim.text) said.push(claim.text);
      }
    },
  };
}

export async function loopRig(jobs: JobService, options: { isLocal?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "research-loop-"));
  const conversations = conversationStore(dir);
  const threads = createJobThreads({ conversations, jobs: () => jobs, pollMs: 60_000, localFile: join(dir, "thread-local.json") });
  const bus = new ActivityBus();
  const sources = startActivitySources({ bus, registry: () => ({ all: () => [], isOnline: () => false }), jobs: () => jobs as never, computers: null, sampleMs: 60_000 });
  const toasts: JarvisEvent[] = [];
  // Quiet hours off (the clock is the real one); the toast fallback is recorded instead of shown.
  const gate = createJarvisEvents(dir, { quietHours: { start: 0, end: 0 }, onFallbackToast: (e) => toasts.push(e) });
  const unwire = wireThreadNotices({ threads, activity: sources, events: gate });
  const stream = createStream({
    bus,
    resolvePrincipal: (req) => {
      const p = req.headers["x-person"];
      return p === "usman" || p === "mehroz" ? { personId: p } : null;
    },
    snapshot: (person) => sources.snapshot(person),
    heartbeatMs: 60_000,
  });
  const server: Server = createServer((req, res) => stream.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await threads.start();
  if (options.isLocal !== false) threads.noteLocal("usman");
  const clients: EventsClient[] = [];
  return {
    dir, conversations, threads, bus, sources, gate, toasts, base,
    open: async (person: string | null, init: { lastEventId?: string } = {}) => {
      const c = await openEvents(base, person, init);
      clients.push(c);
      return c;
    },
    async close() {
      for (const c of clients) c.close();
      stream.closeAll();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      unwire();
      threads.stop();
      sources.stop();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* handles close at GC on Windows */ }
    },
  };
}
export type LoopRig = Awaited<ReturnType<typeof loopRig>>;
