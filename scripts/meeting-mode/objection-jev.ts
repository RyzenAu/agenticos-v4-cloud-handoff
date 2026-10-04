/**
 * Live objection cues in meeting mode — Jev candidate #2 (MINISTRY-JEV-BUSINESS.md, 25 Sep 2026).
 * Classifies one new transcript chunk against seven independent objection nouls so `cuesFor()`'s
 * regex list (cues.ts, kept as the always-on local fallback) can also catch a paraphrase it
 * wasn't written to match — "we're pretty booked out for a while" for `timing`, say. A chunk can
 * raise two objections at once ("too expensive, and we already have someone"), so these are seven
 * independent noul questions, not one primary-objection choice — losing either tag would be wrong.
 * Jev never writes a coaching line: on a hit, the caller shows the SAME fixed card text
 * `cuesFor`'s own rules already carry, via `cueForTag()` in cues.ts.
 *
 * Guardrails from the Ministry's "Risk & guardrail" for this candidate:
 * - a tag's probability must be >= TAG_MIN (0.85) before it is even suggested;
 * - abstains entirely (no network call at all) unless the chunk is attributed to the prospect —
 *   an unknown speaker or the founder's own words must never be sent or trigger a cue; this is a
 *   deliberate abstention, not invented diarisation;
 * - a one-second request deadline (REQUEST_DEADLINE_MS); a slow or failed call abstains, it never
 *   blocks transcription or the chunk pipeline;
 * - the previous chunk is passed only as context and is never itself classified;
 * - sending a chunk's text to Jev's cloud API is a distinct action from local transcription
 *   consent — the caller (session.ts) gates this behind its own explicit cloud-cue opt-in.
 */
import { jevDecide } from "../jev-client";
import type { ObjectionTag } from "./cues";

export const OBJECTION_TAGS: readonly ObjectionTag[] = [
  "price", "incumbent", "send_info", "timing", "trust_privacy", "relevance", "think_about_it",
] as const;

export const TAG_MIN = 0.85;
export const REQUEST_DEADLINE_MS = 1000;
/** Debounce so the same objection doesn't cue repeatedly within this window (session.ts). */
export const CUE_COOLDOWN_MS = 20_000;

export type ChunkSpeaker = "prospect" | "founder" | "unknown";

export type ObjectionChunkInput = {
  sessionId: string;
  chunkId: string;
  capturedAt: string;
  speaker: ChunkSpeaker;
  text: string;
  previousChunkText: string;
};

type JevNoulAnswer = { noul?: number; confidence?: number };
export type ObjectionAnswers = Partial<Record<ObjectionTag, JevNoulAnswer>>;

const SHARED_INSTRUCTION =
  "Read only the NEW thing the prospect just said (the previous chunk is context only, and is " +
  "never itself classified). Answer only for a real objection the PROSPECT is raising right now " +
  "— never the founder's own example or a hypothetical, and never a negated objection " +
  "(\"it's not the price\" is not a price objection).";

export function objectionQuestions(): Record<ObjectionTag, { type: "noul"; instructions: string }> {
  return {
    price: { type: "noul", instructions: `${SHARED_INSTRUCTION} Does it raise cost, budget or affordability as a concern?` },
    incumbent: { type: "noul", instructions: `${SHARED_INSTRUCTION} Does it say they already have a receptionist, website, agency or someone doing this?` },
    send_info: { type: "noul", instructions: `${SHARED_INSTRUCTION} Does it ask to be sent information, details or an email instead of continuing now?` },
    timing: { type: "noul", instructions: `${SHARED_INSTRUCTION} Does it say now is a bad time, they're too busy, or to come back later?` },
    trust_privacy: { type: "noul", instructions: `${SHARED_INSTRUCTION} Does it raise trust, privacy, data security, or suspicion this is a scam or a bot?` },
    relevance: { type: "noul", instructions: `${SHARED_INSTRUCTION} Does it say they're not interested, or that this doesn't apply to them?` },
    think_about_it: { type: "noul", instructions: `${SHARED_INSTRUCTION} Does it say they need to think it over or check with a partner, spouse or boss?` },
  };
}

export type ClassifyResult = { chunkId: string; suggestedTags: ObjectionTag[]; answers: ObjectionAnswers; ms: number };

/**
 * Null means either a deliberate abstention (unknown/founder speaker, empty text, no key) or a
 * failed/timed-out call — the caller treats both identically: no cue, nothing shown, nothing
 * blocked. Never throws.
 */
export async function classifyObjectionCues(
  input: ObjectionChunkInput,
  options: { key: string; request?: typeof fetch; timeoutMs?: number },
): Promise<ClassifyResult | null> {
  if (input.speaker !== "prospect") return null; // abstain rather than invent diarisation
  const text = input.text.trim();
  if (!text || !options.key) return null;
  // Through the one Jev client (surface meeting.objection): the 1 s deadline, no retries, a receipt.
  const out = await jevDecide({
    surface: "meeting.objection",
    caller: "scripts/meeting-mode/objection-jev.ts",
    key: options.key,
    state: { previous_chunk: input.previousChunkText.slice(0, 2000), chunk: text.slice(0, 2000) },
    questions: objectionQuestions(),
    request: options.request,
    timeoutMs: options.timeoutMs ?? REQUEST_DEADLINE_MS,
  });
  if (!out.ok) return null;
  const answers = out.answers as ObjectionAnswers;
  const suggestedTags = OBJECTION_TAGS.filter((tag) => (answers[tag]?.noul ?? 0) >= TAG_MIN);
  return { chunkId: input.chunkId, suggestedTags, answers, ms: out.ms };
}
