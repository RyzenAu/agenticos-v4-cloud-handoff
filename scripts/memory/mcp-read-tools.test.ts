// L7 (29 Sep 2026): "the knowledge graph doesn't connect with Hermes". Hermes' include list asks for 14
// Hindsight READ tools the memory endpoint didn't have. They are now served, read only, from the OS' own
// index; the only writes stay remember / save_to_vault (screened, writer-capability checked) and forget
// (an ask); write/admin verbs are refused by name and never mapped onto anything. TEMP vault + FAKE Hindsight.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { memoryMiddleware } from "./plugin";
import { handleMcp } from "./mcp";
import { ADVERTISED_NAMES } from "./mcp";
import { classifyTool, CORE_TOOLS, READ_TOOLS, SERVED_TOOLS, WRITING_TOOLS, toolCoverage } from "./mcp-tools";
import { createLinks } from "./links";
import { resetWriterRegistrations } from "./hindsight-client";
import { cleanup, setup, usman } from "./testing/harness";
import type { Principal } from "./types";

afterEach(async () => {
  resetWriterRegistrations({ newCapability: true });
  await cleanup();
});
const T = { timeout: 45_000 };
const agent: Principal = { id: "usman", name: "Usman", via: "local", actor: "process" };

/** The 14 tool names Hermes' include list asks for beyond remember / save_to_vault / recall / forget (names only). */
const HERMES_EXTRA_14 = ["list_mental_models", "get_mental_model", "list_directives", "list_memories", "get_memory", "list_documents", "get_document", "list_operations", "get_operation", "list_tags", "get_bank", "get_knowledge_base_tree", "search_knowledge_base", "get_knowledge_page"];

function rpc(mw: ReturnType<typeof memoryMiddleware>, body: unknown) {
  return new Promise<{ status: number; json: any }>((resolve) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: "POST",
      url: "/mcp",
      headers: { host: "127.0.0.1:8081", "content-type": "application/json", "user-agent": "hermes-test" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    let status = 200;
    mw(req as never, { set statusCode(s: number) { status = s; }, setHeader() {}, end(b?: string) { resolve({ status, json: b ? JSON.parse(b) : null }); } } as never, () => resolve({ status: 404, json: null }));
  });
}
let id = 0;
const callRaw = (mw: ReturnType<typeof memoryMiddleware>, name: string, args: Record<string, unknown> = {}) => rpc(mw, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
const call = async (mw: ReturnType<typeof memoryMiddleware>, name: string, args: Record<string, unknown> = {}) => {
  const r = await callRaw(mw, name, args);
  return JSON.parse(r.json.result.content[0].text) as any;
};

describe("L7 · classification (pure)", () => {
  test("the 14 tools Hermes asks for are all served; nothing is missing and nothing is withheld", () => {
    expect(HERMES_EXTRA_14).toHaveLength(14);
    for (const name of HERMES_EXTRA_14) expect(classifyTool(name)).toBe("served");
    expect(toolCoverage([...CORE_TOOLS, ...HERMES_EXTRA_14])).toEqual({ served: 18, withheld: 0, missing: 0, missing_names: [] });
  });
  test("read tools can't write: the writing tools are exactly remember, save_to_vault and forget", () => {
    expect([...WRITING_TOOLS].sort()).toEqual(["forget", "remember", "save_to_vault"]);
    for (const t of READ_TOOLS) expect(WRITING_TOOLS).not.toContain(t);
    expect(SERVED_TOOLS).toEqual([...CORE_TOOLS, ...READ_TOOLS]);
    // What the endpoint advertises is exactly what the status logic counts as served.
    expect(ADVERTISED_NAMES).toEqual([...SERVED_TOOLS]);
  });
  test("write and admin verbs are withheld, an unknown read-like name is a real gap", () => {
    for (const name of ["delete_bank", "delete_memory", "delete_document", "clear_memories", "clear_bank", "create_directive", "update_directive", "create_mental_model", "update_bank", "retain", "reflect", "import_bank", "export_bank", "refresh_mental_model", "consolidate", "add_memory", "update_memory"])
      expect(classifyTool(name)).toBe("withheld");
    for (const name of ["kb_search", "get_graph", "list_entities", "recall_graph"]) expect(classifyTool(name)).toBe("missing");
    expect(toolCoverage(["recall", "delete_bank", "clear_memories", "kb_search", "kb_search", "sk-not-a-name-1234"])).toEqual({ served: 1, withheld: 2, missing: 2, missing_names: ["kb_search"] });
  });
});

describe("L7 · read tools through the memory middleware", () => {
  test(
    "list / get / search / tree / tags / bank answer from the OS index; current rows only; no history, no paths, no settings",
    async () => {
      const h = await setup({ proxy: true });
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => false });
      const tools = (await rpc(mw, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json.result.tools.map((t: { name: string }) => t.name);
      expect(tools).toEqual([...SERVED_TOOLS]);
      for (const t of tools) expect(t).not.toMatch(/^(delete|clear|create|update|retain|reflect)/);

      const a = await call(mw, "remember", { text: "The synthetic Plover clinic closes at 5pm on Fridays.", bucket: "business" });
      const b = await call(mw, "save_to_vault", { text: "The synthetic Curlew studio answers calls from 8am.", bucket: "business" });
      expect(a.ok && b.ok).toBe(true);
      await h.api.sync({ force: true, waitMs: 20_000 });
      // recall is a POST to Hindsight but reads; anything else that isn't a GET would be a write or delete.
      const writeCalls = () => h.fake.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/recall")).length;
      const writesBefore = writeCalls();

      const list = await call(mw, "list_memories", { bucket: "business" });
      expect(list.ok).toBe(true);
      expect(list.items.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(list.items.every((r: { bucket: string }) => r.bucket === "business")).toBe(true);
      const mem = list.items.find((r: { id: string }) => r.id === a.id);
      expect(mem).toMatchObject({ kind: "memory", source: a.id });
      const paged = await call(mw, "list_memories", { limit: 1 });
      expect(paged.items).toHaveLength(1);
      expect(paged.next_offset).toBe(1);
      expect((await call(mw, "list_memories", { limit: 9999 })).items.length).toBeLessThanOrEqual(50);
      expect((await call(mw, "list_memories", { query: "Plover clinic" })).items.map((r: { id: string }) => r.id)).toContain(a.id);

      const docs = await call(mw, "list_documents");
      expect(docs.items.some((r: { kind: string }) => r.kind === "memory")).toBe(false); // documents are vault-backed
      expect(docs.items.map((r: { id: string }) => r.id)).toContain(b.id);

      const got = await call(mw, "get_memory", { id: a.id });
      expect(got).toMatchObject({ ok: true, memory: { id: a.id, text: expect.stringContaining("Plover clinic closes at 5pm") } });
      expect(got.memory).not.toHaveProperty("history");
      for (const tool of ["get_document", "get_knowledge_page"]) {
        expect(await call(mw, tool, { id: b.id })).toMatchObject({ ok: true, document: { id: b.id, text: expect.stringContaining("Curlew studio") } });
        expect(await call(mw, tool, { id: a.id })).toMatchObject({ ok: false, code: "not-a-document" }); // a memory, not a document
        expect(await call(mw, tool, { id: "mf-doesnotexist" })).toMatchObject({ ok: false, code: "not-found" });
      }
      expect(await call(mw, "get_memory", { id: "" })).toMatchObject({ ok: false, code: "not-found" });
      expect((await callRaw(mw, "get_memory", { id: "mem-nope" })).json.result.isError).toBe(true);

      const search = await call(mw, "search_knowledge_base", { query: "When does the Plover clinic close?" });
      const recall = await call(mw, "recall", { query: "When does the Plover clinic close?" });
      expect(search).toEqual(recall);
      expect(search.facts[0]).toMatchObject({ id: a.id, source: a.id });

      const tags = await call(mw, "list_tags");
      expect(tags.tags.map((t: { tag: string }) => t.tag)).toEqual(["business", "finance", "deen", "research", "personal", "general"]);
      expect(tags.tags.find((t: { tag: string }) => t.tag === "business").items).toBeGreaterThanOrEqual(2);
      const tree = await call(mw, "get_knowledge_base_tree");
      const biz = tree.buckets.find((x: { bucket: string }) => x.bucket === "business");
      expect(biz.first.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(biz.first.length).toBeLessThanOrEqual(25);

      const bank = await call(mw, "get_bank");
      expect(bank.bank).toMatchObject({ name: "AgenticOS shared memory", saving: "on" });
      expect(bank.bank.memories).toBeGreaterThanOrEqual(1);
      // Nothing about the setup leaks: no vault or state path, no bank id, no url, no key.
      const everything = JSON.stringify([list, docs, got, tags, tree, bank]);
      for (const leak of [h.vault, h.state, h.base, "syn-connector", "127.0.0.1", "synthetic-test-key", "synthetic-approval-secret", "api_key"]) expect(everything).not.toContain(leak);

      // The Hindsight-only concepts AgenticOS doesn't have: honest empties, never invented.
      expect(await call(mw, "list_operations")).toMatchObject({ ok: true, operations: [] });
      expect(await call(mw, "list_mental_models")).toMatchObject({ ok: true, mental_models: [] });
      expect(await call(mw, "list_directives")).toMatchObject({ ok: true, directives: [] });
      expect(await call(mw, "get_operation", { id: "op-1" })).toMatchObject({ ok: false, code: "not-found" });
      expect(await call(mw, "get_mental_model", { id: "mm-1" })).toMatchObject({ ok: false, code: "not-found" });

      // Reading wrote nothing anywhere.
      expect(writeCalls()).toBe(writesBefore);
    },
    T,
  );

  test(
    "a superseded fact never reaches an agent through a read tool (only its current version)",
    async () => {
      const h = await setup({ proxy: true });
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => false });
      const first = await call(mw, "remember", { text: "The synthetic Tern clinic closes at 5pm." });
      const c = await h.api.correct(usman, first.id, { text: "The synthetic Tern clinic closes at 6pm.", channel: "voice" });
      if (!c.ok) throw new Error(c.message);
      const ids = (await call(mw, "list_memories", { limit: 50 })).items.map((r: { id: string }) => r.id);
      expect(ids).not.toContain(first.id);
      expect(await call(mw, "get_memory", { id: first.id })).toMatchObject({ ok: false, code: "not-found" });
      expect(JSON.stringify(await call(mw, "list_memories", { query: "Tern clinic" }))).not.toContain("5pm");
    },
    T,
  );
});

describe("L7 review F1/F3/F5 · by-id reads obey the same desired set as the lists", () => {
  const stone = (h: { state: string }, id: string) => {
    const p = join(h.state, "tombstones.json");
    let cur: unknown[] = [];
    try { cur = JSON.parse(readFileSync(p, "utf8")); } catch { /* none yet */ }
    writeFileSync(p, JSON.stringify([...cur, { id, content_hash: `hash-${id}`, kind: "fact", forgotten_at: "2026-09-29T00:00:00.000Z", forgotten_by: "usman", approval_id: "apr-synthetic" }]));
  };
  const idsOf = (r: { items: { id: string }[] }) => r.items.map((x) => x.id);

  test(
    "a tombstoned fact and memory (text possibly still in the note) and a path-excluded note are not returned by get_memory / get_document / get_knowledge_page, and the lists drop them too; a normal item still is",
    async () => {
      const h = await setup({ proxy: true });
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => false });
      const fact = await call(mw, "save_to_vault", { text: "The synthetic Curlew studio answers calls from 8am.", bucket: "business" });
      const mem = await call(mw, "remember", { text: "The synthetic Plover clinic closes at 5pm on Fridays.", bucket: "business" });
      const keep = await call(mw, "remember", { text: "The synthetic Godwit depot opens at 6am.", bucket: "business" });
      await h.api.sync({ force: true, waitMs: 20_000 });
      const note = (await call(mw, "list_documents", { limit: 50 })).items.find((x: { kind: string }) => x.kind === "note");
      expect(note).toBeTruthy();
      // Before: everything is readable by id.
      for (const tool of ["get_document", "get_knowledge_page"]) expect((await call(mw, tool, { id: fact.id })).ok).toBe(true);
      expect((await call(mw, "get_memory", { id: mem.id })).ok).toBe(true);
      expect((await call(mw, "get_document", { id: note.id })).ok).toBe(true);
      expect((await call(mw, "get_document", { id: note.source })).ok).toBe(true); // by path too

      stone(h, fact.id);
      stone(h, mem.id);
      writeFileSync(join(h.state, "exclusions.json"), JSON.stringify([{ id: note.id, path: note.source, excluded_at: "2026-09-29T00:00:00.000Z", by: "usman" }]));

      for (const tool of ["get_memory", "get_document", "get_knowledge_page"]) {
        expect(await call(mw, tool, { id: fact.id })).toMatchObject({ ok: false, code: "not-found" });
        expect(await call(mw, tool, { id: mem.id })).toMatchObject({ ok: false, code: "not-found" });
      }
      expect(await call(mw, "get_document", { id: note.id })).toMatchObject({ ok: false, code: "not-found" });
      expect(await call(mw, "get_knowledge_page", { id: note.source })).toMatchObject({ ok: false, code: "not-found" });
      const listed = [...idsOf(await call(mw, "list_memories", { limit: 50 })), ...idsOf(await call(mw, "list_documents", { limit: 50 }))];
      for (const gone of [fact.id, mem.id, note.id]) expect(listed).not.toContain(gone);
      expect((await call(mw, "get_knowledge_base_tree")).buckets.flatMap((b: { first: { id: string }[] }) => b.first.map((x) => x.id))).not.toContain(fact.id);
      // A normal current item is still returned, by id, in a list and in search.
      expect(await call(mw, "get_memory", { id: keep.id })).toMatchObject({ ok: true, memory: { id: keep.id } });
      expect(idsOf(await call(mw, "list_memories", { limit: 50 }))).toContain(keep.id);
    },
    T,
  );

  test("any error while reading fails closed: not-found for a by-id read, unavailable for a list", async () => {
    const h = await setup({ proxy: true });
    const broken = { ...h.api, readableOne: () => { throw new Error("boom at /secret/path"); }, readable: () => { throw new Error("boom at /secret/path"); } } as never;
    const one = async (name: string, args: Record<string, unknown>) => JSON.parse(((await handleMcp(broken, agent, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "t")) as any).result.content[0].text);
    for (const tool of ["get_memory", "get_document", "get_knowledge_page"]) expect(await one(tool, { id: "mem-x" })).toMatchObject({ ok: false, code: "not-found" });
    for (const tool of ["list_memories", "list_documents", "list_tags", "get_bank", "get_knowledge_base_tree"]) {
      const r = await one(tool, {});
      expect(r).toMatchObject({ ok: false, code: "unavailable" });
      expect(JSON.stringify(r)).not.toContain("secret");
    }
  }, T);

  test("at most 4 scanning tools per request (batch); other calls in the batch still answer", async () => {
    const h = await setup({ proxy: true });
    const batch = [...Array(6)].map((_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "list_memories", arguments: {} } }));
    batch.push({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_operations", arguments: {} } });
    const out = (await handleMcp(h.api, agent, batch, "t")) as any[];
    expect(out.slice(0, 4).every((o) => o.result)).toBe(true);
    expect(out.slice(4, 6).every((o) => o.error?.code === -32000)).toBe(true);
    expect(out[6].result).toBeTruthy();
  }, T);

  test("a long tool name is clipped to plain characters when echoed back", async () => {
    const h = await setup({ proxy: true });
    const name = `delete_${"x".repeat(5000)}\n<script>`;
    const refused = JSON.parse(((await handleMcp(h.api, agent, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }, "t")) as any).result.content[0].text);
    expect(refused.code).toBe("not-offered");
    expect(refused.message.length).toBeLessThan(300);
    expect(refused.message).not.toContain("<script>");
    const unknown = (await handleMcp(h.api, agent, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: `zz${"y".repeat(5000)}`, arguments: {} } }, "t")) as any;
    expect(unknown.error.message.length).toBeLessThan(100);
  }, T);
});
describe("L7 · writes stay screened and capability-checked; admin tools are refused", () => {
  test(
    "remember through the endpoint is screened (a secret is refused before any Hindsight call) and carries the writer capability",
    async () => {
      const h = await setup({ proxy: true, writerCapability: true });
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => false });
      const refused = await call(mw, "remember", { text: "wifi password is correcthorsebatterystaple" });
      expect(refused).toMatchObject({ ok: false, code: "prohibited-content" });
      expect((await call(mw, "save_to_vault", { text: "my card number is 4111 1111 1111 1111" })).ok).toBe(false);
      expect(h.fake.calls.some((c) => c.method !== "GET")).toBe(false); // nothing left the OS
      expect(h.fake.writerLog).toEqual([]);

      const ok = await call(mw, "remember", { text: "The synthetic Pelican desk opens at 8." });
      expect(ok.ok).toBe(true);
      expect(h.fake.writerLog.map((x) => x.event)).toEqual(["registered", "ok"]); // the capability rode the write
      expect(h.bankDocs().has(ok.id)).toBe(true);
      expect(JSON.stringify(await call(mw, "list_memories"))).not.toContain("correcthorse");
    },
    T,
  );

  test(
    "a copy the proxy won't accept as writer can't write through the endpoint (queued and visible, not silent); reads still work",
    async () => {
      const h = await setup({ proxy: true, writerCapability: true });
      rmSync(h.env.HINDSIGHT_APPROVAL_SECRET_FILE); // can't prove itself: can't register
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => false });
      const r = await call(mw, "remember", { text: "The synthetic Avocet desk opens at 10." });
      expect(h.bankDocs().has(r.id)).toBe(false);
      expect(h.api.status().hindsight).toBe("writer-refused");
      expect((await call(mw, "list_memories")).ok).toBe(true);
    },
    T,
  );

  test(
    "admin and destructive tools are refused by name: nothing reaches the api, Hindsight or the writer; forget still only asks",
    async () => {
      const h = await setup({ proxy: true, writerCapability: true });
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => true }); // even holding the page token
      const saved = await call(mw, "remember", { text: "The synthetic Grebe clinic closes at 4pm." });
      const before = { calls: h.fake.calls.length, writer: h.fake.writerLog.length, docs: h.bankDocs().size, rows: h.api.list({ includeSuperseded: true }).length, approvals: h.api.approvals.pending().length };
      for (const name of ["delete_bank", "delete_memory", "delete_document", "clear_memories", "create_directive", "update_directive", "create_mental_model", "update_bank", "retain", "reflect", "import_bank", "add_memory", "update_memory"]) {
        const raw = await callRaw(mw, name, { id: saved.id, bank_id: "mu-shared", text: "overwrite", content: "overwrite" });
        const res = JSON.parse(raw.json.result.content[0].text);
        expect(raw.json.result.isError).toBe(true);
        expect(res).toMatchObject({ ok: false, code: "not-offered" });
        expect(res.message).toContain("deliberately doesn't offer");
      }
      // An unknown name is still a plain protocol error.
      expect((await callRaw(mw, "kb_search", {})).json.error.code).toBe(-32602);
      expect({ calls: h.fake.calls.length, writer: h.fake.writerLog.length, docs: h.bankDocs().size, rows: h.api.list({ includeSuperseded: true }).length, approvals: h.api.approvals.pending().length }).toEqual(before);
      expect(h.bankDocs().has(saved.id)).toBe(true);
      // forget still only asks (the agent can't approve it, even with the page token).
      expect(await call(mw, "forget", { id: saved.id })).toMatchObject({ ok: false, code: "approval-required" });
      expect(h.bankDocs().has(saved.id)).toBe(true);
    },
    T,
  );
});

describe("L7 · the status wording follows the tool classes; no secret in any response", () => {
  const HOME = (include: string[], extra = "") => `${extra}mcp_servers:\n  hindsight:\n    url: http://127.0.0.1:8081/__memory/mcp\n    tools:\n      include: [${include.join(", ")}]\n`;
  const homes: string[] = [];
  afterEach(() => void homes.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const linksFor = (cfg: string) => {
    const dir = mkdtempSync(join(tmpdir(), "l7-hermes-"));
    homes.push(dir);
    writeFileSync(join(dir, "config.yaml"), cfg);
    return createLinks({ env: { HERMES_HOME: dir }, port: () => 8081 });
  };

  test("the owner's real config (4 + 14) is Connected with nothing missing; adding admin tools is 'deliberately not offered', not a fault", async () => {
    const { describeLinks } = await import("../../src/components/memory/links-model");
    const view = (l: ReturnType<typeof linksFor>) => ({ data: l.view(), error: null, loading: false });
    const real = describeLinks({ data: null, error: "x", loading: false }, view(linksFor(HOME([...CORE_TOOLS, ...HERMES_EXTRA_14]))), { data: { installed: true }, error: null, loading: false });
    expect(real.nodes.hermes).toMatchObject({ state: "Connected", tone: "ok" });
    const withAdmin = describeLinks({ data: null, error: "x", loading: false }, view(linksFor(HOME([...CORE_TOOLS, ...HERMES_EXTRA_14, "delete_bank", "clear_memories"]))), { data: { installed: true }, error: null, loading: false });
    expect(withAdmin.nodes.hermes).toMatchObject({ state: "Connected", tone: "ok" });
    expect(withAdmin.nodes.hermes.detail).toContain("2 admin tools deliberately not offered.");
    const gap = describeLinks({ data: null, error: "x", loading: false }, view(linksFor(HOME([...CORE_TOOLS, "kb_search", "delete_bank"]))), { data: { installed: true }, error: null, loading: false });
    expect(gap.nodes.hermes).toMatchObject({ state: "Connected, 1 tool missing", tone: "warn" });
    expect(gap.nodes.hermes.detail).toContain("kb_search that this memory endpoint doesn't have");
    expect(gap.nodes.hermes.detail).toContain("1 admin tool deliberately not offered.");
  });

  test(
    "no secret from Hermes' config, the proxy or the environment appears in the links view, any read response or the logs",
    async () => {
      const h = await setup({ proxy: true });
      const secret = "sk-synthetic-L7-not-a-real-key";
      const links = linksFor(HOME([...CORE_TOOLS, ...HERMES_EXTRA_14, secret], `api_key: ${secret}\nauth:\n  token: ${secret}\n`));
      const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => false, links });
      const logged: string[] = [];
      const orig = { log: console.log, warn: console.warn, error: console.error };
      console.log = console.warn = console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
      let out: string;
      try {
        await call(mw, "remember", { text: "The synthetic Osprey depot opens at 7." });
        const seen: unknown[] = [links.view().hermes];
        for (const t of READ_TOOLS) seen.push((await callRaw(mw, t, { id: "mem-x", query: "Osprey" })).json);
        out = JSON.stringify(seen) + logged.join("\n");
      } finally {
        Object.assign(console, orig);
      }
      expect(out).not.toContain(secret);
      expect(out).not.toContain("api_key");
      expect(links.view().hermes).toMatchObject({ checked: true, served_tools: 18, missing_tools: 1, missing_names: [] }); // the pasted key is counted, never shown
    },
    T,
  );
});
