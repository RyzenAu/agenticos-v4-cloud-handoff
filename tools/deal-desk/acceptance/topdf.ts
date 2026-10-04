import { readdirSync, mkdirSync } from "node:fs";
const DL = "D:/deal-desk-journey/downloads"; mkdirSync("D:/deal-desk-journey/pdf", { recursive: true });
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const proc = Bun.spawn([EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9337", "--user-data-dir=D:/deal-desk-journey/edge-pdf", "--allow-file-access-from-files", "about:blank"], { stdout: "ignore", stderr: "ignore" });
await Bun.sleep(2500);
const t = (await (await fetch("http://127.0.0.1:9337/json")).json()).find((x: any) => x.type === "page");
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener("open", r));
let id = 0; const pend = new Map(); ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); pend.get(m.id)?.(m.result ?? { error: m.error }); });
const send = (method: string, params: any = {}) => new Promise<any>(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
for (const f of readdirSync(DL).filter(f => f.endsWith(".html"))) {
  await send("Page.navigate", { url: `file:///${DL}/${f}` }); await Bun.sleep(1200);
  const fit = await send("Runtime.evaluate", { expression: "JSON.stringify([...document.querySelectorAll('.sheet')].map(function(s){var top=s.getBoundingClientRect().top;var cs=getComputedStyle(s);var limit=s.clientHeight-parseFloat(cs.paddingBottom);var b=0;[...s.children].forEach(function(c){if(c.tagName!=='FOOTER'){b=Math.max(b,c.getBoundingClientRect().bottom-top);}});return Math.round(limit-b);}))", returnByValue: true });
  const pdf = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
  if (!pdf.data) { console.log(f, "PDF ERROR", JSON.stringify(pdf.error)); continue; }
  await Bun.write(`D:/deal-desk-journey/pdf/${f.replace(/\.html$/, ".pdf")}`, Buffer.from(pdf.data, "base64"));
  console.log(f, "spare px:", fit.result.value);
}
ws.close(); proc.kill();
