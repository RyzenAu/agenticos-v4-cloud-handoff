/**
 * A tiny real-browser driver for the operations journeys (R7 G: memory, backup and restore through the app). Pure Bun/Node: it starts
 * Edge (the engine under the desktop app's WebView2) headless with its OWN --user-data-dir, speaks the DevTools protocol over the global
 * WebSocket, and quits the browser cleanly. No dependency, and it never touches any browser profile it did not create.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type OpsBrowser = Awaited<ReturnType<typeof openBrowser>>;

export async function openBrowser(opts: { profile: string; port: number; exe?: string; width?: number; height?: number }) {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 1500;
  const child: ChildProcess = spawn(opts.exe ?? EDGE, [`--remote-debugging-port=${opts.port}`, `--user-data-dir=${opts.profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let wsUrl = "";
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${opts.port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      /* not up yet */
    }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error("The browser did not start.");
  const ws = new WebSocket(wsUrl);
  const ready = new Promise<void>((r) => ws.addEventListener("open", () => r()));
  const waiting = new Map<number, (m: any) => void>();
  let id = 0;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)!(m);
      waiting.delete(m.id);
    }
  });
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    await ready;
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method, params }));
    return new Promise<any>((r) => waiting.set(n, r));
  };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value as T;
  };
  const text = () => evaluate<string>("document.body ? document.body.innerText : ''");
  const waitFor = async (js: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate<boolean>(`!!(${js})`)) return true;
      await sleep(200);
    }
    return false;
  };
  return {
    child,
    evaluate,
    text,
    waitFor,
    waitText: (needle: string, ms = 8000) => waitFor(`document.body && document.body.innerText.includes(${JSON.stringify(needle)})`, ms),
    async goto(url: string) {
      await send("Page.navigate", { url });
      await sleep(400);
      await waitFor("document.readyState === 'complete' && document.body && document.body.innerText.length > 20", 20000);
      await sleep(500);
    },
    async shot(path: string) {
      mkdirSync(dirname(path), { recursive: true });
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      writeFileSync(path, Buffer.from(r.result.data, "base64"));
    },
    /** Run a script before any page script on every new document (used to fixture reads the synthetic hub cannot produce). */
    async addInitScript(source: string) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source });
    },
    /** Click the first element matching `selector` whose trimmed text equals (or, with `contains`, includes) `label`. */
    clickText: (label: string, selector = "button", contains = false) =>
      evaluate<boolean>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => { const t = x.textContent.trim(); return ${contains ? "t.includes(" + JSON.stringify(label) + ")" : "t === " + JSON.stringify(label)}; }); if (!el) return false; el.click(); return true; })()`),
    click: (selector: string) => evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`),
    /** Focus the field and insert text as typing does (React sees real input events). Replaces what is there. */
    async type(selector: string, value: string) {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); if (el.select) el.select(); })()`);
      await send("Input.insertText", { text: value });
    },
    /** Set a cookie for a URL (used to give a synthetic browser the owner's confirmed session). */
    async setCookie(name: string, value: string, url: string) {
      await send("Network.enable");
      const r = await send("Network.setCookie", { name, value, url, httpOnly: true, sameSite: "Strict" });
      return !!r.result?.success;
    },
    /** A clean quit (not a kill), so the profile's cookies are flushed the way a normal app exit does. */
    async quit() {
      try {
        await send("Browser.close");
      } catch {
        /* closed */
      }
      ws.close();
      await sleep(1500);
    },
  };
}
