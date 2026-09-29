// J4 test rig: the REAL Jarvis voice turn (scripts/free-voice.ts) and the REAL skills, over fakes only.
//   - Chrome   -> a CDP stub (a JS object, no process)         - Windows -> the j2 fakeWindows PsHost
//   - Groq brain / TypeSafe Jev -> a fetch stub (nothing leaves the machine)
//   - Get-StartApps -> a fixed list (primeStartApps)            - jarvis_command -> described, never executed
// SYNTHETIC: no window, no browser, no network, no mouse or keyboard.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice } from "../free-voice";
import { createJarvisSkills } from "../jarvis-skills";
import { forgetReferent } from "../jarvis-skills/referent";
import { createAgentBrowserHands } from "../j2/agent-browser";
import { fakeWindows, JARVIS_CHROME_PID } from "../j2/fake-windows";
import { matchApp, primeStartApps } from "../pc-hands";
import { MemoryReceiptSink } from "../model-router/receipts";
import { MemoryHealthStore } from "../model-router/health";
import { voiceDestination } from "../../src/lib/voice-actions";

export const FAKE_APPS = ["Google Chrome", "Notepad", "Microsoft PowerPoint", "Visual Studio Code", "Spotify", "Calculator", "Discord", "WhatsApp", "File Explorer", "Obsidian", "Word", "Excel", "Settings", "Task Manager", "Windows PowerShell", "Paint", "Snipping Tool", "Microsoft Edge"].map((name) => ({ name, id: `fake.${name}` }));

export type StubControl = { role: string; name: string };
export type StubPage = { title: string; text: string; controls?: StubControl[] };
const HOME: StubPage = { title: "M&U Ventures | Websites and automation", text: "M&U Ventures builds websites and automation for Australian small businesses. We start with a free preview.", controls: [{ role: "link", name: "Contact" }, { role: "link", name: "Pricing" }, { role: "button", name: "Send message" }, { role: "button", name: "Pay now" }] };

export function cdpStub(pages: Record<string, StubPage> = {}) {
  type Tab = { tabId: string; targetId: string; title: string; url: string; history: string[] };
  const tabs: Tab[] = [{ tabId: "t1", targetId: "T1", title: "New Tab", url: "chrome://newtab/", history: ["chrome://newtab/"] }];
  let active = 0;
  let n = 1;
  const log: string[] = [];
  const clicked: string[] = [];
  const pageOf = (url: string): StubPage => pages[url] ?? (url.includes("muventures.com.au") && !url.includes("bianca") ? HOME : { title: (() => { try { return new URL(url).hostname; } catch { return "page"; } })(), text: `The page at ${url}.`, controls: [] });
  const go = (t: Tab, url: string) => { t.url = url; t.title = url.startsWith("http") ? pageOf(url).title : "New Tab"; t.history.push(url); };
  const tabsView = () => tabs.map((t, i) => ({ tabId: t.tabId, targetId: t.targetId, title: t.title, url: t.url, type: "page", active: i === active }));
  const run = async (argv: string[]) => {
    const cmd = argv.slice(4).filter((a) => a !== "--json");
    const ok = (data: unknown = {}) => ({ code: 0, stdout: JSON.stringify({ success: true, data, error: null }) + "\n", stderr: "" });
    const bad = (error: string) => ({ code: 1, stdout: JSON.stringify({ success: false, data: null, error }) + "\n", stderr: "" });
    log.push(cmd.join(" "));
    const tab = tabs[active];
    const page = pageOf(tab.url);
    const [c, sub, arg] = cmd;
    if (c === "tab") {
      if (!sub) return ok({ tabs: tabsView() });
      if (sub === "new") { const t: Tab = { tabId: `t${++n}`, targetId: `T${n}`, title: "New Tab", url: "about:blank", history: ["about:blank"] }; tabs.push(t); active = tabs.length - 1; if (arg) go(t, arg); return ok({ tabId: t.tabId, targetId: t.targetId, url: t.url, total: tabs.length }); }
      if (sub === "close") { if (tabs.length === 1) return bad("Cannot close the last tab"); tabs.splice(active, 1); active = Math.min(active, tabs.length - 1); return ok({}); }
      const i = tabs.findIndex((t) => t.tabId === sub || t.targetId === sub);
      if (i < 0) return bad(`No tab ${sub}`);
      active = i;
      return ok({ tabId: tabs[i].tabId, targetId: tabs[i].targetId, url: tabs[i].url });
    }
    if (c === "open") return go(tab, sub), ok({ url: sub });
    if (c === "back") { if (tab.history.length < 2) return bad("No previous page"); tab.history.pop(); tab.url = tab.history[tab.history.length - 1]; return ok({ url: tab.url }); }
    if (c === "forward" || c === "reload") return ok({ url: tab.url });
    if (c === "scroll") return ok({ scrolled: true });
    if (c === "get" && sub === "title") return ok({ title: page.title });
    if (c === "get" && sub === "url") return ok({ url: tab.url });
    const control = (ref: string) => (page.controls ?? [])[Number(ref.replace("@e", "")) - 1];
    if (c === "get" && sub === "text" && String(arg).startsWith("@e")) { const ctl = control(arg); return ctl ? ok({ text: ctl.name }) : bad("Element not found"); }
    if (c === "get" && sub === "attr") { const ctl = control(cmd[2]); const key = cmd[3] === "aria-label" ? "aria" : cmd[3]; return ctl ? ok({ value: (ctl as Record<string, string | undefined>)[key] ?? null }) : bad("Element not found"); }
    if (c === "get" && sub === "text") return ok({ text: page.text });
    if (c === "snapshot") { const refs: Record<string, StubControl> = {}; (page.controls ?? []).forEach((ctl, i) => (refs[`e${i + 1}`] = ctl)); return ok({ refs, snapshot: Object.entries(refs).map(([r, v]) => `- ${v.role} "${v.name}" [ref=${r}]`).join("\n") }); }
    if (c === "eval") return ok({ result: { title: page.title, url: tab.url, text: `${page.title}\n${page.text}`, nearby: "", controls: (page.controls ?? []).map((x) => x.name).join("\n"), embeds: false, progress: false } });
    if (c === "click") { clicked.push(sub); return ok({ clicked: sub }); }
    return bad(`unknown command ${c}`);
  };
  return { run, tabs, log, clicked, active: () => tabs[active] };
}

const SAFE_EXEC = new Set(["browser", "window", "time", "maths", "units", "timer", "reminder", "clipboard", "notes", "type", "system"]);
const blockedFetch = (async (url: string) => { throw new Error(`blocked network: ${String(url).slice(0, 60)}`); }) as unknown as typeof fetch;

type Msg = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
export type Exec = { tool: string; args: Record<string, unknown>; said: string; executed: boolean };
export type Persona = "none" | "screen_act" | "control_pc" | "open_url" | "pc_act";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "j4-")); dirs.push(d); return d; };
export function cleanupRigs() { forgetReferent(); primeStartApps(null); while (dirs.length) try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ok */ } }

/** One fake person at a fake PC. `jev` answers TypeSafe (absent = unavailable); `persona` is what the fake brain picks. */
export function makeRig(opts: { persona?: Persona; jev?: Record<string, unknown>; pages?: Record<string, StubPage>; chromeFront?: boolean; sharing?: boolean; status?: () => Promise<any>; needsYou?: () => Promise<any> } = {}) {
  primeStartApps(FAKE_APPS);
  const vaultDir = temp();
  const cdp = cdpStub(opts.pages ?? {});
  const win = fakeWindows();
  const hands = createAgentBrowserHands({ run: cdp.run as never, port: 9222 });
  const launched: string[] = [];
  const skills = createJarvisSkills(temp(), {
    events: { submit: () => undefined },
    now: () => Date.UTC(2026, 8, 29, 2, 0, 0),
    ps: win.ps,
    vault: () => vaultDir,
    fetch: blockedFetch,
    reminderTasks: { register: async () => true, remove: async () => undefined, markDelivered: () => undefined, cleanupStale: async () => undefined },
    browser: { hands, ensure: async () => false },
    windows: { launch: async (a: string) => { launched.push(a); const app = matchApp(FAKE_APPS, a); return app ? `${app.name} is opening.` : `I can't find an app called ${a}.`; }, jarvisChromePid: async () => JARVIS_CHROME_PID, activateTab: async (id: string) => hands.activate(id) },
  });
  let brainCalls = 0;
  let jevCalls = 0;
  const persona = opts.persona ?? "none";
  const fetchFake = (async (url: string, init: { body?: string }) => {
    const u = String(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("typesafe")) { jevCalls++; return opts.jev ? json({ answers: opts.jev, usage: { input_tokens: 600, output_tokens: 20 } }) : new Response("{}", { status: 503 }); }
    if (u.includes("groq") || u.includes("googleapis")) {
      brainCalls++;
      const body = JSON.parse(init.body ?? "{}");
      const lastUser = [...(body.messages as Msg[])].reverse().find((m) => m.role === "user")?.content ?? "";
      let message: Record<string, unknown> = { content: "[brain] (fake: no tool chosen)" };
      const tc = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: "b1", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      if (persona === "screen_act") message = tc("screen_act", { goal: lastUser });
      if (persona === "control_pc") message = tc("control_pc", { task: lastUser });
      if (persona === "open_url") message = tc("open_url", { url: "https://www.example.com/" });
      if (persona === "pc_act") message = tc("pc_act", { action: "open_app", target: "chrome" });
      return json({ choices: [{ message }], model: "j4-fake" });
    }
    throw new Error(`blocked: ${u.slice(0, 60)}`);
  }) as unknown as typeof fetch;
  const voice = freeVoice(temp(), {
    key: (name: string) => ({ GROQ_API_KEY: "fake", TYPESAFE_API_KEY: opts.jev ? "fake" : "" } as Record<string, string>)[name] ?? "",
    fetch: fetchFake,
    sink: new MemoryReceiptSink(),
    health: new MemoryHealthStore(),
    jarvisChromeInFront: async () => opts.chromeFront ?? true,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.needsYou ? { needsYou: opts.needsYou } : {}),
  });
  const messages: Msg[] = [];
  async function execOne(name: string, args: Record<string, unknown>): Promise<Exec> {
    if (name === "skill") {
      const sk = String(args.skill);
      if (SAFE_EXEC.has(sk)) { const r = await skills.run(args); return { tool: name, args, said: r.said, executed: true }; }
      return { tool: name, args, said: `(not executed: ${sk} reads live data)`, executed: false };
    }
    if (name === "navigate") { const d = voiceDestination(args.path); return { tool: name, args, said: d ? `Opened ${d.label}.` : "That destination is not an available OS page.", executed: true }; }
    return { tool: name, args, said: `(dispatched ${name}; not executed)`, executed: false };
  }
  /** One utterance through the real turn; its tool calls run over the fakes; the spoken follow-up turn is taken. */
  async function say(text: string) {
    messages.push({ role: "user", content: text });
    // (The turn accepts 60 messages: drop the oldest whole exchanges, keeping the history a valid conversation.)
    while (messages.length > 40) { messages.shift(); while (messages.length && messages[0].role !== "user") messages.shift(); }
    const r: any = await voice.handle("/voice/free/turn", { messages, ...(opts.sharing ? { sharing: true } : {}) });
    const execs: Exec[] = [];
    let spoken: string | undefined = typeof r.content === "string" ? r.content : undefined;
    if (r.tool_calls?.length) {
      messages.push({ role: "assistant", content: null, tool_calls: r.tool_calls });
      for (const c of r.tool_calls) {
        const one = await execOne(c.function.name, JSON.parse(c.function.arguments || "{}"));
        execs.push(one);
        messages.push({ role: "tool", tool_call_id: c.id, content: one.said });
      }
      const f: any = await voice.handle("/voice/free/turn", { messages });
      spoken = typeof f.content === "string" ? f.content : undefined;
      messages.push({ role: "assistant", content: spoken ?? null });
    } else messages.push({ role: "assistant", content: r.content ?? null });
    const calls: Array<{ function: { name: string; arguments: string } }> = r.tool_calls ?? [];
    const label = calls.length
      ? calls.map((c) => { const a = JSON.parse(c.function.arguments || "{}"); const nm = c.function.name; return nm === "skill" ? `skill:${a.skill}:${a.action ?? ""}` : nm === "pc_act" ? `pc_act:${a.action}${a.target ? ":" + a.target : ""}` : nm === "navigate" ? `navigate:${a.path}` : nm === "browser_act" ? `browser_act:${a.action}` : `tool:${nm}`; }).join("+")
      : typeof r.content === "string" && r.content.startsWith("[brain]") ? "brain" : `say:${r.route?.intent ?? r.model}`;
    return { r, label, calls, execs, spoken, model: String(r.model ?? ""), get brainCalls() { return brainCalls; }, get jevCalls() { return jevCalls; } };
  }
  return { say, messages, skills, cdp, win, launched, vaultDir, close: () => skills.close(), get brainCalls() { return brainCalls; }, get jevCalls() { return jevCalls; } };
}
