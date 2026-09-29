import type { CodingJob, JobState } from "./contracts";
import { specDigest } from "./spec";
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
  name?: string;
};

export type CodingEntryDraft = {
  jobId: string;
  specDigest: string;
  roles: { role: string; roleId: string; model: string; accountSlot: string; basis: string | null; why: string | null }[];
};

export type CodingEntryReply = { say: string; navigate?: string; jobId?: string; jobState?: JobState; draft?: CodingEntryDraft };

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
    async handle(utterance: string, turn: CodingEntryTurn): Promise<CodingEntryReply | null> {
      const caller = { id: turn.personId, name: turn.name, via: turn.via, actor: turn.actor };
      const reply = await deps.voice.handle(utterance, { caller, spokenYes: turn.spokenYes ?? null, previousAssistant: turn.previousAssistant ?? null });
      if (!reply) return null;
      const out: CodingEntryReply = { say: reply.say, ...(reply.navigate ? { navigate: reply.navigate } : {}) };
      // Only a reply that is ABOUT a job carries it (a refusal or a clarifying question doesn't inherit the last one).
      if (!reply.jobId) return out;
      out.jobId = reply.jobId;
      const job = deps.store?.getJob(reply.jobId) ?? null;
      if (job) {
        out.jobState = job.state;
        if (job.state === "awaiting_confirmation" || job.state === "draft") out.draft = draftOf(job);
      }
      return out;
    },
  };
}

export type CodingCommandEntry = ReturnType<typeof createCodingCommandEntry>;

