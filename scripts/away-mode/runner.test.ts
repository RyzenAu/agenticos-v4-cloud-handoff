// Away mode's safety model with every Windows call mocked: the approval gate, the lock, the kill
// switch, his own input, the never-list and the 7-day log retention.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenDone, ScreenRequest, Snapshot, UiElement } from "../screen-hands";
import type { WindowInfo } from "../jarvis-skills/windows";
import { createAwayMode, type AwayDeps, type FilePort, type ScreenPort } from "./runner";
import type { Notice } from "./notify";
import type { RealInput, Rect, Sentinel } from "./sentinel";
import { auditLog, stateStore, sydneyDay } from "./store";

const OWNER = "8550678495";
const HOME = "C:\\Users\\Nebula PC";
let dir: string;
let clock: number;

function fakeSentinel() {
  const listeners = new Set<(i: RealInput) => void>();
  const s = {
    running: false,
    lockedNow: false as boolean | null,
    idle: 60_000,
    shots: [] as Array<{ path: string; rect: Rect; masks: Rect[]; ring?: Rect | null }>,
    async start() {
      s.running = true;
      return true;
    },
    stop() {
      s.running = false;
    },
    async locked() {
      return s.running ? s.lockedNow : null;
    },
    async idleMs() {
      return s.idle;
    },
    async shot(path: string, rect: Rect, masks: Rect[], ring?: Rect | null) {
      s.shots.push({ path, rect, masks, ring });
      return true;
    },
    onInput(l: (i: RealInput) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    press(kind: RealInput["kind"] = "mouse") {
      for (const l of listeners) l({ kind, at: clock });
    },
  };
  return s;
}

function fakeFiles() {
  const disk = new Map<string, string>();
  const recycled: string[] = [];
  const port: FilePort = {
    exists: (p) => disk.has(p),
    mkdir: async (p) => void disk.set(p, "<dir>"),
    write: async (p, t) => {
      if (disk.has(p)) throw new Error("exists");
      disk.set(p, t);
    },
    recycle: async (p) => {
      recycled.push(p);
      disk.delete(p);
    },
  };
  return { port, disk, recycled };
}

let elId = 1;
const el = (type: string, name: string, extra: Partial<UiElement> = {}): UiElement => ({ id: elId++, type, x: 100, y: 100, w: 120, h: 30, password: false, enabled: true, focused: false, hasValue: false, readOnly: false, name, aid: "", help: "", value: "", ...extra });
const NOTEPAD: WindowInfo = { handle: 11, process: "Notepad", cls: "Notepad", title: "Untitled - Notepad" };

function fakeScreen(script: (req: ScreenRequest, signal: AbortSignal) => Promise<Partial<ScreenDone>>) {
  const calls: ScreenRequest[] = [];
  let stops = 0;
  let front: WindowInfo | null = NOTEPAD;
  const snapshot: Snapshot = {
    window: { x: 0, y: 0, w: 1200, h: 800 },
    elements: [el("Edit", "Password", { password: true, x: 50, y: 60 }), el("Button", "Discard", { x: 500, y: 400 }), el("Edit", "Notes", { value: "4111 1111 1111 1111" })],
    focused: null,
    browser: false,
  };
  const port: ScreenPort = {
    act: async (req, signal) => {
      calls.push(req);
      const r = await script(req, signal);
      return { type: "done", ok: true, said: "Done.", steps: 1, ms: 5, stepMs: [5], ...r } as ScreenDone;
    },
    stopAll: () => ++stops,
    flags: () => ({ denylist: true }),
    foreground: async () => front,
    snapshot: async () => snapshot,
  };
  return {
    port,
    calls,
    get stops() {
      return stops;
    },
    setFront(w: WindowInfo | null) {
      front = w;
    },
  };
}

function setup(over: Partial<AwayDeps> = {}, screenScript?: (req: ScreenRequest, signal: AbortSignal) => Promise<Partial<ScreenDone>>) {
  const sentinel = fakeSentinel();
  const files = fakeFiles();
  const screen = fakeScreen(screenScript ?? (async () => ({})));
  const told: Notice[] = [];
  const hermesPrompts: string[] = [];
  const launched: string[] = [];
  const cli: string[][] = [];
  const away = createAwayMode({
    store: stateStore(join(dir, "state")),
    audit: auditLog(join(dir, "data"), () => new Date(clock)),
    sentinel: sentinel as unknown as Sentinel,
    notify: async (n) => {
      told.push(n);
      return { ok: true, detail: "sent" };
    },
    screen: screen.port,
    hermes: async (prompt) => {
      hermesPrompts.push(prompt);
      return "Tidied 12 files into D:\\Downloads\\sorted.";
    },
    // A synthetic Hermes: past the Hermes control block (AUDIT F4 F6), which production never passes.
    // Pass `hermesAdmission: undefined` to test the real block.
    hermesAdmission: () => ({ permitted: true }),
    cli: async (recipe) => {
      cli.push(recipe.argv);
      return { ok: true, output: "Done: 3/3 processed" };
    },
    files: files.port,
    launch: async (app) => {
      launched.push(app);
      return { ok: true, said: `${app} is opening.` };
    },
    ownerChat: () => OWNER,
    home: HOME,
    now: () => clock,
    code: () => "7F3K",
    sleep: async () => undefined,
    config: { tickMs: 1e9, approvalTtlMs: 5 * 60_000, armIdleMs: 15_000, launchWaitMs: 1000 },
    ...over,
  });
  const owner = (text: string) => away.telegram({ platform: "telegram", userId: OWNER, chatId: OWNER, chatType: "dm", text });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Let everything runnable run: ticks until the queue is idle (or waiting on him). */
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (away.busy || away.running !== null) continue;
      await away.tick();
    }
  };
  return { away, sentinel, files, screen, told, hermesPrompts, launched, cli, owner, flush, settle };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "away-"));
  clock = Date.parse("2026-09-25T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const texts = (told: Notice[]) => told.map((n) => n.text).join("\n---\n");

describe("the approval gate", () => {
  async function toApproval() {
    const t = setup();
    t.files.disk.set("D:\\tmp\\away-test\\note.txt", "hi");
    await t.owner("/away on");
    await t.owner("/task delete D:\\tmp\\away-test\\note.txt");
    await t.settle();
    expect(t.away.status().pending).toMatchObject({ action: "Delete D:\\tmp\\away-test\\note.txt (to the Recycle Bin)" });
    expect(texts(t.told)).toContain('Reply "yes 7F3K"');
    expect(t.files.recycled).toEqual([]);
    return t;
  }
  test("no approval: nothing is deleted, and the timeout closes it as not approved", async () => {
    const t = await toApproval();
    clock += 4 * 60_000;
    await t.settle();
    expect(t.files.recycled).toEqual([]);
    clock += 2 * 60_000;
    await t.settle();
    expect(t.away.status().pending).toBeNull();
    expect(t.away.status().tasks.at(-1)?.status).toBe("not_approved");
    expect(texts(t.told)).toContain("Not approved (timed out)");
    // A late "yes" does nothing.
    expect((await t.owner("yes 7F3K")).reply).toContain("Nothing is waiting");
    await t.flush();
    expect(t.files.recycled).toEqual([]);
    expect(t.files.disk.has("D:\\tmp\\away-test\\note.txt")).toBe(true);
  });
  test("a wrong code does nothing; three wrong codes cancel it", async () => {
    const t = await toApproval();
    expect((await t.owner("yes 7F3X")).reply).toContain("doesn't match");
    await t.flush();
    expect(t.files.recycled).toEqual([]);
    await t.owner("yes 2222");
    expect((await t.owner("yes 3333")).reply).toContain("cancelled");
    await t.flush();
    expect(t.files.recycled).toEqual([]);
    expect(t.away.status().tasks.at(-1)?.status).toBe("not_approved");
  });
  test("the right code from another chat (Mehroz, a group) does nothing", async () => {
    const t = await toApproval();
    const mehroz = await t.away.telegram({ platform: "telegram", userId: "8374577224", chatId: "8374577224", chatType: "dm", text: "yes 7F3K" });
    expect(mehroz.reply).toContain("Only Usman");
    const group = await t.away.telegram({ platform: "telegram", userId: OWNER, chatId: "-100123", chatType: "group", text: "yes 7F3K" });
    expect(group.reply).toContain("Only Usman");
    await t.flush();
    expect(t.files.recycled).toEqual([]);
    expect(t.away.status().pending).not.toBeNull();
  });
  test("'no CODE' skips it", async () => {
    const t = await toApproval();
    expect((await t.owner("no 7F3K")).reply).toContain("not doing it");
    await t.flush();
    expect(t.files.recycled).toEqual([]);
  });
  test("'yes CODE' from his own chat, in time: exactly that one action runs", async () => {
    const t = await toApproval();
    expect((await t.owner("yes 7f3k")).reply).toContain("Approved once");
    await t.settle();
    expect(t.files.recycled).toEqual(["D:\\tmp\\away-test\\note.txt"]);
    expect(t.away.status().tasks.at(-1)?.status).toBe("done");
  });
  // REVIEW-SAFETY finding 1 (27 Sep night): this test used to expect a code request with a masked
  // screenshot, then one press of "Discard" after "yes 7F3K". Unattended runs never press a final or
  // money button now (Stage B's durable approvals will re-enable exact actions), so it's refused.
  test("a screen final button is refused unattended: no code asked, nothing pressed", async () => {
    const t = setup({}, async (req) => (req.goal === "click Discard" && !req.confirm ? { ok: false, confirm: "Discard", said: 'That\'s the final "Discard" button. Shall I press it?' } : {}));
    await t.owner("/away on");
    await t.owner("/task open Notepad, click Discard");
    await t.settle();
    expect(t.away.status().pending).toBeNull();
    expect(t.away.status().tasks[0]).toMatchObject({ status: "refused" });
    expect(t.away.status().tasks[0].result).toContain("never pressed while you're away");
    expect(texts(t.told)).not.toContain("yes 7F3K");
    expect(t.screen.calls.filter((c) => c.confirm)).toHaveLength(0);
  });
  test("screenshots of a screen step still paint over the password field and the card-like value", async () => {
    const t = setup();
    await t.owner("/away on");
    await t.owner("/task open Notepad, click Help");
    await t.settle();
    const shot = t.sentinel.shots.at(-1)!;
    expect(shot.masks).toHaveLength(2);
  });
});

describe("the never-list", () => {
  test("refused at the door, even before anything runs", async () => {
    const t = setup();
    await t.owner("/away on");
    for (const task of ["/task pay the Vercel invoice", "/task open Bitwarden and copy the password", "/task email the client the proposal", "/task install OBS", "/task turn off Windows Defender", "/task log in to NetBank"])
      expect((await t.owner(task)).reply).toContain("won't do that");
    await t.settle();
    expect(t.hermesPrompts).toEqual([]);
    expect(t.screen.calls).toEqual([]);
  });
  test("a Send or Pay button is refused outright, never offered for approval", async () => {
    const t = setup({}, async () => ({ ok: false, confirm: "Send", said: "Shall I press it?" }));
    await t.owner("/away on");
    await t.owner("/task open Notepad, click the blue button");
    await t.settle();
    expect(t.away.status().pending).toBeNull();
    expect(t.away.status().tasks.at(-1)?.status).toBe("refused");
    expect(t.screen.calls.filter((c) => c.confirm)).toHaveLength(0);
  });
  test("a banking window in front stops a screen task", async () => {
    const t = setup();
    t.screen.setFront({ handle: 3, process: "chrome", cls: "Chrome_WidgetWin_1", title: "NetBank - CommBank - Google Chrome" });
    await t.owner("/away on");
    await t.owner("/task open Chrome, type hello");
    await t.settle();
    expect(t.screen.calls).toEqual([]);
  });
});

describe("the locked PC", () => {
  test("screen tasks wait; file, CLI and Hermes tasks still run; he's told once", async () => {
    const t = setup();
    t.sentinel.lockedNow = true;
    await t.owner("/away on");
    await t.owner("/task open Notepad, type hello");
    await t.owner("/task create a folder D:\\tmp\\away-test");
    await t.owner("/task run the lead phone-finder");
    await t.settle();
    await t.settle();
    await t.settle();
    expect(t.screen.calls).toEqual([]);
    expect(t.launched).toEqual([]);
    expect(t.files.disk.has("D:\\tmp\\away-test")).toBe(true);
    expect(t.cli).toEqual([["scripts/leads/cli.ts", "phones", "run"]]);
    expect(t.told.filter((n) => n.text.startsWith("PC is locked"))).toHaveLength(1);
    expect(t.away.status().tasks.find((x) => x.text.startsWith("open Notepad"))?.status).toBe("queued");
    t.sentinel.lockedNow = false;
    await t.settle();
    expect(t.launched).toEqual(["Notepad"]);
  });
});

describe("the kill switch", () => {
  test("/stop halts the running screen action at once and pauses the queue", async () => {
    let seen: AbortSignal | null = null;
    const t = setup({}, (req, signal) => {
      seen = signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, stopped: true, said: "Stopped." })));
    });
    await t.owner("/away on");
    await t.owner("/task open Notepad, type a very long line");
    await t.owner("/task create a folder D:\\tmp\\next");
    const running = t.away.tick();
    await t.flush();
    expect(t.away.running).not.toBeNull();
    const reply = (await t.owner("/stop")).reply!;
    await running;
    expect(seen!.aborted).toBe(true);
    expect(t.screen.stops).toBeGreaterThan(0);
    expect(reply).toContain("Stopped #");
    expect(t.away.status().paused).toBe(true);
    await t.settle();
    expect(t.files.disk.has("D:\\tmp\\next")).toBe(false);
    expect((await t.owner("/away resume")).reply).toContain("Resumed");
    await t.settle();
    expect(t.files.disk.has("D:\\tmp\\next")).toBe(true);
  });
  test("his own mouse halts it and switches away mode off; Jarvis's pointer moves don't", async () => {
    let seen: AbortSignal | null = null;
    const t = setup({}, (req, signal) => {
      seen = signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, stopped: true, said: "Stopped." })));
    });
    await t.owner("/away on");
    await t.owner("/task open Notepad, type hello");
    const running = t.away.tick();
    await t.flush();
    t.sentinel.press("move"); // a pointer move mid screen step: ignored
    expect(seen!.aborted).toBe(false);
    t.sentinel.press("mouse"); // a real click: he's back
    await running;
    expect(seen!.aborted).toBe(true);
    expect(t.away.status().on).toBe(false);
    expect(texts(t.told)).toContain("You're back at the PC");
  });
  test("nothing starts until the PC has been idle long enough (arming)", async () => {
    const t = setup();
    t.sentinel.idle = 2_000;
    await t.away.turnOn("voice");
    await t.owner("/task create a folder D:\\tmp\\a");
    await t.settle();
    expect(t.files.disk.size).toBe(0);
    t.sentinel.press("key"); // still at the desk: resets the idle clock, doesn't switch it off
    expect(t.away.status().on).toBe(true);
    clock += 16_000;
    await t.settle();
    expect(t.away.status().armed).toBe(true);
    expect(t.files.disk.has("D:\\tmp\\a")).toBe(true);
  });
});

describe("routes", () => {
  for (const outcome of ["unverified", "step_limit", "no_progress"] as const) {
    test(`screen failure retains ${outcome} across persistence and never requeues`, async () => {
      const t = setup({}, async () => ({ ok: false, outcome, said: "Changed a control but could not verify completion. ".repeat(30) }));
      await t.owner("/away on");
      await t.owner("/task open Notepad, click Help");
      await t.settle();
      const task = t.away.status().tasks[0];
      expect(task.status).toBe("failed");
      expect(task.result).toStartWith(`[screen outcome: ${outcome}] `);
      const persisted = stateStore(join(dir, "state")).read();
      expect(persisted.version).toBe(1);
      expect(persisted.tasks[0].result).toBe(task.result);
      const calls = t.screen.calls.length;
      expect(calls).toBe(1);
      await t.settle();
      expect(t.screen.calls).toHaveLength(calls);
      expect(t.away.status().tasks[0].status).toBe("failed");
      expect(t.away.status().pending).toBeNull();
    });
  }
  test("screen clarification retains the failure outcome", async () => {
    const t = setup({}, async () => ({ ok: false, ask: true, outcome: "unverified", said: "Which control?" }));
    await t.owner("/away on");
    await t.owner("/task open Notepad, click Help");
    await t.settle();
    expect(t.away.status().tasks[0]).toMatchObject({ status: "failed", result: "[screen outcome: unverified] It needs an answer I can't get while you're away: Which control?" });
  });
  // Stage 0 F3 (27 Sep night): this test used to expect a delete NEEDS_APPROVAL to become an approval
  // request. An approval through Hermes binds only to its words, so for deleting, money, publishing and
  // account changes it is now refused and never replayed; other actions still ask for his code.
  test("Hermes gets the away brief; a NEEDS_APPROVAL to delete is refused, never offered or replayed", async () => {
    const t = setup({
      hermes: async () => "NEEDS_APPROVAL: delete 3 duplicate PDFs in C:\\Users\\Nebula PC\\Downloads",
    });
    await t.owner("/away on");
    await t.owner("/task tidy Downloads");
    await t.settle();
    expect(t.away.status().pending).toBeNull();
    expect(t.away.status().tasks[0]).toMatchObject({ status: "refused" });
    expect(t.away.status().tasks[0].result).toContain("binds only to words");
  });
  // REVIEW-SAFETY finding 5: this used to become an approval request (prose replayed to Hermes).
  // Until Stage B every Hermes NEEDS_APPROVAL is refused: restart, book, cancel, subscribe, accept.
  for (const action of ["restart the lead-sites preview server", "book a meeting with Mehroz for Monday", "cancel the Vercel trial", "subscribe to the newsletter", "accept the calendar invite"])
    test(`a NEEDS_APPROVAL to "${action}" is refused, never asked about or replayed`, async () => {
      const t = setup({ hermes: async () => `NEEDS_APPROVAL: ${action}` });
      await t.owner("/away on");
      await t.owner("/task tidy Downloads");
      await t.settle();
      expect(t.away.status().pending).toBeNull();
      expect(t.away.status().tasks[0].status).toBe("refused");
    });
  for (const action of ["pay the Vercel invoice of $20", "publish the preview to production", "change the Vercel account password", "remove the old leads folder"])
    test(`F3: a NEEDS_APPROVAL to "${action}" is refused`, async () => {
      const t = setup({ hermes: async () => `NEEDS_APPROVAL: ${action}` });
      await t.owner("/away on");
      await t.owner("/task tidy Downloads");
      await t.settle();
      expect(t.away.status().pending).toBeNull();
      expect(t.away.status().tasks[0].status).toBe("refused");
    });
  test("F1: a Hermes task off the control allowlist is refused before any Hermes call", async () => {
    const t = setup();
    await t.owner("/away on");
    await t.owner("/task reconfigure the router firmware");
    await t.settle();
    expect(t.hermesPrompts).toEqual([]);
    expect(t.away.status().tasks[0]).toMatchObject({ status: "refused" });
    expect(t.away.status().tasks[0].result).toContain("control allowlist");
  });
  test("F9: the one-time code is never written to disk (state file or audit log)", async () => {
    const t = setup();
    t.files.disk.set("D:\\tmp\\away-test\\note.txt", "hi");
    await t.owner("/away on");
    await t.owner("/task delete D:\\tmp\\away-test\\note.txt");
    await t.settle();
    expect(t.away.status().pending).not.toBeNull();
    const onDisk = [readFileSync(join(dir, "state", "state.json"), "utf8"), ...readdirSync(join(dir, "data", "log")).map((f) => readFileSync(join(dir, "data", "log", f), "utf8"))].join("\n");
    expect(onDisk).not.toContain("7F3K");
    expect(onDisk).toContain("codeHash");
    // The right code still approves it (compared by HMAC in memory); a wrong one doesn't.
    expect((await t.owner("yes 2B2B")).reply).toContain("doesn't match");
    expect((await t.owner("yes 7F3K")).reply).not.toContain("doesn't match");
  });
  test("the brief forbids the screen, deletes and messages", async () => {
    const t = setup();
    await t.owner("/away on");
    await t.owner("/task tidy Downloads");
    await t.settle();
    expect(t.hermesPrompts[0]).toContain("Don't use computer_use");
    expect(t.hermesPrompts[0]).toContain("Do NOT delete");
    expect(texts(t.told)).toContain("Done: #1 tidy Downloads");
  });
  test("files: never outside the safe folders, never overwrite", async () => {
    const t = setup();
    await t.owner("/away on");
    await t.owner("/task create a folder C:\\Windows\\evil");
    t.files.disk.set("D:\\tmp\\x.txt", "old");
    await t.owner("/task create a file called x.txt in D:\\tmp with new");
    await t.settle();
    await t.settle();
    expect(t.files.disk.has("C:\\Windows\\evil")).toBe(false);
    expect(t.files.disk.get("D:\\tmp\\x.txt")).toBe("old");
    expect(t.away.status().tasks.map((x) => x.status)).toEqual(["refused", "refused"]);
  });
});

describe("queued before leaving", () => {
  test("'delete that test file' queued ahead of the task that makes it resolves at run time, and still asks", async () => {
    const t = setup();
    await t.owner("/task create a folder D:\\tmp\\away-test and write a text file there saying hello");
    await t.owner("/task delete that test file");
    await t.owner("/away on");
    await t.settle();
    const del = t.away.status().tasks[1];
    expect(del.route).toBe("file");
    expect(t.away.status().pending?.action).toBe("Delete D:\\tmp\\away-test\\note.txt (to the Recycle Bin)");
    expect(t.hermesPrompts).toEqual([]);
    expect(t.files.recycled).toEqual([]);
  });
});

describe("the audit log", () => {
  test("F9: one log file per Sydney calendar day, not UTC's", () => {
    // 27 Sep 2026 23:30 UTC is already 28 Sep in Sydney (AEST, UTC+10; AEDT starts 4 Oct).
    expect(sydneyDay("2026-09-27T23:30:00.000Z")).toBe("2026-09-28");
    expect(sydneyDay("2026-09-27T13:59:00.000Z")).toBe("2026-09-27");
    const log = auditLog(join(dir, "sydney"), () => new Date("2026-09-27T23:30:00.000Z"));
    log.write({ action: "test", result: "ok" });
    expect(readdirSync(join(dir, "sydney", "log"))).toEqual(["2026-09-28.jsonl"]);
  });
  test("every step is logged; /log shows the last N", async () => {
    const t = setup();
    await t.owner("/away on");
    await t.owner("/task create a folder D:\\tmp\\away-test and write a text file there saying hello");
    await t.settle();
    const log = (await t.owner("/log 5")).reply!;
    expect(log).toContain("write D:\\tmp\\away-test\\note.txt");
    expect(log.split("\n")).toHaveLength(5);
  });
  test("log files and screenshots older than 7 days are pruned; newer ones stay", () => {
    const audit = auditLog(join(dir, "data"), () => new Date("2026-09-25T10:00:00Z"));
    for (const d of ["2026-09-10", "2026-09-17", "2026-09-18", "2026-09-25"]) {
      mkdirSync(join(dir, "data", "log"), { recursive: true });
      writeFileSync(join(dir, "data", "log", `${d}.jsonl`), "{}\n");
      mkdirSync(join(dir, "data", "shots", d), { recursive: true });
      writeFileSync(join(dir, "data", "shots", d, "a.jpg"), "x");
    }
    const removed = audit.prune();
    expect(removed).toHaveLength(4);
    expect(readdirSync(join(dir, "data", "log")).sort()).toEqual(["2026-09-18.jsonl", "2026-09-25.jsonl"]);
    expect(readdirSync(join(dir, "data", "shots")).sort()).toEqual(["2026-09-18", "2026-09-25"]);
  });
  test("no secrets in the log", () => {
    const audit = auditLog(join(dir, "data"), () => new Date(clock));
    audit.write({ action: "x", target: "card 4111 1111 1111 1111", result: "key sk-live_abcdefghijklmnop1234" });
    const [entry] = audit.tail(1);
    expect(entry.target).toBe("card [number]");
    expect(entry.result).toBe("key [key]");
  });
});

describe("restarts", () => {
  test("a task cut off mid-run is closed, not re-run", async () => {
    const store = stateStore(join(dir, "state"));
    store.update((s) => {
      s.tasks.push({ id: 1, text: "tidy Downloads", route: "hermes", plan: { route: "hermes" }, from: "telegram", status: "running", createdAt: "x" });
      s.nextId = 2;
    });
    const t = setup();
    await t.away.start();
    expect(t.away.status().tasks[0].status).toBe("interrupted");
    expect(existsSync(join(dir, "state", "state.json"))).toBe(true);
  });
});
