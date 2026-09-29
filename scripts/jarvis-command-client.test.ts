import { afterEach, describe, expect, test } from "bun:test";
import type { CommandDoneEvent, CommandStreamEvent } from "./jarvis-command/contracts";
import {
  ATTACH_PATH,
  CANCEL_PATH,
  COMMAND_PATH,
  attachPath,
  commandResultText,
  createNdjsonParser,
  parseCommandEvent,
  parseNdjson,
  runJarvisCommand,
  runTypedCommand,
  type CommandGet,
  type CommandPost,
} from "../src/lib/jarvis-command";
import { PAGE_CONTEXT_BOUNDS, boundPageContext, commandPageContext, isOsPath, navigateSaid, planHref, routeVoiceCommand, voiceCommandIndex } from "../src/lib/jarvis-command";
import { buildCommandIndex, resolveCommand } from "../src/lib/commands/registry";
import type { Resolution } from "../src/lib/commands/types";
import { publishPageContext, readPageContext, resetPageContext, setActivePage, type ContextItem } from "../src/lib/page-context";

const originalWindow = (globalThis as any).window;
const fakeWindow = (pathname: string) => ({ location: { pathname }, dispatchEvent: () => true });
afterEach(() => {
  (globalThis as any).window = originalWindow;
  resetPageContext();
});

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const JOB = { type: "job", jobId: "job-1", targetDeviceId: "hub", deviceLabel: "This PC", seq: 1 };
const DECISION = {
  type: "decision",
  seq: 2,
  decision: { op: "app.open", target: "PowerPoint", confidence: 0.93, policy: "act", source: "jev", why: "named app", calibrationRunId: "cal-1" },
};
const NARRATE = { type: "narrate", stage: "act", text: "Opening PowerPoint.", speak: true, seq: 3 };
const STEP = { type: "step", did: "Launched PowerPoint", verified: true, ok: true, seq: 4 };
const DONE: CommandDoneEvent = { type: "done", ok: true, said: "PowerPoint is open.", kind: "app", jobId: "job-1", runId: "run-1", targetDeviceId: "hub", verified: true };

/** A streamed Response whose body is fed by the test (chunks, a clean close, or a network error). */
function controlledStream(signal?: AbortSignal) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const enc = new TextEncoder();
  let closed = false;
  signal?.addEventListener("abort", () => {
    if (closed) return;
    closed = true;
    ctrl.error(new DOMException("The operation was aborted.", "AbortError"));
  });
  return {
    response: new Response(stream, { headers: { "content-type": "application/x-ndjson" } }),
    send(text: string) {
      if (!closed) ctrl.enqueue(enc.encode(text));
    },
    close() {
      if (closed) return;
      closed = true;
      ctrl.close();
    },
    fail() {
      if (closed) return;
      closed = true;
      ctrl.error(new TypeError("network error"));
    },
  };
}

/** A body that arrives in fixed-size byte chunks (lines split mid-JSON, mid-UTF-8). */
function chunkedResponse(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let n = 0; n < bytes.length; n += size) c.enqueue(bytes.slice(n, n + size));
        c.close();
      },
    }),
  );
}

type Call = { method: "POST" | "GET"; path: string; body?: any };
function fakeTransport(handlers: { post?: (path: string, body: any, signal: AbortSignal) => Response | Promise<Response>; get?: (path: string, signal: AbortSignal) => Response | Promise<Response> }) {
  const calls: Call[] = [];
  const post: CommandPost = async (path, body, signal) => {
    calls.push({ method: "POST", path, body });
    if (path === CANCEL_PATH) return Response.json({ ok: true, state: "cancelled" });
    return handlers.post!(path, body, signal);
  };
  const get: CommandGet = async (path, signal) => {
    calls.push({ method: "GET", path });
    return handlers.get!(path, signal);
  };
  return { calls, post, get };
}

describe("NDJSON parsing", () => {
  test("a line split across chunks parses once, whole", () => {
    const parser = createNdjsonParser();
    const text = line(JOB) + line(NARRATE);
    const cut = 13;
    expect(parser.push(text.slice(0, cut))).toEqual([]);
    const rest = parser.push(text.slice(cut));
    expect(rest).toEqual([JOB, NARRATE]);
    expect(parser.flush()).toEqual([]);
  });

  test("blank and malformed lines are skipped; a trailing line without newline is flushed", () => {
    const values = parseNdjson(`\n{bad json\n${line(JOB)}   \n${JSON.stringify(DONE)}`);
    expect(values).toEqual([JOB, DONE]);
  });

  test("parseCommandEvent keeps wire events and rejects anything else", () => {
    expect(parseCommandEvent(JOB)?.type).toBe("job");
    expect(parseCommandEvent(DECISION)?.type).toBe("decision");
    expect(parseCommandEvent(NARRATE)?.type).toBe("narrate");
    expect(parseCommandEvent({ type: "job", seq: 1 })).toBeNull();
    expect(parseCommandEvent({ type: "done", said: "x" })).toBeNull();
    expect(parseCommandEvent({ type: "mystery" })).toBeNull();
    expect(parseCommandEvent(null)).toBeNull();
    const done = parseCommandEvent({ type: "done", ok: false, said: "no", kind: "weird" }) as CommandDoneEvent;
    expect(done.kind).toBe("unavailable");
    expect(done.jobId).toBeNull();
    expect(done.runId).toBe("");
  });

  test("attachPath encodes the job and the since cursor", () => {
    expect(attachPath("a b/c", 7)).toBe(`${ATTACH_PATH}?job=a%20b%2Fc&since=7`);
  });
});

describe("runJarvisCommand", () => {
  test("streams events in order from split chunks, captures the job id and resolves with done", async () => {
    const events: CommandStreamEvent[] = [];
    const t = fakeTransport({ post: () => chunkedResponse([JOB, DECISION, NARRATE, STEP, DONE].map(line).join(""), 5) });
    const done = await runJarvisCommand({ utterance: "open PowerPoint", source: "voice", pageContext: { page: "/operations" }, spokenYes: "yes-1", post: t.post, get: t.get, onEvent: (e) => events.push(e) });
    expect(done.ok).toBe(true);
    expect(done.said).toBe("PowerPoint is open.");
    expect(done.jobId).toBe("job-1");
    expect(events.map((e) => e.type)).toEqual(["job", "decision", "narrate", "step", "done"]);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].path).toBe(COMMAND_PATH);
    expect(t.calls[0].body).toEqual({ utterance: "open PowerPoint", source: "voice", pageContext: { page: "/operations" }, spokenYes: "yes-1" });
  });

  test("a done without jobId inherits the job event's id and device", async () => {
    const t = fakeTransport({ post: () => chunkedResponse(line(JOB) + line({ ...DONE, jobId: null, targetDeviceId: null })) });
    const done = await runJarvisCommand({ utterance: "x", source: "typed", pageContext: null, post: t.post, get: t.get });
    expect(done.jobId).toBe("job-1");
    expect(done.targetDeviceId).toBe("hub");
  });

  test("a dropped stream (network error) re-attaches with since=<last seq> and resumes to done", async () => {
    const events: CommandStreamEvent[] = [];
    const t = fakeTransport({
      post: (_p, _b, signal) => {
        const s = controlledStream(signal);
        s.send(line(JOB) + line(DECISION));
        setTimeout(() => s.fail(), 5);
        return s.response;
      },
      // The server replays from `since`; a duplicate of seq 2 must be ignored.
      get: () => chunkedResponse([DECISION, NARRATE, STEP, DONE].map(line).join(""), 9),
    });
    const done = await runJarvisCommand({ utterance: "open PowerPoint", source: "voice", pageContext: null, post: t.post, get: t.get, onEvent: (e) => events.push(e), reconnect: { delaysMs: [0] } });
    expect(done.ok).toBe(true);
    expect(done.said).toBe("PowerPoint is open.");
    const gets = t.calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(1);
    expect(gets[0].path).toBe(attachPath("job-1", 2));
    expect(events.map((e) => e.type)).toEqual(["job", "decision", "narrate", "step", "done"]);
    expect(t.calls.some((c) => c.path === CANCEL_PATH)).toBe(false);
  });

  test("a body that ends without done re-attaches too, retrying a failed attach", async () => {
    let attachTries = 0;
    const t = fakeTransport({
      post: () => chunkedResponse(line(JOB) + line(NARRATE)),
      get: () => {
        attachTries++;
        if (attachTries === 1) throw new TypeError("still offline");
        if (attachTries === 2) return new Response("busy", { status: 503 });
        return chunkedResponse(line(STEP) + line(DONE));
      },
    });
    const done = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t.post, get: t.get, reconnect: { delaysMs: [0, 1] } });
    expect(done.ok).toBe(true);
    expect(attachTries).toBe(3);
    for (const call of t.calls.filter((c) => c.method === "GET")) expect(call.path).toBe(attachPath("job-1", 3));
  });

  test("reconnect gives up after the grace window, never claiming success and never cancelling", async () => {
    const t = fakeTransport({
      post: () => chunkedResponse(line(JOB)),
      get: () => {
        throw new TypeError("offline");
      },
    });
    const done = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t.post, get: t.get, reconnect: { graceMs: 40, delaysMs: [0, 10] } });
    expect(done.ok).toBe(false);
    expect(done.jobId).toBe("job-1");
    expect(done.outcome).toBe("unverified");
    expect(done.said).toMatch(/nothing is confirmed/i);
    expect(t.calls.filter((c) => c.method === "GET").length).toBeGreaterThan(0);
    expect(t.calls.some((c) => c.path === CANCEL_PATH)).toBe(false);
  });

  test("a 404 on attach (job gone) stops retrying", async () => {
    const t = fakeTransport({ post: () => chunkedResponse(line(JOB)), get: () => Response.json({ error: "no such job" }, { status: 404 }) });
    const done = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t.post, get: t.get, reconnect: { delaysMs: [0] } });
    expect(done.ok).toBe(false);
    expect(t.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  test("a drop before any job event cannot re-attach and says so", async () => {
    const t = fakeTransport({ post: () => chunkedResponse(line(NARRATE)), get: () => chunkedResponse(line(DONE)) });
    const done = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t.post, get: t.get });
    expect(done.ok).toBe(false);
    expect(done.jobId).toBeNull();
    expect(t.calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  test("the caller's abort sends exactly one cancel for the job and resolves stopped", async () => {
    const ac = new AbortController();
    const t = fakeTransport({
      post: (_p, _b, signal) => {
        const s = controlledStream(signal);
        s.send(line(JOB) + line(NARRATE));
        return s.response; // Stays open until aborted.
      },
      get: () => chunkedResponse(line(DONE)),
    });
    const done = await runJarvisCommand({
      utterance: "open PowerPoint",
      source: "voice",
      pageContext: null,
      post: t.post,
      get: t.get,
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "narrate") setTimeout(() => {
          ac.abort();
          ac.abort();
        }, 1);
      },
    });
    expect(done.stopped).toBe(true);
    expect(done.ok).toBe(false);
    expect(done.jobId).toBe("job-1");
    const cancels = t.calls.filter((c) => c.path === CANCEL_PATH);
    expect(cancels).toHaveLength(1);
    expect(cancels[0].body).toEqual({ jobId: "job-1" });
    expect(t.calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  test("an abort before the job event waits for the job id, then cancels it once", async () => {
    const ac = new AbortController();
    const t = fakeTransport({
      post: (_p, _b, signal) => {
        const s = controlledStream(signal);
        ac.abort(); // He said stop before the server named the job.
        setTimeout(() => s.send(line(JOB)), 5);
        return s.response;
      },
    });
    const done = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t.post, get: t.get, signal: ac.signal });
    expect(done.stopped).toBe(true);
    expect(done.jobId).toBe("job-1");
    expect(t.calls.filter((c) => c.path === CANCEL_PATH)).toHaveLength(1);
  });

  test("an already-aborted signal sends nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    const t = fakeTransport({ post: () => chunkedResponse(line(DONE)) });
    const done = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t.post, get: t.get, signal: ac.signal });
    expect(done.stopped).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  test("a failed POST resolves with a failure done (or the server's own done)", async () => {
    const t1 = fakeTransport({ post: () => Response.json({ error: "Not signed in" }, { status: 401 }) });
    const d1 = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t1.post, get: t1.get });
    expect(d1.ok).toBe(false);
    expect(d1.said).toContain("Not signed in");
    const t2 = fakeTransport({ post: () => new Response(line({ ...DONE, ok: false, said: "Refused.", kind: "refused", refused: true }), { status: 403 }) });
    const d2 = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t2.post, get: t2.get });
    expect(d2.said).toBe("Refused.");
    expect(d2.kind).toBe("refused");
    const t3 = fakeTransport({
      post: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const d3 = await runJarvisCommand({ utterance: "x", source: "voice", pageContext: null, post: t3.post, get: t3.get });
    expect(d3.ok).toBe(false);
    expect(d3.said).toMatch(/couldn't reach/);
  });

  test("runTypedCommand uses the same entry with source typed and the current page context", async () => {
    (globalThis as any).window = fakeWindow("/receptionist");
    setActivePage({ path: "/receptionist", destination: "receptionist", title: "Receptionist" });
    publishPageContext("calls", { visible: [{ kind: "call", id: "c1", label: "Flagged call", to: "/receptionist", search: { call: "c1" } }] });
    const t = fakeTransport({ post: () => chunkedResponse(line(JOB) + line(DONE)) });
    const done = await runTypedCommand("open that call", { post: t.post, get: t.get });
    expect(done.ok).toBe(true);
    expect(t.calls[0].path).toBe(COMMAND_PATH);
    expect(t.calls[0].body.source).toBe("typed");
    expect(t.calls[0].body.utterance).toBe("open that call");
    expect(t.calls[0].body.spokenYes).toBeUndefined();
    // Track 1's snapshot goes on the wire as-is (the server parses both shapes).
    expect(t.calls[0].body.pageContext.page).toEqual({ path: "/receptionist", destination: "receptionist", title: "Receptionist" });
    expect(t.calls[0].body.pageContext.visible[0]).toEqual({ kind: "call", id: "c1", label: "Flagged call", to: "/receptionist", search: { call: "c1" } });
    expect(t.calls[0].body.personId).toBeUndefined();
  });
});

describe("commandResultText", () => {
  test("produces the command_result shape the follow-up rule speaks", () => {
    const text = commandResultText({ ...DONE, navigate: { path: "/receptionist" }, ask: false });
    const value = JSON.parse(text);
    expect(value.type).toBe("command_result");
    expect(value.ok).toBe(true);
    expect(value.said).toBe("PowerPoint is open.");
    expect(value.kind).toBe("app");
    expect(value.jobId).toBe("job-1");
    expect(value.ask).toBe(false);
    expect(value.navigate).toBe("/receptionist");
    expect("stopped" in value).toBe(false);
  });

  test("a stop carries stopped and never ok", () => {
    const value = JSON.parse(commandResultText({ type: "done", ok: false, said: "Stopped.", kind: "unavailable", jobId: "j", runId: "", targetDeviceId: null, stopped: true }));
    expect(value).toMatchObject({ type: "command_result", ok: false, said: "Stopped.", stopped: true, jobId: "j" });
  });
});

describe("page context (Track 1 snapshot, bounded)", () => {
  test("no page published and no route: nothing is sent", () => {
    (globalThis as any).window = undefined;
    expect(commandPageContext()).toBeNull();
  });

  test("no active page yet: the current route stands in, with the providers' items", () => {
    (globalThis as any).window = fakeWindow("/operations");
    publishPageContext("ops", { selection: { kind: "package", id: "receptionist-professional", label: "Professional package" } });
    const ctx = commandPageContext()!;
    expect(ctx.page).toEqual({ path: "/operations", destination: null, title: "" });
    expect(ctx.selection?.id).toBe("receptionist-professional");
    expect(ctx.providers).toEqual(["ops"]);
  });

  test("the shell's active page wins over the route", () => {
    (globalThis as any).window = fakeWindow("/elsewhere");
    setActivePage({ path: "/receptionist", destination: "receptionist", title: "Receptionist" });
    expect(commandPageContext()?.page?.path).toBe("/receptionist");
  });

  test("bounded: at most 20 visible items and 8 sources, the snapshot otherwise untouched", () => {
    setActivePage({ path: "/leads", destination: "work", title: "Leads" });
    const visible: ContextItem[] = Array.from({ length: 35 }, (_, i) => ({ kind: "lead", id: `l${i}`, label: `Lead ${i}` }));
    const sources = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, state: "live" as const, source: "crm", lastSuccess: null }));
    publishPageContext("leads", { visible, sources });
    const ctx = commandPageContext()!;
    expect(ctx.visible).toHaveLength(PAGE_CONTEXT_BOUNDS.visible);
    expect(ctx.sources).toHaveLength(PAGE_CONTEXT_BOUNDS.sources);
    expect(ctx.visible[0]).toEqual(visible[0]);
    expect(readPageContext().visible).toHaveLength(35); // The store itself is not modified.
    expect(boundPageContext(null)).toBeNull();
  });

  test("isOsPath accepts OS paths only", () => {
    expect(isOsPath("/leads?lead=3")).toBe(true);
    expect(isOsPath("//evil.example")).toBe(false);
    expect(isOsPath("/\\evil")).toBe(false);
    expect(isOsPath("https://example.com")).toBe(false);
    expect(isOsPath("/has space")).toBe(false);
  });
});

describe("routeVoiceCommand (Track 1's resolver → what the voice tool does)", () => {
  const apps = { state: "live" as const, items: [{ name: "PowerPoint" }, { name: "Word" }] };
  const sites = { state: "live" as const, items: [{ id: "dental", name: "Harbourside Dental", url: "https://dental.example.com.au", kind: "flagship" }] };
  const index = buildCommandIndex({ apps, sites });

  test("a resolved section navigates here, with its focus and href", () => {
    const route = routeVoiceCommand(resolveCommand("Jarvis, open the receptionist's flagged calls please", index, { channel: "voice" }));
    expect(route).toMatchObject({ route: "navigate", to: "/receptionist", focus: "rx-flagged-calls", href: "/receptionist" });
  });

  test("a resolved answer navigates with its search and speaks the figure first", () => {
    const route = routeVoiceCommand(resolveCommand("show the professional margin", index, { channel: "voice" }));
    if (route.route !== "navigate") throw new Error(route.route);
    expect(route.href).toBe("/operations?package=receptionist-professional");
    expect(route.answer).toBeDefined();
    expect(route.said.startsWith(route.answer!.headline)).toBe(true);
    expect(route.said).toContain(`Opened ${route.title}.`);
  });

  test("a resolved website takes the open_url path", () => {
    const route = routeVoiceCommand(resolveCommand("open the harbourside dental website", index, { channel: "voice" }));
    expect(route).toMatchObject({ route: "open-url", url: "https://dental.example.com.au" });
  });

  test("a device plan goes to the server entry with its spoken target", () => {
    const route = routeVoiceCommand(resolveCommand("open PowerPoint on my laptop", index, { channel: "voice" }));
    expect(route).toEqual({ route: "server", why: "device", spokenTarget: "on my laptop" });
  });

  test("unresolved goes to the server entry", () => {
    const route = routeVoiceCommand(resolveCommand("play lo-fi beats on youtube", voiceCommandIndex(), { channel: "voice" }));
    expect(route.route).toBe("server");
    if (route.route === "server") expect(route.why).toBe("unresolved");
  });

  test("ambiguous asks with the resolver's question and acts on nothing", () => {
    const resolution: Resolution = { status: "ambiguous", parsed: { verb: "open", object: "that call", deictic: { noun: "call" } }, candidates: [], ask: "Which one? I can see 2 calls on Receptionist: A; B." };
    expect(routeVoiceCommand(resolution)).toEqual({ route: "ask", said: "Which one? I can see 2 calls on Receptionist: A; B." });
  });

  test("'open that call' uses page context: one visible call resolves to its page", () => {
    setActivePage({ path: "/receptionist", destination: "receptionist", title: "Receptionist" });
    publishPageContext("calls", { visible: [{ kind: "call", id: "c1", label: "Call 11:02", to: "/receptionist", search: { call: "c1" } }] });
    const route = routeVoiceCommand(resolveCommand("open that call", index, { channel: "voice", context: readPageContext() }));
    expect(route).toMatchObject({ route: "navigate", href: "/receptionist?call=c1", said: "Opened Call 11:02." });
  });

  test("planHref and navigateSaid", () => {
    expect(planHref("/leads", { lead: "3" })).toBe("/leads?lead=3");
    expect(planHref("/today")).toBe("/today");
    expect(navigateSaid("Today")).toBe("Opened Today.");
    expect(navigateSaid("Operations", { headline: "Margin 71.2%", figures: [], source: "catalogue", state: "simulated" })).toBe("Margin 71.2%. (simulated figures) Opened Operations.");
  });
});

describe("rule-answered words skip the page resolver (AUDIT-F2)", () => {
  test("memory, finance, receptionist, leads, reminders, prices and margins go to the server entry", async () => {
    const { ruleAnswerIntent } = await import("../src/lib/jarvis-intents");
    const { voiceRouteFor } = await import("../src/lib/jarvis-command");
    const cases: Array<[string, string]> = [
      ["receptionist status", "receptionist"],
      ["any flagged calls", "receptionist"],
      ["what did I spend this month", "finance"],
      ["what do we know about Synthetic Dental Co", "memory"],
      ["mark Synthetic Physio Studio as won", "leads"],
      ["remember to call Mehroz at 5 pm", "reminder"],
      ["how much is the Premium package", "price"],
      ["what's our margin on the Professional package", "margin"],
    ];
    for (const [words, kind] of cases) {
      expect(ruleAnswerIntent(words)).toBe(kind as never);
      expect(voiceRouteFor(words, null)).toEqual({ route: "server", why: "unresolved" });
    }
    expect(ruleAnswerIntent("open the leads page")).toBeNull();
  });
});

describe("the brain's delegate_task opens Track 3's coding draft, never an immediate job", () => {
  test("codingDraftHref: /coding?request=…, with the agent named; too short → null", async () => {
    const { codingDraftHref } = await import("../src/lib/jarvis-command");
    expect(codingDraftHref("fix the failing tests in AgenticOS", "codex")).toBe(`/coding?${new URLSearchParams({ request: "fix the failing tests in AgenticOS. Codex builds." })}`);
    expect(codingDraftHref("review the receptionist branch.", "both")).toBe(`/coding?${new URLSearchParams({ request: "review the receptionist branch. Codex builds, Claude reviews." })}`);
    expect(codingDraftHref("  ", "codex")).toBeNull();
    // R3: never silently cut; too long is null (the caller says why).
    expect(codingDraftHref("x".repeat(1001), "codex")).toBeNull();
  });
  test("voice-companion has no path that starts an agent job from delegate_task or run_workflow", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/components/operator/voice-companion.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("startAgentJob(");
    expect(src).toMatch(/name === "delegate_task" \|\| name === "run_workflow"[\s\S]{0,400}codingDraftHref/);
  });
});
