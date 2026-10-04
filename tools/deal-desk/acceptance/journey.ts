// Real-browser journey test for the deal desk (headless Edge over the DevTools protocol). Synthetic data only.
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
const OUT = "D:/deal-desk-journey"; const DL = `${OUT}/downloads`;
rmSync(DL, { recursive: true, force: true }); mkdirSync(DL, { recursive: true }); rmSync(`${OUT}/edge`, { recursive: true, force: true });
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const proc = Bun.spawn([EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9336", `--user-data-dir=${OUT}/edge`, "--allow-file-access-from-files", "about:blank"], { stdout: "ignore", stderr: "ignore" });
await Bun.sleep(2500);
const targets = await (await fetch("http://127.0.0.1:9336/json")).json();
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
const browserWs = (await (await fetch("http://127.0.0.1:9336/json/version")).json()).webSocketDebuggerUrl;
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

// ── J1: website-only, long names, ex-GST price, discount, USD cost, three stages ──
await goto("http://127.0.0.1:4317/");
let r = await run(`
await click('[data-action="new"]');
await type('name','J1 website only (synthetic)'); await type('client.business', ${JSON.stringify(LONG_NAME)}); await type('client.contact','Dr Synthetic Example-Placeholder, Practice Principal'); await type('client.address', ${JSON.stringify(LONG_ADDR)});
await tab('website'); await pick('website.price.gst','exclusive'); await type('website.price.cents','4,800'); await pick('website.discount.type','percent'); await type('website.discount.bps','5');
await type('website.effortMinutes.build','20'); await type('website.costs.0.cents','29.95');
await click('[data-action="add-cost"]'); await sleep(450); const n=cur().website.costs.length-1; await type('website.costs.'+n+'.label','Font licence (synthetic)'); await pick('website.costs.'+n+'.currency','USD'); await type('website.costs.'+n+'.cents','50');
const invalid=[await type('website.price.cents','abc'), await type('website.price.cents','-5'), await type('website.contingencyBps','101'), await type('website.revisions.includedRounds','1.5')];
await type('website.price.cents','4,800'); await type('website.contingencyBps','10'); await type('website.revisions.includedRounds','2');
await sleep(500); return {stats:stats(), invalid, saved:cur().website.price, costs:cur().website.costs.map(c=>[c.label,c.currency,c.cents])};`);
// 4800 ex, 5% discount = 4560 ex, GST 456, total 5016
check("J1 price/discount/GST", r.stats["Price ex GST"] === "A$4,560.00" && r.stats["GST"] === "A$456.00" && r.stats["Total incl. GST"] === "A$5,016.00", r.stats);
check("J1 invalid inputs rejected", r.invalid.every((x: string) => x.startsWith("INVALID")), r.invalid);
check("J1 saved", r.saved.cents === 480000 && r.saved.gst === "exclusive", r.saved);
await goto("http://127.0.0.1:4317/");
r = await run(`await tab('website'); const d=cur(); return {name:d.name, biz:d.client.business, stats:stats(), usd:[...document.querySelectorAll('#out')][0].textContent.includes('A$5,016.00'), third: stats()};`);
check("J1 reload reopens the same deal", r.name === "J1 website only (synthetic)" && r.biz === LONG_NAME && r.stats["Total incl. GST"] === "A$5,016.00", r);
r = await run(`await tab('quote'); await sleep(200); await click('[data-action="dl-html-client"]'); await click('[data-action="dl-md"]'); await tab('agreement'); await sleep(900); const fit=q('#fit').textContent; const disabled=[...document.querySelectorAll('[data-export]')].map(b=>b.disabled); if(!disabled[1]) await click('[data-action="dl-agreement"]'); return {fit, disabled};`);
results["J1 agreement fit"] = r;
const j1 = { quote: await waitFile("-draft.html"), md: await waitFile(".md"), agreement: r.disabled[1] ? null : await waitFile("-agreement.html") };

// ── J2: receptionist-only Premium, per-second boundary, setup fee, discount, FX, missing cost entered ──
await goto("http://127.0.0.1:4317/");
r = await run(`
await click('[data-action="new"]'); await type('name','J2 receptionist only (synthetic)'); await type('client.business','Example Legal Group (synthetic)'); await type('client.contact','Office manager (synthetic)');
await pick('include.website', false); await pick('include.receptionist', true);
await tab('receptionist'); await click('[data-action="package"][data-id="receptionist-premium"]');
await type('rx.columns.full.billableSeconds','1800:01'); await type('rx.columns.extra.billableSeconds','2,000'); await type('rx.columns.low.billableSeconds','0'); await type('rx.columns.low.smsSegments','0'); await type('rx.columns.low.supportMinutes','0');
const base=rows();
await type('rx.fx.usdPerAudMillionths','0.65'); const fx=rows();
await type('rx.rateOverrides.database','19.35'); const withDb=rows(); const unknownAfter=q('#out .unknowns').textContent.includes('Neon Postgres usage');
await type('rx.setupFeeCents','2490'); await type('rx.monthlyDiscountBps','10'); const flagged=q('#out .flags').textContent;
const invalid=[await type('rx.columns.expected.billableSeconds','12:75'), await type('rx.voiceMicros','-0.1'), await type('rx.fx.date','2026-13-45x')];
await type('rx.columns.expected.billableSeconds','1,440'); await type('rx.voiceMicros','0.12'); await type('rx.fx.date','2026-09-25');
await sleep(500); return {base, fx, withDb, unknownAfter, flagged, invalid, final: rows(), be:[...document.querySelectorAll('#out ul.plain li')].map(l=>l.textContent)};`);
// Premium 1999 ex: 1800:01 -> 1 extra min 0.70 -> 1999.70 ex, GST 199.90+0.07=199.97, total 2199.67; 2000 min -> 200*0.70=140 -> 2139 ex, 213.90 -> 2352.90; zero usage 2198.90
check("J2 per-second and GST", r.base["Extra minutes billed"].join() === "0,0,1,200" && r.base["Invoice incl. GST"][2] === "A$2,199.67" && r.base["Invoice incl. GST"][3] === "A$2,352.90" && r.base["Invoice incl. GST"][0] === "A$2,198.90", [r.base["Extra minutes billed"], r.base["Invoice incl. GST"]]);
check("J2 zero usage: no usage cost, profit shown", r.base["Voice platform"][0] === "A$0.00" && r.base["Per support hour"][0] === "Unknown", [r.base["Voice platform"], r.base["Per support hour"]]);
check("J2 weaker AUD raises USD costs, not revenue", r.fx["Voice platform"][1] !== r.base["Voice platform"][1] && r.fx["Invoice incl. GST"][1] === r.base["Invoice incl. GST"][1], [r.base["Voice platform"][1], r.fx["Voice platform"][1]]);
// expected: 576 calls x 150 s + 29 short calls x 4 s = 86,516 s = 1,441.93 min at US$0.12 / 0.65 x 1.03 = A$274.19
check("J2 FX figure", r.fx["Voice platform"][1] === "A$274.19", r.fx["Voice platform"][1]);
check("J2 entered provider cost leaves unknown list and raises hosting share", !r.unknownAfter && r.withDb["Hosting share"][1] !== r.fx["Hosting share"][1], [r.fx["Hosting share"][1], r.withDb["Hosting share"][1]]);
check("J2 setup fee and discount flagged", /setup fee/i.test(r.flagged) && /discount/i.test(r.flagged), r.flagged);
check("J2 invalid inputs rejected", r.invalid.every((x: string) => x.startsWith("INVALID")), r.invalid);
// discounted monthly 1999*0.9 = 1799.10 ex -> incl 1979.01
check("J2 discounted invoice", r.final["Invoice incl. GST"][0] === "A$1,979.01", r.final["Invoice incl. GST"]);
r = await run(`await tab('quote'); await sleep(200); await click('[data-action="dl-html-client"]'); await tab('agreement'); await sleep(900); const fit=q('#fit').textContent; const disabled=[...document.querySelectorAll('[data-export]')].map(b=>b.disabled); if(!disabled[1]) await click('[data-action="dl-agreement"]'); return {fit, disabled};`);
results["J2 agreement fit"] = r;
await Bun.sleep(600);
const files2 = () => readdirSync(DL);

// ── J3: combined, extensive hand-written scope and many notes -> appendix ──
await goto("http://127.0.0.1:4317/");
const scope = Array.from({ length: 28 }, (_, i) => `Scope item ${i + 1}: a deliberately long synthetic scope line describing page ${i + 1} of the website, its content blocks, forms and review steps.`).join("\\n");
const notes = Array.from({ length: 7 }, (_, i) => `Special term ${i + 1}: synthetic wording agreed in a meeting, long enough to wrap across the line in print.`).join("\\n");
r = await run(`
await click('[data-action="new"]'); await type('name','J3 combined long scope (synthetic)'); await type('client.business','Example Realty Group (synthetic)'); await type('client.contact','Director (synthetic)');
await pick('include.receptionist', true); await tab('quote'); await sleep(150);
const before=q('[data-bind="quote.scope"]').value.split('\\n').length;
await type('quote.scope', ${JSON.stringify(scope).replace(/\\\\n/g, "\\n")}); await type('quote.notes', ${JSON.stringify(notes).replace(/\\\\n/g, "\\n")});
const mode=q('#text-mode').textContent; await sleep(300); await click('[data-action="dl-html-internal"]');
await tab('agreement'); await sleep(900); const fit=q('#fit').textContent; const disabled=[...document.querySelectorAll('[data-export]')].map(b=>b.disabled); if(!disabled[1]) await click('[data-action="dl-agreement"]');
return {before, mode, fit, disabled, custom: cur().quote.customText, deliverablesKept: cur().quote.deliverables.length>50};`);
check("J3 hand-edited text kept, appendix added, export allowed", r.custom && r.deliverablesKept && /Appendix A/.test(r.fit) && !r.disabled[1], r);

// ── J4: zero values ──
await goto("http://127.0.0.1:4317/");
r = await run(`
await click('[data-action="new"]'); await type('name','J4 zero values (synthetic)'); await tab('website'); await type('website.price.cents','0');
for (const k of ['discovery','design','build','content','cms','qa','pm']) await type('website.effortMinutes.'+k,'0'); await type('website.revisions.includedRounds','0'); await type('website.labourHourlyCents','0');
return {stats:stats(), text:q('#out').textContent.includes('NaN')};`);
check("J4 zero price/hours: no NaN, margin n/a", !r.text && r.stats["Gross profit"] === "A$0.00" && r.stats["Effective hourly"] === "Unknown", r.stats);

// ── Robustness: duplicate double-click, save failure, conflicting tabs ──
r = await run(`const n0=JSON.parse(localStorage.getItem('mu-deal-desk/v1')).deals.length; const b=q('[data-action="duplicate"]'); b.click(); q('[data-action="duplicate"]').click(); await sleep(500); return [n0, JSON.parse(localStorage.getItem('mu-deal-desk/v1')).deals.length];`);
check("double-click duplicate creates one deal", r[1] === r[0] + 1, r);
r = await run(`await tab('deal'); const orig=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError')}; await type('name','J4 while storage is full'); await sleep(500); const text=q('#status span:last-child').textContent; Storage.prototype.setItem=orig; await type('name','J4 zero values copy (synthetic)'); await sleep(500); return [text, q('#status span:last-child').textContent];`);
check("save failure is shown, then recovers", /NOT SAVED/.test(r[0]) && /Saved in this browser/.test(r[1]), r);
// second tab edits and saves; first tab must refuse to overwrite
const t2 = await (await fetch("http://127.0.0.1:9336/json/new?http://127.0.0.1:4317/", { method: "PUT" })).json();
const page2 = await connect(t2.webSocketDebuggerUrl); await Bun.sleep(1500);
await page2.ev(HELPERS + `await tab('deal'); await type('name','Edited in the OTHER tab (synthetic)'); await sleep(500); return 1;`);
await Bun.sleep(500);
r = await run(`const bannerShown=!q('#conflict').hidden; await type('name','Edited in THIS tab after the conflict'); await sleep(500); const stored=cur().name; const status=q('#status span:last-child').textContent; await click('[data-action="conflict-copy"]'); await sleep(400); const s=JSON.parse(localStorage.getItem('mu-deal-desk/v1')); return {bannerShown, stored, status, names:s.deals.map(d=>d.name).filter(n=>/OTHER tab|my copy/.test(n)), conflictHidden:q('#conflict').hidden};`);
check("conflicting edits: other tab's save is not overwritten, this tab's deal kept as a copy", r.bannerShown && r.stored === "Edited in the OTHER tab (synthetic)" && /NOT SAVED/.test(r.status) && r.names.length === 2 && r.conflictHidden, r);
page2.close();

// ── Export the downloaded documents to PDF exactly as a browser prints them ──
const pdfs: string[] = [];
check("no page errors during the journey", page.errors.length === 0, page.errors.slice(0, 5));
await Bun.write(`${OUT}/results.json`, JSON.stringify({ results, downloads: files2(), pdfs }, null, 1));
for (const [k, v] of Object.entries(results)) console.log(v.ok === false ? "FAIL" : v.ok === true ? "pass" : "info", k, v.ok === true ? "" : JSON.stringify(v.detail ?? v));
console.log("downloads:", files2().join(", "));
console.log(fails.length ? `FAILS: ${fails.length}` : "ALL PASS");
page.close(); browser?.close(); proc.kill();
