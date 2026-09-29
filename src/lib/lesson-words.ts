/**
 * The words of a lesson (Jarvis teaching a task on his screen, or taking over), shared by the
 * server's routing (scripts/screen-hands/teach.ts, free-voice rules, the Jev bench) and the voice
 * client, which steers a running lesson with no model call ("next", "just do it", "stop").
 * Pure. Design: docs/SCREEN-CONTROL.md, "Teach mode".
 */
import { isAffirmative } from "./jarvis-control";

export type LessonMode = "teach" | "drive";
/**
 * How a lesson teaches (Teach Mode 2.0): "show" (Jarvis does each step with his cursor and says
 * what he's doing), "guide" (he points and explains, then waits for HIM, with a hint if he's stuck)
 * or "quiz" (only the goal; he does it unassisted, and a hint only if he asks or stalls).
 */
export type LessonStyle = "show" | "guide" | "quiz";
export type LessonControl = "next" | "skip" | "drive" | "teach" | "stuck" | "repeat" | "stop" | "known" | "hint";
export type LessonState = "teaching" | "driving" | "confirm" | "ask" | "ended";

/** "Hey Jarvis, can you…please" → the order itself (same rules as screen_act's tidy). */
export function tidyWords(utterance: string) {
  return utterance
    .trim()
    .replace(/^(?:(?:ok(?:ay)?|right|alright|hey)[,\s]+)?(?:jarvis[,\s]+)?/i, "")
    .replace(/^(?:can you|could you|would you|will you|please|now|go ahead and|just)\s+/i, "")
    .replace(/^(?:please|now|just)\s+/i, "")
    .replace(/[\s,]+(?:please|for me|thanks|thank you|jarvis|sir)[.!?]*$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

const TEACH_STARTS: RegExp[] = [
  /^(?:can you |could you |would you )?show me how (?:to|do i|you|i can) (.+)$/i,
  /^(?:can you |could you )?teach me(?: how)?(?: to| about)? (.+)$/i,
  // Not "where do I go to…" or "where do I find…": those are usually a folder or one of the OS's
  // pages ("where do I find my downloads"), which pc_act and navigate answer.
  /^where do i (?:click|press|tap) (?:to|for|if i want to) (.+)$/i,
  /^where do i ((?:change|set|turn on|turn off|switch on|switch off) .+)$/i,
  /^(?:can you |could you )?(?:walk|talk|guide|take) me through(?: how to)? (.+)$/i,
  /^(?:can you |could you )?show me where (?:to|i) (.+)$/i,
  /^how do i (.+?) (?:here|in here|in this(?: app| window| page)?|on this(?: page| screen)?|on (?:my|the) screen)$/i,
];
const DRIVE_STARTS: RegExp[] = [/^(?:you do it|just do it|take over|take control|do it for me)[,:]?\s+(?:and\s+)?(.+)$/i];

/** "Show me how to change the font" → a teach lesson; "take over and fill this in" → drive. Pure. */
export function lessonIntent(utterance: string): { mode: LessonMode; goal: string } | null {
  const u = tidyWords(utterance);
  if (!u || u.length > 240) return null;
  for (const re of DRIVE_STARTS) {
    const m = u.match(re);
    if (m && m[1].trim().length > 2) return { mode: "drive", goal: m[1].trim() };
  }
  for (const re of TEACH_STARTS) {
    const m = u.match(re);
    if (!m) continue;
    const goal = m[1].replace(/\?+$/, "").trim();
    // "teach me something", "show me how you work": not a task on his screen.
    if (goal.length < 3 || /^(?:something|anything|stuff|it|this|that|you work|to use you)$/i.test(goal)) return null;
    return { mode: "teach", goal };
  }
  return null;
}

const CONTROLS: Array<[LessonControl, RegExp]> = [
  // "I know this": skip this whole lesson and remember he knows it (a course moves on).
  ["known", /^(?:i (?:already )?know (?:this|that|how(?: to do (?:this|that))?)(?: (?:one|bit|already))?|i know how|i'?ve done this before|skip this lesson|i can do this already)$/],
  ["hint", /^(?:(?:give me |can i (?:have|get) |i need )?a hint|hint(?: please)?|help me out|give me a clue|clue)$/],
  ["stop", /^(?:stop|stop (?:it|that|now|teaching|the lesson|there)|cancel(?: (?:it|that|the lesson))?|never ?mind|that'?s (?:enough|all|it)|end (?:the )?lesson|quit|forget it|leave it)$/],
  ["drive", /^(?:(?:just |you )?do it(?: for me)?|you do it|you do (?:the rest|it for me)|take over|you take over|take control|you take control|you drive|do the rest|finish it(?: for me| off)?|you finish it|(?:just )?take it from here)$/],
  ["teach", /^(?:let me (?:do it|try|drive)|i'?ll do it|i'?ll try|show me instead|teach me instead|back to teaching)$/],
  ["skip", /^(?:skip(?: (?:it|this|that))?(?: (?:one|step))?|skip ahead|move on)$/],
  // "You do this one": just this step, then back to teaching (like "I can't find it").
  ["stuck", /^(?:(?:you )?do (?:this|that) one(?: for me)?|you do this|i can'?t (?:find|see) (?:it|that|them)|where is it|i don'?t see (?:it|that)|can'?t (?:find|see) it|i'?m (?:lost|stuck)|it'?s not there|not there|i don'?t get it|i can'?t do it|it'?s not working|nothing happened)$/],
  ["repeat", /^(?:again|say (?:that|it) again|repeat(?: that)?|come again|which one|where|show me again|sorry|pardon|what was that)$/],
  ["next", /^(?:next|next (?:one|step|bit)|done|done that|(?:i'?ve |i )?(?:done|did) (?:it|that)|did it|got it|finished|i'?m done|what'?s next|what now|and now|then what|ready|okay next|ok next|okay done|ok done)$/],
];

// --- courses (Teach Mode 2.0): several lessons for an app, with saved progress --------------------
export type CourseAction = "start" | "continue" | "next" | "list";
export type CourseIntent = { action: CourseAction; topic?: string; style?: LessonStyle };

/** A lesson goal starts with a verb ("change the font"); a course names an app or a topic. */
const TASK_VERB =
  /^(?:how\b|to\b|add|adjust|apply|arrange|attach|build|change|check|clear|close|colour|color|combine|connect|convert|copy|create|crop|customi[sz]e|cut|delete|disable|do|download|draw|duplicate|edit|enable|export|fill|filter|find|fix|format|get|group|hide|import|insert|install|join|lock|make|merge|move|name|open|organi[sz]e|paste|pin|print|put|record|remove|rename|render|reset|resize|restore|rotate|run|save|schedule|search|select|send|set|share|show|sort|split|start|stop|switch|sync|track|trim|turn|type|undo|unhide|update|upload|use|write|zoom)\b/i;
const STYLE_WORDS: Array<[LessonStyle, RegExp]> = [
  ["quiz", /\b(?:quiz|test) me\b/i],
  ["show", /\b(?:show me|you do (?:it|them)|demo(?:nstrate)?)\b/i],
  ["guide", /\b(?:guide me|let me (?:do|try) (?:it|them)|walk me through)\b/i],
];
const styleIn = (u: string) => STYLE_WORDS.find(([, re]) => re.test(u))?.[0];

/**
 * "Teach me DaVinci Resolve", "teach me Excel pivot tables", "I want to learn Figma" → a course;
 * "continue my Resolve lessons", "next lesson", "quiz me on Excel", "what's in my Figma course".
 * A task ("teach me how to change the font") stays a single lesson (lessonIntent). Pure.
 */
export function courseIntent(utterance: string): CourseIntent | null {
  const u = tidyWords(utterance).replace(/[’`]/g, "'").replace(/\?+$/, "").trim();
  if (!u || u.length > 120) return null;
  const style = styleIn(u);
  const withStyle = (i: CourseIntent): CourseIntent => (style ? { ...i, style } : i);
  let m: RegExpMatchArray | null;
  if (/^(?:(?:the |my )?next lesson|start the next lesson|(?:continue|resume|carry on with|keep going with|pick up)(?: (?:my|the))? (?:lessons?|course|training)|continue where (?:i|we) left off)$/i.test(u)) return withStyle({ action: "next" });
  if ((m = u.match(/^(?:continue|resume|carry on with|keep going with|pick up|back to|(?:guide|walk|take) me through|(?:quiz|test) me on|show me)(?: (?:with|on))?(?: my| the)? (.+?) (?:lessons?|course|training|tutorials?)$/i))) return withStyle({ action: "continue", topic: m[1].trim() });
  if ((m = u.match(/^(?:what'?s|what is) (?:in |left in |next in )?my (.+?) (?:course|lessons?)$|^(?:list|show) (?:me )?my (.+?)? ?(?:courses|lessons)$/i))) return { action: "list", ...((m[1] ?? m[2]) ? { topic: (m[1] ?? m[2]).trim() } : {}) };
  if ((m = u.match(/^(?:quiz|test) me (?:on|in|about) (.+)$/i))) return { action: "continue", topic: m[1].trim(), style: "quiz" };
  m =
    u.match(/^(?:give me |make me |build me |start |do )?(?:a |an )?(?:course|lessons?|tutorials?|training|crash course) (?:on|in|for|about) (.+)$/i) ??
    u.match(/^(?:i want to|i'd like to|help me|i need to) learn(?: how to use)? (.+)$/i) ??
    u.match(/^(?:teach|train) me(?: all)? about (.+)$/i) ??
    u.match(/^(?:teach|train) me (?:the basics of|to use|how to use) (.+)$/i) ??
    u.match(/^(?:teach|train) me (.+)$/i);
  if (!m) return null;
  const topic = m[1].replace(/\b(?:from scratch|step by step|properly|please|as a beginner)\b/gi, "").replace(/\s+/g, " ").trim();
  // A task, not a subject: a single lesson (lessonIntent) answers "teach me to change the font".
  if (!topic || topic.length < 2 || TASK_VERB.test(topic) || topic.split(" ").length > 6 || /^(?:something|anything|stuff|it|this|that|you)$/i.test(topic)) return null;
  // "Teach me how to use Figma" is a course; "teach me how the font works" isn't anything.
  return withStyle({ action: "start", topic });
}

/** A word that steers a running lesson. Only meaningful while one is active. Pure. */
export function lessonControl(utterance: string): LessonControl | null {
  const u = tidyWords(utterance).toLowerCase().replace(/[’`]/g, "'").replace(/[?!.,]+$/g, "").trim();
  if (!u || u.length > 60) return null;
  for (const [control, re] of CONTROLS) if (re.test(u)) return control;
  return null;
}

export type LessonCommand = { control: LessonControl } | { confirm: string } | { answer: string };

/** Words that make a yes conditional: it waits for another time or another step. */
const CONDITIONAL = /\b(?:after|once|when|later|first|until|before|in a (?:sec|second|minute|moment)|let me (?:check|review|read|look))\b/i;

/**
 * While a lesson runs, what his words do to it, with no model call: a control ("next", "you do
 * it", "stop"), his yes to the one pending final button, or his answer to Jarvis's question. Null
 * means an ordinary turn (the lesson carries on in the background). Pure.
 */
export function lessonShortcut(utterance: string, lesson: { state: LessonState; confirm?: string } | null): LessonCommand | null {
  if (!lesson || lesson.state === "ended") return null;
  const control = lessonControl(utterance);
  if (lesson.state === "confirm") {
    if (control === "stop") return { control: "stop" };
    // A qualified yes ("yes, after I review it", "yes once I've checked") isn't a yes yet.
    if (lesson.confirm && isAffirmative(utterance) && !CONDITIONAL.test(utterance)) return { confirm: lesson.confirm };
    // "No", "leave it", "not yet": the button stays unpressed.
    if (/^\s*(?:no|nope|nah|don'?t|do not|not yet|leave it|wait|hold on)\b/i.test(utterance)) return { control: "skip" };
    return null;
  }
  if (lesson.state === "ask") {
    if (control === "stop" || control === "skip") return { control };
    const answer = tidyWords(utterance);
    return answer ? { answer } : null;
  }
  return control ? { control } : null;
}
