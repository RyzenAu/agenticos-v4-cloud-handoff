import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceptionistService, LINE_CONFIG_KEYS, resolveLine } from "./plugin";
import { formatAuNumber } from "./aggregate";

// Synthetic values only. None of these is a real agent id, number or key.
const CFG_AGENT = "agent_synthetic_config_0001";
const CFG_NUMBER = "+61400000001";
const OPT_AGENT = "agent_synthetic_option_0002";
const OPT_NUMBER = "+61400000002";

const keys = (values: Record<string, string>) => (name: string) => values[name] ?? "";

test("line: explicit options win over runtime config", () => {
  const line = resolveLine({ agentId: OPT_AGENT, number: OPT_NUMBER, providerKey: keys({ [LINE_CONFIG_KEYS.agentId]: CFG_AGENT, [LINE_CONFIG_KEYS.number]: CFG_NUMBER }) });
  expect(line).toEqual({ agentId: OPT_AGENT, number: OPT_NUMBER, lineSource: "options" });
});

test("line: runtime config through providerKey replaces the hard-coded demo line", () => {
  const asked: string[] = [];
  const line = resolveLine({ providerKey: (name) => { asked.push(name); return keys({ [LINE_CONFIG_KEYS.agentId]: ` ${CFG_AGENT} `, [LINE_CONFIG_KEYS.number]: CFG_NUMBER })(name); } });
  expect(line).toEqual({ agentId: CFG_AGENT, number: CFG_NUMBER, lineSource: "config" });
  expect(asked).toEqual([LINE_CONFIG_KEYS.agentId, LINE_CONFIG_KEYS.number]);
});

test("line: a half-configured line never mixes with the demo line; the fallback is labelled", () => {
  const onlyAgent = resolveLine({ providerKey: keys({ [LINE_CONFIG_KEYS.agentId]: CFG_AGENT }) });
  expect(onlyAgent.lineSource).toBe("legacy-demo-default");
  expect(onlyAgent.agentId).not.toBe(CFG_AGENT);
  const none = resolveLine({ providerKey: () => "" });
  expect(none.lineSource).toBe("legacy-demo-default");
  const throwing = resolveLine({ providerKey: () => { throw new Error("config unreadable"); } });
  expect(throwing.lineSource).toBe("legacy-demo-default");
  // Option for one half + config for the other is still an explicit choice.
  expect(resolveLine({ agentId: OPT_AGENT, providerKey: keys({ [LINE_CONFIG_KEYS.number]: CFG_NUMBER }) })).toEqual({ agentId: OPT_AGENT, number: CFG_NUMBER, lineSource: "options" });
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("dashboard service: configured agent id reaches the Retell read, and read time + line source reach the model", async () => {
  const root = mkdtempSync(join(tmpdir(), "rx-plugin-"));
  dirs.push(root);
  const urls: string[] = [];
  // Synthetic fetch: records the URL and fails every request. No network is touched.
  const fetchStub = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response("synthetic failure", { status: 500 });
  }) as unknown as typeof fetch;
  const now = Date.parse("2026-09-27T06:00:00Z");
  const service = createReceptionistService(
    {
      root,
      token: "fixture",
      fetch: fetchStub,
      providerKey: keys({ RETELL_API_KEY: "synthetic-retell-key", [LINE_CONFIG_KEYS.agentId]: CFG_AGENT, [LINE_CONFIG_KEYS.number]: CFG_NUMBER }),
    },
    { now: () => now },
  );
  const d = await service.getDashboard();
  expect(urls.some((u) => u.includes(`/get-agent/${CFG_AGENT}`))).toBe(true);
  expect(urls.some((u) => u.includes("agent_21273200f10cb3694a4cf82112"))).toBe(false);
  // Every Retell read failed and none ever succeeded: a failed block with NO good-read time (RX-7,
  // intended change: it used to carry the failed attempt's time, shown as "Updated just now").
  expect(d.agentReadiness).toMatchObject({ ok: false, asOf: null, stale: true });
  expect(d.channelHealth).toMatchObject({ ok: true, lastOkAt: { retell: null, twilio: null } });
  expect(d.feedRead).toMatchObject({ ok: false, reason: "Agency feed not configured", lastOkAt: null });
  expect(d.channelHealth).toMatchObject({ ok: true, retell: "unknown", twilio: "unknown", webhook: "unknown", asOf: new Date(now).toISOString(), stale: false });
  // No feed configured: exceptions are a failed block, never "0 open".
  expect(d.exceptionSummary).toMatchObject({ ok: false, reason: "Agency feed not configured" });
  // The key never leaks into the model.
  expect(JSON.stringify(d)).not.toContain("synthetic-retell-key");
});

test("snapshot service: the configured line and its source reach the single-tenant snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "rx-plugin-"));
  dirs.push(root);
  const fetchStub = (async () => new Response("synthetic failure", { status: 500 })) as unknown as typeof fetch;
  const service = createReceptionistService(
    { root, receptionistRoot: root, token: "fixture", fetch: fetchStub, providerKey: keys({ [LINE_CONFIG_KEYS.agentId]: CFG_AGENT, [LINE_CONFIG_KEYS.number]: CFG_NUMBER }) },
    { now: () => Date.parse("2026-09-27T06:00:00Z") },
  );
  const s = await service.get();
  expect(s.agent).toMatchObject({ id: CFG_AGENT, number: CFG_NUMBER, lineSource: "config" });
  expect(s.agent.retellUrl).toContain(CFG_AGENT);
});

test("number formatting is generic, not tied to one hard-coded line", () => {
  expect(formatAuNumber(CFG_NUMBER)).toBe("+61 400 000 001");
  expect(formatAuNumber("+15550000000")).toBe("+15550000000");
});
