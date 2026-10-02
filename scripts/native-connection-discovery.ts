import { spawn } from "node:child_process";
import { assistantBinary, commandLaunch, terminateChild } from "./assistant-runtime";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existingConnectionDiscovery } from "./account-discovery";
import type { ConnectionDiscovery, ExistingAppConnection } from "../src/lib/operator";
import { dataDirFor } from "./cloud/data-dir";

/** Keep only names and CLI connection health; never retain server URLs or configuration. */
export function claudeConnectionMetadata(output: string): ExistingAppConnection[] {
  const apps: ExistingAppConnection[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9 _.-]{0,79}): .+ - (.+)$/);
    if (!match) continue;
    const health = /(?:✓|✔).*Connected|^Connected$/i.test(match[2]);
    apps.push({ id: "claude:" + match[1].trim().replaceAll(" ", "_"), name: match[1].trim(), harness: "claude", isAccessible: health, isEnabled: null, runtimeEnabled: null, callable: null, observed: true, directAuthorization: false });
    if (apps.length === 50) break;
  }
  return apps;
}
export function nativeConnectionDiscovery(root: string, options: NonNullable<Parameters<typeof existingConnectionDiscovery>[1]> & { claudeBinary?: string | null; claudeStart?: typeof spawn } = {}) {
  const codex = existingConnectionDiscovery(root, options);
  let cached: { at: number; apps: ExistingAppConnection[]; detail: string } | undefined;
  let pending: Promise<NonNullable<typeof cached>> | undefined;
  let cancel: (() => void) | undefined, stopped = false;
  async function claude(force = false) {
    if (!force && cached && Date.now() - cached.at < 60000) return cached;
    if (pending) return pending;
    const platform = { platform: options.platform, env: options.env };
    const binary = options.claudeBinary === undefined ? assistantBinary("claude", options.homeDir || homedir(), undefined, platform) : options.claudeBinary;
    if (!binary) return { at: Date.now(), apps: [], detail: "Claude Code was not found. Install it, sign in, then rescan." };
    pending = new Promise(resolve => {
      // claude.cmd (npm on Windows) only runs through cmd.exe; claude.exe and POSIX binaries start directly.
      const launch = commandLaunch(binary, ["mcp", "list"], platform);
      const child = (options.claudeStart || spawn)(launch.file, launch.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments, env: { ...process.env, NO_COLOR: "1" } });
      let output = "", bytes = 0, done = false;
      const finish = (detail: string, ok = false) => {
        if (done) return; done = true; clearTimeout(timer); terminateChild(child, "SIGTERM", platform); cancel = undefined;
        const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) terminateChild(child, "SIGKILL", platform); }, 300); kill.unref();
        resolve({ at: Date.now(), apps: ok ? claudeConnectionMetadata(output) : [], detail }); output = "";
      };
      const timer = setTimeout(() => finish("Claude connection check timed out. Check MCP status in Claude."), 12000);
      cancel = () => finish("Claude discovery stopped.");
      child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 262144) finish("Claude metadata exceeded its bounded limit."); else output += chunk.toString(); });
      child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 262144) finish("Claude metadata exceeded its bounded limit."); });
      child.on("error", () => finish("Claude connection check could not start."));
      child.on("close", code => finish(code === 0 ? "Claude MCP server health was checked. Tool permissions and callability must be verified inside your Claude task." : "Claude could not verify its MCP connections.", code === 0));
    });
    try { cached = await pending; return cached; } finally { pending = undefined; }
  }
  // GET /setup/connections answers with peek(): the last combined check, or "unchecked". It never
  // starts Codex (`codex app-server`) or Claude (`claude mcp list`) (T8c, lead decision). read() is the
  // check: POST /setup/connections/check (Check again, the setup scan). The last answer is kept on
  // disk (app names and health flags only) so a restart still has it.
  const file = join(dataDirFor(root), "setup-connections.json");
  let last: ConnectionDiscovery | undefined;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved?.version === 1 && Array.isArray(saved.apps) && typeof saved.checkedAt === "string") last = saved;
  } catch { /* never checked on this PC */ }
  const remember = (value: ConnectionDiscovery) => {
    last = value;
    try {
      mkdirSync(join(dataDirFor(root)), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      renameSync(tmp, file);
    } catch { /* the in-memory answer still stands */ }
  };
  return {
    async read(force = false) {
      if (stopped) return codex.read();
      const [native, mcp] = await Promise.all([codex.read(force), claude(force)]);
      const combined: ConnectionDiscovery = { ...native, apps: [...native.apps.map(app => ({ ...app, harness: "codex" as const })), ...mcp.apps], harnesses: [{ id: "codex", detail: native.detail }, { id: "claude", detail: mcp.detail }], detail: native.detail + " " + mcp.detail };
      remember(combined);
      return combined;
    },
    /** The last check as it was (an expired one shows as needing a fresh check), or "unchecked". Never spawns. */
    peek(): ConnectionDiscovery {
      if (last) return structuredClone(last);
      return { version: 1, harness: "codex", scope: "global", status: "unchecked", checkedAt: null, expiresAt: null, runtimeFresh: false, apps: [], truncated: false, detail: "Not checked yet. Use Check again to ask Codex and Claude which apps they can use." };
    },
    close() { stopped = true; codex.close(); cancel?.(); },
  };
}
