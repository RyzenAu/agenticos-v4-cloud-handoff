// Two confirmed browser sessions on a PC-ROLE synthetic hub (the first browser is trusted on first use; it confirms the second with a code).
// Mehroz cannot be confirmed on loopback (that needs a real Tailscale login): founder attribution for Mehroz is covered by the route-matrix test.
// Was: two-founder journey on a SERVER-ROLE synthetic hub (scripts/acceptance/r7/hub.ts --role server, synthetic seed, port 8164).
// One Edge process, two isolated browser contexts (separate cookie jars). Each is confirmed as a different founder with a
// one-time console pair code (scripts/identity/pair-code.ts logic); codes are passed straight to the browser, never printed.
// Synthetic data only. Nothing is sent anywhere.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
process.env.MU_DATA_DIR = "D:\\AgenticOS-r7-data\\dealdesk";
const { makePairCode } = await import("D:/AgenticOS-int-dealdesk/scripts/identity/pair-code.ts");
const HUB = "http://127.0.0.1:8165";
const OUT = "D:/deal-desk-journey/founders"; const DL = `${OUT}/downloads`;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(DL, { recursive: true }); mkdirSync(`${OUT}/shots`, { recursive: true });
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const proc = Bun.spawn([EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9371", `--user-data-dir=${OUT}/edge`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
await Bun.sleep(2500);
const ver = await (await fetch("http://127.0.0.1:9371/json/version")).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map<number, (v: any) => void>(); const errors: Record<string, string[]> = {};
const sess2name = new Map<string, string>();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id) { pend.get(m.id)?.(m.result ?? { error: m.error }); return; }
  if (m.method === "Runtime.exceptionThrown" && m.sessionId) (errors[sess2name.get(m.sessionId) ?? "?"] ??= []).push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 200));
});
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const HELPERS = `
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const q=(s)=>document.querySelector(s);
const type=async(path,v)=>{const el=q('[data-bind="'+path+'"]'); if(!el) throw new Error('no field '+path); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); await sleep(20); return el.getAttribute('aria-invalid')==='true'?'INVALID':'ok';};
const pick=async(path,v)=>{const el=q('[data-bind="'+path+'"]'); if(el.type==='checkbox') el.checked=v; else el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); await sleep(60);};
const click=async(sel)=>{const el=q(sel); if(!el) throw new Error('no '+sel); el.click(); await sleep(80);};
const tab=async(t)=>click('[data-tab="'+t+'"]');
const status=()=>q('#status span:last-child')?.textContent||'';
const stats=()=>Object.fromEntries([...document.querySelectorAll('#out .stat')].map(s=>[s.querySelector('span').textContent,s.querySelector('strong').textContent]));
const rows=()=>Object.fromEntries([...document.querySelectorAll('#out table tbody tr')].map(r=>[r.children[0].childNodes[0].textContent.trim(),[...r.children].slice(1).map(c=>c.childNodes[0].textContent.trim())]));
const tok=async()=>(await fetch('/__token').then(r=>r.json()).catch(()=>({}))).token||'';
const op=async(path,body)=>{const r=await fetch('/__operator'+path, body?{method:'POST',headers:{'Content-Type':'application/json','X-Claude-OS-Token':await tok()},body:JSON.stringify(body)}:{}); return {status:r.status, body:await r.json().catch(()=>null)};};
`;
async function context(name: string) {
  const { browserContextId } = await send("Target.createBrowserContext");
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  sess2name.set(sessionId, name);
  await send("Runtime.enable", {}, sessionId); await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL.replace(/\//g, "\\"), browserContextId });
  const ev = async (expr: string) => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${HELPERS}${expr}})()`, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? "eval failed"}`); return r.result?.value; };
  const goto = async (url: string, wait = 3000) => { await send("Page.navigate", { url }, sessionId); await Bun.sleep(wait); };
  const shot = async (file: string, w = 1440, h = 1000, mobile = false) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }, sessionId); await Bun.sleep(800); await Bun.write(`${OUT}/shots/${file}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" }, sessionId)).data, "base64")); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId); };
  return { name, ev, goto, shot, sessionId };
}
const results: Record<string, any> = {}; const fails: string[] = [];
const check = (name: string, ok: boolean, detail: any = "") => { results[name] = { ok, detail }; if (!ok) fails.push(name); console.log(ok ? "pass" : "FAIL", name, ok ? "" : JSON.stringify(detail).slice(0, 400)); };
const info = (name: string, detail: any) => { results[name] = { ok: null, detail }; console.log("info", name, JSON.stringify(detail).slice(0, 400)); };

const A = await context("usman"); const B = await context("mehroz");
// A opens the fresh hub first: trusted on first use. B is a new browser at this PC: pending, read-only, until A confirms it with a code.
await A.goto(`${HUB}/`, 6000);
check("first browser is a confirmed session", (await A.ev(`return (await (await fetch('/__devices/me')).json()).principal?.actor;`)) === "human");
await B.goto(`${HUB}/deal-desk/index.html`, 4000);
let r: any;
r = await B.ev(`const me=(await (await fetch('/__devices/me')).json()); return {actor: me.principal?.actor, pending: me.hubSession?.pending, mode: window.__dealDesk?.state.mode, readOnly: window.__dealDesk?.state.readOnly, banner: [...document.querySelectorAll('.conflict')].map(b=>b.textContent).join(' | '), status: status()};`);
check("unconfirmed second browser opens the desk read-only and says so up front", r.readOnly === true && /isn't confirmed yet/.test(r.banner) && /Read only/.test(r.status), r);
r = await B.ev(`await type('client.contact','typed while read-only'); await sleep(1500); return {status: status(), list: (await (await fetch('/__operator/leads/deal-desk/list')).json()).deals.length};`);
check("a read-only browser's edit is not sent", /Read only/.test(r.status) && r.list === 0, r);
const code = await A.ev(`const r=await fetch('/__devices/sessions/confirm-code',{method:'POST',headers:{'Content-Type':'application/json','X-Claude-OS-Token':await tok()},body:'{}'}); return (await r.json()).code;`);
const conf = await B.ev(`const r=await fetch('/__devices/sessions/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-Claude-OS-Token':await tok()},body:JSON.stringify({code:${JSON.stringify(code)}})}); return r.status;`);
check("second browser confirmed with a one-time code from the first", (await B.ev(`return (await (await fetch('/__devices/me')).json()).principal?.actor;`)) === "human", { confirm: conf });
// 1. Usman creates a deal; it is credited to Usman.
await A.goto(`${HUB}/deal-desk/index.html`, 4000);
info("desk page after pairing", await A.ev(`return {title: document.title, body: document.body.innerText.slice(0,200), hasDesk: !!window.__dealDesk, app: (await fetch('/deal-desk/app.js')).status};`));
r = await A.ev(`return {mode: window.__dealDesk.state.mode, readOnly: window.__dealDesk.state.readOnly, status: status()};`);
check("confirmed browser opens the shared desk writable", r.mode === "shared" && r.readOnly === false, r);
r = await A.ev(`await click('[data-action="new"]'); await sleep(900); await type('name','Two-founder deal (synthetic)'); await type('client.business','Example Two-Founder Dental (synthetic)'); await type('client.contact','Practice manager (synthetic)'); await pick('include.receptionist', true); await sleep(1600); const id=window.__dealDesk.state.currentId; const g=(await op('/leads/deal-desk/get?id='+id)).body; return {id, status: status(), updatedBy: g.updatedBy, rev: g.rev};`);
const dealId = r.id;
check("session A's save is credited to the verified person (usman)", r.updatedBy === "usman" && /Saved for both founders/.test(r.status), r);
// Viewing does not write.
r = await A.ev(`const before=(await op('/leads/deal-desk/get?id=${dealId}')).body.rev; await tab('website'); await tab('quote'); await tab('deal'); await sleep(1200); const after=(await op('/leads/deal-desk/get?id=${dealId}')).body.rev; return {before, after};`);
check("switching tabs does not create a revision", r.before === r.after, r);
// 2. Commercial maths on screen: GST, discount, FX, payment stages, pending terms.
r = await A.ev(`await tab('website'); await type('website.price.cents','2,000'); await pick('website.price.gst','exclusive'); await pick('website.discount.type','percent'); await type('website.discount.bps','10');
 await click('[data-action="add-stage"]'); await sleep(300); await type('website.stages.0.shareBps','40'); await type('website.stages.1.shareBps','30'); await type('website.stages.2.shareBps','30');
 const n=window.__dealDesk.state.deals.find(d=>d.id==='${dealId}').website.costs.length; await type('website.costs.2.cents','25'); await type('website.fx.usdPerAudMillionths','0.65'); await sleep(1600);
 const st=[...document.querySelectorAll('#out table')][0].querySelectorAll('tbody tr'); const stages=[...st].map(t=>[...t.children].map(c=>c.textContent.trim()).slice(1)); const care=[...document.querySelectorAll('#out .stat')].map(s=>s.textContent);
 return {stats: stats(), stages, status: status(), hostingShare: care.find(t=>/Cost/.test(t))};`);
// 2000 ex - 10% = 1800 ex, GST 180, total 1980; stages 40/30/30 of 1980 = 792/594/594; GST 72/54/54
check("GST and discount on screen", r.stats["Price ex GST"] === "A$1,800.00" && r.stats["GST"] === "A$180.00" && r.stats["Total incl. GST"] === "A$1,980.00", r.stats);
check("payment stages tie to the total", JSON.stringify(r.stages.slice(0, 3).map((s: string[]) => s[2])) === JSON.stringify(["A$792.00", "A$594.00", "A$594.00"]) && r.stages[0][1] === "A$72.00", r.stages);
// US$25 / 0.65 x 1.03 = A$39.62 care-plan hosting
check("supplier cost converts from USD", /hosting A\$39\.62/.test(r.hostingShare ?? ""), r.hostingShare);
// 3. Mehroz opens the same deal, edits it; credited to Mehroz.
await B.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=deal`);
r = await B.ev(`return {name: q('[data-bind="name"]').value, mode: window.__dealDesk.state.mode, readOnly: window.__dealDesk.state.readOnly};`);
check("session B sees session A's deal", r.name === "Two-founder deal (synthetic)" && r.mode === "shared" && r.readOnly === false, r);
r = await B.ev(`await type('client.contact','Changed in session B'); await sleep(1600); const g=(await op('/leads/deal-desk/get?id=${dealId}')).body; return {status: status(), updatedBy: g.updatedBy, rev: g.rev, linkText: q('#out')?.textContent ?? ''};`);
check("session B's save is credited to the verified person (usman, the only founder at this PC)", r.updatedBy === "usman" && /Saved for both founders/.test(r.status), r);
// 4. Usman's stale edit is refused; nothing is overwritten.
r = await A.ev(`await tab('deal'); await type('client.address','Usman edit on a stale revision'); await sleep(1800); const g=(await op('/leads/deal-desk/get?id=${dealId}')).body; return {status: status(), banner: [...document.querySelectorAll('.conflict')].map(b=>b.textContent).join(' | '), serverContact: (g.draft??g.deal).client.contact, serverAddress: (g.draft??g.deal).client.address, updatedBy: g.updatedBy};`);
check("session A's stale edit is refused, nothing overwritten", /newer version/.test(r.status) && /Usman saved a newer version/.test(r.banner) && r.serverContact === "Changed in session B" && r.serverAddress !== "Usman edit on a stale revision", r);
r = await A.ev(`await click('[data-action="shared-theirs"]'); await sleep(600); return {contact: q('[data-bind="client.contact"]')?.value, banner: [...document.querySelectorAll('.conflict')].length, status: status()};`);
check("'Load their version' shows session B's change and clears the banner", r.contact === "Changed in session B" && /Saved|Shared/.test(r.status), r);
// Refresh persistence for both.
await A.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=deal`); await B.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=deal`);
const a2 = await A.ev(`return q('[data-bind="client.contact"]').value;`); const b2 = await B.ev(`return q('[data-bind="client.contact"]').value;`);
check("after refresh both sessions see the same saved deal", a2 === "Changed in session B" && b2 === "Changed in session B", { a2, b2 });
// 5. Quote and agreement: downloads, pending terms, and the receptionist invoice shown on screen.
r = await A.ev(`await tab('receptionist'); const inv=rows()['Invoice incl. GST']; await tab('quote'); await sleep(500); await click('[data-action="dl-html-client"]'); await click('[data-action="dl-md"]'); await tab('agreement'); await sleep(2200); const fit=q('#fit').textContent; await click('[data-action="dl-agreement"]'); return {inv, fit};`);
info("receptionist invoice shown (low, expected, full, over)", r.inv); info("agreement page estimate", r.fit);
const shown = r.inv;
// 6. Attach to a synthetic lead: refused while the lead's package differs, accepted once it matches.
const leads = await A.ev(`return (await op('/leads/list')).body;`);
const leadId = (leads?.leads ?? leads?.items ?? [])[0]?.id;
r = await A.ev(`await op('/leads/deal', {lead: ${leadId}, offer: 'both', packageId: 'receptionist-essential'}); await tab('deal'); await sleep(200); q('#lead-id').value='${leadId}'; let m1=''; const oa=window.alert; window.alert=(m)=>m1=m; await click('[data-action="lead-attach"]'); await sleep(1500);
 await op('/leads/deal', {lead: ${leadId}, offer: 'both', packageId: 'receptionist-professional'}); q('#lead-id').value='${leadId}'; let m2=''; window.alert=(m)=>m2=m; await click('[data-action="lead-attach"]'); await sleep(1800); window.alert=oa; const det=(await op('/leads/detail?id=${leadId}')).body; return {m1, m2, drafts: det?.drafts};`);
check("attach refuses a package mismatch in plain words, then attaches", /saved as Essential but this workbook prices Professional/.test(r.m1) && /Added to lead/.test(r.m2) && r.drafts?.includes("deal-desk-agreement.html"), r);
const serverAgreement = (await A.ev(`return (await op('/leads/draft-file?id=${leadId}&file=deal-desk-agreement.html')).body?.content ?? '';`)) as string;
await Bun.write(`${DL}/server-agreement.html`, serverAgreement);
// 7. Evidence screens.
await A.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=deal`); await A.shot("usman-deal-desk-1440");
await B.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=agreement`, 4000); await B.shot("mehroz-agreement-tab-1440"); await B.shot("mehroz-deal-desk-375", 375, 1500, true);
info("page errors", errors);
await Bun.sleep(1500); info("downloads", readdirSync(DL));
await Bun.write(`${OUT}/results.json`, JSON.stringify({ results, shown, dealId, leadId }, null, 1));
for (const [k, v] of Object.entries(results)) console.log(v.ok === false ? "FAIL" : v.ok === true ? "pass" : "info", k, v.ok === true ? "" : JSON.stringify(v.detail).slice(0, 500));
console.log(fails.length ? `FAILS: ${fails.length}` : "ALL PASS");
ws.close(); proc.kill();
