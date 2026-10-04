/**
 * Which agent bot a request names, from the words alone (pure). One grammar for the two places that need it:
 *
 *   - the voice rules (scripts/free-voice.ts), so "use the builder agent", "builder, open Chrome" or "in my agents, have the builder open a
 *     Chrome tab" go to the ONE command path as a bot's request, never to the speaker's own PC, the brain or the coding harness first;
 *   - the bot scope (scripts/agents/jarvis.ts named()), which decides the bot for the command path itself.
 *
 * Nothing here starts, routes or reads anything: it returns the bot and what is left of the words.
 */

export type BotName = { id: string; name: string };
export type Named<B extends BotName = BotName> = {
  bot: B;
  /** "task": the words are the bot's task; "bare": the bot was named with no task ("use the builder agent"); show / continue / stop as before. */
  kind: "task" | "bare" | "show" | "continue" | "stop";
  /** The task (kind "task"), "" otherwise. */
  task: string;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Words that come before the request itself: "hey Jarvis", "so", "in my agents section", "I want you to", "can you", "why can't you". */
const LEAD = String.raw`^(?:(?:hey\s+)?jarvis[,\s]+)?(?:(?:so|okay|ok|right|and|now|yeah|well|no|nope|nah|actually|um|uh)[,\s]+){0,3}(?:(?:in|on|from|under)\s+(?:my|the|our)\s+agents?(?:'s)?(?:\s+(?:sections?|workspace|page|tab|area|view))?[,\s]+)?(?:(?:i\s+(?:want|need|wanna)\s+(?:you\s+)?to|i(?:'d|\s+would)\s+like\s+(?:you\s+)?to|(?:can|could|would|will)\s+you|why\s+(?:can'?t|cannot|won'?t|didn'?t|couldn'?t)\s+you|please|just|go\s+(?:and\s+)?)\s+)*`;
const NOUN = String.raw`(?:\s+(?:cloud\s+)?(?:bot|agent|computer|desktop|machine))?`;

/** "open Chrome on it" → "open Chrome"; trailing courtesy and "on its computer" are not part of the task. */
export function cleanTask(task: string): string {
  return task
    .trim()
    .replace(/[\s,]+(?:for me|please|thanks|thank you)\s*[.!?]*$/i, "")
    .replace(/\s+(?:on|in|with)\s+(?:it|there|that|its (?:own )?computer|his computer|her computer|the (?:bot|agent)'?s? computer)\s*[.!?]*$/i, "")
    .replace(/[\s.!?]+$/, "")
    .trim();
}

export function namedBot<B extends BotName>(utterance: string, bots: readonly B[]): Named<B> | null {
  if (!bots.length) return null;
  const names = [...new Set(bots.flatMap((b) => [b.id.toLowerCase(), b.name.toLowerCase()]))].sort((a, b) => b.length - a.length).map(escape).join("|");
  const botFor = (word: string) => bots.find((b) => b.id.toLowerCase() === word.toLowerCase() || b.name.toLowerCase() === word.toLowerCase()) ?? null;
  const text = String(utterance ?? "").trim().replace(/[’`]/g, "'").replace(/\s+/g, " ");
  const out = (word: string | undefined, kind: Named["kind"], task = "", asSaid = false): Named<B> | null => {
    const bot = word ? botFor(word) : null;
    if (!bot) return null;
    if (kind !== "task") return { bot, kind, task: "" };
    const t = asSaid ? task.trim() : cleanTask(task);
    return t.length >= 2 ? { bot, kind: "task", task: t } : { bot, kind: "bare", task: "" };
  };
  // "Ask Research to find X", "Have Builder fix this on Claude Max 2", "Get the research bot to ...", "Tell Builder: ..." (the task kept as said)
  let m = new RegExp(`${LEAD}(?:ask|tell|have|get|let)\\s+(?:the\\s+)?(${names})(?:'s)?${NOUN}(?:\\s+to|\\s*[:,])?\\s+(.{2,})$`, "i").exec(text);
  if (m) return out(m[1], "task", m[2], true);
  // "Show me Research's computer", "open the builder bot", "what's Research doing", "how is Builder doing"
  m = new RegExp(`${LEAD}(?:(?:show|open|bring up|pull up|check on)\\s+(?:me\\s+)?(?:the\\s+)?(${names})(?:'s)?${NOUN}|(?:what'?s|how'?s|how is|what is)\\s+(?:the\\s+)?(${names})(?:'s)?${NOUN}\\s+(?:doing|up to|going|status))\\s*[.!?]*$`, "i").exec(text);
  if (m) return out(m[1] ?? m[2], "show");
  // "Continue the research", "resume the builder task", "pick up Builder's work"
  m = new RegExp(`${LEAD}(?:continue|resume|carry on(?: with)?|pick up)\\s+(?:the\\s+|that\\s+|this\\s+|my\\s+)?(${names})(?:'s)?(?:\\s+(?:job|task|work|run|research))?${NOUN}\\s*[.!?]*$`, "i").exec(text);
  if (m) return out(m[1], "continue");
  // "Stop the Research task", "cancel Builder"
  m = new RegExp(`${LEAD}(?:stop|cancel|abort)\\s+(?:the\\s+)?(${names})(?:'s)?(?:\\s+(?:task|job|run|work))?${NOUN}\\s*[.!?]*$`, "i").exec(text);
  if (m) return out(m[1], "stop");
  // "Use the builder agent", "run a builder for me and open Chrome on it", "use the Research bot to find X", "why can't you launch the Builder?".
  // The bot needs an article before it ("the builder") or "bot"/"agent" after it, so "start research on X" stays a plain request.
  m = new RegExp(`${LEAD}(?:use|try|run|start|launch|fire up|wake up|pick|go with|switch to|get)\\s+(?:(?:the|my|our|a|an)\\s+(${names})(?:'s)?${NOUN}|(${names})\\s+(?:bot|agent))(?:\\s+for\\s+me)?(?:\\s*[,:]?\\s*(?:to|and(?:\\s+then)?|so(?:\\s+that)?\\s+it|until|then)\\s+(.{2,})|\\s*[,:]\\s*(.{2,}))?\\s*[.!?]*$`, "i").exec(text);
  if (m) return out(m[1] ?? m[2], "task", m[3] ?? m[4] ?? "");
  // "Builder, open Chrome", "Research agent: find the contact page"
  m = new RegExp(`${LEAD}(${names})(?:\\s+(?:bot|agent))?\\s*[,:]\\s*(.{2,})$`, "i").exec(text);
  if (m) return out(m[1], "task", m[2]);
  return null;
}

/** "tell it to …", "have it …", "ask it to …": a task for the bot named just before. The task, or null. */
export function pronounTask(utterance: string): string | null {
  const text = String(utterance ?? "").trim().replace(/[’`]/g, "'").replace(/\s+/g, " ");
  const m = new RegExp(`${LEAD}(?:tell|ask|have|get|let)\\s+(?:it|him|her|them|that one)(?:\\s+to|\\s*[:,])?\\s+(.{2,})$`, "i").exec(text);
  const t = m ? cleanTask(m[1]) : "";
  return t.length >= 2 ? t : null;
}

/** Everyday apps a spoken bot task names. Speech-to-text mishears short app names ("start a crowd" for "start Chrome"). */
const KNOWN_APPS = ["chrome", "edge", "firefox", "notepad", "word", "excel", "powerpoint", "outlook", "teams", "spotify", "slack", "discord", "terminal", "explorer", "calculator", "paint", "vscode", "code", "whatsapp", "zoom", "figma", "obsidian", "browser", "youtube", "google", "gmail"];
/** Real words that are not apps but are fine to start or open: never "corrected". */
const NOT_MISHEARD = new Set(["calendar", "settings", "files", "folder", "photos", "camera", "music", "maps", "clock", "store", "inbox", "mail", "email", "leads", "notes", "task", "tasks", "job", "research", "search", "website", "site", "page", "tab", "window", "app", "document", "report", "draft", "meeting", "timer"]);
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/**
 * A one-word "start/open/launch X" where X is not an app anyone uses but sounds like one ("start a crowd" → Chrome): what was probably meant,
 * so the bot asks in plain words instead of starting a goal nobody asked for. Null when X is a known app, not close to one, or more than a word.
 */
export function misheardApp(task: string): { heard: string; meant: string } | null {
  const m = /^(?:start|open|launch|run|fire up|load)\s+(?:up\s+)?(?:a|an|the|my)?\s*([a-z]{3,12})(?:\s+(?:tab|window|app))?$/i.exec(cleanTask(task));
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (KNOWN_APPS.includes(word) || NOT_MISHEARD.has(word)) return null;
  let best: { app: string; d: number } | null = null;
  for (const app of KNOWN_APPS) {
    if (app.length < 4 || app[0] !== word[0]) continue;
    const d = distance(word, app);
    if (d <= Math.min(3, Math.max(2, Math.floor(app.length / 2))) && (!best || d < best.d)) best = { app, d };
  }
  return best ? { heard: cleanTask(task), meant: `open ${best.app[0].toUpperCase()}${best.app.slice(1)}` } : null;
}

/** "Chrome, Chrome, Chrome tab" / "a Chrome tab" said as the answer to "what should Builder do?": the task it means ("open a Chrome tab"). */
export function answerAsTask(utterance: string): string {
  const words = cleanTask(String(utterance ?? "").replace(/[,]+/g, " ")).split(/\s+/).filter(Boolean);
  const kept = words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase());
  const text = kept.join(" ");
  return /^(?:open|start|launch|run|go|search|find|look|show|close|type|write|click|make|create|check|read|get|fix|build|research|visit|play|download|log|sign|book|send|post)\b/i.test(text) ? text : `open ${text}`;
}
