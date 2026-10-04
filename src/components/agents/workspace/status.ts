// The bot's one honest status line: "Ready", "Working on …", "Needs you: …", "Offline: …". Derived from what the services report
// (the shared computer, its lease, the coding jobs), never stored. A pattern borrowed from Open Dot's bot header (behaviour only).
import { screenFailing, type ComputerView } from "@/lib/computers-client";
import type { ComputerJobView } from "@/lib/agent-workspace";
import { ACTIVE_STATES, type CodingJob } from "@/lib/coding-client";
import { needsYouLine } from "@/components/coding/needs-you";
import type { Tone } from "@/components/ds";
import type { Bot } from "./bots";

export type BotStatusKind = "ready" | "working" | "needs-you" | "held" | "offline" | "unconfigured";
export type BotStatus = { kind: BotStatusKind; tone: Tone; text: string };

const DAY = 86_400_000;
const lower1 = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Pure: does this coding job wait for a person right now? A stale draft or an old unconfirmed plan is not "needs you". */
export function codingWaitsForYou(job: CodingJob, now = Date.now()): boolean {
  const age = now - (Date.parse(job.updatedAt) || 0);
  if (job.supersededBy || job.state === "draft") return false;
  if (job.state === "awaiting_confirmation") return age < DAY;
  if (job.runs.some((r) => r.state === "needs_input")) return age < 7 * DAY;
  return ["needs_owner", "awaiting_approval", "interrupted", "blocked_allowance"].includes(job.state) && age < 7 * DAY;
}

export type StatusInput = {
  bot: Bot;
  /** The bot's shared computer, or null (none assigned, not found, or not shared). */
  computer: ComputerView | null;
  /** The computer's newest job, when read. */
  job?: ComputerJobView | null;
  /** Coding jobs, for a bot that can code. */
  coding?: readonly CodingJob[] | null;
  me: string | null;
  nameOf?: (id: string) => string;
  now?: number;
};

export function deriveBotStatus(i: StatusInput): BotStatus {
  const { bot, computer: c, me } = i;
  const nameOf = i.nameOf ?? ((id: string) => id);
  const now = i.now ?? Date.now();
  const coding = bot.coding.enabled ? i.coding ?? [] : [];

  // Archived: nothing is asked of it, and nothing it did is lost. While jobs it already had are finishing it says so.
  if (bot.lifecycle === "archiving") return { kind: "working", tone: "info", text: "Archived. Its earlier jobs are finishing; it takes no new requests" };
  if (bot.lifecycle === "archived") return { kind: "offline", tone: "neutral", text: "Archived: unarchive it in Setup to talk to it" };

  // A shared computer's job that belongs to ANOTHER bot is that bot's work, not this one's (bots share the computer's one control lease: it runs one task at a time and refuses another, there is no queue).
  const other = c?.assigned ? bot.sharesComputerWith?.find((o) => o.id === c.assigned!.agent) : undefined;

  // Needs you: the things only a person can unblock, most urgent first.
  if (c && (c.state === "failed" || c.failure)) return { kind: "needs-you", tone: "danger", text: `Needs you: its computer failed${c.failure ? `, ${lower1(short(c.failure.reason, 80))}` : ""}. Reconnect it` };
  if (c && c.controller.kind === "person" && c.controller.who === me && c.paused) return { kind: "needs-you", tone: "warn", text: `Needs you: ${agentName(bot, c.paused.agent)}'s job is paused while you hold the controls. Return them` };
  if (c && c.assigned && !other && i.job?.state === "awaiting-approval") return { kind: "needs-you", tone: "warn", text: `Needs you: approve the step ${c.assigned.agent} asked about` };
  const waiting = coding.filter((j) => codingWaitsForYou(j, now)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (waiting) return { kind: "needs-you", tone: "warn", text: `Needs you: ${short(lower1(needsYouLine(waiting)), 220)}` };

  // Working: something is running.
  if (c?.takeoverPending) return { kind: "working", tone: "info", text: `${c.takeoverPending.by === me ? "You are" : `${nameOf(c.takeoverPending.by)} is`} taking over; it pauses at its next safe step` };
  if (c && c.controller.kind === "agent" && c.assigned && !other) return { kind: "working", tone: "info", text: `Working on ${short(lower1(c.assigned.title || c.assigned.jobId))}` };
  const building = coding.filter((j) => (ACTIVE_STATES as string[]).includes(j.state)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (building) return { kind: "working", tone: "info", text: `Working on ${short(lower1(building.spec.objective))}` };
  if (c?.state === "starting") return { kind: "working", tone: "info", text: "Starting its computer" };

  if (other && !coding.length) return { kind: "working", tone: "info", text: `Busy with ${other.name}'s task; ask again when it finishes` };

  // Someone has the controls (not waiting on anyone to return them).
  if (c && c.controller.kind === "person") {
    const mine = c.controller.who === me;
    return { kind: "held", tone: mine ? "accent" : "info", text: mine ? (c.heldByYouElsewhere ? "You have the controls of its computer in another window" : "You have the controls of its computer") : `${nameOf(c.controller.who ?? "someone")} has the controls of its computer` };
  }

  // Not able to work.
  if (c && (c.state === "offline" || c.state === "asleep")) {
    if (!bot.coding.enabled) return { kind: "offline", tone: "neutral", text: `Offline: its computer is ${c.state === "asleep" ? "asleep" : "stopped"}. Start it from Show computer beside the chat` };
  }
  if (!c && !bot.coding.enabled) {
    // One word and one sentence for "it has no usable computer", whether none was ever chosen or the chosen one isn't on this hub.
    return { kind: "unconfigured", tone: "neutral", text: bot.computer ? `No computer: "${bot.computer}" isn't on this hub. Choose one in Setup` : "No computer yet. Choose one in Setup" };
  }
  if (bot.readiness && (bot.readiness.state === "offline" || bot.readiness.state === "unconfigured") && !c) return { kind: bot.readiness.state, tone: "neutral", text: `Offline: ${bot.readiness.reasons[0] ?? "not ready"}` };
  // Round 8: the header said plain "Ready" while the computer panel beside it said the screen was not working. Work that needs no screen still runs,
  // so it stays "ready", but it says what is wrong and where to fix it (the panel names the layer and offers Restart display).
  if (c && screenFailing(c)) return { kind: "ready", tone: "warn", text: "Ready, but its computer's screen isn't working. Show computer to fix it" };
  if (c && c.lastJob && i.job && i.job.id === c.lastJob.jobId && ["failed", "interrupted", "unknown"].includes(i.job.state)) return { kind: "ready", tone: "warn", text: "Ready. The last job did not finish" };
  return { kind: "ready", tone: "success", text: "Ready" };
}

/** The agent of a paused job as a person reads it: this bot's name, a bot it shares the computer with, else the id capitalised (never "research's job"). */
export function agentName(bot: Pick<Bot, "id" | "name" | "sharesComputerWith">, agent: string): string {
  if (agent === bot.id) return bot.name;
  const other = bot.sharesComputerWith?.find((o) => o.id === agent);
  return other ? other.name : agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : "The agent";
}

/** Tone to dot colour (a dot is never the only signal: the words always sit beside it). */
export const TONE_DOT: Record<Tone, string> = { neutral: "bg-muted-foreground", accent: "bg-brand", success: "bg-success", warn: "bg-warn", danger: "bg-danger", info: "bg-info" };

/** Pure: the few words a bot list row shows under the name. The full sentence stays in the header's status line and the row's title. */
export function shortStatus(s: BotStatus, bot: Pick<Bot, "lifecycle">): string {
  if (bot.lifecycle === "archived") return "Archived";
  if (bot.lifecycle === "archiving") return "Archiving";
  switch (s.kind) {
    case "ready": return s.tone !== "warn" ? "Ready" : /screen isn't working/.test(s.text) ? "Ready, screen not working" : "Ready, last job unfinished";
    case "working": return s.text.startsWith("Working on ") ? short(s.text, 34) : s.text.startsWith("Starting") ? "Starting its computer" : "Working";
    case "needs-you": return "Needs you";
    case "held": return s.text.startsWith("You ") ? "You have the controls" : "Someone has the controls";
    case "unconfigured": return "No computer";
    case "offline": return "Offline";
  }
}

export type StatusAction = { label: string; tab: "computer" | "tasks" | "setup" };

/**
 * Pure: the one thing to press when the status asks something of the person, beside the status line. Null when nothing is asked.
 * "computer" opens the conversation with the computer showing; the label always names where it goes.
 */
export function statusAction(s: BotStatus, bot: Pick<Bot, "computer" | "lifecycle" | "coding">): StatusAction | null {
  if (bot.lifecycle === "archived" || bot.lifecycle === "archiving") return { label: "Open Setup", tab: "setup" };
  const onComputer = /computer failed|while you hold the controls|approve the step|taking over/.test(s.text);
  switch (s.kind) {
    case "needs-you": return onComputer ? { label: "Show computer", tab: "computer" } : { label: "Open Tasks", tab: "tasks" };
    case "held": return { label: "Show computer", tab: "computer" };
    case "unconfigured": return { label: "Choose a computer", tab: "setup" };
    case "offline": return bot.computer ? { label: "Show computer", tab: "computer" } : { label: "Open Setup", tab: "setup" };
    default: return null;
  }
}

/**
 * Pure: should the status action be on the page? Not on the tab it points at. On Chat a computer-pointing action is redundant only while the
 * computer is showing; with the panel closed it is how the person gets there (it opens the panel).
 */
export function statusActionVisible(act: StatusAction | null, shownTab: "chat" | "tasks" | "setup", computerShown: boolean): act is StatusAction {
  if (!act || act.tab === shownTab) return false;
  if (act.tab === "computer" && shownTab === "chat") {
    // On Chat the tab row already has the Show computer toggle: a plain "Show computer" here would be the same button twice.
    // A specific next step (Reconnect, Take over...) still shows while the panel is closed.
    return !computerShown && act.label !== "Show computer";
  }
  return true;
}
