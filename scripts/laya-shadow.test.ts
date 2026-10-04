import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layaUrl, logShadow, queryLaya } from "./laya-shadow";

describe("layaUrl", () => {
  test("off by default; trims a trailing slash when set", () => {
    expect(layaUrl({})).toBeUndefined();
    expect(layaUrl({ LAYA_URL: "" })).toBeUndefined();
    expect(layaUrl({ LAYA_URL: " http://127.0.0.1:8899/ " })).toBe("http://127.0.0.1:8899");
  });
});

describe("queryLaya", () => {
  test("posts to /v1/systemone and returns answers with timing", async () => {
    let seen: { url: string; body: string } | null = null;
    const request = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) };
      return Response.json({ answers: { lane: { choice: "chat", confidence: 0.9 } } });
    }) as typeof fetch;
    const result = await queryLaya("http://127.0.0.1:8899", { model: "x", state: {}, questions: {} }, request);
    expect(seen!.url).toBe("http://127.0.0.1:8899/v1/systemone");
    expect(result?.answers.lane.choice).toBe("chat");
    expect(typeof result?.ms).toBe("number");
  });
  test("null on a bad response, a malformed body or a thrown error, never throwing", async () => {
    expect(await queryLaya("http://x", {}, (async () => new Response("nope", { status: 500 })) as typeof fetch)).toBeNull();
    expect(await queryLaya("http://x", {}, (async () => Response.json({ nope: true })) as typeof fetch)).toBeNull();
    expect(await queryLaya("http://x", {}, (async () => { throw new Error("down"); }) as typeof fetch)).toBeNull();
  });
});

describe("logShadow", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test("appends one JSON line with intents/timings, never the utterance", async () => {
    const root = mkdtempSync(join(tmpdir(), "laya-shadow-"));
    dirs.push(root);
    await logShadow({ at: "2026-09-24T00:00:00.000Z", jevIntent: "os_page", jevConfidence: 0.9, jevMs: 280, layaIntent: "os_page", layaConfidence: 0.85, layaMs: 40, agree: true }, root);
    await logShadow({ at: "2026-09-24T00:00:01.000Z", jevIntent: "brain", jevConfidence: 0, jevMs: 300, layaIntent: null, layaConfidence: null, layaMs: null, agree: null }, root);
    const lines = readFileSync(join(root, ".operator-data", "laya-shadow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ at: "2026-09-24T00:00:00.000Z", jevIntent: "os_page", jevConfidence: 0.9, jevMs: 280, layaIntent: "os_page", layaConfidence: 0.85, layaMs: 40, agree: true });
    expect(JSON.stringify(lines)).not.toContain("utterance");
  });
});
