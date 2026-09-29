// The Claude Code page's answer (W-B, 29 Sep 2026): is Claude Code ready on this PC, from the coding
// harness's /accounts read. Pure, so the honest states are tested: unknown is never "ready".
import type { CodingAccounts, CodingJob } from "./coding-client";

type ClaudeAccount = Extract<CodingAccounts["accounts"][number], { accountSlot: "claude:max" }>;

export function claudeVerdict(accounts: CodingAccounts | null | undefined, failed: boolean) {
  const claude = accounts?.accounts.find((a): a is ClaudeAccount => a.accountSlot === "claude:max") ?? null;
  if (failed) return { tone: "neutral" as const, title: "Couldn't check Claude Code", why: "The coding harness didn't answer, so its state is unknown. Coding jobs and chat may still work.", claude: null };
  if (!accounts) return { tone: "neutral" as const, title: "Checking Claude Code…", why: "Reading what's installed on this PC.", claude: null };
  if (!claude || !claude.installed) return { tone: "warn" as const, title: "Claude Code isn't installed here", why: "The harness can't find the Claude Code CLI on this PC, so Claude roles can't start. Install it and sign in with /login.", claude };
  const limit = claude.allowance?.limitReached;
  if (limit) return { tone: "warn" as const, title: "Claude Code is at its plan limit", why: "A Claude role won't start until the window resets. Nothing draws paid credits.", claude };
  // Installed is what's known; sign-in is checked when a role starts (a signed-out CLI stops it with "sign in").
  return { tone: "ok" as const, title: "Claude Code is installed", why: "It runs on your Max subscription, never an API key. Give it a coding job and it plans, builds and gets reviewed in its own worktree. Sign-in is checked when a job starts.", claude };
}

export const usesClaude = (job: CodingJob) => job.spec.roles.some((r) => r.agent?.route === "claude-code-cli") || job.runs.some((r) => r.binding.route === "claude-code-cli");

