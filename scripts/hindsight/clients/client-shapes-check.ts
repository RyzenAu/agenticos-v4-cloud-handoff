/**
 * Client config shapes against a SYNTHETIC AgenticOS (a quiet copy with its own vault and Hindsight),
 * without applying anything (REVIEW-STAGE-D B3 wiring).
 *
 * It rebuilds the exact entries connect-clients.ps1 writes (it never reads or edits the real
 * ~/.claude.json, the hindsight-ask SKILL.md or Hermes' config.yaml) and makes real requests with them:
 *
 *   claude  mcpServers.hindsight = { type: "http", url: "http://127.0.0.1:<os>/__memory/mcp" }, no headers
 *   hermes  mcp_servers.hindsight = { url: same, tools.include: [recall, remember, save_to_vault, forget] }
 *   skill   the SKILL.md curl form: POST <os>/__memory/recall, no key, no header, Git Bash curl
 *
 * For the MCP shapes it speaks streamable-HTTP MCP as a client would: initialize, notifications/
 * initialized, tools/list (the tools the entry needs are there; no update/delete tool is), then
 * remember and recall. It also checks that a save is visible to AgenticOS (GET /__memory/items) with its
 * processing model, and that a password is refused. Prints JSON; there is no key to print.
 *
 *   bun scripts/hindsight/clients/client-shapes-check.ts --os-port 8095
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const arg = (n: string, f: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : f;
};
const OS_PORT = Number(arg("os-port", "8095"));
if (OS_PORT === 8081) throw new Error("This check runs against a synthetic copy, never the live OS.");
const OS = `http://127.0.0.1:${OS_PORT}`;
const URL_ = `${OS}/__memory/mcp`;

const SHAPES = {
  claude: { type: "http", url: URL_ },
  hermes: { url: URL_, tools: { include: ["recall", "remember", "save_to_vault", "forget"] } },
} as const;
const FORBIDDEN = ["update_memory", "invalidate_memory", "sync_retain", "delete_bank", "clear_memories", "delete_document", "correct"];

async function rpc(method: string, params?: unknown, id?: number) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const toolResult = (r: { json: any }) => JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");

async function mcpShape(name: "claude" | "hermes") {
  const entry = SHAPES[name];
  const canary = `Kestrel${randomBytes(3).toString("hex")}`;
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: `stage-d-${name}-shape`, version: "1" } }, 1);
  await rpc("notifications/initialized", {});
  const tools: string[] = ((await rpc("tools/list", {}, 2)).json?.result?.tools ?? []).map((t: { name: string }) => t.name);
  const needed = name === "hermes" ? [...SHAPES.hermes.tools.include] : ["remember", "recall"];
  const saved = toolResult(await rpc("tools/call", { name: "remember", arguments: { text: `The ${canary} test ${name === "claude" ? "clinic" : "garage"} opens at ${name === "claude" ? "7am" : "9am"}.` } }, 3));
  const recalled = toolResult(await rpc("tools/call", { name: "recall", arguments: { query: `When does the ${canary} test ${name === "claude" ? "clinic" : "garage"} open?` } }, 4));
  const secret = toolResult(await rpc("tools/call", { name: "remember", arguments: { text: `The ${canary} wifi password is correcthorsebatterystaple` } }, 5));
  const item = saved.id ? await (await fetch(`${OS}/__memory/item/${saved.id}`)).json() : null;
  return {
    client: name,
    entry,
    initialize: init.status,
    server: init.json?.result?.serverInfo?.name ?? null,
    tools_present: needed.every((t) => tools.includes(t)),
    rewrite_or_delete_tools_exposed: FORBIDDEN.filter((t) => tools.includes(t)),
    save: { ok: saved.ok, id: saved.id ?? null },
    visible_in_os: item?.row?.id === saved.id,
    processed_by: item?.row?.processed_by ? `${item.row.processed_by.provider}/${item.row.processed_by.model}` : null,
    recall_found_canary: JSON.stringify(recalled).toLowerCase().includes(canary.toLowerCase()),
    recall_source: recalled.facts?.[0]?.source ?? null,
    password_refused: secret.ok === false && secret.code === "prohibited-content",
    canary,
  };
}

function skillShape(canary: string) {
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const run = (cmd: string) => spawnSync(bash, ["-c", cmd], { encoding: "utf8", windowsHide: true, timeout: 300_000 }).stdout.trim();
  const health = run(`curl -s -o /dev/null -w "%{http_code}" ${OS}/__memory/status`);
  const out = run(`curl -s -X POST ${OS}/__memory/recall -H "Content-Type: application/json" -d '{"query": "When does the ${canary} test clinic open?", "max_tokens": 400}'`);
  let facts: { text?: string; source?: unknown }[] = [];
  try {
    facts = JSON.parse(out).facts ?? [];
  } catch {
    /* reported below */
  }
  return { client: "skill", form: "curl, no key, no header", health_http: health, recall_results: facts.length, recall_found_canary: facts.some((f) => (f.text ?? "").toLowerCase().includes(canary.toLowerCase())) };
}

const claude = await mcpShape("claude");
const hermes = await mcpShape("hermes");
const out = { os: `127.0.0.1:${OS_PORT}`, at: new Date().toISOString(), results: [claude, hermes, skillShape(claude.canary)] };
console.log(JSON.stringify(out, null, 2));
