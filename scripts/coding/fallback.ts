import { claudeStopReason, type AccountsConfig } from "./accounts";
import type { AgentBinding, AllowanceSnapshot, ClaudeAccountSlot } from "./contracts";
import { CLAUDE_MODELS, claudeBinding, codexBinding, currentClaudeModel } from "./spec";

/**
 * Automatic, configured fallback between accounts and models (1 Oct 2026).
 *
 * The owner lists, in `coding-prefs.json`, where a role may move when its account is at its limit:
 *
 *   "fallback": { "auto": true, "chain": ["claude:max", "claude-opus-5-5", "claude:max-2/claude-sonnet-5-5", "gpt-6-astra"] }
 *
 * Each entry is an account slot ("claude:max-2": the same model on that account), a model id ("claude-opus-5-5": that
 * model on the role's own account, or on the first usable account when the role isn't Claude), or "slot/model".
 * Codex entries are used only when the caller says Codex may run (it is paused by design until its sandbox isolation
 * is applied). Nothing here ever moves a role to an account that isn't configured, is signed out, or is itself at its
 * limit, and an entry already tried for that role is never tried again (no loops).
 *
 * This only PICKS the next binding. The orchestrator resumes the role exactly as an owner's "resume on another
 * account" does: roles that already finished are skipped, the integrated head and passing tests are kept, and a
 * role blocked part-way continues in its own worktree on top of what it already committed. Nothing is replayed.
 */

export type FallbackConfig = { auto: boolean; chain: readonly string[] };
export const NO_FALLBACK: FallbackConfig = { auto: false, chain: [] };

export function validateFallback(v: unknown): FallbackConfig {
  if (v === undefined || v === null) return NO_FALLBACK;
  const o = v as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o)) throw new Error("fallback needs an object");
  if (o.auto !== undefined && typeof o.auto !== "boolean") throw new Error("fallback.auto must be true or false");
  if (!Array.isArray(o.chain) || o.chain.some((m) => typeof m !== "string" || !m || m.length > 80)) throw new Error("fallback.chain must be a list of account slots or model ids");
  return { auto: o.auto === true, chain: (o.chain as string[]).slice(0, 8) };
}

/** A stable key for a binding: where it runs and what runs. */
export const bindingKey = (b: AgentBinding) => `${b.accountSlot}/${b.model}`;

export type FallbackEnv = {
  accounts: AccountsConfig;
  /** Is this Claude login signed in? null = not checked (never blocks). */
  claudeConnected: (slot: ClaudeAccountSlot) => boolean | null;
  allowance: (slot: ClaudeAccountSlot) => AllowanceSnapshot | null;
  stopAtPercent: number;
  cliVersions: { claude: string | null; codex: string | null };
  /** Codex may run (its isolation is applied). Default false: a Codex entry is skipped and said. */
  codexAvailable?: boolean;
  now?: () => number;
  /** Only a bare account slot may be picked: the model never changes. Used for a role whose account is signed out (round 6). */
  accountsOnly?: boolean;
};

export type FallbackPick = { binding: AgentBinding; why: string; /** The target account can draw paid credits (said before it is used). */ credits?: boolean };
export type FallbackResult = { pick: FallbackPick | null; skipped: { entry: string; why: string }[] };

const isSlot = (e: string): e is ClaudeAccountSlot => /^claude:max(?:-[2-9]|-[1-9]\d)?$/.test(e);

/** The next binding for a role that can't continue as it is, or null with the reason each entry was skipped. */
export function nextFallback(current: AgentBinding, tried: readonly string[], chain: readonly string[], env: FallbackEnv): FallbackResult {
  const skipped: { entry: string; why: string }[] = [];
  const seen = new Set([bindingKey(current), ...tried]);
  const slotUsable = (slot: ClaudeAccountSlot): string | null => {
    if (!env.accounts.claude.some((c) => c.slot === slot)) return "isn't a configured Claude account";
    if (env.claudeConnected(slot) === false) return "isn't signed in";
    const block = claudeStopReason(env.allowance(slot), env.stopAtPercent, env.now?.());
    return block ? block.replace(/^Claude's /, "").replace(/\.$/, "") : null;
  };
  /** The first configured, signed-in Claude account below its limit (for a role that isn't on Claude yet). */
  const anySlot = (): ClaudeAccountSlot | null => env.accounts.claude.map((c) => c.slot).find((s) => !slotUsable(s)) ?? null;

  for (const entry of chain) {
    let binding: AgentBinding | null = null;
    let why = "";
    let credits = false;
    if (env.accountsOnly && !(isSlot(entry))) { skipped.push({ entry, why: "a signed-out account is only moved to another account, never to another model" }); continue; }
    const [head, tail] = entry.includes("/") ? (entry.split("/", 2) as [string, string]) : [entry, ""];
    if (isSlot(head) && !tail) {
      const bad = slotUsable(head);
      if (bad) { skipped.push({ entry, why: bad }); continue; }
      const model = current.route === "claude-code-cli" ? current.model : "claude-sonnet-5-5";
      binding = claudeBinding(currentClaudeModel(model as never), env.cliVersions.claude ?? "unknown", head);
      why = `${head} is the next account in the fallback list`;
      credits = !!env.allowance(head)?.creditsWouldBeUsed;
    } else if (isSlot(head) && tail && (CLAUDE_MODELS as readonly string[]).includes(tail)) {
      const bad = slotUsable(head);
      if (bad) { skipped.push({ entry, why: bad }); continue; }
      binding = claudeBinding(tail as never, env.cliVersions.claude ?? "unknown", head);
      why = `${tail} on ${head} is the next entry in the fallback list`;
    } else if ((CLAUDE_MODELS as readonly string[]).includes(entry)) {
      const slot = current.route === "claude-code-cli" ? current.accountSlot : anySlot();
      if (!slot) { skipped.push({ entry, why: "no Claude account can take new work" }); continue; }
      const bad = current.route === "claude-code-cli" ? null : slotUsable(slot);
      if (bad) { skipped.push({ entry, why: bad }); continue; }
      binding = claudeBinding(entry as never, env.cliVersions.claude ?? "unknown", slot);
      why = `${entry} on the same account is the next entry in the fallback list`;
    } else if (entry === "gpt-6-astra" || entry === "gpt-5.6-sol" || entry === "gpt-5.6-terra" || entry === "gpt-5.6-luna" || entry === "gpt-5.5") {
      if (!env.codexAvailable) { skipped.push({ entry, why: "Codex is paused until its sandbox isolation is applied" }); continue; }
      // Prefer a Codex account that may not draw paid credits; if only a credits-allowed one exists it is used and said.
      const cfg = env.accounts.codex.find((c) => !c.creditsAllowed) ?? env.accounts.codex[0];
      if (!cfg) { skipped.push({ entry, why: "no Codex account is connected" }); continue; }
      binding = codexBinding(entry, cfg.slot, env.cliVersions.codex ?? "unknown");
      why = `${entry} on ${cfg.slot} is the next entry in the fallback list`;
      credits = !!cfg.creditsAllowed;
    } else {
      skipped.push({ entry, why: "not an account slot or a model this harness runs" });
      continue;
    }
    if (seen.has(bindingKey(binding))) { skipped.push({ entry, why: "already tried for this role" }); continue; }
    return { pick: { binding, why: credits ? `${why}; this account can draw paid credits` : why, ...(credits ? { credits: true } : {}) }, skipped };
  }
  return { pick: null, skipped };
}
