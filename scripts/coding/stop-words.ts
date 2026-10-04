// Round 11 (defect 2): an explicit Stop said while the coding planner is asking a question. The whole utterance must be a stop or cancel
// command; a file name or path that merely contains the word ("src/stop.ts", "stop.ts", "the stop button in src/ui/stop-button.tsx") is an
// answer, never a stop. Pure.

const LEAD = String.raw`(?:(?:please|ok(?:ay)?|no|actually|jarvis)[,\s]+)*`;
const VERB = String.raw`(?:stop|cancel|abort|halt|never\s*mind)`;
const TAIL_WORD = String.raw`(?:it|that|this|now|please|everything|all|the|my|that's|draft|question|request|plan|coding|job|task|work|build|builder|reviewer|tester|one|for|about)`;
const STOP_COMMAND = new RegExp(String.raw`^${LEAD}${VERB}(?:[,\s]+${TAIL_WORD})*[\s.!]*$`, "i");
// "drop", "scrap" and "forget" are natural answers to an either/or question ("drop it", "forget that one", "scrap that"): they cancel only when
// they name the work itself ("scrap the job", "drop the draft", "forget the coding request"). Review, round 11.
const WEAK_VERB = String.raw`(?:drop|scrap|forget)`;
const WORK_NOUN = String.raw`(?:draft|request|plan|coding|job|task|build)`;
const WEAK_COMMAND = new RegExp(String.raw`^${LEAD}${WEAK_VERB}(?:[,\s]+(?:it|that|this|the|my|whole|coding|now|please))*[,\s]+${WORK_NOUN}(?:[,\s]+(?:job|request|draft|now|please))*[\s.!]*$`, "i");

/** True when the whole utterance is a stop/cancel command ("stop", "stop that", "never mind", "cancel the draft", "please stop the coding job"). */
export function isStopCommand(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t || t.length > 80) return false;
  // A path or file name is an answer: a slash, a backslash or a dotted extension anywhere in the words.
  if (/[\\/]|\.[a-z0-9]{1,6}\b/i.test(t.replace(/[.!]+$/, ""))) return false;
  return STOP_COMMAND.test(t) || WEAK_COMMAND.test(t);
}

/** The stop names the running coding job or one of its roles (so it reaches that job, not only the pending question). */
export function namesCodingWork(text: string): boolean {
  return /\b(?:coding|job|build|builder|reviewer|tester)\b/i.test(String(text ?? ""));
}
