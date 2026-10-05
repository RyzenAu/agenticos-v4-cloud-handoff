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
import { createCommandService, type CommandService, type CommandServiceDeps, type Delegates } from "./service";
import type { JobThreads } from "./threads";
import { loadCodingDetector } from "./coding";
import { spokenConfirmations } from "../jarvis-execution/voice-confirmation";
import { backgroundJobsDisabled } from "../preview-guard";
import { runLeadAction, type LeadsApiLike } from "./leads";
import type { AiTotalsLike, CalendarEventLike } from "./os-reads";
import { needsYouSaid, type NeedsYouSources } from "../workspace/needs-you-voice";
import { runCrmIntent, type CrmOperationsLike } from "./crm";
import { hubRole } from "../cloud/hub-role";
import { skillIntent } from "../jarvis-skills";
import { receptionistAnswer, receptionistQuestion } from "./receptionist";
import type { ReceptionistSnapshot } from "../receptionist/types";
import { providerKey } from "../provider-config";
import type { PinCatalogue } from "../jev-pins";
import { isCodingRequest } from "../../src/lib/commands/coding";

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
  /** The CRM's typed operations (crmRuntime(root).operations), resolved on use so an un-upgraded CRM is a plain sentence, not a crash. */
  crm?: () => CrmOperationsLike;
  /** The Jarvis skills (timers, alarms, reminders): "remember to …" becomes a real reminder. */
  skills?: () => { run(body: unknown, options?: { remote?: boolean; desk?: boolean }): Promise<{ ok: boolean; said: string }> } | undefined;
  /** The saved calendar events the Calendar page shows (read only): "what's on my calendar today". */
  calendarEvents?: () => readonly CalendarEventLike[];
  /** The AI usage snapshot (/__ai_usage, the Finance page's "AI spend" source): "how much have we spent on AI this month". */
  aiTotals?: () => Promise<AiTotalsLike>;
  /** The two workspace panels Home's "Needs you" list reads (and the coding store): "what needs my attention". */
  needsYou?: () => Promise<NeedsYouSources>;
  /** The same frontmost Jarvis Chrome check used by voice for current-page actions. */
  jarvisChromeInFront?: () => Promise<boolean>;
  /** Jarvis threads: job results land in the person's durable conversation (scripts/jarvis-command/threads.ts). */
  threads?: JobThreads;
  /** Agent bots (scripts/agents/jarvis.ts): "Ask Research to ...", a request made for a bot's conversation. Absent: no request is a bot's. */
  bots?: (shared: { /** The command service's own coding delegate (the per-person voice state a "start it" is answered from). */ coding?: Delegates["coding"] }) => CommandServiceDeps["bots"];
  /** The coding command entry (scripts/coding/command-entry.ts), resolved lazily: absent, coding words open the draft page as before. */
  /** Shared cloud computers (scripts/computers/jarvis.ts): "use the research computer to ...". */
  computers?: (utterance: string, principal: Principal) => Promise<{ ok: boolean; said: string; jobId?: string; deviceId?: string; navigate?: string } | null>;
  coding?: () => Promise<{ handle(utterance: string, turn: { personId: string; actor: "human" | "process"; via: string; spokenYes?: string | null; previousAssistant?: string | null; pin?: { accountSlot: string | null; model: string | null } | null; channel?: "voice" | "typed" }): Promise<{ say: string; navigate?: string; jobId?: string; jobState?: string; draft?: unknown; drafted?: boolean; started?: boolean } | null>; matches?(utterance: string): boolean; cancelPending?(turn: { personId: string; actor: "human" | "process"; via: string }): boolean; hasPendingQuestion?(turn: { personId: string; actor: "human" | "process"; via: string }): boolean }>;
  /**
   * The TypeSafe key for the Jev controller, read by NAME (TYPESAFE_API_KEY, else JEV_API_KEY) the way the rest of the hub reads it
   * (providerKey: the process environment, <repo>/.env.local, ~/.config/agentic-os.env). Never logged. Default: read from the repo root.
   */
  jevKey?: () => string;
  /** The coding accounts this server has (slot + label), for refusing a named account that isn't here with the ones that are. */
  pinCatalogue?: () => PinCatalogue | null;
  /** The shared coding voice when it has been built (scripts/coding/plugin.ts existingCodingVoice): pending planner questions live there. */
  codingVoice?: () => { peek(caller: { id: string; via?: string; actor?: string }): { draftId: string | null }; cancelPending(caller: { id: string; via?: string; actor?: string }): boolean } | null;
}): CommandService {
  const { devices } = options;
  // Track 3's coding detector, when its branch is in this tree (coding words then open its draft page).
  void loadCodingDetector();
  // "Start it" answers only Jarvis's own last coding line, so remember it per person, briefly (typed turns carry no transcript).
  const lastCodingSay = new Map<string, { say: string; at: number }>();
  // The coding entry's own detector (it knows the repo ids), once the entry has loaded; until then the shared pure detector.
  // (Loaded lazily by the first coding turn below, exactly as before: nothing here starts the coding runtime early.)
  let codingEntry: { matches?(utterance: string): boolean } | null = null;
  const delegates: Delegates = {
    ...(options.coding ? { codingMatches: (utterance: string) => (codingEntry?.matches ? codingEntry.matches(utterance) : isCodingRequest(utterance)) } : {}),
    ...(options.coding
      ? {
          coding: async (utterance: string, turn: { personId: string; actor: "human" | "process"; via: string; spokenYes: string | null; pin?: { accountSlot: string | null; model: string | null } | null; jevDecided?: boolean; conversationId?: string; channel?: "voice" | "typed" }) => {
            const entry = await options.coding!();
            codingEntry = entry;
            const prev = lastCodingSay.get(`${turn.personId}:${turn.actor}`);
            const r = await entry.handle(utterance, { ...turn, pin: turn.pin ?? null, previousAssistant: prev && Date.now() - prev.at < 10 * 60_000 ? prev.say : null });
            if (r) lastCodingSay.set(`${turn.personId}:${turn.actor}`, { say: r.say, at: Date.now() });
            return r;
          },
          // A whole-request Stop drops a pending planner question; it never loads the coding runtime just to find there was nothing pending.
          // The SHARED coding voice (the one the free-voice coding tool uses too), so a question asked there is seen here. Read only when it
          // already exists: no voice built means no question can be pending, and nothing loads the coding runtime just to look.
          codingCancelPending: async (turn: { personId: string; actor: "human" | "process"; via: string }) => {
            const voice = options.codingVoice?.() ?? null;
            if (voice) return voice.cancelPending({ id: turn.personId, via: turn.via, actor: turn.actor });
            return !!(codingEntry as { cancelPending?(t: typeof turn): boolean } | null)?.cancelPending?.(turn);
          },
          codingPendingQuestion: async (turn: { personId: string; actor: "human" | "process"; via: string }) => {
            const voice = options.codingVoice?.() ?? null;
            if (voice) return !!voice.peek({ id: turn.personId, via: turn.via, actor: turn.actor }).draftId;
            return !!(codingEntry as { hasPendingQuestion?(t: typeof turn): boolean } | null)?.hasPendingQuestion?.(turn);
          },
        }
      : {}),
    ...(options.computers ? { computers: options.computers } : {}),
    ...(options.calendarEvents || options.needsYou || options.aiTotals
      ? { reads: { ...(options.calendarEvents ? { calendar: () => options.calendarEvents!() } : {}), ...(options.needsYou ? { needsYou: async () => needsYouSaid(await options.needsYou!()) } : {}), ...(options.aiTotals ? { aiTotals: () => options.aiTotals!() } : {}) } }
      : {}),
    ...(options.memoryTurn ? { memory: (utterance: string, caller: unknown, spokenYes: string | null) => options.memoryTurn!(caller, utterance, spokenYes) } : {}),
    // A lead's website is read from the CRM by id (the page's own words never name the address that gets opened).
    leadSite: async (leadId) => {
      const api = options.leads?.();
      if (!api || !/^\d{1,9}$/.test(leadId)) return null;
      const r = (await api.handle("/leads/detail", "GET", {}, new URLSearchParams({ id: leadId }), false)) as { lead?: { name?: string; website?: string | null } };
      return r.lead ? { name: String(r.lead.name ?? ""), website: r.lead.website ?? null } : null;
    },
    leads: async (action, principal, eventId, jobId) => {
      const api = options.leads?.();
      if (!api) return { ok: false, said: "The leads service isn't running here, so nothing in the CRM changed.", verified: null };
      // Dot (the gateway): the same CRM capabilities its /crm routes need. Reading leads needs crm.read, changing one needs crm.write.
      if (principal.via === "gateway") {
        const need = action.action === "count" || action.action === "next" ? "crm.read" : "crm.write";
        if (!(principal.capabilities ?? []).includes(need as never)) return { ok: false, said: `That needs Dot's ${need} permission, so nothing in the CRM was read or changed.`, verified: null };
      }
      return runLeadAction(api, action, principal, { ...(eventId ? { eventId } : {}), ...(jobId ? { jobId } : {}) });
    },
    ...(options.crm
      ? { crm: (intent, principal, pageContext, eventId) => runCrmIntent({ operations: options.crm!, role: () => hubRole(), readOnly: () => backgroundJobsDisabled() }, intent, principal, pageContext as never, eventId ? { eventId } : {}) }
      : {}),
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
    // Jev's one controller decision for open-ended words; with no key it is said plainly and only exact commands run (brief §4.12).
    controller: { key: options.jevKey ?? (() => providerKey(process.cwd(), "TYPESAFE_API_KEY") || providerKey(process.cwd(), "JEV_API_KEY")) },
    ...(options.pinCatalogue ? { pinCatalogue: options.pinCatalogue } : {}),
    ...(options.threads ? { threads: options.threads } : {}),
    ...(options.bots ? { bots: options.bots({ coding: delegates.coding }) } : {}),
  });
}
