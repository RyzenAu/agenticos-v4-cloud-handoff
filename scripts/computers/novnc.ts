import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The viewer client: noVNC (https://github.com/novnc/noVNC, MPL-2.0), pinned to one version as an npm dependency and served by the
 * hub from node_modules, never copied into our tree. It speaks RFB over the hub's authenticated WebSocket
 * (`/__computers/<name>/vnc`, scripts/computers/viewer.ts). noVNC is ONLY the pixels and the mouse: who may act is decided by our control
 * lease, on the hub, in the byte stream (scripts/computers/rfb.ts), so a viewer that is not the holder is view-only whatever the page says.
 *
 * The contract for the Computers page (Agent C):
 *
 *   <iframe src="/__computers/<name>/viewer" title="research computer" />        same origin, frame-ancestors 'self'
 *
 *   The page shows the screen, a "Take control" / "Return to agent" button pair, and heartbeats the lease while the person holds it.
 *   It posts to its parent (same origin only):   { source: "mu-computer-viewer", name, connected, canControl,
 *                                                  state, controller: {kind, who}, takeoverPending, paused }
 *   and accepts from its parent:                 { target: "mu-computer-viewer", type: "takeover" | "return" | "refresh" }   (refresh = re-read the lease now)
 *   Add ?bare=1 to the src to hide the frame's own header (the parent draws the controls).
 *   GET /__computers/<name>/viewer-state  -> { view, canControl }    (the same facts, for a component that draws its own chrome)
 *   A component that wants its own noVNC can use:  new RFB(el, "wss://<host>/__computers/<name>/vnc", { shared: true }) with
 *   rfb.viewOnly = !canControl, and the assets under /__computers/assets/novnc/core/rfb.js (signed-in founders only).
 */

export const NOVNC_VERSION = "1.7.0";
const ASSET = /^\/assets\/novnc\/((?:core|vendor)\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.js)$/;

export function novncDir(root: string) {
  return resolve(join(root, "node_modules", "@novnc", "novnc"));
}

/** A noVNC source file by its path under core/ or vendor/, or null. Nothing else in the package (no docs, no package.json) and no traversal. */
export function novncAsset(root: string, path: string): { body: Buffer; type: string } | null {
  const m = ASSET.exec(path);
  if (!m || m[1].includes("..") || m[1].includes("//")) return null;
  const dir = novncDir(root);
  const file = resolve(join(dir, m[1]));
  if (!file.startsWith(`${dir}\\`) && !file.startsWith(`${dir}/`)) return null;
  if (!existsSync(file)) return null;
  return { body: readFileSync(file), type: "text/javascript; charset=utf-8" };
}

export const isNovncAssetPath = (path: string) => ASSET.test(path);

export function viewerCsp(host: string) {
  return `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://${host} wss://${host}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`;
}

/** The viewer document for one computer. `name` is validated by the caller (lowercase letters, digits, dashes). */
export function viewerPage(name: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} computer</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1c1c1a; --bar: #e9e9e5; --accent: #2457c5; --muted: #6b6b66; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecece8; --bar: #232321; --accent: #86a8f2; --muted: #9a9a94; } }
  html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; background: var(--bar); }
  header .who { flex: 1 1 auto; min-width: 12ch; }
  header .muted { color: var(--muted); }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--muted); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button[hidden] { display: none; }
  #screen { flex: 1 1 auto; min-height: 0; background: #000; }
  #note { padding: 24px; }
</style></head>
<body>
<header><span class="who" id="who">Connecting to ${name}…</span><button id="take" class="primary" hidden>Take control</button><button id="back" hidden>Return to agent</button></header>
<div id="screen"></div><div id="note" hidden></div>
<script type="module">
import RFB from "/__computers/assets/novnc/core/rfb.js";
const NAME = ${JSON.stringify(name)};
const $ = (id) => document.getElementById(id);
let token = "";
try { token = (await (await fetch("/__token")).json()).token || ""; } catch {}
const api = async (method, path, body) => {
  const res = await fetch("/__computers/" + NAME + path, { method, headers: { "content-type": "application/json", ...(method !== "GET" ? { "x-claude-os-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
let rfb = null, connected = false, last = null;
const tell = () => { try { parent.postMessage({ source: "mu-computer-viewer", name: NAME, connected, canControl: !!last?.canControl, state: last?.view?.state, controller: last?.view?.controller, takeoverPending: last?.view?.takeoverPending ?? null, paused: last?.view?.paused ?? null }, location.origin); } catch {} };
function draw() {
  if (!last) return;
  const c = last.view.controller;
  $("who").textContent = NAME + ": " + (last.canControl ? "you have control" : c.kind === "person" ? c.who + " has control" : c.kind === "agent" ? "agent " + c.who + " is working" : last.view.state) + (last.view.takeoverPending ? " (pausing the agent at its next safe step)" : "");
  $("take").hidden = last.canControl || last.view.takeoverPending?.by === last.me;
  $("back").hidden = !(last.canControl || last.view.takeoverPending);
  if (rfb) rfb.viewOnly = !last.canControl; // the hub enforces this anyway: a viewer without the lease cannot send input
  tell();
}
async function refresh() { const r = await api("GET", "/viewer-state"); if (r.status === 200) { last = r.json; draw(); } }
function connect() {
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/__computers/" + NAME + "/vnc";
  rfb = new RFB($("screen"), url, { shared: true });
  rfb.viewOnly = true; rfb.scaleViewport = true; rfb.resizeSession = false;
  rfb.addEventListener("connect", () => { connected = true; tell(); });
  rfb.addEventListener("disconnect", () => { connected = false; tell(); $("note").hidden = false; $("note").textContent = "The screen is not available (the computer is asleep, has no desktop, or the session ended)."; });
}
$("take").onclick = async () => { await api("POST", "/takeover", {}); await refresh(); };
$("back").onclick = async () => { await api("POST", "/return", {}); await refresh(); };
addEventListener("message", async (e) => { if (e.origin !== location.origin || e.data?.target !== "mu-computer-viewer") return; if (e.data.type === "takeover") $("take").click(); if (e.data.type === "return") $("back").click(); if (e.data.type === "refresh") await refresh(); });
// ?bare=1: the Computers page draws its own controls around this frame, so the frame shows only the screen.
if (new URLSearchParams(location.search).has("bare")) document.querySelector("header").style.display = "none";
await refresh();
connect();
setInterval(refresh, 2000);
setInterval(() => { if (last?.canControl) api("POST", "/lease/renew", {}); }, 20000);
</script></body></html>`;
}
