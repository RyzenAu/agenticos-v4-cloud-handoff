// Pure rules behind the Setup tab: option lists, the plain-words state of each real thing a control points at, the
// reason a control is disabled, and the one-line effect of each choice. No React, no network, no clock (callers pass
// `now` where it matters), so every sentence the page says is testable.
import type { ClaudeCodingAccount, CodexCodingAccount, CodingAccount, CodingAccounts } from "@/lib/coding-client";
import type { ComputerView, ComputersRead } from "@/lib/computers-client";
import { stateChip } from "@/lib/computers-client";
import { fmtDateTime } from "@/lib/format";
import type { BotReadiness, ReadinessReason } from "@/lib/agent-bots";
import type { Bot } from "@/lib/agent-bots";
import type { MemoryPool, Read, RoutineRow, RouterLite, RouterModel } from "./sources";

export type Tone = "neutral" | "success" | "warn" | "danger" | "info";
export type Option = { value: string; label: string; disabled?: boolean };
/** `reason` is the sentence shown beside a control that cannot be used; null when it can. */
export type Gate = { disabled: boolean; reason: string | null };
const OPEN: Gate = { disabled: false, reason: null };
const shut = (reason: string): Gate => ({ disabled: true, reason });

export const SECTION_IDS = { purpose: "setup-purpose", computer: "setup-computer", model: "setup-model", skills: "setup-skills", routines: "setup-routines", memory: "setup-memory", manage: "setup-manage" } as const;
export type SectionKey = keyof typeof SECTION_IDS;

const when = (iso: string | number | null | undefined) => (iso ? fmtDateTime(typeof iso === "number" ? new Date(iso) : iso) : null);

// ---------------------------------------------------------------------------------------------------------------
// Computer

export function computerOptions(read: ComputersRead, current: string | null): { options: Option[]; gate: Gate } {
  const none: Option = { value: "", label: "No computer" };
  if (read.status === "unavailable") {
    return { options: current ? [none, { value: current, label: current }] : [none], gate: shut(`${read.reason} The choice can't be changed until it can be read.`) };
  }
  const options: Option[] = [none, ...read.computers.map((c) => ({ value: c.name, label: `${c.label || c.name} (${stateChip(c).word.toLowerCase()})` }))];
  if (current && !read.computers.some((c) => c.name === current)) options.push({ value: current, label: `${current} (not on this hub)` });
  if (read.computers.length === 0 && !current) return { options, gate: shut("No shared computers exist yet. Add one in Computers, then come back to assign it.") };
  return { options, gate: OPEN };
}

/** What the assigned computer is doing right now, in words, with the tone to colour it. */
export function computerStateLine(c: ComputerView): { text: string; tone: Tone } {
  switch (c.state) {
    case "online":
      return { text: "Online and idle.", tone: "success" };
    case "busy":
      return { text: c.assigned ? `Busy: ${c.assigned.agent} is working on “${c.assigned.title}”.` : c.controller.kind === "person" ? "Busy: someone has taken control." : "Busy.", tone: "info" };
    case "starting":
      return { text: "Starting up.", tone: "info" };
    case "asleep":
      return { text: "Asleep (suspended on purpose). Start it in Computers.", tone: "warn" };
    case "offline":
      return { text: "Offline. Start it in Computers.", tone: "warn" };
    case "failed":
      return { text: `Failed${c.failure?.reason ? `: ${c.failure.reason}` : ""}. Recover it in Computers.`, tone: "danger" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Coding accounts

export type AccountInfo = {
  slot: string;
  label: string;
  /** The words after the label: "ready", "at its weekly limit until Mon 6 Oct, 9:00 am", "signed out". */
  text: string;
  tone: Tone;
  /** false when the account can never take work as it stands (not installed, signed out). */
  selectable: boolean;
  /** One line on whether using it costs extra. */
  paid: string;
  models: string[];
  modelsVerified: string[];
};

const isClaude = (a: CodingAccount): a is ClaudeCodingAccount => a.accountSlot.startsWith("claude:");

export function accountInfo(a: CodingAccount, isolation?: CodingAccounts["codexIsolation"]): AccountInfo {
  if (isClaude(a)) {
    const label = a.label ?? (a.accountSlot === "claude:max" ? "Claude Max" : a.accountSlot);
    const base = { slot: a.accountSlot, label, paid: `A ${a.plan ?? "subscription"} plan you already pay for: no per-call charge.`, models: [...a.models], modelsVerified: a.modelsVerified ?? [] };
    if (!a.installed) return { ...base, text: "the Claude program isn't installed on this PC", tone: "danger", selectable: false };
    if (a.connection?.state === "signed-out") return { ...base, text: `signed out${a.connection.reason ? ` (${a.connection.reason})` : ""}`, tone: "danger", selectable: false };
    const windows = a.allowance?.windows ?? [];
    if (a.allowance?.limitReached) {
      const full = windows.filter((w) => (w.usedPercent ?? 0) >= 100);
      const gating = full.length ? full : windows;
      const reset = gating.map((w) => w.resetsAt).filter((x): x is string => !!x).sort().pop() ?? null;
      const name = gating[0]?.label ? `${gating[0].label.toLowerCase()} limit` : "usage limit";
      return { ...base, text: `at its ${name}${reset ? ` until ${when(reset)}` : " (reset time not reported)"}`, tone: "warn", selectable: true };
    }
    if (a.connection?.state === "unknown" || !a.connection) return { ...base, text: "installed; sign-in not checked yet", tone: "neutral", selectable: true };
    const peak = windows.map((w) => w.usedPercent).filter((p): p is number => typeof p === "number").sort((x, y) => y - x)[0];
    return { ...base, text: typeof peak === "number" ? `ready, ${Math.round(peak)}% of its allowance used` : "ready", tone: "success", selectable: true };
  }
  const c = a as CodexCodingAccount;
  const label = `Codex ${c.accountSlot.replace(/^codex:?/, "") || "main"}`.trim();
  const base = { slot: c.accountSlot, label, paid: c.creditsAllowed ? `A ${c.plan} plan; it may spend paid credits once the plan runs out.` : `A ${c.plan} plan you already pay for; paid credits are not allowed, so no extra charge.`, models: [...c.models], modelsVerified: [] as string[] };
  if (!c.installed) return { ...base, text: "the Codex program isn't installed on this PC", tone: "danger", selectable: false };
  // Codex jobs can't start until the owner applies its sandbox isolation: the accounts service says so, so say it.
  if (isolation?.state === "paused") return { ...base, text: "paused until its sandbox isolation is applied (an owner step)", tone: "warn", selectable: false };
  const peak = c.reading?.peakPercent;
  if (typeof peak === "number" && peak >= 100) return { ...base, text: `at its usage limit${c.reading?.resetsAt ? ` until ${when(c.reading.resetsAt)}` : " (reset time not reported)"}`, tone: "warn", selectable: true };
  return { ...base, text: typeof peak === "number" ? `ready, ${Math.round(peak)}% of its allowance used` : "ready", tone: "success", selectable: true };
}

export function accountOptions(read: Read<{ accounts: CodingAccount[]; codexIsolation?: CodingAccounts["codexIsolation"] }>, current: string | null): { options: Option[]; gate: Gate; infos: AccountInfo[] } {
  const auto: Option = { value: "", label: "Automatic: the hub picks an account that can take work" };
  if (read.status === "unavailable") return { options: current ? [auto, { value: current, label: current }] : [auto], gate: shut(`${read.reason} The account can't be changed until it can be read.`), infos: [] };
  const infos = read.accounts.map((a) => accountInfo(a, read.codexIsolation));
  const options: Option[] = [auto, ...infos.map((i) => ({ value: i.slot, label: `${i.label}: ${i.text}`, disabled: !i.selectable && i.slot !== current }))];
  if (current && !infos.some((i) => i.slot === current)) options.push({ value: current, label: `${current} (no longer on this hub)` });
  if (infos.length === 0 && !current) return { options, gate: shut("No coding accounts are set up on this hub, so the hub has nothing to pick from."), infos };
  return { options, gate: OPEN, infos };
}

export function modelOptions(info: AccountInfo | null, current: string | null, accountsKnown: boolean): { options: Option[]; gate: Gate } {
  const hub: Option = { value: "", label: "Let the hub choose" };
  if (!accountsKnown) return { options: current ? [hub, { value: current, label: current }] : [hub], gate: shut("Accounts couldn't be read, so their models can't be listed.") };
  if (!info) return { options: current ? [hub, { value: current, label: current }] : [hub], gate: shut("Choose an account first. Models are listed per account, so the hub picks one while the account is automatic.") };
  if (info.models.length === 0) return { options: current ? [hub, { value: current, label: `${current} (not offered)` }] : [hub], gate: shut(`${info.label} didn't report any models, so the hub chooses.`) };
  const options: Option[] = [hub, ...info.models.map((m) => ({ value: m, label: info.modelsVerified.includes(m) ? `${m} (has run here)` : m }))];
  if (current && !info.models.includes(current)) options.push({ value: current, label: `${current} (not offered by ${info.label})` });
  return { options, gate: OPEN };
}

/** Coding jobs belong to bots the hub has switched coding on for. Setup never turns authority on. */
export function codingGate(bot: Pick<Bot, "coding" | "name">): Gate {
  return bot.coding.enabled ? OPEN : shut(`${bot.name} doesn't run coding jobs, so it has no coding account to choose. Coding is chosen when a bot is made, not from Setup.`);
}

// ---------------------------------------------------------------------------------------------------------------
// Model route

const ROUTE_WORD: Record<RouterModel["route"], string> = { free: "free", subscription: "subscription", metered: "paid per use" };
const RUNNABLE = new Set(["verified", "configured"]);

export function healthWord(m: RouterModel): string {
  const h = m.health;
  if (!RUNNABLE.has(m.status)) return "not set up on this hub";
  if (!h) return "not checked";
  switch (h.state) {
    case "ok":
      return "working";
    case "limited":
    case "exhausted":
      return h.until ? `limited until ${when(h.until)}` : "limited";
    case "down":
      return "down";
    case "unlisted":
      return "no longer listed";
    default:
      return "not checked";
  }
}

export type RouteGroup = { label: string; options: Option[] };

export function routeGroups(read: Read<{ router: RouterLite }>, current: string): { groups: RouteGroup[]; note: string | null } {
  const basic: RouteGroup = { label: "Let the hub decide", options: [{ value: "auto", label: "Automatic" }, { value: "free-only", label: "Free models only" }] };
  if (read.status === "unavailable") {
    const keep: RouteGroup[] = current !== "auto" && current !== "free-only" ? [{ label: "Chosen now", options: [{ value: current, label: current }] }] : [];
    return { groups: [basic, ...keep], note: `${read.reason} Specific models can't be listed until it can be read.` };
  }
  // Only models that can write this bot's replies (text in, text out) and that are set up here, by their display names. A model already chosen stays
  // listed even when it no longer qualifies, so the choice is never silently changed.
  const offered = (m: RouterModel) => m.id === current || (m.text !== false && RUNNABLE.has(m.status));
  const by = (route: RouterModel["route"]) =>
    read.router.models.filter((m) => m.route === route && offered(m)).map((m): Option => ({ value: m.id, label: `${m.label ?? m.id}: ${healthWord(m)}`, disabled: !RUNNABLE.has(m.status) && m.id !== current }));
  const groups = [basic, { label: "Free", options: by("free") }, { label: "Subscription", options: by("subscription") }, { label: "Paid per use", options: by("metered") }].filter((g) => g.options.length > 0);
  if (current !== "auto" && current !== "free-only" && !read.router.models.some((m) => m.id === current)) groups.push({ label: "Chosen now", options: [{ value: current, label: `${current} (not in the router's list)` }] });
  return { groups, note: null };
}

export function routeDisclosure(read: Read<{ router: RouterLite }>, route: string): { text: string; tone: Tone } {
  if (route === "auto") return { text: "The router picks a working free or subscription model for each job. It never picks a paid-per-use one by itself.", tone: "neutral" };
  if (route === "free-only") return { text: "Only models verified as free. It never falls back to a paid one.", tone: "success" };
  const m = read.status === "ok" ? read.router.models.find((x) => x.id === route) : undefined;
  if (!m) return { text: "This route isn't in the router's list right now, so its cost can't be stated.", tone: "warn" };
  const cost = m.route === "free" ? (m.verifiedFree ? "Free: no charge, verified by the router's catalogue." : "Free route, but the catalogue hasn't verified that it is never charged.") : m.route === "subscription" ? "Uses a subscription you already pay for: no per-call charge." : "Paid per use: each call is charged to your account with that provider.";
  return { text: `${cost} Right now: ${healthWord(m)}.${m.label ? ` (${m.id})` : ""}`, tone: m.route === "metered" ? "warn" : m.route === "free" ? "success" : "neutral" };
}

// ---------------------------------------------------------------------------------------------------------------
// What the bot can do (read-only): its skills, what its computer can do, whether it runs coding jobs.

export type AbilityRow = { name: string; description?: string; missing: boolean };

/** The bot's skills, each with the hub's one-line description when it has one; a skill the hub no longer lists is flagged. */
export function skillAbilities(read: Read<{ skills: { name: string; description?: string }[] }>, chosen: string[]): AbilityRow[] {
  const known = read.status === "ok" ? read.skills : [];
  return [...chosen].sort((a, b) => a.localeCompare(b)).map((name) => {
    const k = known.find((s) => s.name === name);
    return { name, ...(k?.description ? { description: k.description } : {}), missing: read.status === "ok" && !k };
  });
}

/** Pure: does the "What this bot can do" section have anything to say? Not for a bot with no skills that doesn't code: it would only say it does nothing. */
export function skillsSectionShown(bot: Pick<Bot, "skills" | "coding">): boolean {
  return bot.skills.length > 0 || bot.coding.enabled;
}

/** What the assigned computer says it can do, in words. null = no computer to ask. */
export function computerAbilities(read: ComputersRead, name: string | null): string | null {
  if (!name) return null;
  if (read.status === "unavailable") return "Not known: the computers service couldn't be read.";
  const c = read.computers.find((x) => x.name === name);
  if (!c) return `“${name}” isn't one of this hub's shared computers.`;
  if (!c.capabilities) return "The computer hasn't reported what it can do.";
  return c.capabilities.length ? c.capabilities.join(", ") : "It reports nothing beyond running jobs.";
}

// ---------------------------------------------------------------------------------------------------------------
// Routines

export function scheduleText(r: Pick<RoutineRow, "schedule" | "kind" | "source" | "nextRunAt">): string {
  const s = r.schedule;
  const next = r.nextRunAt ? ` Next: ${when(r.nextRunAt)}.` : "";
  if (s?.kind === "daily") return `Every day at ${s.at} (${s.tz}).${next}`;
  if (s?.kind === "interval") return `${s.everyMinutes % 60 === 0 && s.everyMinutes >= 60 ? `Every ${s.everyMinutes / 60} hour${s.everyMinutes === 60 ? "" : "s"}` : `Every ${s.everyMinutes} minute${s.everyMinutes === 1 ? "" : "s"}`}.${next}`;
  return r.kind === "event" ? "Runs when something it watches reports an event." : "No schedule reported.";
}

export type RoutineItem = { id: string; name: string; schedule: string; state: RoutineRow["state"]; missing: boolean };

export function routineItems(read: Read<{ routines: RoutineRow[] }>, linked: string[]): RoutineItem[] {
  const listed = read.status === "ok" ? read.routines.map((r) => ({ id: r.id, name: r.name, schedule: scheduleText(r), state: r.state, missing: false })) : [];
  const gone = linked.filter((id) => !listed.some((r) => r.id === id)).map((id) => ({ id, name: id, schedule: "This routine no longer exists in Automations.", state: "disabled" as const, missing: true }));
  return [...listed, ...gone];
}

/** Pure: the names of the routines THIS bot is linked to (not every routine the hub lists), for the archive confirmation. None linked: none named. */
export function linkedRoutineNames(read: Read<{ routines: RoutineRow[] }>, linked: string[]): string[] {
  return routineItems(read, linked).filter((r) => linked.includes(r.id)).map((r) => r.name);
}

/** Pure: the readiness reasons Setup's card still needs to show: the header already says a bot has no usable computer, with its one action. */
export function cardReasons(reasons: ReadinessReason[]): ReadinessReason[] {
  const aboutComputer = (r: ReadinessReason) => r.fix?.kind === "open-computer" || (r.fix?.kind === "open-setup-section" && r.fix.target === "computer") || /computer/i.test(r.code) || /\bcomputer\b/i.test(r.text);
  return reasons.filter((r) => !aboutComputer(r));
}

export function routinesGate(read: Read<{ routines: unknown[] }>): Gate {
  if (read.status === "unavailable") return shut(`${read.reason} Linked routines stay as they are; you can only unlink them until the list loads.`);
  return OPEN;
}

// ---------------------------------------------------------------------------------------------------------------
// Memory

export function poolLine(read: Read<{ memory: MemoryPool }>): { text: string; tone: Tone } {
  if (read.status === "unavailable") return { text: `${read.reason} Whether memory will work is unknown.`, tone: "warn" };
  const m = read.memory;
  const mode = m.mode === "on" ? "Shared memory is saving." : m.mode === "read" ? "Shared memory is read-only: nothing new is saved." : m.mode === "off" ? "Shared memory writes are off: nothing new is saved." : "Shared memory's mode isn't reported.";
  const recall = m.hindsightEnabled === false ? " The pool itself is switched off, so there is nothing to recall." : m.hindsightEnabled === true ? " Recall is available." : "";
  const extra = [typeof m.pending === "number" && m.pending > 0 ? `${m.pending} waiting to be saved` : null, m.lastSuccessAt ? `last saved ${when(m.lastSuccessAt)}` : null].filter(Boolean);
  return { text: `${mode}${recall}${extra.length ? ` (${extra.join("; ")})` : ""}`, tone: m.mode === "on" && m.hindsightEnabled !== false ? "success" : "warn" };
}

/**
 * A switch the hub's memory can't honour is unavailable, with the reason beside it, whatever its stored value: it is never shown as On when
 * nothing would be recalled or saved. (A value stored earlier stays stored; it applies again when the pool is back.)
 */
export function memoryGate(kind: "recall" | "saveResults", current: boolean, read: Read<{ memory: MemoryPool }>): Gate {
  if (read.status === "unavailable") return OPEN;
  const m = read.memory;
  if (kind === "recall" && m.hindsightEnabled === false) return shut("The shared pool is switched off on this hub, so there is nothing to recall from.");
  if (kind === "saveResults" && (m.mode === "off" || m.mode === "read")) return shut(m.mode === "off" ? "Memory writes are off on this hub, so nothing would be saved. Turn them on in Memory." : "The shared pool is read-only on this hub, so nothing would be saved. Change that in Memory.");
  return OPEN;
}

// ---------------------------------------------------------------------------------------------------------------
// Readiness: each reason is the hub's structured { code, text, fix? }; the fix decides the button.

export type RecoveryAction = { label: string; section?: SectionKey; to?: string; retry?: true };
export type ReadinessItem = { key: string; text: string; action: RecoveryAction | null };

const SECTION_LABEL: Record<SectionKey, string> = { purpose: "Edit purpose and instructions", computer: "Choose a computer", model: "Choose another model or account", skills: "See what it can do", routines: "Review routines", memory: "Review memory", manage: "Copy or archive this bot" };

export function recoveryFor(reason: ReadinessReason): RecoveryAction | null {
  const f = reason.fix;
  if (!f) return null;
  switch (f.kind) {
    case "open-computer":
    case "take-over":
      return { label: "Open Computers", to: "/computers" };
    case "open-setup-section":
      return f.target && f.target in SECTION_IDS ? { label: SECTION_LABEL[f.target as SectionKey], section: f.target as SectionKey } : null;
    case "sign-in":
      return { label: "Sign in", to: "/coding" };
    case "retry":
      return { label: "Check again", retry: true };
  }
}

export function readinessItems(readiness: BotReadiness): ReadinessItem[] {
  return readiness.reasons.map((r, i) => ({ key: `${r.code}:${i}`, text: r.text, action: recoveryFor(r) }));
}

export const READINESS_TONE: Record<BotReadiness["state"], Tone> = { ready: "success", working: "info", "needs-you": "warn", offline: "warn", unconfigured: "neutral" };
