/** Real mounted CRM acceptance. NEVER imports seed/runtime code or starts a server.
 * Run only against an isolated disposable workspace and a permitted local browser:
 * bun scripts/crm/browser-acceptance.ts --disposable --base-url=http://localhost:8081 \
 *   --browser-executable=/absolute/path/to/chromium --storage-state=/absolute/path/to/synthetic-founder.json \
 *   --output-dir=/tmp/crm-browser-acceptance
 * The caller supplies a synthetic founder session through the normal sign-in flow.
 * This file was authored in a browser-blocked environment and has NOT been run there.
 */
import { chromium, type Page, type Locator } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CrmSnapshot } from "./types";

const option = (key: string) =>
  process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const base = new URL(option("base-url") || "http://localhost:8081");
const executable = option("browser-executable"),
  storageState = option("storage-state");
if (!process.argv.includes("--disposable"))
  throw new Error(
    "Refusing writes: supply --disposable only for an isolated synthetic workspace. Never use a real client workspace.",
  );
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password
)
  throw new Error(
    "Use the permitted loopback CRM server. No remote host or embedded credentials are accepted.",
  );
if (!executable || !isAbsolute(executable) || !storageState || !isAbsolute(storageState))
  throw new Error(
    "Supply absolute --browser-executable and --storage-state paths for an existing permitted browser and synthetic founder session. The runner does not obtain credentials.",
  );
const out = resolve(option("output-dir") || "/tmp/crm-browser-acceptance");
await mkdir(out, { recursive: true });
const prefix = `CRM acceptance ${new Date().toISOString().replace(/[:.]/g, "-")}`;
const completed: string[] = [],
  screenshots: string[] = [],
  failures: string[] = [],
  consoleErrors: string[] = [],
  pageErrors: string[] = [];
const report = {
  status: "running",
  prefix,
  completed,
  screenshots,
  failures,
  consoleErrors,
  pageErrors,
  neverRun: [
    "Live providers, emails, calendar invitations, payment, paid generation, deployment",
    "Real external job artifact availability and provider completion",
    "Native screen-reader announcement quality and Safari/Firefox",
    "Visual screenshot review by the integration owner",
    "Full journey interactions repeated at every viewport (one journey is run; screenshots check all three widths)",
    "Modal focus trapping, focus restoration, unsaved navigation, Back/Forward and Escape dismissal",
    "External result link destination is recorded and rendered but never visited",
  ],
};
let injectingFailure = false;
await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
async function createSession() {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: executable, headless: true });
    const context = await browser.newContext({
      storageState,
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    // These browser guards do not prevent the server from contacting providers. The
    // caller must run the separate disposable hub with providers/background work disabled.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === base.origin || ["data:", "blob:", "about:"].includes(url.protocol))
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => {
      const url = new URL(socket.url());
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      if (url.origin === base.origin) socket.connectToServer();
      else socket.close({ code: 1008, reason: "Acceptance permits this disposable hub only" });
    });
    return { browser, context, page: await context.newPage() };
  } catch (error) {
    report.status = "failed";
    failures.push(
      `Browser/session initialisation: ${error instanceof Error ? error.message : String(error)}`,
    );
    await browser?.close().catch(() => {});
    await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
    throw error;
  }
}
const { browser, context, page } = await createSession();
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  if (
    injectingFailure &&
    message.location().url.includes("/__crm/snapshot") &&
    message.text().includes("503")
  )
    return;
  consoleErrors.push(`${message.text()} (${message.location().url})`);
});
async function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
async function visible(locator: Locator) {
  await locator.waitFor({ state: "visible", timeout: 15000 });
}
async function snapshot(): Promise<CrmSnapshot> {
  const response = await context.request.get(new URL("/__crm/snapshot", base).href, {
    maxRedirects: 0,
  });
  if (!response.ok())
    throw new Error(
      `Snapshot read failed (${response.status()}); verify synthetic founder identity before any run.`,
    );
  return response.json();
}
async function saveDialog(name: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name, exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15000 });
}
async function capture(label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  await check(!overflow, `Horizontal page overflow in ${label}`);
  const filename = `${label}.png`;
  await page.screenshot({ path: resolve(out, filename), fullPage: true });
  screenshots.push(filename);
}
async function step(name: string, run: () => Promise<void>) {
  await run();
  completed.push(name);
}
try {
  const initial = await snapshot();
  await check(
    initial.companies.length === 0 && initial.deals.length === 0 && initial.projects.length === 0,
    "Workspace is not empty. This runner requires a fresh disposable CRM to protect existing records.",
  );
  await step("Mounted CRM loads; keyboard tab navigation", async () => {
    await page.goto(new URL("/crm?view=companies", base).href);
    await visible(page.getByRole("heading", { name: "CRM", exact: true }));
    const companies = page.getByRole("tab", { name: "Companies", exact: true });
    await companies.focus();
    await page.keyboard.press("ArrowRight");
    await check(
      (await page
        .getByRole("tab", { name: "Contacts", exact: true })
        .getAttribute("aria-selected")) === "true",
      "ArrowRight did not select Contacts",
    );
    await page.getByRole("tab", { name: "Companies", exact: true }).click();
  });
  await step("Create company and preserve modal cancellation", async () => {
    await page.getByRole("button", { name: "Add company", exact: true }).first().click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add company", exact: true })
      .click();
    await check(
      await page.getByRole("dialog").isVisible(),
      "Blank company form closed unexpectedly",
    );
    await check(
      await page
        .getByRole("dialog")
        .getByLabel("Business name", { exact: true })
        .evaluate((node) => (node as HTMLInputElement).validity.valueMissing),
      "Required business name did not reject a blank value",
    );
    await check((await snapshot()).companies.length === 0, "Blank form created a company");
    await page
      .getByRole("dialog")
      .getByLabel("Business name", { exact: true })
      .fill(`${prefix} cancelled`);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await check((await snapshot()).companies.length === 0, "Cancel created a company");
    await page.getByRole("button", { name: "Add company", exact: true }).first().click();
    await page.getByRole("dialog").getByLabel("Business name", { exact: true }).fill(prefix);
    await page
      .getByRole("dialog")
      .getByLabel("Internal notes", { exact: true })
      .fill("Synthetic record created by local browser acceptance");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add company", exact: true })
      .dblclick();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 15000 });
    await check(
      (await snapshot()).companies.filter((record) => record.name === prefix).length === 1,
      "Double submit created more than one company",
    );
    await page.getByPlaceholder("Name, phone, email or company ID").fill(prefix);
    await page.getByRole("button", { name: prefix, exact: true }).click();
  });
  const company = (await snapshot()).companies.find((record) => record.name === prefix)!;
  await check(!!company?.id, "Company stable ID missing");
  await step("Edit company and preserve stable ID", async () => {
    await page.getByRole("button", { name: "Edit company", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Internal notes", { exact: true })
      .fill("Edited through mounted UI");
    await saveDialog("Save changes");
    const changed = (await snapshot()).companies.find((record) => record.id === company.id);
    await check(
      changed?.notes === "Edited through mounted UI" && changed.version > company.version,
      "Company edit did not persist under stable ID",
    );
  });
  await step("Create company contact", async () => {
    await page.getByRole("button", { name: "Add contact", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Full name", { exact: true })
      .fill("Synthetic contact");
    await saveDialog("Add contact");
    const contacts = (await snapshot()).contacts.filter(
      (contact) => contact.companyId === company.id,
    );
    await check(
      contacts.length === 1 && contacts[0].name === "Synthetic contact",
      "Contact did not persist under the intended company",
    );
  });
  await step("Create deal with scope, owner and dated next action", async () => {
    await page.getByRole("tab", { name: /^Deals/ }).click();
    await page.getByRole("button", { name: "Add deal", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title", { exact: true }).fill(`${prefix} website`);
    await dialog.getByLabel("Responsible founder", { exact: true }).selectOption("usman");
    await dialog.getByLabel("Sales stage", { exact: true }).selectOption("proposal");
    await dialog
      .getByLabel("Service and scope", { exact: true })
      .fill("Synthetic website scope for local acceptance");
    await dialog.getByLabel("Next action", { exact: true }).fill("Review the synthetic proposal");
    await dialog.getByLabel("Next action due", { exact: false }).fill("2026-10-15T10:00");
    await saveDialog("Add deal");
    const proposalResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/__crm/ops") &&
        response.request().postDataJSON()?.name === "crm.proposal.draft",
    );
    await page.getByRole("button", { name: "Draft proposal", exact: true }).last().click();
    await check((await proposalResponse).ok(), "Proposal operation failed");
    await check(
      (await snapshot()).documents.some((d) => d.companyId === company.id && d.kind === "proposal"),
      "Proposal draft not created",
    );
  });
  const deal = (await snapshot()).deals.find((record) => record.companyId === company.id)!;
  await check(
    deal.owner === "usman" &&
      deal.scope === "Synthetic website scope for local acceptance" &&
      deal.nextAction === "Review the synthetic proposal" &&
      !!deal.nextActionDue &&
      Number.isFinite(Date.parse(deal.nextActionDue)),
    "Deal owner, scope or dated next action did not persist",
  );
  await step("Create linked project and delivery task", async () => {
    await page.getByRole("tab", { name: /^Delivery/ }).click();
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Project name", { exact: true }).fill(`${prefix} delivery`);
    await dialog.getByLabel("Linked deal", { exact: true }).selectOption(deal.id);
    await saveDialog("Add project");
    const project = (await snapshot()).projects.find((p) => p.companyId === company.id)!;
    await page
      .locator(`[id="crm-project-${project.id}"]`)
      .getByRole("button", { name: "Add task", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Title", { exact: true })
      .fill(`${prefix} review layout`);
    await saveDialog("Add task");
    const saved = (await snapshot()).tasks.find((task) => task.projectId === project.id);
    await check(
      saved?.dealId === deal.id && saved.kind === "delivery" && saved.status === "open",
      "Delivery task relationship/default was not persisted",
    );
  });
  const project = (await snapshot()).projects.find((record) => record.companyId === company.id)!;
  await step("Link a delivery result and inspect deferred document content", async () => {
    await page
      .locator(`[id="crm-project-${project.id}"]`)
      .getByRole("button", { name: "Link delivery result", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title", { exact: true }).fill(`${prefix} saved result`);
    await dialog
      .getByLabel("Existing document link", { exact: true })
      .fill("https://example.com/synthetic-review");
    await dialog
      .getByLabel("First version content", { exact: false })
      .fill("Synthetic delivery review; external link is a placeholder and is not visited");
    await saveDialog("Add document");
    const document = (await snapshot()).documents.find(
      (d) => d.projectId === project.id && d.kind === "deliverable",
    )!;
    const row = page
      .locator("#crm-company-panel-delivery")
      .locator(`[id="crm-document-delivery-${document.id}"]`);
    await check(
      document.externalUrl === "https://example.com/synthetic-review",
      "Saved result URL changed",
    );
    const link = row.getByRole("link", { name: /Open document/ });
    await check(
      (await link.getAttribute("href")) === document.externalUrl &&
        (await link.getAttribute("target")) === "_blank" &&
        (await link.getAttribute("rel"))?.includes("noopener") === true,
      "Result link target or tab isolation is incorrect",
    );
    await row.getByRole("button", { name: /Versions and content/ }).click();
    await visible(
      row.getByText(
        "Synthetic delivery review; external link is a placeholder and is not visited",
        { exact: true },
      ),
    );
  });
  await step("Responsive company journey at 1440, 768 and 390 px", async () => {
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await capture(`company-${width}`);
    }
  });
  await step(
    "Slow refresh preserves an unsaved editor draft before and after response",
    async () => {
      let releaseSlow!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      const waiting = page.waitForRequest((request) => request.url().endsWith("/__crm/snapshot"), {
        timeout: 15000,
      });
      await page.route("**/__crm/snapshot", async (route) => {
        await held;
        await route.continue();
      });
      try {
        const response = page.waitForResponse(
          (response) => response.url().endsWith("/__crm/snapshot") && response.ok(),
        );
        await page.getByRole("button", { name: "Refresh CRM", exact: true }).click();
        await waiting;
        await page.getByRole("button", { name: "Edit company", exact: true }).click();
        const notes = page.getByRole("dialog").getByLabel("Internal notes", { exact: true });
        await notes.fill("Unsaved draft during a slow read");
        await check(
          (await notes.inputValue()) === "Unsaved draft during a slow read",
          "Pending refresh replaced unsaved text",
        );
        releaseSlow();
        await response;
        await check(
          (await notes.inputValue()) === "Unsaved draft during a slow read",
          "Completed refresh replaced unsaved text",
        );
        await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
        await check(
          (await snapshot()).companies.find((c) => c.id === company.id)?.notes ===
            "Edited through mounted UI",
          "Cancelling unsaved refresh draft changed stored notes",
        );
      } finally {
        releaseSlow();
        await page.unroute("**/__crm/snapshot");
      }
    },
  );
  await step("Stale-data warning retains loaded records and recovers", async () => {
    injectingFailure = true;
    await page.route("**/__crm/snapshot", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Injected disposable acceptance failure" }),
      }),
    );
    await page.getByRole("button", { name: "Refresh CRM", exact: true }).click();
    await visible(page.getByText("Showing the last loaded records", { exact: true }));
    await visible(page.getByRole("heading", { name: prefix, exact: true }));
    await capture("stale-390");
    await page.unroute("**/__crm/snapshot");
    await page.getByRole("button", { name: "Retry refresh", exact: true }).click();
    await page
      .getByText("Showing the last loaded records", { exact: true })
      .waitFor({ state: "hidden" });
    injectingFailure = false;
  });
  await step("Template edit, version history and explicit company application", async () => {
    await page.goto(new URL("/crm?view=templates", base).href);
    await page.getByLabel("Search workflow templates", { exact: true }).fill("follow-up");
    await page.getByRole("button", { name: "Edit template", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Summary", { exact: true })
      .fill(`Synthetic follow-up checklist ${prefix}`);
    await saveDialog("Save new template version");
    await visible(page.getByText("Version 2", { exact: true }));
    await page.getByRole("button", { name: /Preview and version history/ }).click();
    await visible(page.getByRole("button", { name: /^Version 1 ·/ }));
    await page.getByRole("button", { name: "Apply template", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Record type", { exact: true })
      .selectOption("company");
    await page
      .getByRole("dialog")
      .getByLabel("Apply to record", { exact: true })
      .selectOption(company.id);
    await saveDialog("Create tasks and draft");
    await check(
      (await snapshot()).activities.some(
        (activity) => activity.companyId === company.id && activity.kind === "workflow",
      ),
      "Workflow timeline receipt missing",
    );
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await capture(`templates-${width}`);
    }
  });
  await step("Saved deep links survive reload", async () => {
    await page.goto(
      new URL(`/crm?ref=${encodeURIComponent(`crm:project:${project.id}`)}&tab=delivery`, base)
        .href,
    );
    await visible(page.locator(`[id="crm-project-${project.id}"]`));
    await page.reload();
    await visible(page.locator(`[id="crm-project-${project.id}"]`));
  });
  await check(pageErrors.length === 0, `Browser JavaScript errors: ${pageErrors.join("; ")}`);
  await check(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join("; ")}`);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  failures.push(error instanceof Error ? error.message : String(error));
  await page.screenshot({ path: resolve(out, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ ...report, outputDirectory: out }, null, 2));
}
