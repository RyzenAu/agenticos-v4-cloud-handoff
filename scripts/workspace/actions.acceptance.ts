// Synthetic browser verification. No live source, providers, or agent launch endpoint is used.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const at = "2026-09-30T01:00:00Z";
const item = { id: "sample-opening", title: "Choose the sample opening", detail: "Choose an opening for the fabricated business page.", href: "/websites", area: "websites", source: "Synthetic review", since: "2026-09-30", recordable: true, revision: "synthetic-revision" };
const job = { id: "sample-job", requestId: "sample-request", prompt: "Prepare the sample page", createdAt: at, updatedAt: at, runs: [{ agent: "claude", status: "needs_input", text: "", events: [], pending: { id: "sample-question", kind: "question", title: "Choose the layout", detail: "Which reviewed layout should the sample use?", choices: ["Compact", "Expanded"] } }] };
mkdirSync("outputs/editable-actions", { recursive: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: "reduce" }); page.setDefaultTimeout(10000);
    const errors: string[] = []; const writes: { path: string; body: any }[] = []; let refuse = true;
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") return route.abort();
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/__operator/leads/edit" && request.method() === "POST") {
        const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
        if (refuse) { refuse = false; return json({ error: "Synthetic save failed. Try again." }, 503); }
        return json({ lead: { ...body, status: body.status ?? "call_back", editVersion: "synthetic-lead-v2" } });
      }
      if (url.pathname === "/__operator/leads/detail") return json(await page.evaluate(() => (window as any).getSyntheticDetail()));
      if (request.method() === "POST") throw new Error(`Unexpected mutation: ${url.pathname}`);
      return route.continue();
    });
    await page.goto("http://127.0.0.1:4398/lead"); await page.locator("#open-lead").click();
    const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Edit lead", exact: true }).click();
    await dialog.getByLabel("Business name", { exact: true }).fill("Updated Sample Dental");
    await dialog.getByLabel("Phone", { exact: true }).fill("0299990001");
    await dialog.getByLabel("Assigned to", { exact: true }).selectOption("mehroz");
    await dialog.getByRole("tab", { name: "Call", exact: true }).click();
    await dialog.getByRole("tab", { name: "Overview", exact: true }).click();
    assert.equal(await dialog.getByLabel("Business name", { exact: true }).inputValue(), "Updated Sample Dental");
    await dialog.getByRole("button", { name: "Save lead", exact: true }).click();
    await dialog.getByText("Synthetic save failed. Try again.", { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel("Business name", { exact: true }).inputValue(), "Updated Sample Dental");
    await page.screenshot({ path: `outputs/editable-actions/lead-editor-${width}.png` });
    await dialog.getByRole("button", { name: "Save lead", exact: true }).click(); await dialog.getByText("Lead saved.", { exact: true }).waitFor();
    assert.equal(writes.length, 2); assert.deepEqual(Object.keys(writes[1].body).sort(), ["by", "lead", "name", "owner", "phone", "version"].sort());
    await page.keyboard.press("Escape"); await page.locator("#open-lead").click();
    await dialog.getByRole("heading", { name: "Updated Sample Dental", exact: true }).waitFor();
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true); assert.deepEqual(errors, []); await page.close();

    const decisions = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: "reduce" }); decisions.setDefaultTimeout(10000);
    const decisionErrors: string[] = []; const actionWrites: { path: string; body: any }[] = []; let records: any[] = []; let waiting = true;
    decisions.on("pageerror", e => decisionErrors.push(e.message));
    await decisions.route("**/*", route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") return route.abort();
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/__workspace/today") return json({ ok: true, updatedAt: at, ms: 1, data: { now: at, approvals: records.length ? [] : [item], decisions: records, approvalsErrors: [], derivedError: null, callingWindow: { open: true } } });
      if (url.pathname === "/__workspace/needs-you") return json({ ok: true, updatedAt: at, ms: 1, data: { total: records.length ? 0 : 1, complete: true, parts: {} } });
      if (url.pathname === "/__operator/agent-jobs") return json({ jobs: waiting ? [job] : [] });
      if (url.pathname === "/__operator/workspace/decision" && request.method() === "POST") {
        const body = request.postDataJSON(); actionWrites.push({ path: url.pathname, body });
        records = body.answer === "reopen" ? [] : [{ item, revision: item.revision, answer: body.answer, note: body.note, at, by: "synthetic-owner" }]; return json({ records });
      }
      if (url.pathname === "/__operator/agent-jobs/respond" && request.method() === "POST") { actionWrites.push({ path: url.pathname, body: request.postDataJSON() }); waiting = false; return json({ ok: true }); }
      if (request.method() === "POST") throw new Error(`Unexpected mutation: ${url.pathname}`);
      return route.continue();
    });
    await decisions.goto("http://127.0.0.1:4400/");
    const row = decisions.locator('[data-decision="sample-opening"]');
    await row.getByRole("button", { name: "Record decision", exact: true }).click();
    await row.getByLabel("Decision note (optional)", { exact: true }).fill("Use the compact opening.");
    await decisions.screenshot({ path: `outputs/editable-actions/decisions-${width}.png` });
    await row.getByRole("button", { name: "Save decision", exact: true }).click();
    await decisions.getByText("No business decisions waiting", { exact: true }).waitFor();
    await decisions.locator("summary").filter({ hasText: "Recorded decisions" }).click();
    await row.getByRole("button", { name: "Edit decision", exact: true }).click();
    await row.getByLabel("Your decision", { exact: true }).selectOption("declined");
    await row.getByRole("button", { name: "Save decision", exact: true }).click();
    await row.getByRole("button", { name: "Reopen", exact: true }).click();
    await row.getByRole("button", { name: "Record decision", exact: true }).waitFor();
    const questions = decisions.getByRole("region", { name: "Agent questions", exact: true });
    await questions.getByRole("button", { name: "Compact", exact: true }).click();
    await questions.getByRole("button", { name: "Send answer", exact: true }).click();
    await questions.getByText("No agents waiting for your answer.", { exact: true }).waitFor();
    assert.equal(actionWrites.length, 4); assert.deepEqual(actionWrites[3].body.answers, { answer: "Compact" });
    assert.equal(await decisions.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true); assert.deepEqual(decisionErrors, []);
    results.push({ width, leadEdit: true, unchangedFieldsOmitted: true, unsavedEditsPreserved: true, saveFailureRecoverable: true, reopenLead: true, decisionSaveEditReopen: true, agentAnswer: true, liveEffects: 0, errors: [] });
    await decisions.close();
  }
} finally { await browser.close(); }
writeFileSync("outputs/editable-actions/acceptance.json", JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
