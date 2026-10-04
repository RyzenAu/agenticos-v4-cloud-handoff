// Which coding jobs wait for a person, and why, in one line. Shared by the list, the job card and the agent workspace.
import { NEEDS_YOU, jobStateLabel, type CodingJob } from "@/lib/coding-client";
import { codingPauseReason } from "../../../scripts/coding/pause-reason";

export function needsYou(job: CodingJob) {
  return (
    (NEEDS_YOU as string[]).includes(job.state) || job.runs.some((r) => r.state === "needs_input")
  );
}

/** Why a job needs you, in one line a person would say. */
export function needsYouLine(job: CodingJob): string {
  const asking = job.runs.find((r) => r.state === "needs_input" && r.pendingInput);
  if (asking) return `${asking.roleId} is asking: ${asking.pendingInput!.title}`;
  switch (job.state) {
    case "draft": return "The plan needs fixes before it can start";
    case "awaiting_confirmation": return "The plan is ready. Press Start when you're happy with it";
    case "awaiting_approval": return "Waiting for your spoken yes or Telegram code to merge. Not merged yet";
    // Why it stopped, in words (round 7): a bare "Resume when you're ready" never said what had happened.
    case "interrupted":
    case "blocked_allowance":
    case "needs_owner": {
      const reason = codingPauseReason(job);
      return reason.length > 220 ? `${reason.slice(0, 217)}...` : reason;
    }
    default: return jobStateLabel(job.state).label;
  }
}
