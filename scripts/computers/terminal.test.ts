// Round 10 (owner's addition): a real terminal into a SHARED BOT COMPUTER, held to the control lease. Three layers:
//   1. the session manager (who may, logging, closing on lease loss, idle, stop) with a fake process;
//   2. the adapter's stream (the script first, frames only after the bridge says ready, refusals as sentences) with a fake host process;
//   3. the real hub routes over HTTP (confirmed person, the lease in THIS window, the other founder, a program, Return, Stop), with a fake host.
// The bridge inside the computer (computer-ctl.sh `term`) is exercised against the real WSL distro in terminal-wsl.test.ts.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { WslLocalAdapter } from "./wsl-local";
import type { StreamProc } from "./script-adapter";
import { commandForLog, createTerminals, frame, resizeFrame, type TerminalProcess } from "./terminal";
import { startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(40_000);

/** A shell stand-in: echoes what it is sent, records resizes, can exit. */
function fakeProc() {
  const data: ((c: Uint8Array) => void)[] = [];
  const exit: ((c: number | null) => void)[] = [];
  const got = { written: [] as string[], sizes: [] as string[], closed: 0 };
  const proc: TerminalProcess = {
    write: (d) => { const s = new TextDecoder().decode(d); got.written.push(s); for (const l of data) l(new TextEncoder().encode(`echo:${s}`)); },
    resize: (c, r) => void got.sizes.push(`${c}x${r}`),
    close: () => { got.closed++; for (const l of exit) l(0); },
    onData: (l) => void data.push(l),
    onExit: (l) => void exit.push(l),
  };
  return { proc, got, emit: (s: string) => data.forEach((l) => l(new TextEncoder().encode(s))), exit: (c: number) => exit.forEach((l) => l(c)) };
}

describe("the session manager", () => {
  const usman = { personId: "usman", session: "s-1" };
  const other = { personId: "usman", session: "s-2" };
  function world(opts: { idleMs?: number } = {}) {
    let holder: { personId: string; session: string } | null = usman;
    let t = 1_000_000;
    const log: string[] = [];
    const procs: ReturnType<typeof fakeProc>[] = [];
    const terms = createTerminals({
      holds: (_c, who) => (holder && holder.personId === who.personId && holder.session === who.session ? null : "Take control of research first."),
      open: async () => { const p = fakeProc(); procs.push(p); return p.proc; },
      log: (_c, kind, text, who) => void log.push(`${kind}|${who}|${text}`),
      now: () => t,
      ...(opts.idleMs ? { idleMs: opts.idleMs } : {}),
    });
    return { terms, log, procs, set: (h: typeof holder) => void (holder = h), tick: (ms: number) => void (t += ms) };
  }

  test("only the person holding the computer in THIS window opens it; the same window re-attaches; one terminal per computer", async () => {
    const w = world();
    expect(await w.terms.start("research", other)).toEqual({ ok: false, status: 409, reason: "Take control of research first." });
    const a = await w.terms.start("research", usman, { cols: 120, rows: 40 });
    expect(a).toMatchObject({ ok: true, attached: false });
    expect(await w.terms.start("research", usman)).toMatchObject({ ok: true, attached: true, id: a.ok ? a.id : "" });
    expect(w.procs).toHaveLength(1);
    expect(w.log[0]).toBe("terminal-open|usman|terminal opened by usman (120x40), as the computer's own user");
  });

  test("keystrokes go to the shell; each Enter is logged (masked); output reads back by sequence without repeats", async () => {
    const w = world();
    const s = await w.terms.start("research", usman);
    if (!s.ok) throw new Error("not opened");
    expect(w.terms.input("research", s.id, usman, "ls -la\r")).toEqual({ ok: true });
    expect(w.terms.input("research", s.id, usman, "export TOKEN=abc123 && curl 4111111111111111\r")).toEqual({ ok: true });
    expect(w.log.filter((l) => l.startsWith("terminal-command"))).toEqual(["terminal-command|usman|terminal: ls -la", "terminal-command|usman|terminal: export TOKEN=[hidden] && curl [number]"]);
    const first = await w.terms.events("research", s.id, usman, 0);
    expect(first.ok && first.chunks.map((c) => c.data)).toEqual(["echo:ls -la\r", "echo:export TOKEN=abc123 && curl 4111111111111111\r"]);
    const again = await w.terms.events("research", s.id, usman, first.ok ? first.next : 0);
    expect(again.ok && again.chunks).toEqual([]);
    // Someone else (even the same person in another window) cannot read or type into it.
    expect(w.terms.input("research", s.id, other, "id\r")).toMatchObject({ ok: false, status: 404 });
    expect(await w.terms.events("research", s.id, other, 0)).toMatchObject({ ok: false, status: 404 });
  });

  test("a long poll wakes on output", async () => {
    const w = world();
    const s = await w.terms.start("research", usman);
    if (!s.ok) throw new Error("not opened");
    const later = w.terms.events("research", s.id, usman, 0, 5_000);
    setTimeout(() => w.procs[0].emit("hello"), 30);
    const r = await later;
    expect(r.ok && r.chunks.map((c) => c.data)).toEqual(["hello"]);
  });

  test("losing the controls closes it: Return to agent, expiry or another window; input after that is refused", async () => {
    const w = world();
    const s = await w.terms.start("research", usman);
    if (!s.ok) throw new Error("not opened");
    w.set(null); // returned to the agent
    w.terms.leaseChanged("research");
    expect(w.procs[0].got.closed).toBe(1);
    expect(w.terms.input("research", s.id, usman, "id\r")).toMatchObject({ ok: false, status: 410 });
    const r = await w.terms.events("research", s.id, usman, 0);
    expect(r.ok && r.closed).toEqual({ reason: "the controls went back to the agent or to someone else" });
    expect(w.log.at(-1)).toBe("terminal-close|usman|terminal closed: the controls went back to the agent or to someone else");
  });

  test("input checks the lease itself even when no lease event arrived", async () => {
    const w = world();
    const s = await w.terms.start("research", usman);
    if (!s.ok) throw new Error("not opened");
    w.set(other);
    expect(w.terms.input("research", s.id, usman, "rm -rf ~\r")).toMatchObject({ ok: false, status: 409 });
    expect(w.procs[0].got.written).toEqual([]);
    expect(w.procs[0].got.closed).toBe(1);
  });

  test("idle closes it; Stop closes it; a shell that ends closes it; each says why", async () => {
    const w = world({ idleMs: 60_000 });
    const s = await w.terms.start("research", usman);
    if (!s.ok) throw new Error("not opened");
    w.tick(61_000);
    w.terms.sweep();
    expect((await w.terms.events("research", s.id, usman, 0)) as unknown).toMatchObject({ ok: true, closed: { reason: "idle for 1 minutes" } });
    const s2 = await w.terms.start("research", usman);
    if (!s2.ok) throw new Error("not reopened");
    w.terms.computerStopped("research", "the computer was stopped");
    expect((await w.terms.events("research", s2.id, usman, 0)) as unknown).toMatchObject({ closed: { reason: "the computer was stopped" } });
    const s3 = await w.terms.start("research", usman);
    if (!s3.ok) throw new Error("not reopened");
    w.procs.at(-1)!.exit(130);
    expect((await w.terms.events("research", s3.id, usman, 0)) as unknown).toMatchObject({ closed: { reason: "the shell ended (exit 130)" } });
  });

  test("command lines in the log carry no control characters and no long digit runs", () => {
    expect(commandForLog("\x1b[Acat /etc/passwd\x07")).toBe("cat /etc/passwd");
    expect(commandForLog("password: hunter2")).toBe("password: [hidden]");
    expect(commandForLog("x".repeat(300)).length).toBe(200);
  });
});

describe("the adapter's stream into the computer", () => {
  function fakeHost(answer: string) {
    const writes: Uint8Array[] = [];
    let out: ((c: Uint8Array) => void) | null = null;
    let onExit: ((c: number | null) => void) | null = null;
    let ended = false;
    const proc: StreamProc = {
      write: (d) => void writes.push(d),
      end: () => void (ended = true),
      kill: () => onExit?.(null),
      onStdout: (l) => void (out = l),
      onExit: (l) => void (onExit = l),
    };
    const adapter = new WslLocalAdapter("kali-linux", async () => ({ code: 0, stdout: "", stderr: "" }), "echo script-body");
    let argv: string[] = [];
    adapter.spawnStream = (a) => ((argv = a), setTimeout(() => out?.(new TextEncoder().encode(answer)), 5), proc);
    return { adapter, writes, argv: () => argv, ended: () => ended, send: (s: string) => out?.(new TextEncoder().encode(s)), exit: (c: number) => onExit?.(c) };
  }

  test("a refusal from the computer is a sentence and nothing is sent after the script", async () => {
    const h = fakeHost('{"ok":false,"error":"this computer runs as the host login user, not a user of its own, so no terminal is offered"}\n');
    const r = await h.adapter.openTerminal({ name: "research" }, { cols: 100, rows: 30 });
    expect(r).toEqual({ refused: "No terminal: this computer runs as the host login user, not a user of its own, so no terminal is offered." });
    expect(h.argv()).toEqual(["wsl.exe", "-d", "kali-linux", "--", "bash", "-s", "--", "term", "research"]);
    expect(h.writes).toHaveLength(1); // the script only
    expect(new TextDecoder().decode(h.writes[0])).toContain("echo script-body");
    expect(h.ended()).toBe(true);
  });

  test("ready: the first frame is the window size, keystrokes are framed, output after the ready line reaches the session, close sends q", async () => {
    const h = fakeHost('{"ok":true,"term":"ready"}\nwelcome$ ');
    const r = await h.adapter.openTerminal({ name: "research" }, { cols: 100, rows: 30 });
    if ("refused" in r) throw new Error(r.refused);
    const seen: string[] = [];
    r.onData((c) => seen.push(new TextDecoder().decode(c)));
    await new Promise((x) => setTimeout(x, 20));
    expect(seen).toEqual(["welcome$ "]);
    expect([...h.writes[1]]).toEqual([...resizeFrame(100, 30)]);
    r.write(new TextEncoder().encode("ls\r"));
    expect([...h.writes[2]]).toEqual([...frame("d", new TextEncoder().encode("ls\r"))]);
    r.close();
    expect([...h.writes[3]]).toEqual([...frame("q")]);
  });

  test("a host that never answers is refused, not left half open", async () => {
    const h = fakeHost("");
    const r = await h.adapter.openTerminal({ name: "research" }, { cols: 80, rows: 24 }, 50);
    expect(r).toEqual({ refused: "The computer didn't open a terminal within 20 seconds." });
  });
});

describe("through the real hub routes", () => {
  let hub: ComputersHub | undefined;
  afterEach(async () => {
    await hub?.close();
    hub = undefined;
  });

  async function ready() {
    hub = await startComputersHub();
    const shells: ReturnType<typeof fakeProc>[] = [];
    (hub.host as unknown as { openTerminal: unknown }).openTerminal = async () => { const p = fakeProc(); shells.push(p); return p.proc; };
    expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
    await hub.waitFor("online", () => hub!.computers.list().some((c) => c.name === "research" && c.state === "online"));
    return shells;
  }

  test("a program is refused; a person without the controls is told to take them; with them it opens, types, logs, and Return closes it", async () => {
    const shells = await ready();
    expect((await hub!.api("program", "POST", "/research/terminal", {})).status).toBe(403);
    const before = await hub!.api("usman", "POST", "/research/terminal", {});
    expect(before.status).toBe(409);
    expect(before.json.error).toMatch(/Take control of research first/);
    expect((await hub!.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    const opened = await hub!.api("usman", "POST", "/research/terminal", { cols: 90, rows: 25 });
    expect(opened.status).toBe(200);
    const id = opened.json.id as string;
    // The other founder holds nothing here: no terminal, and not this one.
    expect((await hub!.api("mehroz", "POST", "/research/terminal", {})).status).toBe(409);
    expect((await hub!.api("mehroz", "POST", `/research/terminal/${id}/input`, { data: "id\r" })).status).toBe(404);
    expect((await hub!.api("usman", "POST", `/research/terminal/${id}/input`, { data: "pwd\r" })).status).toBe(200);
    const ev = await hub!.api("usman", "GET", `/research/terminal/${id}/events?after=0`);
    expect(ev.json.chunks.map((c: { data: string }) => c.data)).toEqual(["echo:pwd\r"]);
    expect(hub!.computers.events().filter((e) => e.type.startsWith("terminal")).map((e) => `${e.type}: ${e.detail}`)).toEqual([
      "terminal-open: terminal opened by usman (90x25), as the computer's own user",
      "terminal-command: terminal: pwd",
    ]);
    expect((await hub!.api("usman", "POST", "/research/return", {})).status).toBe(200);
    await hub!.waitFor("closed on return", () => shells[0].got.closed === 1);
    const after = await hub!.api("usman", "GET", `/research/terminal/${id}/events?after=0`);
    expect(after.json.closed).toEqual({ reason: "the controls went back to the agent or to someone else" });
    expect((await hub!.api("usman", "POST", `/research/terminal/${id}/input`, { data: "ls\r" })).status).toBe(410);
  });

  test("taking the controls pauses the agent's job at its safe step; the paused job's own history records the terminal's commands; Return resumes it", async () => {
    hub = await startComputersHub();
    hub.host.executorsFor = () => ({
      wait: async (args, ctx) => { await new Promise((r) => setTimeout(r, Number(args.ms ?? 0))); return ctx.signal.aborted ? { ok: false, said: "Stopped.", verified: false } : { ok: true, said: "waited", verified: true }; },
      echo: async () => ({ ok: true, said: "Echoed.", verified: true }),
    });
    (hub.host as unknown as { openTerminal: unknown }).openTerminal = async () => fakeProc().proc;
    expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
    await hub.waitFor("online", () => hub!.computers.list().some((c) => c.name === "research" && c.state === "online"));
    const job = await hub.api("usman", "POST", "/research/jobs", { agent: "research", title: "two steps", steps: [{ executor: "wait", args: { ms: 1500 } }, { executor: "echo", args: {} }] });
    expect(job.status).toBe(200);
    await hub.waitFor("the agent holds the computer", () => hub!.computers.view("research").controller.kind === "agent");
    await hub.api("usman", "POST", "/research/takeover", {});
    await hub.waitFor("held after the safe step", () => hub!.computers.view("research").controller.kind === "person");
    expect(hub.computers.jobView(job.json.jobId)!.paused).toBe(true);
    const id = (await hub.api("usman", "POST", "/research/terminal", {})).json.id as string;
    expect((await hub.api("usman", "POST", `/research/terminal/${id}/input`, { data: "cat notes.txt\r" })).status).toBe(200);
    const steps = hub.computers.jobView(job.json.jobId)!.steps;
    expect(steps.filter((s) => s.executor === "computer.terminal").map((s) => s.intent)).toEqual(["terminal opened by usman (100x30), as the computer's own user", "terminal: cat notes.txt"]);
    expect((await hub.api("usman", "POST", "/research/return", {})).status).toBe(200);
    await hub.waitFor("the same job finishes", () => hub!.computers.jobView(job.json.jobId)?.state === "succeeded");
    expect(hub.computers.jobView(job.json.jobId)!.steps.some((s) => s.executor === "computer.terminal" && /terminal closed/.test(s.intent))).toBe(true);
  });

  test("Stop on the computer (confirmed while held) closes its terminal", async () => {
    const shells = await ready();
    expect((await hub!.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    const id = (await hub!.api("usman", "POST", "/research/terminal", {})).json.id as string;
    expect((await hub!.api("usman", "POST", "/research/action", { action: "stop", force: true })).status).toBe(200);
    expect(shells[0].got.closed).toBe(1);
    expect((await hub!.api("usman", "GET", `/research/terminal/${id}/events?after=0`)).json.closed).toEqual({ reason: "the computer was stopped" });
  });
});
