// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { sendDotTask } from "./jarvis-send";

describe("Dot's Jarvis composer: POST /__gateway/tasks with the request id as its eventId", () => {
  test("accepted when the hub answers; the words, the page token and the id are what is sent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url === "/__token" ? new Response(JSON.stringify({ token: "page-token" })) : new Response(JSON.stringify({ ok: true, said: "QA DOT 1" }));
    }) as unknown as typeof fetch;
    const p = sendDotTask("  Reply with QA DOT 1 ", { requestId: "jr-test-1", fetcher });
    expect(await p.done).toBe("accepted");
    const post = calls.find((c) => c.url === "/__gateway/tasks")!;
    expect(post.init?.method).toBe("POST");
    expect((post.init?.headers as Record<string, string>)["X-Claude-OS-Token"]).toBe("page-token");
    expect(JSON.parse(String(post.init?.body))).toEqual({ text: "Reply with QA DOT 1", eventId: "jr-test-1" });
  });

  test("a refusal or a network failure keeps the words (not accepted)", async () => {
    const refused = (async (url: string) => (url === "/__token" ? new Response('{"token":"t"}') : new Response("{}", { status: 403 }))) as unknown as typeof fetch;
    expect(await sendDotTask("x", { fetcher: refused }).done).toBe("cancelled");
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await sendDotTask("x", { fetcher: down }).done).toBe("cancelled");
  });
});
