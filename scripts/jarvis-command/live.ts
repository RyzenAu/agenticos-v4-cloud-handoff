/**
 * The command service's live wiring on the hub (Track 2). Kept here so operator-plugin.ts only gains a
 * few additive lines: build once per server, route /screen/command* through it.
 */
import type { Principal } from "../identity/principal";
import type { JobService } from "../jobs/service";
import type { ScreenHands } from "../screen-hands/index";
import type { DevicesService } from "../devices/service";
import { HUB_DEVICE_ID } from "../devices/registry";
import { resolveTarget } from "../devices/route";
import type { JarvisEntry } from "../jev-command";
import { createCommandService, type CommandService, type Delegates } from "./service";
import { loadCodingDetector } from "./coding";
import { backgroundJobsDisabled } from "../preview-guard";
import { runLeadAction, type LeadsApiLike } from "./leads";
import { skillIntent } from "../jarvis-skills";
import { receptionistAnswer, receptionistQuestion } from "./receptionist";
import type { ReceptionistSnapshot } from "../receptionist/types";
import type { DeskPayments } from "../desk-payments/service";

/** A preview (ARGENTIC_PREVIEW=1) or quiet copy (AGENTIC_OS_NO_BACKGROUND=1): no real OS side effects. */
const previewCopy = () => backgroundJobsDisabled() || process.env.ARGENTIC_PREVIEW === "1";
const PREVIEW_REMINDER = "This is a preview copy of the OS, so I won't set a real reminder or Windows task. Nothing was scheduled.";

/** Skills that only read or schedule (never type, move windows or touch the clipboard): safe to answer typed. */
const READ_ONLY_SKILLS = new Set(["timer", "time", "maths", "units", "currency", "system", "weather", "finance", "ai_usage", "inbox", "deploys", "capabilities"]);

export function createLiveCommandService(options: {
  screen: ScreenHands;
  entry: () => JarvisEntry | null;
  devices: DevicesService;
  jobs: () => JobService;
  memoryTurn?: (caller: unknown, utterance: string, spokenYes: string | null) => Promise<{ said: string; outcome: string } | null>;
  /** The receptionist dashboard snapshot (scripts/receptionist/plugin.ts receptionistSnapshot). */
  receptionist?: () => Promise<ReceptionistSnapshot>;
  /** The leads service (createLeadsApi): CRM actions by voice or typing. */
  leads?: () => LeadsApiLike | undefined;
  /** The Jarvis skills (timers, alarms, reminders): "remember to …" becomes a real reminder. */
  skills?: () => { run(body: unknown, options?: { remote?: boolean; desk?: boolean }): Promise<{ ok: boolean; said: string }> } | undefined;
  /** Desk payments (scripts/desk-payments, P1): typed words at his desk. Absent: typed commands are exactly as before. */
  deskPay?: () => DeskPayments | undefined;
}): CommandService {
  const { devices } = options;
  // Track 3's coding detector, when its branch is in this tree (coding words then open its draft page).
  void loadCodingDetector();
  const delegates: Delegates = {
    ...(options.memoryTurn ? { memory: (utterance: string, caller: unknown, spokenYes: string | null) => options.memoryTurn!(caller, utterance, spokenYes) } : {}),
    leads: async (action, principal) => {
      const api = options.leads?.();
      if (!api) return { ok: false, said: "The leads service isn't running here, so nothing in the CRM changed.", verified: null };
      return runLeadAction(api, action, principal);
    },
    skill: {
      match: (utterance: string) => {
        const req = skillIntent(utterance);
        return req && "skill" in req && READ_ONLY_SKILLS.has(req.skill) ? req.skill : null;
      },
      run: async (utterance: string, principal: Principal) => {
        const skills = options.skills?.();
        const req = skillIntent(utterance);
        if (!skills || !req) return { ok: false, said: "That skill isn't available here, so I won't guess." };
        // A preview or quiet copy never registers a real Windows timer or reminder task (REVIEW-T2).
        if ("skill" in req && (req.skill === "timer" || req.skill === "reminder") && previewCopy()) return { ok: false, said: PREVIEW_REMINDER };
        const r = await skills.run(req, { remote: principal.via !== "loopback-owner" });
        return { ok: r.ok, said: r.said };
      },
    },
    reminder: async (words, principal) => {
      const skills = options.skills?.();
      const req = skillIntent(words);
      if (!skills || !req) return { ok: false, said: "I couldn't set that reminder, so nothing is scheduled." };
      if (previewCopy()) return { ok: false, said: PREVIEW_REMINDER };
      // An ask-back ("morning or evening?") is said as-is; nothing is scheduled until he answers.
      if ("skill" in req && req.skill === "say") return { ok: false, said: String((req as { text?: string }).text ?? "When should I remind you?") };
      const r = await skills.run(req, { remote: principal.via !== "loopback-owner" });
      return { ok: r.ok, said: r.said };
    },
    // Desk payments: a typed payment order, yes, no, or "open my bank" is answered here ONLY for the owner at his desk.
    deskPay: {
      handle: async (utterance, principal, source) => {
        const desk = options.deskPay?.();
        if (!desk) return null;
        const verdict = desk.verdict(principal);
        if (!verdict.ok) return null;
        // Only the typed box's own words count as his here. A command a model sent (source "voice") is never recorded as heard, and
        // its "yes" or "no" never answers a payment: it is just text.
        const typed = source === "typed";
        const turn = await desk.turn(utterance, { desk: true, answered: false, channel: typed ? "typed" : "voice", record: typed });
        if (!turn) return null;
        if ("say" in turn) return { ok: !turn.refused && !turn.ask, said: turn.say, ask: turn.ask, refused: turn.refused };
        const call = turn.call as { skill?: string; action?: string; url?: string; name?: string };
        if (call.skill === "browser") {
          const skills = options.skills?.();
          if (!skills) return { ok: false, said: "Jarvis's browser skill isn't available here, so nothing opened." };
          const r = await skills.run(call, { remote: false, desk: true });
          return { ok: r.ok, said: r.said };
        }
        if (call.action === "confirm" && typed) {
          const c = turn.call as { id?: unknown; ticket?: unknown };
          const r = await desk.confirm(String(c.id ?? ""), { how: "typed-yes", ticket: c.ticket }, { desk: verdict, source: "typed" });
          return { ok: r.ok, said: r.said };
        }
        if (call.action === "confirm") return null;
        const r = await desk.request(String((turn.call as { text?: unknown }).text ?? utterance), { desk: verdict, source: typed ? "typed" : "voice" });
        return { ok: r.ok, said: r.said, ask: r.asks, refused: r.refused };
      },
      cancelAll: (principal) => {
        const desk = options.deskPay?.();
        if (desk && desk.verdict(principal).ok) desk.cancel("all");
      },
    },
    ...(options.receptionist
      ? {
          receptionist: async (utterance: string) => {
            try {
              const q = receptionistQuestion(utterance) ?? "status";
              const a = receptionistAnswer(q, await options.receptionist!());
              return { ok: a.verified, said: a.said, verified: a.verified };
            } catch {
              return { ok: false, said: "I couldn't read the receptionist's feed, so I won't guess." };
            }
          },
        }
      : {}),
  };
  return createCommandService({
    jobs: options.jobs,
    entry: options.entry,
    runs: options.screen.runs,
    hubDeviceId: HUB_DEVICE_ID,
    resolveTarget: (ctx) => resolveTarget(ctx, devices.registry),
    dispatcher: devices.dispatcher,
    micOwner: (personId) => devices.registry.micOwner(personId),
    deviceLabel: (id) => devices.registry.all().find((d) => d.id === id)?.label ?? id,
    delegates,
  });
}
