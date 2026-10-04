import type { Bot, BotReadiness, ReadinessPart, ReadinessReason, ReadinessState, ReasonFix } from "./types";

/**
 * A bot's readiness, DERIVED on every read from the services it points at. Nothing here is stored and nothing is inferred from files:
 *
 *   computer   the shared computer's own state (online / busy / asleep / offline / failed / starting), who holds its control lease, and the
 *              open jobs on it (a job waiting for a yes is "needs you")
 *   coding     the accounts service's real answer for the account the bot will use (Claude: `claude auth status` on that profile; Codex:
 *              installed, isolation applied, below its limit), and the open coding jobs (a job waiting for the owner is "needs you")
 *   router     whether the bot's model route can pick a model now
 *
 * Each reason is a stable code, one sentence of what is wrong and one of what to do about it, and, when the UI can act on it, a `fix`.
 * The words a person sees are chosen here, once.
 */

export type ComputerFacts = {
  exists: boolean;
  label: string;
  state: "starting" | "online" | "busy" | "asleep" | "offline" | "failed";
  desired: "running" | "suspended" | "stopped";
  /** Who holds the control lease right now. */
  controller: { kind: "agent" | "person" | null; who: string | null; jobId: string | null };
  takeoverPending: { by: string } | null;
  failure: { reason: string } | null;
  /** The job the computer is running for an agent now (its title), if any. */
  assigned: { jobId: string; title: string } | null;
  /** Screen truth from the computers service (absent on an older hub: then `usable`, or nothing, decides). */
  screen?: { applicable: boolean; ok: boolean; checking: boolean; reason: string | null; nextLabel: string | null };
  /** Online (or busy) AND, for a computer with a screen, the screen works. "Ready" here never rests on `state` alone. */
  usable?: boolean;
};
/** Open jobs of this bot, from the job services (not from a stored state). */
export type OpenWork = { jobId: string; title: string; kind: "computer" | "coding"; phase: "running" | "waiting"; /** What it waits for, in the job's own words. */ note?: string };
export type AccountFacts = { ready: boolean | null; label: string; reason: string | null };

export type ReadinessDeps = {
  computer(name: string): ComputerFacts | null;
  openWork(bot: Bot): OpenWork[];
  /** `slot` null = the automatic pick: is ANY coding account ready? */
  codingAccount(slot: string | null): AccountFacts;
  routerCheck(route: string): { ok: boolean; reason: string | null };
  /** The bot a job was made for (the job service's own record), or null. Lets a shared computer's busy state be read per bot. */
  botOfJob?(jobId: string): string | null;
  botName?(id: string): string | undefined;
};

const why = (code: string, text: string, fix?: ReasonFix): ReadinessReason => ({ code, text, ...(fix ? { fix } : {}) });
const part = (state: ReadinessState, reason: ReadinessReason | null = null): ReadinessPart => ({ state, reason });

function computerPart(bot: Bot, deps: ReadinessDeps, work: OpenWork[]): { part: ReadinessPart; notes: ReadinessReason[] } {
  const name = bot.computer as string;
  const open: ReasonFix = { kind: "open-computer", target: name };
  const c = deps.computer(name);
  if (!c || !c.exists) return { part: part("unconfigured", why("computer-missing", `The computer "${name}" doesn't exist yet. Create it on the Computers page, or pick another in Setup.`, { kind: "open-setup-section", target: "computer" })), notes: [] };
  const waiting = work.find((w) => w.kind === "computer" && w.phase === "waiting");
  const waitingReason = () => why("computer-job-waiting", `"${waiting!.title}" is waiting for you${waiting!.note ? `: ${waiting!.note}` : ""}. Answer it from the conversation, or stop it.`, open);
  switch (c.state) {
    case "failed":
      return { part: part("offline", why("computer-failed", `${c.label} failed${c.failure?.reason ? ` (${c.failure.reason.slice(0, 120)})` : ""}. Use Recover on the Computers page; nothing it was doing is replayed.`, open)), notes: [] };
    case "offline":
      return { part: part("offline", c.desired === "stopped" ? why("computer-stopped", `${c.label} was stopped on purpose. Start it on the Computers page.`, open) : why("computer-unreachable", `${c.label} isn't answering. Check its host on the Computers page; Recover restarts what died.`, open)), notes: [] };
    case "starting":
      return { part: part("offline", why("computer-starting", `${c.label} is still starting up. Give it a minute; it shows Ready here when it is up.`, { kind: "retry" })), notes: [] };
    case "asleep":
      return { part: part("ready"), notes: [why("computer-asleep", `${c.label} is asleep. It wakes by itself when it gets a task.`)] };
    case "busy": {
      if (c.controller.kind === "person") return { part: part("needs-you", why("computer-person-control", `${c.controller.who ?? "A person"} is controlling ${c.label}. The job carries on when they hand the controls back.`, open)), notes: [] };
      if (waiting) return { part: part("needs-you", waitingReason()), notes: [] };
      const notes = c.takeoverPending ? [why("takeover-pending", `${c.takeoverPending.by} is waiting to take control; the agent pauses at its next safe step.`, open)] : [];
      // Bots may share one computer and its one control lease: it runs ONE task at a time and refuses another (there is no queue). A job on it that was made
      // for ANOTHER bot is that bot's work, so this bot is busy too, with a reason that names the other bot and the way out.
      const others = c.assigned && deps.botOfJob?.(c.assigned.jobId);
      if (others && others !== bot.id) {
        const name = deps.botName?.(others) ?? others;
        return { part: part("working", { ...why("computer-busy-other-bot", `${c.label} is busy with ${name}'s task. Ask ${bot.name} again when it finishes: the computer runs one task at a time, and a task given now is refused.`, open), bot: { id: others, name } }), notes };
      }
      return { part: part("working"), notes };
    }
    case "online":
    default: {
      if (waiting) return { part: part("needs-you", waitingReason()), notes: [] };
      // Online is not ready: the screen has to work. A screen still being checked is not yet known, not failed.
      const s = c.screen;
      const broken = s ? s.applicable && !s.ok && !s.checking : c.usable === false;
      if (broken) {
        const reason = s?.reason ?? `${c.label}'s screen isn't working.`;
        return { part: part("needs-you", why("computer-screen-down", `${reason}${s?.nextLabel ? ` Next: ${s.nextLabel}.` : " Open the computer to see what is wrong."}`, open)), notes: [] };
      }
      return { part: part("ready"), notes: s?.applicable && s.checking && !s.ok ? [why("computer-screen-checking", `${c.label} is checking its screen. It is usable meanwhile; this clears by itself.`)] : [] };
    }
  }
}

function codingPart(bot: Bot, deps: ReadinessDeps, work: OpenWork[]): ReadinessPart {
  const slot = bot.coding.accountSlot;
  const a = deps.codingAccount(slot);
  const mine = work.filter((w) => w.kind === "coding");
  const waiting = mine.find((w) => w.phase === "waiting");
  if (a.ready === false)
    return part("offline", why("coding-account-not-ready", `${slot ? `${a.label} can't take coding work: ${a.reason ?? "it isn't ready"}` : `No coding account can take work: ${a.reason ?? "none is ready"}`}. ${slot ? "Sign it in (Coding > Accounts), or change the account in Setup. I won't use a different account for you." : "Sign one in on the Coding page."}`, { kind: "sign-in", ...(slot ? { target: slot } : {}) }));
  if (a.ready === null) return part("unconfigured", why("coding-account-unchecked", `${slot ? a.label : "The coding accounts"} haven't been checked yet${a.reason ? ` (${a.reason})` : ""}. Give it a moment, then reload; coding jobs wait until the check says it is signed in.`, { kind: "retry" }));
  if (waiting) return part("needs-you", why("coding-job-waiting", `Coding job "${waiting.title}" is waiting for you${waiting.note ? `: ${waiting.note}` : ""}. Open it from the conversation to answer.`));
  if (mine.some((w) => w.phase === "running")) return part("working");
  return part("ready");
}

export function deriveReadiness(bot: Bot, deps: ReadinessDeps): BotReadiness {
  const work = deps.openWork(bot);
  const parts: BotReadiness["parts"] = {};
  const notes: ReadinessReason[] = [];
  if (bot.computer) {
    const c = computerPart(bot, deps, work);
    parts.computer = c.part;
    notes.push(...c.notes);
  }
  if (bot.coding.enabled) parts.coding = codingPart(bot, deps, work);
  // The model route only ever explains a degraded bot (an unavailable route falls back to the next model by itself); it never decides alone.
  const route = deps.routerCheck(bot.modelPreference.route);
  if (!route.ok) parts.router = part("offline", why("route-unavailable", `${bot.name}'s model route "${bot.modelPreference.route}" has no model available right now${route.reason ? ` (${route.reason.slice(0, 140)})` : ""}. Switch the route to auto in Setup, or wait for the provider.`, { kind: "open-setup-section", target: "model" }));

  const capabilities = [parts.computer, parts.coding].filter((p): p is ReadinessPart => !!p);
  const reasons = [...Object.values(parts).map((p) => p?.reason).filter((r): r is ReadinessReason => !!r), ...notes];
  const working = work.find((w) => w.phase === "running") ?? null;
  if (!capabilities.length) {
    return { state: "unconfigured", reasons: [why("no-capability", `${bot.name} has no computer and coding is off, so there is nowhere for it to work. Pick a computer in Setup.`, { kind: "open-setup-section", target: "computer" }), ...reasons], working: null, parts };
  }
  const states = capabilities.map((p) => p.state);
  const state: ReadinessState = states.includes("working") ? "working" : states.includes("needs-you") ? "needs-you" : states.includes("ready") ? "ready" : states.includes("offline") ? "offline" : "unconfigured";
  return { state, reasons, working: working ? { jobId: working.jobId, title: working.title, kind: working.kind } : null, parts };
}
