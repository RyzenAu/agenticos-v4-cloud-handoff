/**
 * GET /__memory/links: how the agents are wired to this memory (W-D, 29 Sep 2026: "the knowledge
 * graph doesn't connect with Hermes"). Read only and cheap:
 *
 *   hermes.configured   Hermes' config.yaml has an MCP server whose url ends in /__memory/mcp
 *   hermes.port_matches that url's port is THIS server's port (null when unknown)
 *   agent_calls         the last agent tool call this server answered on /__memory/mcp: when, and
 *                       which tool (never the text, the caller or anything it returned)
 *
 * Nothing from the config is returned but those booleans and tool-name counts (plus up to 6 plain,
 * letters-and-underscores names of tools the OS lacks): no url, path, key or other value. The
 * config is read at most once per mtime change (a stat per request, no spawn).
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SERVED_TOOLS, toolCoverage } from "./mcp-tools";

/** The tools /__memory/mcp actually offers (mcp.ts, classed in mcp-tools.ts). */
export const MEMORY_MCP_TOOLS = SERVED_TOOLS;

export type HermesLink =
  | {
      checked: true;
      configured: boolean;
      port_matches: boolean | null;
      /** Tool names in Hermes' include list that the OS answers. */
      served_tools: number;
      /** Write/admin tools in the list (delete_*, clear_*, create_* ...) that the OS deliberately does not offer: not a fault. */
      withheld_tools: number;
      /** Real gaps: tools the OS neither serves nor deliberately withholds. */
      missing_tools: number;
      /** Up to 6 of the missing names, when they are plain tool names (never any other config value). */
      missing_names: string[];
    }
  | { checked: false; configured: null; port_matches: null; reason: "no-config" | "unreadable" };

export type LinksView = {
  hermes: HermesLink;
  agent_calls: { count: number; last_at: string | null; last_tool: string | null; since: string };
  as_of: string;
};

/** Where Hermes keeps config.yaml: HERMES_HOME, then ~/.hermes, then %LOCALAPPDATA%\hermes (Windows). */
export function hermesConfigCandidates(env: Record<string, string | undefined>, home = homedir()) {
  const out: string[] = [];
  if (env.HERMES_HOME?.trim()) out.push(join(env.HERMES_HOME.trim(), "config.yaml"));
  out.push(join(env.HOME?.trim() || env.USERPROFILE?.trim() || home, ".hermes", "config.yaml"));
  if (env.LOCALAPPDATA?.trim()) out.push(join(env.LOCALAPPDATA.trim(), "hermes", "config.yaml"));
  return out;
}

/**
 * Does this config.yaml point an MCP server at an OS memory endpoint? Only lines inside the
 * top-level `mcp_servers:` block count; returns the port of the first match (or null if none).
 */
export function memoryMcpPort(yaml: string): { found: boolean; port: number | null; tools: string[] } {
  // Split the top-level mcp_servers block into its server entries (one indent level down).
  const entries: string[][] = [];
  let inBlock = false;
  let entryIndent = -1;
  for (const raw of yaml.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      inBlock = /^mcp_servers\s*:/.test(raw);
      entryIndent = -1;
      continue;
    }
    if (!inBlock || !raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    if (entryIndent < 0) entryIndent = indent;
    if (indent === entryIndent) entries.push([raw]);
    else entries[entries.length - 1]?.push(raw);
  }
  for (const entry of entries) {
    const urlLine = entry.map((l) => /^\s+url\s*:\s*["']?([^"'\s#]+)/.exec(l)).find(Boolean);
    if (!urlLine || !/\/__memory\/mcp\/?$/.test(urlLine[1])) continue;
    const port = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\//i.exec(urlLine[1]);
    // tools: include: [a, b]  or  include:\n - a\n - b
    const tools: string[] = [];
    const at = entry.findIndex((l) => /^\s+include\s*:/.test(l));
    if (at >= 0) {
      const inline = /include\s*:\s*\[([^\]]*)\]/.exec(entry[at]);
      if (inline) tools.push(...inline[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
      else for (const l of entry.slice(at + 1)) {
        const item = /^\s+-\s*["']?([^"'\s#]+)/.exec(l);
        if (!item) break;
        tools.push(item[1]);
      }
    }
    return { found: true, port: port ? Number(port[1]) : null, tools };
  }
  return { found: false, port: null, tools: [] };
}

export function createLinks(options: { env?: Record<string, string | undefined>; port: () => number | null; now?: () => Date; home?: string }) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const since = now().toISOString();
  let calls = 0;
  let lastAt: string | null = null;
  let lastTool: string | null = null;
  let cache: { path: string; mtime: number; result: ReturnType<typeof memoryMcpPort> } | null = null;

  function hermes(): HermesLink {
    for (const path of hermesConfigCandidates(env, options.home)) {
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (!cache || cache.path !== path || cache.mtime !== mtime) {
        try {
          cache = { path, mtime, result: memoryMcpPort(readFileSync(path, "utf8")) };
        } catch {
          return { checked: false, configured: null, port_matches: null, reason: "unreadable" };
        }
      }
      const port = options.port();
      const cov = toolCoverage(cache.result.tools);
      return {
        checked: true,
        configured: cache.result.found,
        port_matches: cache.result.found && cache.result.port !== null && port !== null ? cache.result.port === port : null,
        served_tools: cov.served,
        withheld_tools: cov.withheld,
        missing_tools: cov.missing,
        missing_names: cov.missing_names,
      };
    }
    return { checked: false, configured: null, port_matches: null, reason: "no-config" };
  }

  return {
    /** Record the tool calls in one /__memory/mcp request (a single message or a batch). */
    recordRpc(rpc: unknown) {
      for (const m of Array.isArray(rpc) ? rpc : [rpc]) {
        const msg = m as { method?: unknown; params?: { name?: unknown } };
        if (msg?.method !== "tools/call") continue;
        const name = typeof msg.params?.name === "string" && /^[a-z_]{1,32}$/.test(msg.params.name) ? msg.params.name : "unknown";
        calls++;
        lastAt = now().toISOString();
        lastTool = name;
      }
    },
    view(): LinksView {
      return { hermes: hermes(), agent_calls: { count: calls, last_at: lastAt, last_tool: lastTool, since }, as_of: now().toISOString() };
    },
  };
}
export type MemoryLinks = ReturnType<typeof createLinks>;
