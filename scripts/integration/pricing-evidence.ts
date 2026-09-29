// Rendered pricing evidence for the integration branch (synthetic data only, quiet copy on 4310).
//   bun scripts/integration/pricing-evidence.ts <outDir>
// 1. Real code path, no UI: a synthetic Professional client through buildDashboard, a proposal and an
//    invoice draft through sales-backoffice, and the consistency fixture.
// 2. Rendered: Operations › Package economics with Essential / Professional / Premium selected, on
//    first load and after a cache-bypassing reload; /receptionist with the synthetic dashboard model
//    served by route interception. Exact rendered text goes to <outDir>/rendered.json.
// Never touches 8081, real stores or keys: USERPROFILE/HOME point at an empty temp folder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../receptionist/dashboard";
import type { AgencyFeedState } from "../receptionist/types";
import { draftDir, draftInvoice, draftProposal, invoiceData } from "../leads/sales-backoffice";
import type { Lead } from "../leads/crm";
import { receptionistConsistencyFixture } from "../../src/lib/business-economics";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: bun scripts/integration/pricing-evidence.ts <outDir>");
mkdirSync(OUT, { recursive: true });
const NOW = Date.now();

// ── 1. Real code path ─────────────────────────────────────────────────────────────────────────
const feed: AgencyFeedState = {
  ok: true, generatedAt: new Date(NOW - 5 * 60_000).toISOString(), windowDays: 30, view: "metadata",
  organizations: [{ id: "org_synthetic_1", name: "Synthetic Dental (fictional)", niche: "DENTAL", isDemoTenant: false, inboundNumberMasked: "••• 000" }],
  totals: { calls: 480, completed: 470, failed: 10, avgDurationSeconds: 150, totalMinutes: 1200, byOutcome: [{ name: "booked", count: 200 }], bySentiment: [], qaGraded: 0, qaFlagged: 0, qaCriticalOpen: 0, triagePending: 0, triageDone: 0, oldestPendingTriageAt: null },
  calls: [], followUps: [],
  clients: [{
    organizationId: "org_synthetic_1", slug: "synthetic-dental", isDemoTenant: false,
    bookings: { byStatus: { CONFIRMED: 200 }, total: 200, madeOnCalls: 200, sandbox: 0, upcoming: 20 },
    handoffs: { transfersByStatus: {}, alertsByReason: { NEW_BOOKING: 200 }, alertsByStatus: { SENT: 200 } },
    minutesThisMonth: { monthStart: new Date(NOW - 20 * 86_400_000).toISOString(), calls: 480, callMinutes: 1200, billableMinutesCurrentPeriod: 1200 },
    readiness: { agentMapped: true, inboundNumberSet: true, calendarRequested: "GOOGLE", calendarInUse: "GOOGLE", calendarReason: "configured", liveCalendar: true, demoDiaryConfirmed: false, bookingOutcome: "confirmed", alertMailboxSet: true, transferEnabled: false, smsEnabled: false, retentionDays: 90, retellRetentionAligned: "unverified" },
  }],
  deployment: { retellWebhookSecretSet: true, alertEmailChannelLive: true, cronSecretValid: true, trustProxyHeaders: true, transferExecutionEnabled: false },
} as AgencyFeedState;
const agent = { ok: true as const, name: "Synthetic Agent", voice: "voice-x", language: "en-AU", model: "model-x", published: true, webhook: true, webhookHost: "rx.example.test", webhookProbe: "protected" as const, modified: new Date(NOW - 3 * 86_400_000).toISOString(), prompt000: true, disclosure: true, recording: true, overseas: true, transfer: false, promptKnown: true, version: 3, llmVersion: 5 };
const model = buildDashboard({
  now: NOW, providersReadAt: NOW, feed, agent,
  numberFacts: { ok: true, attached: true, version: 3, sms: false },
  twilio: { ok: true, connected: true, trunkSid: "TK_synthetic", balanceUsd: 42, month: { ok: true, usd: 1, balanceUsd: 42 } },
  clientPackages: { "synthetic-dental": "receptionist-professional" },
});
writeFileSync(join(OUT, "synthetic-dashboard-model.json"), JSON.stringify(model, null, 2));

const draftRoot = mkdtempSync(join(tmpdir(), "mu-pricing-drafts-"));
const lead = { id: 901, pitch: "receptionist", name: "Synthetic Dental Pty Ltd (fictional)" } as Lead;
const issued = new Date("2026-09-28T00:00:00Z");
draftProposal(draftRoot, lead, "receptionist-professional");
draftInvoice(draftRoot, lead, issued, "receptionist-professional");
const draftFolder = draftDir(draftRoot, lead.id);
const proposal = readFileSync(join(draftFolder, "proposal.md"), "utf8");
const invoice = readFileSync(join(draftFolder, "deposit-invoice.md"), "utf8");
writeFileSync(join(OUT, "proposal-professional.md"), proposal);
writeFileSync(join(OUT, "invoice-professional.md"), invoice);
rmSync(draftRoot, { recursive: true, force: true });
const inv = invoiceData(lead, issued, "receptionist-professional");
const fixture = receptionistConsistencyFixture();
const codePath = {
  dashboardCommercial: model.commercial,
  dashboardClients: (model as unknown as { clients: unknown }).clients,
  invoiceDraft: { lines: inv.lines, notInvoiced: inv.notInvoiced, subtotal: inv.subtotal, gst: inv.gst, total: inv.total },
  fixture: { packageId: fixture.customer.packageId, billableMinutes: fixture.usage.billableMinutes, lines: fixture.expectedInvoice.lines, totals: fixture.expectedInvoice.totals, setupFee: fixture.expectedInvoice.setupFee, transfers: fixture.usage.transfers },
};
writeFileSync(join(OUT, "code-path.json"), JSON.stringify(codePath, null, 2));
console.log("code path written");

// ── 2. Rendered ───────────────────────────────────────────────────────────────────────────────
const { chromium } = await import("file:///C:/Users/Nebula%20PC/source/repos/AgenticOS-v4/node_modules/playwright-core/index.mjs");
const WT = join(import.meta.dir, "..", "..");
const home = mkdtempSync(join(tmpdir(), "mu-synthetic-home-"));
const env = { ...process.env, ARGENTIC_PREVIEW: "1", AGENTIC_OS_NO_BACKGROUND: "1", USERPROFILE: home, HOME: home };
const server = Bun.spawn([process.execPath, "--bun", "node_modules/vite/bin/vite.js", "dev", "--port", "4310", "--strictPort", "--host", "127.0.0.1"], { cwd: WT, env, stdout: "ignore", stderr: "ignore" });
const BASE = "http://127.0.0.1:4310";
for (;;) { try { await (await fetch(`${BASE}/today`, { signal: AbortSignal.timeout(120_000) })).text(); break; } catch { await Bun.sleep(400); } }
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const rendered: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e).slice(0, 200)));
  const workbench = async (label: string) => {
    const w = page.locator(".economics-workbench");
    await w.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(600);
    const snap = await w.evaluate((el: HTMLElement) => {
      const val = (label: string) => [...el.querySelectorAll("label.economics-field")].find((l) => l.querySelector("span")?.textContent?.startsWith(label))?.querySelector("input")?.value ?? null;
      const dd = (dt: string) => [...el.querySelectorAll(".economics-results > div")].find((d) => d.querySelector("dt")?.textContent?.startsWith(dt))?.querySelector("dd")?.textContent ?? null;
      const gstBox = [...el.querySelectorAll("label.economics-actions")].find((l) => /GST/.test(l.textContent ?? ""));
      return {
        package: (el.querySelector("select") as HTMLSelectElement | null)?.selectedOptions[0]?.textContent ?? null,
        status: [...el.querySelectorAll(".economics-status li")].map((li) => li.textContent?.trim()),
        fields: { monthly: val("Monthly price"), setup: val("Setup fee"), included: val("Included minutes"), overage: val("Overage / minute") },
        fieldLabels: [...el.querySelectorAll("label.economics-field > span")].slice(0, 4).map((s) => s.textContent),
        gst: { label: gstBox?.textContent?.trim() ?? null, checked: (gstBox?.querySelector("input") as HTMLInputElement | null)?.checked ?? null },
        revenueExGst: dd("Revenue excluding GST"),
        setupHeading: [...el.querySelectorAll("h3")].map((h) => h.textContent).find((t) => /^Setup/.test(t ?? "")) ?? null,
        setupFirstRow: [...el.querySelectorAll(".economics-results")].at(-1)?.querySelector("dt")?.textContent ?? null,
        // Stale figures/wording as whole tokens (with context); a computed value such as "1,549" is not a price.
        staleHits: [...(el.textContent ?? "").matchAll(/(?<![\d,.$])(549|1\.10)(?![\d,])|\b300 min|GST-inclusive if registered|No price is approved|No catalogue entry is approved/g)].map((m) => (el.textContent ?? "").slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 20)),
        broad549: [...(el.textContent ?? "").matchAll(/\b549\b/g)].map((m) => (el.textContent ?? "").slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 20)),
      };
    });
    rendered[label] = snap;
    await page.screenshot({ path: join(OUT, `operations-${label}.png`), fullPage: false });
    return snap;
  };
  await page.goto(`${BASE}/operations`, { waitUntil: "commit" });
  await workbench("initial");
  for (const [id, label] of [["receptionist-professional", "professional"], ["receptionist-premium", "premium"], ["receptionist-essential", "essential"]] as const) {
    await page.locator(".economics-workbench select").first().selectOption(id);
    await workbench(label);
  }
  // Draft JSON as rendered for Essential.
  await page.getByRole("button", { name: "View draft details" }).click();
  const draftJson = await page.locator('textarea[aria-label="Draft proposal JSON"]').inputValue();
  const parsed = JSON.parse(draftJson);
  rendered.draftJson = { notice: parsed.notice, status: parsed.proposal?.pricing?.status, setupStatus: parsed.proposal?.pricing?.setupStatus, monthlyCents: parsed.proposal?.pricing?.monthly?.cents, setupCents: parsed.proposal?.pricing?.setup?.cents };
  // Hard refresh: cache disabled, reload.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.reload({ waitUntil: "commit" });
  await workbench("after-hard-refresh");
  // Receptionist with the synthetic model.
  const r = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  await r.route("**/__receptionist/dashboard", (route: { fulfill: (o: unknown) => Promise<void> }) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...model, generatedAt: new Date().toISOString() }) }));
  await r.goto(`${BASE}/receptionist`, { waitUntil: "commit" });
  await r.getByText("Commercial", { exact: true }).first().waitFor({ timeout: 60_000 });
  await r.waitForTimeout(1200);
  rendered.receptionist = await r.evaluate(() => {
    const label = [...document.querySelectorAll("p")].find((p) => p.textContent?.trim() === "Commercial");
    const block = label?.parentElement;
    return { commercialBlock: block?.textContent?.replace(/\s+/g, " ").trim() ?? null, overviewMrr: [...document.querySelectorAll(".sh-signal")].find((t) => /MRR/.test(t.textContent ?? ""))?.textContent?.replace(/\s+/g, " ").trim() ?? null };
  });
  await r.locator("text=Usage & economics").first().scrollIntoViewIfNeeded().catch(() => {});
  await r.screenshot({ path: join(OUT, "receptionist-commercial-synthetic.png"), fullPage: false });
  rendered.pageErrors = errors;
} finally {
  await browser.close();
  Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(server.pid)]);
  rmSync(home, { recursive: true, force: true });
}
writeFileSync(join(OUT, "rendered.json"), JSON.stringify(rendered, null, 2));
console.log(JSON.stringify(rendered, null, 2));
process.exit(0);
