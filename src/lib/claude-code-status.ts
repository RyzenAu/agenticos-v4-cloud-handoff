// The Claude Code page's answer (W-B, 29 Sep 2026): is Claude Code ready on this PC, from the coding
// harness's /accounts read. Pure, so the honest states are tested: unknown is never "ready".
import { isClaudeAccount, type ClaudeCodingAccount, type CodingAccounts, type CodingJob } from "./coding-client";

export function claudeVerdict(accounts: CodingAccounts | null | undefined, failed: boolean) {
  const all = (accounts?.accounts ?? []).filter(isClaudeAccount);
  const claude: ClaudeCodingAccount | null = all.find((a) => a.accountSlot === "claude:max") ?? all[0] ?? null;
  if (failed) return { tone: "neutral" as const, title: "Couldn't check Claude Code", why: "The coding harness didn't answer, so its state is unknown. Coding jobs and chat may still work.", claude: null };
  if (!accounts) return { tone: "neutral" as const, title: "Checking Claude Code…", why: "Reading what's installed on this PC.", claude: null };
  if (!claude || !claude.installed) return { tone: "warn" as const, title: "Claude Code isn't installed here", why: "The harness can't find the Claude Code CLI on this PC, so Claude roles can't start. Install it and sign in with /login.", claude };
  const connected = all.filter((a) => a.connection?.state === "connected");
  const usable = connected.filter((a) => !a.allowance?.limitReached);
  if (all.length > 1 && connected.length) {
    if (!usable.length) return { tone: "warn" as const, title: "Every Claude account is at its plan limit", why: "A Claude role won't start until a window resets. Nothing draws paid credits.", claude };
    return { tone: "ok" as const, title: `${connected.length} of ${all.length} Claude accounts signed in`, why: "Each runs on its own Max subscription, never an API key. Pick the account when you start a job; a started role stays on its account.", claude };
  }
  if (claude.connection?.state === "signed-out") return { tone: "warn" as const, title: "Claude Code isn't signed in", why: `${claude.connection.reason ?? "The sign-in check failed"}. Sign in with /login, then check again.`, claude };
  const limit = claude.allowance?.limitReached;
  if (limit) return { tone: "warn" as const, title: "Claude Code is at its plan limit", why: "A Claude role won't start until the window resets. Nothing draws paid credits.", claude };
  if (claude.connection?.state === "connected") return { tone: "ok" as const, title: "Claude Code is signed in", why: "It runs on your Max subscription, never an API key. Give it a coding job and it plans, builds and gets reviewed in its own worktree.", claude };
  // Installed is what's known; sign-in is checked when a role starts (a signed-out CLI stops it with "sign in").
  return { tone: "ok" as const, title: "Claude Code is installed", why: "It runs on your Max subscription, never an API key. Give it a coding job and it plans, builds and gets reviewed in its own worktree. Sign-in is checked when a job starts.", claude };
}

export const usesClaude = (job: CodingJob) => job.spec.roles.some((r) => r.agent?.route === "claude-code-cli") || job.runs.some((r) => r.binding.route === "claude-code-cli");

