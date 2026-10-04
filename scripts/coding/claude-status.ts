import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cliHomeGuard } from "../cli-home-guard";
import { runCapture } from "../nonblocking-exec";
import type { AccountsConfig, ClaudeSlotConfig, ClaudeSlotState } from "./accounts";
import type { ClaudeAccountSlot } from "./contracts";

/**
 * Is each configured Claude login actually signed in? (30 Sep 2026, second Max 20x account.)
 *
 * The ONLY evidence accepted is `claude auth status` run by the real claude.exe on that slot's own
 * profile (CLAUDE_CONFIG_DIR, or the default ~/.claude for claude:max), reporting loggedIn with a
 * claude.ai subscription login. A folder existing, a Claude.ai browser session or an API key does not
 * count. The email and organisation are never kept or shown; only a one-way digest of them is held in
 * memory so two slots signed in to the SAME account are reported instead of being counted twice.
 */

export type ClaudeSlotStatus = ClaudeSlotState & {
  /** Plan Claude Code reports for the login ("max", "pro"…), or null when not signed in / unknown. */
  subscription: string | null;
  checkedAt: string | null;
  /** Another slot that is signed in to the same Claude account (owner should sign this one in again). */
  sameAccountAs: ClaudeAccountSlot | null;
};

/** The environment a Claude child runs with for this slot: its own profile and nothing else. */
export function claudeSlotEnv(slot: Pick<ClaudeSlotConfig, "configDir">, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) if (k.toLowerCase() === "claude_config_dir") delete env[k];
  if (slot.configDir) env.CLAUDE_CONFIG_DIR = slot.configDir;
  return env;
}

type Probe = (binary: string, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; stdout: string }>;

const defaultProbe: Probe = async (binary, env) => {
  const r = await runCapture(binary, ["auth", "status"], { timeout: 15_000, env });
  return { ok: !r.error, stdout: r.stdout };
};

/** Parse `claude auth status` JSON. Identity fields are reduced to a digest here and dropped. */
export function parseAuthStatus(stdout: string): { connected: boolean; reason: string | null; subscription: string | null; identity: string | null } {
  let j: Record<string, unknown>;
  try { j = JSON.parse(stdout); } catch { return { connected: false, reason: "Claude Code returned an unreadable sign-in status", subscription: null, identity: null }; }
  if (j.loggedIn !== true) return { connected: false, reason: "not signed in on this profile", subscription: null, identity: null };
  if (j.authMethod !== "claude.ai") return { connected: false, reason: `signed in with ${String(j.authMethod ?? "an unknown method")}, not a Claude subscription`, subscription: null, identity: null };
  const who = [j.email, j.orgId].filter((v) => typeof v === "string" && v).join("|");
  return {
    connected: true,
    reason: null,
    subscription: typeof j.subscriptionType === "string" ? j.subscriptionType : null,
    identity: who ? createHash("sha256").update(who).digest("hex").slice(0, 16) : null,
  };
}

const TTL_MS = 5 * 60_000;

export function claudeStatusService(options: { accounts: () => AccountsConfig; binary: () => string | undefined | Promise<string | undefined>; probe?: Probe; env?: NodeJS.ProcessEnv; now?: () => number }) {
  const cache = new Map<ClaudeAccountSlot, ClaudeSlotStatus & { identity: string | null; at: number }>();
  const inflight = new Map<ClaudeAccountSlot, Promise<void>>();
  const now = options.now ?? Date.now;

  async function check(cfg: ClaudeSlotConfig): Promise<void> {
    const at = now();
    const put = (s: Omit<ClaudeSlotStatus, "slot" | "checkedAt" | "sameAccountAs">, identity: string | null) =>
      cache.set(cfg.slot, { slot: cfg.slot, ...s, checkedAt: new Date(at).toISOString(), sameAccountAs: null, identity, at });
    if (cfg.configDir && !existsSync(cfg.configDir)) return void put({ connected: false, reason: "its profile folder doesn't exist yet", subscription: null }, null);
    const binary = await options.binary();
    if (!binary) return void put({ connected: null, reason: "Claude Code isn't installed", subscription: null }, null);
    const home = cliHomeGuard("claude", options.env ?? process.env);
    if (!home.ok) return void put({ connected: null, reason: home.reason, subscription: null }, null);
    // A preview/quiet copy never probes the owner's profiles (cliHomeGuard); the live server probes each slot's own.
    if (home.copy) return void put({ connected: null, reason: "not checked here: a preview copy or test hub never reads the owner's logins unless it was started to use them on purpose", subscription: null }, null);
    const r = await (options.probe ?? defaultProbe)(binary, claudeSlotEnv(cfg, home.env));
    if (!r.ok && !r.stdout.trim()) return void put({ connected: null, reason: "Claude Code didn't answer the sign-in check", subscription: null }, null);
    const p = parseAuthStatus(r.stdout);
    put({ connected: p.connected, reason: p.reason, subscription: p.subscription }, p.identity);
  }

  /** Refresh stale slots (at most one probe per slot at a time). */
  async function refresh(force = false): Promise<void> {
    const config = options.accounts();
    await Promise.all(config.claude.map((cfg) => {
      const c = cache.get(cfg.slot);
      if (!force && c && now() - c.at < TTL_MS) return Promise.resolve();
      let p = inflight.get(cfg.slot);
      if (!p) { p = check(cfg).catch(() => undefined).finally(() => inflight.delete(cfg.slot)); inflight.set(cfg.slot, p); }
      return p;
    }));
  }

  /** What is known now (never blocks): unknown until a check has run. */
  function current(): ClaudeSlotStatus[] {
    const config = options.accounts();
    const rows = config.claude.map((cfg): ClaudeSlotStatus & { identity: string | null } => {
      const c = cache.get(cfg.slot);
      return c && (cfg.configDir === null || existsSync(cfg.configDir) || c.connected === false)
        ? { ...c }
        : { slot: cfg.slot, connected: null, reason: "not checked yet", subscription: null, checkedAt: null, sameAccountAs: null, identity: null };
    });
    // Two profiles signed in to one Claude account: the later slot is not a second account.
    for (const [i, r] of rows.entries()) {
      if (!r.connected || !r.identity) continue;
      const first = rows.slice(0, i).find((o) => o.connected && o.identity === r.identity);
      if (first) { r.sameAccountAs = first.slot; r.connected = false; r.reason = `signed in to the same Claude account as ${first.slot}, so it isn't a second account`; }
    }
    return rows.map(({ identity: _i, ...rest }) => rest);
  }

  return { refresh, current, forget: (slot: ClaudeAccountSlot) => cache.delete(slot) };
}
