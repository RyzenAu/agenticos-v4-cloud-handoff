// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentChatApi, NOT_ALLOWED_PREFIX, ThreadReadError, type ThreadReadKind } from "./agent-chat";
import { runJarvisCommand, type CommandPost } from "./jarvis-command";

// Round 7: the conversation "unavailable while the page otherwise loads" is several different failures. Each one must say which it is.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const stub = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = ((url: string, init?: RequestInit) => impl(String(url), init)) as typeof fetch;
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const read = async (api = createAgentChatApi({ timeoutMs: 60 })) => {
  try {
    await api.fetchThread("research", 0);
    return null;
  } catch (error) {
    return error as ThreadReadError;
  }
};

describe("a failed thread read names its boundary", () => {
  test("403 from an unpaired browser: not-paired, the hub's own sentence, and no retry can help", async () => {
    stub(async () => json(403, { error: "Conversations need a confirmed sign-in: open Agentic OS in your paired browser, or use it at the hub PC." }));
    const e = await read();
    expect(e).toBeInstanceOf(ThreadReadError);
    expect(e!.kind).toBe("not-paired");
    expect(e!.message).toBe(`${NOT_ALLOWED_PREFIX}Conversations need a confirmed sign-in: open Agentic OS in your paired browser, or use it at the hub PC.`);
    expect(e!.retryable).toBe(false);
  });

  test("401 (no verified person at all) is also a pairing problem, not a server fault", async () => {
    stub(async () => json(401, { error: "Sign in first: use Agentic OS at this PC, or open it through your own Tailscale address." }));
    const e = await read();
    expect(e!.kind).toBe("not-paired");
    expect(e!.message).toContain("Sign in first");
  });

  test("503 from an unreadable conversations store: store, the hub's sentence, retryable", async () => {
    stub(async () => json(503, { error: "Saved conversations could not be read. Your history was left untouched." }));
    const e = await read();
    expect(e!.kind).toBe("store");
    expect(e!.message).toContain("Saved conversations could not be read");
    expect(e!.retryable).toBe(true);
  });

  test("a bare 500 is the hub's fault, with its status; the generic body is not passed off as a cause", async () => {
    stub(async () => json(500, { error: "Something went wrong." }));
    const e = await read();
    expect(e!.kind).toBe("server");
    expect(e!.message).toContain("status 500");
    expect(e!.message).not.toContain("Something went wrong");
  });

  test("404: the bot is gone, retrying cannot help", async () => {
    stub(async () => json(404, { error: 'There is no bot called "research".' }));
    const e = await read();
    expect(e!.kind).toBe("not-found");
    expect(e!.retryable).toBe(false);
  });

  test("a connection that fails outright is a network problem", async () => {
    stub(async () => {
      throw new TypeError("Failed to fetch");
    });
    const e = await read();
    expect(e!.kind).toBe("network");
    expect(e!.retryable).toBe(true);
  });

  test("a hub that accepts the connection and never answers times out (it must not leave the page loading for ever)", async () => {
    stub((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const started = Date.now();
    const e = await read();
    expect(e!.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("headers arrive but the body stalls: still a timeout", async () => {
    stub(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200 });
    });
    const e = await read();
    expect(e!.kind).toBe("timeout");
  });

  test("an answer that is not a thread is a shape problem", async () => {
    stub(async () => json(200, { nope: true }));
    const e = await read();
    expect(e!.kind).toBe("shape" satisfies ThreadReadKind);
  });

  test("the caller's own abort is passed through, not reworded as a hub fault", async () => {
    stub((_url, init) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const ctl = new AbortController();
    const api = createAgentChatApi({ timeoutMs: 5000 });
    const p = api.fetchThread("research", 0, ctl.signal).catch((e) => e);
    ctl.abort();
    const e = await p;
    expect(e).not.toBeInstanceOf(ThreadReadError);
  });
});

describe("a send whose answer never came back is not a failed send", () => {
  const input = { botId: "research", conversationId: "agent:p1:research", utterance: "Find dentists", source: "typed" as const, eventId: "bot-evt-0001" };

  test("the post times out after the hub may have accepted it: unconfirmed, never 'did not start', and the same event id is what a resend carries", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const post: CommandPost = async (_p, body) => {
      bodies.push(body as Record<string, unknown>);
      throw new Error("timed out");
    };
    // Round 11: a dropped send is resent automatically (here with no wait); every resend carries the SAME event id.
    const sendRetry = { delaysMs: [0, 0, 0] };
    const done = await runJarvisCommand({ utterance: input.utterance, source: "typed", conversationId: input.conversationId, target: { bot: "research" }, eventId: input.eventId, post, pageContext: null, sendRetry });
    expect(done.ok).toBe(false);
    expect(done.outcome).toBe("unverified");
    expect(done.said).toContain("may have arrived");
    const firstRun = bodies.length;
    expect(firstRun).toBeGreaterThan(1);
    await runJarvisCommand({ utterance: input.utterance, source: "typed", conversationId: input.conversationId, target: { bot: "research" }, eventId: input.eventId, post, pageContext: null, sendRetry });
    expect(bodies.length).toBe(firstRun * 2);
    expect(new Set(bodies.map((b) => b.eventId))).toEqual(new Set(["bot-evt-0001"]));
  });

  test("a 4xx is the hub declining it (definite); a 5xx may have come after it started (unverified)", async () => {
    const as = (status: number): CommandPost => async () => new Response(JSON.stringify({ error: "nope" }), { status, headers: { "content-type": "application/json" } });
    const four = await runJarvisCommand({ utterance: "x y", source: "typed", post: as(403), pageContext: null });
    const five = await runJarvisCommand({ utterance: "x y", source: "typed", post: as(502), pageContext: null });
    expect(four.outcome).toBeUndefined();
    expect(five.outcome).toBe("unverified");
  });
});

describe("the hub's saved reply reaches the browser whole", () => {
  test("parseThread keeps the hub's ok and unverified on a reply (unverified used to be dropped, so a possibly-started command read as a plain failure)", async () => {
    const { parseThread } = await import("./agent-chat");
    const t = parseThread({ conversationId: "c", entries: [{ seq: 1, key: "e:ack", at: "x", jobId: "", state: "ack", text: "t", ok: false, unverified: true }, { seq: 2, key: "f:ack", at: "x", jobId: "", state: "ack", text: "t" }] })!;
    expect(t.entries[0]).toMatchObject({ ok: false, unverified: true });
    expect(t.entries[1].unverified).toBeUndefined();
    expect(t.entries[1].ok).toBeUndefined();
  });
});
