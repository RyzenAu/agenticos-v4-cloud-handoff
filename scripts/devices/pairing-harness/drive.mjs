// Drives the pairing harness (hub.ts) in a REAL Chromium profile that behaves like the desktop app's WebView2: one persistent profile
// folder, cookies kept across browser restarts, a normal HTTP origin. Pure Node (global WebSocket + fetch); no new dependency.
//
//   node scripts/devices/pairing-harness/drive.mjs --out docs/programme-20261001/evidence/r7-ops --profile D:\AgenticOS-r7-data\g\webview-profile
//
// It only talks to http://127.0.0.1:8127 (the synthetic hub) and a browser it starts itself with its own --user-data-dir.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const out = resolve(arg("out", "evidence"));
const profile = resolve(arg("profile", "webview-profile"));
const base = arg("base", "http://127.0.0.1:8127");
const exe = arg("exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
const debugPort = Number(arg("port", "9227"));
const person = arg("as", "mehroz");
mkdirSync(out, { recursive: true });
if (process.argv.includes("--fresh")) rmSync(profile, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (m) => { log.push(m); console.log(m); };

async function launch() {
  const child = spawn(exe, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--window-size=1100,1500", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return { child, ws: page.webSocketDebuggerUrl };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("browser did not start");
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const ready = new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = async (method, params = {}) => { await ready; const n = ++id; ws.send(JSON.stringify({ id: n, method, params })); return new Promise((r) => waiting.set(n, r)); };
  const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  return { send, evaluate, close: () => ws.close() };
}

async function open(url) {
  const b = await launch();
  const c = cdp(b.ws);
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url });
  for (let i = 0; i < 80; i++) { if ((await c.evaluate("document.body && document.body.innerText.length")) > 40) break; await sleep(250); }
  await sleep(600);
  const shot = async (name, note) => {
    const r = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(join(out, name), Buffer.from(r.result.data, "base64"));
    say(`screenshot ${name}: ${note}`);
  };
  const text = () => c.evaluate("document.body.innerText");
  const clickButton = (label) => c.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  const type = async (selector, value) => {
    await c.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await c.send("Input.insertText", { text: value });
  };
  const waitText = async (needle, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await text()).includes(needle)) return true; await sleep(200); } return false; };
  // Closing through the browser (not a kill) lets Chromium flush its cookie store to the profile, as a clean app exit does.
  const quit = async () => { try { await c.send("Browser.close"); } catch { /* closed */ } c.close(); await sleep(1500); };
  return { c, shot, text, clickButton, type, waitText, quit, b };
}

const get = async (path) => (await fetch(`${base}${path}`, { headers: { cookie: `mu_harness_as=${person}` } })).json();
const state = async () => (await get("/__harness/state")).sessions.map((s) => `${s.person}:${s.via}:${s.pending ? "pending" : "confirmed"}${s.revoked ? ":revoked" : ""}`);

// --mode before: the panel as it was at 491b8ee0 (scripts/devices/pairing-harness/before/, a copy of that commit's files) against the same hub.
if (arg("mode") === "before") {
  const b = await open(`${base}/__harness/as/${person}`);
  await b.waitText("Synthetic server hub");
  await b.c.send("Page.navigate", { url: `${base}/before.html` });
  await b.waitText("BEFORE the fix");
  await b.waitText("Pair this device");
  await b.clickButton("Pair this device");
  await sleep(1500);
  await b.shot("pairing-00-before-fix.png", "BEFORE: after the bare Tailscale login the page claims 'This device is paired.' and still offers 'Pair this device'");
  say(`before: claims paired=${(await b.text()).includes("This device is paired.")}; still offers pairing=${(await b.text()).includes("With your Tailscale login")}; sessions=${JSON.stringify(await state())}`);
  writeFileSync(join(out, "pairing-before-log.txt"), log.join("\n") + "\n");
  await b.quit();
  process.exit(0);
}

// Pick who this WebView profile is (a non-secret harness cookie), then run the journey.
let s = await open(`${base}/__harness/as/${person}`);
await s.waitText("Pair this device");
await s.shot("pairing-02-pair-this-device.png", "first open in the desktop-like profile (server hub): says up front that a code finishes it");
say(`hub sessions before: ${JSON.stringify(await state())}`);
await s.clickButton("Pair this device");
say(`waiting state shown: ${await s.waitText("This browser needs a code")}`);
await s.shot("pairing-03-waiting-for-code.png", "after the bare Tailscale login: honest waiting state, exact console command, code box");
say(`hub sessions after bare login: ${JSON.stringify(await state())}`);
const waitingText = await s.text();
say(`notice claims paired: ${waitingText.includes("This device is paired.")}`);
await s.quit();

// App restart: same profile folder.
s = await open(base + "/");
say(`after restart still waiting: ${await s.waitText("This browser needs a code")}`);
await s.shot("pairing-04-after-restart-still-waiting.png", "browser restarted on the same profile: the waiting state is still recognised (cookie persisted)");

// A wrong code first (refused, still unconfirmed), then the real console code.
await s.type("[data-testid='waiting-for-code'] input", "WRNG-CODE");
await s.clickButton("Confirm this browser");
say(`wrong code refused: ${await s.waitText("That code is wrong, used or expired")}`);
await s.shot("pairing-05-wrong-code.png", "a wrong code is refused and nothing becomes confirmed");
const code = (await get(`/__harness/console-code?for=${person}`)).code;
await s.c.evaluate("document.querySelector(\"[data-testid='waiting-for-code'] input\").select()");
await s.type("[data-testid='waiting-for-code'] input", code);
await s.clickButton("Confirm this browser");
say(`confirmed: ${await s.waitText("Paired browser over Tailscale")}`);
await sleep(800);
await s.shot("pairing-06-confirmed.png", "a one-time console code confirms the browser: signed in as a paired browser");
say(`hub sessions after code: ${JSON.stringify(await state())}`);
await s.quit();

s = await open(base + "/");
say(`confirmed after restart: ${await s.waitText("Paired browser over Tailscale")}`);
await s.shot("pairing-07-confirmed-after-restart.png", "restart again: still confirmed (30-day persistent cookie in the profile)");
await s.quit();

writeFileSync(join(out, "pairing-journey-log.txt"), log.join("\n") + "\n");
