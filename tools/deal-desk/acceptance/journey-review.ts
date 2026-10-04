// Real-browser journey test for the deal desk (headless Edge over the DevTools protocol). Synthetic data only.
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
const OUT = "D:/deal-desk-journey"; const DL = `${OUT}/downloads`;
mkdirSync(DL, { recursive: true }); rmSync(`${OUT}/edge-r`, { recursive: true, force: true });
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const proc = Bun.spawn([EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9339", `--user-data-dir=${OUT}/edge-r`, "--allow-file-access-from-files", "about:blank"], { stdout: "ignore", stderr: "ignore" });
await Bun.sleep(2500);
const targets = await (await fetch("http://127.0.0.1:9339/json")).json();
async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map<number, (v: any) => void>(); const errors: string[] = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id) pend.get(m.id)?.(m.result ?? { error: m.error }); else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(" ")); });
  const send = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression: string) => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result?.value; };
  await send("Runtime.enable"); await send("Page.enable");
  return { send, ev, errors, close: () => ws.close() };
}
const page = await connect(targets.find((t: any) => t.type === "page").webSocketDebuggerUrl);
const browserWs = (await (await fetch("http://127.0.0.1:9339/json/version")).json()).webSocketDebuggerUrl;
const browser = await connect(browserWs).catch(() => null);
await page.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL.replace(/\//g, "\\") });
await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const HELPERS = `
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const q=(s)=>document.querySelector(s);
const type=async(path,v)=>{const el=q('[data-bind="'+path+'"]'); if(!el) throw new Error('no field '+path); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); await sleep(15); return el.getAttribute('aria-invalid')==='true' ? 'INVALID: '+(q('[data-err-for="'+path+'"]')?.textContent||'') : 'ok';};
const pick=async(path,v)=>{const el=q('[data-bind="'+path+'"]'); if(!el) throw new Error('no select '+path); if(el.type==='checkbox'){el.checked=v;} else el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); await sleep(40);};
const click=async(sel)=>{const el=q(sel); if(!el) throw new Error('no '+sel); el.click(); await sleep(60);};
const tab=async(t)=>click('[data-tab="'+t+'"]');
const stats=()=>Object.fromEntries([...document.querySelectorAll('#out .stat')].map(s=>[s.querySelector('span').textContent,s.querySelector('strong').textContent]));
const rows=()=>Object.fromEntries([...document.querySelectorAll('#out table tbody tr')].map(r=>[r.children[0].childNodes[0].textContent.trim(),[...r.children].slice(1).map(c=>c.childNodes[0].textContent.trim())]));
const cur=()=>{const s=JSON.parse(localStorage.getItem('mu-deal-desk/v1')); return s.deals.find(d=>d.id===s.currentId);};
`;
let step = 0; const run = async (body: string) => { step++; try { return await page.ev(HELPERS + body); } catch (e) { const snap = await page.ev(`return {tab: document.querySelector("[role=tab][aria-selected=true]")?.textContent, url: location.href, body: document.body.innerText.slice(0,200)}`); console.log("STEP", step, "failed:", String(e).slice(0,200), JSON.stringify(snap)); throw e; } };
const goto = async (url: string) => { await page.send("Page.navigate", { url }); await Bun.sleep(1500); };
const results: Record<string, any> = {}; const fails: string[] = [];
const check = (name: string, ok: boolean, detail: any = "") => { results[name] = { ok, detail }; if (!ok) fails.push(`${name}: ${JSON.stringify(detail)}`); };
const pdf = async (file: string, out: string) => { await goto(`file:///${file}`); const r = await page.send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true }); await Bun.write(out, Buffer.from(r.data, "base64")); const fit = await page.ev(`return [...document.querySelectorAll('.sheet')].length`); return fit; };
const waitFile = async (suffix: string) => { for (let i = 0; i < 40; i++) { const f = readdirSync(DL).find((x) => x.endsWith(suffix) && !x.endsWith(".crdownload")); if (f) return `${DL}/${f}`; await Bun.sleep(150); } throw new Error(`download ${suffix} never arrived`); };
const LONG_NAME = "The Extraordinarily Long-Named Synthetic Family Dental and Orthodontic Centre of Greater Western Sydney Pty Ltd (synthetic)";
const LONG_ADDR = "Suite 14B, Level 27, The Very Tall Synthetic Tower, 1234-1250 Great Western Highway (cnr Imaginary Parade), Parramatta NSW 2150";


const KEY = 'mu-deal-desk/v1';
await goto("http://127.0.0.1:4317/");
// make three real deals
let r = await run(`for (const n of ['R1 (synthetic)','R2 (synthetic)','R3 (synthetic)']) { await click('[data-action="new"]'); await sleep(900); await type('name', n); } await sleep(600); return JSON.parse(localStorage.getItem('${KEY}')).deals.map(d=>d.name);`);
const before = r.length;
// F01: half-finished stage edit must not be saved and must not wipe anything on reload
r = await run(`await tab('website'); await type('website.stages.1.shareBps','30'); await sleep(600); const st=JSON.parse(localStorage.getItem('${KEY}')); return {status:q('#status span:last-child').textContent, stored:st.deals.find(d=>d.id===st.currentId).website.stages.map(s=>s.shareBps), out:q('#out').textContent.slice(0,60)};`);
check("F01 uncalculable edit is not saved", /NOT SAVED until this calculates/.test(r.status) && r.stored.join() === "5000,5000", r);
await goto("http://127.0.0.1:4317/");
r = await run(`const st=JSON.parse(localStorage.getItem('${KEY}')); await tab('deal'); await type('client.contact','after reload'); await sleep(600); const st2=JSON.parse(localStorage.getItem('${KEY}')); return {n:st.deals.length, n2:st2.deals.length, names:st2.deals.map(d=>d.name), options:document.querySelectorAll('#deal-select option').length};`);
check("F01 reload keeps every deal and the next edit does not overwrite them", r.n === before && r.n2 === before && r.options === before && r.names.filter((n: string) => /^R[123]/.test(n)).length === 3, r);
r = await run(`await tab('website'); const bad=[]; for (const [p,v] of [['website.targetMarginBps','100'],['website.costs.2.sharedAcross','0'],['website.fx.usdPerAudMillionths','0']]) { bad.push([p, await type(p,v), q('#status span:last-child').textContent.slice(0,22)]); await sleep(350);} await tab('receptionist'); for (const [p,v] of [['rx.avgCallSeconds','3'],['rx.termMonths','121'],['rx.clientsSharingPlatform','0']]) { bad.push([p, await type(p,v), q('#status span:last-child').textContent.slice(0,22)]); await sleep(350);} return bad;`);
results["F01 other uncalculable values (field result, save status)"] = r;
await goto("http://127.0.0.1:4317/");
r = await run(`const st=JSON.parse(localStorage.getItem('${KEY}')); return {n:st.deals.length, shown:document.querySelectorAll('#deal-select option').length};`);
check("F01 after more bad values and a reload, all deals still open", r.n === before && r.shown === before, r);
r = await run(`await tab('website'); await click('[data-action="remove-stage"][data-i="1"]'); await sleep(600); const st=JSON.parse(localStorage.getItem('${KEY}')); return {status:q('#status span:last-child').textContent.slice(0,30), stored:st.deals.find(d=>d.id===st.currentId).website.stages.length};`);
check("F01 removing a stage that breaks 100% is not saved", /NOT SAVED/.test(r.status) && r.stored === 2, r);
// quarantine: stored deals damaged by hand
await goto("http://127.0.0.1:4317/");
r = await run(`const st=JSON.parse(localStorage.getItem('${KEY}')); st.deals[1].website.stages=[{shareBps:9999}]; st.deals.push({schemaVersion:1,id:'weird',name:'Weird',quote:{validDays:1e300}}); localStorage.setItem('${KEY}', JSON.stringify(st)); return st.deals.length;`);
const withBad = r;
await goto("http://127.0.0.1:4317/");
r = await run(`const banner=[...document.querySelectorAll('.conflict')].map(b=>b.textContent).join(' | '); await tab('deal'); await type('client.contact','edit after quarantine'); await sleep(600); const st=JSON.parse(localStorage.getItem('${KEY}')); return {banner, shown:document.querySelectorAll('#deal-select option').length, deals:st.deals.length, quarantined:(st.quarantined||[]).length, stuck: document.body.textContent.includes('Loading the deal desk')};`);
check("F02/F03 damaged deals are set aside, kept and never lost; app still loads", /2 saved deals could not be opened/.test(r.banner) && r.shown === withBad - 2 && r.deals === withBad - 2 && r.quarantined === 2 && !r.stuck, r);
// unreadable storage is never overwritten
await run(`localStorage.setItem('${KEY}', '{not json'); return 1;`);
await goto("http://127.0.0.1:4317/");
r = await run(`const banner=document.querySelector('.conflict')?.textContent||''; await tab('deal'); await type('name','typing while locked'); await sleep(600); return {banner, raw: localStorage.getItem('${KEY}'), status:q('#status span:last-child').textContent};`);
check("unreadable saved data locks saving and is left untouched", /could not be read/.test(r.banner) && r.raw === "{not json" && /NOT SAVING/.test(r.status), r);
await run(`localStorage.removeItem('${KEY}'); return 1;`);
await goto("http://127.0.0.1:4317/");
// F04 duplicate ids in one import; malformed import leaves things alone
r = await run(`
const d=window.__dealDesk.state.deals[0]; const mk=(o)=>{const dt=new DataTransfer(); dt.items.add(new File([JSON.stringify(o)],'x.json',{type:'application/json'})); return dt.files;};
const inp=()=>q('input[type=file][data-action-change="import"]'); let msgs=[]; const oa=window.alert; window.alert=(m)=>msgs.push(m);
const a={...JSON.parse(JSON.stringify(d)), id:'dup', name:'Dup A (synthetic)'}; const b={...JSON.parse(JSON.stringify(d)), id:'dup', name:'Dup B (synthetic)'};
inp().files=mk({deals:[a,b]}); inp().dispatchEvent(new Event('change',{bubbles:true})); await sleep(700);
const ids=window.__dealDesk.state.deals.map(x=>x.id); const n1=ids.length;
const bad={...JSON.parse(JSON.stringify(d)), id:'bad1'}; bad.quote.validDays=1e300;
inp().files=mk({deals:[bad]}); inp().dispatchEvent(new Event('change',{bubbles:true})); await sleep(700);
const dt=new DataTransfer(); dt.items.add(new File(['{"deals":[{"schemaVersion":1,"id":"p1","name":"Proto (synthetic)","__proto__":{"polluted":true}}]}'],'p.json')); inp().files=dt.files; inp().dispatchEvent(new Event('change',{bubbles:true})); await sleep(700);
window.alert=oa; return {unique:new Set(ids).size===ids.length, n1, n2:window.__dealDesk.state.deals.length, msgs, polluted:({}).polluted===undefined};`);
check("F04 duplicate ids in one file get distinct ids; a bad file imports nothing", r.unique && r.n1 === 6 && /cannot be opened|must be/.test(r.msgs[1]) && r.polluted, r);
// F09 keyboard and F22 export gating
r = await run(`const f=q('input[type=file][data-action-change="import"]'); const cs=getComputedStyle(f); await tab('receptionist'); const b=q('[data-action="package"][data-id="receptionist-premium"]'); b.focus(); const oc=window.confirm; window.confirm=()=>true; b.click(); window.confirm=oc; await sleep(200); const kept=document.activeElement?.dataset?.id; q('[data-tab="agreement"]').click(); const early=[...document.querySelectorAll('[data-export]')].map(x=>x.disabled); await sleep(1200); const later=[...document.querySelectorAll('[data-export]')].map(x=>x.disabled); return {importFocusable: cs.display!=='none' && cs.visibility!=='hidden' && f.tabIndex>=0, kept, early, later};`);
check("F09 import is keyboard-reachable and focus survives a re-render", r.importFocusable && r.kept === "receptionist-premium", r);
check("F22 agreement export is disabled until the fit check has run", r.early.every(Boolean) && !r.later.some(Boolean), r);
r = await run(`await tab('receptionist'); await type('rx.columns.extra.supportMinutes','2000'); await sleep(200); const over=rows()['Operating profit'][3]; const text=q('#out ul.plain li').textContent; return {over, text};`);
check("F05 loss message agrees with the over-allowance column", r.over.startsWith("-") && /Loses money from/.test(r.text), r);
check("no page errors", page.errors.length === 0, page.errors.slice(0, 5));
for (const [k, v] of Object.entries(results)) console.log(v.ok === false ? "FAIL" : v.ok === true ? "pass" : "info", k, v.ok === true ? "" : JSON.stringify(v.detail ?? v));
console.log(fails.length ? `FAILS: ${fails.length}` : "ALL PASS");
await Bun.write(`${OUT}/results-review-fixes.json`, JSON.stringify(results, null, 1));
page.close(); browser?.close(); proc.kill();
