import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { SubscriptionCard } from "../ai-usage/types";
import { latestSubscriptionCards } from "../model-router/allowance";
import type { AllowanceReading, AllowanceSnapshot, ClaudeAccountSlot, CodexAccountSlot, IsoTime } from "./contracts";

/**
 * Which account runs a role (CODING-HARNESS §2.7 amended by the OWNER DECISIONS of 28 Sep 2026).
 *
 *  1. Three connected Codex accounts. A NEW job's Codex role goes to the first connected slot that is
 *     below the stop threshold (least used first). The slot is then FIXED for that run: the runner never
 *     rotates mid-run, and an interrupted or blocked run stays on its slot until the owner explicitly
 *     resumes it (optionally reassigning it, which is recorded).
 *  2. openai-1's paid credits stay enabled: when every plan window is exhausted, a slot whose config
 *     says `creditsAllowed` (openai-1 only) may still take the job, and the receipt records credits
 *     before/after. Nothing here buys credits or changes top-up.
 *
 * "Connected" means the slot has a native Codex login the harness can start: the default ~/.codex
 * (verified 27 Sep to be openai-2, Plus) or a slot-specific CODEX_HOME the owner signed in himself
 * (`CODEX_HOME=<dir> codex login`). Hermes' pooled logins are NOT native logins; routed roles reach
 * them through the model router instead (runners/router.ts).
 */

export type CodexSlotConfig = {
  slot: CodexAccountSlot;
  /** null = the default Codex home (~/.codex). */
  codexHome: string | null;
  plan: "chatgpt-plus" | "chatgpt-pro";
  /** Owner decision 2: only openai-1 may draw paid credits past its plan limit. */
  creditsAllowed: boolean;
  /** Lower goes first when windows tie. */
  order: number;
};
/**
 * A native Claude Code login (30 Sep 2026: a second Max 20x account). Each slot is its OWN profile:
 * `configDir` null = the default ~/.claude (the original account, "claude:max"); otherwise an absolute
 * CLAUDE_CONFIG_DIR the owner signed in himself (`CLAUDE_CONFIG_DIR=<dir> claude auth login`). Nothing
 * is ever copied between profiles. Listing a slot here does NOT make it connected: that is decided by
 * `claude auth status` run on the slot's own profile (claude-status.ts).
 */
export type ClaudeSlotConfig = {
  slot: ClaudeAccountSlot;
  configDir: string | null;
  /** What the owner bought; the plan Claude Code reports is shown next to it. */
  plan: "claude-max-20x" | "claude-max-5x" | "claude-pro";
  /** Short name the UI and Jarvis say, e.g. "Claude Max 2". */
  label: string;
  /** Lower goes first when an automatic pick ties. */
  order: number;
};
export type AccountsConfig = { version: 1; codex: CodexSlotConfig[]; claude: ClaudeSlotConfig[] };

export const DEFAULT_CLAUDE: ClaudeSlotConfig = { slot: "claude:max", configDir: null, plan: "claude-max-20x", label: "Claude Max", order: 0 };

/** The verified default: the native Codex login is the openai-2 Plus account (CODING-HARNESS §2.4). */
export const DEFAULT_ACCOUNTS: AccountsConfig = {
  version: 1,
  codex: [{ slot: "codex:openai-2", codexHome: null, plan: "chatgpt-plus", creditsAllowed: false, order: 0 }],
  claude: [DEFAULT_CLAUDE],
};

const CLAUDE_SLOT = /^claude:max(?:-(?:[2-9]|[1-9]\d))?$/;
export const isClaudeSlot = (v: unknown): v is ClaudeAccountSlot => typeof v === "string" && CLAUDE_SLOT.test(v);

const SLOTS: readonly CodexAccountSlot[] = ["codex:openai-1", "codex:openai-2", "codex:openai-3"];

export class AccountsInvalid extends Error {}

/** `.operator-data/coding/accounts.json` (owner-edited). Missing = the verified default. Invalid = refused. */
export function loadAccounts(file: string): AccountsConfig {
  if (!existsSync(file)) return DEFAULT_ACCOUNTS;
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 64 * 1024) throw new AccountsInvalid("accounts.json can't be opened safely");
  let v: unknown;
  try { v = JSON.parse(readFileSync(file, "utf8")); } catch { throw new AccountsInvalid("accounts.json is not valid JSON"); }
  return validateAccounts(v);
}

export function validateAccounts(v: unknown): AccountsConfig {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || o.version !== 1 || !Array.isArray(o.codex)) throw new AccountsInvalid("accounts.json needs {version:1, codex:[…]}");
  const claude = validateClaude(o.claude);
  const seen = new Set<string>();
  const codex = (o.codex as unknown[]).map((raw, i) => {
    const c = raw as Record<string, unknown>;
    if (!c || !SLOTS.includes(c.slot as CodexAccountSlot)) throw new AccountsInvalid(`codex[${i}].slot must be one of ${SLOTS.join(", ")}`);
    if (seen.has(c.slot as string)) throw new AccountsInvalid(`codex[${i}].slot is listed twice`);
    seen.add(c.slot as string);
    if (c.codexHome !== null && (typeof c.codexHome !== "string" || !/^(?:[A-Za-z]:[\\/]|\/)/.test(c.codexHome))) throw new AccountsInvalid(`codex[${i}].codexHome must be an absolute path or null`);
    if (c.plan !== "chatgpt-plus" && c.plan !== "chatgpt-pro") throw new AccountsInvalid(`codex[${i}].plan must be chatgpt-plus or chatgpt-pro`);
    if (typeof c.creditsAllowed !== "boolean") throw new AccountsInvalid(`codex[${i}].creditsAllowed must be true or false`);
    if (c.creditsAllowed && c.slot !== "codex:openai-1") throw new AccountsInvalid(`codex[${i}]: only openai-1 may draw paid credits (owner decision 2)`);
    return { slot: c.slot as CodexAccountSlot, codexHome: (c.codexHome as string | null) ?? null, plan: c.plan, creditsAllowed: c.creditsAllowed, order: typeof c.order === "number" ? c.order : i } as CodexSlotConfig;
  });
  if (codex.filter((c) => c.codexHome === null).length > 1) throw new AccountsInvalid("only one slot can use the default Codex home");
  return { version: 1, codex, claude };
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/;
const foldPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Missing `claude` = the one default login, as before 30 Sep. "claude:max" is always the default profile. */
function validateClaude(raw: unknown): ClaudeSlotConfig[] {
  if (raw === undefined) return [DEFAULT_CLAUDE];
  if (!Array.isArray(raw) || !raw.length) throw new AccountsInvalid("accounts.json claude must be a non-empty list");
  const seen = new Set<string>();
  const dirs = new Set<string>();
  const out = raw.map((r, i) => {
    const c = r as Record<string, unknown>;
    if (!c || !isClaudeSlot(c.slot)) throw new AccountsInvalid(`claude[${i}].slot must be claude:max or claude:max-<n>`);
    if (seen.has(c.slot)) throw new AccountsInvalid(`claude[${i}].slot is listed twice`);
    seen.add(c.slot);
    const dir = c.configDir ?? null;
    if (c.slot === "claude:max" && dir !== null) throw new AccountsInvalid("claude:max is the default ~/.claude profile (configDir null)");
    if (c.slot !== "claude:max" && (typeof dir !== "string" || !ABSOLUTE.test(dir))) throw new AccountsInvalid(`claude[${i}].configDir must be an absolute CLAUDE_CONFIG_DIR`);
    if (typeof dir === "string") {
      // A second slot on the same profile (or on the default ~/.claude) would be one login counted twice.
      if (dirs.has(foldPath(dir)) || /[\\/]\.claude$/i.test(dir.replace(/[\\/]+$/, ""))) throw new AccountsInvalid(`claude[${i}].configDir is already another slot's profile`);
      dirs.add(foldPath(dir));
    }
    const plan = c.plan ?? "claude-max-20x";
    if (plan !== "claude-max-20x" && plan !== "claude-max-5x" && plan !== "claude-pro") throw new AccountsInvalid(`claude[${i}].plan must be claude-max-20x, claude-max-5x or claude-pro`);
    const label = typeof c.label === "string" && c.label.trim() ? c.label.trim().slice(0, 40) : c.slot === "claude:max" ? "Claude Max" : `Claude Max ${c.slot.split("-").pop()}`;
    return { slot: c.slot, configDir: dir as string | null, plan, label, order: typeof c.order === "number" ? c.order : i } as ClaudeSlotConfig;
  });
  if (!out.some((c) => c.slot === "claude:max")) out.unshift(DEFAULT_CLAUDE);
  return out;
}

export type SlotReading = { slot: CodexAccountSlot; peakPercent: number | null; resetsAt: string | null; readAt: IsoTime | null };

/** Per-account windows from the /usage service's latest snapshot (15-minute cache; no extra call). */
export function slotReadings(cards: readonly SubscriptionCard[] | null = latestSubscriptionCards()): SlotReading[] {
  if (!cards) return [];
  return cards
    .filter((c) => c.provider === "openai" && SLOTS.includes(c.id as CodexAccountSlot))
    .map((c) => {
      const windows = c.status.ok ? c.status.windows : [];
      const top = [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
      return { slot: c.id as CodexAccountSlot, peakPercent: c.peakPercent, resetsAt: top?.resetsAt ?? null, readAt: null };
    });
}

export type SlotChoice =
  | { ok: true; slot: CodexSlotConfig; reason: string; considered: { slot: CodexAccountSlot; why: string }[]; creditsLikely: boolean }
  | { ok: false; reason: string; considered: { slot: CodexAccountSlot; why: string }[] };

/**
 * Pick the account for a NEW Codex role. Least-used connected slot below the stop threshold first; an
 * unknown reading never blocks (the runner reads live limits before the turn and stops honestly).
 * When every slot is at the limit, a credits-allowed slot (openai-1) is used and flagged. Never called
 * for an existing run: its slot is fixed (resume keeps it unless the owner reassigns).
 */
export function pickCodexSlot(config: AccountsConfig, readings: readonly SlotReading[], stopAtPercent = 95, preferred?: CodexAccountSlot): SlotChoice {
  const considered: { slot: CodexAccountSlot; why: string }[] = [];
  const byUse = [...config.codex].sort((a, b) => {
    if (preferred && a.slot === preferred) return -1;
    if (preferred && b.slot === preferred) return 1;
    const ra = readings.find((r) => r.slot === a.slot)?.peakPercent ?? null;
    const rb = readings.find((r) => r.slot === b.slot)?.peakPercent ?? null;
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    return a.order - b.order;
  });
  for (const c of byUse) {
    const r = readings.find((x) => x.slot === c.slot);
    const used = r?.peakPercent ?? null;
    if (used !== null && used >= stopAtPercent) { considered.push({ slot: c.slot, why: `at ${Math.round(used)}%${r?.resetsAt ? `, resets ${r.resetsAt}` : ""}` }); continue; }
    return { ok: true, slot: c, reason: used === null ? `${c.slot}: no recent reading (the runner checks live limits before starting)` : `${c.slot}: least used at ${Math.round(used)}%`, considered, creditsLikely: false };
  }
  const credit = byUse.find((c) => c.creditsAllowed);
  if (credit) return { ok: true, slot: credit, reason: `every plan window is at its limit; ${credit.slot} may draw its paid credits (owner decision 2)`, considered, creditsLikely: true };
  return { ok: false, reason: `Every connected Codex account is at its limit (${considered.map((c) => `${c.slot} ${c.why}`).join("; ")}).`, considered };
}

/** One Claude account's cached allowance (the /usage service's OAuth read for THAT profile, same as its /usage). Null = unknown. */
export function claudeAllowance(cards: readonly SubscriptionCard[] | null = latestSubscriptionCards(), slot: ClaudeAccountSlot = "claude:max"): AllowanceSnapshot | null {
  const card = cards?.find((c) => c.provider === "anthropic" && c.id === slot);
  if (!card || !card.status.ok) return null;
  return {
    accountSlot: slot,
    windows: card.status.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent, resetsAt: (w.resetsAt ?? null) as IsoTime | null })),
    creditsWouldBeUsed: false,
    limitReached: card.status.windows.some((w) => w.usedPercent >= 100),
    source: "anthropic-oauth-usage-cached",
    // The time the provider was LAST READ (not now): a cached figure must not look fresh. Unknown stays null.
    readAt: (card.status.freshness.checkedAt ?? null) as IsoTime | null,
  };
}

/** A reading older than this is stale (the usage service refreshes about every 15 minutes). */
export const ALLOWANCE_STALE_MS = 30 * 60_000;

/**
 * Can this allowance reading be trusted right now? "unknown" = nothing read, or no window has a figure
 * (never shown as 0%); "stale" = read long ago, or a window it shows has already reset (its figure is gone);
 * otherwise "fresh". One account's snapshot is never consulted for another: a snapshot for a different
 * slot than `slot` is unknown.
 */
export function allowanceReading(snapshot: AllowanceSnapshot | null | undefined, now: number = Date.now(), slot?: ClaudeAccountSlot): AllowanceReading {
  if (!snapshot) return "unknown";
  if (slot && snapshot.accountSlot !== slot) return "unknown";
  if (!snapshot.windows.some((w) => w.usedPercent !== null)) return "unknown";
  const readAt = snapshot.readAt ? Date.parse(snapshot.readAt) : NaN;
  if (!Number.isFinite(readAt)) return "unknown";
  if (now - readAt > ALLOWANCE_STALE_MS) return "stale";
  if (snapshot.windows.some((w) => w.resetsAt && Date.parse(w.resetsAt) <= now)) return "stale";
  return "fresh";
}

/** A reason to stop a Claude role before it starts, or null. Unknown never blocks. */
export function claudeStopReason(snapshot: AllowanceSnapshot | null, stopAtPercent: number, now: number = Date.now()): string | null {
  if (!snapshot) return null;
  // A window that has already reset no longer holds that figure: it never blocks (the runner stops honestly on a real limit).
  const reset = (w: { resetsAt: IsoTime | null }) => !!w.resetsAt && Date.parse(w.resetsAt) <= now;
  const high = snapshot.windows.find((w) => w.usedPercent !== null && w.usedPercent >= stopAtPercent && !reset(w));
  if (!high && !(snapshot.limitReached && snapshot.windows.some((w) => w.usedPercent !== null && w.usedPercent >= 100 && !reset(w)))) return null;
  const w = high ?? snapshot.windows[0];
  return `Claude's ${w.label} window is at ${Math.round(w.usedPercent ?? 100)}%${w.resetsAt ? `, resetting ${w.resetsAt}` : ""}.`;
}

/** What is known about one Claude login right now. `connected` null = not checked yet (unknown). */
export type ClaudeSlotState = { slot: ClaudeAccountSlot; connected: boolean | null; reason: string | null };

export type ClaudeChoice =
  | { ok: true; slot: ClaudeSlotConfig; reason: string; considered: { slot: ClaudeAccountSlot; why: string }[] }
  | { ok: false; reason: string; considered: { slot: ClaudeAccountSlot; why: string }[] };

export const labelOf = (config: AccountsConfig, slot: string) => config.claude.find((c) => c.slot === slot)?.label ?? slot;

/**
 * Pick the Claude account for a NEW role: the preferred slot when it is connected and below the stop
 * threshold, otherwise the next available one in order (the reason says why the preferred one was
 * skipped). Signed out = skipped; an unknown connection or reading never blocks (the runner stops
 * honestly on a real sign-in or limit error). Never called for an existing run: its slot is fixed.
 */
export function pickClaudeSlot(config: AccountsConfig, states: readonly ClaudeSlotState[], cards: readonly SubscriptionCard[] | null, stopAtPercent = 95, preferred?: ClaudeAccountSlot): ClaudeChoice {
  const considered: { slot: ClaudeAccountSlot; why: string }[] = [];
  const order = [...config.claude].sort((a, b) => (preferred && a.slot === preferred ? -1 : preferred && b.slot === preferred ? 1 : a.order - b.order));
  for (const c of order) {
    const st = states.find((s) => s.slot === c.slot);
    if (st?.connected === false) { considered.push({ slot: c.slot, why: `not signed in${st.reason && st.reason !== "not signed in on this profile" ? ` (${st.reason})` : ""}` }); continue; }
    const block = claudeStopReason(claudeAllowance(cards, c.slot), stopAtPercent);
    if (block) { considered.push({ slot: c.slot, why: block.replace(/^Claude's /, "").replace(/\.$/, "") }); continue; }
    const skipped = considered.length ? `, because ${considered.map((x) => `${labelOf(config, x.slot)}: ${x.why}`).join("; ")}` : "";
    return { ok: true, slot: c, reason: `${c.label}${st?.connected ? "" : " (connection not checked yet)"}${skipped}`, considered };
  }
  return { ok: false, reason: `No Claude account can take new work (${considered.map((x) => `${labelOf(config, x.slot)}: ${x.why}`).join("; ")}).`, considered };
}
