import { allowanceReading, claudeAllowance, labelOf, slotReadings, type AccountsConfig } from "../coding/accounts";
import type { ClaudeSlotStatus } from "../coding/claude-status";
import { codexIsolationStatus } from "../coding/routes";
import type { IsolationApproval } from "../coding/codex-isolation";
import { CLAUDE_MODELS_OFFERED, CODEX_MODELS } from "../coding/spec";
import type { AccountFacts } from "./readiness";

/**
 * The coding accounts' real readiness, from the accounts service's own answers (the same ones the Coding page's accounts list is built on):
 *
 *   Claude   `claude auth status` run on that slot's own profile (connected / signed out / not checked yet), and the cached usage window
 *            (a slot at its limit is not ready). A profile folder, a browser session or an API key never counts.
 *   Codex    the CLI is installed, the owner has applied the sandbox isolation (Codex is paused until then), and the slot is below its stop
 *            threshold.
 *
 * "Not checked yet" is `ready: null`, never true: a coding job is not offered an account nobody has verified.
 */

export type AccountsView = {
  accounts: () => AccountsConfig;
  cliVersions: () => { claude: string | null; codex: string | null };
  claudeStatus?: { current: () => ClaudeSlotStatus[]; refresh: (force?: boolean) => Promise<void> };
  codexIsolationApproval?: () => IsolationApproval | null;
};

const STOP_AT_PERCENT = 95;

export function accountFacts(view: AccountsView, slot: string): AccountFacts {
  const config = view.accounts();
  const versions = view.cliVersions();
  const claude = config.claude.find((c) => c.slot === slot);
  if (claude) {
    const label = claude.label;
    if (!versions.claude) return { ready: false, label, reason: "Claude Code isn't installed on this server" };
    const st = view.claudeStatus?.current().find((s) => s.slot === slot);
    if (!view.claudeStatus) return { ready: null, label, reason: "the sign-in check isn't available here" };
    if (!st || st.connected === null) return { ready: null, label, reason: st?.reason ?? "not checked yet" };
    if (st.connected === false) return { ready: false, label, reason: st.reason ?? "not signed in" };
    const allowance = claudeAllowance(undefined, claude.slot);
    if (allowance?.limitReached && allowanceReading(allowance, Date.now(), claude.slot) !== "stale") return { ready: false, label, reason: "its usage window is full (it resets by itself)" };
    return { ready: true, label, reason: null };
  }
  const codex = config.codex.find((c) => c.slot === slot);
  if (codex) {
    const label = `Codex (${codex.slot.replace("codex:", "")})`;
    if (!versions.codex) return { ready: false, label, reason: "Codex isn't installed on this server" };
    const iso = codexIsolationStatus((view.codexIsolationApproval ?? (() => null))());
    if (iso.state === "paused") return { ready: false, label, reason: "Codex is paused until its sandbox isolation is applied (bun scripts/coding/codex-isolation.ts --apply, run once by the owner)" };
    const reading = slotReadings().find((r) => r.slot === codex.slot);
    if (reading?.peakPercent !== null && reading?.peakPercent !== undefined && reading.peakPercent >= STOP_AT_PERCENT && !codex.creditsAllowed) return { ready: false, label, reason: `it is at ${Math.round(reading.peakPercent)}% of its plan window` };
    return { ready: true, label, reason: null };
  }
  return { ready: false, label: labelOf(config, slot), reason: "it isn't a configured coding account" };
}

/** The automatic pick: is ANY configured coding account ready? Not ready with the reasons when none is; not known when none is ready but some are unchecked. */
export function anyAccountFacts(view: AccountsView): AccountFacts {
  const config = view.accounts();
  const slots = [...config.claude.map((c) => c.slot as string), ...config.codex.map((c) => c.slot as string)];
  const all = slots.map((s) => accountFacts(view, s));
  const ready = all.find((a) => a.ready === true);
  if (ready) return ready;
  if (all.some((a) => a.ready === null)) return { ready: null, label: "the coding accounts", reason: all.find((a) => a.ready === null)?.reason ?? null };
  return { ready: false, label: "the coding accounts", reason: all.map((a) => `${a.label}: ${a.reason}`).join("; ") || "none is configured" };
}

/** Every slot of the accounts service, and the models each runs (Claude slots: the Claude models; Codex slots: the native Codex catalogue). */
export const slotsOf = (config: AccountsConfig): string[] => [...config.claude.map((c) => c.slot as string), ...config.codex.map((c) => c.slot as string)];
export const modelsForSlot = (slot: string): string[] => (slot.startsWith("claude:") ? [...CLAUDE_MODELS_OFFERED] : slot.startsWith("codex:") ? [...CODEX_MODELS] : []);
export const allCodingModels = (): string[] => [...CLAUDE_MODELS_OFFERED, ...CODEX_MODELS];
