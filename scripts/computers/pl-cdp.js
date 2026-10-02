// Measures one navigation in a computer's own Chromium over its DevTools port (node 24: fetch + WebSocket). Prints one JSON line.
const [port, url, maxArg] = process.argv.slice(2);
const maxMs = Number(maxArg || 45000);
const tg = await (await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const wait = new Map();
const out = { url, tDCL: null, tLoad: null, finalUrl: null, status: null, title: null, readyAtEnd: null, requests: 0, failed: {}, pending: [], pendingAt25s: null, bytes: 0, firstByte: null };
const reqs = new Map();
let t0 = 0, navDone = false;
const now = () => Math.round(performance.now() - t0);
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) return wait.get(d.id)(d);
  const p = d.params || {};
  if (d.method === "Page.domContentEventFired") out.tDCL = out.tDCL ?? now();
  else if (d.method === "Page.loadEventFired") out.tLoad = out.tLoad ?? now();
  else if (d.method === "Network.requestWillBeSent") { out.requests++; reqs.set(p.requestId, { url: p.request.url, type: p.type, t: now() }); }
  else if (d.method === "Network.responseReceived") { const r = reqs.get(p.requestId); if (p.type === "Document" && (out.status === null || p.frameId === p.loaderId || true)) { if (out.firstByte === null) out.firstByte = now(); if (p.response.url && !/^(about|chrome)/.test(p.response.url)) { out.status = p.response.status; out.finalUrl = p.response.url; } } }
  else if (d.method === "Network.loadingFinished") { out.bytes += p.encodedDataLength || 0; reqs.delete(p.requestId); }
  else if (d.method === "Network.loadingFailed") { const k = p.errorText || "failed"; out.failed[k] = (out.failed[k] || 0) + 1; reqs.delete(p.requestId); }
};
const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
t0 = performance.now();
const nav = await send("Page.navigate", { url });
if (nav.result?.errorText) out.navError = nav.result.errorText;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let snap25 = false;
while (now() < maxMs) {
  if (!snap25 && now() >= 25000) { snap25 = true; out.pendingAt25s = [...reqs.values()].slice(0, 6).map((x) => `${x.type} ${x.url.slice(0, 70)} (${Math.round((now() - x.t) / 1000)}s)`); out.loadedAt25s = out.tLoad !== null; }
  if (out.tLoad !== null && now() > out.tLoad + 1500) break;
  await sleep(250);
}
const ev = await send("Runtime.evaluate", { expression: "JSON.stringify({t:document.title,u:location.href,r:document.readyState})", returnByValue: true });
try { const v = JSON.parse(ev.result.result.value); out.title = v.t; out.readyAtEnd = v.r; out.finalUrl = v.u; } catch {}
out.pending = [...reqs.values()].slice(0, 6).map((x) => `${x.type} ${x.url.slice(0, 70)} (${Math.round((now() - x.t) / 1000)}s)`);
out.pendingCount = reqs.size; out.endedAt = now();
console.log(JSON.stringify(out));
ws.close();
fetch("http://127.0.0.1:" + port + "/json/close/" + tg.id).catch(() => {});
