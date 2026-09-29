/**
 * The memory MCP endpoint for agents (REVIEW-STAGE-D B3): POST /__memory/mcp.
 *
 * Claude Code, Hermes and the hindsight-ask skill save and recall HERE instead of writing straight into
 * the shared Hindsight bank, so every save is screened (guard.ts), visible on the Memory page and to
 * Jarvis, forgettable through the approval path, and has its processing model recorded. The Hindsight
 * proxy lets them read only.
 *
 * Streamable-HTTP MCP, JSON responses only (no SSE stream, no session state): initialize,
 * notifications/*, ping, tools/list, tools/call. Tools:
 *   remember       { text, title?, bucket? }   a Hindsight memory (mem-…), provenance "agent"
 *   save_to_vault  { text, title?, bucket? }   a fact in the bucket's Obsidian note, then indexed
 *   recall         { query }                    facts with their sources (vault path or mem- id)
 *   forget         { id }                       ASKS: either founder's spoken yes, or the code sent to the requester's Telegram DM; runs then
 * There is deliberately no correct/update/invalidate tool: an agent can't rewrite a stored fact.
 *
 * Read-only extras (L7, so Hermes' Hindsight-style include list works): search_knowledge_base, list_memories,
 * get_memory, list_documents, get_document, get_knowledge_page, get_knowledge_base_tree, list_tags, get_bank,
 * list_operations, get_operation, list_mental_models, get_mental_model, list_directives. They read the OS' own
 * index (current rows only). Write/admin verbs (delete_*, clear_*, create_*, update_*, retain, reflect ...) are
 * refused by name ("not-offered") and never mapped onto remember/save_to_vault. See mcp-tools.ts.
 */
import type { MemoryApi } from "./api";
import { classifyTool, CORE_TOOLS, READ_TOOLS } from "./mcp-tools";
import { BUCKETS, isBucket, type Principal } from "./types";

const BUCKET_ENUM = { type: "string", enum: [...BUCKETS] } as const;
const LIMITS = { limit: { type: "integer", description: "At most this many (default 20, max 50)." }, offset: { type: "integer" } } as const;

/**
 * Read-only tools (L7, 29 Sep 2026), named as Hindsight's MCP names them so Hermes' include list works
 * unchanged. Each answers from the OS' own index, current rows only, and none can write, delete or
 * reconfigure anything. There is deliberately no delete_*, clear_*, create_* or update_* tool.
 */
const READ_TOOL_DEFS = [
  { name: "search_knowledge_base", description: "Search saved knowledge (same as recall). Name each source in the answer.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "list_memories", description: "List saved memories and facts (newest first), optionally by bucket or a search phrase. Read only.", inputSchema: { type: "object", properties: { bucket: BUCKET_ENUM, query: { type: "string" }, ...LIMITS } } },
  { name: "get_memory", description: "Read one saved memory or fact by id. Read only.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_documents", description: "List the vault notes and saved vault facts (newest first). Read only.", inputSchema: { type: "object", properties: { bucket: BUCKET_ENUM, query: { type: "string" }, ...LIMITS } } },
  { name: "get_document", description: "Read one vault note or vault fact by id or path (an excerpt of a long note). Read only.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "get_knowledge_page", description: "Read one knowledge page: a vault note or fact, by id or path (same as get_document). Read only.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "get_knowledge_base_tree", description: "The knowledge base by bucket: how many items each holds and the first few titles. Read only.", inputSchema: { type: "object", properties: {} } },
  { name: "list_tags", description: "The buckets (tags) with how many current items each holds. Read only.", inputSchema: { type: "object", properties: {} } },
  { name: "get_bank", description: "A summary of AgenticOS' shared memory: item counts and whether saving is on. No settings, paths or keys. Read only.", inputSchema: { type: "object", properties: {} } },
  { name: "list_operations", description: "Background operations. AgenticOS saves finish before they return, so this is always empty. Read only.", inputSchema: { type: "object", properties: {} } },
  { name: "get_operation", description: "One background operation by id. AgenticOS has none, so this is always not-found. Read only.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_mental_models", description: "Generated summaries. AgenticOS keeps none (use recall), so this is always empty. Read only.", inputSchema: { type: "object", properties: {} } },
  { name: "get_mental_model", description: "One generated summary by id. AgenticOS keeps none, so this is always not-found. Read only.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_directives", description: "Standing directives. AgenticOS has none for agents to read or change, so this is always empty. Read only.", inputSchema: { type: "object", properties: {} } },
] as const;

export const MCP_TOOLS = [
  {
    name: "remember",
    description: "Keep ONE short fact the user asked you to remember, in AgenticOS' shared memory (Hindsight). Never passwords, keys, bank or card details, TFNs or codes: they are refused.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The fact, one or two sentences." }, title: { type: "string" }, bucket: { type: "string", enum: ["business", "finance", "deen", "research", "personal", "general"] } },
      required: ["text"],
    },
  },
  {
    name: "save_to_vault",
    description: "Save ONE curated fact into the Obsidian vault (and index it), when the user says to save it to the vault.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, title: { type: "string" }, bucket: { type: "string", enum: ["business", "finance", "deen", "research", "personal", "general"] } },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description: "Look up saved knowledge. Answer only from what comes back and name each source (vault note path or memory id).",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "forget",
    description:
      "Ask to forget one saved item (by id). This only REQUESTS it: either founder approves by saying yes to Jarvis, or the requester answers the one-time code sent to their Telegram DM, and it runs when approved. You can't approve it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  ...READ_TOOL_DEFS,
] as const;

/** mcp.test.ts asserts these agree with mcp-tools.ts (the names the status logic counts as served). */
export const ADVERTISED_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const count = (v: unknown, dflt: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : dflt);
type Row = ReturnType<MemoryApi["readable"]>[number];
const srcOf = (r: Row) => (r.source.kind === "vault" ? r.source.path : r.source.id);
const brief = (r: Row) => ({ id: r.id, kind: r.kind, title: r.title, bucket: r.bucket, text: clip(r.text, 300), source: srcOf(r), date: r.date });
/** A tool name echoed back to the caller: plain characters only, at most 40. */
const plainName = (n: string) => clip(n.replace(/[^A-Za-z0-9_.-]/g, "?"), 40);
const UNAVAILABLE = { ok: false, code: "unavailable", message: "Memory can't be read right now." };

/**
 * A read of one stored item. Only what api.readable() lists (connector.desired(): current, not tombstoned, not
 * path-excluded) can be read by id, exactly the list tools' rule; no history, no superseded or forgotten text.
 * Any error reads as not-found (fail closed).
 */
function readOne(api: MemoryApi, id: string, want: "any" | "vault") {
  const notFound = { ok: false, code: "not-found", message: "Nothing current is saved under that id." };
  let r: Row | null;
  try {
    r = id ? api.readableOne(id) : null;
  } catch {
    return notFound;
  }
  if (!r) return notFound;
  if (want === "vault" && r.kind === "memory") return { ok: false, code: "not-a-document", message: "That id is a memory, not a vault note or fact. Use get_memory." };
  return { ok: true, [want === "vault" ? "document" : "memory"]: { id: r.id, kind: r.kind, title: r.title, bucket: r.bucket, text: r.text, source: srcOf(r), version: r.version, date: r.date } };
}

function readList(api: MemoryApi, args: Record<string, unknown>, vaultOnly: boolean) {
  const bucket = isBucket(args.bucket) ? args.bucket : undefined;
  const q = s(args.query).slice(0, 200).trim();
  let rows: Row[];
  try {
    rows = api.readable({ bucket, q: q || undefined, vaultOnly });
  } catch {
    return UNAVAILABLE;
  }
  const limit = Math.max(1, count(args.limit, 20, 50));
  const offset = Math.min(count(args.offset, 0, 100_000), rows.length);
  const page = rows.slice(offset, offset + limit);
  return { ok: true, total: rows.length, items: page.map(brief), next_offset: offset + page.length < rows.length ? offset + page.length : null };
}

/** All current rows for the summary tools (one desired() pass), or null on any error. */
function allRows(api: MemoryApi): Row[] | null {
  try {
    return api.readable({});
  } catch {
    return null;
  }
}

/** The tools that scan every current row: at most this many per request (batch), so one call can't loop the index. */
const SCAN_TOOLS: readonly string[] = ["list_memories", "list_documents", "list_tags", "get_bank", "get_knowledge_base_tree"];
const MAX_SCANS_PER_REQUEST = 4;
const NO_SUMMARIES = "AgenticOS keeps no generated summaries or standing directives for agents. Use recall or list_memories.";

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const s = (v: unknown) => (typeof v === "string" ? v : "");

async function callTool(api: MemoryApi, p: Principal, name: string, args: Record<string, unknown>, client: string) {
  const bucket = isBucket(args.bucket) ? args.bucket : undefined;
  const note = `via ${client}`.slice(0, 200);
  switch (name) {
    case "remember": {
      const r = await api.remember(p, { text: s(args.text), title: s(args.title) || undefined, bucket, channel: "agent", note });
      return r.ok ? { ok: true, id: r.memory.id, message: r.message } : { ok: false, code: r.code, message: r.message };
    }
    case "save_to_vault": {
      const r = await api.saveToVault(p, { text: s(args.text), title: s(args.title) || undefined, bucket, channel: "agent", note });
      return r.ok ? { ok: true, id: r.fact.wiki_ref, path: r.fact.source.path, message: r.message } : { ok: false, code: r.code, message: r.message };
    }
    case "list_memories":
      return readList(api, args, false);
    case "list_documents":
      return readList(api, args, true);
    case "get_memory":
      return readOne(api, s(args.id), "any");
    case "get_document":
    case "get_knowledge_page":
      return readOne(api, s(args.id), "vault");
    case "list_tags": {
      const rows = allRows(api);
      if (!rows) return UNAVAILABLE;
      return { ok: true, tags: BUCKETS.map((tag) => ({ tag, items: rows.filter((r) => r.bucket === tag).length })) };
    }
    case "get_bank": {
      const rows = allRows(api);
      if (!rows) return UNAVAILABLE;
      const by = (k: string) => rows.filter((r) => r.kind === k).length;
      return { ok: true, bank: { name: "AgenticOS shared memory", saving: api.settings.writes ? "on" : "off", items: rows.length, notes: by("note"), facts: by("fact"), memories: by("memory") } };
    }
    case "get_knowledge_base_tree": {
      const rows = allRows(api);
      if (!rows) return UNAVAILABLE;
      return { ok: true, buckets: BUCKETS.map((bucket) => { const own = rows.filter((r) => r.bucket === bucket); return { bucket, items: own.length, first: own.slice(0, 25).map((r) => ({ id: r.id, kind: r.kind, title: r.title })) }; }) };
    }
    case "list_operations":
      return { ok: true, operations: [], note: "AgenticOS saves finish before they return, so nothing is queued." };
    case "list_mental_models":
      return { ok: true, mental_models: [], note: NO_SUMMARIES };
    case "list_directives":
      return { ok: true, directives: [], note: NO_SUMMARIES };
    case "get_operation":
    case "get_mental_model":
      return { ok: false, code: "not-found", message: name === "get_operation" ? "AgenticOS has no background operations." : NO_SUMMARIES };
    case "search_knowledge_base":
    case "recall": {
      const r = await api.recall(p, s(args.query));
      return {
        ok: true,
        facts: r.facts.map((f) => ({ id: f.id, text: f.text, source: f.source.kind === "vault" ? f.source.path : f.source.id, date: f.date })),
        instruction: r.facts.length ? "Answer only from these and name the source of each." : "Nothing saved. Say so; do not guess.",
      };
    }
    case "forget": {
      const id = s(args.id);
      const kind = id.startsWith("mem-") ? "memory" : "full";
      const r = await api.forget(p, { kind, target: id });
      if (!r.ok && r.code === "approval-required")
        // r.message already says how it's approved (either founder's spoken yes, or the code sent to the requester's DM);
        // the server runs it as soon as it's approved. The approval id is not handed to the agent.
        return { ok: false, code: "approval-required", message: `${r.message} You can't approve it, and a click on the Memory page can't either. Don't ask again: it is already waiting.` };
      return r.ok ? { ok: true, message: r.message } : { ok: false, code: r.code, message: r.message };
    }
    default:
      // A write or admin verb (delete_*, clear_*, create_*, update_*, retain, reflect ...) is refused by name,
      // never mapped onto anything: the only ways to write are remember / save_to_vault (screened), and forget asks.
      if (classifyTool(name) === "withheld")
        return { ok: false, code: "not-offered", message: `AgenticOS deliberately doesn't offer ${plainName(name)}: agents can't change or reconfigure memory. To save use remember or save_to_vault; to remove something use forget, which asks a person to approve.` };
      return null;
  }
}

/** Handle one JSON-RPC message (or a batch). Returns the response body, or null for notifications only. */
export async function handleMcp(api: MemoryApi, p: Principal, body: unknown, client: string): Promise<unknown> {
  let scans = 0; // counted synchronously as each message starts, so the cap is deterministic within a batch
  const one = async (m: Rpc) => {
    const id = m?.id ?? null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!m || typeof m !== "object" || typeof m.method !== "string") return err(-32600, "Invalid request");
    if (m.method.startsWith("notifications/")) return null;
    if (m.method === "initialize")
      return ok({
        protocolVersion: s(m.params?.protocolVersion) || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentic-os-memory", version: "1" },
        instructions: "AgenticOS shared memory: remember, save_to_vault, recall; forget only asks. Saves are screened and visible in AgenticOS.",
      });
    if (m.method === "ping") return ok({});
    if (m.method === "tools/list") return ok({ tools: MCP_TOOLS });
    if (m.method === "tools/call") {
      const name = s(m.params?.name);
      const args = (m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {}) as Record<string, unknown>;
      if (SCAN_TOOLS.includes(name) && ++scans > MAX_SCANS_PER_REQUEST) return err(-32000, `Too many list calls in one request (at most ${MAX_SCANS_PER_REQUEST}); send them separately.`);
      const r = await callTool(api, p, name, args, client);
      if (!r) return err(-32602, `Unknown tool: ${plainName(name)}`);
      return ok({ content: [{ type: "text", text: JSON.stringify(r) }], isError: r.ok === false });
    }
    return err(-32601, `Method not found: ${m.method}`);
  };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map((m) => one(m as Rpc)))).filter(Boolean);
    return out.length ? out : null;
  }
  return one(body as Rpc);
}
