import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Database } from "bun:sqlite";
import { fetchRetell } from "./retell";
import { fetchTwilio } from "./twilio";
import { createSummaries } from "./summaries";
import { readEvals, readLegalTemplate } from "./evals";
import { readLeads } from "./commercial";
import { createReceptionistService, receptionistMiddleware } from "./plugin";
import { inputs, NOW } from "./aggregate.test";
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "receptionist-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
test("Retell projects safe fields, reads modern inbound routing and paginates", async () => {
  const requests: { url: string; body: any }[] = [];
  const request = (async (url: any, init: any) => {
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeDefined();
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), body });
    if (String(url).includes("/get-agent/"))
      return response({
        agent_name: "Fixture",
        is_published: true,
        response_engine: { llm_id: "llm_fixture" },
      });
    if (String(url).includes("/get-retell-llm/"))
      return response({
        general_prompt: "AI virtual assistant recording overseas APP 8 call 000",
        general_tools: [{ type: "transfer_call" }],
      });
    if (String(url).endsWith("/list-phone-numbers"))
      return response([
        {
          phone_number: "+61485011208",
          inbound_agents: [{ agent_id: "fixture", agent_version: 4 }],
          custom_sms_enabled: false,
        },
      ]);
    expect(init.method).toBe("POST");
    expect(body.filter_criteria).toEqual({ agent_id: ["fixture"] });
    return response(
      Array.from({ length: body.pagination_key ? 1 : 1000 }, (_, n) => ({
        call_id: body.pagination_key ? "last" : String(n),
        call_status: "ended",
        call_type: "phone_call",
        from_number: "+61412345208",
        duration_ms: 183000,
        call_cost: { combined_cost: 42.95 },
        transcript_object: [
          { role: "agent", content: "I am an AI assistant. I'll text you. PRIVATE_327" },
        ],
      })),
    );
  }) as typeof fetch;
  const r = await fetchRetell({
    providerKey: () => "synthetic-only",
    fetch: request,
    agentId: "fixture",
    number: "+61485011208",
    flagCache: new Map(),
  });
  expect(r.calls.ok && r.calls.rows.length).toBe(1001);
  expect(r.number).toMatchObject({ ok: true, attached: true, version: 4, sms: false });
  expect(r.agent).toMatchObject({
    ok: true,
    prompt000: true,
    recording: true,
    overseas: true,
    transfer: true,
  });
  expect(JSON.stringify(r)).not.toContain("PRIVATE_327");
  expect(JSON.stringify(r)).not.toContain("synthetic-only");
  expect(requests.filter((r) => r.body).at(-1)?.body.pagination_key).toBe("999");
  if (r.calls.ok)
    expect(r.calls.rows[0]).toMatchObject({
      from: "••• 208",
      usdCents: 42.95,
      flags: ["SMS_PROMISE"],
      checked: true,
    });
});
test("provider errors never reflect payloads or exception messages", async () => {
  for (const request of [
    async () => response({ message: "sensitive-fixture" }, 401),
    async () => {
      throw new Error("sensitive-fixture");
    },
  ]) {
    const r = await fetchRetell({
      providerKey: () => "fake",
      fetch: request as typeof fetch,
      agentId: "fixture",
      number: "fixture",
      flagCache: new Map(),
    });
    expect(r.calls.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sensitive-fixture");
  }
});
test("Twilio GET-only routing and whole-account spend", async () => {
  const request = (async (url: any, init: any) => {
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeDefined();
    const u = String(url);
    if (u.endsWith("/Trunks"))
      return response({
        trunks: [{ sid: "trunk_fixture", domain_name: "mu-retell.pstn.twilio.com" }],
      });
    if (u.endsWith("/OriginationUrls"))
      return response({ origination_urls: [{ sip_url: "sip:sip.retellai.com", enabled: true }] });
    if (u.endsWith("/PhoneNumbers"))
      return response({ phone_numbers: [{ phone_number: "+61485011208" }] });
    if (u.endsWith("/Balance.json")) return response({ balance: "11.726", currency: "USD" });
    return response({ usage_records: [{ price: "8.274" }] });
  }) as typeof fetch;
  const r = await fetchTwilio({
    providerKey: () => "fake",
    fetch: request,
    number: "+61485011208",
  });
  expect(r).toMatchObject({
    ok: true,
    connected: true,
    balanceUsd: 11.726,
    month: { ok: true, usd: 8.274 },
  });
});
test("summary failure cached six hours and persisted with PII stripped", async () => {
  const root = temp();
  let count = 0,
    now = NOW;
  const mimo = (async () => {
    count++;
    throw Error("never reflected");
  }) as any;
  const options = { enabled: true, mimo, now: () => now };
  const summarize = createSummaries(root, options);
  const line = await summarize(
    "call",
    "Call +61 412 345 678 or demo@example.test. Another sentence.",
  );
  expect(line?.source).toBe("first-sentence");
  await summarize("call", "changed");
  expect(count).toBe(1);
  const disk = readFileSync(join(root, ".operator-data/receptionist-summaries.json"), "utf8");
  expect(disk).not.toContain("345 678");
  expect(disk).not.toContain("demo@example");
  await createSummaries(root, options)("call", "changed");
  expect(count).toBe(1);
  now += 6 * 3600_000;
  await summarize("call", "New summary.");
  expect(count).toBe(2);
});
test("MiMo gets only analysis summary, bounded output and caches successful line", async () => {
  const root = temp();
  let count = 0;
  const summarize = createSummaries(root, {
    enabled: true,
    mimo: (async (o: any) => {
      count++;
      expect(o.task).toBe("receptionist-summary");
      expect(o.maxTokens).toBe(60);
      expect(o.messages[1].content).toBe("Asked about hours.");
      return { text: "Caller asked about opening hours." };
    }) as any,
  });
  expect((await summarize("one", "Asked about hours."))?.source).toBe("mimo");
  await summarize("one", "Changed");
  expect(count).toBe(1);
});
test("eval reports and LEGAL literal distinguish missing and unknown", () => {
  const root = temp();
  expect(readEvals(root).ok).toBe(false);
  expect(readLegalTemplate(root)).toBe("unknown");
  mkdirSync(join(root, "reports/evals"), { recursive: true });
  writeFileSync(
    join(root, "reports/evals/dental-2026-09-25.md"),
    "**Result: 18/20 scenario checks passed**",
  );
  writeFileSync(
    join(root, "reports/evals/legal-2026-09-26.md"),
    "**Result: 10/10 scenario checks passed**",
  );
  expect(readEvals(root)).toEqual({
    ok: true,
    date: "2026-09-26",
    reports: 1,
    passed: 10,
    total: 10,
  });
  mkdirSync(join(root, "src/lib/buildmaster"), { recursive: true });
  const file = join(root, "src/lib/buildmaster/client-profile.ts");
  writeFileSync(file, "const SUPPORTED_NICHES = ['DENTAL']; // 'LEGAL'");
  expect(readLegalTemplate(root)).toBe("missing");
  writeFileSync(file, "const SUPPORTED_NICHES = ['DENTAL', 'LEGAL'];");
  expect(readLegalTemplate(root)).toBe("present");
});
test("CRM read-only filtering and all empty buckets", () => {
  const file = join(temp(), "crm.sqlite");
  expect(readLeads(file)).toEqual({ ok: false, reason: "CRM not found" });
  const db = new Database(file);
  db.exec("CREATE TABLE leads(status TEXT,pitch TEXT,excluded INTEGER,merged_into TEXT)");
  for (const row of [
    ["new", "receptionist", 0, null],
    ["won", "both", 0, null],
    ["new", "website", 0, null],
    ["new", "both", 1, null],
    ["new", "both", 0, "duplicate"],
  ])
    db.query("INSERT INTO leads VALUES(?,?,?,?)").run(...row);
  db.close();
  const result = readLeads(file);
  expect(result.ok && result.total).toBe(2);
  expect(result.ok && result.byStage.map((s) => s.count)).toEqual([1, 0, 0, 0, 0, 1, 0]);
});
test("snapshot cache shares builds, expires at 60 seconds and sign-offs persist", async () => {
  const root = temp();
  let count = 0,
    now = NOW;
  const service = createReceptionistService(
    { root, token: "fixture", providerKey: () => "" },
    {
      now: () => now,
      load: async () => {
        count++;
        return inputs();
      },
    },
  );
  const [a, b] = await Promise.all([service.get(), service.get()]);
  expect(a).toBe(b);
  expect(count).toBe(1);
  await service.get();
  expect(count).toBe(1);
  now += 60_000;
  await service.get();
  expect(count).toBe(2);
  await service.refresh();
  expect(count).toBe(3);
  // RX-5: the signer is the server-supplied verified name; the body `by` is ignored.
  const s = await service.saveReadiness({ id: "compliance", done: true, by: "Forged" }, "Owner");
  // UI-truth H5: the fixture prompt lacks recording consent and APP 8 wording, so the sign-off is
  // recorded but cannot pass the gate (it used to turn it done on the signature alone).
  expect(s.readiness.blockers[2]).toMatchObject({ done: false, state: "evidence-missing", signedOff: { by: "Owner" } });
  expect(
    JSON.parse(readFileSync(join(root, ".operator-data/receptionist-readiness.json"), "utf8"))
      .compliance.by,
  ).toBe("Owner");
});
test("middleware protects writes, loopback, body size and derived blockers", async () => {
  const root = temp();
  const service = createReceptionistService(
    { root, token: "fixture", providerKey: () => "" },
    { load: async () => inputs() },
  );
  async function request(
    method: string,
    url: string,
    body = "",
    token?: string,
    address = "127.0.0.1",
  ) {
    const req = Object.assign(new EventEmitter(), {
      method,
      url,
      // A browser at this PC always sends a local Host (Stage B1 refuses an empty one).
      headers: { host: "127.0.0.1:8081", ...(token ? { "x-claude-os-token": token } : {}) },
      socket: { remoteAddress: address },
    });
    let status = 0;
    const headers: Record<string, string> = {};
    const done = new Promise<any>((resolve) => {
      const res = {
        set statusCode(n: number) {
          status = n;
        },
        setHeader: (k: string, v: string) => (headers[k] = v),
        end: (s: string) => resolve({ status, body: JSON.parse(s), headers }),
      };
      receptionistMiddleware(service, "fixture")(req as any, res as any, () =>
        resolve({ status: 404 }),
      );
    });
    req.emit("data", Buffer.from(body));
    req.emit("end");
    return done;
  }
  expect((await request("GET", "/", "", "", "10.0.0.1")).status).toBe(403);
  expect((await request("POST", "/refresh")).status).toBe(403);
  expect(
    (
      await request(
        "POST",
        "/readiness",
        JSON.stringify({ id: "no-false-actions", done: true, by: "Owner" }),
        "fixture",
      )
    ).status,
  ).toBe(400);
  expect((await request("POST", "/readiness", "x".repeat(4097), "fixture")).status).toBe(413);
  const ask = await request("GET", "/ask");
  expect(ask.status).toBe(200);
  expect(ask.body.said).toContain("Answering on");
  expect(ask.headers["Cache-Control"]).toBe("no-store");
});
