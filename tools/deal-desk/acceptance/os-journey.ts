// Connected OS journey on the ISOLATED test hub (http://127.0.0.1:8163, synthetic data, own data dir).
// Two independent Edge profiles = two separate browser sessions on this PC. Founder identity is NOT exercised here
// (both are local sessions); the authenticated two-founder test belongs to the round-7 integration gate.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
const HUB = "http://127.0.0.1:8163"; const OUT = "D:/deal-desk-journey/os"; const DL = `${OUT}/downloads`;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(DL, { recursive: true }); mkdirSync(`${OUT}/shots`, { recursive: true });
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
async function browser(port: number, profile: string) {
  const proc = Bun.spawn([EDGE, "--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(2500);
  const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x: any) => x.type === "page");
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map<number, (v: any) => void>(); const errors: string[] = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id) pend.get(m.id)?.(m.result ?? { error: m.error }); else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); });
  const send = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Page.enable");
  const ev = async (expression: string) => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${HELPERS}${expression}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result?.value; };
  const goto = async (url: string, wait = 2500) => { await send("Page.navigate", { url }); await Bun.sleep(wait); };
  const shot = async (name: string, w: number, h: number, mobile = false) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }); await Bun.sleep(700); await Bun.write(`${OUT}/shots/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64")); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); };
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  return { send, ev, goto, shot, errors, close: () => { ws.close(); proc.kill(); } };
}
const HELPERS = `
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const q=(s)=>document.querySelector(s);
const type=async(path,v)=>{const el=q('[data-bind="'+path+'"]'); if(!el) throw new Error('no field '+path); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); await sleep(20);};
const pick=async(path,v)=>{const el=q('[data-bind="'+path+'"]'); if(el.type==='checkbox') el.checked=v; else el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); await sleep(60);};
const click=async(sel)=>{const el=q(sel); if(!el) throw new Error('no '+sel); el.click(); await sleep(80);};
const tab=async(t)=>click('[data-tab="'+t+'"]');
const status=()=>q('#status span:last-child')?.textContent||'';
const stats=()=>Object.fromEntries([...document.querySelectorAll('#out .stat')].map(s=>[s.querySelector('span').textContent,s.querySelector('strong').textContent]));
const op=async(path,body)=>{const t=await fetch('/__token').then(r=>r.json()).catch(()=>({token:''})); const r=await fetch('/__operator'+path, body?{method:'POST',headers:{'Content-Type':'application/json','X-Claude-OS-Token':t.token||''},body:JSON.stringify(body)}:{}); return {status:r.status, body:await r.json().catch(()=>null)};};
`;
const results: Record<string, any> = {}; const fails: string[] = [];
const check = (name: string, ok: boolean, detail: any = "") => { results[name] = { ok, detail }; if (!ok) fails.push(name); };
const info = (name: string, detail: any) => { results[name] = { ok: null, detail }; };

const A = await browser(9361, "D:/deal-desk-journey/os/edge-A");
const B = await browser(9362, "D:/deal-desk-journey/os/edge-B");
await A.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL.replace(/\//g, "\\") });

// 0. A browser-local deal from before sharing existed, then the shared page offers it with a preview.
await A.goto(`${HUB}/deal-desk/index.html`);
await A.ev(`const d=window.__dealDesk.state.deals[0]; const mine=JSON.parse(JSON.stringify(d)); mine.id='local-only-1'; mine.name='Local-only deal (synthetic)'; mine.synthetic=false; localStorage.setItem('mu-deal-desk/v1', JSON.stringify({rev:1, deals:[mine], currentId:mine.id})); return 1;`);
await A.goto(`${HUB}/deal-desk/index.html`);
let r = await A.ev(`return {mode: window.__dealDesk.state.mode, status: status(), offer: q('.conflict.offer')?.textContent||''};`);
check("A opens in shared mode on the OS and offers the browser-local deal", r.mode === "shared" && /saved only in this browser/.test(r.offer), r);
r = await A.ev(`await click('[data-action="offer-open"]'); await sleep(200); const rows=[...document.querySelectorAll('.offer-panel tbody tr')].map(t=>t.textContent); const before=(await op('/leads/deal-desk/list')).body.deals.length; const oa=window.alert; let msg=''; window.alert=(m)=>msg=m; await click('[data-action="offer-copy"]'); await sleep(1500); window.alert=oa; const after=(await op('/leads/deal-desk/list')).body.deals.map(d=>d.name); return {rows, before, after, msg, localKept: JSON.parse(localStorage.getItem('mu-deal-desk/v1')).deals.length};`);
check("import preview lists what will happen, copies on request, keeps the local original", r.rows.length === 1 && /New: copied/.test(r.rows[0]) && r.before === 0 && r.after.includes("Local-only deal (synthetic)") && r.localKept === 1, r);

// 1. A creates and edits a deal; it is saved for both founders.
r = await A.ev(`await click('[data-action="new"]'); await sleep(900); await type('name','Shared journey deal (synthetic)'); await type('client.business','Example Shared Clinic (synthetic)'); await type('client.contact','Practice manager (synthetic)'); await pick('include.receptionist', true); await sleep(1500); return {status: status(), id: window.__dealDesk.state.currentId};`);
const dealId = r.id;
check("A's new deal is saved for both founders", /Saved for both founders/.test(r.status), r);
// 2. An unfinished payment schedule is kept as a draft; the last complete version is not overwritten.
r = await A.ev(`await tab('website'); await type('website.stages.1.shareBps','30'); await sleep(1500); const g=(await op('/leads/deal-desk/get?id=${dealId}')).body; return {status: status(), lastComplete: g.deal?.website?.stages?.map(s=>s.shareBps), draft: g.draft?.website?.stages?.map(s=>s.shareBps), problem: g.problem};`);
check("unfinished schedule saved as a draft beside the last complete version", /Unfinished changes kept as a draft for both founders/.test(r.status) && r.lastComplete?.join() === "5000,5000" && r.draft?.join() === "5000,3000", r);
await A.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=website`);
r = await A.ev(`return {stage: q('[data-bind="website.stages.1.shareBps"]').value, status: status(), out: q('#out').textContent.slice(0,40)};`);
check("refresh restores the unfinished draft rather than losing it", r.stage === "30" && /Can't calculate yet/.test(r.out), r);
r = await A.ev(`await type('website.stages.1.shareBps','50'); await sleep(1500); const g=(await op('/leads/deal-desk/get?id=${dealId}')).body; return {status: status(), draft: g.draft, rev: g.rev};`);
check("finishing the schedule clears the draft", /Saved for both founders/.test(r.status) && r.draft === null, r);

// 3. B (a separate browser session) opens the same deal and edits it.
await B.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=deal`);
r = await B.ev(`return {mode: window.__dealDesk.state.mode, name: q('[data-bind="name"]').value, by: q('#out')?.textContent ? '' : ''};`);
check("B sees A's deal", r.mode === "shared" && r.name === "Shared journey deal (synthetic)", r);
r = await B.ev(`await type('client.contact','Changed in session B'); await sleep(1500); return status();`);
check("B's edit saves", /Saved for both founders/.test(r), r);
// 4. A, still on the old revision, edits the same deal: conflict, nothing overwritten; keep mine as a copy.
r = await A.ev(`await tab('deal'); await type('client.address','Edited in A after B saved'); await sleep(1600); return {status: status(), banner: [...document.querySelectorAll('.conflict')].map(b=>b.textContent).join(' | ')};`);
check("A's stale edit is refused with a clear conflict", /newer version/.test(r.status) && /saved a newer version/.test(r.banner), r);
r = await A.ev(`await click('[data-action="shared-mine-copy"]'); await sleep(2000); const list=(await op('/leads/deal-desk/list')).body.deals; const orig=(await op('/leads/deal-desk/get?id=${dealId}')).body; return {names:list.map(d=>d.name), origContact: (orig.draft??orig.deal).client.contact, origAddress: (orig.draft??orig.deal).client.address};`);
check("conflict: B's save kept, A's change kept as a separate copy", r.origContact === "Changed in session B" && r.origAddress !== "Edited in A after B saved" && r.names.some((n: string) => /\(my copy\)/.test(n)), r);
// 5. A refreshes and reopens: B's change is there.
await A.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=deal`);
r = await A.ev(`return q('[data-bind="client.contact"]').value;`);
check("after refresh A sees B's change", r === "Changed in session B", r);
// B picks up A's copy when its tab regains focus
r = await B.ev(`window.dispatchEvent(new Event('focus')); await sleep(1500); return [...document.querySelectorAll('#deal-select option')].map(o=>o.textContent).filter(n=>/my copy/.test(n)).length;`);
check("B sees A's new copy when its tab regains focus", r === 1, r);

// 6. Quote + agreement from the saved deal; downloads; then link to the CRM deal and attach to a synthetic lead.
r = await A.ev(`await tab('receptionist'); const rows=Object.fromEntries([...document.querySelectorAll('#out table tbody tr')].map(t=>[t.children[0].childNodes[0].textContent.trim(),[...t.children].slice(1).map(c=>c.childNodes[0].textContent.trim())])); await tab('quote'); await sleep(400); await click('[data-action="dl-html-client"]'); await tab('agreement'); await sleep(1800); const fit=q('#fit').textContent; await click('[data-action="dl-agreement"]'); return {incl: rows['Invoice incl. GST'], fit};`);
info("A: displayed receptionist invoice (low, expected, full, over)", r.incl); const shown = r.incl;
info("A: agreement page estimate", r.fit);
const leads = await A.ev(`return (await op('/leads/list')).body;`);
const leadId = (leads?.leads ?? leads?.items ?? leads ?? [])[0]?.id;
r = await A.ev(`await op('/leads/deal', {lead: ${leadId}, offer: 'receptionist', packageId: 'receptionist-professional'}); await tab('deal'); await sleep(200); q('#crm-ref').value='crm:deal:synthetic-1'; await click('[data-action="crm-link"]'); await sleep(1200); q('#lead-id').value='${leadId}'; const oa=window.alert; let msg=''; window.alert=(m)=>msg=m; await click('[data-action="lead-attach"]'); await sleep(2000); window.alert=oa; const g=(await op('/leads/deal-desk/get?id=${dealId}')).body; const det=(await op('/leads/detail?id=${leadId}')).body; return {msg, crm: g.crmDealRef, lead: g.leadId, drafts: det?.drafts};`);
check("CRM reference stored and quote/agreement attached to the lead's drafts", r.crm === "crm:deal:synthetic-1" && r.lead === leadId && ["deal-desk-quote.html", "deal-desk-agreement.html", "deal-desk-deal.json"].every((f) => r.drafts?.includes(f)), r);

// 7. Saved deal reproduces the same documents after reopening (server-rendered attachment vs the browser download).
r = await A.ev(`const f=await op('/leads/draft-file?id=${leadId}&file=deal-desk-agreement.html'); return f.body?.content?.length||0;`);
info("server-rendered agreement length", r);
const serverAgreement = (await A.ev(`return (await op('/leads/draft-file?id=${leadId}&file=deal-desk-agreement.html')).body.content;`)) as string;
await Bun.write(`${OUT}/server-agreement.html`, serverAgreement);

// 8. Narrow and desktop evidence of the desk inside the OS; Operations link; motion kit through the OS.
await A.goto(`${HUB}/deal-desk/index.html?deal=${dealId}&tab=receptionist`); await A.shot("os-deal-desk-desktop", 1440, 1000);
await A.shot("os-deal-desk-375", 375, 1600, true);
await A.goto(`${HUB}/operations`, 4000);
r = await A.ev(`const a=[...document.querySelectorAll('a')].find(x=>/Deal desk/.test(x.textContent)); return a ? a.getAttribute('href') : null;`);
check("Operations shows the Deal desk link", r === "/deal-desk/index.html", r);
await A.shot("os-operations-link", 1440, 900);
await A.goto(`${HUB}/motion?tab=kit`, 5000);
r = await A.ev(`const t=document.body.innerText; const ids=['Call waveform','Call flow path','24-hour coverage dial','Included-minutes meter','Go-live checklist','Cursor demo button']; return {found: ids.filter(n=>t.includes(n)), frames: document.querySelectorAll('iframe').length};`);
check("motion kit tab lists the new pieces", r.found.length === 6, r);
await A.shot("os-motion-kit-desktop", 1440, 1000); await A.shot("os-motion-kit-375", 375, 1400, true);
await A.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await A.goto(`${HUB}/motion?tab=kit`, 5000);
r = await A.ev(`let running=0, frames=0; for (const f of document.querySelectorAll('iframe')) { try { const d=f.contentDocument; if(!d) continue; frames++; running += d.getAnimations().filter(a=>a.playState==='running').length; } catch {} } running += document.getAnimations().filter(a=>a.playState==='running').length; return {frames, running};`);
check("motion kit in the OS: no running animations with reduced motion", r.running === 0, r);
await A.send("Emulation.setEmulatedMedia", { features: [] });
info("page errors A", A.errors.slice(0, 5)); info("page errors B", B.errors.slice(0, 5));
await Bun.sleep(1500);
info("downloads", readdirSync(DL));
await Bun.write(`${OUT}/results.json`, JSON.stringify({ results, shown, leadId, dealId }, null, 1));
for (const [k, v] of Object.entries(results)) console.log(v.ok === false ? "FAIL" : v.ok === true ? "pass" : "info", k, v.ok === true ? "" : JSON.stringify(v.detail).slice(0, 400));
console.log(fails.length ? `FAILS: ${fails.length}` : "ALL PASS");
A.close(); B.close();
