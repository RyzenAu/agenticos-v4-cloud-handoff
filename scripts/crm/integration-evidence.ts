/** Mounted-app integration evidence on a DISPOSABLE hub whose CRM was migrated from SYNTHETIC leads (seed-gate-hub.ts, then migrate.ts --apply --backup).
 * Loopback only; the founder is the owner at the hub (no stored session needed). It never starts a server, never reads a credential, and refuses a CRM
 * that does not look like the synthetic seed (six migrated leads). Complements browser-acceptance.ts (the company-to-result journey on an empty CRM):
 *
 *   bun scripts/crm/integration-evidence.ts --base-url=http://127.0.0.1:8762 --browser-executable=C:/.../chrome.exe --output-dir=D:/.../evidence
 *
 * Covers, with screenshots at 1440, 768 and 390: the migrated list, an edit that persists across a reload, a conflicting edit ("Changed elsewhere", Reload
 * latest, nothing lost), the CSV import preview (never committed), the one-time-upgrade state is covered by tests, and the Leads bridge through the mounted
 * app: a founder's CRM correction survives a Leads sync, a Leads correction arrives once, and a repeated Leads event or snapshot adds no second activity.
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const option = (key: string) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
const base = new URL(option("base-url") ?? "http://127.0.0.1:8762");
const executable = option("browser-executable");
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("Loopback only.");
if (!executable || !isAbsolute(executable))
  throw new Error("Supply an absolute --browser-executable.");
const out = resolve(option("output-dir") ?? "./integration-evidence");
await mkdir(out, { recursive: true });
const WIDTHS = [1440, 768, 390] as const;
const report: {
  status: string;
  steps: string[];
  screenshots: string[];
  failures: string[];
  consoleErrors: string[];
  facts: Record<string, unknown>;
} = { status: "running", steps: [], screenshots: [], failures: [], consoleErrors: [], facts: {} };
const save = () =>
  writeFile(resolve(out, "integration-report.json"), JSON.stringify(report, null, 2));

const browser = await chromium.launch({ executablePath: executable, headless: true });
const context: BrowserContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
  serviceWorkers: "block",
});
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return url.origin === base.origin || ["data:", "blob:", "about:"].includes(url.protocol)
    ? route.continue()
    : route.abort("blockedbyclient");
});
const page: Page = await context.newPage();
page.on(
  "console",
  (m) =>
    m.type() === "error" &&
    !m.text().includes("409") &&
    !m.text().includes("400 (Bad Request)") &&
    report.consoleErrors.push(`${m.text()} (${m.location().url})`),
);
const ok = (c: boolean, msg: string) => {
  if (!c) throw new Error(msg);
};
const url = (p: string) => new URL(p, base).href;
async function token(): Promise<string> {
  return ((await (await context.request.get(url("/__token"))).json()) as { token: string }).token;
}
async function snap(): Promise<any> {
  const r = await context.request.get(url("/__crm/snapshot"), { maxRedirects: 0 });
  ok(r.ok(), `snapshot ${r.status()}`);
  return r.json();
}
async function op(name: string, input: unknown): Promise<any> {
  const r = await context.request.post(url("/__crm/ops"), {
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
    data: { name, input },
  });
  return { status: r.status(), ...(await r.json()) };
}
async function leads(path: string, body: unknown): Promise<any> {
  const r = await context.request.post(url(`/__operator/leads/${path}`), {
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
    data: body,
  });
  return { status: r.status(), body: await r.json().catch(() => null) };
}
/** A freshly started dev hub re-optimises dependencies on first load (a 504 on one module); reloading fixes it. */
async function open(path: string, ready: () => Promise<unknown>) {
  await page.goto(url(path));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await ready();
      return;
    } catch {
      await page.reload();
    }
  }
  await ready();
}
async function shot(label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  ok(!overflow, `Horizontal overflow in ${label}`);
  await page.screenshot({ path: resolve(out, `${label}.png`), fullPage: false });
  report.screenshots.push(`${label}.png`);
}
async function atEachWidth(label: string) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w === 390 ? 900 : 1000 });
    await page.waitForTimeout(250);
    await shot(`${label}-${w}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function step(name: string, run: () => Promise<void>) {
  await run();
  report.steps.push(name);
  await save();
}
try {
  const first = await snap();
  ok(
    first.companies.length === 6 && first.deals.length === 6,
    `Expected the six migrated synthetic leads, found ${first.companies.length} companies`,
  );
  // Google-sourced leads migrate WITHOUT their display name (no independent source). A founder's Leads correction is that source: it must arrive.
  const unnamed = first.companies.every((c: any) => c.name === "");
  report.facts.migratedUnnamed = unnamed;
  if (unnamed)
    await step(
      "Unnamed migrated companies read as a label, with a heading and a named open button",
      async () => {
        await open("/crm?view=companies", async () => {
          await page.getByRole("heading", { name: "CRM", exact: true }).waitFor({ timeout: 15000 });
          await page
            .getByRole("button", { name: /^Unnamed company \(lead #\d+\)$/ })
            .first()
            .waitFor({ timeout: 15000 });
        });
        await atEachWidth("unnamed-list");
        await page
          .getByRole("button", { name: /^Unnamed company \(lead #\d+\)$/ })
          .first()
          .click();
        await page.getByRole("heading", { name: /^Unnamed company · .+\(lead #\d+\)$/ }).waitFor();
        await atEachWidth("unnamed-company-page");
        const options = await page.evaluate(() =>
          [...document.querySelectorAll("option")].map((o) => o.textContent ?? ""),
        );
        ok(
          options.every((t) => t.trim() !== ""),
          "a picker has a blank option",
        );
        ok(
          first.deals.every((d: any) => d.title === `Lead #${d.legacyLeadId} opportunity`),
          "unexpected seeded deal titles",
        );
      },
    );
  if (unnamed)
    await step(
      "A founder's Leads correction (the name) arrives in the CRM through the bridge",
      async () => {
        for (const company of first.companies) {
          const detail = await (
            await context.request.get(url(`/__operator/leads/detail?id=${company.legacyLeadId}`))
          ).json();
          const edited = await leads("edit", {
            lead: company.legacyLeadId,
            version: detail.lead.editVersion,
            by: "usman",
            name: `${detail.lead.name} Pty Ltd`,
          });
          ok(edited.status === 200, `lead edit ${edited.status}`);
        }
        const named = await snap();
        ok(
          named.companies.every((c: any) => c.name !== ""),
          "a Leads correction did not reach the CRM",
        );
        report.facts.namesAfterLeadsCorrection = named.companies.map((c: any) => c.name);
        ok(
          named.deals.every(
            (d: any) =>
              d.title ===
              `${named.companies.find((c: any) => c.id === d.companyId).name} opportunity`,
          ),
          "auto-named deals were not retitled when the name arrived",
        );
      },
    );
  const start = await snap();
  const target = start.companies[0];

  await step("Migrated list renders", async () => {
    await open("/crm?view=companies", async () => {
      await page.getByRole("heading", { name: "CRM", exact: true }).waitFor({ timeout: 15000 });
      await page
        .getByRole("button", { name: target.name, exact: true })
        .waitFor({ timeout: 15000 });
    });
    await atEachWidth("list");
  });

  await step("Edit persists across a reload", async () => {
    await page.getByRole("button", { name: target.name, exact: true }).click();
    await page.getByRole("button", { name: "Edit company", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Internal notes", { exact: true }).fill("Edited in the mounted app");
    await atEachWidth("edit-dialog");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.reload();
    await page.getByText("Edited in the mounted app").first().waitFor();
    const after = (await snap()).companies.find((c: any) => c.id === target.id);
    ok(
      after.notes.includes("Edited in the mounted app") && after.version > target.version,
      "edit not persisted",
    );
    await atEachWidth("after-reload");
  });

  await step("Conflicting edit says changed elsewhere and loses nothing", async () => {
    await page.getByRole("button", { name: "Edit company", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const current = (await snap()).companies.find((c: any) => c.id === target.id);
    await dialog
      .getByLabel("Internal notes", { exact: true })
      .fill("My draft after the other founder saved");
    // The other founder saves first, through the same operation the buttons use.
    const other = await op("crm.company.update", {
      id: target.id,
      expectedVersion: current.version,
      patch: { industry: "Changed by the other founder" },
    });
    ok(other.ok === true, "the competing save failed");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.getByText("Changed elsewhere").waitFor();
    ok(
      await dialog.getByRole("button", { name: "Save changes", exact: true }).isDisabled(),
      "stale save is still enabled",
    );
    ok(
      (await dialog.getByLabel("Internal notes", { exact: true }).inputValue()) ===
        "My draft after the other founder saved",
      "draft was lost",
    );
    await atEachWidth("conflict");
    await dialog.getByRole("button", { name: "Reload latest", exact: true }).click();
    await dialog.getByText("Changed elsewhere").waitFor({ state: "hidden" });
    ok(
      (await dialog.getByLabel("Industry", { exact: true }).inputValue()) ===
        "Changed by the other founder",
      "latest value not taken",
    );
    ok(
      (await dialog.getByLabel("Internal notes", { exact: true }).inputValue()) ===
        "My draft after the other founder saved",
      "draft lost on reload",
    );
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const final = (await snap()).companies.find((c: any) => c.id === target.id);
    ok(
      final.notes === "My draft after the other founder saved" &&
        final.industry === "Changed by the other founder",
      "merged save lost a field",
    );
    report.facts.conflict = { finalVersion: final.version };
  });

  await step("CSV import shows a preview and commits nothing", async () => {
    const before = (await snap()).companies.length;
    await page.goto(url("/crm?view=companies"));
    await page.getByRole("button", { name: "Import CSV", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("CSV content")
      .fill(
        `name,industry,email\nSynthetic Import Co,Plumbing,hello@synthetic-import.example\n${target.name},Dental,`,
      );
    await dialog.getByRole("button", { name: "Preview and validate" }).click();
    await dialog.getByText(/rows/).first().waitFor();
    await atEachWidth("import-preview");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    ok((await snap()).companies.length === before, "preview created a record");
  });

  await step("Escape keeps typed text; Cancel discards it", async () => {
    await page.goto(url("/crm?view=companies"));
    await page.getByRole("button", { name: "Add company", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Business name", { exact: true }).fill("Typed but not saved");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ok(await dialog.isVisible(), "Escape closed a dialog with typed text");
    await dialog.getByText("Your changes are still here").waitFor();
    ok(
      (await dialog.getByLabel("Business name", { exact: true }).inputValue()) ===
        "Typed but not saved",
      "typed text lost",
    );
    await atEachWidth("escape-keeps-text");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Add company", exact: true }).first().click();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" }); // nothing typed: Escape closes
  });

  await step(
    "Export all, then import that same file: every row is a match and nothing is new",
    async () => {
      const before = (await snap()).companies.length;
      const exported = await op("crm.csv.export", { kind: "companies" });
      ok(exported.ok === true, "export failed");
      const csv: string = exported.data.csv;
      await page.goto(url("/crm?view=companies"));
      await page.getByRole("button", { name: "Import CSV", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("CSV content").fill(csv);
      await dialog.getByRole("button", { name: "Preview and validate" }).click();
      await dialog
        .getByText(/with possible matches/)
        .first()
        .waitFor();
      const summary =
        (await dialog
          .getByText(/with possible matches/)
          .first()
          .textContent()) ?? "";
      ok(
        new RegExp(`^${before} with possible matches`).test(summary.trim()) ||
          summary.includes(`${before} with possible matches`),
        `expected ${before} matches, saw "${summary}"`,
      );
      ok(
        (await dialog.getByText(/0 invalid/).count()) > 0,
        "the export's own file has invalid rows",
      );
      await atEachWidth("export-import-roundtrip");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      ok((await snap()).companies.length === before, "round trip created a record");
    },
  );

  await step(
    "A rejected phone number is explained beside its field; Time zone is a list",
    async () => {
      await page.goto(url("/crm?view=companies"));
      await page.getByRole("button", { name: "Add company", exact: true }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Business name", { exact: true }).fill("Phone check Co");
      await dialog.getByLabel("Business phone", { exact: true }).fill("abc");
      const zone = dialog.getByLabel("Time zone", { exact: true });
      ok((await zone.evaluate((el) => el.tagName)) === "SELECT", "Time zone is not a list");
      ok(
        (await zone.locator("option").first().textContent()) === "Australia/Sydney",
        "Australia is not first",
      );
      await dialog.getByRole("button", { name: "Add company", exact: true }).click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: "Enter an Australian phone number" })
        .waitFor();
      ok(!(await dialog.innerText()).match(/emails\.0|patch\./), "a field path is shown");
      await atEachWidth("phone-error-beside-field");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      ok(
        !(await snap()).companies.some((c: any) => c.name === "Phone check Co"),
        "a rejected form saved a record",
      );
    },
  );

  await step("The pipeline search is kept in the address across a reload", async () => {
    await page.goto(url("/crm?view=pipeline"));
    const box = page.getByRole("searchbox", { name: "Search deals or companies" });
    await box.fill("opportunity");
    await page.waitForURL(/q=opportunity/);
    await page.reload();
    ok((await box.inputValue()) === "opportunity", "the search was lost on reload");
    await atEachWidth("pipeline-search-in-address");
  });

  await step("Timeline tells the account's story in words, with no ids", async () => {
    await page.goto(
      url(`/crm?view=companies&ref=${encodeURIComponent(`crm:company:${target.id}`)}&tab=timeline`),
    );
    await page.getByText("Company details updated").first().waitFor({ timeout: 15000 });
    const text = await page.locator("main").innerText();
    ok(!/(task|document|workflow|company)-[0-9a-f]{6,}/i.test(text), "the timeline prints an id");
    await atEachWidth("timeline-story");
  });

  await step(
    "Leads bridge: correction kept, Leads change arrives once, repeats add nothing",
    async () => {
      const s0 = await snap();
      const c = s0.companies.find((x: any) => x.id === target.id);
      const legacyId = c.legacyLeadId;
      ok(typeof legacyId === "number", "target has no legacy lead");
      // 1. The founder's CRM correction survives repeated Leads syncs (each snapshot runs the bridge).
      const corrected = await op("crm.company.update", {
        id: c.id,
        expectedVersion: c.version,
        patch: { phone: "02 9999 0000" },
      });
      ok(corrected.ok === true, "phone correction failed");
      for (let i = 0; i < 3; i++) await snap();
      const s1 = await snap();
      ok(
        s1.companies.find((x: any) => x.id === c.id).phone === "02 9999 0000",
        "CRM correction was overwritten by a sync",
      );
      // 2. A Leads event arrives once, even when sent twice with the same event key.
      const activitiesBefore = s1.activities.filter((a: any) => a.companyId === c.id).length;
      const body = {
        lead: legacyId,
        outcome: "interested",
        kind: "call",
        by: "usman",
        event: `integration-evidence-${Date.now()}`,
      };
      const first = await leads("log", body);
      const second = await leads("log", body);
      ok(
        first.status === 200 && second.status === 200,
        `leads log ${first.status}/${second.status}`,
      );
      ok(
        second.body?.duplicate === true,
        "the repeated Leads event was not recognised as a duplicate",
      );
      for (let i = 0; i < 3; i++) await snap();
      const s2 = await snap();
      const added =
        s2.activities.filter((a: any) => a.companyId === c.id).length - activitiesBefore;
      ok(added === 1, `expected one new activity from two identical Leads events, saw ${added}`);
      ok(
        s2.companies.find((x: any) => x.id === c.id).phone === "02 9999 0000",
        "correction lost after the Leads event",
      );
      report.facts.leadsBridge = {
        legacyId,
        newActivities: added,
        duplicateFlag: second.body?.duplicate,
      };
      await page.goto(
        url(`/crm?view=companies&ref=${encodeURIComponent(`crm:company:${c.id}`)}&tab=timeline`),
      );
      await page.getByRole("heading", { name: c.name }).waitFor();
      await atEachWidth("timeline-after-leads");
    },
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failures.push(error instanceof Error ? error.message : String(error));
  await page.screenshot({ path: resolve(out, "failure.png") }).catch(() => undefined);
} finally {
  await save();
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.status === "passed" ? 0 : 1);
