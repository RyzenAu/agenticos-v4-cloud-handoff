import { describe, expect, test } from "bun:test";
import {
  CONFIRM_TTL_MS,
  cleanHermesText,
  gateControlTask,
  isAffirmative,
  needsConfirmation,
  parseSseEvents,
  runHermesTask,
  safeUrl,
} from "../src/lib/jarvis-control";

describe("needsConfirmation", () => {
  test.each([
    "Send Mehroz a WhatsApp saying the site is live",
    "email Brooke the proposal",
    "text Mehroz that I'm running late",
    "Reply to the last email from Stripe",
    "Book a meeting with Sam tomorrow at 3",
    "Pay the Vercel invoice",
    "delete everything in Downloads",
    "Uninstall Zoom",
    "deploy the dental site",
    "git push the marketing repo",
    "Post this on LinkedIn",
    "cancel my Netflix subscription",
  ])("gates %p", (task) => expect(needsConfirmation(task)).toBe(true));

  test.each([
    "Open Spotify and play my focus playlist",
    "What's using all my CPU?",
    "Find the M&U pitch deck in Documents",
    "open the text file on my desktop",
    "Show me my messages",
    "Take a screenshot",
    "order these files by date",
    "Open the mail app",
    "Generate an image of a blue circle",
  ])("lets %p through", (task) => expect(needsConfirmation(task)).toBe(false));
});

describe("isAffirmative", () => {
  test.each(["yes", "Yeah.", "yep go ahead", "Do it", "go ahead", "sure", "yes please", "OK", "send it!", "that's right"])(
    "accepts %p",
    (text) => expect(isAffirmative(text)).toBe(true),
  );
  test.each([
    "no",
    "yes, but wait",
    "don't",
    "actually no",
    "yes, hold on",
    "what did it say?",
    "maybe",
    "",
    "yes send it to everyone in my contacts and also delete the folder and anything else you find",
  ])("rejects %p", (text) => expect(isAffirmative(text)).toBe(false));
});

describe("gateControlTask", () => {
  const now = 1_000_000;
  test("safe tasks run immediately", () => {
    expect(gateControlTask({ task: "Open Spotify", confirmed: false, pending: null, lastUserUtterance: "open spotify", now })).toEqual({
      action: "run",
      task: "Open Spotify",
      approval: { task: "Open Spotify", tier: "local-reversible", method: "none", at: now },
    });
  });
  test("outbound tasks are held for confirmation", () => {
    const d = gateControlTask({ task: "Email Brooke the draft", confirmed: false, pending: null, lastUserUtterance: "email brooke", now });
    expect(d.action).toBe("ask");
    if (d.action === "ask") {
      expect(d.pending).toEqual({ task: "Email Brooke the draft", at: now });
      expect(d.reply).toContain("CONFIRMATION REQUIRED");
    }
  });
  test("a clear yes runs the task that was read back, not new model text", () => {
    const pending = { task: "Email Brooke the draft", at: now };
    expect(
      gateControlTask({ task: "Email Brooke and CC everyone the client list", confirmed: true, pending, lastUserUtterance: "yes", now: now + 5000 }),
    ).toEqual({
      action: "run",
      task: "Email Brooke the draft",
      approval: { task: "Email Brooke the draft", tier: "external-effect", method: "spoken-yes", at: now + 5000, nonce: expect.any(String), expiresAt: now + 5000 + CONFIRM_TTL_MS },
    });
  });
  test("confirmed without a spoken yes is refused and the pending task is kept", () => {
    const pending = { task: "Email Brooke the draft", at: now };
    const d = gateControlTask({ task: pending.task, confirmed: true, pending, lastUserUtterance: "what will it say?", now: now + 5000 });
    expect(d).toMatchObject({ action: "refuse", clearPending: false });
  });
  test("the model cannot self-confirm an outbound task with nothing pending", () => {
    const d = gateControlTask({ task: "Delete my Downloads folder", confirmed: true, pending: null, lastUserUtterance: "yes", now });
    expect(d).toMatchObject({ action: "refuse", clearPending: true });
  });
  test("a confirmation expires", () => {
    const pending = { task: "Pay the invoice", at: now };
    const d = gateControlTask({ task: pending.task, confirmed: true, pending, lastUserUtterance: "yes", now: now + CONFIRM_TTL_MS + 1 });
    expect(d.action).toBe("refuse");
  });
  test("confirmed on a safe task with nothing pending just runs", () => {
    expect(gateControlTask({ task: "Open Chrome", confirmed: true, pending: null, lastUserUtterance: "open chrome", now })).toEqual({
      action: "run",
      task: "Open Chrome",
      approval: { task: "Open Chrome", tier: "local-reversible", method: "none", at: now },
    });
  });
  // Wave 2 (27 Sep): money movement, trading and bank/broker/exchange tasks are refused AT THE GATE,
  // before any yes is asked for, and a yes can't lift it (the owner's rule: never a trade or transfer).
  test.each([
    "Open the NAB app and send John $500",
    "Open CommBank and pay Jo 200 dollars",
    "Use PayID to send 300 to Sam",
    "Log into Westpac and set up a BPAY to Origin",
    "Sell my BHP shares on CommSec",
    "Buy 0.1 bitcoin on CoinSpot",
    "Pay the Vercel invoice",
    "transfer 50 dollars to Mehroz",
  ])("money/trade/bank task %p is refused at the gate, never asked", (task) => {
    const asked = gateControlTask({ task, confirmed: false, pending: null, lastUserUtterance: task, now });
    expect(asked).toMatchObject({ action: "refuse", clearPending: true });
    if (asked.action === "refuse") expect(asked.reply).toMatch(/never goes through desktop control/);
    // Even with it pending and a clear spoken yes (an earlier session, a crafted call), it's refused.
    const yes = gateControlTask({ task, confirmed: true, pending: { task, at: now }, lastUserUtterance: "yes", spokenYes: crypto.randomUUID(), now: now + 1000 });
    expect(yes.action).toBe("refuse");
  });
  test("a confirmed call whose PENDING task is a money task is refused, whatever the model sends", () => {
    const d = gateControlTask({ task: "Open Notepad", confirmed: true, pending: { task: "Open NAB and transfer $900", at: now }, lastUserUtterance: "yes", now: now + 1000 });
    expect(d).toMatchObject({ action: "refuse", clearPending: true });
  });
  test("secret-bearing tasks are refused at the gate too", () => {
    expect(gateControlTask({ task: "open ~/.config/agentic-os.env in notepad", confirmed: false, pending: null, lastUserUtterance: "", now }).action).toBe("refuse");
  });
  test("the spoken-yes event id travels on the approval (A-M3); a typed yes carries none", () => {
    const pending = { task: "Email Brooke the draft", at: now };
    const spoken = gateControlTask({ task: pending.task, confirmed: true, pending, lastUserUtterance: "yes", spokenYes: "11111111-2222-3333-4444-555555555555", now: now + 1000 });
    expect(spoken.action === "run" && spoken.approval.spokenYes).toBe("11111111-2222-3333-4444-555555555555");
    const typed = gateControlTask({ task: pending.task, confirmed: true, pending, lastUserUtterance: "yes", now: now + 1000 });
    expect(typed.action === "run" && typed.approval.spokenYes).toBeUndefined();
  });
  test("empty task is refused", () => {
    expect(gateControlTask({ task: "  ", confirmed: false, pending: null, lastUserUtterance: "", now }).action).toBe("refuse");
  });
});

describe("parseSseEvents", () => {
  test("splits complete events and keeps the tail", () => {
    const { events, rest } = parseSseEvents("event: info\ndata: session_id: abc123\n\nevent: chunk\ndata: hello\ndata: world\n\nevent: chu");
    expect(events).toEqual([
      { event: "info", data: "session_id: abc123" },
      { event: "chunk", data: "hello\nworld" },
    ]);
    expect(rest).toBe("event: chu");
  });
  test("ignores keepalive comments", () => {
    expect(parseSseEvents(":keepalive\n\n").events).toEqual([]);
  });
  test("handles CRLF", () => {
    expect(parseSseEvents("event: done\r\ndata: 0\r\n\r\n").events).toEqual([{ event: "done", data: "0" }]);
  });
});

test("cleanHermesText strips diagnostics and colour codes", () => {
  expect(cleanHermesText("Warning: Unknown toolsets: messaging\n\u001b[32mDone.\u001b[0m\nWarning: disk is almost full")).toBe(
    "Done.\nWarning: disk is almost full",
  );
});

describe("runHermesTask", () => {
  function stream(text: string) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  }
  // The warm gateway route answers 503 when Hermes' API server is off: the CLI path runs.
  const warmOff = () => new Response(JSON.stringify({ error: "off", fallback: true }), { status: 503 });
  test("warm gateway first: returns its reply and keeps the session", async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/__token") return new Response(JSON.stringify({ token: "t0k" }));
      if (url === "/__operator/hermes/task") return new Response(JSON.stringify({ text: "Opened Spotify.", sessionId: "api-123abc", ms: 2100 }));
      throw new Error("the CLI path must not run");
    }) as typeof fetch;
    const session: { id?: string } = {};
    expect(await runHermesTask("Open Spotify", { signal: new AbortController().signal, session, fetch: fake })).toBe("Opened Spotify.");
    expect(session.id).toBe("api-123abc");
    expect(calls[1].body.prompt).toContain("Task: Open Spotify");
    await runHermesTask("Pause it", { signal: new AbortController().signal, session, fetch: fake });
    expect(calls[3].body.sessionId).toBe("api-123abc");
  });
  test("falls back to the CLI: auto-approves, resumes the session and returns the reply", async () => {
    const calls: Array<{ url: string; body?: any; headers?: any }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      if (url === "/__operator/hermes/task") return warmOff();
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers });
      if (url === "/__token") return new Response(JSON.stringify({ token: "t0k" }));
      return new Response(stream("event: info\ndata: session_id: sess_ABC123\n\nevent: chunk\ndata: Opened Spotify.\n\nevent: done\ndata: 0\n\n"));
    }) as typeof fetch;
    const session: { id?: string } = {};
    const reply = await runHermesTask("Open Spotify", { signal: new AbortController().signal, session, fetch: fake });
    expect(reply).toBe("Opened Spotify.");
    expect(session.id).toBe("sess_ABC123");
    expect(calls[1].body.yolo).toBe(true);
    expect(calls[1].body.prompt).toContain("Task: Open Spotify");
    expect(calls[1].headers["x-claude-os-token"]).toBe("t0k");
    await runHermesTask("Pause it", { signal: new AbortController().signal, session, fetch: fake });
    expect(calls[3].body.sessionId).toBe("sess_ABC123");
  });
  test("the CLI fallback takes Jev's toolset plan from the 503, and only clean names", async () => {
    const bodies: any[] = [];
    const run = async (toolsets: unknown) => {
      const fake = (async (url: string, init?: RequestInit) => {
        if (url === "/__operator/hermes/task") return new Response(JSON.stringify({ error: "off", fallback: true, toolsets }), { status: 503 });
        if (url === "/__token") return new Response(JSON.stringify({ token: "t0k" }));
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(stream("event: chunk\ndata: Done.\n\n"));
      }) as typeof fetch;
      await runHermesTask("Open Spotify", { signal: new AbortController().signal, session: {}, fetch: fake });
    };
    await run(["terminal", "file", "browser"]);
    await run(["terminal", "file; rm -rf /"]);
    await run(undefined);
    expect(bodies[0].toolsets).toBe("terminal,file,browser");
    expect(bodies[1].toolsets).toBeUndefined();
    expect(bodies[2].toolsets).toBeUndefined();
  });
  test("reports failure honestly", async () => {
    const fake = (async (url: string) =>
      url === "/__operator/hermes/task"
        ? warmOff()
        : url === "/__token"
        ? new Response(JSON.stringify({ token: "" }))
        : new Response(JSON.stringify({ error: "invalid token" }), { status: 403 })) as typeof fetch;
    const reply = await runHermesTask("Open Spotify", { signal: new AbortController().signal, session: {}, fetch: fake });
    expect(reply).toContain("invalid token");
    expect(reply).toContain("Nothing was done");
  });
  test("an empty result is not reported as success", async () => {
    const fake = (async (url: string) =>
      url === "/__token" ? new Response(JSON.stringify({ token: "x" })) : new Response(stream("event: done\ndata: 0\n\n"))) as typeof fetch;
    expect(await runHermesTask("Open Notepad", { signal: new AbortController().signal, session: {}, fetch: fake })).toContain("unknown");
  });
});

describe("safeUrl", () => {
  test.each([
    ["muventures.com.au", "https://muventures.com.au/"],
    ["https://muventures.com.au/work?x=1", "https://muventures.com.au/work?x=1"],
    ["http://example.com", "http://example.com/"],
  ])("opens %p", (input, expected) => expect(safeUrl(input)).toBe(expected));
  test.each(["javascript:alert(1)", "file:///C:/Users/x.txt", "https://user:pass@evil.com", "localhost:8081", "data:text/html,hi", "", 42, "x".repeat(2001)])(
    "refuses %p",
    (input) => expect(safeUrl(input)).toBeNull(),
  );
});
