import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindControlDisconnect, ControlDispatchGate } from "./server-approval";
import { SpokenConfirmationLedger, SPOKEN_YES_TTL_MS, spokenConfirmations } from "./voice-confirmation";
import { askControlQuestion, gateControlTask, jarvisTaskPrompt, runHermesTask } from "../../src/lib/jarvis-control";
import { runChild } from "./child";

// "Delete ..." needs his spoken yes and is not a hard refusal (money/bank/secret tasks are).
const TASK = "Delete the synthetic draft in D:\tmp\jarvis-acceptance";
const spokenYes = (ledger: SpokenConfirmationLedger) => ({ spokenYes: ledger.record("yes")!.id });
// A-M3 binding (27 Sep night): the server asks the question for this exact task first; only a yes
// said AFTER it counts. These tests used to redeem any yes from the last 60 s (the unsafe behaviour).
const askedThenYes = (gate: ControlDispatchGate, ledger: SpokenConfirmationLedger, task: string, tick: () => void = () => undefined) => {
  gate.ask({ task });
  tick();
  return spokenYes(ledger);
};

test("A-M3: a client-asserted yes never mints a grant; only a fresh, unused server-side spoken-yes event does", () => {
  let now = 5000;
  const ledger = new SpokenConfirmationLedger(() => now);
  const gate = new ControlDispatchGate(() => now, ledger);
  const b = { task: TASK, requestId: randomUUID() };
  // The old rubber stamp: any "yes" string from a page-token holder. Refused, however it's phrased.
  for (const literal of ["yes", "Yes.", "go ahead", "yes but wait"]) expect(() => gate.issue(b, literal)).toThrow("spoken approval");
  expect(() => gate.issue(b, { spokenYes: randomUUID() })).toThrow("spoken approval");
  expect(() => gate.issue(b, {})).toThrow("spoken approval");
  expect(ledger.record("yes, but wait")).toBeNull();
  expect(ledger.record("what did it say?")).toBeNull();
  const event = askedThenYes(gate, ledger, TASK, () => void (now += 1));
  expect(gate.issue(b, event).nonce).toMatch(/^[a-f0-9-]{36}$/);
  // Single use: the same spoken yes can't approve a second task.
  expect(() => gate.issue({ task: TASK, requestId: randomUUID() }, event)).toThrow("spoken approval");
  // Stale: a yes said more than SPOKEN_YES_TTL_MS ago is no approval.
  const old = askedThenYes(gate, ledger, TASK, () => void (now += 1));
  now += SPOKEN_YES_TTL_MS;
  expect(() => gate.issue({ task: TASK, requestId: randomUUID() }, old)).toThrow("spoken approval");
});

test("A-M3 binding: a control grant needs a yes said AFTER the server asked about THIS task, and the question is spent", () => {
  let now = 10_000;
  const ledger = new SpokenConfirmationLedger(() => now);
  const gate = new ControlDispatchGate(() => now, ledger);
  const b = () => ({ task: TASK, requestId: randomUUID() });
  // No question asked: even a fresh, clear spoken yes (small talk: "yes, it's sunny") mints nothing.
  expect(() => gate.issue(b(), spokenYes(ledger))).toThrow("no question was asked");
  // A yes said BEFORE the question doesn't answer it.
  const early = spokenYes(ledger);
  now += 5;
  gate.ask({ task: TASK });
  now += 5;
  expect(() => gate.issue(b(), early)).toThrow("spoken approval");
  // A question about a different task doesn't cover this one.
  gate.ask({ task: "Delete another synthetic draft" });
  now += 5;
  const yes = spokenYes(ledger);
  expect(() => gate.issue({ task: "Delete a third synthetic draft", requestId: randomUUID() }, yes)).toThrow("no question was asked");
  // One question at a time (REVIEW-SAFETY §3): asking about another task superseded this task's
  // question, so it is asked again; the yes said after it: one grant, then the question is spent.
  expect(() => gate.issue(b(), spokenYes(ledger))).toThrow("no question was asked");
  gate.ask({ task: TASK });
  now += 5;
  const again = spokenYes(ledger);
  expect(gate.issue(b(), again).nonce).toMatch(/^[a-f0-9-]{36}$/);
  now += 5;
  expect(() => gate.issue(b(), spokenYes(ledger))).toThrow("no question was asked");
  // A question expires with the read-back (two minutes).
  gate.ask({ task: TASK });
  now += 2 * 60 * 1000;
  expect(() => gate.issue(b(), spokenYes(ledger))).toThrow("no question was asked");
  // A malformed question is refused.
  expect(() => gate.ask({ task: "  padded " })).toThrow("Invalid control question");
  expect(() => gate.ask({})).toThrow("Invalid control question");
});

test("the spoken-yes ledger: after-binding, capacity, no text kept", () => {
  let now = 100;
  const ledger = new SpokenConfirmationLedger(() => now, 3);
  const a = ledger.record("yes")!;
  now = 200;
  expect(ledger.redeem(a.id, { after: 150 })).toBeNull();
  const b = ledger.record("yes please")!;
  expect(ledger.redeem(b.id, { after: 150 })).toEqual({ id: b.id, at: 200 });
  for (let i = 0; i < 5; i++) ledger.record("yes");
  expect(ledger.outstanding()).toBeLessThanOrEqual(3);
  expect(JSON.stringify([...(ledger as unknown as { events: Map<string, unknown> }).events.values()])).not.toContain("yes");
});

test("server authority rejects missing, forged, stale and future grants", () => {
  let now = 1000;
  const ledger = new SpokenConfirmationLedger(() => now);
  const gate = new ControlDispatchGate(() => now, ledger);
  const task = TASK, requestId = randomUUID();
  const b = { task, requestId };
  expect(() => gate.consume(b, jarvisTaskPrompt(task))).toThrow("required");
  expect(() => gate.issue(b, "yes but wait")).toThrow("explicit spoken approval");
  const grant = gate.issue(b, askedThenYes(gate, ledger, task, () => void (now += 1)));
  expect(() => gate.consume({ ...b, approvalNonce: randomUUID() }, jarvisTaskPrompt(task))).toThrow("invalid");
  now = 999;
  expect(() => gate.consume({ ...b, approvalNonce: grant.nonce }, jarvisTaskPrompt(task))).toThrow("invalid");
  now = grant.expiresAt;
  expect(() => gate.consume({ ...b, approvalNonce: grant.nonce }, jarvisTaskPrompt(task))).toThrow("expired");
});
test("server authority binds exact prompt, task hash, request ID and single consumption", () => {
  const ledger = new SpokenConfirmationLedger();
  const gate = new ControlDispatchGate(Date.now, ledger);
  const task = TASK, b = { task, requestId: randomUUID() };
  const grant = gate.issue(b, askedThenYes(gate, ledger, task, () => Bun.sleepSync(2))), approved = { ...b, approvalNonce: grant.nonce };
  expect(grant.taskHash).toMatch(/^[a-f0-9]{64}$/);
  expect(() => gate.consume(approved, jarvisTaskPrompt(task) + " and delete everything")).toThrow("does not match");
  expect(() => gate.consume({ ...approved, requestId: randomUUID() }, jarvisTaskPrompt(task))).toThrow("invalid");
  expect(() => gate.consume({ ...approved, task: "Delete another synthetic draft" }, jarvisTaskPrompt("Delete another synthetic draft"))).toThrow("invalid");
  gate.consume(approved, jarvisTaskPrompt(task));
  expect(() => gate.consume(approved, jarvisTaskPrompt(task))).toThrow("replay");
  expect(() => gate.issue(b, askedThenYes(gate, ledger, task, () => Bun.sleepSync(2)))).toThrow("fresh");
});
test("safe dispatch is also deduplicated and a restarted authority rejects old external grants", () => {
  const gate = new ControlDispatchGate();
  const b = { task: "Open Notepad", requestId: randomUUID() };
  gate.consume(b, jarvisTaskPrompt(b.task));
  expect(() => gate.consume(b, jarvisTaskPrompt(b.task))).toThrow("replay");
  const ledger = new SpokenConfirmationLedger();
  const external = { task: TASK, requestId: randomUUID() };
  const first = new ControlDispatchGate(Date.now, ledger);
  const grant = first.issue(external, askedThenYes(first, ledger, external.task, () => Bun.sleepSync(2)));
  expect(() => new ControlDispatchGate().consume({ ...external, approvalNonce: grant.nonce }, jarvisTaskPrompt(external.task))).toThrow("invalid");
});
test("real loopback disconnect invokes production cancellation binding and reaps a real synthetic child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-http-synthetic-"));
  let settle!: (value: unknown) => void;
  const exited = new Promise<unknown>((r) => { settle = r; });
  const gate = new ControlDispatchGate();
  const b = { task: "Open Notepad", requestId: randomUUID() };
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    // Fixture request is local and synthetic. This is the production admission/cancel
    // code, with only the executable replaced: no model, Notepad or credentials.
    gate.consume(b, jarvisTaskPrompt(b.task));
    bindControlDisconnect(res, () => controller.abort());
    try {
      settle(await runChild({ executable: process.execPath, args: ["--no-env-file", "-e", "setInterval(()=>{},1000)"],
        cwd: dir, signal: controller.signal, timeoutMs: 8000,
        onStarted: () => { res.writeHead(200, { "Content-Type": "text/plain" }); res.write("synthetic-started"); },
      }));
    } catch (error) { settle(error); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address() as { port: number };
    const request = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: request.signal });
    await response.body!.getReader().read();
    request.abort();
    expect(await exited).toMatchObject({ ok: false, cancelled: true });
    expect(controller.signal.aborted).toBe(true);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 12_000);

test("real client approval -> loopback transport -> server admission -> synthetic file, with replay denied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-admission-synthetic-"));
  const artifact = join(dir, "synthetic.txt"), gate = new ControlDispatchGate();
  let dispatches = 0, lastBody: unknown;
  const server = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/__token") return json({ token: "synthetic-only" });
    if (req.headers["x-claude-os-token"] !== "synthetic-only") return json({ error: "unauthorised" }, 403);
    let body = ""; for await (const bytes of req) body += bytes;
    const payload = JSON.parse(body);
    try {
      if (req.url === "/__operator/control/question") return json(gate.ask(payload));
      if (req.url === "/__operator/control/approval") return json(gate.issue(payload, payload.confirmation));
      if (req.url === "/__operator/hermes/task") return json({ fallback: true }, 503);
      gate.consume(payload.control, payload.prompt);
      lastBody = payload;
      dispatches++;
      writeFileSync(artifact, "SYNTHETIC-CONTROL-EFFECT");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("event: chunk\ndata: Synthetic file prepared.\n\nevent: done\ndata: ok\n\n");
    } catch { json({ error: "approval refused" }, 403); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const task = TASK, now = Date.now();
    const request = ((url: string, init?: RequestInit) => fetch(base + url, init)) as typeof fetch;
    // Jarvis asks the read-back question: the server records it for this exact task (A-M3 binding)…
    expect(await askControlQuestion(task, { fetch: request })).toBe(true);
    Bun.sleepSync(2);
    // …then the server's own STT records his spoken yes (the process ledger the route redeems from).
    const heard = spokenConfirmations.record("yes")!;
    const approved = gateControlTask({ task, confirmed: true, pending: { task, at: now }, lastUserUtterance: "yes", spokenYes: heard.id, now });
    if (approved.action !== "run") throw new Error("Synthetic confirmation refused");
    expect(await runHermesTask(task, { signal: new AbortController().signal, session: {}, approval: approved.approval, fetch: request })).toBe("Synthetic file prepared.");
    expect(readFileSync(artifact, "utf8")).toBe("SYNTHETIC-CONTROL-EFFECT");
    const replay = await fetch(base + "/__hermes_chat", { method: "POST", headers: { "x-claude-os-token": "synthetic-only" }, body: JSON.stringify(lastBody) });
    expect(replay.status).toBe(403);
    expect(dispatches).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a typed yes (no spoken event) is never dispatched, and the server is not even asked", async () => {
  const task = TASK, now = Date.now(), calls: string[] = [];
  const approved = gateControlTask({ task, confirmed: true, pending: { task, at: now }, lastUserUtterance: "yes", now });
  if (approved.action !== "run") throw new Error("gate should run with a local yes; the server decides");
  const request = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ token: "synthetic-only" }));
  }) as typeof fetch;
  expect(await runHermesTask(task, { signal: new AbortController().signal, session: {}, approval: approved.approval, fetch: request })).toContain("only your spoken yes");
  expect(calls.filter((u) => u.includes("approval") || u.includes("hermes"))).toEqual([]);
});
