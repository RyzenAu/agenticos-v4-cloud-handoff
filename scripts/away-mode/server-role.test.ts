import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awayRoute, SERVER_AWAY_LINE } from "./service";
import { createAwayMode, type AwayDeps, type Sentinel } from "./runner";
import { auditLog, stateStore } from "./store";

/**
 * MU_HUB_ROLE=server: away mode drives a DESKTOP (screen, windows, apps) and the server has none, so for every caller and every
 * door (the OS card, voice, Telegram /task) it refuses honestly and nothing runs; a state carried over from a PC is disarmed.
 */

const OWNER = "8550678495";
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "away-server-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(disabled?: string) {
  const calls = { screen: 0, hermes: 0, launch: 0, cli: 0, files: 0 };
  const sentinel = { async start() { return true; }, stop() {}, async locked() { return false; }, async idleMs() { return 60_000; }, async shot() { return true; }, onInput() { return () => undefined; } };
  const deps: AwayDeps = {
    ...(disabled ? { disabled } : {}),
    store: stateStore(join(dir, "state")),
    audit: auditLog(join(dir, "data")),
    sentinel: sentinel as unknown as Sentinel,
    notify: async () => ({ ok: true, detail: "sent" }),
    screen: { act: async () => (calls.screen++, { type: "done", ok: true, said: "x", steps: 1, ms: 1, stepMs: [1] } as never), stopAll: () => 0, flags: () => ({ denylist: true }), foreground: async () => null, snapshot: async () => null as never },
    hermes: async () => (calls.hermes++, "done"),
    hermesAdmission: () => ({ permitted: true }),
    cli: async () => (calls.cli++, { ok: true, output: "done" }),
    files: { exists: () => false, mkdir: async () => void calls.files++, write: async () => void calls.files++, recycle: async () => void calls.files++ },
    launch: async (app) => (calls.launch++, { ok: true, said: `${app} opening` }),
    ownerChat: () => OWNER,
    home: "C:\\Users\\x",
    code: () => "7F3K",
    sleep: async () => undefined,
    config: { tickMs: 1e9, approvalTtlMs: 300_000, armIdleMs: 15_000, launchWaitMs: 100 },
  } as AwayDeps;
  return { away: createAwayMode(deps), calls };
}
const owner = (away: ReturnType<typeof createAwayMode>, text: string) => away.telegram({ platform: "telegram", userId: OWNER, chatId: OWNER, chatType: "dm", text });
const settle = async (away: ReturnType<typeof createAwayMode>) => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await away.tick();
  }
};

describe("server role: away mode drives no desktop for any caller", () => {
  test("Telegram /away on, /task and /resume answer the honest line, queue nothing and run nothing", async () => {
    const { away, calls } = build(SERVER_AWAY_LINE);
    for (const text of ["/away on", "/task tidy Downloads", "/task open notepad and type hello", "/away resume"]) {
      const r = await owner(away, text);
      expect([text, r.handled, r.reply]).toEqual([text, true, SERVER_AWAY_LINE]);
    }
    await settle(away);
    expect(away.status().on).toBe(false);
    expect(away.status().tasks).toEqual([]);
    expect(calls).toEqual({ screen: 0, hermes: 0, launch: 0, cli: 0, files: 0 });
  });

  test("voice ('away mode on', 'while I'm away, tidy Downloads') gets the same line", async () => {
    const { away, calls } = build(SERVER_AWAY_LINE);
    expect(await away.voice({ on: true })).toBe(SERVER_AWAY_LINE);
    expect(await away.voice({ task: "tidy Downloads" })).toBe(SERVER_AWAY_LINE);
    await settle(away);
    expect(away.status().tasks).toEqual([]);
    expect(calls.screen + calls.hermes + calls.launch).toBe(0);
  });

  test("a state carried over from a PC (away on, armed, a queued task) is disarmed at start and never runs", async () => {
    const pcState = build();
    await owner(pcState.away, "/away on");
    await owner(pcState.away, "/task tidy Downloads");
    expect(pcState.away.status().on).toBe(true);
    expect(pcState.away.status().tasks.length).toBe(1);
    pcState.away.close();
    const { away, calls } = build(SERVER_AWAY_LINE); // same state folder, now the server role
    await away.start();
    await settle(away);
    expect(away.status().on).toBe(false);
    expect(away.status().armed).toBe(false);
    expect(calls).toEqual({ screen: 0, hermes: 0, launch: 0, cli: 0, files: 0 });
  });

  test("stopping and turning off stay available (refusing to stop would be unsafe)", async () => {
    const { away } = build(SERVER_AWAY_LINE);
    expect((await owner(away, "/away off")).reply).not.toBe(SERVER_AWAY_LINE);
    expect((await owner(away, "/stop")).reply).not.toBe(SERVER_AWAY_LINE);
    expect((await owner(away, "/status")).handled).toBe(true);
  });

  test("the OS card route answers 501 for on, resume and task (the owner included), and still serves status", async () => {
    const { away } = build(SERVER_AWAY_LINE);
    const prior = process.env.MU_HUB_ROLE;
    process.env.MU_HUB_ROLE = "server";
    try {
      for (const remote of [null, { name: "Mehroz", role: "co-founder" }, { name: "Usman", role: "owner" }])
        for (const action of ["on", "resume", "task"]) {
          let out: { value: any; status: number } | null = null;
          const handled = await awayRoute({ path: "/away", method: "POST", body: { action, text: "tidy Downloads" }, remote, send: (value, status = 200) => void (out = { value, status }) }, away);
          expect([JSON.stringify(remote), action, handled, out!.status, out!.value.error]).toEqual([JSON.stringify(remote), action, true, 501, SERVER_AWAY_LINE]);
        }
      let status = 0;
      await awayRoute({ path: "/away", method: "GET", body: {}, remote: null, send: (_v, s = 200) => void (status = s) }, away);
      expect(status).toBe(200);
    } finally {
      if (prior === undefined) delete process.env.MU_HUB_ROLE;
      else process.env.MU_HUB_ROLE = prior;
    }
  });

  test("outside the server role nothing changes: the same requests arm and queue as before", async () => {
    const { away } = build();
    expect((await owner(away, "/away on")).reply).not.toBe(SERVER_AWAY_LINE);
    expect((await owner(away, "/task tidy Downloads")).reply).not.toBe(SERVER_AWAY_LINE);
    expect(away.status().on).toBe(true);
    expect(away.status().tasks.length).toBe(1);
  });
});

describe("server role: the relay token's permission check runs once per file version, not per request", () => {
  test("repeated /__away bearer reads do not re-run the slow ACL check (no event-loop stall from local callers)", async () => {
    const { relayToken } = await import("./service");
    const before = { role: process.env.MU_HUB_ROLE, data: process.env.MU_DATA_DIR };
    process.env.MU_HUB_ROLE = "server";
    process.env.MU_DATA_DIR = join(dir, "data");
    try {
      const first = relayToken(dir); // creates the file protected
      relayToken(dir); // first read of the existing file: may run the check once
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) expect(relayToken(dir)).toBe(first);
      // On Windows the check (icacls + PowerShell) costs ~0.7 s each; five cached reads must take far less than one check.
      expect(performance.now() - t0).toBeLessThan(250);
    } finally {
      if (before.role === undefined) delete process.env.MU_HUB_ROLE; else process.env.MU_HUB_ROLE = before.role;
      if (before.data === undefined) delete process.env.MU_DATA_DIR; else process.env.MU_DATA_DIR = before.data;
    }
  });
});