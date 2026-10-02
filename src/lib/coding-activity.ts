import type { CodingEvent } from "./coding-client";

export type ActivityFilter = "milestones" | "agent" | "all";
export const ACTIVITY_FILTERS = [
  { value: "milestones", label: "Milestones" },
  { value: "agent", label: "Agent updates" },
  { value: "all", label: "All activity" },
] as const;

const milestones = new Set(["state", "plan", "input_request", "input_resolved", "error", "recovery", "gate", "approval_request", "approval_resolved", "apply", "handoff", "test", "review"]);
/** Keep failures/decisions visible by default; streamed text and routine policy noise remain accessible. */
export function codingActivity(events: readonly CodingEvent[], filter: ActivityFilter): CodingEvent[] {
  return events.filter((event) => filter === "all" || (filter === "agent" ? ["text", "spoken", "step"].includes(event.type) : milestones.has(event.type) || (event.type === "text" && event.payload.final)))
    .slice().sort((a, b) => b.seq - a.seq);
}
