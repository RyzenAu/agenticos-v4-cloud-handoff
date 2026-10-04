// Actual CodingList browser flow on the synthetic UI server. All shaping/starting is intercepted.
// Usage: bun run scripts/coding/composer.acceptance.ts http://127.0.0.1:4396
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const origin = process.argv[2];
assert(
  origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin),
  "Use the isolated synthetic UI server, never the live OS.",
);
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage();
page.setDefaultTimeout(8000);
let shapes = 0,
  starts = 0;
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const response = (objective: string) => ({
  kind: "draft",
  jobId: "synthetic-job",
  specDigest: "synthetic-digest",
  validation: { ok: true, errors: [], warnings: [] },
  spokenSummary: "Synthetic plan",
  spec: {
    objective,
    repo: {
      repoId: "synthetic-repo",
      baseSha: "0".repeat(40),
      baseRef: "main",
      jobBranch: "coding/synthetic",
    },
    checks: [],
    roles: [],
    doneWhen: [],
  },
});
try {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.route("**/__operator/coding/shape", async (route) => {
    shapes++;
    const request = route.request().postDataJSON().utterance;
    if (request.includes("slow")) await new Promise((r) => setTimeout(r, 700));
    await route.fulfill({ json: response(request) });
  });
  await page.route("**/__operator/coding/jobs", async (route) => {
    if (route.request().method() === "POST") {
      starts++;
      await new Promise((r) => setTimeout(r, 300));
      return route.fulfill({ json: { job: { id: "synthetic-job" } } });
    }
    return route.continue();
  });
  await page.goto(`${origin}/coding`, { waitUntil: "domcontentloaded" });
  const input = page.getByLabel("What should change, and in which repo?");
  await input.fill("Change A in synthetic-repo");
  await page.getByRole("button", { name: "Draft the plan", exact: true }).click();
  await page.getByRole("button", { name: "Start this job", exact: true }).waitFor();
  await input.fill("Change B in synthetic-repo");
  assert.equal(
    await page.getByRole("button", { name: "Start this job", exact: true }).count(),
    0,
    "Editing the request must invalidate the previous plan",
  );
  await page.getByRole("button", { name: "Draft the plan", exact: true }).click();
  await page
    .getByRole("region", { name: "Drafted plan" })
    .getByText("Change B in synthetic-repo", { exact: true })
    .waitFor();
  await input.fill("A slow request in synthetic-repo");
  await page.getByRole("button", { name: "Draft the plan", exact: true }).click();
  await input.fill("The current request in synthetic-repo");
  await page.getByRole("button", { name: "Draft the plan", exact: true }).click();
  await page
    .getByRole("region", { name: "Drafted plan" })
    .getByText("The current request in synthetic-repo", { exact: true })
    .waitFor();
  await page.waitForTimeout(900);
  assert.equal(
    await page
      .getByRole("region", { name: "Drafted plan" })
      .getByText("A slow request in synthetic-repo", { exact: true })
      .count(),
    0,
    "A late response must not replace the current plan",
  );
  assert.equal(starts, 0, "Editing and shaping must not start a job");
  await page.getByRole("button", { name: "Start this job", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Start this job", exact: true }).isDisabled(),
    true,
  );
  await page.waitForURL((url) => url.pathname === "/coding/synthetic-job");
  assert.equal(starts, 1, "Only the current draft may send one intercepted start request");
  const firstHandoff = "First handoff in synthetic-repo";
  const secondHandoff = "Second handoff in synthetic-repo";
  await page.goto(`${origin}/coding?${new URLSearchParams({ request: firstHandoff })}`);
  await page.getByRole("region", { name: "Drafted plan" }).getByText(firstHandoff, { exact: true }).waitFor();
  // Stay on the mounted Coding route, as the command palette/Jarvis does.
  await page.evaluate((request) => window.history.pushState({}, "", `/coding?${new URLSearchParams({ request })}`), secondHandoff);
  await page.waitForFunction((request) => (document.getElementById("coding-request") as HTMLTextAreaElement)?.value === request, secondHandoff);
  await page.getByRole("region", { name: "Drafted plan" }).getByText(secondHandoff, { exact: true }).waitFor();
  assert.equal(starts, 1, "A new handoff may draft, but must not start a job");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      pass: true,
      shapes,
      interceptedStarts: starts,
      agentsLaunched: 0,
      providerCalls: 0,
    checks: ["edit invalidates old plan", "late draft ignored", "current draft starts once", "new handoff replaces the previous composer"],
    }),
  );
} finally {
  await browser.close();
}
