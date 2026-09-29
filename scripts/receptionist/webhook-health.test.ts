import { expect, test } from "bun:test";
import { inputs, NOW } from "./aggregate.test";
import { buildReceptionistSnapshot as build } from "./aggregate";
import { fetchRetell, probeWebhook } from "./retell";

const HOOK = "https://mu-receptionist.vercel.app/api/retell/webhook";
const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;

test("probe maps endpoint answers to verdicts", async () => {
  expect(await probeWebhook(HOOK, status(401))).toBe("protected");
  expect(await probeWebhook(HOOK, status(403))).toBe("protected");
  expect(await probeWebhook(HOOK, status(200))).toBe("open");
  expect(await probeWebhook(HOOK, status(503))).toBe("unconfigured");
  expect(await probeWebhook(HOOK, status(404))).toBe("unreachable");
  expect(await probeWebhook(HOOK, (async () => { throw new Error("boom"); }) as unknown as typeof fetch)).toBe("unreachable");
});

test("probe never calls a non-https URL and sends no credentials or signature", async () => {
  let called = 0;
  expect(await probeWebhook("http://example.test/hook", (async () => { called++; return new Response("", { status: 401 }); }) as unknown as typeof fetch)).toBe("unreachable");
  expect(await probeWebhook("not a url", status(401))).toBe("unreachable");
  expect(called).toBe(0);
  let headers: Record<string, string> = {};
  await probeWebhook(HOOK, (async (_u: unknown, init: RequestInit) => { headers = init.headers as Record<string, string>; return new Response("", { status: 401 }); }) as unknown as typeof fetch);
  expect(Object.keys(headers).map((h) => h.toLowerCase())).toEqual(["content-type"]);
});

test("fetchRetell reads the agent's actual webhook_url and probes it unsigned", async () => {
  const probed: string[] = [];
  const r = await fetchRetell({
    agentId: "fixture", number: "fixture", providerKey: () => "synthetic", flagCache: new Map(),
    fetch: (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === HOOK) { probed.push(String((init?.headers as Record<string, string>)?.Authorization ?? "none")); return new Response("{}", { status: 401 }); }
      return new Response(JSON.stringify(u.includes("get-agent") ? { version: 0, webhook_url: HOOK } : []));
    }) as typeof fetch,
  });
  expect(probed).toEqual(["none"]);
  expect(r.agent).toMatchObject({ webhook: true, webhookHost: "mu-receptionist.vercel.app", webhookProbe: "protected" });
});

test("health strip: reachable and protected webhook is green", () => {
  const i = inputs();
  if (i.agent.ok) Object.assign(i.agent, { webhook: true, webhookHost: "mu-receptionist.vercel.app", webhookProbe: "protected" });
  const h = build(i, NOW).health.find((x) => x.id === "webhook");
  expect(h).toMatchObject({ tone: "ok", headline: "Webhook connected" });
  expect(h?.detail).toContain("reachable and protected");
  expect(h?.next).toBeUndefined();
});

test("health strip: open, unconfigured and unreachable webhooks are red with a next step", () => {
  for (const probe of ["open", "unconfigured", "unreachable"] as const) {
    const i = inputs();
    if (i.agent.ok) Object.assign(i.agent, { webhook: true, webhookHost: "x.test", webhookProbe: probe });
    const h = build(i, NOW).health.find((x) => x.id === "webhook");
    expect(h?.tone).toBe("bad");
    expect(h?.next).toBeTruthy();
  }
});
