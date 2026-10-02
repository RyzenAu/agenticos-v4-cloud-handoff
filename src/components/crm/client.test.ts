// @ts-ignore: bun supplies test types at runtime.
import { afterEach, describe, expect, test } from "bun:test";
import {
  CrmRequestError,
  crmErrorMessage,
  crmOperation,
  getCrmSnapshot,
  resetCrmToken,
} from "@/lib/crm-client";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCrmToken();
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
describe("CRM browser transport", () => {
  test("sends typed operations with the page token and preserves the receipt", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url) === "/__token"
        ? json({ token: "synthetic-token" })
        : json({ ok: true, text: "Saved", href: "/crm?ref=crm:company:a", data: { id: "a" } });
    }) as typeof fetch;
    const receipt = await crmOperation("crm.company.create", { name: "Synthetic company" });
    expect(receipt.text).toBe("Saved");
    expect(calls[1].url).toBe("/__crm/ops");
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({
      name: "crm.company.create",
      input: { name: "Synthetic company" },
    });
    expect((calls[1].init!.headers as Record<string, string>)["X-Claude-OS-Token"]).toBe(
      "synthetic-token",
    );
  });
  test("retries only the exact pre-mutation stale-token refusal", async () => {
    let tokens = 0,
      writes = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) =>
      String(url) === "/__token"
        ? json({ token: `token${++tokens}` })
        : ++writes === 1
          ? json({ error: "Refresh this page and try again." }, 403)
          : json({ ok: true, text: "Saved" })) as typeof fetch;
    expect((await crmOperation("crm.company.create", { name: "A" })).ok).toBe(true);
    expect(tokens).toBe(2);
    expect(writes).toBe(2);
  });
  test("a conflict keeps its status and gives honest draft-preserving recovery", async () => {
    let writes = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) =>
      String(url) === "/__token"
        ? json({ token: "t" })
        : (writes++,
          json({ ok: false, code: "conflict", text: "Record changed." }, 409))) as typeof fetch;
    const error = await crmOperation("crm.company.update", {
      id: "a",
      expectedVersion: 1,
      patch: { name: "B" },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(CrmRequestError);
    expect(error.status).toBe(409);
    expect(crmErrorMessage(error)).toContain("Your draft has been kept");
    expect(writes).toBe(1);
  });
  test("never retries a network-uncertain write", async () => {
    let writes = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url) === "/__token") return json({ token: "t" });
      writes++;
      throw new TypeError("Network interrupted");
    }) as typeof fetch;
    const error = await crmOperation("crm.company.create", { name: "A" }).catch((e) => e);
    expect(error.code).toBe("uncertain");
    expect(error.message).toContain("may have saved");
    expect(writes).toBe(1);
  });
  test("never retries other access refusals", async () => {
    let writes = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) =>
      String(url) === "/__token"
        ? json({ token: "t" })
        : (writes++, json({ error: "Not authorised" }, 403))) as typeof fetch;
    await expect(crmOperation("crm.views.list", {})).rejects.toThrow("Not authorised");
    expect(writes).toBe(1);
  });
  test("an unreadable successful response is not called saved", async () => {
    globalThis.fetch = (async () => new Response("Not JSON", { status: 200 })) as typeof fetch;
    await expect(getCrmSnapshot()).rejects.toThrow("unreadable response");
  });
});
