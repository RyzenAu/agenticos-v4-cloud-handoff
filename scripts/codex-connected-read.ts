import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { installedCodex } from "./account-discovery";
import { commandLaunch, terminateChild, type PlatformOptions } from "./assistant-runtime";
import { cliHomeGuard } from "./cli-home-guard";

// Deliberately not a general tool proxy. There are no writes, prompts, model turns or credential copies.
export const CONNECTED_READ_TOOLS = new Set([
  "gmail.get_profile", "gmail.search_emails", "gmail.read_email", "gmail.list_labels",
  "google_calendar.get_profile", "google_calendar.list_calendars", "google_calendar.search_events",
  "microsoft_outlook_email.get_profile", "microsoft_outlook_email.get_recent_emails", "microsoft_outlook_email.fetch_message",
  "slack.slack_list_workspaces", "slack.slack_search_public_and_private",
  "mercury.getAccounts", "mercury.listTransactions", "granola.get_account_info", "granola.list_meetings", "granola.get_meetings",
  "notion.notion-list-recent-pages", "notion.fetch",
]);
export type ConnectedTool = { name: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; _meta?: any };
const record = (v: any) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
export function unwrapConnectedRead(value: any, allowText = false) {
  if (value?.isError) throw new Error("The connected app could not complete this read. Check its connection in Codex.");
  if (value?.structuredContent && typeof value.structuredContent === "object") return value.structuredContent;
  for (const item of value?.content || []) if (item.type === "text") { try { return JSON.parse(item.text); } catch { /* Not structured provider data. */ } }
  if (allowText) { const text = (value?.content || []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n"); if (text) return { text }; }
  throw new Error("The connected app returned no readable data.");
}

/** A short-lived supported app-server session. Incoming permission requests fail closed. */
export async function withConnectedRead<T>(root: string, work: (client: { tools: Record<string, ConnectedTool>; call: (name: string, args: unknown) => Promise<any> }) => Promise<T>, options: PlatformOptions & { callTimeoutMs?: number; binary?: string; launch?: typeof spawn; timeoutMs?: number } = {}): Promise<T> {
  const platform = { platform: options.platform, env: options.env };
  const binary = options.binary || installedCodex(undefined, undefined, platform);
  if (!binary) throw new Error("Install and sign in to Codex to use its existing connections.");
  // F3-26: a preview or quiet copy with a synthetic home must not reach the owner's accounts through Codex's
  // credential store: it runs on the copy's own CODEX_HOME with a file store (normally signed out), or not at all.
  const home = cliHomeGuard("codex", options.env ?? process.env);
  if (!home.ok) throw new Error(home.reason);
  // A Windows npm shim (codex.cmd) only runs through cmd.exe; a native binary starts directly.
  const launch = commandLaunch(binary, ["app-server", "--stdio", ...home.args], platform);
  const child = (options.launch || spawn)(launch.file, launch.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments, env: { ...home.env, RUST_LOG: "error" } });
  let id = 0, bytes = 0, buffer = "", stopped = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const decoder = new StringDecoder("utf8");
  const stop = (message = "The Codex connection closed. Try refreshing again.") => {
    if (stopped) return; stopped = true;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)); } pending.clear();
    child.stdin.end(); terminateChild(child, "SIGTERM", platform);
    const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) terminateChild(child, "SIGKILL", platform); }, 300); kill.unref();
  };
  const lifetime = setTimeout(() => stop("The connected read timed out. Your saved data is unchanged."), options.timeoutMs ?? 240000);
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (stopped) { reject(new Error("The Codex connection closed.")); return; }
    // A slow answer fails this one read only; the session stays up for the reads that follow.
    const request = ++id, timer = setTimeout(() => { pending.delete(request); reject(new Error("Codex did not respond in time. Retry the connection.")); }, options.callTimeoutMs ?? 60000);
    pending.set(request, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: request, method, params }) + "\n");
  });
  child.stdout.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > 12 * 1024 * 1024) { stop("The connected read exceeded its response limit."); return; }
    buffer += decoder.write(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0 && !stopped) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      let reply: any; try { reply = JSON.parse(line); } catch { stop("Codex returned an unreadable response."); return; }
      if (reply.method) {
        if (reply.id !== undefined) stop("This app needs approval in Codex. Open its connection there, then retry.");
        continue;
      }
      const task = pending.get(reply.id); if (!task) continue;
      pending.delete(reply.id); clearTimeout(task.timer);
      if (reply.error) task.reject(new Error("Codex could not perform this supported read. Check your connection and Codex version."));
      else task.resolve(reply.result);
    }
  });
  child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) stop("Codex output exceeded its limit."); });
  child.on("error", () => stop("Codex could not start.")); child.on("close", () => stop()); child.stdin.on("error", () => stop());
  try {
    await rpc("initialize", { clientInfo: { name: "agentic_os_connected_read", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    await rpc("app/installed", { forceRefresh: true });
    const session = await rpc("thread/start", { cwd: root, ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
    const threadId = session?.thread?.id;
    if (typeof threadId !== "string") throw new Error("Codex did not start a read session.");
    const status = await rpc("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", limit: 50 });
    const tools = record(status?.data?.find((s: any) => s.name === "codex_apps")?.tools) as Record<string, ConnectedTool>;
    return await work({ tools, async call(name, args) {
      if (!CONNECTED_READ_TOOLS.has(name) || tools[name]?.annotations?.readOnlyHint !== true || tools[name]?.annotations?.destructiveHint === true) throw new Error("This read is not available through your Codex connection.");
      return unwrapConnectedRead(await rpc("mcpServer/tool/call", { threadId, server: "codex_apps", tool: name, arguments: args }), name.startsWith("granola."));
    } });
  } finally { clearTimeout(lifetime); stop(); }
}
