// Start: bun run scripts/leads/detail-continuity.preview.ts
// Check: bun run scripts/leads/detail-continuity.acceptance.ts
// All mutation requests are intercepted; only fabricated state is loaded.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
const browser=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true});
mkdirSync("outputs/detail-continuity",{recursive:true});
const results=[];
try {
  for(const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:960},reducedMotion:"reduce"});page.setDefaultTimeout(8000);
    const errors:string[]=[];const writes:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await page.route("**/*",r=>{
      const u=new URL(r.request().url());if(u.hostname!=="127.0.0.1")return r.abort();
      if(r.request().method()==="POST") {writes.push(u.pathname);return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})})}
      return r.continue();
    });
    await page.goto("http://127.0.0.1:4398/lead");await page.locator("#open-lead").click();
    const dialog=page.getByRole("dialog");await dialog.waitFor();
    assert.equal(await dialog.getByRole("tabpanel",{name:"Overview",exact:true}).isVisible(),true);
    assert.equal(await dialog.getByRole("heading",{name:"Deal",exact:true}).count(),0,"secondary views must not mount before needed");
    await dialog.getByRole("button",{name:"Prepare call",exact:true}).click();
    assert.equal(await dialog.getByRole("tabpanel",{name:"Call",exact:true}).isVisible(),true);
    const note=dialog.getByPlaceholder("Note (optional)");await note.fill("Synthetic unsaved callback note");
    await dialog.getByRole("tab",{name:"Deal",exact:true}).click();
    const monthly=dialog.getByLabel("Monthly (A$, ex GST)");await monthly.fill("1200");
    await dialog.getByRole("tab",{name:"Call",exact:true}).click();assert.equal(await note.inputValue(),"Synthetic unsaved callback note");
    await dialog.getByRole("tab",{name:"Deal",exact:true}).click();assert.equal(await monthly.inputValue(),"1200");
    const prefs=dialog.getByRole("tab",{name:"Call",exact:true});await prefs.click();
    await dialog.locator("summary").filter({hasText:"Edit contact notes"}).click();
    const pref=dialog.getByRole("textbox",{name:"How they like to be contacted"});await pref.fill("Synthetic updated contact notes");
    await Promise.all([page.waitForResponse(r=>r.url().endsWith("/__operator/leads/deal") && r.request().method()==="POST"),dialog.getByRole("button",{name:"Save",exact:true}).click()]);assert.equal(writes.length,1);assert.equal(writes[0],"/__operator/leads/deal");
    const callback=dialog.getByLabel("Call back on");assert.equal(await callback.getAttribute("min")!==null,true);
    await dialog.getByRole("tab",{name:"Overview",exact:true}).click();
    const first=dialog.getByRole("tab",{name:"Overview",exact:true});await first.focus();await page.keyboard.press("End");
    assert.equal(await dialog.getByRole("tab",{name:"History",exact:true}).getAttribute("aria-selected"),"true");
    await page.keyboard.press("Home");assert.equal(await first.getAttribute("aria-selected"),"true");
    for(const tab of ["Overview","Call","Deal","Research","History"]) {
      await dialog.getByRole("tab",{name:tab,exact:true}).click();
      assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      const panel=dialog.getByRole("tabpanel",{name:tab,exact:true});assert.equal(await panel.isVisible(),true);
      await page.screenshot({path:`outputs/detail-continuity/round1-${tab.toLowerCase()}-${width}.png`});
    }
    await page.evaluate(()=> (window as any).setSyntheticLead({status:"do_not_contact"}));
    await dialog.getByRole("tab",{name:"Overview",exact:true}).click();assert.equal(await dialog.getByRole("button",{name:"Prepare call"}).count(),0);
    await dialog.getByRole("tab",{name:"Call",exact:true}).click();assert.equal(await dialog.getByRole("button",{name:"Start call (meeting mode)",exact:true}).isDisabled(),true);
    await page.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});assert.equal(await page.locator("#open-lead").evaluate(el=>document.activeElement===el),true);
    await page.evaluate(()=> (window as any).setSyntheticLead({excluded:true,excludedReason:"Synthetic excluded business"}));await page.locator("#open-lead").click();
    await dialog.getByRole("tab",{name:"Research",exact:true}).click();assert.equal(await dialog.getByRole("button",{name:"SEO audit",exact:true}).count(),0);
    assert.deepEqual(errors,[]);assert.equal(writes.length,1);
    results.push({width,tabPersistence:true,syntheticSave:true,keyboardTabs:true,escapeAndFocus:true,noContactRestriction:true,excludedResearch:true,noOverflow:true,errors});
    await page.close();
    const memory=await browser.newPage({viewport:{width,height:960},reducedMotion:"reduce"});
    await memory.route("**/*",r=>new URL(r.request().url()).hostname==="127.0.0.1"?r.continue():r.abort());
    await memory.goto("http://127.0.0.1:4398/memory-detail");await memory.locator("#open-lead").click();
    assert.equal(await memory.locator(".op-detail-text").evaluate(el=>getComputedStyle(el).fontSize),"15px");
    await memory.screenshot({path:`outputs/detail-continuity/round1-memory-${width}.png`});await memory.close();
  }
} finally {await browser.close()}
writeFileSync("outputs/detail-continuity/interactions.json",JSON.stringify(results,null,2));console.log(JSON.stringify(results));
