import type { CodingJob, JobState } from "./contracts";
import { specDigest } from "./spec";
import type { BuilderPin } from "./shaper";
import type { CodingStore } from "./store";
import type { CodingVoice } from "./voice";

/**
 * The coding command entry: ONE pure facade for the command service (scripts/jarvis-command) to call for BOTH
 * typed and spoken turns, so they share the same shaper and voice state (voice.ts keys that state per person,
 * and a program's turns under the same person id never share a person's).
 *
 * CONTRACT
 *   createCodingCommandEntry({ voice, store? }) -> { handle, matches }
 *
 *   handle(utterance, turn) -> Promise<CodingEntryReply | null>
 *     turn.personId          "usman" | "mehroz": who is asking (the verified caller, never read from the words)
 *     turn.actor             "human" | "process": only a person starts, stops, resumes, approves or asks to merge
 *     turn.via               "local" | "telegram" | "voice" | "tailnet": how the caller was verified
 *     turn.spokenYes         the STT spoken-yes id when the transcript was a clear yes (else null/absent);
 *                            a typed "yes" carries none, so a typed yes can never approve a merge
 *     turn.previousAssistant the last thing Jarvis said to this person (a whole yes answers only "Say start ...")
 *     returns null when the words are not a coding turn (the service carries on to its other rules and the brain);
 *     otherwise { say, navigate?, jobId?, jobState?, draft? }:
 *       say       the exact line to speak or show; never "done" before the gate passed, never "merged" before git says so
 *       navigate  "/coding" when the Coding page should open on the job
 *       jobId     the job THIS reply is about (drafted, started, stopped, resumed, asked about, merge asked),
 *                 so the service can attach progress (poll /coding/jobs/:id or subscribe to its events).
 *                 A refusal or a clarifying question carries none: it never inherits the last job.
 *       jobState  its state at the moment of the reply (needs `store`)
 *       draft     present while the job awaits "start": { jobId, specDigest, roles: [{ role, roleId, model,
 *                 accountSlot, basis, why }] } (needs `store`)
 *
 *   matches(utterance, repoIds?) -> boolean: the SAME detector the command registry and the voice rules use
 *     ("assign a builder to fix X and a reviewer to check it", "have a builder fix X", "Codex, fix X").
 *
 * Nothing here starts a job by itself: a draft is started only by a person's whole "start it" right after the
 * question, or by the Coding page's Start (either way ONE run set: a second start of the same plan is a no-op),
 * and a merge exists only as an approval request the owner answers with his spoken yes or Telegram code.
 * No state is kept here; everything lives in the voice, the shaper and the store the caller already owns.
 */

export type CodingEntryTurn = {
  personId: string;
  actor: "human" | "process";
  via: "local" | "telegram" | "voice" | "tailnet" | (string & {});
  spokenYes?: string | null;
  previousAssistant?: string | null;
  /** The conversation the words were said in (a thread id); undefined is the person's default Jarvis thread. A yes starts only a draft bound to it. */
  conversationId?: string;
  /** Jev chose the coding lane for these words: draft them as a new request when nothing more specific (a pending answer, status, stop) applies. */
  jevDecided?: boolean;
  /** The builder this turn must use, as structured fields (an Agents bot coding setting): exactly this account and model, or a refusal. */
  pin?: BuilderPin | null;
  name?: string;
  /** How the words arrived: "typed" in a Jarvis box, "voice" when spoken. Recorded on a draft's spec.source.channel as it was. */
  channel?: "voice" | "typed";
};

export type CodingEntryDraft = {
  jobId: string;
  specDigest: string;
  roles: { role: string; roleId: string; model: string; accountSlot: string; basis: string | null; why: string | null }[];
};

export type CodingEntryReply = { say: string; navigate?: string; jobId?: string; jobState?: JobState; draft?: CodingEntryDraft; /** A NEW draft this turn made, requested by this person: the only draft a conversation may record itself as the origin of (round 11 review M2). */ drafted?: true; /** This turn started (or resumed) it: a conversation links it as its running job only then (release re-check M4). */ started?: true };

export function createCodingCommandEntry(deps: { voice: CodingVoice; store?: Pick<CodingStore, "getJob"> }) {
  const draftOf = (j: CodingJob): CodingEntryDraft => ({
    jobId: j.id,
    specDigest: specDigest(j.spec),
    roles: j.spec.roles.filter((r) => r.agent).map((r) => {
      const c = (j.spec.roleChoices ?? []).find((x) => x.role === (r.role === "builder" ? "builder" : r.role));
      return { role: r.role, roleId: r.roleId, model: r.agent!.model, accountSlot: r.agent!.accountSlot, basis: c?.basis ?? null, why: c?.why ?? null };
    }),
  });

  return {
    matches: (utterance: string, repoIds: readonly string[] = []) => deps.voice.isCodingStart(utterance, repoIds),
    /** A whole-request Stop (handled by the command service before any coding words): drop this person's pending planner question. */
    cancelPending: (turn: Pick<CodingEntryTurn, "personId" | "actor" | "via" | "name">): boolean => deps.voice.cancelPending({ id: turn.personId, name: turn.name, via: turn.via, actor: turn.actor }),
    /** Is this person's coding planner waiting for an answer (a pending question, no job yet)? */
    hasPendingQuestion: (turn: Pick<CodingEntryTurn, "personId" | "actor" | "via" | "name">): boolean => !!deps.voice.peek({ id: turn.personId, name: turn.name, via: turn.via, actor: turn.actor }).draftId,
    async handle(utterance: string, turn: CodingEntryTurn): Promise<CodingEntryReply | null> {
      const caller = { id: turn.personId, name: turn.name, via: turn.via, actor: turn.actor };
      const reply = await deps.voice.handle(utterance, { caller, spokenYes: turn.spokenYes ?? null, previousAssistant: turn.previousAssistant ?? null, pin: turn.pin ?? null, ...(turn.jevDecided ? { jevDecided: true } : {}), ...(turn.channel ? { channel: turn.channel } : {}), ...(turn.conversationId ? { conversationId: turn.conversationId } : {}) });
      if (!reply) return null;
      const out: CodingEntryReply = { say: reply.say, ...(reply.navigate ? { navigate: reply.navigate } : {}) };
      // Only a reply that is ABOUT a job carries it (a refusal or a clarifying question doesn't inherit the last one).
      if (!reply.jobId) return out;
      out.jobId = reply.jobId;
      const job = deps.store?.getJob(reply.jobId) ?? null;
      if (job) {
        out.jobState = job.state;
        if (job.state === "awaiting_confirmation" || job.state === "draft") out.draft = draftOf(job);
        if (reply.drafted && job.spec.requestedBy.personId === turn.personId) out.drafted = true;
        if (reply.started) out.started = true;
      }
      return out;
    },
  };
}

export type CodingCommandEntry = ReturnType<typeof createCodingCommandEntry>;
