// The 26 Sep hardening pass: flags (the backend switch), the deny-list, Jev's "can this be undone?",
// the snapshot-scoped ref contract, the checked click and the loopback-only CDP launch.
import { describe, expect, test } from "bun:test";
import type { WindowInfo } from "../jarvis-skills/windows";
import { cdpArgs, cdpElements, cdpHands, CDP_ID_BASE, createCdpSessions, electronAppFrom, loopbackOnly, refJs, uiaType, type CdpClient, type CdpDeps, type CdpPage } from "./cdp";
import { FLAG_DEFAULTS, FLAGS_OFF, resolveFlags, screenFlags, type ScreenFlags } from "./flags";
import { nativeHands, runScreenAct, type Hands, type Minds } from "./index";
import { Missed, parseClickCheck, WindowMoved, type NativeScreen } from "./native";
import { deniedTyping, deniedWindow, forbiddenChord, irreversibleSubject, secureField, vetAction, vetActionWithJev, type UiElement } from "./plan";
import { isRefError, RefError, resolveRef, sameTarget, scope, whichOne } from "./refs";

let id = 500;
const el = (type: string, name: string, y: number, extra: Partial<UiElement> = {}): UiElement => ({
  id: id++, type, x: 100, y, w: 200, h: 30, password: false, enabled: true, focused: false, hasValue: ["Edit", "Document"].includes(type), readOnly: false, name, aid: "", help: "", value: "", ...extra,
});
const ALL_ON: ScreenFlags = { recheck: true, jevIrreversible: true, denylist: true, refs: true, cdp: true, jevStep: true, formFill: true, replay: true, jevControl: true };
const on = (patch: Partial<ScreenFlags>): ScreenFlags => ({ ...FLAG_DEFAULTS, ...patch });
const signal = () => new AbortController().signal;

describe("flags (the switch)", () => {
  // 27 Sep night (review finding 2): jevIrreversible is ON by default; it only ever adds a question.
  test("everything is off by default except Jev's 'can this be undone?' (jevControl too, until the Jev loop is finished)", () => {
    expect(resolveFlags({})).toEqual(FLAG_DEFAULTS);
    expect(FLAG_DEFAULTS).toEqual({ ...FLAGS_OFF, jevIrreversible: true });
    expect(screenFlags({}, "Z:/nowhere/flags.json")).toEqual(FLAG_DEFAULTS);
    expect(resolveFlags({ JARVIS_SCREEN_JEV_CONTROL: "0", JARVIS_SCREEN_JEV_IRREVERSIBLE: "0" })).toEqual(FLAGS_OFF);
  });
  test("environment variables turn single flags on and off", () => {
    expect(resolveFlags({ JARVIS_SCREEN_RECHECK: "1", JARVIS_SCREEN_DENYLIST: "true" })).toEqual(on({ recheck: true, denylist: true }));
    expect(resolveFlags({ JARVIS_SCREEN_HARDENED: "1", JARVIS_SCREEN_CDP: "0" })).toEqual({ ...ALL_ON, cdp: false });
    expect(resolveFlags({ JARVIS_SCREEN_REFS: "maybe" })).toEqual(FLAG_DEFAULTS);
  });
  test("the flags file, overridden by the environment; junk ignored", () => {
    expect(resolveFlags({}, { recheck: true, refs: "on", bogus: true })).toEqual(on({ recheck: true, refs: true }));
    expect(resolveFlags({ JARVIS_SCREEN_RECHECK: "off" }, { recheck: true })).toEqual(FLAG_DEFAULTS);
    expect(resolveFlags({}, ["recheck"])).toEqual(FLAG_DEFAULTS);
  });
});

describe("deny-list", () => {
  const win = (process: string, title: string, cls = ""): WindowInfo => ({ handle: 1, process, title, cls });
  test("password managers and Windows prompts are never touched", () => {
    expect(deniedWindow(win("1Password", "1Password"))).toMatch(/password manager/);
    expect(deniedWindow(win("KeePassXC", "Database.kdbx - KeePassXC"))).toMatch(/password manager/);
    expect(deniedWindow(win("msedge", "Bitwarden Web Vault - Microsoft Edge"))).toMatch(/password manager/);
    expect(deniedWindow(win("consent", "User Account Control"))).toMatch(/Windows sign-in or security/);
    expect(deniedWindow(win("CredentialUIBroker", "Windows Security"))).toMatch(/Windows sign-in or security/);
    expect(deniedWindow(win("explorer", "Credential Manager"))).toMatch(/password manager|security/);
    expect(deniedWindow(win("Notepad", "notes.txt - Notepad"))).toBeNull();
    expect(deniedWindow(win("SystemSettings", "Settings"))).toBeNull();
  });
  test("sign-in pages: clicks yes, typing no", () => {
    expect(deniedTyping(win("msedge", "Sign in - Google Accounts - Microsoft Edge"))).toMatch(/sign-in page/);
    expect(deniedTyping(win("msedge", "Invoice INV-0042 - Microsoft Edge"))).toBeNull();
  });
  test("secure fields: the password flag, the label or the AutomationId", () => {
    expect(secureField(el("Edit", "Passcode", 1))).toBe(true);
    expect(secureField(el("Edit", "", 1, { aid: "txtPwd" }))).toBe(true);
    expect(secureField(el("Edit", "", 1, { aid: "otp_input" }))).toBe(true);
    expect(secureField(el("Edit", "Anything", 1, { password: true }))).toBe(true);
    expect(secureField(el("Edit", "Customer name", 1, { aid: "customerName" }))).toBe(false);
    expect(secureField(el("Edit", "Spinner", 1, { aid: "spinner" }))).toBe(false);
  });
  test("lock, sign-out, shut-down and Run chords, in any spelling", () => {
    for (const k of ["win+l", "L + Win", "windows+l", "ctrl+alt+del", "control+alt+delete", "alt+f4", "win+x", "win+r", "ctrl+shift+esc", "ctrl+alt+end"]) expect(forbiddenChord(k)).toBe(true);
    for (const k of ["ctrl+a", "alt+left", "win", "ctrl+l", "shift+delete", "f4"]) expect(forbiddenChord(k)).toBe(false);
  });
  test("vetAction refuses them only with the flag, and a spoken yes never opens them", () => {
    const pw = el("Edit", "Password", 10, { password: true });
    const key = { do: "key" as const, keys: "win+l", label: "win+l" };
    expect(vetAction(key, { focused: null })).toEqual({ ok: true });
    expect(vetAction(key, { focused: null, deny: true, confirmed: "win+l" }).ok).toBe(false);
    expect(vetAction({ do: "click", element: pw }, { focused: null }).ok).toBe(true);
    expect(vetAction({ do: "click", element: pw }, { focused: null, deny: true })).toMatchObject({ ok: false, said: expect.stringMatching(/password/) });
    expect(vetAction({ do: "key", keys: "ctrl+v", label: "paste" }, { focused: pw, deny: true }).ok).toBe(false);
    expect(vetAction({ do: "key", keys: "tab", label: "tab" }, { focused: pw, deny: true }).ok).toBe(true);
    expect(vetAction({ do: "click", element: el("Button", "Next", 1) }, { focused: null, deny: true, window: win("consent", "User Account Control") }).ok).toBe(false);
    expect(vetAction({ do: "type", text: "hello", field: el("Edit", "Email", 1) }, { focused: null, deny: true, window: win("msedge", "Sign in – Microsoft account") }).ok).toBe(false);
    expect(vetAction({ do: "type", text: "hello", field: el("Edit", "", 1, { aid: "pin" }) }, { focused: null, deny: true }).ok).toBe(false);
  });
});

describe("Jev's 'can this be undone?' only ever adds a question", () => {
  const asked: unknown[] = [];
  const jev = (p: number | null) => async (subject: unknown) => (asked.push(subject), p);
  const click = (name: string, extra: Partial<UiElement> = {}) => ({ do: "click" as const, element: el("Button", name, 1, extra) });
  test("adds a spoken-yes gate the regex missed", async () => {
    const v = await vetActionWithJev(click("Clear browsing data"), { focused: null, window: { process: "chrome" } }, jev(0.93), signal());
    expect(v).toMatchObject({ ok: false, confirm: "Clear browsing data", said: expect.stringMatching(/can't be undone/), jev: 0.93 });
  });
  test("Empty Recycle Bin (which the old regex missed) is now the rules' own question, Jev not needed", async () => {
    asked.length = 0;
    const v = await vetActionWithJev(click("Empty Recycle Bin"), { focused: null, window: { process: "explorer" } }, jev(0.01), signal());
    expect(v).toMatchObject({ ok: false, confirm: "Empty Recycle Bin" });
    expect(asked).toEqual([]);
  });
  test("a low probability or no answer leaves the rules' verdict", async () => {
    expect(await vetActionWithJev(click("Display"), { focused: null }, jev(0.04), signal())).toMatchObject({ ok: true, jev: 0.04 });
    expect(await vetActionWithJev(click("Display"), { focused: null }, jev(null), signal())).toEqual({ ok: true });
    expect(await vetActionWithJev(click("Display"), { focused: null }, async () => Promise.reject(new Error("down")), signal())).toEqual({ ok: true });
  });
  test("never removes FINAL_BUTTON's question, and isn't even asked then", async () => {
    asked.length = 0;
    const v = await vetActionWithJev(click("Submit"), { focused: null }, jev(0.01), signal());
    expect(v).toMatchObject({ ok: false, confirm: "Submit" });
    expect(asked).toEqual([]);
  });
  test("his yes to that exact button stands", async () => {
    expect(await vetActionWithJev(click("Factory reset"), { focused: null, confirmed: "factory reset" }, jev(0.99), signal())).toEqual({ ok: true });
  });
  test("Jev sees role, label and app only: no values, no secure fields, no text boxes", async () => {
    asked.length = 0;
    await vetActionWithJev(click("Clear browsing data", { value: "secret-value" }), { focused: null, app: "Notepad" }, jev(0.2), signal());
    expect(asked).toEqual([{ control: "Button", label: "Clear browsing data", app: "Notepad" }]);
    expect(irreversibleSubject({ do: "type", text: "x", field: null }, { focused: null })).toBeNull();
    expect(irreversibleSubject({ do: "click", element: el("Edit", "Search", 1) }, { focused: null })).toBeNull();
    expect(irreversibleSubject({ do: "click", element: el("Button", "PIN", 1, { password: true }) }, { focused: null })).toBeNull();
    expect(irreversibleSubject({ do: "key", keys: "enter", label: "enter" }, { focused: el("Button", "Discard changes", 1) })).toMatchObject({ label: "Discard changes", confirm: "enter" });
  });
});

describe("ref contract", () => {
  const snap = scope({ window: { x: 0, y: 0, w: 800, h: 600 }, elements: [el("Button", "Save", 10), el("Button", "Save as", 50)], focused: null, browser: false });
  test("refs resolve only against the snapshot they came from", () => {
    const first = snap.elements[0];
    expect(resolveRef(`@s${snap.sid}e${first.id}`, snap)).toBe(first);
    expect(resolveRef(first.id, snap)).toBe(first);
    const later = scope(snap);
    expect(() => resolveRef(`@s${snap.sid}e${first.id}`, later)).toThrow(RefError);
    try {
      resolveRef(999_999, snap);
    } catch (error) {
      expect(isRefError(error, "STALE_REF")).toBe(true);
    }
    expect(() => resolveRef("click Save", snap)).toThrow(/isn't a control reference/);
  });
  test("sameTarget: role, name, AutomationId and a 6 px rectangle", () => {
    const a = el("Button", "Save", 100, { aid: "save" });
    expect(sameTarget(a, { ...a, x: a.x + 4 })).toBe(true);
    expect(sameTarget(a, { ...a, y: a.y + 40 })).toBe(false);
    expect(sameTarget(a, { ...a, name: "Delete all" })).toBe(false);
    expect(sameTarget(a, { ...a, aid: "delete" })).toBe(false);
    expect(sameTarget(a, { ...a, type: "Hyperlink" })).toBe(false);
    expect(sameTarget({ ...a, type: "Point", w: 2, h: 2 }, { ...a, x: 500 })).toBe(true);
    expect(sameTarget(a, null)).toBe(false);
  });
  test("the question back for look-alikes", () => {
    expect(whichOne([el("Button", "Save draft", 1), el("Button", "Save copy", 2)])).toBe('I can see more than one that fits: "Save draft" or "Save copy". Which one?');
  });
});

describe("checked click (native side)", () => {
  test("the helper's answers", () => {
    expect(parseClickCheck("2")).toEqual({ ok: true });
    expect(parseClickCheck("9999")).toEqual({ ok: false, why: "moved" });
    expect(parseClickCheck("stale\nA\t-1\tButton\t1\t2\t3\t4\te\tDelete all\t\t\t")).toMatchObject({ ok: false, why: "stale", under: expect.stringContaining("Delete all") });
    expect(parseClickCheck("missed\t10\t20")).toEqual({ ok: false, why: "pointer", at: { x: 10, y: 20 } });
    expect(parseClickCheck("covered\tUser Account Control")).toEqual({ ok: false, why: "covered", title: "User Account Control" });
    expect(parseClickCheck("0")).toMatchObject({ ok: false, why: "pointer" });
  });

  // A NativeScreen that records calls; clickAt answers from a queue.
  function fakeNative(answers: string[]) {
    const log: string[] = [];
    const native = {
      cursor: async () => ({ x: 5, y: 5 }),
      moveCursor: async (x: number, y: number) => void log.push(`move ${x},${y}`),
      click: async () => void log.push("click"),
      clickAt: async (_h: number, _x: number, _y: number, t: { name: string }) => (log.push(`clickAt ${t.name}`), parseClickCheck(answers.shift() ?? "2")),
      at: async () => "",
      act: async () => "none",
    } as unknown as NativeScreen;
    return { native, log };
  }
  const target = el("Button", "Save draft", 200);
  test("recheck off: the old click; on: the checked one", async () => {
    const off = fakeNative([]);
    await nativeHands({} as never, off.native).click(1, 10, 10);
    expect(off.log).toEqual(["click"]);
    const ok = fakeNative(["2"]);
    await nativeHands({} as never, ok.native).click(1, 10, 10, target);
    expect(ok.log[0]).toBe("clickAt Save draft");
  });
  test("each refusal becomes the right error, and nothing is clicked", async () => {
    const cases: Array<[string, (e: unknown) => boolean]> = [
      ["stale\n", (e) => isRefError(e, "STALE_REF")],
      ["missed\t0\t0", (e) => e instanceof Missed && e.why === "pointer"],
      ["covered\tNew notification", (e) => e instanceof Missed && /New notification/.test(e.message)],
      ["9999", (e) => e instanceof WindowMoved],
    ];
    for (const [answer, check] of cases) {
      const { native, log } = fakeNative([answer]);
      const error = await nativeHands({} as never, native).click(1, 10, 10, target).then(() => null, (e) => e);
      expect(check(error)).toBe(true);
      expect(log).not.toContain("click");
    }
  });
});

// --- the run loop with the flags --------------------------------------------------------------------
type Page = { elements: UiElement[] };
function fakeHands(page: Page, options: { clickErrors?: Error[]; front?: WindowInfo } = {}) {
  const log: string[] = [];
  const front = options.front ?? { handle: 42, process: "msedge", cls: "Chrome_WidgetWin_1", title: "Test form - Microsoft Edge" };
  const hands: Hands = {
    foreground: async () => front,
    windows: async () => [front],
    focus: async () => true,
    snapshot: async () => ({ window: { x: 0, y: 0, w: 1200, h: 800 }, elements: page.elements.map((e) => ({ ...e })), focused: null, browser: false }),
    focused: async () => null,
    at: async () => null,
    click: async (_h, x, y, expect) => {
      const error = options.clickErrors?.shift();
      if (error) {
        log.push(`refused ${expect?.name}`);
        throw error;
      }
      log.push(`click ${expect ? `${expect.name} (checked)` : `${x},${y}`}`);
    },
    type: async (_h, text) => void log.push(`type ${text}`),
    keys: async (_h, chord) => void log.push(`keys ${chord}`),
    wheel: async () => undefined,
    capture: async () => null,
  };
  return { hands, log };
}
const act = (goal: string, hands: Hands, flags: ScreenFlags, minds: Minds = {}, confirm?: string) =>
  runScreenAct({ goal, ...(confirm ? { confirm } : {}) }, { hands, minds, flags, signal: signal(), sleep: async () => undefined });

describe("screen_act with the flags", () => {
  test("recheck passes the chosen control to the click; off, it doesn't", async () => {
    const page = { elements: [el("Button", "Next", 100)] };
    const a = fakeHands(page);
    await act("click Next", a.hands, FLAGS_OFF);
    expect(a.log[0]).toMatch(/^click \d+,\d+$/);
    const b = fakeHands(page);
    await act("click Next", b.hands, on({ recheck: true }));
    expect(b.log).toEqual(["click Next (checked)"]);
  });
  test("STALE_REF: re-read the window and click it afresh, once", async () => {
    const page = { elements: [el("Button", "Save draft", 100)] };
    const { hands, log } = fakeHands(page, { clickErrors: [new RefError("STALE_REF", "moved")] });
    const done = await act("click Save draft", hands, on({ recheck: true }));
    expect(done).toMatchObject({ ok: true, said: 'Clicked "Save draft".' });
    expect(log).toEqual(["refused Save draft", "click Save draft (checked)"]);
  });
  test("STALE_REF twice: leave it alone", async () => {
    const page = { elements: [el("Button", "Save draft", 100)] };
    const { hands, log } = fakeHands(page, { clickErrors: [new RefError("STALE_REF", "moved"), new RefError("STALE_REF", "moved")] });
    const done = await act("click Save draft", hands, on({ recheck: true }));
    expect(done).toMatchObject({ ok: false, said: expect.stringMatching(/kept moving/) });
    expect(log.filter((l) => l.startsWith("click"))).toEqual([]);
  });
  test("Missed (a prompt over the point): stop, nothing pressed", async () => {
    const page = { elements: [el("Button", "Save draft", 100)] };
    const { hands } = fakeHands(page, { clickErrors: [new Missed("covered", "User Account Control")] });
    expect(await act("click Save draft", hands, on({ recheck: true }))).toMatchObject({ ok: false, said: expect.stringMatching(/User Account Control" was over that spot/) });
  });
  test("look-alikes: a best guess without `refs`, a question with it", async () => {
    const page = { elements: [el("Button", "Save draft", 100), el("Button", "Save copy", 160)] };
    const guess = fakeHands(page);
    expect(await act("click save", guess.hands, FLAGS_OFF)).toMatchObject({ ok: true });
    expect(guess.log).toHaveLength(1);
    const asks = fakeHands(page);
    expect(await act("click save", asks.hands, on({ refs: true }))).toMatchObject({ ok: true, ask: true, said: expect.stringMatching(/"Save draft" or "Save copy"\. Which one\?/) });
    expect(asks.log).toEqual([]);
  });
  test("deny-list: a password manager window ends the run untouched", async () => {
    const { hands, log } = fakeHands({ elements: [el("Button", "Unlock", 100)] }, { front: { handle: 9, process: "1Password", cls: "Chrome_WidgetWin_1", title: "1Password" } });
    expect(await act("click Unlock", hands, FLAGS_OFF)).toMatchObject({ ok: true });
    const denied = fakeHands({ elements: [el("Button", "Unlock", 100)] }, { front: { handle: 9, process: "1Password", cls: "Chrome_WidgetWin_1", title: "1Password" } });
    expect(await act("click Unlock", denied.hands, on({ denylist: true }))).toMatchObject({ ok: false, said: expect.stringMatching(/password manager/) });
    expect(denied.log).toEqual([]);
    void log;
  });
  test("deny-list: no Win+L, even when asked", async () => {
    const { hands, log } = fakeHands({ elements: [el("Button", "Next", 100)] });
    // Through the planner (the rules can't even say it): it asks for win+l.
    const minds: Minds = { decide: async () => ({ do: "key", keys: "win+l" }) };
    const done = await act("lock my computer for me please", hands, on({ denylist: true }), minds);
    expect(done).toMatchObject({ ok: false, said: expect.stringMatching(/lock, sign-out/) });
    expect(log).toEqual([]);
  });
  test("recheck, typing: a menu left open is closed with Escape; any other non-text focus is refused", async () => {
    const doc = el("Document", "Text editor", 100);
    const file = el("MenuItem", "File", 20);
    let focus: UiElement | null = file;
    const notepad = { handle: 7, process: "Notepad", cls: "Notepad", title: "Untitled - Notepad" };
    const make = () => {
      const f = fakeHands({ elements: [doc] }, { front: notepad });
      f.hands.focused = async () => focus;
      const keys = f.hands.keys;
      f.hands.keys = async (h, chord) => {
        await keys(h, chord);
        if (chord === "escape" && focus?.type === "MenuItem") focus = doc;
      };
      return f;
    };
    // Off: it "types" into the menu and says so (the old behaviour).
    const off = make();
    expect(await act("type hello in there", off.hands, FLAGS_OFF)).toMatchObject({ ok: true, said: 'Typed "hello".' });
    // On: Escape closes the menu, then the text goes into the document.
    focus = file;
    const on1 = make();
    expect(await act("type hello in there", on1.hands, on({ recheck: true }))).toMatchObject({ ok: true });
    expect(on1.log).toEqual(["keys escape", "type hello"]);
    // On, focus on a button: refused, nothing typed.
    focus = el("Button", "Save", 60);
    const on2 = make();
    expect(await act("type hello in there", on2.hands, on({ recheck: true }))).toMatchObject({ ok: false, said: expect.stringMatching(/isn't in a text box \(it's on "Save"\)/) });
    expect(on2.log).toEqual([]);
  });
  test("Jev's gate in the loop: asks, then presses on his yes", async () => {
    const page = { elements: [el("Button", "Clear browsing data", 100)] };
    const minds: Minds = { irreversible: async () => 0.97 };
    const first = fakeHands(page);
    expect(await act("click Clear browsing data", first.hands, on({ jevIrreversible: true }), minds)).toMatchObject({ ok: false, confirm: "Clear browsing data" });
    expect(first.log).toEqual([]);
    const yes = fakeHands(page);
    expect(await act("click Clear browsing data", yes.hands, on({ jevIrreversible: true }), minds, "Clear browsing data")).toMatchObject({ ok: true });
    expect(yes.log).toHaveLength(1);
    const off = fakeHands(page);
    expect(await act("click Clear browsing data", off.hands, FLAGS_OFF, minds)).toMatchObject({ ok: true });
    // Empty Recycle Bin used to run here with the flag off (the regex missed it): now the rules ask.
    const bin = fakeHands({ elements: [el("Button", "Empty Recycle Bin", 100)] });
    expect(await act("click Empty Recycle Bin", bin.hands, FLAGS_OFF, minds)).toMatchObject({ ok: false, confirm: "Empty Recycle Bin" });
    expect(bin.log).toEqual([]);
  });
});

// --- CDP ------------------------------------------------------------------------------------------
describe("CDP launch (loopback only, on request)", () => {
  test("switches: a loopback port, and nobody else sets a debugging switch", () => {
    expect(cdpArgs(9321)).toEqual(["--remote-debugging-port=9321", "--remote-debugging-address=127.0.0.1"]);
    expect(() => cdpArgs(9321, ["--remote-debugging-address=0.0.0.0"])).toThrow(/Jarvis alone/);
    expect(() => cdpArgs(9321, ["--remote-allow-origins=*"])).toThrow();
    expect(() => cdpArgs(80)).toThrow();
    expect(loopbackOnly(["127.0.0.1"])).toBe(true);
    expect(loopbackOnly(["127.0.0.1", "::1"])).toBe(true);
    expect(loopbackOnly(["0.0.0.0"])).toBe(false);
    expect(loopbackOnly(["127.0.0.1", "192.168.1.5"])).toBe(false);
    expect(loopbackOnly([])).toBe(false);
  });
  test("only listed apps, by name", () => {
    expect(electronAppFrom("open VS Code so you can drive it")?.key).toBe("vscode");
    expect(electronAppFrom("obsidian")?.key).toBe("obsidian");
    expect(electronAppFrom("chrome")).toBeNull();
    expect(() => refJs(1.5)).toThrow();
    expect(refJs(3)).toContain(")(3)");
  });
  const deps = (over: Partial<CdpDeps> = {}) => {
    const log: string[] = [];
    const d: CdpDeps = {
      env: { LOCALAPPDATA: "C:/L" },
      exists: () => true,
      start: (exe, args) => (log.push(`start ${args.join(" ")}`), 4242),
      running: async () => false,
      listeners: async () => (log.some((l) => l.startsWith("start")) ? ["127.0.0.1"] : []),
      kill: async (pid) => void log.push(`kill ${pid}`),
      request: (async () => new Response(JSON.stringify({ Browser: "Chrome/140" }))) as unknown as typeof fetch,
      sleep: async () => undefined,
      ...over,
    };
    return { d, log };
  };
  test("refused while the app is already running (his windows are never closed)", async () => {
    const { d, log } = deps({ running: async () => true });
    expect(await createCdpSessions(d).launch("vscode")).toMatchObject({ ok: false, said: expect.stringMatching(/already open/) });
    expect(log).toEqual([]);
  });
  test("a port reachable beyond loopback: closed again, not driven", async () => {
    const { d, log } = deps();
    d.listeners = async () => (log.some((l) => l.startsWith("start")) ? ["0.0.0.0"] : []);
    const s = createCdpSessions(d);
    expect(await s.launch("vscode")).toMatchObject({ ok: false, said: expect.stringMatching(/outside this PC/) });
    expect(log).toContain("kill 4242");
    expect(s.list()).toEqual([]);
  });
  test("launched: a session for that app's windows", async () => {
    const { d, log } = deps();
    const s = createCdpSessions(d);
    const r = await s.launch("vscode");
    expect(r).toMatchObject({ ok: true, app: "vscode" });
    expect(log[0]).toMatch(/^start --remote-debugging-port=93\d\d --remote-debugging-address=127\.0\.0\.1$/);
    expect((await s.forWindow({ process: "Code" }))?.port).toBe(r.port!);
    expect(await s.forWindow({ process: "notepad" })).toBeNull();
  });
});

describe("CDP hands", () => {
  const page: CdpPage = {
    dpr: 1.5, innerWidth: 1000, innerHeight: 700, outerWidth: 1000, outerHeight: 700,
    items: [
      { i: 0, tag: "button", role: "", type: "", name: "Run", id: "run", x: 10, y: 20, w: 60, h: 20, disabled: false, focused: false, password: false, checked: null, expanded: null, selected: false, value: "", readOnly: false },
      { i: 1, tag: "input", role: "", type: "password", name: "Token", id: "", x: 10, y: 60, w: 200, h: 20, disabled: false, focused: false, password: true, checked: null, expanded: null, selected: false, value: "", readOnly: false },
      { i: 2, tag: "div", role: "tab", type: "", name: "Explorer", id: "", x: 0, y: 0, w: 40, h: 40, disabled: false, focused: false, password: false, checked: null, expanded: null, selected: true, value: "", readOnly: false },
    ],
  };
  test("page controls become screen elements (roles, dpr, password flag)", () => {
    const els = cdpElements(page, { x: 100, y: 200 });
    expect(els[0]).toMatchObject({ id: CDP_ID_BASE, type: "Button", x: 115, y: 230, w: 90, h: 30, name: "Run", aid: "run", web: true });
    expect(els[1]).toMatchObject({ type: "Edit", password: true, value: "" });
    expect(els[2]).toMatchObject({ type: "TabItem", selected: true });
    expect(uiaType({ tag: "a", role: "", type: "" })).toBe("Hyperlink");
    expect(uiaType({ tag: "input", role: "", type: "checkbox" })).toBe("CheckBox");
    const status = cdpElements({ ...page, items: [{ ...page.items[0], tag: "p", role: "status", type: "statictext", name: "Project opened", disabled: true, readOnly: true }] }, { x: 0, y: 0 })[0];
    expect(status).toMatchObject({ type: "Text", enabled: false, invokable: false, hasValue: false });
  });
  function fakeClient(refNow: () => object | null) {
    const sent: string[] = [];
    const client: CdpClient = {
      send: async (method, params = {}) => {
        sent.push(method === "Input.dispatchMouseEvent" ? `${method} ${params.type} ${params.x},${params.y}` : method);
        if (method !== "Runtime.evaluate") return {};
        const expr = String(params.expression);
        if (expr.includes("jarvis.refs\")] = refs")) return { result: { value: JSON.stringify(page) } };
        if (expr.includes('Symbol.for("jarvis.refs")] || [])')) {
          const now = refNow();
          return { result: { value: now ? JSON.stringify(now) : null } };
        }
        return { result: { value: null } };
      },
      close: () => undefined,
    };
    return { client, sent };
  }
  const base = fakeHands({ elements: [el("Document", "", 200, { x: 100, w: 1500, h: 1050 })] }).hands;
  const win: WindowInfo = { handle: 42, process: "Code", cls: "Chrome_WidgetWin_1", title: "Welcome - Visual Studio Code" };
  test("a press re-reads the ref and clicks in the page (his pointer never moves)", async () => {
    const { client, sent } = fakeClient(() => ({ x: 10, y: 20, w: 60, h: 20, name: "Run" }));
    const hands = cdpHands(base, client);
    const snap = await hands.snapshot(win);
    const run = snap.elements.find((e) => e.name === "Run")!;
    expect(await hands.press!(42, run, true)).toBe("uia");
    expect(sent.filter((s) => s.startsWith("Input"))).toEqual(["Input.dispatchMouseEvent mouseMoved 40,30", "Input.dispatchMouseEvent mousePressed 40,30", "Input.dispatchMouseEvent mouseReleased 40,30"]);
  });
  test("a ref that moved or vanished is STALE_REF, and nothing is dispatched", async () => {
    for (const now of [{ x: 10, y: 90, w: 60, h: 20, name: "Run" }, { x: 10, y: 20, w: 60, h: 20, name: "Delete" }, null]) {
      const { client, sent } = fakeClient(() => now);
      const hands = cdpHands(base, client);
      const run = (await hands.snapshot(win)).elements.find((e) => e.name === "Run")!;
      const error = await hands.press!(42, run, true).then(() => null, (e) => e);
      expect(isRefError(error, "STALE_REF")).toBe(true);
      expect(sent.some((s) => s.startsWith("Input"))).toBe(false);
    }
  });
});
