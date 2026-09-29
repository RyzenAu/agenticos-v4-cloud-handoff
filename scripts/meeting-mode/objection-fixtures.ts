/**
 * Synthetic labelled dialogue chunks for classifyObjectionCues() shadow evaluation (Ministry
 * report, candidate #2). Every line here is invented for this evaluation — never a real
 * recording or transcript, per the owner's hard rule. Covers paraphrases the regex list in
 * cues.ts can't enumerate, negations, a founder's own example, a hypothetical, an unknown
 * speaker, several objections in one chunk, and plain no-objection small talk.
 */
import type { ChunkSpeaker } from "./objection-jev";
import type { ObjectionTag } from "./cues";

export type ObjectionFixture = {
  id: string;
  speaker: ChunkSpeaker;
  previousChunkText: string;
  text: string;
  /** Ground truth. Empty array means "no objection tag should fire". Ignored for a non-prospect
   *  speaker, where the classifier must abstain (return null) before ever reaching Jev. */
  expectedTags: ObjectionTag[];
  note: string;
};

export const OBJECTION_FIXTURES: ObjectionFixture[] = [
  {
    id: "price-paraphrase", speaker: "prospect", previousChunkText: "So that's roughly what it'd run per month.",
    text: "Yeah look, that's a fair bit more than we were hoping to spend on something like this.",
    expectedTags: ["price"], note: "Paraphrased price concern; cuesFor's regex wouldn't match this wording.",
  },
  {
    id: "incumbent-paraphrase", speaker: "prospect", previousChunkText: "How does the after-hours side work?",
    text: "Our front desk girl usually picks that up when she's back in the morning, so it's kind of already covered.",
    expectedTags: ["incumbent"], note: "Paraphrase of 'we already have someone'.",
  },
  {
    id: "send-info-paraphrase", speaker: "prospect", previousChunkText: "Happy to run through it now if you like.",
    text: "Honestly, easier if you just shoot the details through and I'll have a proper look later.",
    expectedTags: ["send_info"], note: "Paraphrase of 'send me some info'.",
  },
  {
    id: "timing-paraphrase", speaker: "prospect", previousChunkText: "Is now still an OK time?",
    text: "We're absolutely slammed with the new opening, so anything new is going to have to wait a bit.",
    expectedTags: ["timing"], note: "Paraphrase of a bad time / too busy.",
  },
  {
    id: "trust-paraphrase", speaker: "prospect", previousChunkText: "It listens in and takes notes automatically.",
    text: "I guess I'm just not sure where all that patient information actually ends up going.",
    expectedTags: ["trust_privacy"], note: "Paraphrase of a data/privacy concern.",
  },
  {
    id: "relevance-paraphrase", speaker: "prospect", previousChunkText: "It's mainly built for missed-call recovery.",
    text: "Yeah, I don't think that's really a problem we actually have here.",
    expectedTags: ["relevance"], note: "Paraphrase of 'not interested / doesn't apply to us'.",
  },
  {
    id: "think-about-it-paraphrase", speaker: "prospect", previousChunkText: "So that's the whole offer.",
    text: "I'd want to run this past my business partner before we go any further.",
    expectedTags: ["think_about_it"], note: "Paraphrase of needing to check with a partner.",
  },
  {
    id: "two-objections-at-once", speaker: "prospect", previousChunkText: "So what did you think?",
    text: "Honestly it feels pricey for what it is, and we've already got a system that mostly does this.",
    expectedTags: ["price", "incumbent"], note: "Two independent objections in one chunk — neither should be lost.",
  },
  {
    id: "negated-price", speaker: "prospect", previousChunkText: "Was it the cost that put you off?",
    text: "No, it's not really the price, we just don't have the bandwidth to onboard something new right now.",
    expectedTags: ["timing"], note: "Explicitly negates price; the real (only) objection here is timing.",
  },
  {
    id: "hypothetical-not-real", speaker: "prospect", previousChunkText: "Feel free to ask me anything.",
    text: "Just out of curiosity, if someone said this was too expensive, what would you normally tell them?",
    expectedTags: [], note: "A hypothetical question, not the prospect's own objection.",
  },
  {
    id: "no-objection-smalltalk", speaker: "prospect", previousChunkText: "Nice office, by the way.",
    text: "Thanks, we just moved in a few months ago, still finding our feet with the new layout.",
    expectedTags: [], note: "Plain small talk; nothing should fire.",
  },
  {
    id: "founders-own-example", speaker: "founder", previousChunkText: "What do people usually say?",
    text: "A lot of clients tell us it's too expensive at first, but then they see the missed-call numbers.",
    expectedTags: [], note: "The FOUNDER's own words — must abstain (no network call at all) before Jev ever sees it.",
  },
  {
    id: "unknown-speaker", speaker: "unknown", previousChunkText: "",
    text: "It's too expensive and we already have someone doing this.",
    expectedTags: [], note: "Unattributed chunk — must abstain rather than invent diarisation, even though the words are unambiguous.",
  },
  {
    id: "trust-scam-paraphrase", speaker: "prospect", previousChunkText: "It's an AI note-taker, similar to what you might have on Zoom.",
    text: "How do I even know this isn't just some kind of scam thing recording us?",
    expectedTags: ["trust_privacy"], note: "Different phrasing of the trust/scam concern than the regex list uses.",
  },
  {
    id: "context-only-previous-chunk", speaker: "prospect", previousChunkText: "It's too expensive for us right now.",
    text: "Anyway, what happens if a call comes in outside business hours?",
    expectedTags: [], note: "This NEW chunk is a plain question; the earlier price objection must not leak forward into it.",
  },
];
