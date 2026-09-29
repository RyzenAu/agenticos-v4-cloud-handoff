// Track 2 · Stage C acceptance, SYNTHETIC: every item goes through the REAL voice entry code path —
//   fake STT audio → freeVoice /voice/free/stt → /voice/free/turn (rules) → the voice client's own
//   jarvis_command dispatch (Track 1's resolver, then runJarvisCommand over real HTTP) → the real
//   /screen/command route → the real command service → a real Job (SQLite) → the real Jarvis entry
//   (fake hands) or a real paired companion over the real devices service → the done → the follow-up
//   turn's spoken line → /voice/free/tts (fake TTS).
// Fakes: Groq STT/TTS and TypeSafe Jev over a fake fetch; screen/browser/PowerPoint/Notepad/file executors;
// Hindsight (the Stage D fake). No real device, window, browser, account or network beyond 127.0.0.1.
import { spokenSafe } from "../j4/spoken"; // (J4: the spoken line has no ID, path or ISO date; the typed one keeps them)
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice, pcmToWav } from "../free-voice";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { createJarvisEntry, type EntryDeps } from "../jev-command";
import { createRunLog } from "../screen-hands/run-log";
import type { ScreenDone, ScreenRequest } from "../screen-hands/index";
import { screenGoalRefusal } from "../screen-hands/refusals";
import type { AppBrowser, TranscriptSegment } from "../browser/app-browser";
import type { DeckOp } from "../jev-powerpoint";
import { JobService } from "../jobs/service";
import { resolvePrincipal } from "../identity/principal";
import { resolveTarget } from "../devices/route";
import { SIMULATED_SERVE, SIMULATED_TAILNET, startHub, TAILNET, type Hub, type Who } from "../devices/test-harness";
import { CompanionWorker } from "../../companion/worker";
import { MicLock } from "../../companion/mic-lock";
import type { Executor } from "../../companion/executors";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { createMemoryVoiceTurn } from "../memory/voice-turn";
import { cleanup as memoryCleanup, setup as memorySetup, usman as memUsman } from "../memory/testing/harness";
import { commandResultText, runJarvisCommand, voiceRouteFor, type CommandGet, type CommandPost } from "../../src/lib/jarvis-command";
import type { PageContextSnapshot } from "../../src/lib/page-context";
import { createCommandService, type CommandService } from "./service";
import { commandRoute } from "./route";
import { runLeadAction } from "./leads";
import { loadCodingDetector } from "./coding";
import { confirmAnswer } from "../free-voice";
import { receptionistAnswer, receptionistQuestion } from "./receptionist";
import { skillIntent } from "../jarvis-skills";
import type { ReceptionistSnapshot } from "../receptionist/types";

/** A synthetic receptionist dashboard snapshot (the shape the live service returns). */
const SYNTHETIC_RX = {
  generatedAt: "2026-09-28T01:30:00.000Z",
  sentence: "Not safe to sell · 12 calls in 7 days · 1 flagged — next: follow up the flagged 28 Sep call.",
  verdict: { decision: "Not safe to sell", tone: "bad", facts: ["12 calls in 7 days", "1 flagged", "0 of 5 gates passed"], next: "Follow up the flagged 28 Sep call" },
  incidents: [{ callId: "synthetic-1", startedAt: "2026-09-28T00:02:00.000Z", from: "04•• ••• 123", flags: [], consequence: "Caller may expect a booking that wasn't made.", retellUrl: "" }],
  awaitingRetest: [],
  calls: { ok: true, windows: [{ label: "Today", count: 3, answered: 3 }, { label: "7 days", count: 12, answered: 11 }, { label: "All time", count: 40, answered: 38 }], recent: [], latencyTrend: [], flagTotals: {} },
  feed: { ok: true, windowDays: 7, totals: { byOutcome: [{ name: "booked", count: 4 }, { name: "message", count: 8 }] } },
} as unknown as ReceptionistSnapshot;
import type { CommandDoneEvent, CommandStreamEvent, ExecutorResult } from "./contracts";

const T = { timeout: 45_000 };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const until = async (check: () => boolean | Promise<boolean>, ms = 4_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
};

// ---- fakes -----------------------------------------------------------------------------------------
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
/** Jev over a fake TypeSafe endpoint: a category at a confidence (sub-choices optional). */
function jev(category = "screen_act", confidence = 0.92, extra: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const request = (async (_url: string, init?: RequestInit) => {
    asked.push(String(JSON.parse(String(init?.body ?? "{}"))?.input ?? ""));
    return json({ answers: { category: { choice: category, confidence }, outbound: { noul: 0.02, confidence: 0.9 }, ...extra }, usage: { input_tokens: 600, output_tokens: 20 } });
  }) as unknown as typeof fetch;
  return { request, asked };
}

type Hands = {
  screen: ScreenRequest[];
  apps: string[];
  opened: string[];
  urls: string[];
  youtube: string[];
  decks: DeckOp[];
  blank: string[];
  notepad: string[];
  coding: string[];
  leads: string[];
  reminders: string[];
  skills: string[];
  /** Called as the Notepad fake finishes (checked), before it returns: to stage a stop that races completion. */
  onNotepadDone?: () => void;
  screenGate?: Promise<void>;
};

function fakeBrowser(h: Hands, slowPageMs = 0): AppBrowser {
  let url = "about:blank";
  let paused = true;
  const segments: TranscriptSegment[] = [
    { seconds: 12, stamp: "0:12", text: "The key idea is to answer every call within three rings." },
    { seconds: 95, stamp: "1:35", text: "Second, confirm the booking by text straight away." },
  ];
  return {
    page: () => ({ url: () => url }) as never,
    open: async (u) => {
      h.urls.push(u);
      // A page that ignores stops while it loads (the real Playwright goto has no signal).
      if (slowPageMs) await new Promise((r) => setTimeout(r, slowPageMs));
      url = u;
      return { ok: true, said: `Opened ${new URL(u).hostname}.`, url: u };
    },
    youtubeSearch: async (q) => (h.youtube.push(`search:${q}`), (url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`), { ok: true, said: `Searched YouTube for ${q}.`, results: [{ title: "Synthetic lo-fi", href: "/watch?v=abc" }] }),
    openResult: async (m) => (h.youtube.push(`open:${m.index ?? m.title}`), (url = "https://www.youtube.com/watch?v=abc"), { ok: true, said: "Opened the video \"Synthetic lo-fi\"." }),
    videoInfo: async () => ({ url, videoId: "abc", title: "Synthetic receptionist tips", duration: 180, currentTime: 0, paused, ad: false, botWall: false }),
    setPlaying: async (want) => {
      h.youtube.push(want);
      const before = paused;
      paused = want === "pause";
      return { ok: true, said: want === "pause" ? "Paused." : "Playing.", before: !before, after: !paused };
    },
    transcript: async () => segments,
    frames: async () => [],
    screenshot: async () => undefined,
    evidence: () => ({ dialogs: 0, popups: 0, downloads: 0, refused: 0 }),
    close: async () => undefined,
  };
}

const verified = (said: string, evidence: string): ExecutorResult => ({ ok: true, said, verified: true, evidence });

/** The hub side: a real JobService + real Jarvis entry over fake hands, the real command service, the real route over HTTP. */
async function rig(options: { jev?: ReturnType<typeof jev>; memory?: boolean; graceMs?: number; slowScreen?: boolean; slowNotepad?: number; voiceJev?: "leads-page" | "unsure"; brain?: boolean; memoryWrites?: boolean; screenConfirm?: string; slowAppMs?: number; slowPageMs?: number; slowDeckMs?: number } = {}) {
  // Track 3's coding detector when its branch is merged into this tree (REVIEW-T2 #3).
  const t3 = await loadCodingDetector();
  const hub: Hub = await startHub({ maxWaitMs: 300 });
  cleanups.push(() => hub.close());
  const jobsPath = join(hub.root, ".operator-data", "jobs.sqlite");
  let jobs = new JobService({ path: jobsPath, stopGraceMs: 1500, snapshotMs: 0 });
  cleanups.push(() => {
    try {
      jobs.close();
    } catch {
      /* running: the process is ending */
    }
  });
  const fileRoot = join(hub.root, "authorised");
  mkdirSync(fileRoot, { recursive: true });
  writeFileSync(join(fileRoot, "quarterly-plan.docx"), "synthetic");
  const h: Hands = { screen: [], apps: [], opened: [], urls: [], youtube: [], decks: [], blank: [], notepad: [], coding: [], leads: [], reminders: [], skills: [] };
  // A synthetic CRM behind the leads API shape (search → log → list read-back).
  const crm = new Map<number, { title: string; status: string }>([[7, { title: "Synthetic Physio Studio", status: "new" }], [8, { title: "Synthetic Dental Co", status: "to_call" }]]);
  const fakeLeads = {
    handle: async (path: string, _m: string, body: unknown, params: URLSearchParams) => {
      if (path === "/leads/search") return { hits: [...crm].filter(([, l]) => l.title.toLowerCase().includes((params.get("q") ?? "").toLowerCase())).map(([id, l]) => ({ group: "leads", leadId: id, title: l.title })) };
      if (path === "/leads/log") {
        const b = body as { lead: number; outcome: string };
        crm.get(b.lead)!.status = b.outcome;
        return { lead: {} };
      }
      if (path === "/leads/list") return { leads: [...crm].filter(([, l]) => l.status === params.get("status")).map(([id]) => ({ id })) };
      if (path === "/leads/cards") return { cards: [{ leadId: 8, name: "Synthetic Dental Co", vertical: "dental", area: "Parramatta" }] };
      throw new Error(path);
    },
  };
  const runs = createRunLog();
  const j = options.jev ?? jev();
  let entryCalls = 0;
  const deps: EntryDeps = {
    screen: {
      runs,
      act: (async (req: ScreenRequest, signal: AbortSignal) => {
        // As the real screen executor does first (scripts/screen-hands/index.ts): a money, bank or secret goal
        // is refused before any step, whatever routed it there (S2d: money REQUESTS now reach routing).
        const refusedGoal = req.payment ? null : screenGoalRefusal(req.goal);
        if (refusedGoal) return { type: "done", ok: false, said: refusedGoal.said, steps: 0, ms: 1, stepMs: [] } satisfies ScreenDone;
        h.screen.push(req);
        if (options.slowScreen) {
          // A long screen task that honours its stop between sub-steps.
          for (let i = 0; i < 200 && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 25));
          if (signal.aborted) return { type: "done", ok: false, said: "Stopped.", stopped: true, steps: 1, ms: 5, stepMs: [5] } satisfies ScreenDone;
        }
        if (options.screenConfirm) return { type: "done", ok: false, said: `Shall I press ${options.screenConfirm}?`, confirm: options.screenConfirm, ask: true, steps: 1, ms: 5, stepMs: [5] } satisfies ScreenDone;
        return { type: "done", ok: true, said: "Clicked \"Save\" (checked: the dialog closed).", steps: 1, ms: 5, stepMs: [5] } satisfies ScreenDone;
      }) as EntryDeps["screen"]["act"],
    },
    jevKey: () => "synthetic-key",
    request: j.request,
    front: async () => ({ process: "Notepad", title: "Untitled - Notepad" }),
    browser: async () => browserInstance,
    activeVideo: async () => /watch\?v=/.test(browserInstance.page().url()),
    summarise: async () => ({ text: "- [0:12] Answer every call within three rings.\n- [1:35] Confirm the booking by text straight away.", model: "synthetic-llm" }),
    files: { roots: [fileRoot], open: async (p) => void h.opened.push(p), titles: async () => h.opened.map((p) => `${p.split(/[\\/]/).pop()} - Word`), sleep: async () => undefined },
    openApp: async (name) => {
      h.apps.push(name);
      // An app lane that ignores its stop (the review's repro): it finishes later, whatever happens.
      if (options.slowAppMs) await new Promise((r) => setTimeout(r, options.slowAppMs));
      return { ok: true, said: `Opened ${name}.` };
    },
    deck: async (op) => (h.decks.push(op), options.slowDeckMs && (await new Promise((r) => setTimeout(r, options.slowDeckMs))), { ok: true, said: `${op.op} ok (read back from PowerPoint).`, path: op.path, exists: true, slides: 1, titles: ["Q3 plan"], showing: op.op === "show", showSlide: null, ms: 5 }),
    notepad: async (text, signal) => {
      h.notepad.push(text);
      // A slow typist that honours its stop (the real executor checks its signal between keys).
      for (let i = 0; i < (options.slowNotepad ?? 0) / 25 && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 25));
      if (signal.aborted) return { ok: false, said: "Stopped before the line was finished; nothing was saved.", verified: false };
      const checkedAt = Date.now();
      h.onNotepadDone?.();
      return { checkedAt, ...verified("Typed the line into a new Notepad document and read it back.", "read-back matched (sha256)") };
    },
    deckBlank: async (title) => (h.blank.push(title), verified(`New presentation with the title slide "${title}" (never saved).`, "COM read-back: 1 slide, title matched")),
  };
  const browserInstance = fakeBrowser(h, options.slowPageMs);
  const entry = createJarvisEntry(deps);
  const spoken = new SpokenConfirmationLedger();
  let memoryTurn: ReturnType<typeof createMemoryVoiceTurn> | null = null;
  if (options.memory) {
    const m = await memorySetup({ proxy: true, writes: options.memoryWrites !== false });
    cleanups.push(() => memoryCleanup());
    await m.api.sync({ force: true });
    memoryTurn = createMemoryVoiceTurn({ api: () => m.api, spoken });
  }
  const service: CommandService = createCommandService({
    jobs: () => jobs,
    entry: () => (entryCalls++, entry),
    runs,
    hubDeviceId: "usman-pc",
    resolveTarget: (ctx) => resolveTarget(ctx, hub.svc.registry),
    dispatcher: hub.svc.dispatcher,
    micOwner: (p) => hub.svc.registry.micOwner(p),
    deviceLabel: (id) => hub.svc.registry.all().find((d) => d.id === id)?.label ?? id,
    graceMs: options.graceMs ?? 400,
    delegates: {
      ...(memoryTurn
        ? {
            memory: async (u: string, caller: unknown, yes: string | null) => {
              const x = await memoryTurn!(caller as typeof memUsman, u, { spokenYes: yes });
              return x ? { said: x.content, outcome: x.outcome } : null;
            },
          }
        : {}),
      receptionist: async (utterance: string) => {
        const a = receptionistAnswer(receptionistQuestion(utterance) ?? "status", SYNTHETIC_RX);
        return { ok: a.verified, said: a.said, verified: a.verified };
      },
      skill: {
        match: (u: string) => {
          const req = skillIntent(u);
          return req && "skill" in req && ["finance", "time", "maths", "units"].includes(req.skill) ? req.skill : null;
        },
        run: async (u: string) => {
          const req = skillIntent(u) as { skill: string };
          h.skills.push(req.skill);
          return { ok: true, said: req.skill === "finance" ? "$298.04 went out this month (synthetic NAB CSV as of 26 Sep, partial period)." : `[synthetic ${req.skill} skill]` };
        },
      },
      leads: async (action, principal) => {
        h.leads.push(`${principal.personId}:${JSON.stringify(action)}`);
        return runLeadAction(fakeLeads, action, principal);
      },
      reminder: async (words) => (h.reminders.push(words), { ok: true, said: `Reminder set: ${words.replace(/^remind me to /, "")}.` }),
    },
  });

  // The /__operator/screen/command* routes on their own loopback server, identity from the SAME store.
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname.replace(/^\/__operator/, "");
    const principal = resolvePrincipal(req as IncomingMessage, { root: hub.root, store: hub.svc.store, tailnetName: TAILNET, servePeer: SIMULATED_SERVE, tailnet: SIMULATED_TAILNET });
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (!principal) return send({ error: "Sign in first" }, 401);
    let body: unknown = {};
    if (req.method !== "GET") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    }
    const memoryCaller = principal.personId === "usman" ? memUsman : { id: "mehroz", name: "Mehroz", via: "tailnet", actor: "human" };
    if (!(await commandRoute({ path, method: req.method || "GET", url, body, principal, req, res, service, send, memoryCaller }))) send({ error: "Not found" }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const headersFor = (who: Who): Record<string, string> => (who === "local" ? { host: `127.0.0.1:${port}` } : { host: `${TAILNET}:8443`, "tailscale-user-login": hub.headersFor(who)["tailscale-user-login"], "x-forwarded-for": hub.headersFor(who)["x-forwarded-for"] });
  /** The voice client's transport for one person (their browser). `drop` kills the first stream after N events. */
  function transport(who: Who, drop?: { afterEvents: number }) {
    let dropped = false;
    const post: CommandPost = async (path, body, signal) => {
      const res = await fetch(`http://127.0.0.1:${port}/__operator${path}`, { method: "POST", headers: { ...headersFor(who), "content-type": "application/json" }, body: JSON.stringify(body), signal });
      if (!drop || dropped || path !== "/screen/command" || !res.body) return res;
      dropped = true;
      // Simulate the network dropping mid-stream: pass N lines, then error the body.
      const reader = res.body.getReader();
      let lines = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) return controller.close();
          lines += new TextDecoder().decode(value).split("\n").filter(Boolean).length;
          controller.enqueue(value);
          if (lines >= drop.afterEvents) {
            void reader.cancel();
            controller.error(new TypeError("network dropped (synthetic)"));
          }
        },
      });
      return new Response(stream, { status: res.status, headers: res.headers });
    };
    const get: CommandGet = (path, signal) => fetch(`http://127.0.0.1:${port}/__operator${path}`, { headers: headersFor(who), signal });
    return { post, get };
  }

  // ---- the REAL voice entry, with fake STT and TTS ---------------------------------------------------
  const voiceRoot = mkdtempSync(join(tmpdir(), "stage-c-voice-"));
  cleanups.push(() => rmSync(voiceRoot, { recursive: true, force: true }));
  let heard = "";
  const spokenOut: string[] = [];
  const voiceFetch = (async (url: string, init?: RequestInit) => {
    if (url.includes("/audio/transcriptions")) return json({ text: heard });
    if (url.includes("/audio/speech")) {
      spokenOut.push(String(JSON.parse(String(init?.body ?? "{}")).input ?? ""));
      return new Response(pcmToWav(new Uint8Array(64), 24000), { headers: { "Content-Type": "audio/wav" } });
    }
    // Jev (the voice router): OS pages are its call; everything else these tests say is claimed by rules first.
    // The F4 re-run: Jev unsure (so only rules and the command entry decide), and a fake brain that just says it was reached.
    if (url.includes("typesafe") && options.voiceJev === "unsure") return json({ answers: { category: { type: "choice", choice: "brain", confidence: 0.2 }, outbound: { type: "noul", noul: 0.01 }, multi: { type: "noul", noul: 0.01 }, complete: { type: "noul", noul: 0.5 } } });
    if (url.includes("/chat/completions") && options.brain) return json({ choices: [{ message: { role: "assistant", content: "[synthetic-brain] reached" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    if (url.includes("typesafe")) return json({ answers: { category: { type: "choice", choice: "os_page", confidence: 0.96 }, page: { type: "choice", choice: "/leads", confidence: 0.95 }, site: { type: "choice", choice: "none", confidence: 0.9 }, outbound: { type: "noul", noul: 0.01 }, multi: { type: "noul", noul: 0.01 }, complete: { type: "noul", noul: 0.95 } } });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const voice = freeVoice(voiceRoot, {
    key: (name) => ({ GROQ_API_KEY: "synthetic-groq", TYPESAFE_API_KEY: "synthetic-jev" } as Record<string, string>)[name] ?? "",
    fetch: voiceFetch,
    sink: new MemoryReceiptSink(),
    health: new MemoryHealthStore(),
    ...(memoryTurn
      ? { memory: async (utterance: string, turn: { caller: unknown; spokenYes: string | null; previousAssistant: string | null }) => (await memoryTurn!(turn.caller as typeof memUsman, utterance, { spokenYes: turn.spokenYes, previousAssistant: turn.previousAssistant }))?.content ?? null }
      : {}),
  });
  const wav = Buffer.from(pcmToWav(new Uint8Array(3200), 16000)).toString("base64");

  type Spoken = { text: string; tool: string | null; done: CommandDoneEvent | null; line: string; events: CommandStreamEvent[]; tts: unknown };
  /**
   * One spoken turn, end to end. The client half mirrors voice-companion.tsx's jarvisCommand() exactly:
   * Track 1's resolver first (navigate / open-url / ask), else runJarvisCommand to the server entry.
   */
  async function say(who: Who, words: string, opts: { page?: PageContextSnapshot | null; signal?: AbortSignal; drop?: { afterEvents: number }; previous?: { role: "assistant"; content: string }; observe?: boolean } = {}): Promise<Spoken> {
    heard = words;
    const stt = (await voice.handle("/voice/free/stt", { audio: wav, turn: who === "local" })) as { text: string };
    const user = { role: "user" as const, content: stt.text };
    const history = opts.previous ? [opts.previous, user] : [user];
    const first = (await voice.handle("/voice/free/turn", { messages: history, remote: who !== "local" }, who === "local" ? memUsman : undefined)) as { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    const call = first.tool_calls?.[0];
    const events: CommandStreamEvent[] = [];
    if (!call) {
      const tts = first.content ? await voice.handle("/voice/free/tts", { text: first.content }) : null;
      return { text: stt.text, tool: null, done: null, line: first.content ?? "", events, tts };
    }
    if (call.function.name === "navigate") {
      // The voice client's navigate tool (an OS page): the page opens in the UI; nothing acts on a device.
      const path = String(JSON.parse(call.function.arguments).path ?? "");
      const done: CommandDoneEvent = { type: "done", ok: true, said: `Opening ${path}.`, kind: "navigate", navigate: { path }, jobId: null, runId: "", targetDeviceId: null };
      return { text: stt.text, tool: "navigate", done, line: done.said, events, tts: await voice.handle("/voice/free/tts", { text: done.said }) };
    }
    // The F4 re-run records other client tools (planned only; nothing runs), everything else asserts the one entry.
    if (opts.observe && call.function.name !== "jarvis_command") return { text: stt.text, tool: call.function.name, done: null, line: `planned ${call.function.name} ${call.function.arguments}`.slice(0, 200), events, tts: null };
    expect(call.function.name).toBe("jarvis_command");
    const args = JSON.parse(call.function.arguments) as { utterance: string; spokenTarget?: string };
    let done: CommandDoneEvent;
    const route = voiceRouteFor(args.utterance, opts.page ?? null);
    if (route.route === "ask") done = { type: "done", ok: false, ask: true, said: route.said, kind: "ask", jobId: null, runId: "", targetDeviceId: null };
    else if (route.route === "navigate") done = { type: "done", ok: true, said: route.said, kind: "navigate", navigate: { path: route.href }, jobId: null, runId: "", targetDeviceId: null };
    else if (route.route === "open-url") done = { type: "done", ok: true, said: `Opened ${route.title}.`, kind: "browser", url: route.url, jobId: null, runId: "", targetDeviceId: null };
    else {
      const t = transport(who, opts.drop);
      done = await runJarvisCommand({
        utterance: args.utterance,
        source: "voice",
        ...(args.spokenTarget ?? route.spokenTarget ? { spokenTarget: args.spokenTarget ?? route.spokenTarget } : {}),
        pageContext: opts.page ?? null,
        signal: opts.signal,
        post: t.post,
        get: t.get,
        onEvent: (e) => events.push(e),
        reconnect: { graceMs: 3000, delaysMs: [50, 100, 200, 400] },
      });
    }
    const content = commandResultText(done);
    const second = (await voice.handle("/voice/free/turn", { messages: [...history, { role: "assistant", content: null, tool_calls: first.tool_calls }, { role: "tool", tool_call_id: call.id, content }], remote: who !== "local" })) as { content: string | null };
    const line = second.content ?? "";
    const tts = line ? await voice.handle("/voice/free/tts", { text: line }) : null;
    return { text: stt.text, tool: call.function.name, done, line, events, tts };
  }

  /** A typed command from the palette: the same client function, source "typed". */
  async function type(who: Who, words: string, page: PageContextSnapshot | null = null) {
    const t = transport(who);
    const events: CommandStreamEvent[] = [];
    const done = await runJarvisCommand({ utterance: words, source: "typed", pageContext: page, post: t.post, get: t.get, onEvent: (e) => events.push(e) });
    return { done, events };
  }

  async function pairCompanion(owner: "usman" | "mehroz", label: string, aliases: string[], executors: Record<string, Executor>, opts: { mic?: boolean; flaky?: { down: boolean } } = {}) {
    const issuer = owner === "usman" ? hub.browser("local") : hub.browser("mehroz");
    if (owner === "mehroz") await issuer.post("/pair/tailnet", { label: "Mehroz's browser" });
    const code = (await issuer.post("/pair/code", { purpose: "companion" })).json.code as string;
    const headers = hub.headersFor(owner as Who);
    const res = await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code, label, aliases }) });
    const paired = (await res.json()) as { token: string; deviceId: string };
    expect(res.status).toBe(200);
    const lockDir = mkdtempSync(join(tmpdir(), "stage-c-mic-"));
    cleanups.push(() => rmSync(lockDir, { recursive: true, force: true }));
    const worker = new CompanionWorker({
      hubUrl: hub.base,
      token: paired.token,
      deviceId: paired.deviceId,
      owner,
      extraHeaders: headers,
      heartbeatMs: 40,
      pollWaitMs: 300,
      micLock: opts.mic ? new MicLock(join(lockDir, "mic.lock")) : null,
      executors,
      fetchImpl: (async (input: string, init?: RequestInit) => {
        if (opts.flaky?.down) throw new Error("network down (synthetic)");
        return fetch(input, init);
      }) as typeof fetch,
      log: () => undefined,
    }).start();
    cleanups.push(() => worker.stop());
    expect(await worker.waitOnline()).toBe(true);
    return { worker, deviceId: paired.deviceId };
  }

  return {
    hub, h, j, runs, service, say, type, pairCompanion, spokenOut, t3,
    jobs: () => jobs,
    entryCalls: () => entryCalls,
    reopenJobs: () => {
      try {
        jobs.close();
      } catch {
        /* still running in-process: a restart would kill it */
      }
      jobs = new JobService({ path: jobsPath, stopGraceMs: 1500, snapshotMs: 0 });
      return jobs;
    },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;
const job = (r: Rig, id: string | null) => (id ? r.jobs().get(id) : null);

// ---- Stage C, item by item ------------------------------------------------------------------------------
describe("Stage C (SYNTHETIC) through the real voice entry", () => {
  test("YouTube control: search, open the first result, pause — in the app-owned browser, one job, spoken line", async () => {
    const r = await rig({ jev: jev("browser.search", 0.9) });
    const s = await r.say("local", "Search YouTube for synthetic lo-fi beats and play the first video, then pause it");
    expect(s.tool).toBe("jarvis_command");
    expect(s.done).toMatchObject({ ok: true, kind: "browser", targetDeviceId: "usman-pc" });
    expect(r.h.youtube).toEqual(["search:synthetic lo-fi beats", "open:1", "pause"]);
    const j = job(r, s.done!.jobId)!;
    expect(j).toMatchObject({ kind: "voice", state: "succeeded", targetDeviceId: "usman-pc", principal: { personId: "usman", via: "loopback-owner" } });
    expect(j.steps.some((st) => st.jev?.op === "browser.youtube" && st.jev.policy === "act")).toBe(true);
    expect(j.steps.some((st) => st.verification?.ok === true)).toBe(true);
    expect(s.line).toBe(s.done!.said);
    expect(r.spokenOut.at(-1)).toBe(s.line);
    // Concise speech: only the one line per act was marked to speak; the rest is in the job.
    expect(s.events.filter((e) => e.type === "narrate" && e.speak).length).toBeLessThanOrEqual(4);
  }, T);

  test("public-video analysis: what matters, with the evidence actually available (transcript timestamps checked)", async () => {
    const r = await rig({ jev: jev("browser.search", 0.9) });
    await r.say("local", "Search YouTube for synthetic receptionist tips and open the first video");
    const s = await r.say("local", "Tell me what matters in this video on YouTube");
    expect(s.done).toMatchObject({ ok: true, kind: "browser" });
    const j = job(r, s.done!.jobId)!;
    expect(j.steps.some((st) => /Watch source: transcript; 2\/2 timestamps verified/.test(st.intent))).toBe(true);
    expect(s.line).toMatch(/0:12|three rings/);
  }, T);

  test("PowerPoint: a new never-saved deck with a title slide (verified by read-back); a named deck by COM ops", async () => {
    const r = await rig();
    const blank = await r.say("local", "Open a new PowerPoint and add a title slide 'Synthetic Q3 plan'");
    expect(blank.done).toMatchObject({ ok: true, kind: "app", verified: true, decision: { op: "deck.blank", policy: "act", deviceId: "usman-pc" } });
    expect(r.h.blank).toEqual(["Synthetic Q3 plan"]);
    const named = await r.say("local", "Create a deck called synthetic-board with the title 'Board pack' and show it");
    expect(named.done?.ok).toBe(true);
    expect(r.h.decks.map((d) => d.op)).toEqual(["create", "show"]);
    expect(job(r, named.done!.jobId)?.state).toBe("succeeded");
  }, T);

  test("OS and app navigation: an app opens on his PC (checked); an OS page opens in the UI; typed and spoken take the same path", async () => {
    const r = await rig();
    const spoken = await r.say("local", "Open Notepad");
    expect(spoken.done).toMatchObject({ ok: true, kind: "app", targetDeviceId: "usman-pc", decision: { op: "app.open", target: "notepad" } });
    const typed = await r.type("local", "Open Notepad");
    expect(typed.done).toMatchObject({ ok: true, kind: "app", targetDeviceId: "usman-pc", decision: { op: "app.open", target: "notepad" } });
    expect(r.h.apps).toEqual(["notepad", "notepad"]);
    // Same destination: identical decisions apart from ids; one job each, kinds voice vs command.
    expect(job(r, spoken.done!.jobId)?.kind).toBe("voice");
    expect(job(r, typed.done!.jobId)?.kind).toBe("command");
    const page = await r.say("local", "Take me to the leads page");
    expect(page.done).toMatchObject({ ok: true, kind: "navigate" });
    expect(page.done!.navigate!.path).toBe("/leads");
    expect(page.tool).toBe("navigate"); // Jev (the voice router) chose the page
    // Typed, the same words reach the same page (the server's registry lane; no device acts).
    const typedPage = await r.type("local", "Take me to the leads page");
    expect(typedPage.done).toMatchObject({ ok: true, kind: "navigate", navigate: { path: "/leads" }, targetDeviceId: "none", decision: { op: "navigate", source: "registry" } });
    const typing = await r.say("local", "Open Notepad and type 'M&U synthetic test line'");
    expect(typing.done).toMatchObject({ ok: true, verified: true, decision: { op: "notepad.type" } });
    expect(r.h.notepad).toEqual(["M&U synthetic test line"]);
  }, T);

  test("authorised files: found by name inside the authorised folder and confirmed by its window; secrets refused", async () => {
    const r = await rig();
    const s = await r.say("local", "Open the file quarterly-plan");
    expect(s.done).toMatchObject({ ok: true, kind: "file", verified: true });
    expect(r.h.opened).toHaveLength(1);
    const secret = await r.say("local", "Open the file agentic-os.env");
    expect(secret.done?.ok).toBe(false);
    expect(r.h.opened).toHaveLength(1);
  }, T);

  test("memory: save, recall, correct (asked once, a spoken yes) and forget-asks — the shared memory path", async () => {
    const r = await rig({ memory: true });
    const save = await r.say("local", "Remember that the synthetic Heron clinic parks behind gate C");
    expect(save.tool).toBeNull(); // memory has its own voice rules (Stage D); the job-backed typed path shares its API
    expect(save.line).toContain("Hindsight memory");
    const recall = await r.say("local", "What do we know about the Heron clinic?");
    expect(recall.line).toMatch(/gate C/i);
    const ask = await r.say("local", "Correct that: the synthetic Heron clinic parks behind gate D.");
    expect(ask.line).toContain("Say yes to update it");
    const yes = await r.say("local", "yes", { previous: { role: "assistant", content: ask.line } });
    expect(yes.line).toMatch(/updated|corrected/i);
    const forget = await r.say("local", "Forget that");
    expect(forget.line).toMatch(/Say yes to approve/i);
    // Typed: the same memory API through the command service, recorded as a job.
    const typed = await r.type("local", "What do we know about the Heron clinic?");
    expect(typed.done).toMatchObject({ ok: true, decision: { op: "memory.voice", delegateTo: "memory" } });
    expect(typed.done.said).toMatch(/gate D/i);
    expect(job(r, typed.done.jobId)?.state).toBe("succeeded");
  }, 90_000);

  test("receptionist and finance: state from its feed; margins from the economics model; 'explain this margin' from the page", async () => {
    const r = await rig();
    const rx = await r.say("local", "How's the receptionist doing today?");
    expect(rx.done).toMatchObject({ ok: true, decision: { op: "receptionist.status", delegateTo: "receptionist" } });
    expect(rx.line).toContain("Source: receptionist dashboard (Retell and the agency feed), read ");
    const margin = await r.say("local", "What's our margin on the Professional package with 8 clients?");
    expect(margin.done).toMatchObject({ ok: true, kind: "answer", verified: true, numbers: { clients: 8, source: expect.stringContaining("business-economics") } });
    // Page context: the Operations page with Professional selected. Numbers come from code, never the page.
    const ops: PageContextSnapshot = {
      version: 1,
      page: { path: "/operations", destination: "operations", title: "Operations" },
      selection: { kind: "package", id: "receptionist-professional", label: "Professional package", facts: { contributionMarginPct: "999%" } },
      focused: null,
      visible: [],
      sources: [],
      job: null,
      providers: ["operations"],
      at: Date.now(),
    };
    const typed = await r.type("local", "Explain this margin", ops);
    expect(typed.done).toMatchObject({ ok: true, kind: "answer", decision: { op: "answer.margin", source: "context" } });
    expect(typed.done.said).toContain("Source: src/lib/receptionist-packages.ts + src/lib/business-economics.ts");
    expect(typed.done.said).toMatch(/doesn't match the model/); // a stale page figure is called out, not repeated
  }, T);

  test("'open that call' resolves against the page; two calls → Jev asks; no page → says so; never guesses", async () => {
    const r = await rig();
    const base: PageContextSnapshot = { version: 1, page: { path: "/receptionist", destination: "receptionist", title: "Receptionist" }, selection: null, focused: null, visible: [], sources: [], job: null, providers: ["receptionist"], at: Date.now() };
    const one = { ...base, focused: { kind: "call" as const, id: "c1", label: "Call 11:02 am (synthetic)", to: "/receptionist", search: { call: "c1" } } };
    const s = await r.type("local", "Open that call", one);
    expect(s.done).toMatchObject({ ok: true, kind: "navigate", navigate: { path: "/receptionist?call=c1" } });
    const two = { ...base, visible: [{ kind: "call" as const, id: "c1", label: "Call A" }, { kind: "call" as const, id: "c2", label: "Call B" }] };
    const amb = await r.type("local", "Open that call", two);
    expect(amb.done).toMatchObject({ ok: false, ask: true, decision: { policy: "ask", source: "context" } });
    const none = await r.type("local", "Open that call", null);
    expect(none.done).toMatchObject({ ok: false, ask: true });
    expect(none.done.said).toMatch(/can't see which page/);
  }, T);

  test("coding work is Track 3's: typed and spoken open its draft page (nothing starts here); never the screen", async () => {
    const r = await rig();
    const words = "Assign Codex to fix the flaky synthetic login test in the receptionist repo";
    const typed = await r.type("local", words);
    expect(typed.done.decision?.op).not.toBe("coding.assign");
    expect(r.h.screen).toHaveLength(0);
    if (r.t3) {
      // T3's draft → plan → "Start it?": no job is started by the command entry, for either founder.
      expect(typed.done).toMatchObject({ ok: true, kind: "navigate", decision: { op: "coding.draft", delegateTo: "coding" } });
      expect(typed.done.navigate!.path).toMatch(/^\/coding\?request=/);
      expect(typed.done.said).toContain("Start it?");
      const spoken = await r.say("local", words);
      expect(spoken.done?.navigate?.path).toBe(typed.done.navigate!.path);
      const mehroz = await r.type("mehroz", words);
      expect(mehroz.done).toMatchObject({ ok: true, kind: "navigate", decision: { op: "coding.draft" } });
      expect(mehroz.done.refused).toBeUndefined();
      expect(r.jobs().list({ kind: "coding", limit: 10 })).toHaveLength(0);
    }
  }, T);


  test("interrupt/stop: saying stop mid-task cancels the job through the job service; the loop stops between steps", async () => {
    const r = await rig({ slowNotepad: 4000 });
    const stop = new AbortController();
    const running = r.say("local", "Open Notepad and type 'a long synthetic line'", { signal: stop.signal });
    expect(await until(() => r.h.notepad.length === 1)).toBe(true);
    stop.abort();
    const s = await running;
    expect(s.done).toMatchObject({ ok: false, stopped: true });
    const j = job(r, s.done!.jobId);
    expect(j?.state).toBe("cancelled");
    expect(j?.cancelRequested).toBe(true);
  }, T);

  test("reconnect: the stream drops mid-task, the client re-attaches and hears the real outcome (no re-run)", async () => {
    const r = await rig({ slowNotepad: 600 });
    const s = await r.say("local", "Open Notepad and type 'reconnect synthetic line'", { drop: { afterEvents: 2 } });
    expect(s.done).toMatchObject({ ok: true, verified: true });
    expect(r.h.notepad).toHaveLength(1); // ran once
    expect(job(r, s.done!.jobId)?.state).toBe("succeeded");
  }, T);

  test("a dropped stream nobody re-attaches to is cancelled after the grace period", async () => {
    const r = await rig({ slowNotepad: 4000, graceMs: 200 });
    const events: CommandStreamEvent[] = [];
    const emit = (e: CommandStreamEvent) => void events.push(e);
    const started = r.service.run({ principal: { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman", deviceId: "usman-pc" }, body: { utterance: "Open Notepad and type 'abandoned synthetic line'", source: "typed" } }, emit);
    expect(await until(() => events.some((e) => e.type === "job"))).toBe(true);
    const jobId = (events.find((e) => e.type === "job") as { jobId: string }).jobId;
    // The client's stream closed without a done, and nobody re-attaches.
    r.service.dropped(jobId, emit);
    const done = await started;
    expect(done.stopped).toBe(true);
    expect(r.jobs().get(jobId)?.state).toBe("cancelled");
  }, T);

  test("recover: a restart marks a running job unknown and never re-runs it", async () => {
    const r = await rig();
    const jobs = r.jobs();
    const j = jobs.create({ kind: "voice", principal: { personId: "usman", via: "loopback-owner" }, targetDeviceId: "usman-pc", title: "Synthetic in-flight command" });
    jobs.begin(j.id);
    const fresh = r.reopenJobs();
    expect(fresh.recover()).toMatchObject({ unknown: 1 });
    expect(fresh.get(j.id)).toMatchObject({ state: "unknown" });
    const again = await fresh.run(j.id, async () => ({ ok: true }));
    expect(again).toMatchObject({ admitted: false, reason: "not-queued" });
  }, T);

  test("the job records who asked, never the server-only session key", async () => {
    const r = await rig();
    const done = await r.service.run({ principal: { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman", deviceId: "usman-pc", sessionId: "server-only-session-key-synthetic" }, body: { utterance: "Open Notepad", source: "typed" } });
    const j = job(r, done.jobId)!;
    expect(j.principal).toEqual({ personId: "usman", via: "loopback-owner", actor: "human", deviceId: "usman-pc" });
    expect(JSON.stringify(j)).not.toContain("server-only-session-key");
  }, T);

  test("S2d: a money request is not refused in code (it reaches routing), and nothing executes", async () => {
    const r = await rig();
    for (const words of ["Transfer 500 dollars to John from my NAB account on my laptop", "Buy 10 shares of BHP on CommSec"]) {
      const typed = await r.type("local", words);
      expect(typed.done.decision?.op).not.toBe("refuse");
      expect(typed.done.ok).toBe(false);
    }
    // The screen executor refuses the money goal before any step, and no app was opened.
    expect(r.h.apps.length + r.h.screen.length).toBe(0);
  }, T);
});

describe("AUDIT-F4 rows owned by Track 2 (SYNTHETIC, the real voice entry)", () => {
  test("F9 prices and margins by voice come from code, not a model", async () => {
    const r = await rig();
    const price = await r.say("local", "How much is the Premium package?");
    expect(price.done).toMatchObject({ ok: true, kind: "answer", targetDeviceId: "none", decision: { op: "answer.price", source: "rules" } });
    expect(price.line).toContain("Premium: A$1,999.00 a month ex GST (approved)");
    const margin = await r.say("mehroz", "What's the margin on Essential with 10 clients in a busy month?");
    expect(margin.done).toMatchObject({ ok: true, kind: "answer", targetDeviceId: "none", numbers: { clients: 10, scenario: "high" } });
    expect(r.entryCalls()).toBe(0); // no device, and no hub, for an answer
  }, T);

  test("F11 lead actions by voice: mark won, log a call, who's next — written and read back", async () => {
    const r = await rig();
    const won = await r.say("mehroz", "Mark Synthetic Physio Studio as won");
    expect(won.done).toMatchObject({ ok: true, verified: true, decision: { op: "leads.action", delegateTo: "leads" } });
    expect(won.line).toBe("Marked Synthetic Physio Studio as won.");
    const logged = await r.say("local", "Log a call to Synthetic Dental Co as no answer");
    expect(logged.line).toBe("Logged a call to Synthetic Dental Co as no answer.");
    const next = await r.say("local", "Who should I call next?");
    expect(next.line).toMatch(/^Next to call: Synthetic Dental Co/);
    expect(r.h.leads[0]).toMatch(/^mehroz:/); // who asked is the verified principal
  }, T);

  test("F13 'remember to …' becomes a real reminder (typed through the service; spoken through the reminder skill)", async () => {
    const r = await rig();
    const typed = await r.type("local", "Remember to call Mehroz at 5 pm");
    expect(typed.done).toMatchObject({ ok: true, decision: { op: "reminder.set", delegateTo: "reminder" } });
    expect(r.h.reminders).toEqual(["remind me to call Mehroz at 5 pm"]);
  }, T);

  test("F10 device routing by voice: Mehroz's 'lock the PC' never touches the hub; a named machine is routed", async () => {
    const r = await rig();
    await r.pairCompanion("mehroz", "Mehroz's PC", ["pc"], {});
    const lock = await r.say("mehroz", "Lock the PC");
    expect(lock.tool).toBe("jarvis_command");
    expect(lock.done).toMatchObject({ ok: false, refused: true });
    expect(r.entryCalls()).toBe(0);
    const laptop = await r.say("local", "Open Chrome on my laptop");
    expect(laptop.done).toMatchObject({ ok: false });
    expect(laptop.done!.said).toMatch(/none of your devices is called "my laptop"/);
    expect(r.h.apps).toHaveLength(0);
  }, T);

  test("F14 'cancel that' typed while a command runs stops it through the job service", async () => {
    const r = await rig({ slowNotepad: 4000 });
    const running = r.type("local", "Open Notepad and type 'long synthetic line'");
    expect(await until(() => r.h.notepad.length === 1)).toBe(true);
    const stop = await r.type("local", "cancel that");
    expect(stop.done).toMatchObject({ ok: true, stopped: true });
    const done = (await running).done;
    expect(done).toMatchObject({ ok: false, stopped: true });
    expect(job(r, done.jobId)?.state).toBe("cancelled");
  }, T);
});

describe("device routing (SYNTHETIC): separate sign-ins, shared workspace, the requester's own computer", () => {
  const companionExecutors = (log: string[], opts: { hold?: { release?: () => void } } = {}): Record<string, Executor> => ({
    "app.open": async (args) => (log.push(`app.open:${String(args.name)}`), verified(`Opened ${String(args.name)}.`, "a new window appeared")),
    "notepad.type": async (args) => (log.push(`notepad.type:${String(args.text)}`), verified("Typed into a new Notepad document and read it back.", "read-back matched")),
    "deck.blank": async (args, ctx) => {
      log.push(`deck.blank:${String(args.title)}`);
      if (opts.hold) await new Promise<void>((resolve, reject) => {
        opts.hold!.release = resolve;
        ctx.signal.addEventListener("abort", () => reject(new Error("Cancelled.")), { once: true });
      });
      return verified("New presentation, title read back.", "COM read-back");
    },
    "open-url": async (args) => (log.push(`open-url:${String(args.url)}`), { ok: true, said: `Asked the default browser to open ${String(args.url)}.`, verified: null }),
  });

  test("Mehroz's command runs on HIS companion, never the hub; the job names his device", async () => {
    const r = await rig();
    const log: string[] = [];
    const m = await r.pairCompanion("mehroz", "Mehroz's PC", ["pc", "desktop"], companionExecutors(log), { mic: true });
    const s = await r.say("mehroz", "Open Notepad and type 'hello from Mehroz synthetic'");
    expect(s.done).toMatchObject({ ok: true, kind: "remote", targetDeviceId: m.deviceId, verified: true, decision: { op: "notepad.type", deviceId: m.deviceId } });
    expect(log).toEqual(["notepad.type:hello from Mehroz synthetic"]);
    expect(r.entryCalls()).toBe(0); // the hub's hands never ran
    const j = job(r, s.done!.jobId)!;
    expect(j).toMatchObject({ targetDeviceId: m.deviceId, principal: { personId: "mehroz" }, state: "succeeded" });
    expect(j.steps.some((st) => st.executor === "companion" && st.verification?.ok === true)).toBe(true);
    // Mic ownership: his voice originates at the companion holding his mic.
    expect(r.hub.svc.registry.micOwner("mehroz")).toBe(m.deviceId);
  }, T);

  test("naming someone else's device is refused; the hub is never a fallback for Mehroz", async () => {
    const r = await rig();
    const s = await r.type("mehroz", "Open Notepad on Usman's PC");
    expect(s.done).toMatchObject({ ok: false, refused: true });
    expect(s.done.said).toMatch(/belongs to usman|isn't yours|own devices/i);
    // No companion paired: nothing is re-routed to the hub either.
    const none = await r.type("mehroz", "Open Notepad");
    expect(none.done).toMatchObject({ ok: false });
    expect(none.done.said).toMatch(/no device registered for mehroz/);
    expect(r.entryCalls()).toBe(0);
    expect(r.h.apps).toHaveLength(0);
  }, T);

  test("simultaneous users: Usman on the hub and Mehroz on his PC at the same time, separate jobs, no cross-talk", async () => {
    const r = await rig();
    const log: string[] = [];
    const hold: { release?: () => void } = {};
    await r.pairCompanion("mehroz", "Mehroz's PC", ["pc"], companionExecutors(log, { hold }));
    const mehroz = r.type("mehroz", "Open a new PowerPoint and add a title slide 'Mehroz synthetic'");
    expect(await until(() => log.length === 1)).toBe(true);
    const usman = await r.type("local", "Open a new PowerPoint and add a title slide 'Usman synthetic'");
    expect(usman.done).toMatchObject({ ok: true, targetDeviceId: "usman-pc" });
    hold.release?.();
    const m = await mehroz;
    expect(m.done).toMatchObject({ ok: true, kind: "remote" });
    expect(r.h.blank).toEqual(["Usman synthetic"]);
    expect(log).toEqual(["deck.blank:Mehroz synthetic"]);
    expect(job(r, m.done.jobId)?.principal.personId).toBe("mehroz");
    expect(job(r, usman.done.jobId)?.principal.personId).toBe("usman");
  }, T);

  test("cancel a remote command mid-run: the companion aborts it, the job is cancelled", async () => {
    const r = await rig();
    const log: string[] = [];
    const hold: { release?: () => void } = {};
    await r.pairCompanion("mehroz", "Mehroz's PC", ["pc"], companionExecutors(log, { hold }));
    const stop = new AbortController();
    const t = (r as Rig).say("mehroz", "Open a new PowerPoint and add a title slide 'Cancel me synthetic'", { signal: stop.signal });
    expect(await until(() => log.length === 1)).toBe(true);
    stop.abort();
    const s = await t;
    expect(s.done).toMatchObject({ ok: false, stopped: true });
    expect(job(r, s.done!.jobId)?.state).toBe("cancelled");
  }, T);

  test("offline recovery: his companion drops mid-command → the job fails naming his device; nothing runs elsewhere", async () => {
    const r = await rig();
    const log: string[] = [];
    const hold: { release?: () => void } = {};
    const flaky = { down: false };
    const m = await r.pairCompanion("mehroz", "Mehroz's PC", ["pc"], companionExecutors(log, { hold }), { flaky });
    const pending = r.type("mehroz", "Open a new PowerPoint and add a title slide 'Offline synthetic'");
    expect(await until(() => log.length === 1)).toBe(true);
    flaky.down = true;
    r.hub.svc.dispatcher.deviceOffline(m.deviceId);
    const s = await pending;
    expect(s.done).toMatchObject({ ok: false, targetDeviceId: m.deviceId });
    expect(s.done.said).toMatch(/Mehroz's PC went offline|offline/);
    expect(r.entryCalls()).toBe(0);
    // And a new command while it's offline fails at once, naming the device.
    const next = await r.type("mehroz", "Open Notepad");
    expect(next.done.said).toMatch(/Mehroz's PC is offline/);
    expect(job(r, next.done.jobId)?.targetDeviceId).toBe(m.deviceId);
  }, T);

  test("a request the companion can't run (the screen loop) is refused plainly, not sent anywhere else", async () => {
    const r = await rig();
    await r.pairCompanion("mehroz", "Mehroz's PC", ["pc"], companionExecutors([]));
    const s = await r.type("mehroz", "Click the Save button in there");
    expect(s.done).toMatchObject({ ok: false, refused: true, kind: "refused" });
    expect(s.done.said).toMatch(/needs Usman's PC's screen loop/);
    expect(r.entryCalls()).toBe(0);
  }, T);

  test("Usman over Tailscale can't drive the hub's screen remotely; at the PC he can", async () => {
    const r = await rig();
    const remote = await r.type("usman", "Open Notepad");
    expect(remote.done).toMatchObject({ ok: false, refused: true });
    expect(remote.done.said).toMatch(/only for someone sitting at it/);
    const local = await r.type("local", "Open Notepad");
    expect(local.done.ok).toBe(true);
  }, T);
});

// ---- AUDIT-F4 re-run of the rows Track 2 owns (SYNTHETIC; Jev unsure + a fake brain, so only rules and the entry decide) ----
const F4_ROWS: Array<{ id: string; text: string; person?: "mehroz"; page?: boolean }> = [
  { id: "L04", text: "who should I call next" },
  { id: "L07", text: "log a call to Synthetic Dental Co as no answer" },
  { id: "L08", text: "mark Synthetic Physio Studio as won" },
  { id: "P01", text: "what's our margin on the Professional package" },
  { id: "P02", text: "explain this margin", page: true },
  { id: "P03", text: "what's the margin on Essential with 10 clients in a busy month" },
  { id: "P04", text: "how much is the Premium package" },
  { id: "M05", text: "save this to the vault: the F4 audit ran on 28 September" },
  { id: "M06", text: "find my notes about pricing" },
  { id: "M08", text: "remember to call Mehroz at 5 pm" },
  { id: "C01", text: "Jarvis, fix the login bug in the dental site" },
  { id: "C02", text: "assign Codex to fix the failing tests in AgenticOS" },
  { id: "C04", text: "ask Claude to review the receptionist branch" },
  { id: "D01", text: "open Notepad" },
  { id: "D02", text: "open Chrome on my laptop" },
  { id: "D03", text: "open PowerPoint" },
  { id: "D04", text: "create a PowerPoint deck called Audit Test" },
  { id: "D06", text: "open the file Synthetic Proposal" },
  { id: "D07", text: "open github.com" },
  { id: "D11", text: "open Chrome", person: "mehroz" },
  { id: "D12", text: "open File Explorer" },
  { id: "Y02", text: "search YouTube for lo-fi study music" },
  { id: "Y05", text: "watch this video and tell me what matters" },
  { id: "Y06", text: "search YouTube for Hormozi offers and play the first video" },
  { id: "X01", text: "stop" },
  { id: "X02", text: "cancel that" },
  { id: "$02", text: "transfer $500 to Mehroz" },
  { id: "$03", text: "buy 10 shares of Apple" },
  // AUDIT-F2 additions: receptionist, finance and memory give the same answer typed and spoken.
  { id: "R01", text: "receptionist status" },
  { id: "R03", text: "any receptionist calls today" },
  { id: "R04", text: "any flagged calls" },
  { id: "R05", text: "how many bookings did the receptionist make this week" },
  { id: "R06", text: "is the receptionist ready to sell" },
  { id: "F01", text: "what did I spend this month" },
  { id: "M01", text: "remember that Synthetic Dental Co prefers calls before 10 am" },
  { id: "M02", text: "what do we know about Synthetic Dental Co" },
];

describe("AUDIT-F4 re-run (SYNTHETIC): Track 2 rows, typed vs spoken through the one entry", () => {
  test("every owned row: typed and spoken reach the same destination, and the owned expectations hold", async () => {
    const r = await rig({ voiceJev: "unsure", brain: true, jev: jev("brain", 0.3), memory: true });
    const ops: PageContextSnapshot = { version: 1, page: { path: "/operations", destination: "operations", title: "Operations" }, selection: { kind: "package", id: "receptionist-professional", label: "Professional package" }, focused: null, visible: [], sources: [], job: null, providers: ["operations"], at: Date.now() };
    const rows: Array<Record<string, unknown>> = [];
    for (const row of F4_ROWS) {
      const who: Who = row.person === "mehroz" ? "mehroz" : "local";
      const page = row.page ? ops : null;
      const spoken = await r.say(who, row.text, { page, observe: true });
      const typed = await r.type(who, row.text, page);
      // A page opened is compared by its path (the palette/voice client and the server open the same page).
      const dest = (d: CommandDoneEvent | null, tool: string | null) => (d ? (d.kind === "navigate" && d.navigate ? `navigate:${d.navigate.path}` : `${d.kind}:${d.decision?.op ?? ""}:${d.targetDeviceId ?? ""}`) : `tool:${tool}`);
      // The destination SERVICE: a skill spoken (the client runs it) and the same skill typed (the server runs it)
      // are one destination; a memory rule spoken and the memory delegate typed are one too (compared by answer).
      const spokenSkill = spoken.tool === "skill" ? /"skill":"(\w+)"/.exec(spoken.line)?.[1] : undefined;
      const service = (x: string, skill?: string) => (skill ? `skill:${skill}` : x.replace(/^answer:skill\.(\w+):none$/, "skill:$1").replace(/^answer:reminder\.set:none$/, "skill:reminder"));
      // Typed runs right after spoken, so a save typed second reads "Already remembered…": the same memory API.
      const memorySame = spoken.tool === null && typed.done.decision?.delegateTo === "memory" && (spoken.line === typed.done.said || spoken.line === spokenSafe(typed.done.said) || /^Already (?:remembered|in the vault)/.test(typed.done.said));
      const same = memorySame || service(dest(spoken.done, spoken.tool), spokenSkill) === service(dest(typed.done, null));
      rows.push({ id: row.id, text: row.text, who, spokenTool: spoken.tool, spoken: service(dest(spoken.done, spoken.tool), spokenSkill), typed: service(dest(typed.done, null)), same, typedOk: typed.done.ok, said: typed.done.said.slice(0, 160), spokenLine: spoken.line.slice(0, 160) });
    }
    if (process.env.F4_RERUN_OUT) (await import("node:fs")).writeFileSync(process.env.F4_RERUN_OUT, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const by = Object.fromEntries(rows.map((x) => [x.id as string, x]));
    // The rows the lead assigned (device routing, lead actions, reminders, margins/prices) are right, typed = spoken.
    for (const id of ["L04", "L07", "L08", "P01", "P02", "P03", "P04", "D01", "D02", "D03", "D04", "D06", "D07", "D11", "D12", "Y05", "Y06"]) expect({ id, same: by[id].same }).toEqual({ id, same: true });
    // J2 (29 Sep): a plain YouTube search by VOICE is the agent-browser hands in Jarvis Chrome (Jev routes, agent-browser
    // acts); typed, it is still the command entry's browser executor until that lane moves to the same hands.
    expect({ spoken: by.Y02.spoken, typed: by.Y02.typed }).toEqual({ spoken: "skill:browser", typed: "browser:browser.youtube:usman-pc" });
    // C02/C04 are Track 3's words: on a tree with T3 merged, typed and spoken both open its Coding draft.
    if (r.t3)
      for (const id of ["C02", "C04"]) {
        expect({ id, same: by[id].same, typed: by[id].typed }).toMatchObject({ id, same: true, typed: expect.stringMatching(/^navigate:\/coding\?request=/) });
        expect(by[id].said).toContain("Start it?"); // T3's draft, not an immediate job
      }
    expect(by.P01.typed).toBe("answer:answer.margin:none");
    expect(by.P04.typed).toBe("answer:answer.price:none");
    expect(by.L08.typed).toMatch(/^answer:leads.action/);
    expect(by.D02.typedOk).toBe(false); // "my laptop" isn't one of Usman's devices: refused, not run on the hub
    expect(by.D11.typed).toMatch(/:none$|refused/); // Mehroz with no companion: refused, never the hub
    expect(by.D12.typed).toBe("app:app.open:usman-pc");
    expect(by.M08.typed).toBe("skill:reminder");
    expect(by.C01.typed).not.toMatch(/^screen:/); // F7: "fix the login bug" never clicks on the window in front
    // S2d: money requests are no longer refused in code; they route, and executing them stays refused.
    for (const id of ["$02", "$03"]) expect(by[id].typed).not.toMatch(/:refuse:/);
    // AUDIT-F2: receptionist questions reach the dashboard/feed with a cited source; finance and memory match spoken.
    for (const id of ["R01", "R03", "R04", "R05", "R06", "F01", "M01", "M02", "M05", "M08"]) expect({ id, same: by[id].same }).toEqual({ id, same: true });
    expect(by.R04.typed).toBe("answer:receptionist.flagged:none");
    expect(by.R04.said).toMatch(/^1 flagged call to act on\..*Source: receptionist dashboard/);
    expect(by.R03.said).toMatch(/^3 calls today, 3 answered\./);
    expect(by.R05.said).toMatch(/^4 bookings in the feed's last 7 days\./);
    expect(by.R06.said).toMatch(/^Not safe to sell\./);
    expect(by.F01.typed).toBe("skill:finance");
    expect(r.h.screen).toHaveLength(0);
  }, 120_000);
});

describe("REVIEW-T2 fixes (SYNTHETIC)", () => {
  test("#1 memory with writes OFF: a save is never reported done; the job isn't succeeded", async () => {
    const r = await rig({ memory: true, memoryWrites: false });
    for (const words of ["Save this to the vault: the synthetic review ran on 28 September", "Remember that the synthetic Heron clinic parks behind gate C"]) {
      const typed = await r.type("local", words);
      expect(typed.done).toMatchObject({ ok: false, decision: { delegateTo: "memory" } });
      expect(typed.done.said).toMatch(/nothing was saved/i);
      expect(job(r, typed.done.jobId)?.state).not.toBe("succeeded");
    }
  }, 90_000);

  test("#2 compound commands: nothing runs half-way, and the unsupported step is named", async () => {
    const r = await rig();
    for (const [words, step] of [
      ["Open Notepad and type 'hi John' then email it to John", "email it to John"],
      ["Open Notepad and type hello and save it as report.txt", "save it as report.txt"],
      ["Open Notepad and type 'hello' then press enter", "press enter"],
    ] as const) {
      const spoken = await r.say("local", words);
      const typed = await r.type("local", words);
      for (const d of [spoken.done!, typed.done]) {
        expect(d).toMatchObject({ ok: false, ask: true });
        expect(d.said).toContain(step);
        expect(d.said).toMatch(/haven't done any of it/);
      }
    }
    expect(r.h.notepad).toHaveLength(0);
  }, T);

  test("#4 F16 read-only finance: typed answers like spoken; paying still refuses", async () => {
    const r = await rig();
    const typed = await r.type("local", "what's my bank balance");
    expect(typed.done.refused).toBeUndefined();
    expect(typed.done).toMatchObject({ ok: true, decision: { op: "skill.finance" } });
    const spoken = await r.say("local", "what's my bank balance", { observe: true });
    expect(spoken.tool).toBe("skill");
    const question = await r.type("local", "how much is in my NAB account?");
    expect(question.done.refused).toBeUndefined();
    expect(question.done.said).not.toMatch(/never drive|don't move money/);
    // S2d: paying is not refused in code any more; it routes, and nothing is paid or pressed.
    for (const words of ["pay the Telstra bill", "transfer $200 from my NAB account to Mehroz", "what's my balance, then pay the electricity bill"]) {
      const t = await r.type("local", words);
      expect(t.done.decision?.op).not.toBe("refuse");
      // Either the screen executor refused the payment, or only the read-only part ran (the balance).
      if (t.done.ok) expect(t.done.decision?.op).toBe("skill.finance");
    }
    expect(r.h.screen.length + r.h.apps.length).toBe(0);
  }, T);

  test("#5 job states: a final-button question awaits approval; a handoff is handed off; a stop after completion is succeeded", async () => {
    const q = await rig({ screenConfirm: "Send", jev: jev("screen_act", 0.95) });
    const ask = await q.type("local", "Send the draft in there");
    expect(ask.done).toMatchObject({ ok: false, ask: true, confirm: "Send" });
    expect(job(q, ask.done.jobId)?.state).toBe("awaiting-approval");
    // The next request settles it: never left hanging, never "failed".
    await q.type("local", "what's our margin on the Professional package");
    expect(job(q, ask.done.jobId)).toMatchObject({ state: "interrupted" });

    const h = await rig({ jev: jev("brain", 0.9) });
    const handoff = await h.type("local", "draft a proposal outline for a dental practice");
    expect(handoff.done).toMatchObject({ ok: false, kind: "handoff" });
    expect(job(h, handoff.done.jobId)).toMatchObject({ state: "succeeded", note: expect.stringMatching(/^Handed off to brain/) });

    const s = await rig();
    const events: CommandStreamEvent[] = [];
    // The stop lands exactly as the executor finishes (after its check): the race the review found.
    s.h.onNotepadDone = () => void s.jobs().cancel((events.find((e) => e.type === "job") as { jobId: string }).jobId);
    const done = await s.service.run({ principal: { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman", deviceId: "usman-pc" }, body: { utterance: "Open Notepad and type 'finished synthetic line'", source: "typed" } }, (e) => void events.push(e));
    expect(done).toMatchObject({ ok: true, stopped: true });
    expect(done.said).toMatch(/already finished when you said stop/);
    expect(s.jobs().get(done.jobId!)).toMatchObject({ state: "succeeded", quarantined: false });
    // And the next command is not blocked by a quarantine.
    expect((await s.type("local", "what's our margin on the Professional package")).done.ok).toBe(true);
  }, T);

  test("R2 #2 a stop the lane ignores is never called 'already finished': the reply says so and B2 quarantines it", async () => {
    const r = await rig({ slowAppMs: 400 });
    const events: CommandStreamEvent[] = [];
    const run = r.service.run({ principal: { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman", deviceId: "usman-pc" }, body: { utterance: "Open Notepad", source: "typed" } }, (e) => void events.push(e));
    expect(await until(() => r.h.apps.length === 1)).toBe(true);
    const jobId = (events.find((e) => e.type === "job") as { jobId: string }).jobId;
    void r.jobs().cancel(jobId); // at ~0 ms; the lane finishes at ~400 ms without looking at its signal
    const done = await run;
    expect(done.said).not.toMatch(/already finished/);
    expect(done.said).toMatch(/couldn't stop that in time/);
    expect(r.jobs().get(jobId)).toMatchObject({ state: "succeeded", quarantined: true });
  }, T);

  test("R2 compounds with a step before the typing or after a URL: nothing runs, the step is named", async () => {
    const r = await rig();
    for (const [words, step] of [
      ["email John and then open notepad and type hi", "email John"],
      ["send the report to Mehroz then open notepad and type hi", "send the report to Mehroz"],
      ["open https://example.com and then click the first link", "click the first link"],
      ["open https://example.com then log in", "log in"],
    ] as const) {
      const typed = await r.type("local", words);
      expect(typed.done).toMatchObject({ ok: false, ask: true });
      expect(typed.done.said).toContain(`"${step}"`);
    }
    expect(r.h.notepad).toHaveLength(0);
    expect(r.h.urls).toHaveLength(0);
  }, T);

  test("REVIEW-T3 F7b: a code change that only names a money feature is coding, typed and spoken; anything that spends is refused both ways", async () => {
    const r = await rig();
    for (const words of ["fix the checkout bug in the dental site", "update the PayID copy on the dental site", "implement BPAY support in the receptionist app"]) {
      const typed = await r.type("local", words);
      const spoken = await r.say("local", words, { observe: true });
      if (r.t3) {
        // T3 in the tree: its coding draft, typed and spoken (nothing is paid, nothing starts).
        expect({ words, kind: typed.done.kind, path: typed.done.navigate?.path?.split("?")[0] }).toEqual({ words, kind: "navigate", path: "/coding" });
        expect(spoken.done?.navigate?.path ?? spoken.line).toContain("/coding");
      } else {
        // T2 alone (no T3 carve-out yet): refused both ways — still the same answer typed and spoken.
        expect({ words, refused: typed.done.refused }).toEqual({ words, refused: true });
        expect(spoken.tool).toBeNull();
        expect(spoken.line).toMatch(/Nothing was done|never drive|don't pay/);
      }
    }
    // S2d: a request that also spends is no longer refused in code; whatever it routes to, nothing is paid.
    for (const words of ["fix the checkout bug in the dental site and then pay the invoice", "fix the $50 checkout bug in the dental site", "fix the checkout bug in the dental site and pay it for me"]) {
      const typed = await r.type("local", words);
      expect({ words, op: typed.done.decision?.op === "refuse" }).toEqual({ words, op: false });
      await r.say("local", words, { observe: true });
    }
    expect(r.h.screen).toHaveLength(0);
  }, T);

  test("R3: a stop during a slow page open or a named-deck step is honoured (cancelled, nothing quarantined)", async () => {
    for (const [opts, words] of [
      [{ slowPageMs: 600 }, "Open https://example.com"],
      [{ slowDeckMs: 600 }, "Create a deck called synthetic-slow with the title 'Slow' and show it"],
    ] as const) {
      const r = await rig(opts);
      const events: CommandStreamEvent[] = [];
      const run = r.service.run({ principal: { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman", deviceId: "usman-pc" }, body: { utterance: words, source: "typed" } }, (e) => void events.push(e));
      expect(await until(() => r.h.urls.length + r.h.decks.length === 1)).toBe(true);
      const jobId = (events.find((e) => e.type === "job") as { jobId: string }).jobId;
      await r.jobs().cancel(jobId);
      const done = await run;
      expect({ words, stopped: done.stopped, ok: done.ok }).toEqual({ words, stopped: true, ok: false });
      expect(done.said).toMatch(/Stopped\. (?:The page|PowerPoint) may still/);
      expect(r.jobs().get(jobId)).toMatchObject({ state: "cancelled", quarantined: false });
      expect((await r.type("local", "what's our margin on the Professional package")).done.ok).toBe(true); // not on hold
    }
  }, T);

  test("R4 F1: a step the stop couldn't cancel is recorded when it lands; the note never says it didn't happen", async () => {
    for (const [opts, words, landed] of [
      [{ slowDeckMs: 400 }, "Create a deck called synthetic-late with the title 'Late' and show it", /finished afterwards: create ok/],
      [{ slowPageMs: 400 }, "Open https://example.com", /finished afterwards: Opened example\.com/],
    ] as const) {
      const r = await rig(opts);
      const events: CommandStreamEvent[] = [];
      const run = r.service.run({ principal: { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman", deviceId: "usman-pc" }, body: { utterance: words, source: "typed" } }, (e) => void events.push(e));
      expect(await until(() => r.h.urls.length + r.h.decks.length === 1)).toBe(true);
      const jobId = (events.find((e) => e.type === "job") as { jobId: string }).jobId;
      await r.jobs().cancel(jobId);
      const done = await run;
      expect(done).toMatchObject({ ok: false, stopped: true });
      expect("lateWork" in done).toBe(false); // never on the wire
      // Right after the stop: cancelled, hedged — not "Stopped on request."
      expect(r.jobs().get(jobId)).toMatchObject({ state: "cancelled", quarantined: false, note: expect.stringMatching(/may still finish/) });
      // When the step lands, the job says what actually happened.
      expect(await until(() => /finished afterwards/.test(r.jobs().get(jobId)?.note ?? ""), 3000)).toBe(true);
      const j = r.jobs().get(jobId)!;
      expect(j.note).toMatch(landed);
      expect(j.steps.some((st) => st.executor === "late-result" && st.verification?.ok === true)).toBe(true);
    }
  }, T);

  test("#6 a yes after a jarvis_command final-button question goes to the screen gate, bound to that request", () => {
    const utterance = "Send the draft in there";
    const command = { id: "c1", type: "function" as const, function: { name: "jarvis_command", arguments: JSON.stringify({ utterance }) } };
    const result = JSON.stringify({ type: "command_result", ok: false, said: "Shall I press Send?", kind: "screen", confirm: "Send", ask: true });
    const messages = [
      { role: "user" as const, content: utterance },
      { role: "assistant" as const, content: null, tool_calls: [command] },
      { role: "tool" as const, tool_call_id: "c1", content: result },
      { role: "assistant" as const, content: "Shall I press Send?" },
      { role: "user" as const, content: "yes" },
    ];
    const answer = confirmAnswer(messages as never);
    expect(answer).toMatchObject({ reply: "yes", surface: "screen" });
    expect(answer?.call?.function.name).toBe("screen_act");
    expect(JSON.parse(answer!.call!.function.arguments)).toEqual({ goal: utterance, confirmed: true });
    // Not a whole-utterance yes → never confirms (S2's rule).
    const loose = confirmAnswer([...messages.slice(0, 4), { role: "user", content: "okay, open notepad instead" }] as never);
    expect(loose?.call ?? null).toBeNull();
  });
});
