import { describe, expect, test } from "bun:test";
import { JEV_MODEL, JEV_SURFACES, JEV_URL, jevAnswers, jevDecide } from "./jev-client";
import { catalogueModel } from "./model-router/catalogue";
import { MemoryHealthStore } from "./model-router/health";
import { MemoryReceiptSink } from "./model-router/receipts";

const QUESTIONS = { lane: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } } };
const answer = (status = 200) => new Response(JSON.stringify({ answers: { lane: { type: "choice", choice: "a", confidence: 0.93 } } }), { status });

function scripted(replies: Array<() => Response | Promise<Response>>) {
  const calls: { url: string; body: any; auth: string }[] = [];
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    return next();
  }) as unknown as typeof fetch;
  return { calls, request };
}
const base = () => ({ key: "jev-fixture", state: { utterance: "open inbox" }, questions: QUESTIONS, sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), sleep: async () => {} });

describe("the one Jev client", () => {
  test("model id comes from the catalogue; one POST; a receipt with the HTTP status", async () => {
    expect(JEV_MODEL).toBe(catalogueModel("typesafe/jev-latest").providerModel);
    const { calls, request } = scripted([() => answer()]);
    const b = base();
    const out = await jevDecide({ ...b, surface: "voice.reflex", request, caller: "scripts/jev.ts" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.answers.lane.choice).toBe("a");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(JEV_URL);
    expect(calls[0].body).toEqual({ model: JEV_MODEL, state: { utterance: "open inbox" }, questions: QUESTIONS });
    expect(b.sink.receipts).toHaveLength(1);
    expect(b.sink.receipts[0]).toMatchObject({ task: "jev.decision", caller: "scripts/jev.ts (voice.reflex)", provider: "typesafe", model: "typesafe/jev-latest", route: "metered", outcome: "succeeded", httpStatus: 200 });
    // Metadata only: never the utterance or the key.
    expect(JSON.stringify(b.sink.receipts[0])).not.toContain("open inbox");
    expect(JSON.stringify(b.sink.receipts[0])).not.toContain("jev-fixture");
  });

  test("429 then 200: one bounded retry inside the budget", async () => {
    const { calls, request } = scripted([() => new Response("{}", { status: 429, headers: { "retry-after": "0" } }), () => answer()]);
    const b = base();
    const out = await jevDecide({ ...b, surface: "inbox.triage", request });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(b.sink.receipts.map((r) => [r.outcome, r.httpStatus])).toEqual([["succeeded", 200]]);
  });

  test("5xx beyond the retry count fails with the status recorded; the caller gets null and uses its rules", async () => {
    const { calls, request } = scripted([() => new Response("{}", { status: 503 }), () => new Response("{}", { status: 503 }), () => new Response("{}", { status: 503 })]);
    const b = base();
    const out = await jevDecide({ ...b, surface: "voice.router", request });
    expect(out).toMatchObject({ ok: false, reason: "http", httpStatus: 503 });
    expect(calls).toHaveLength(1 + JEV_SURFACES["voice.router"].retries);
    // The failed attempt with its status, then the router's exhaustion record (Jev has no free substitute).
    expect(b.sink.receipts.map((r) => [r.outcome, r.errorCode, r.httpStatus])).toEqual([
      ["failed", "unavailable", 503],
      ["exhausted_free", "no_eligible_model", null],
    ]);
    expect(await jevAnswers({ ...base(), surface: "voice.router", request: scripted([() => new Response("{}", { status: 400 })]).request })).toBeNull();
  });

  test("a 400 is never retried", async () => {
    const { calls, request } = scripted([() => new Response("{}", { status: 400 }), () => answer()]);
    const out = await jevDecide({ ...base(), surface: "inbox.triage", request });
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("TypeSafe 529 overload recovers within the existing retry budget", async () => {
    const { calls, request } = scripted([() => new Response("{}", { status: 529 }), () => answer()]);
    const out = await jevDecide({ ...base(), surface: "voice.router", request });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("a retry never runs past the surface budget", async () => {
    let now = 0;
    const { calls, request } = scripted([
      () => {
        now += 1400;
        return new Response("{}", { status: 503 });
      },
      () => answer(),
    ]);
    const out = await jevDecide({ ...base(), surface: "voice.reflex", request, clock: () => now });
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("the guardian surface is receipted as approval.guardian", async () => {
    const b = base();
    await jevDecide({ ...b, surface: "hermes.guardian", request: scripted([() => answer()]).request });
    expect(b.sink.receipts[0].task).toBe("approval.guardian");
  });

  test("no key: no call and no receipt", async () => {
    const { calls, request } = scripted([() => answer()]);
    const b = base();
    const out = await jevDecide({ ...b, key: "", surface: "voice.reflex", request });
    expect(out).toMatchObject({ ok: false, reason: "no-key" });
    expect(calls).toHaveLength(0);
    expect(b.sink.receipts).toHaveLength(0);
  });

  test("an unreadable reply is a failure, not an empty decision", async () => {
    const out = await jevDecide({ ...base(), surface: "bench", request: scripted([() => new Response("{\"nope\":1}", { status: 200 })]).request });
    expect(out).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("an invalid decision is receipted as failed without retry or exposed content", async () => {
    const b = base();
    const { calls, request } = scripted([() => Response.json({ answers: { lane: { choice: "unasked-secret-value", confidence: 5 } } })]);
    const out = await jevDecide({ ...b, surface: "voice.router", request });
    expect(out).toMatchObject({ ok: false, reason: "unreadable", httpStatus: 200 });
    expect(calls).toHaveLength(1);
    expect(b.sink.receipts.some((r) => r.outcome === "succeeded")).toBe(false);
    expect(JSON.stringify(b.sink.receipts)).not.toContain("unasked-secret-value");
  });
});
