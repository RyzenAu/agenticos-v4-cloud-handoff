/**
 * Follow-ups about a job that is already going (Open Dot V). PURE: words + the person's linked jobs in, one decision out. The command
 * service acts on it (status from the real job state, cancel through the existing cancel path, extra context recorded on the job).
 *
 * Which job does "that" mean? One rule for status, stop and add-context:
 *   1. a topical reference names it: "the research job", "the coding task", "that Bondi research" (title/kind match);
 *   2. otherwise the job the person most recently referenced (started it, asked about it, added to it);
 *   3. a tie, or several topical matches, is ambiguous: ONE short question, and nothing is done until he answers.
 *
 * Attach (add context to the running job instead of starting a second one):
 *   - an explicit reference ("for that task, also ...", "add to the research job: ...") attaches at once; or
 *   - a continuation marker ("also", "include", "only", "instead") inside the active-job window (2 minutes since the job was last
 *     referenced) attaches ONLY when what follows overlaps the job's own topic (at least half of its content words, and at least one).
 *     Having a single open job is never enough: "skip this song", "don't forget my 5pm meeting" and "also open YouTube" are new
 *     commands and go through the normal path. Several equally good topical matches: ask. Anything else is a new request.
 * Nothing here ever starts, stops or edits a job; it only decides.
 */

export type ActiveJob = {
  jobId: string;
  kind: "job" | "coding";
  title: string;
  /** Real state from the job service (never from the words). */
  state: string;
  /** Epoch ms: last started/asked-about/added-to. */
  lastReferencedAt: number;
  /** The conversation whose thread links it. */
  conversationId?: string;
  /** The agent bot whose conversation links it (a bot thread's job). */
  bot?: string;
};

export type FollowUp =
  | { kind: "status"; jobId: string }
  | { kind: "cancel"; jobId: string }
  | { kind: "attach"; jobId: string; context: string }
  | { kind: "ask"; question: string; options: string[] }
  | { kind: "none" };

export const ATTACH_WINDOW_MS = 2 * 60_000;
/** A job that ended this recently can still be asked about ("how's that going?" right after it finished). */
export const STATUS_RECENT_MS = 10 * 60_000;
/** Job service states and coding-store states alike: open is everything that has not ended. */
const ENDED = new Set(["succeeded", "completed", "failed", "cancelled", "interrupted", "unknown"]);
export const isOpenState = (state: string) => !ENDED.has(state);

const STOP_TOPIC = new Set(["a", "an", "the", "that", "this", "it", "my", "our", "job", "task", "work", "run", "one", "please", "on", "for", "of", "to", "and", "in", "at", "with", "computer", "bot", "agent"]);
const tokens = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_TOPIC.has(w));

/** Words that say "the same kind of work" for a job: its kind, and the nouns people use for it. */
function topicWords(job: ActiveJob): Set<string> {
  const set = new Set(tokens(job.title));
  if (job.kind === "coding") for (const w of ["coding", "code", "builder", "reviewer", "fix", "repo", "branch"]) set.add(w);
  return set;
}

/** Named groups `a`..`e` capture the topic of "how's the X going" / "status of X" so a question about something that is NOT one of his jobs ("how's the market doing") is never answered as a job's status. */
const STATUS = /^(?:so\s+|ok(?:ay)?\s+|and\s+)?(?:how(?:'s| is| are| did)\s+(?:that|it|this|things|(?:the|my)\s+(?<a>.{2,40}?))(?:\s+(?:going|coming along|looking|doing|go|get on|progress(?:ing)?))?|what(?:'s| is)\s+(?:the\s+)?(?:status|progress|update)(?:\s+(?:on|of|with)\s+(?<b>.{2,40}?))?|any\s+(?:update|news|progress)(?:\s+(?:on|with)\s+(?<c>.{2,40}?))?|is\s+(?:that|it|the\s+(?<d>.{2,40}?))\s+(?:done|finished|ready|working)(?:\s+yet)?|are\s+we\s+(?:there|done)(?:\s+yet)?|(?:did|has)\s+(?:that|it|the\s+(?<e>.{2,40}?))\s+(?:finish|finished|work|worked|go through)(?:\s+yet)?)\s*[?.!]*$/i;
const STOP = /^(?:please\s+)?(?:jarvis,?\s+)?(?:stop|cancel|abort|kill|end|drop)\s+(?:that|this|the\s+(.{2,40}?)|my\s+(.{2,40}?)|it)(?:\s+(?:task|job|run|work|request|one))?\s*[.!?]*$/i;
const BARE_STOP = /^(?:please\s+)?(?:jarvis,?\s+)?(?:stop|cancel|abort|never\s?mind|forget it)(?:\s+(?:it|that|this|now))?\s*[.!?]*$/i;
/** "the research job", "that coding task", "the Bondi research": a topical reference. Group 1 = the topic. */
const REFERENCE_TAIL = /^((?:[a-z0-9'-]+\s+){0,3}?)(?:job|task|run|work|research|build)\b/i;
/** The LAST "the/that/my <topic> job|task|research" in the words ("what's the status of the research job" means the research job). */
function referenceHint(text: string): string {
  let hint = "";
  for (const m of text.matchAll(/\b(?:that|this|the|my)\s+/gi)) {
    const t = REFERENCE_TAIL.exec(text.slice(m.index! + m[0].length));
    if (t) hint = t[1].trim();
  }
  return hint;
}
const EXPLICIT_ATTACH = /^(?:please\s+)?(?:(?:for|on|to|in|about)\s+(?:that|this|the\s+[^,:]{2,40}?|my\s+[^,:]{2,40}?)\s+(?:job|task|run|research|work)\b[,:\s-]*|(?:add|include|attach|tell)\s+(?:this\s+)?(?:to|in|for)\s+(?:that|this|the\s+[^,:]{2,40}?)\s+(?:job|task|run|research|work)\b[,:\s-]*|(?:add|include)\s+to\s+(?:that|it)\b[,:\s-]*)(.{3,})$/i;
const MARKER = /^(?:and\s+)?(?:also|plus|one more thing|oh and|and also|make sure|please also|actually|include|exclude|only|but|don't|do not|instead|focus on|prioriti[sz]e|skip|ignore)\b/i;
const MARKER_WORDS = new Set(["also", "plus", "make", "sure", "please", "include", "exclude", "only", "but", "dont", "don't", "instead", "focus", "skip", "ignore", "actually", "forget", "more", "thing", "prioritise", "prioritize"]);
/** Markers that only ever ADD to the work in hand (never "don't", "skip", "instead", "but", "ignore", "actually"). */
const ADDITIVE = /^(?:and\s+)?(?:also|plus|and also|please also|one more thing|oh and|include|exclude|focus on|prioriti[sz]e)\b/i;
const ANAPHOR = /\b(?:their|its|them|those|these)\b/i;
const NEW_ACTION = /^(?:and\s+)?(?:also\s+)?(?:please\s+)?(?:open|go to|play|send|call|email|text|message|navigate|switch|close|launch|start|run|remind|set|turn|show me|take me)\b/i;

function candidates(active: ActiveJob[], hint: string): ActiveJob[] {
  const want = tokens(hint);
  if (!want.length) return [];
  return active.filter((j) => {
    const topic = topicWords(j);
    return want.some((w) => topic.has(w) || [...topic].some((t) => t.startsWith(w) || w.startsWith(t)));
  });
}

/** The most recently referenced job, or null when two share the newest time (ask). */
function newest(active: ActiveJob[]): ActiveJob | null {
  if (!active.length) return null;
  const sorted = [...active].sort((a, b) => b.lastReferencedAt - a.lastReferencedAt);
  return sorted.length === 1 || sorted[0].lastReferencedAt > sorted[1].lastReferencedAt ? sorted[0] : null;
}

const nameOf = (j: ActiveJob) => `"${j.title.slice(0, 40)}"`;
function askWhich(options: ActiveJob[], verb: string): FollowUp {
  const names = options.slice(0, 3).map(nameOf);
  return { kind: "ask", question: `Which one: ${names.slice(0, -1).join(", ")}${names.length > 1 ? " or " : ""}${names.at(-1)}?`.replace("Which one:", `Which one to ${verb}:`), options: options.slice(0, 3).map((j) => j.jobId) };
}

/** Resolve "that/it/the X job" to one job. `pool`: the jobs a phrase may mean. */
function resolve(text: string, pool: ActiveJob[], verb: string): { job: ActiveJob } | { ask: FollowUp } | null {
  if (!pool.length) return null;
  const hint = referenceHint(text) || (STOP.exec(text)?.[1] ?? STOP.exec(text)?.[2] ?? "").trim() || (Object.values(STATUS.exec(text)?.groups ?? {}).find(Boolean) ?? "").trim();
  const topical = hint ? candidates(pool, hint) : [];
  if (hint && tokens(hint).length && !topical.length) return null; // names something that isn't one of his jobs: not ours to answer
  if (topical.length === 1) return { job: topical[0] };
  if (topical.length > 1) {
    const n = newest(topical);
    return n ? { job: n } : { ask: askWhich(topical, verb) };
  }
  if (pool.length === 1) return { job: pool[0] };
  const n = newest(pool);
  return n ? { job: n } : { ask: askWhich(pool, verb) };
}

export function classifyFollowUp(utterance: string, jobs: ActiveJob[], now: number): FollowUp {
  const text = utterance.trim().replace(/\s+/g, " ").replace(/^(?:hey\s+)?jarvis[,\s]+/i, "");
  if (!text || !jobs.length) return { kind: "none" };
  const open = jobs.filter((j) => isOpenState(j.state));
  const recent = jobs.filter((j) => isOpenState(j.state) || now - j.lastReferencedAt <= STATUS_RECENT_MS);

  if (STATUS.test(text)) {
    const r = resolve(text, recent, "check");
    return !r ? { kind: "none" } : "job" in r ? { kind: "status", jobId: r.job.jobId } : r.ask;
  }
  if (STOP.test(text) && !/\b(?:music|timer|alarm|video|playback|recording)\b/i.test(text)) {
    // A bare "stop it" (no job/task word) only means a job he just mentioned: otherwise it is for whatever is playing or running elsewhere.
    const bare = !/\b(?:task|job|run|work|request|one)\b/i.test(text) && /^(?:please\s+)?(?:jarvis,?\s+)?(?:stop|cancel|abort|kill|end|drop)\s+(?:it|this|that)\s*[.!?]*$/i.test(text);
    const r = resolve(text, bare ? open.filter((j) => now - j.lastReferencedAt <= ATTACH_WINDOW_MS) : open, "stop");
    return !r ? { kind: "none" } : "job" in r ? { kind: "cancel", jobId: r.job.jobId } : r.ask;
  }
  // A bare "stop" belongs to the existing stop path unless it is plainly about several of his jobs: then ask which.
  if (BARE_STOP.test(text) && open.length > 1) return askWhich(open, "stop");
  if (BARE_STOP.test(text) && open.length === 1 && open[0].kind === "job" && now - open[0].lastReferencedAt <= ATTACH_WINDOW_MS) return { kind: "cancel", jobId: open[0].jobId };

  const explicit = EXPLICIT_ATTACH.exec(text);
  if (explicit && open.length) {
    const r = resolve(text, open, "add to");
    if (!r) return { kind: "none" };
    return "job" in r ? { kind: "attach", jobId: r.job.jobId, context: explicit[1].trim().slice(0, 300) } : r.ask;
  }
  if (MARKER.test(text)) {
    const inWindow = open.filter((j) => now - j.lastReferencedAt <= ATTACH_WINDOW_MS);
    if (!inWindow.length) return { kind: "none" };
    if (NEW_ACTION.test(text.replace(MARKER, "").trim())) return { kind: "none" };
    const words = tokens(text.replace(MARKER, "")).filter((w) => !MARKER_WORDS.has(w));
    // Stricter topical check: the overlap must cover at least half of the content words, so one shared word in a long unrelated request is not enough.
    const scored = inWindow
      .map((j) => ({ j, score: words.filter((w) => topicWords(j).has(w)).length }))
      .map((s) => (s.score > 0 && s.score * 2 >= words.length ? s : { ...s, score: 0 }))
      .sort((a, b) => b.score - a.score);
    const clean = text.replace(/^(?:and\s+)?(?:also|plus|and also|please also)[,\s]+/i, "").slice(0, 300);
    if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) return { kind: "attach", jobId: scored[0].j.jobId, context: clean };
    if (scored[0].score > 0) return askWhich(scored.filter((s) => s.score === scored[0].score).map((s) => s.j), "add that to");
    // No topical overlap. An additive marker that points back at the job's subject with "their/its/them/those" ("also include their
    // opening hours") attaches when it is the ONLY job in the window, and asks when there are several. Nothing else is guessed.
    if (ADDITIVE.test(text) && ANAPHOR.test(text)) return inWindow.length === 1 ? { kind: "attach", jobId: inWindow[0].jobId, context: clean } : askWhich(inWindow, "add that to");
    return { kind: "none" }; // no topical match: a new command, never guessed onto a running job
  }
  return { kind: "none" };
}
