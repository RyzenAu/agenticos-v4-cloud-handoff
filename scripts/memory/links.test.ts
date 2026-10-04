// W-D (29 Sep 2026): GET /__memory/links tells the knowledge graph whether Hermes is wired to this
// memory. Booleans only: no url, path or other config value ever leaves the server. TEMP dirs only.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createLinks, hermesConfigCandidates, memoryMcpPort } from "./links";
import { memoryMiddleware } from "./plugin";
import { cleanup, setup } from "./testing/harness";
import type { Principal } from "./types";

const temps: string[] = [];
afterEach(async () => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  await cleanup();
});
function hermesHome(config: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "wd-hermes-"));
  temps.push(dir);
  if (config !== null) writeFileSync(join(dir, "config.yaml"), config);
  return dir;
}
const LINKED = `model:
  default: synthetic
mcp_servers:
  hindsight:
    url: http://127.0.0.1:8081/__memory/mcp
    tools:
      include: [recall, remember, save_to_vault, forget]
`;

describe("memoryMcpPort", () => {
  test("finds an MCP server pointed at /__memory/mcp and its port", () => {
    expect(memoryMcpPort(LINKED)).toEqual({ found: true, port: 8081, tools: ["recall", "remember", "save_to_vault", "forget"] });
    expect(memoryMcpPort(`mcp_servers:\n  m:\n    url: "http://localhost:4541/__memory/mcp"\n`)).toEqual({ found: true, port: 4541, tools: [] });
  });
  test("ignores other MCP servers and urls outside the mcp_servers block", () => {
    expect(memoryMcpPort(`mcp_servers:\n  hindsight:\n    url: http://127.0.0.1:8878/mcp/mu-shared/\n`).found).toBe(false);
    expect(memoryMcpPort(`notes:\n  url: http://127.0.0.1:8081/__memory/mcp\nmcp_servers:\n  x:\n    url: http://127.0.0.1:9/mcp\n`).found).toBe(false);
    expect(memoryMcpPort("").found).toBe(false);
  });
});

describe("createLinks", () => {
  test("classes each tool Hermes asks for: served, deliberately withheld (admin/write), or a real gap", () => {
    const cfg = `mcp_servers:\n  other:\n    url: http://127.0.0.1:9/mcp\n    tools:\n      include: [kb_search]\n  hindsight:\n    url: http://127.0.0.1:8081/__memory/mcp\n    tools:\n      include:\n        - recall\n        - list_memories\n        - delete_bank\n        - kb_search\n        - kb_graph\n`;
    const view = createLinks({ env: { HERMES_HOME: hermesHome(cfg) }, port: () => 8081 }).view();
    expect(view.hermes).toEqual({ checked: true, configured: true, port_matches: true, served_tools: 2, withheld_tools: 1, missing_tools: 2, missing_names: ["kb_search", "kb_graph"] });
  });
  test("L7: the owner's real include list (4 memory tools + 14 Hindsight read tools) is fully served: nothing missing", () => {
    const names = ["recall", "remember", "save_to_vault", "forget", "list_mental_models", "get_mental_model", "list_directives", "list_memories", "get_memory", "list_documents", "get_document", "list_operations", "get_operation", "list_tags", "get_bank", "get_knowledge_base_tree", "search_knowledge_base", "get_knowledge_page"];
    const cfg = `mcp_servers:\n  hindsight:\n    url: http://127.0.0.1:8081/__memory/mcp\n    tools:\n      include: [${names.join(", ")}]\n`;
    expect(createLinks({ env: { HERMES_HOME: hermesHome(cfg) }, port: () => 8081 }).view().hermes).toEqual({ checked: true, configured: true, port_matches: true, served_tools: 18, withheld_tools: 0, missing_tools: 0, missing_names: [] });
  });
  test("a name that isn't a plain tool name (a pasted key) is counted, never echoed", () => {
    const cfg = `mcp_servers:\n  hindsight:\n    url: http://127.0.0.1:8081/__memory/mcp\n    tools:\n      include: [sk-synthetic-not-real-1234, recall]\n`;
    const view = createLinks({ env: { HERMES_HOME: hermesHome(cfg) }, port: () => 8081 }).view();
    expect(view.hermes).toMatchObject({ served_tools: 1, missing_tools: 1, missing_names: [] });
    expect(JSON.stringify(view)).not.toContain("sk-synthetic");
  });
  test("configured and pointed at this server's port", () => {
    const links = createLinks({ env: { HERMES_HOME: hermesHome(LINKED) }, port: () => 8081 });
    expect(links.view().hermes).toEqual({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] });
  });
  test("configured for another port (a preview, or a moved OS) says so", () => {
    const links = createLinks({ env: { HERMES_HOME: hermesHome(LINKED) }, port: () => 4541 });
    expect(links.view().hermes).toEqual({ checked: true, configured: true, port_matches: false, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] });
  });
  test("Hermes installed but not wired to memory is 'not connected', not unknown", () => {
    const links = createLinks({ env: { HERMES_HOME: hermesHome("mcp_servers:\n  other:\n    url: http://127.0.0.1:9/mcp\n") }, port: () => 8081 });
    expect(links.view().hermes).toEqual({ checked: true, configured: false, port_matches: null, served_tools: 0, withheld_tools: 0, missing_tools: 0, missing_names: [] });
  });
  test("no config anywhere is 'not checked', never 'not connected'", () => {
    const empty = hermesHome(null);
    const links = createLinks({ env: { HERMES_HOME: empty, HOME: empty, USERPROFILE: empty }, port: () => 8081, home: empty });
    expect(links.view().hermes).toEqual({ checked: false, configured: null, port_matches: null, reason: "no-config" });
  });
  test("a changed config is picked up (the cache follows the file's mtime)", () => {
    const home = hermesHome("mcp_servers:\n");
    const links = createLinks({ env: { HERMES_HOME: home }, port: () => 8081 });
    expect(links.view().hermes.configured).toBe(false);
    writeFileSync(join(home, "config.yaml"), LINKED);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(home, "config.yaml"), later, later);
    expect(links.view().hermes.configured).toBe(true);
  });
  test("returns booleans only: no url, port number or path", () => {
    const home = hermesHome(LINKED.replace("mcp_servers:", "api_key: sk-synthetic-not-real\nmcp_servers:"));
    const text = JSON.stringify(createLinks({ env: { HERMES_HOME: home }, port: () => 8081 }).view());
    for (const leak of ["127.0.0.1", "8081", "__memory", home, "sk-synthetic", "config.yaml"]) expect(text).not.toContain(leak);
  });
  test("counts agent tool calls with the tool's name only", () => {
    let t = Date.parse("2026-09-29T04:00:00Z");
    const links = createLinks({ env: { HERMES_HOME: hermesHome(LINKED) }, port: () => 8081, now: () => new Date(t) });
    links.recordRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    links.recordRpc({ jsonrpc: "2.0", id: 2, method: "initialize" });
    expect(links.view().agent_calls).toMatchObject({ count: 0, last_at: null, last_tool: null });
    t += 60_000;
    links.recordRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recall", arguments: { query: "private question" } } });
    links.recordRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "<script>", arguments: {} } });
    const v = links.view();
    expect(v.agent_calls).toMatchObject({ count: 2, last_at: "2026-09-29T04:01:00.000Z", last_tool: "unknown" });
    expect(JSON.stringify(v)).not.toContain("private question");
  });
  test("looks in HERMES_HOME, then ~/.hermes, then %LOCALAPPDATA%\\hermes", () => {
    const c = hermesConfigCandidates({ HERMES_HOME: "H", HOME: "U", LOCALAPPDATA: "L" });
    expect(c).toEqual([join("H", "config.yaml"), join("U", ".hermes", "config.yaml"), join("L", "hermes", "config.yaml")]);
  });
});

describe("GET /__memory/links through the memory middleware", () => {
  const agent: Principal = { id: "usman", name: "Usman", via: "local", actor: "process" };
  function request(mw: ReturnType<typeof memoryMiddleware>, method: "GET" | "POST", url: string, body?: unknown) {
    return new Promise<{ status: number; json: any }>((resolve) => {
      const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
        method,
        url,
        headers: { host: "127.0.0.1:8081", "content-type": "application/json", "user-agent": "hermes-test" },
        socket: { remoteAddress: "127.0.0.1" },
      });
      let status = 200;
      mw(req as never, { set statusCode(s: number) { status = s; }, setHeader() {}, end(b?: string) { resolve({ status, json: b ? JSON.parse(b) : null }); } } as never, () => resolve({ status: 404, json: null }));
    });
  }
  test("serves the view and counts a real agent tool call", async () => {
    const h = await setup({ proxy: true });
    const links = createLinks({ env: { HERMES_HOME: hermesHome(LINKED) }, port: () => 8081 });
    const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => false, links });
    const first = await request(mw, "GET", "/links");
    expect(first.status).toBe(200);
    expect(first.json.hermes).toEqual({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] });
    expect(first.json.agent_calls.count).toBe(0);
    const rec = await request(mw, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: { query: "anything" } } });
    expect(rec.status).toBe(200);
    const after = await request(mw, "GET", "/links");
    expect(after.json.agent_calls).toMatchObject({ count: 1, last_tool: "recall" });
  }, 30_000);
  test("a copy without links leaves the route to the next handler", async () => {
    const h = await setup({ proxy: true });
    const mw = memoryMiddleware({ api: () => h.api, principalFor: () => agent, tokenOk: () => false });
    expect((await request(mw, "GET", "/links")).status).toBe(404);
  }, 30_000);
});
