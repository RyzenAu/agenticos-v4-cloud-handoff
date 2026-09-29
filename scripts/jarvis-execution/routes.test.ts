import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { operatorPlugin } from "../operator-plugin";
import { configureIdentity } from "../identity/principal";
import { syntheticTailnetForTests } from "../remote-access";
import { controlExecution } from "./runtime";
import { modelFleetReceiptSink } from "../model-fleet/receipt-sink";
import { jarvisTaskPrompt, listExecutionReceipts, readExecutionReceipt, cancelExecutionReceipt, runHermesTask, runControlTask } from "../../src/lib/jarvis-control";

process.env.AGENTIC_OS_NO_CODEX = "1";
process.env.AGENTIC_OS_TAILNET_NAME = "synthetic.test.ts.net";
// This test drives the real execution runtime, which a quiet copy (AGENTIC_OS_NO_BACKGROUND=1) refuses to
// construct (runtime.ts, audit A-L5). Pin the flag off for this file, whatever the shell running the suite set.
let quietBefore: string | undefined;
beforeAll(() => { quietBefore = process.env.AGENTIC_OS_NO_BACKGROUND; delete process.env.AGENTIC_OS_NO_BACKGROUND; });
afterAll(() => { if (quietBefore === undefined) delete process.env.AGENTIC_OS_NO_BACKGROUND; else process.env.AGENTIC_OS_NO_BACKGROUND = quietBefore; });
test("actual operator registration HTTP auth/list/read/cancel/privacy and client reconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-routes-synthetic-"));
  const token = "synthetic-page-token";
  mkdirSync(join(root, "fake-home"));
  mkdirSync(join(root, ".operator-data"));
  // A founder signed in over Tailscale (Stage B1: only people.json founders resolve to a principal).
  writeFileSync(join(root, ".operator-data", "people.json"), JSON.stringify({ people: [{ name: "Mehroz", tailscale: ["synthetic@example.test"] }] }));
  // Tailscale Serve simulated over this test's loopback socket (REVIEW-S1 F2a: the real server only
  // believes the headers when the socket's peer is tailscaled; identity/serve-peer.ts).
  // `tailscale status` simulated too: the hub owns 100.64.0.1, so Mehroz's 100.64.0.12 is another node (REVIEW-S1 R2-1).
  configureIdentity({ root, servePeer: () => true, tailnet: syntheticTailnetForTests("synthetic.test.ts.net", ["100.64.0.1"]) });
  const plugin = operatorPlugin({ root, token, memoryHome: join(root, "fake-home") });
  let middleware: any;
  (plugin.configureServer as any)({ middlewares: { use: (_: string, fn: any) => { middleware = fn; } } });
  const server = createServer((req, res) => {
    if (req.url === "/__token") { res.end(JSON.stringify({ token })); return; }
    if (req.url?.startsWith("/__operator")) req.url = req.url.slice("/__operator".length);
    middleware(req, res, () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = ((url: any, init: any) => fetch(base + url, init)) as typeof fetch;
  const runtime = controlExecution(root);
  modelFleetReceiptSink(root)({ model: "deepseek-v4.1-flash", provider: "cline", providerModel: "cline-free/deepseek-v4.1-flash",
    outcome: "succeeded", elapsedMs: 1, contextTrimmed: false, fallback: "none", usage: { inputTokens: 1, outputTokens: 1, costUsd: null } });
  const binding = { requestId: randomUUID(), task: "Show synthetic task list" };
  const admission = runtime.begin(binding, jarvisTaskPrompt(binding.task));
  if (!admission.admitted) throw new Error("admission");
  try {
    const fleetUrl = base + "/__operator/model-fleet/receipts?limit=50";
    expect((await fetch(fleetUrl)).status).toBe(403);
    const fleet = await fetch(fleetUrl, { headers: { "X-Claude-OS-Token": token } });
    expect(fleet.status).toBe(200);
    const fleetBody = await fleet.json();
    expect(fleetBody.receipts).toHaveLength(1);
    expect(fleetBody.receipts[0].costUsd).toBeNull();
    expect(fleetBody.receipts[0].model).toBe("deepseek-v4.1-flash");
    expect(fleetBody).toMatchObject({ noRecorderFailuresSince: fleetBody.since, spendIsLowerBound: false, recorder: { failures: 0, lastFailureReason: null } });
    // Quarantine state/recovery ride the same registration and page-token check.
    const quarantineUrl = base + "/__operator/control/quarantine";
    expect((await fetch(quarantineUrl)).status).toBe(403);
    const quarantine = await fetch(quarantineUrl, { headers: { "X-Claude-OS-Token": token } });
    expect(quarantine.status).toBe(200);
    expect((await quarantine.json()).quarantine).toMatchObject({ quarantined: false, jobs: [] });
    expect((await fetch(quarantineUrl + "/recover", { method: "POST", headers: { "X-Claude-OS-Token": token, "Content-Type": "application/json" }, body: "{}" })).status).toBe(409);
    expect((await fetch(quarantineUrl + "/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(fleetUrl, { headers: { Host: "synthetic.test.ts.net", "Tailscale-User-Login": "synthetic@example.test", "X-Forwarded-For": "100.64.0.12", "X-Claude-OS-Token": token } })).status).toBe(403);
    for (const path of ["", `/${binding.requestId}`]) {
      expect((await fetch(base + "/__operator/control/jobs" + path)).status).toBe(403);
      expect((await fetch(base + "/__operator/control/jobs" + path, { headers: { "X-Claude-OS-Token": "wrong" } })).status).toBe(403);
    }
    const rows = await listExecutionReceipts({ fetch: request });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["id", "digest", "tier", "status", "evidence", "usageMicrousd"].sort());
    expect(JSON.stringify(rows)).not.toContain(binding.task);
    expect((await readExecutionReceipt(binding.requestId, { fetch: request }))?.status).toBe("running");
    expect(await readExecutionReceipt(randomUUID(), { fetch: request })).toBeNull();
    expect((await fetch(base + "/__operator/control/jobs?limit=101", { headers: { "X-Claude-OS-Token": token } })).status).toBe(400);
    for (const path of ["", `/${binding.requestId}`, `/${binding.requestId}/cancel`]) {
      expect((await fetch(base + "/__operator/control/jobs" + path, {
        method: path.endsWith("cancel") ? "POST" : "GET",
        headers: { Host: "synthetic.test.ts.net", "Tailscale-User-Login": "synthetic@example.test", "X-Forwarded-For": "100.64.0.12", "X-Claude-OS-Token": token, "Content-Type": "application/json" },
        ...(path.endsWith("cancel") ? { body: "{}" } : {}),
      })).status).toBe(403);
    }
    const cancelUrl = base + `/__operator/control/jobs/${binding.requestId}/cancel`;
    expect((await fetch(cancelUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(cancelUrl, { method: "POST", headers: { "X-Claude-OS-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ owner: randomUUID(), permitted: true }) })).status).toBe(400);
    let receipts = 0;
    const report = await runHermesTask(binding.task, { signal: new AbortController().signal, session: {}, requestId: binding.requestId, fetch: request, onReceipt: () => receipts++ });
    expect(report).toContain("not repeated"); expect(receipts).toBe(1);
    const result = await runControlTask(binding.task, { signal: new AbortController().signal, session: {}, approval: null, requestId: binding.requestId, fetch: request });
    expect(result.kind).toBe("result");
    if (result.kind === "result") { expect(result.requestId).toBe(binding.requestId); expect(result.receipt?.status).toBe("running"); expect(result.outcome).toBe("unverified"); }
    expect(runHermesTask("Different task", { signal: new AbortController().signal, session: {}, requestId: binding.requestId, fetch: request })).rejects.toThrow("different task");
    const cancel = await cancelExecutionReceipt(binding.requestId, { fetch: request });
    expect(cancel.cancelRequested).toBe(true); expect(cancel.receipt.status).toBe("running");
    admission.ticket.finish({ ok: true });
    expect((await admission.ticket.completion).status).toBe("cancelled");
    expect((await cancelExecutionReceipt(binding.requestId, { fetch: request })).cancelRequested).toBe(false);
  } finally {
    configureIdentity(undefined);
    admission.ticket.finish({ ok: false }); await admission.ticket.completion;
    runtime.close(); (plugin.closeBundle as any)?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
