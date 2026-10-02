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
import type { JobThreads } from "./threads";
import { loadCodingDetector } from "./coding";
import { spokenConfirmations } from "../jarvis-execution/voice-confirmation";
import { backgroundJobsDisabled } from "../preview-guard";
import { runLeadAction, type LeadsApiLike } from "./leads";
import { skillIntent } from "../jarvis-skills";
import { receptionistAnswer, receptionistQuestion } from "./receptionist";
import type { ReceptionistSnapshot } from "../receptionist/types";

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
  /** The same frontmost Jarvis Chrome check used by voice for current-page actions. */
  jarvisChromeInFront?: () => Promise<boolean>;
  /** Jarvis threads: job results land in the person's durable conversation (scripts/jarvis-command/threads.ts). */
  threads?: JobThreads;
  /** The coding command entry (scripts/coding/command-entry.ts), resolved lazily: absent, coding words open the draft page as before. */
  /** Shared cloud computers (scripts/computers/jarvis.ts): "use the research computer to ...". */
  computers?: (utterance: string, principal: Principal) => Promise<{ ok: boolean; said: string; jobId?: string; deviceId?: string; navigate?: string } | null>;
  coding?: () => Promise<{ handle(utterance: string, turn: { personId: string; actor: "human" | "process"; via: string; spokenYes?: string | null; previousAssistant?: string | null }): Promise<{ say: string; navigate?: string; jobId?: string; jobState?: string; draft?: unknown } | null> }>;
}): CommandService {
  const { devices } = options;
  // Track 3's coding detector, when its branch is in this tree (coding words then open its draft page).
  void loadCodingDetector();
  // "Start it" answers only Jarvis's own last coding line, so remember it per person, briefly (typed turns carry no transcript).
  const lastCodingSay = new Map<string, { say: string; at: number }>();
  const delegates: Delegates = {
    ...(options.coding
      ? {
          coding: async (utterance: string, turn: { personId: string; actor: "human" | "process"; via: string; spokenYes: string | null }) => {
            const entry = await options.coding!();
            const prev = lastCodingSay.get(`${turn.personId}:${turn.actor}`);
            const r = await entry.handle(utterance, { ...turn, previousAssistant: prev && Date.now() - prev.at < 10 * 60_000 ? prev.say : null });
            if (r) lastCodingSay.set(`${turn.personId}:${turn.actor}`, { say: r.say, at: Date.now() });
            return r;
          },
        }
      : {}),
    ...(options.computers ? { computers: options.computers } : {}),
    ...(options.memoryTurn ? { memory: (utterance: string, caller: unknown, spokenYes: string | null) => options.memoryTurn!(caller, utterance, spokenYes) } : {}),
    // A lead's website is read from the CRM by id (the page's own words never name the address that gets opened).
    leadSite: async (leadId) => {
      const api = options.leads?.();
      if (!api || !/^\d{1,9}$/.test(leadId)) return null;
      const r = (await api.handle("/leads/detail", "GET", {}, new URLSearchParams({ id: leadId }), false)) as { lead?: { name?: string; website?: string | null } };
      return r.lead ? { name: String(r.lead.name ?? ""), website: r.lead.website ?? null } : null;
    },
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
    // In the cloud role the hub is not a device: nobody's "here" is the server, so no origin is the hub.
    hubDeviceId: devices.hubIsDevice ? HUB_DEVICE_ID : "",
    resolveTarget: (ctx) => resolveTarget(ctx, devices.registry),
    dispatcher: devices.dispatcher,
    micOwner: (personId) => devices.registry.micOwner(personId),
    // screen.goal runs only on a companion that reports it (its heartbeat's capabilities).
    supports: (deviceId, executor) => devices.registry.presenceOf(deviceId)?.capabilities?.includes(executor) === true,
    spoken: spokenConfirmations,
    deviceLabel: (id) => devices.registry.all().find((d) => d.id === id)?.label ?? id,
    delegates,
    ...(options.threads ? { threads: options.threads } : {}),
  });
}
