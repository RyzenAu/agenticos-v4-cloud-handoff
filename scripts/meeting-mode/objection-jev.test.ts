import { describe, expect, test } from "bun:test";
import { classifyObjectionCues, objectionQuestions, OBJECTION_TAGS, TAG_MIN } from "./objection-jev";

function fakeFetch(answers: Record<string, { noul?: number }>, opts: { ok?: boolean; throws?: boolean; slow?: boolean } = {}) {
  return (async (_url: string, init?: RequestInit) => {
    if (opts.throws) throw new Error("network down");
    if (opts.slow) {
      // Races the real AbortSignal.timeout() the same way a live fetch would, instead of just
      // blocking for the full duration and defeating the point of the deadline test.
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(resolve, 5000);
      });
    }
    return {
      ok: opts.ok ?? true,
      json: async () => ({ answers }),
    } as Response;
  }) as typeof fetch;
}

const BASE_INPUT = { sessionId: "m-1", chunkId: "m-1-1", capturedAt: "2026-09-25T00:00:00.000Z", previousChunkText: "" };

describe("objectionQuestions", () => {
  test("asks all seven tags as independent nouls", () => {
    const qs = objectionQuestions();
    expect(Object.keys(qs).sort()).toEqual([...OBJECTION_TAGS].sort());
    for (const tag of OBJECTION_TAGS) expect(qs[tag].type).toBe("noul");
  });
});

describe("classifyObjectionCues", () => {
  test("abstains (no network call) when the speaker isn't the prospect", async () => {
    let called = false;
    const request = (async () => {
      called = true;
      return { ok: true, json: async () => ({ answers: {} }) } as Response;
    }) as typeof fetch;
    const founder = await classifyObjectionCues({ ...BASE_INPUT, speaker: "founder", text: "it's too expensive" }, { key: "k", request });
    const unknown = await classifyObjectionCues({ ...BASE_INPUT, speaker: "unknown", text: "it's too expensive" }, { key: "k", request });
    expect(founder).toBeNull();
    expect(unknown).toBeNull();
    expect(called).toBe(false);
  });

  test("abstains on empty text or a missing key", async () => {
    const request = fakeFetch({ price: { noul: 0.99 } });
    expect(await classifyObjectionCues({ ...BASE_INPUT, speaker: "prospect", text: "   " }, { key: "k", request })).toBeNull();
    expect(await classifyObjectionCues({ ...BASE_INPUT, speaker: "prospect", text: "too pricey" }, { key: "", request })).toBeNull();
  });

  test("only suggests a tag at or above the 0.85 threshold, and can raise several at once", async () => {
    const request = fakeFetch({
      price: { noul: 0.9 }, incumbent: { noul: 0.87 }, timing: { noul: 0.5 }, send_info: { noul: 0.849 },
    });
    const result = await classifyObjectionCues({ ...BASE_INPUT, speaker: "prospect", text: "too expensive, and we already have someone" }, { key: "k", request });
    expect(result).not.toBeNull();
    expect(result!.suggestedTags.sort()).toEqual(["incumbent", "price"].sort());
    expect(TAG_MIN).toBe(0.85);
  });

  test("returns null (never throws) on a non-ok response, a network error, or a timeout", async () => {
    expect(await classifyObjectionCues({ ...BASE_INPUT, speaker: "prospect", text: "x" }, { key: "k", request: fakeFetch({}, { ok: false }) })).toBeNull();
    expect(await classifyObjectionCues({ ...BASE_INPUT, speaker: "prospect", text: "x" }, { key: "k", request: fakeFetch({}, { throws: true }) })).toBeNull();
    const slowResult = await classifyObjectionCues(
      { ...BASE_INPUT, speaker: "prospect", text: "x" },
      { key: "k", request: fakeFetch({}, { slow: true }), timeoutMs: 20 },
    );
    expect(slowResult).toBeNull();
  });

  test("never sends the previous chunk as the thing being classified — only as context", async () => {
    let sentState: any = null;
    const request = (async (_url: string, init?: RequestInit) => {
      sentState = JSON.parse(String(init?.body)).state;
      return { ok: true, json: async () => ({ answers: {} }) } as Response;
    }) as typeof fetch;
    await classifyObjectionCues(
      { ...BASE_INPUT, speaker: "prospect", text: "and the price too", previousChunkText: "we already use someone else" },
      { key: "k", request },
    );
    expect(sentState.chunk).toBe("and the price too");
    expect(sentState.previous_chunk).toBe("we already use someone else");
  });
});
