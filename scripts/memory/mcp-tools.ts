/**
 * Which tool names the OS memory MCP endpoint (/__memory/mcp) serves, and how any other name a client
 * (Hermes' include list, Claude Code) asks for is classed (L7, 29 Sep 2026: "the knowledge graph
 * doesn't connect with Hermes"). Pure: no I/O, imported by mcp.ts (dispatch) and links.ts (status).
 *
 *   served     the OS answers it. Writes are only remember / save_to_vault (screened, writer-capability
 *              checked in the Hindsight client); forget only ASKS. Everything else served here is READ
 *              ONLY: it reads the same rows the Memory page already lists, current ones only.
 *   withheld   a write or admin/destructive verb (delete_*, clear_*, create_*, update_*, retain, reflect,
 *              import/export ...) that the OS deliberately does not offer. Never mapped to anything: an
 *              agent has no second way to write or reconfigure the bank.
 *   missing    anything else the OS does not have: a real gap.
 */

/** The four tools the endpoint has always had. The only ones that can write (or ask to forget). */
export const CORE_TOOLS = ["remember", "save_to_vault", "recall", "forget"] as const;

/**
 * Read-only tools, named as Hindsight's MCP names them so a client written for Hindsight keeps working
 * when it is pointed at the OS. Each is answered from the OS' own index (never from Hindsight directly).
 */
export const READ_TOOLS = [
  "search_knowledge_base", // recall, under Hindsight's name
  "list_memories",
  "get_memory",
  "list_documents",
  "get_document",
  "get_knowledge_page", // a document, under Hindsight's name
  "get_knowledge_base_tree",
  "list_tags",
  "get_bank",
  "list_operations",
  "get_operation",
  "list_mental_models",
  "get_mental_model",
  "list_directives",
] as const;

export const SERVED_TOOLS: readonly string[] = [...CORE_TOOLS, ...READ_TOOLS];

/** The tools that may change something (or ask to). Everything in READ_TOOLS must stay out of this list. */
export const WRITING_TOOLS: readonly string[] = ["remember", "save_to_vault", "forget"];

/**
 * A verb that writes, deletes or reconfigures. Matched on the first word of the name, so delete_bank,
 * clear_memories, create_directive, update_bank, retain, reflect, import_bank ... are all withheld.
 * `forget` is not here: it is served (as an ask).
 */
const WITHHELD = /^(delete|clear|remove|purge|reset|drop|create|update|set|patch|edit|add|import|export|clone|transfer|merge|reprocess|retry|cancel|refresh|reflect|consolidate|regenerate|configure|retain|write|invalidate|restore|backup|upsert|put|post)(_|$)/;

export type ToolClass = "served" | "withheld" | "missing";

export function classifyTool(name: string): ToolClass {
  if (SERVED_TOOLS.includes(name)) return "served";
  return WITHHELD.test(name) ? "withheld" : "missing";
}

/** Letters and underscores only, short: safe to show. Anything else (a key pasted in by mistake) is counted, never echoed. */
const SAFE_NAME = /^[a-z]+(_[a-z]+){0,4}$/;

export type ToolCoverage = {
  served: number;
  /** Write/admin tools the OS deliberately does not offer. */
  withheld: number;
  /** Real gaps: tools the OS neither serves nor deliberately withholds. */
  missing: number;
  /** Up to 6 of the missing names that are plain tool names; the rest are only counted. */
  missing_names: string[];
};

export function toolCoverage(asked: readonly string[]): ToolCoverage {
  const names = [...new Set(asked)];
  const out: ToolCoverage = { served: 0, withheld: 0, missing: 0, missing_names: [] };
  for (const name of names) {
    const c = classifyTool(name);
    if (c === "served") out.served++;
    else if (c === "withheld") out.withheld++;
    else {
      out.missing++;
      if (out.missing_names.length < 6 && name.length <= 40 && SAFE_NAME.test(name)) out.missing_names.push(name);
    }
  }
  return out;
}
