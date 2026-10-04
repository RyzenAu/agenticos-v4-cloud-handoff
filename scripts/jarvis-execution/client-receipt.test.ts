import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf } from "./journal";
import { runHermesTask, listExecutionReceipts, ReceiptUnavailable } from "../../src/lib/jarvis-control";

test("CLI duplicate 409 returns its durable receipt and stable request ID without resubmission", async () => {
  const id = randomUUID(), task = "Show synthetic task list";
  const receipt = { id, digest: digestOf(task), tier: "read-only", status: "running", evidence: null, usageMicrousd: null };
  let dispatches = 0, callbackId = "", callbackReceipt: unknown;
  const request = (async (url: any, init: any) => {
    if (url === "/__token") return Response.json({ token: "synthetic-token" });
    if (String(url).includes("/control/jobs/")) return Response.json({ error: "missing" }, { status: 404 });
    if (url === "/__operator/hermes/task") return Response.json({}, { status: 503 });
    expect(url).toBe("/__hermes_chat");
    dispatches++;
    expect(JSON.parse(init.body).control.requestId).toBe(id);
    return Response.json({ receipt }, { status: 409 });
  }) as typeof fetch;
  const report = await runHermesTask(task, { signal: new AbortController().signal, session: {}, requestId: id, fetch: request,
    onRequestId: (value) => callbackId = value, onReceipt: (value) => callbackReceipt = value });
  expect(report).toContain("running"); expect(report).toContain("not repeated");
  expect(report).not.toContain("Nothing was done");
  expect(dispatches).toBe(1); expect(callbackId).toBe(id); expect(callbackReceipt).toEqual(receipt);
});
test("preview without operator routes reports unavailable rather than an empty live ledger", async () => {
  for (const reply of [new Response("", { status: 404 }), new Response("<html>preview</html>", { status: 200 })]) {
    const request = (async (url: any) => url === "/__token" ? Response.json({ token: "synthetic" }) : reply) as typeof fetch;
    await expect(listExecutionReceipts({ fetch: request })).rejects.toBeInstanceOf(ReceiptUnavailable);
  }
});
