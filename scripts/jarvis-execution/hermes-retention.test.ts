import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hermesControlRetentionAdmission } from "./hermes-retention";

test("retention gate refuses synthetic HTTP control before any executor or storage admission", async () => {
  let executions = 0;
  const server = createServer((_req, res) => {
    const admission = hermesControlRetentionAdmission();
    if (!admission.permitted) { res.statusCode = admission.status; res.end(JSON.stringify(admission.body)); return; }
    executions++; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}`, { method: "POST", body: JSON.stringify({ ephemeral: true, noHistory: true }) });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("hermes_retention_unverified");
    expect(executions).toBe(0);
    const source = readFileSync(join(import.meta.dir, "../../vite.config.ts"), "utf8");
    const route = source.slice(source.indexOf("let controlTicket: ExecutionTicket"), source.indexOf("res.setHeader(\"X-Jarvis-Request-Id\""));
    expect(route.indexOf("hermesControlRetentionAdmission()")).toBeLessThan(route.indexOf("controlExecution(__dirname).begin"));
    expect(route).toContain("res.end(JSON.stringify(retention.body))");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
