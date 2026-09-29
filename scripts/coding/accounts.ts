import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { SubscriptionCard } from "../ai-usage/types";
import { latestSubscriptionCards } from "../model-router/allowance";
import type { AllowanceSnapshot, CodexAccountSlot, IsoTime } from "./contracts";

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
export type AccountsConfig = { version: 1; codex: CodexSlotConfig[] };

/** The verified default: the native Codex login is the openai-2 Plus account (CODING-HARNESS §2.4). */
export const DEFAULT_ACCOUNTS: AccountsConfig = {
  version: 1,
  codex: [{ slot: "codex:openai-2", codexHome: null, plan: "chatgpt-plus", creditsAllowed: false, order: 0 }],
};

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
  return { version: 1, codex };
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

/** Claude's cached allowance (the /usage service's OAuth read, same as Claude Code's /usage). */
export function claudeAllowance(cards: readonly SubscriptionCard[] | null = latestSubscriptionCards()): AllowanceSnapshot | null {
  const card = cards?.find((c) => c.provider === "anthropic");
  if (!card || !card.status.ok) return null;
  return {
    accountSlot: "claude:max",
    windows: card.status.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent, resetsAt: (w.resetsAt ?? null) as IsoTime | null })),
    creditsWouldBeUsed: false,
    limitReached: card.status.windows.some((w) => w.usedPercent >= 100),
    source: "anthropic-oauth-usage-cached",
    readAt: new Date().toISOString() as IsoTime,
  };
}

/** A reason to stop a Claude role before it starts, or null. Unknown never blocks. */
export function claudeStopReason(snapshot: AllowanceSnapshot | null, stopAtPercent: number): string | null {
  if (!snapshot) return null;
  const high = snapshot.windows.find((w) => w.usedPercent !== null && w.usedPercent >= stopAtPercent);
  if (!high && !snapshot.limitReached) return null;
  const w = high ?? snapshot.windows[0];
  return `Claude's ${w.label} window is at ${Math.round(w.usedPercent ?? 100)}%${w.resetsAt ? `, resetting ${w.resetsAt}` : ""}.`;
}
