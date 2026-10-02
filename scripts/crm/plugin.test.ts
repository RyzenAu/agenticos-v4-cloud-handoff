import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createCrmMiddleware, type CrmHttpService } from "./plugin";
import { pageTokenFor, type Principal } from "../identity/principal";
import type { HubRole } from "../cloud/hub-role";

const token = "synthetic-crm-token";
const founders: Record<string, Principal> = {
  usman: {
    personId: "usman",
    via: "paired-session",
    actor: "human",
    sessionId: "synthetic-session-u",
    displayName: "Usman",
  },
  mehroz: {
    personId: "mehroz",
    via: "paired-session",
    actor: "human",
    sessionId: "synthetic-session-m",
    displayName: "Mehroz",
  },
  bare: { personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" },
  companion: { personId: "usman", via: "companion", actor: "process", displayName: "Companion" },
};
let server: Server,
  origin = "",
  calls: { name: string; input: unknown; person: string }[] = [];
let role: HubRole = "server",
  readOnly = false;
const service: CrmHttpService = {
  snapshot: () => ({ companies: [{ id: "shared", owner: "usman" }] }),
  resolveLegacyLead: (id) => (id === 7 ? { kind: "company", id: "lead-7" } : null),
  operations: {
    list: () => [{ name: "crm.company.create", summary: "Create a company" }],
    run(name, input, principal) {
      if (name === "crm.test.conflict")
        return { ok: false, code: "conflict", text: "Record changed elsewhere." };
      if (name === "crm.test.failure") throw new Error("Private database /private/secret failed");
      calls.push({ name, input, person: principal.personId });
      return { ok: true, href: "/crm?ref=crm%3Acompany%3Ashared", text: "Saved." };
    },
  },
};
beforeAll(async () => {
  const middleware = createCrmMiddleware({
    root: process.cwd(),
    token,
    service: () => service,
    principal: (req) => founders[String(req.headers["x-test-principal"])] ?? null,
    role: () => role,
    readOnly: () => readOnly,
  });
  server = createServer(
    (req, res) =>
      void middleware.handle(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const get = (path: string, who = "usman", headers: Record<string, string> = {}) =>
  fetch(origin + path, { headers: { "x-test-principal": who, ...headers } });
const post = (body: unknown, who = "usman", headers: Record<string, string> = {}) =>
  fetch(origin + "/__crm/ops", {
    method: "POST",
    headers: {
      "x-test-principal": who,
      "content-type": "application/json",
      "x-claude-os-token": pageTokenFor(founders[who] ?? founders.usman, token),
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("CRM HTTP uses the existing identity contract", () => {
  test("anonymous and companion callers never open the shared store", async () => {
    expect((await get("/__crm/snapshot", "nobody")).status).toBe(401);
    expect((await get("/__crm/snapshot", "companion")).status).toBe(403);
  });
  test("both founders read the same company even when another founder owns it", async () => {
    const u = await get("/__crm/snapshot", "usman"),
      m = await get("/__crm/snapshot", "mehroz");
    expect(u.status).toBe(200);
    expect(m.status).toBe(200);
    expect(await u.json()).toEqual(await m.json());
    expect(m.headers.get("cache-control")).toBe("no-store");
  });
  test("writes take attribution only from the resolved principal", async () => {
    calls = [];
    const r = await post(
      { name: "crm.company.create", input: { name: "Synthetic Dental" } },
      "mehroz",
    );
    expect(r.status).toBe(200);
    expect(calls[0].person).toBe("mehroz");
    expect(
      (await post({ name: "crm.company.create", input: {}, principal: founders.usman }, "mehroz"))
        .status,
    ).toBe(400);
    expect(
      (await post({ name: "crm.company.create", input: {}, by: "usman" }, "mehroz")).status,
    ).toBe(400);
    expect(calls).toHaveLength(1);
  });
  test("page tokens are person-bound, never the internal token for remote founders", async () => {
    const command = { name: "crm.company.create", input: {} };
    expect((await post(command, "mehroz", { "x-claude-os-token": token })).status).toBe(403);
    expect(
      (await post(command, "mehroz", { "x-claude-os-token": pageTokenFor(founders.usman, token) }))
        .status,
    ).toBe(403);
    const r = await post(command, "usman", { "x-claude-os-token": "" });
    expect(await r.json()).toEqual({ ok: false, error: "Refresh this page and try again." });
  });
  test("server writes require a confirmed session and never fall back to a name", async () => {
    expect((await get("/__crm/snapshot", "bare")).status).toBe(200);
    expect((await post({ name: "crm.company.create", input: {} }, "bare")).status).toBe(403);
  });
  test("same-origin, exact JSON, bounded bodies and read-only mode", async () => {
    expect(
      (await get("/__crm/snapshot", "usman", { origin: "https://other.example" })).status,
    ).toBe(403);
    expect((await get("/__crm/snapshot", "usman", { "sec-fetch-site": "cross-site" })).status).toBe(
      403,
    );
    expect(
      (await post({}, "usman", { "content-type": "text/plain; x=application/json" })).status,
    ).toBe(415);
    expect(
      (await post({ name: "crm.company.create", input: "x".repeat(2 * 1024 * 1024) })).status,
    ).toBe(413);
    readOnly = true;
    expect((await post({ name: "crm.company.create", input: {} })).status).toBe(409);
    readOnly = false;
  });
  test("conflicts are honest and unexpected errors disclose no private path", async () => {
    expect((await post({ name: "crm.test.conflict", input: {} })).status).toBe(409);
    const r = await post({ name: "crm.test.failure", input: {} });
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("/private/secret");
  });
  test("legacy references and descriptor reads are explicit", async () => {
    expect(await (await get("/__crm/resolve-legacy?lead=7")).json()).toEqual({
      ref: { kind: "company", id: "lead-7" },
    });
    expect((await get("/__crm/resolve-legacy?lead=7oops")).status).toBe(400);
    expect((await get("/__crm/resolve-legacy?lead=8")).status).toBe(404);
    expect((await get("/__crm/ops")).status).toBe(200);
    expect((await get("/__crm/unknown")).status).toBe(404);
  });
});
