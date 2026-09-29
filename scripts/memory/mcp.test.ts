// REVIEW-STAGE-D B3: agents (Claude Code, Hermes, hindsight-ask) save through the OS memory API, so
// every save is screened, visible, forgettable and has its model recorded. TEMP vault + FAKE Hindsight.
import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { memoryMiddleware } from "./plugin";
import { join } from "node:path";
import { localApprovals } from "./approvals";
import { agentOf, cleanup, mehroz, setup, telegramOf, telegramReply, usman } from "./testing/harness";
import type { Principal } from "./types";

afterEach(cleanup);
const T = { timeout: 30_000 };
const agentProcess: Principal = { id: "usman", name: "Usman", via: "local", actor: "process" };
const browser: Principal = { id: "usman", name: "Usman", via: "local", actor: "human" };

async function post(mw: ReturnType<typeof memoryMiddleware>, url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any }>((resolve) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: "POST",
      url,
      headers: { host: "127.0.0.1:8081", "content-type": "application/json", "user-agent": "claude-code/2.1", ...headers },
      socket: { remoteAddress: "127.0.0.1" },
    });
    let status = 200;
    mw(req as never, { set statusCode(s: number) { status = s; }, setHeader() {}, end(b?: string) { resolve({ status, json: b ? JSON.parse(b) : null }); } } as never, () => resolve({ status: 404, json: null }));
  });
}
const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const result = (r: { json: any }) => JSON.parse(r.json.result.content[0].text);

describe("agents save through the OS (MCP)", () => {
  test(
    "save, screen, recall with sources, visible in the Memory list, model recorded; forget only asks",
    async () => {
      const h = await setup({ proxy: true });
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agentProcess, tokenOk: () => false });
      const init = await post(mw, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", clientInfo: { name: "claude-code" } } });
      expect(init.json.result.serverInfo.name).toBe("agentic-os-memory");
      expect((await post(mw, "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const tools = (await post(mw, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" })).json.result.tools.map((t: { name: string }) => t.name);
      expect(tools.slice(0, 4)).toEqual(["remember", "save_to_vault", "recall", "forget"]); // the writers/asker first, then L7's read-only tools
      expect(tools.filter((n: string) => !["remember", "save_to_vault", "recall", "forget"].includes(n) && !/^(list|get|search)_/.test(n))).toEqual([]);
      expect(tools).not.toContain("update_memory");

      const saved = result(await post(mw, "/mcp", call(3, "remember", { text: "The synthetic Plover clinic closes at 5pm on Fridays." })));
      expect(saved.ok).toBe(true);
      const row = h.api.item(saved.id)!.row;
      expect(row.processed_by?.model).toBe("deepseek/deepseek-v4.1-flash"); // model recorded
      expect(h.api.list({ kind: "memory" }).map((r) => r.id)).toContain(saved.id); // visible to the OS
      expect(h.bankDocs().get(saved.id)?.tags).toContain("src:agenticos");

      const refused = result(await post(mw, "/mcp", call(4, "remember", { text: "wifi password is correcthorsebatterystaple" })));
      expect(refused).toMatchObject({ ok: false, code: "prohibited-content" });
      expect(JSON.stringify(h.api.list({}))).not.toContain("correcthorse");

      const rec = result(await post(mw, "/mcp", call(5, "recall", { query: "When does the Plover clinic close?" })));
      expect(rec.facts[0]).toMatchObject({ id: saved.id, source: saved.id });

      const forget = result(await post(mw, "/mcp", call(6, "forget", { id: saved.id })));
      expect(forget).toMatchObject({ ok: false, code: "approval-required" });
      expect(h.bankDocs().has(saved.id)).toBe(true); // nothing removed until a person approves
      expect(h.api.approvals.pending().some((a) => a.target === `memory:${saved.id}`)).toBe(true);
    },
    T,
  );

  test("the token-less agent path is only for a local PROCESS caller with no browser markers, on agent routes", async () => {
    const h = await setup({ proxy: true });
    const agentMw = memoryMiddleware({ api: () => h.api, principalFor: () => agentProcess, tokenOk: () => false });
    const browserMw = memoryMiddleware({ api: () => h.api, principalFor: () => browser, tokenOk: () => false });
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await post(agentMw, "/mcp", rpc)).status).toBe(200);
    expect((await post(agentMw, "/recall", { query: "x" })).status).toBe(200);
    // A browser (session cookie → "human") still needs its page token.
    expect((await post(browserMw, "/mcp", rpc)).status).toBe(403);
    // Browser markers: refused (the origin rule, or no token).
    expect((await post(agentMw, "/mcp", rpc, { origin: "http://localhost:5173" })).status).toBe(403);
    expect((await post(agentMw, "/mcp", rpc, { "sec-fetch-mode": "cors" })).status).toBe(403);
    // Not an agent route: forget, correct and approval steps need a person with the page.
    expect((await post(agentMw, "/forget", { kind: "unindex", target: "n-proposal-terms" })).status).toBe(403);
    expect((await post(agentMw, "/correct", { id: "mf-00000000a1", text: "x" })).status).toBe(403);
    expect((await post(agentMw, "/approvals/grant", { approval_id: "apr-0000000000000000" })).status).toBe(403);
  });
});

describe("REVIEW-STAGE-D R2-1 on B2's service (Track 6): an agent can't approve its own forget", () => {
  test(
    "a program's forget: no card, no page-token grant, no click (not even a person's); only the requester's own Telegram code (or spoken yes) approves, and it runs at once",
    async () => {
      const h = await setup({ proxy: true });
      const agent = agentOf(usman);
      const agentMw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => true }); // it even holds the page token
      const pageMw = memoryMiddleware({ api: () => h.api, principalFor: () => usman, tokenOk: () => true });
      const saved = result(await post(agentMw, "/mcp", call(1, "remember", { text: "The synthetic Grebe clinic closes at 4pm." })));
      const ask = result(await post(agentMw, "/mcp", call(2, "forget", { id: saved.id })));
      expect(ask.code).toBe("approval-required");
      expect(ask.message).toContain("Telegram");
      const pending = h.api.approvals.pending().find((a) => a.target === `memory:${saved.id}`)!;
      expect(pending).toMatchObject({ requested_actor: "process", approve_with: "voice-or-telegram", state: "pending" });
      // The approvals store never holds the text being forgotten.
      expect(pending.summary).not.toContain("Grebe");
      expect(pending.display).toContain("Grebe");
      // The one-time code went to the REQUESTER's own Telegram DM, never back to the agent.
      const code = h.codeFor("usman");
      expect(code).toMatch(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
      expect(JSON.stringify(ask)).not.toContain(code!);
      // The reviewer's repro: the agent with the page token gets no card and can't grant.
      expect((await post(agentMw, "/approvals/card", { approval_id: pending.id })).status).toBe(403);
      expect((await post(agentMw, "/approvals/grant", { approval_id: pending.id, card_nonce: "00000000-0000-4000-8000-000000000000" })).status).toBe(403);
      // A person's click can't answer a program's request either: no card for it at all.
      const click = await post(pageMw, "/approvals/card", { approval_id: pending.id });
      expect(click.status).toBe(403);
      expect(click.json.reason).toContain("say yes to Jarvis");
      expect((await post(pageMw, "/approvals/grant", { approval_id: pending.id, card_nonce: "00000000-0000-4000-8000-000000000000" })).status).toBe(403);
      const again = await post(agentMw, "/forget", { kind: "memory", target: saved.id, approval_id: pending.id });
      expect(again.json.ok).toBe(false);
      expect(h.bankDocs().has(saved.id)).toBe(true);
      // The other founder's Telegram can't answer Usman's code (a miss against HER); a wrong code is a miss too.
      expect(await telegramReply(h.api, telegramOf(mehroz), `approve ${code}`)).toMatch(/doesn't match|Nothing is waiting/);
      expect(await telegramReply(h.api, telegramOf(usman), `approve ${code === "ZZZZ-9999" ? "YYYY-8888" : "ZZZZ-9999"}`)).toContain("doesn't match anything waiting for you (1/3)");
      expect(h.bankDocs().has(saved.id)).toBe(true);
      // The requester's own DM: approved, and the server runs exactly that forget. The reply names ids only.
      const said = await telegramReply(h.api, telegramOf(usman), `approve ${code}`);
      expect(said).toContain("Approved and done");
      expect(said).not.toContain("Grebe");
      expect(h.telegram.every((t) => !t.text.includes("Grebe"))).toBe(true); // the request line too
      expect(h.bankDocs().has(saved.id)).toBe(false);
      expect(h.api.approvals.get(pending.id)).toMatchObject({ state: "consumed", granted_via: "telegram", outcome: "succeeded" });
      // Replay: the code is spent (and replaying it is another miss).
      expect(await telegramReply(h.api, telegramOf(usman), `approve ${code}`)).toMatch(/doesn't match|Nothing is waiting/); 

      // A person's OWN forget from the Memory page gets its own approval, which the card's button answers.
      const other = result(await post(agentMw, "/mcp", call(3, "remember", { text: "The synthetic Grebe courier comes at noon." })));
      const mine = await post(pageMw, "/forget", { kind: "memory", target: other.id });
      expect(mine.json.code).toBe("approval-required");
      expect(mine.json.approval.approve_with).toBe("button");
      const card = await post(pageMw, "/approvals/card", { approval_id: mine.json.approval.id });
      expect(card.status).toBe(200);
      const g = await post(pageMw, "/approvals/grant", { approval_id: mine.json.approval.id, card_nonce: card.json.card_nonce });
      expect(g.status).toBe(200);
      expect(g.json.result.ok).toBe(true);
      expect(h.bankDocs().has(other.id)).toBe(false);
      // The same card can't be clicked twice.
      expect((await post(pageMw, "/approvals/grant", { approval_id: mine.json.approval.id, card_nonce: card.json.card_nonce })).status).not.toBe(200);
    },
    T,
  );

  test("a program's forget can be refused from the requester's Telegram ('deny CODE'): nothing removed, and it can't be approved later", async () => {
    const h = await setup({ proxy: true });
    const agentMw = memoryMiddleware({ api: () => h.api, principalFor: () => agentOf(usman), tokenOk: () => true });
    const saved = result(await post(agentMw, "/mcp", call(1, "remember", { text: "The synthetic Shearwater desk opens at 9." })));
    result(await post(agentMw, "/mcp", call(2, "forget", { id: saved.id })));
    const code = h.codeFor("usman")!;
    expect(await telegramReply(h.api, telegramOf(usman), `deny ${code}`)).toContain("OK, refused");
    expect(h.bankDocs().has(saved.id)).toBe(true);
    expect(await telegramReply(h.api, telegramOf(usman), `approve ${code}`)).toMatch(/doesn't match|Nothing is waiting/);
    expect(h.bankDocs().has(saved.id)).toBe(true);
  });

  test("held-release follows the same rule: a program can neither request-and-click nor grant it", async () => {
    const h = await setup({ proxy: true });
    const gate = localApprovals(join(h.base, "gate"), { spoken: h.spoken, now: h.clock });
    const req = { action: "memory.bulk-retract" as const, target: "vanished:25", digest: "d", summary: "Remove 25 vanished documents." };
    const byAgent = gate.require({ ...req, principal: agentOf(usman) });
    if (byAgent.status !== "pending") throw new Error("expected pending");
    expect(byAgent.requestedActor).toBe("process");
    expect(gate.card(byAgent.approvalId, usman)).toBeNull(); // a program's request has no card
    expect(gate.grant(byAgent.approvalId, usman, "ui", { cardNonce: "00000000-0000-4000-8000-000000000000" }).ok).toBe(false);
    const byPerson = gate.require({ ...req, principal: usman });
    if (byPerson.status !== "pending") throw new Error("expected pending");
    expect(byPerson.approvalId).not.toBe(byAgent.approvalId); // never merged with the program's request
    expect(gate.card(byPerson.approvalId, agentOf(usman))).toBeNull(); // a program has no browser session
    const card = gate.card(byPerson.approvalId, usman)!;
    expect(gate.grant(byPerson.approvalId, agentOf(usman), "ui", { cardNonce: card.cardNonce }).ok).toBe(false);
    expect(gate.grant(byPerson.approvalId, usman, "ui", { cardNonce: card.cardNonce }).ok).toBe(true);
    // A caller with no actor is treated as a program (as in Stage B2).
    const unknown = gate.require({ ...req, digest: "e", principal: { id: "usman", name: "Usman", via: "local" } });
    if (unknown.status !== "pending") throw new Error("expected pending");
    expect(unknown.requestedActor).toBe("process");
    expect(gate.card(unknown.approvalId, usman)).toBeNull();
  });
});
