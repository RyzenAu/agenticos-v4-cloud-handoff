// Jarvis's hands on the real screen: the pure parts (unit tested, no Windows needed).
//
// - parseSnapshot: the native helper's rows → elements, with web content marked in a browser.
// - parseGoal: plain commands ("click the Name field and type Test", "select all", "scroll down a
//   bit", "type hello world in there") → steps, with no model call. Open goals ("help me finish
//   this form") return null and go to the step-by-step model loop.
// - pickElement: which element he means ("the Name field", "Next", "the second button").
// - vetAction: the safety rules every action passes, whoever chose it (rules, Jev, the model or
//   vision): no typing into password fields or of secrets, no final Submit/Pay/Send/Delete… without
//   his spoken yes, no clicking controls whose text is instructions aimed at Jarvis.
// - screenActIntent: which utterances are about his screen (routing, used by free-voice.ts).
import { similarity } from "../jarvis-skills/fuzzy";
import { looksSecret } from "../jarvis-skills/text";
import { FINAL_BUTTON } from "../../src/lib/action-keywords";
import { MONEY_AMOUNT, moneyButton, moneyContext, moneyContextLevel, moneySurfaceRefusal, ownDashboard, type MoneyContextLevel } from "../../src/lib/money-policy";

export type UiElement = {
  id: number;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  password: boolean;
  enabled: boolean;
  focused: boolean;
  hasValue: boolean;
  readOnly: boolean;
  toggled?: boolean;
  /** ExpandCollapse state (menus, drop-downs, settings expanders), when the control has one. */
  expanded?: boolean;
  /** SelectionItem: this tab, list item or radio is the selected one. */
  selected?: boolean;
  /** Supports UIA Invoke (a press needs no mouse). */
  invokable?: boolean;
  name: string;
  aid: string;
  help: string;
  value: string;
  /** Inside the page (not the browser's own toolbar or tabs), when the window is a browser. */
  web?: boolean;
};
export type Snapshot = {
  window: { x: number; y: number; w: number; h: number };
  elements: UiElement[];
  focused: UiElement | null;
  browser: boolean;
  /**
   * Containers (Window, Pane, Group rectangles smaller than the window) from the helper's "B" rows: a dialog,
   * card or box. An amount and a commit press in the same one are an amount box (R8 §2). Absent in older fakes.
   */
  boxes?: UiElement[];
  /** The helper cut the context read short (a cap or its deadline): "no amount seen" then means "unknown" (R8 review §4). */
  truncated?: boolean;
};

// --- snapshot ------------------------------------------------------------------------------------
/** One helper row (E/F/A tab-separated columns) → an element; exported for lesson probes. */
export function parseRow(line: string): UiElement | null {
  return row(line.split("	"));
}
function row(cols: string[]): UiElement | null {
  const [, id, type, x, y, w, h, flags = "", name = "", aid = "", help = "", value = ""] = cols;
  const n = [id, x, y, w, h].map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  return {
    id: n[0], type, x: n[1], y: n[2], w: n[3], h: n[4],
    password: flags.includes("p"), enabled: flags.includes("e"), focused: flags.includes("f"),
    hasValue: flags.includes("v"), readOnly: flags.includes("r"),
    ...(flags.includes("1") ? { toggled: true } : flags.includes("0") ? { toggled: false } : {}),
    ...(flags.includes("X") ? { expanded: true } : flags.includes("C") ? { expanded: false } : {}),
    ...(flags.includes("S") ? { selected: true } : {}),
    ...(flags.includes("I") ? { invokable: true } : {}),
    name, aid, help,
    // A password field's value never leaves the helper; belt and braces here too.
    value: flags.includes("p") ? "" : value,
  };
}

export const BROWSER_PROCESS = /^(?:chrome|msedge|firefox|brave|opera|vivaldi|arc)$/i;

export function parseSnapshot(text: string, options: { browser?: boolean } = {}): Snapshot {
  let window = { x: 0, y: 0, w: 0, h: 0 };
  const elements: UiElement[] = [];
  let focused: UiElement | null = null;
  const boxes: UiElement[] = [];
  let truncated = false;
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t");
    if (cols[0] === "W" && cols.length >= 5) window = { x: +cols[1], y: +cols[2], w: +cols[3], h: +cols[4] };
    else if (cols[0] === "E") {
      const e = row(cols);
      if (e) elements.push(e);
    } else if (cols[0] === "T") truncated = true;
    else if (cols[0] === "B") {
      const b = row(cols);
      if (b) boxes.push(b);
    } else if (cols[0] === "F" || cols[0] === "A") focused = row(cols);
  }
  const browser = !!options.browser;
  if (browser) {
    // The page is the largest Document; everything inside it is web content.
    const doc = elements.filter((e) => e.type === "Document").sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (doc) for (const e of elements) e.web = e !== doc && inside(e, doc);
  }
  return { window, elements, focused, browser, ...(boxes.length ? { boxes } : {}), ...(truncated ? { truncated } : {}) };
}
const inside = (e: UiElement, box: UiElement) => e.x >= box.x - 2 && e.y >= box.y - 2 && e.x + e.w <= box.x + box.w + 2 && e.y + e.h <= box.y + box.h + 2;
export const centre = (e: Pick<UiElement, "x" | "y" | "w" | "h">) => ({ x: Math.round(e.x + e.w / 2), y: Math.round(e.y + e.h / 2) });
export const labelOf = (e: UiElement) => (e.name || e.help || e.aid || "").trim();

// --- words -----------------------------------------------------------------------------------------
const clean = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

/** Strip "hey Jarvis", "can you", "please", "for me" and end punctuation, keeping his casing. */
export function tidy(utterance: string) {
  return utterance
    .trim()
    .replace(/^(?:(?:ok(?:ay)?|right|alright|hey)[,\s]+)?(?:jarvis[,\s]+)?/i, "")
    .replace(/^(?:can you|could you|would you|will you|please|now|go ahead and|just)\s+/i, "")
    .replace(/^(?:please|now|just)\s+/i, "")
    .replace(/[\s,]+(?:please|for me|thanks|thank you|jarvis|sir)[.!?]*$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

// --- goals → steps -----------------------------------------------------------------------------
export type Step =
  | { do: "click"; target: string; state?: "on" | "off" }
  | { do: "type"; text: string; into?: string }
  | { do: "key"; keys: string; label: string }
  | { do: "scroll"; dir: "up" | "down"; amount: number }
  | { do: "say"; said: string }
  /** Save As / Open through the app's common file dialog (file-dialog.ts): the name or path as said. */
  | { do: "file"; kind: "save" | "open"; name: string };

const KEY_NAMES: Record<string, string> = {
  enter: "enter", return: "enter", tab: "tab", escape: "escape", esc: "escape", space: "space", spacebar: "space", backspace: "backspace",
  delete: "delete", up: "up", down: "down", left: "left", right: "right", home: "home", end: "end", "page up": "pageup", "page down": "pagedown", f2: "f2", f5: "f5",
};
const TIMES: Record<string, number> = { once: 1, twice: 2, two: 2, three: 3, four: 4, five: 5 };

/** What he means by "my business name": things Jarvis knows; anything else personal is asked for. */
const PROFILE: Array<[RegExp, string]> = [
  [/^(?:my|our|the) (?:business|company|agency)(?:'s)? name$|^(?:the )?name of (?:my|our) (?:business|company)$|^my business$/i, "M&U Ventures"],
  [/^my (?:first )?name$/i, "Usman"],
  [/^my (?:co-?founder|partner|business partner)(?:'s)? name$/i, "Mehroz"],
];
const ASK_FOR = /^(?:my|our|his|the) (?:e-?mail(?: address)?|phone(?: number)?|mobile(?: number)?|number|address|postcode|abn|website|date of birth|dob|surname|last name|full name)$/i;

/** Resolve "my business name" → "M&U Ventures"; a question back when it's personal data he must say. */
export function resolveText(text: string): { text: string } | { ask: string } {
  const t = text.trim().replace(/^["“'](.*)["”']$/, "$1").trim();
  for (const [re, value] of PROFILE) if (re.test(t)) return { text: value };
  if (ASK_FOR.test(t)) return { ask: `What should I put for ${t.replace(/^(?:my|our|his|the) /i, "your ")}? Say it and I'll type it.` };
  return { text: t };
}

const VERB = "(?:click|tap|press|hit|select|choose|pick|tick|untick|check|uncheck|type|enter|write|put|fill|scroll|go|open|focus|turn|switch|enable|disable)";

function clause(raw: string): Step[] | null {
  // A typing command keeps its text as said ("type see you..."); other commands lose end punctuation.
  const c = /^(?:type|write|enter|put|input|key in|pop|paste)\b/i.test(raw.trim()) ? raw.trim() : raw.trim().replace(/[.!?]+$/, "");
  const l = c.toLowerCase();
  if (!c) return null;
  if (/^(?:select|highlight) (?:all|everything)(?: (?:the )?text)?(?: in (?:here|there|it|this|that))?$/.test(l)) return [{ do: "key", keys: "ctrl+a", label: "select all" }];
  if (/^(?:undo|undo that)$/.test(l)) return [{ do: "key", keys: "ctrl+z", label: "undo" }];
  if (/^(?:redo|redo that)$/.test(l)) return [{ do: "key", keys: "ctrl+y", label: "redo" }];
  if (/^(?:go )?back(?: a page)?$/.test(l)) return [{ do: "key", keys: "alt+left", label: "back" }];
  if (/^(?:go )?forward(?: a page)?$/.test(l)) return [{ do: "key", keys: "alt+right", label: "forward" }];
  if (/^(?:reload|refresh)(?: (?:the|this) page| this| it)?$/.test(l)) return [{ do: "key", keys: "f5", label: "reload" }];
  if (/^close (?:this|the|that) tab$/.test(l)) return [{ do: "key", keys: "ctrl+w", label: "close tab" }];
  if (/^(?:go to|scroll to|jump to) the (top|bottom)(?: of the page)?$/.test(l)) return [{ do: "key", keys: /top/.test(l) ? "ctrl+home" : "ctrl+end", label: l }];
  let m = l.match(/^(?:press|hit|tap|push)(?: the)? (enter|return|tab|escape|esc|space|spacebar|backspace|delete|up|down|left|right|home|end|page up|page down|f2|f5)(?: key| button)?(?: (once|twice|two|three|four|five) times?| (once|twice))?$/);
  if (m) {
    const times = TIMES[m[2] ?? m[3] ?? "once"] ?? 1;
    const key = KEY_NAMES[m[1]];
    return Array.from({ length: times }, () => ({ do: "key" as const, keys: key, label: key }));
  }
  m = l.match(/^(?:press|hit) (ctrl|control|alt|shift)[ +-]+(?:(shift|alt)[ +-]+)?([a-z0-9]|enter|tab|delete|f\d{1,2})$/);
  if (m) {
    const keys = [m[1] === "control" ? "ctrl" : m[1], m[2], m[3]].filter(Boolean).join("+");
    return [{ do: "key", keys, label: keys }];
  }
  m = l.match(/^scroll(?: the page| it| this)?(?: (up|down))?(?: (a (?:little |tiny )?bit|a little|slightly|a touch|a lot|lots|loads|a page|one page|right down|all the way(?: (?:up|down))?))?(?: (up|down))?$/);
  if (m) {
    const dir = (m[1] ?? m[3] ?? "down") as "up" | "down";
    const how = m[2] ?? "";
    const amount = /bit|little|slightly|touch/.test(how) ? 3 : /lot|loads|all the way|right down/.test(how) ? 15 : 6;
    return [{ do: "scroll", dir, amount }];
  }
  if (/^page (up|down)$/.test(l)) return [{ do: "key", keys: l.replace(" ", ""), label: l }];
  // "fill in the name field with Test", "set the email box to x", "put Test in the name field"
  m = c.match(/^(?:fill(?: in| out)?|set|change) (?:the |this |that )?(.+?)(?: field| box| input)? (?:with|to|as) (.+)$/i);
  if (m && !/^(?:this|that|it|(?:the |this |that )?(?:form|page)|everything|(?:my |the )?details)$/i.test(m[1])) return typed(m[2], m[1]);
  // "type hello world in there", "type Test into the name field", "enter my business name here"
  m = c.match(/^(?:type|write|enter|put|input|key in|pop)(?: in| out)? (.+?)(?: (?:in|into|on) (?:there|here|it|this|that)(?: (?:field|box|bit|space))?| (?:in|into) (?:the |this |that )?(.+?)(?: field| box| input| bar| area)| here| there)?$/i);
  if (m) return typed(m[1], m[2]);
  // "turn on night light", "switch off Bluetooth", "enable dark mode": a switch set to a state
  // (left alone when it's already there).
  m = c.match(/^(?:turn|switch|toggle) (on|off) (?:the )?(.+?)(?: (?:switch|toggle|setting|option))?$|^(?:turn|switch) (?:the )?(.+?) (on|off)$|^(enable|disable) (?:the )?(.+?)(?: (?:switch|toggle|setting|option))?$/i);
  if (m) {
    const state = ((m[1] ?? m[4] ?? (m[5] ? (m[5].toLowerCase() === "enable" ? "on" : "off") : "on")) as string).toLowerCase() as "on" | "off";
    const target = (m[2] ?? m[3] ?? m[6] ?? "").trim();
    if (target && !/^(?:it|this|that)$/i.test(target)) return [{ do: "click", target, state }];
  }
  // "save it as report.txt", "save this to D:\tmp\notes\a.txt", "save as Quarterly notes"
  m = c.match(/^save(?: (?:it|this|that|the (?:file|note|document|doc|text)))? (?:as|to|into|under) (?:a file (?:called|named) )?["“']?(.+?)["”']?$/i);
  if (m && m[1].trim()) return fileStep("save", m[1]);
  // "open the file D:\tmp\a.txt", "open file notes.txt", "open D:\tmp\a.txt" (a bare "open X" stays a click)
  m = c.match(/^open (?:the )?file (?:called |named )?["“']?(.+?)["”']?$/i) ?? c.match(/^open ["“']?((?:[a-z]:[\\/]|\\\\).+?)["”']?$/i);
  if (m && m[1].trim()) return fileStep("open", m[1]);
  // "click the Name field", "tick the terms box", "press the blue button", "open the second link"
  m = c.match(/^(?:click|tap|press|hit|select|choose|pick|tick|untick|check|uncheck|open|focus|go to)(?: on| into| in)? (.+)$/i);
  if (m) {
    const target = m[1].trim();
    if (/^(?:it|this|that|here|there|in there|in here)$/i.test(target)) return null;
    return [{ do: "click", target }];
  }
  return null;
}

/** A file name or path for a file dialog: one line, no wildcards (an Open dialog treats them as a filter). */
export const FILE_NAME_OK = /^[^*?"<>|\r\n]{1,260}$/;
function fileStep(kind: "save" | "open", raw: string): Step[] | null {
  const name = raw.trim();
  return FILE_NAME_OK.test(name) ? [{ do: "file", kind, name }] : null;
}

function typed(rawText: string, into?: string): Step[] {
  const resolved = resolveText(rawText);
  if ("ask" in resolved) return [{ do: "say", said: resolved.ask }];
  const steps: Step[] = [];
  if (into && !/^(?:it|this|that|there|here)$/i.test(into.trim())) steps.push({ do: "click", target: into.trim() });
  steps.push({ do: "type", text: resolved.text, ...(into ? { into: into.trim() } : {}) });
  return steps;
}

/** Only the leading "hey Jarvis, can you…" of a command: what follows is his payload, word for word. */
export function tidyHead(utterance: string) {
  return utterance
    .trim()
    .replace(/^(?:(?:ok(?:ay)?|right|alright|hey)[,\s]+)?(?:jarvis[,\s]+)?/i, "")
    .replace(/^(?:can you|could you|would you|will you|please|now|go ahead and|just)\s+/i, "")
    .replace(/^(?:please|now|just)\s+/i, "")
    .trim();
}
/** Commands whose tail is text to type: trailing "Jarvis", "please" or "thanks" there is his text. */
const TYPES_TEXT = /^(?:type|write|enter|put|input|key in|pop|paste|fill(?: in| out)?|set|change)\b/i;

/** A plain command → steps, or null for an open goal (the model loop takes those). Pure. */
export function parseGoal(goal: string): Step[] | null {
  const head = tidyHead(goal);
  // "type hello from Jarvis": the payload keeps its last word (only a stray full stop goes).
  const g = TYPES_TEXT.test(head) ? head.replace(/(?<![.])[.]$/, "") : tidy(goal);
  if (!g || g.length > 300) return null;
  // "click System, then Display, then turn on Night light": "then" (with or without a comma) always
  // splits; a bare comma or "and" splits only before a verb.
  const parts = g.split(new RegExp(`\\s*,?\\s+(?:and then|then|after that)\\s+|\\s*,\\s*(?=${VERB}\\b)|\\s+and\\s+(?=${VERB}\\b)`, "i"));
  const steps: Step[] = [];
  for (const part of parts) {
    let s = clause(part);
    // "…, then Display": a bare name after a click is another click.
    if (!s && steps[steps.length - 1]?.do === "click" && /^[\w'&-]+(?: [\w'&-]+){0,4}$/.test(part.trim()) && !new RegExp(`^${VERB}\\b`, "i").test(part.trim()))
      s = [{ do: "click", target: part.trim() }];
    if (!s) return null;
    steps.push(...s);
  }
  return steps.length && steps.length <= 8 ? steps : null;
}

// --- picking an element ------------------------------------------------------------------------
const KIND_TYPES: Record<string, string[]> = {
  field: ["Edit", "ComboBox", "Document", "Spinner"],
  button: ["Button", "SplitButton", "MenuItem", "Hyperlink"],
  link: ["Hyperlink"],
  checkbox: ["CheckBox"],
  radio: ["RadioButton"],
  tab: ["TabItem"],
  item: ["ListItem", "TreeItem", "DataItem", "MenuItem"],
  dropdown: ["ComboBox"],
};
const KIND_WORDS: Array<[RegExp, string]> = [
  [/\b(?:fields?|box(?:es)?|inputs?|text ?box|text field|search bar|bar)\b/, "field"],
  [/\bbuttons?\b/, "button"],
  [/\blinks?\b/, "link"],
  [/\b(?:check ?box(?:es)?|tick ?box(?:es)?)\b/, "checkbox"],
  [/\b(?:radio(?: buttons?)?|options?)\b/, "radio"],
  [/\btabs?\b/, "tab"],
  [/\b(?:drop ?downs?|menus?|select)\b/, "dropdown"],
];
const ORDINAL: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1 };
/** Words vision can see but UIA can't (colour, position, pictures). */
export const VISUAL = /\b(?:blue|red|green|yellow|orange|purple|pink|black|white|grey|gray|dark|light|big|large|small|little|tiny|top|bottom|left|right|corner|middle|centre|center|icon|image|picture|photo|logo|arrow|round|square)\b/;

export type TargetWords = { words: string; kind?: string; ordinal?: number; visual: boolean };
export function targetWords(target: string): TargetWords {
  let t = clean(target);
  let kind: string | undefined;
  for (const [re, k] of KIND_WORDS)
    if (re.test(t)) {
      kind ??= k;
      t = t.replace(re, " ");
    }
  let ordinal: number | undefined;
  for (const [word, n] of Object.entries(ORDINAL))
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      ordinal ??= n;
      t = t.replace(new RegExp(`\\b${word}\\b`), " ");
    }
  const visual = VISUAL.test(t);
  const words = t
    .replace(VISUAL, " ")
    .replace(/\b(?:the|a|an|on|in|that|this|those|these|my|there|here|one|called|named|labelled|labeled|says|saying|with|thing|bit|of|screen|page|button|field)\b/g, " ")
    .replace(/\b(?:blue|red|green|yellow|orange|purple|pink|black|white|grey|gray|dark|light|big|large|small|little|tiny|top|bottom|left|right|corner|middle|centre|center|icon|image|picture|photo|logo|arrow|round|square)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { words, kind, ordinal, visual };
}

const BROWSER_UI = /\b(?:address|url|tab|tabs|bookmark|back|forward|reload|refresh|extension|profile|menu|toolbar|downloads?)\b/;

function scoreLabel(label: string, words: string) {
  const l = clean(label);
  if (!l || !words) return 0;
  if (l === words) return 1;
  const lw = l.split(" "), tw = words.split(" ");
  if (tw.every((w) => lw.includes(w))) return Math.max(0.72, 0.9 - 0.04 * (lw.length - tw.length));
  if (l.startsWith(words) || words.startsWith(l)) return 0.7;
  const hits = tw.filter((w) => lw.some((x) => x === w || (w.length >= 4 && x.startsWith(w)))).length;
  const dice = (2 * hits) / (lw.length + tw.length);
  const fuzzy = similarity(l, words);
  return Math.max(hits ? 0.35 + 0.45 * dice : 0, fuzzy >= 0.8 ? 0.75 * fuzzy : 0);
}

export type ElementPick = { element: UiElement | null; score: number; ambiguous: UiElement[]; needsVision: boolean };
export const PICK_MIN = 0.6;

/** The element he means, from UIA alone. `needsVision` when only the pixels can tell. Pure. */
export function pickElement(snapshot: Snapshot, target: string): ElementPick {
  const want = targetWords(target);
  const types = want.kind ? KIND_TYPES[want.kind] : null;
  const usable = snapshot.elements.filter((e) => e.enabled && e.w >= 4 && e.h >= 4 && !(snapshot.browser && e.type === "Document" && !e.web));
  const scored = usable
    .map((e) => {
      let s = want.words ? Math.max(scoreLabel(e.name, want.words), 0.95 * scoreLabel(e.help, want.words), 0.9 * scoreLabel(e.aid.replace(/[_-]+/g, " "), want.words)) : 0;
      if (types) s = types.includes(e.type) ? s + (want.words ? 0.08 : 0.5) : s * 0.6;
      if (snapshot.browser && !e.web && !BROWSER_UI.test(want.words)) s -= 0.15;
      if (snapshot.browser && e.web) s += 0.02;
      return { e, s: Math.min(1.2, s) };
    })
    .filter((x) => x.s > 0);
  if (want.ordinal !== undefined) {
    // "the second button": reading order among the kind (and the words, if any).
    // "The last button" means a real button when there are any, not a link styled as one.
    const strict = want.kind === "button" && scored.some((x) => ["Button", "SplitButton"].includes(x.e.type)) ? ["Button", "SplitButton"] : null;
    const pool = scored
      .filter((x) => x.s >= (want.words ? PICK_MIN : 0.5) && (!snapshot.browser || x.e.web !== false || !want.kind) && (!strict || strict.includes(x.e.type)))
      .map((x) => x.e)
      .sort((a, b) => (Math.abs(a.y - b.y) < 12 ? a.x - b.x : a.y - b.y));
    const element = want.ordinal === -1 ? pool[pool.length - 1] : pool[want.ordinal - 1];
    return { element: element ?? null, score: element ? 1 : 0, ambiguous: [], needsVision: !element && want.visual };
  }
  scored.sort((a, b) => b.s - a.s || a.e.y - b.e.y || a.e.x - b.e.x);
  const best = scored[0];
  if (!best || best.s < PICK_MIN || (!want.words && want.visual)) {
    // Nothing named that, or only a colour/position ("the blue button"): pixels decide.
    return { element: null, score: best?.s ?? 0, ambiguous: [], needsVision: want.visual || !best || best.s < PICK_MIN };
  }
  // Rivals: close scores on a DIFFERENT label (two "Next" buttons are the same thing twice).
  const rivals = scored.filter((x) => x !== best && best.s - x.s < 0.05 && clean(labelOf(x.e)) !== clean(labelOf(best.e))).map((x) => x.e);
  return { element: best.e, score: best.s, ambiguous: rivals.length ? [best.e, ...rivals].slice(0, 8) : [], needsVision: false };
}

// --- safety ------------------------------------------------------------------------------------
/**
 * Final, consequential buttons: pressing one needs his spoken yes (the control_pc rule). Built from
 * the one shared keyword list (src/lib/action-keywords.ts) that control_pc's task gate also uses.
 */
export { FINAL_BUTTON };
/** Fields whose contents Jarvis never types or reads. */
export const SENSITIVE_FIELD =
  /pass(?:word|code|phrase)|\bpin\b|card ?(?:number|no)|credit ?card|debit ?card|\bcvv\b|\bcvc\b|\bcsc\b|security (?:code|question)|expir(?:y|ation)|\bbsb\b|account (?:number|no)|acct|routing|\biban\b|\bswift\b|sort code|tax file|\btfn\b|\bssn\b|social security|passport|licen[cs]e (?:number|no)|driver'?s? licen|medicare|\b2fa\b|two[- ]factor|one[- ]time|\botp\b|verification code|auth(?:entication)? code|api ?key|secret|token|private key|seed phrase|recovery (?:phrase|code)/i;
/** Text on screen written AT an assistant: data, never instructions. */
export const INJECTION =
  /\b(?:ignore (?:all |any |the )?(?:previous|prior|above|earlier|your)|disregard (?:the|all|your|previous)|new instructions|system prompt|you are (?:now )?(?:jarvis|an? (?:ai|assistant))|(?:jarvis|assistant|ai|agent)\s*[:,-]\s*(?:please |now )?(?:click|press|type|send|delete|ignore|open)|instructions? (?:for|to) (?:the )?(?:ai|assistant|agent|jarvis))\b/i;

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}
/** Card numbers, 2FA codes, bank and tax numbers, keys and passwords he might ask to type. */
export function sensitiveText(text: string): string | null {
  const t = text.trim();
  if (looksSecret(t)) return "key";
  if (/\bpass(?:word|code)\b|\bmy pin\b|\bcvv\b|\bcard number\b|\b2fa\b|\botp\b|\bverification code\b/i.test(t)) return "secret";
  const digits = t.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return "card";
  if (/^\d{6,9}$/.test(digits)) return "code";
  if (/^\d{3}-?\d{3}\s+\d{5,10}$/.test(t)) return "bank";
  if (/^[A-Z]{1,2}\d{6,8}$/i.test(t)) return "id";
  return null;
}

export type Action =
  | { do: "click"; element: UiElement }
  | { do: "type"; text: string; field: UiElement | null }
  | { do: "key"; keys: string; label: string }
  | { do: "scroll"; dir: "up" | "down"; amount: number };
/** `refused`: a hard refusal no yes can lift (money buttons); `confirm`: a question his spoken yes answers. */
/** `money`: the refusal is a money press (away.payment may ask the owner's code for exactly this press). */
export type Verdict = { ok: true } | { ok: false; confirm?: string; said: string; refused?: true; money?: true };
/** The owner's rule, said when a money button is refused (never "ask"). */
export const MONEY_BUTTON_SAID = "That button pays, buys, bets, trades, tops up or moves money. I never press those, whatever the approval: it's yours to do yourself. Nothing was pressed.";
/** A dialog that is about money (an amount, a checkout, a bank): its Yes/OK is a money press. Pure. */
export const moneyDialog = (text: string | null | undefined) => !!text && (!!moneySurfaceRefusal({ title: text }) || MONEY_AMOUNT.test(text));

/**
 * One spelling per key, so the gate below can't be sidestepped by an alias ("return", "del",
 * "control+return" are "enter", "delete", "ctrl+enter"). Pure.
 */
export function canonicalKeys(keys: string) {
  const alias: Record<string, string> = { return: "enter", del: "delete", esc: "escape", control: "ctrl", spacebar: "space", "pg up": "pageup", "pg down": "pagedown" };
  return keys
    .toLowerCase()
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => alias[k] ?? k)
    .join("+");
}

// --- deny-list (flag `denylist`; the macos-computer-use-kit idea, for Windows) ------------------
/** Password managers, by window title or process: never acted on at all. */
export const PASSWORD_MANAGER =
  /\b(?:1password|bitwarden|lastpass|keepass(?:xc)?|dashlane|keeper(?: password manager| security)?|nordpass|roboform|enpass|proton ?pass|keychain|password manager|credential manager|passwords? - microsoft edge|google password manager)\b/i;
const PASSWORD_MANAGER_PROCESS = /^(?:1password|bitwarden|lastpass|keepass|keepassxc|dashlane|keeperpasswordmanager|keeper|nordpass|roboform|enpass|protonpass|proton pass)$/i;
/** Windows' own credential, UAC, lock and sign-in surfaces. */
const WINDOWS_PROMPT_PROCESS =
  /^(?:consent|credentialuibroker|logonui|lockapp|useraccountbroker|microsoft\.aad\.brokerplugin|cloudexperiencehost|securityhealthhost|windowssecurity|credentialenrollmentmanager|secureassessmentbrowser|sihost)$/i;
const WINDOWS_PROMPT_TITLE =
  /\b(?:user account control|windows security|credential manager|enter (?:network )?(?:credentials|password)|windows hello|sign in to (?:windows|your microsoft account|microsoft|onedrive|outlook|teams)|microsoft account|lock screen|choose an account|pick an account|verify (?:it's|that it's) you)\b/i;
/** Sign-in and verification pages: clicking is allowed (he may want "Next"), typing isn't. */
const SIGN_IN_TITLE = /\b(?:sign[ -]?in|log[ -]?in|signin|authenticat(?:e|ion)|two[- ]step|2-step|2fa|verification code|one[- ]time (?:code|password)|reset (?:your )?password)\b/i;
/** Secure fields beyond the UIA password flag: by label or AutomationId. */
const SECURE_ID = /\b(?:pwd|passwd|password|passcode|pin|otp|mfa|totp|cvv|cvc|csc)\b|(?:^|_)(?:pwd|passwd|pin|otp|cvv)(?:_|$)/i;

type WindowLike = { process?: string; title?: string; cls?: string };
/** A window Jarvis never touches (flag `denylist`): the reason, or null. Pure. */
export function deniedWindow(win: WindowLike | null | undefined): string | null {
  if (!win) return null;
  const process = (win.process ?? "").replace(/\.exe$/i, "");
  const title = win.title ?? "";
  if (PASSWORD_MANAGER_PROCESS.test(process) || PASSWORD_MANAGER.test(title)) return "That's a password manager. I don't touch those; you'll have to.";
  if (WINDOWS_PROMPT_PROCESS.test(process) || WINDOWS_PROMPT_TITLE.test(title) || /^Credential Dialog Xaml Host$/i.test(win.cls ?? ""))
    return "That's a Windows sign-in or security prompt. That one's yours to answer.";
  return null;
}
/** A window Jarvis may click in but never types into (sign-in and code pages). Pure. */
export const deniedTyping = (win: WindowLike | null | undefined) => (win && SIGN_IN_TITLE.test(win.title ?? "") ? "That's a sign-in page. You'll have to type into that one yourself." : null);
/** A secure field: the UIA password flag, a sensitive label, or a password/PIN/OTP AutomationId. Pure. */
export const secureField = (e: UiElement | null | undefined) =>
  !!e && (e.password || SENSITIVE_FIELD.test(`${e.name} ${e.help}`) || SECURE_ID.test(e.aid.replace(/([a-z])([A-Z])/g, "$1_$2")));

/** Lock, sign-out, shut-down, Run and power-menu chords, as sets of keys. */
const FORBIDDEN_CHORDS: string[][] = [
  ["win", "l"], // lock
  ["win", "x"], // power-user menu (shut down, sign out)
  ["win", "r"], // Run: a command line by another name
  ["ctrl", "alt", "delete"], // the secure attention screen (lock, sign out, switch user)
  ["ctrl", "alt", "end"], // the same over Remote Desktop
  ["alt", "f4"], // closes his app, or on the desktop the shut-down dialog
  ["ctrl", "shift", "escape"], // Task Manager: end task, sign out
];
/** Is this chord one Jarvis never presses (whatever the spelling or order)? Pure. */
export function forbiddenChord(keys: string): boolean {
  const set = new Set(canonicalKeys(keys.replace(/\s+/g, "")).split("+").map((k) => (k === "windows" || k === "meta" || k === "super" ? "win" : k)));
  return FORBIDDEN_CHORDS.some((chord) => chord.length === set.size && chord.every((k) => set.has(k)));
}
/** Keys that only move away from a secure field. */
const LEAVE_KEYS = new Set(["tab", "shift+tab", "escape"]);

/** Apps where Enter in a box moves to the next cell or line: Office, Notepad, code editors. */
const EDITOR_APP = /^(?:excel|winword|powerpnt|onenote|notepad|notepad\+\+|code|devenv|wordpad|soffice(?:\.bin)?|scalc|swriter)$/i;
/** Enter in these just searches or goes: no confirmation. */
const FINAL_KEY_FIELDS = /search|find|filter|address and search|url|query/i;
/** Enter in these SENDS (WhatsApp, Teams, Slack, comment and reply boxes), whatever the control type. */
const SENDING_FIELDS = /\b(?:message|chat|comment|reply|compose|write a|type a|post|tweet|caption)\b/i;
/** Chat and mail apps, and chat/mail pages in a browser: Enter in their unlabelled composer sends too. */
const CHAT_PROCESS = /^(?:whatsapp|whatsapp\.root|telegram|signal|discord|slack|ms-teams|teams|olk|outlook|thunderbird|messenger|skype|zoom|lync)$/i;
const CHAT_TITLE = /\b(?:whatsapp|messenger|slack|teams|discord|telegram|signal|gmail|outlook|inbox|compose|chat|messages|linkedin|instagram|x\.com|twitter|reddit)\b/i;
/**
 * A follow-up dialog's affirmative button ("Are you sure?" → Yes / OK / Continue): pressing it
 * completes whatever raised it, so after a gated press, or on a dialog that talks about something
 * final, it needs his fresh yes like the final button itself (review finding 2, 27 Sep night).
 */
export const AFFIRM_BUTTON = /^(?:ok|okay|yes|yes,? .{1,30}|y|continue|proceed|confirm|allow|sure|do it|go ahead|i understand|i'm sure|got it|retry|try again|delete anyway|send anyway|continue anyway)$/i;
const RISKY_DIALOG = /\b(?:permanently|can'?t be undone|cannot be undone|irreversible|are you sure|lose (?:your|all|any|unsaved)|unsaved (?:changes|work)|will be (?:deleted|removed|lost|sent|charged|published)|replace (?:it|the file|existing)|already exists)\b/i;
/** Is this text (a window's title and static texts) about something final? Pure. */
export const riskyDialog = (text: string | null | undefined) => !!text && (RISKY_DIALOG.test(text) || FINAL_BUTTON.test(text));
/** A window's title and its static texts, for riskyDialog (bounded). Pure. */
export function dialogTextOf(snap: Pick<Snapshot, "elements"> | null | undefined, title = "") {
  // (An Image's name is its alt text: a total drawn as a picture still reads, R6 §3.)
  const texts = (snap?.elements ?? []).filter((e) => e.type === "Text" || e.type === "Pane" || e.type === "Window" || e.type === "Image").map((e) => e.name).filter(Boolean);
  return [title, ...texts].join(" \n ").slice(0, 3000);
}
/**
 * Does the page embed content its text can't show (R6 §3)? An iframe (a second Document, or one named as a
 * frame), a canvas or custom-drawn control, or an image with no alt text. Pure.
 */
export function embedsOf(snap: Pick<Snapshot, "elements"> | null | undefined) {
  const els = snap?.elements ?? [];
  const docs = els.filter((e) => e.type === "Document");
  return docs.length >= 2 || docs.some((d) => !d.name.trim() || /\b(?:i?frame|secure|payment|card|checkout|stripe|paypal|adyen|braintree|square)\b/i.test(d.name)) || els.some((e) => e.type === "Custom" || (e.type === "Image" && !e.name.trim()) || /\bcanvas\b/i.test(`${e.name} ${e.aid}`));
}
/** A frame that takes payment ("Secure payment frame", "Stripe card frame", "PayPal checkout"): the page is a checkout. */
const PAYMENT_FRAME = /\b(?:payment|card|checkout|stripe|paypal|adyen|braintree|square|klarna|afterpay)\b/i;
/**
 * The short texts right beside a control (R7 §2): texts, images, radios and list items whose box is within
 * 300 px vertically and 900 px horizontally of the control's, one per line. A price tag in the same box as
 * "Send" or "Next" (a tip, gift, donation or membership dialog) reads here whatever the site or language. Pure.
 */
export function nearbyTextOf(target: UiElement | null | undefined, elements: readonly UiElement[] | null | undefined, boxes?: readonly UiElement[] | null) {
  return nearbyOf(target, elements, boxes)
    .map((e) => e.name)
    .join("\n")
    .slice(0, 2000);
}
/**
 * What sits beside a control (R8, R8 review fix 1): the UNION of everything within the old radius (300 px
 * vertically, 900 px horizontally) and everything in the control's dialog (the largest Window box holding it; else
 * its smallest box). Never narrower than the radius: a Send in a small button group still sees the "A$3.00"
 * 150 px away, and a tip box whose amount is 600 px away in the same dialog is seen too. Pure.
 */
export function nearbyOf(target: UiElement | null | undefined, elements: readonly UiElement[] | null | undefined, boxes?: readonly UiElement[] | null): UiElement[] {
  if (!target || !elements?.length) return [];
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const box = dialogOf(target, boxes) ?? containerOf(target, boxes);
  const inBox = (e: UiElement) => !!box && e.x + e.w / 2 >= box.x && e.x + e.w / 2 <= box.x + box.w && e.y + e.h / 2 >= box.y && e.y + e.h / 2 <= box.y + box.h;
  const near = (e: UiElement) => Math.abs(e.y + e.h / 2 - cy) <= 300 && Math.abs(e.x + e.w / 2 - cx) <= 900;
  return elements.filter((e) => e !== target && e.name && NEARBY_TYPES.has(e.type) && (near(e) || inBox(e)));
}
/** The largest dialog (a Window box) that holds the control, or null. Pure. */
export function dialogOf(target: Pick<UiElement, "x" | "y" | "w" | "h">, boxes: readonly UiElement[] | null | undefined) {
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const holding = (boxes ?? []).filter((b) => b.type === "Window" && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h);
  return holding.sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null;
}
const NEARBY_TYPES = new Set(["Text", "Image", "RadioButton", "ListItem", "Custom", "Group", "DataItem", "Button", "TabItem", "Hyperlink"]);
/** The smallest box (dialog, card, group) whose rectangle holds the control's centre, or null. Pure. */
export function containerOf(target: Pick<UiElement, "x" | "y" | "w" | "h">, boxes: readonly UiElement[] | null | undefined) {
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const holding = (boxes ?? []).filter((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h && b.w * b.h > target.w * target.h * 1.5);
  return holding.sort((a, b) => a.w * a.h - b.w * b.h)[0] ?? null;
}
/** Is this line just an amount ("A$14.99", "$5", "2,00 €", "₹499"), with at most a couple of letters besides? */
export function amountOnly(line: string) {
  const l = String(line ?? "").normalize("NFKC").trim();
  if (!l || l.length > 24 || !/\d/.test(l)) return false;
  const rest = l.replace(/(?:[a-z]{1,3}\$|[$€£¥₹₩₽₱₺₫₪฿]|\b(?:aud|usd|eur|gbp|nzd|cad|inr|pkr|rp|rm|kr|zł|zl|ksh|tl|chf|sek|nok|dkk|jpy|cny)\b)/gi, "").replace(/[\d\s.,'/-]+/g, "").replace(/\b(?:mo|month|yr|year|each|only|from)\b/gi, "");
  return rest.length <= 2 && /(?:[a-z]{1,3}\$|[$€£¥₹₩₽₱₺₫₪฿]|\b(?:aud|usd|eur|gbp|nzd|cad|inr|pkr|rp|rm|kr|zł|zl|ksh|tl|chf|sek|nok|dkk|jpy|cny)\b)/i.test(l);
}
/**
 * An amount picker (R8 §3): choosable controls (radios, list items, tiles, tabs, buttons, images) named only by an
 * amount ("$5", "A$10", "2,00 €"), or unnamed image tiles under an "amount" prompt. Pure.
 */
export function amountPickerOf(elements: readonly UiElement[] | null | undefined) {
  // (Not CheckBox: a shop's "$0 - $50" price filter isn't an amount to pay, R8 review OK7. Callers pass only
  // what sits beside the pressed control.)
  return (elements ?? []).some((e) => PICKER_TYPES.has(e.type) && amountOnly(e.name));
}
const PICKER_TYPES = new Set(["RadioButton", "ListItem", "TabItem", "Button", "Image", "Custom", "DataItem"]);
/** Choosable controls: an amount on one of these in mail or chat is an offer to pay, not words in a message. */
const CHOOSABLE_TYPES = new Set(["RadioButton", "ListItem", "TabItem", "Button"]);
/** The page's controls and fields ("name id" per line) for the money context: a Pay button or a card field makes it a checkout. */
export function controlsTextOf(snap: Pick<Snapshot, "elements"> | null | undefined) {
  return (snap?.elements ?? [])
    .filter((e) => ["Button", "Hyperlink", "Edit", "ComboBox", "MenuItem", "SplitButton"].includes(e.type) && (e.name || e.aid))
    .map((e) => `${e.name} ${String(e.aid ?? "").replace(/[_-]+/g, " ")}`.trim())
    .concat((snap?.elements ?? []).some((e) => e.type === "Document" && PAYMENT_FRAME.test(e.name)) ? ["payment iframe"] : [])
    .join("\n")
    .slice(0, 4000);
}

/**
 * The rules every action passes before it runs. `confirmed` is the exact button label he said yes
 * to (set only by the client's spoken-yes gate), so a yes covers that one button and nothing else.
 */
export type VetContext = {
  focused: UiElement | null;
  confirmed?: string | null;
  browser?: boolean;
  /** Flag `denylist`: password managers, Windows prompts, secure fields and lock chords are refused. */
  deny?: boolean;
  /** The window acted on, for the deny-list. */
  window?: WindowLike | null;
  /** A gated (final) press already happened in this run or just before it: a dialog's Yes/OK is final too. */
  followUp?: boolean;
  /** The window's title and static texts (dialogTextOf): "Are you sure you want to permanently delete…?" */
  dialogText?: string | null;
  /** The browser's address (addressBarUrl), when known: a money host or checkout path is money context. */
  url?: string | null;
  /**
   * Nobody is at the PC (away mode, REVIEW-SAFETY-R3 finding 2): deny by default. Only a short list of
   * navigational presses (Next page, Back, Close, Search, Open, Play, Pause, Show more, Expand, tabs,
   * menus) and navigation keys run, never on a page showing money; everything else is REFUSED, not asked.
   */
  unattended?: boolean;
  /** The page's other controls and fields ("name aid" per line): a Pay button or card field there makes it a checkout. */
  controls?: string | null;
  /** The page embeds an iframe, a canvas or an unnamed image (embedsOf). */
  embeds?: boolean;
  /** The snapshot's elements: what sits right beside the pressed control (nearbyTextOf, R7 §2). */
  elements?: readonly UiElement[] | null;
  /** The snapshot's containers (Snapshot.boxes): the pressed control's own box or dialog (R8 §2). */
  boxes?: readonly UiElement[] | null;
  /** The snapshot's context read was cut short (Snapshot.truncated). */
  truncated?: boolean;
};

/**
 * Continue-type presses that complete a flow (Next, Continue, Proceed, Review order, Done, Go…). On a money
 * page they are money presses: refused outright, even after his yes (REVIEW-SAFETY-R3 finding 3).
 */
export const CONTINUE_BUTTON =
  /^(?:next(?:\s+(?:step|page))?|continue(?:\s+.{0,30})?|proceed(?:\s+.{0,30})?|review(?:\s+(?:order|and\s+pay|&\s+pay|purchase))?|go|submit|done|finish|complete|confirm|place|save\s+and\s+continue|agree(?:\s+and\s+continue)?|i\s+agree|accept|ok|okay|yes|send|sign|authori[sz]e|verify|approve|allow|get\s+started|start|join|book(?:\s+now)?|reserve|apply|activate|redeem|claim|weiter|doorgaan|fortsatt|fortsätt|tovabb|tovább|continuar|continuer|avanti|dalej|dalsi|jatka|lanjut(?:kan)?|tiep\s+tuc|devam|далее|продолжить|继续|繼續|次へ|다음|계속|do\s+it|let'?s\s+go|yes,?\s+please|i'?m\s+in|count\s+me\s+in|tap\s+to\s+confirm)(?:\s*[>›→»]+)?$/i;
/**
 * Commit-type presses beyond CONTINUE_BUTTON (R7 §1): choosing or selecting a tier or amount, sending, and their
 * equivalents in the supported languages. With CONTINUE_BUTTON, AFFIRM_BUTTON and unnamed or icon-only buttons,
 * these are the presses that take an offer when an amount is on the page.
 */
export const COMMIT_BUTTON =
  /^(?:choose(?:\s+.{0,30})?|select(?:\s+.{0,30})?|pick(?:\s+.{0,30})?|send(?:\s+.{0,30})?|submit(?:\s+.{0,30})?|proceed(?:\s+.{0,30})?|confirm(?:\s+.{0,30})?|next(?:\s+.{0,20})?|continue(?:\s+.{0,30})?|subscribe|upgrade(?:\s+.{0,20})?|support(?:\s+.{0,20})?|gift(?:\s+.{0,20})?|tip(?:\s+.{0,20})?|donate(?:\s+.{0,20})?|give(?:\s+.{0,20})?|join(?:\s+.{0,20})?|become\s+a\s+.{1,20}|envoyer|envoi|valider|confirmer|choisir|s[ée]lectionner|suivant|continuer|payer|faire\s+un\s+don|enviar|confirmar|elegir|seleccionar|siguiente|continuar|donar|pr[óo]ximo|escolher|selecionar|inviare|invia|conferma|scegli|seleziona|avanti|continua|senden|absenden|best[äa]tigen|w[äa]hlen|ausw[äa]hlen|weiter|fortfahren|spenden|verzenden|verstuur|bevestigen|kiezen|selecteren|volgende|doorgaan|skicka|bekr[äa]fta|v[äa]lj|n[äa]sta|forts[äa]tt|send|bekreft|velg|neste|wy[śs]lij|potwierd[źz]|wybierz|dalej|g[öo]nder|onayla|se[çc]|ileri|devam|отправить|подтвердить|выбрать|далее|продолжить|送信|確認|選択|次へ|続ける|发送|確定|确认|选择|下一步|继续|전송|확인|선택|다음|계속|kirim|konfirmasi|pilih|lanjut(?:kan)?|ipadala|kumpirmahin|piliin|susunod|tuma|thibitisha|chagua|endelea)$/iu;
/** Presses that only begin a sign-up (a pricing page's "Get started"): at most asked, never refused by an offer's price alone (R7 §4). */
export const ENTRY_BUTTON = /^(?:get\s+started|get\s+it|get|start(?:\s+now)?|try(?:\s+it)?(?:\s+(?:free|now|for\s+free))?|start\s+(?:a\s+|your\s+)?(?:free\s+)?trial|sign\s+up(?:\s+.{0,20})?|book\s+a\s+demo|talk\s+to\s+sales|contact\s+sales)$/i;
/** Reading, playing and file-picking presses that only look like commits ("Next video", "Continue reading", "Choose file"). */
const NOT_COMMIT = /^(?:(?:continue|next|keep|play)\s+(?:reading|watching|listening|video|song|track|episode|chapter|article|story|post|lesson|page|slide|image|photo|item|result)s?|send\s+(?:feedback|a\s+message|message|link|invite)|give\s+feedback|select\s+(?:all|none|text|files?|folders?|photos?|images?)|choose\s+(?:files?|folders?|photos?|images?|a\s+file)|pick\s+(?:files?|a\s+file|colou?r))$/i;
/** Is this press a commit (takes an offer where an amount shows)? Unnamed and icon-only buttons count. Pure. */
export function commitPress(label: string) {
  const l = clean(label);
  if (ENTRY_BUTTON.test(l) || NOT_COMMIT.test(l)) return false;
  return !l || CONTINUE_BUTTON.test(l) || AFFIRM_BUTTON.test(l) || COMMIT_BUTTON.test(l);
}
/** Presses allowed with nobody at the PC: navigation only (and never on a money page). */
export const SAFE_UNATTENDED =
  /^(?:next\s+page|previous\s+page|prev(?:ious)?|back|go\s+back|close|close\s+tab|search|open|play|pause|resume|show\s+more|see\s+more|load\s+more|read\s+more|more|expand|collapse|show\s+less|view|file|edit|format|insert|tools|help|home|new|new\s+tab|new\s+file|new\s+window|refresh|reload|zoom\s+in|zoom\s+out|minimi[sz]e|maximi[sz]e|restore(?:\s+down)?|cancel|no|not\s+now|dismiss|menu|settings?|options|more\s+options|save\s+as)$/i;
/** Presses that only look or choose, allowed on a money page when he's there (never a commit). */
export const SAFE_ATTENDED =
  /^(?:like|dislike|(?:show\s+)?transcript|captions|subtitles|full\s?screen|exit\s+full\s?screen|theat(?:re|er)\s+mode|mini\s?player|mute|unmute|skip(?:\s+ads?)?|more\s+actions|copy(?:\s+link)?|filter(?:s)?|sort(?:\s+by)?|view\s+all|see\s+all|show\s+all|learn\s+more|details|info|information|faq|terms|privacy(?:\s+policy)?|go\s+home|scroll\s+to\s+top)$/i;
const SELECT_TYPES = new Set(["CheckBox", "RadioButton", "TabItem", "ListItem", "TreeItem", "DataItem", "HeaderItem", "Text"]);
/** Is this press plain navigation or choosing (safe on a money page when he's there)? Pure. */
function browsingPress(label: string, element: UiElement) {
  const l = clean(label);
  return SELECT_TYPES.has(element.type) || (!!l && (SAFE_UNATTENDED.test(l) || SAFE_ATTENDED.test(l)));
}
/** Keys allowed with nobody at the PC: moving, selecting, copying, undoing, saving; Enter only in a Save dialog's file name. */
const SAFE_UNATTENDED_KEYS = new Set(["tab", "shift+tab", "escape", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "ctrl+a", "ctrl+c", "ctrl+s", "ctrl+z", "ctrl+y", "ctrl+f", "ctrl+home", "ctrl+end", "alt+left", "alt+right", "f5"]);
/** Fields whose value is money or a payment detail (away mode never types into these). */
const MONEY_FIELD = /\b(?:amount|price|total|pay(?:ment)?|payee|card|cvv|cvc|expiry|bsb|account\s+(?:number|no)|tip|donation|bid|stake|wager|quantity|qty|wallet|recipient|iban|swift)\b/i;
/** Windows Save / Save As dialogs: the File name box (UIA AutomationId 1001) is the one place Enter saves. */
const SAVE_DIALOG_TITLE = /^(?:save(?:\s+as)?|save\s+file(?:\s+as)?|save\s+a\s+copy)$|\bsave\s+as\b/i;
export const UNATTENDED_SAID = "Nobody's at the PC, so I only press navigation (Next page, Back, Close, Search, Open, Play…), and never on a page about money. That press is yours to make. Nothing was pressed.";
/** Is Enter on this focus the Save dialog's own "save a new file" (away mode's only unattended Enter)? Pure. */
export function saveDialogEnter(focused: UiElement | null | undefined, title: string | null | undefined) {
  return !!focused && ["Edit", "ComboBox"].includes(focused.type) && (/\bfile\s*name\b/i.test(`${focused.name} ${focused.help}`) || focused.aid === "1001" || focused.aid === "FileNameControlHost") && SAVE_DIALOG_TITLE.test(String(title ?? "").trim());
}

/** Labels that look like money but are ordinary in a file, git or YouTube context (REVIEW-SAFETY-R3 §2 carve-outs 2-4). */
const CARVE_OUT_LABEL = /^(?:convert(?:\s+(?:files?|now|it|this|video|audio|image|document))?|transfer(?:\s+files?)?|subscribe|check\s?out(?:\s+branch)?)$/i;
const FILE_PROCESS = /^(?:explorer|excel|winword|powerpnt|onenote|acrord32|acrobat|handbrake|vlc|audacity|photos|mspaint|paint|notepad|code|wetransfer)$/i;
const GIT_PROCESS = /^(?:code|devenv|githubdesktop|gitkraken|sourcetree|fork|windowsterminal|wt|powershell|pwsh|cmd|idea64|rider64|webstorm64|smartgit|tortoisegitproc)$/i;
const hostOfUrl = (url: string | null | undefined) => {
  try {
    return url ? new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
};
/**
 * A money-looking label that is ordinary here: "Convert"/"Transfer" in a file app or a page about files,
 * "Checkout" in git, "Subscribe" on YouTube or with no price in sight. Only when nothing on the page is
 * money (no amount, no pay/card/plan id, no money site). Such a press is ASKED about, never refused. Pure.
 */
function carvedOut(label: string, element: UiElement, context: VetContext): boolean {
  const l = clean(label);
  if (!CARVE_OUT_LABEL.test(l)) return false;
  const process = (context.window?.process ?? "").replace(/\.exe$/i, "");
  const title = context.window?.title ?? "";
  const text = context.dialogText ?? title;
  if (moneyContext({ title, url: context.url, text, process })) return false;
  if (/(?:^|[\s_\-])(?:pay|payment|checkout|purchase|billing|card|wallet|price|plan|premium|order)(?:$|[\s_\-])/i.test(element.aid.replace(/([a-z])([A-Z])/g, "$1 $2"))) return false;
  // Subscribe: only on YouTube, or a free newsletter/channel page with no price or plan words in sight.
  if (/^subscribe/.test(l)) {
    if (/(?:^|\.)youtube\.com$/.test(hostOfUrl(context.url)) || /\byoutube\b/i.test(title)) return true;
    const free = /\b(?:newsletter|mailing\s+list|channel|podcast|updates|blog|feed|digest)\b/i.test(text);
    return free && !/\b(?:plans?|premium|pro|plus|trial|per\s+month|monthly|yearly|annual|price|pricing|\/\s?mo|paid|member(?:ship)?)\b/i.test(text);
  }
  if (/^(?:convert|transfer)/.test(l)) return FILE_PROCESS.test(process) || /\b(?:files?|folders?|documents?|pdf|docx?|mp[34]|jpe?g|png|wetransfer)\b/i.test(text);
  return GIT_PROCESS.test(process) || /\b(?:branch|main|master|HEAD|git|origin|commit)\b/.test(text);
}
/** Mail and chat surfaces: an amount in a message is words about money, not a payment page. */
const mailOrChat = (context: VetContext) => CHAT_PROCESS.test((context.window?.process ?? "").replace(/\.exe$/i, "")) || (!!context.browser && CHAT_TITLE.test(context.window?.title ?? "") && !MONEY_TITLE_HINT.test(context.window?.title ?? ""));
const MONEY_TITLE_HINT = /\b(?:wallet|pay|payments?|checkout|billing|bank|crypto)\b/i;
/**
 * The money context of a press on `element` and its strength (null: none). Mail and chat pages ignore an
 * amount in a message. `transactional` (a checkout: a total or amount due, a pay/order/card control or
 * field, a paying title or path, a money site) refuses; `incidental` (an amount merely in the text) asks
 * (REVIEW-SAFETY-R5 §6). Pure.
 */
function moneyLevel(element: UiElement | null, context: VetContext, commit = false): MoneyContextLevel | null {
  const beside = element ? nearbyOf(element, context.elements, context.boxes) : [];
  const nearby = beside.map((e) => e.name).join("\n").slice(0, 2000);
  const input = {
    title: context.window?.title, url: context.url, process: context.window?.process, element, controls: context.controls, commit, embeds: context.embeds === true, nearby,
    picker: amountPickerOf(beside), progress: (context.elements ?? []).some((e) => e.type === "ProgressBar"),
  };
  const withText = moneyContextLevel({ ...input, text: context.dialogText ?? context.window?.title ?? "" });
  if (!withText || !mailOrChat(context)) return withText;
  // Mail and chat: sending, replying or posting a message about money is words about money (title only). Any
  // other committing press there (Discord's "Continue" on a Nitro plan) reads the whole page (R7).
  if (commit && !MESSAGING_PRESS.test(clean(element ? labelOf(element) : ""))) return withText;
  const titleOnly = moneyContextLevel({ ...input, controls: null, nearby: null, picker: false, text: context.window?.title ?? "" });
  if (titleOnly) return titleOnly;
  // An amount box inside mail or chat (R8 §1: a Nitro gift in a chat, "Send money with Google Pay" in Gmail): an
  // amount on a CHOOSABLE control beside Send (a tip or gift tile), or an amount inside a dialog (Window box) that
  // holds Send, outside any editable draft. Static text in the conversation or the draft never counts: a friend's
  // "$20" bubble, an invoice email's "A$825.00" cell (R8 review OK5, OK6).
  const dialog = element ? dialogOf(element, context.boxes) : null;
  const drafts = (context.elements ?? []).filter((e) => e.type === "Edit" || e.type === "Document").filter((d) => !dialog || d.w * d.h < dialog.w * dialog.h);
  const inside = (e: UiElement, b: Pick<UiElement, "x" | "y" | "w" | "h">) => e.x + e.w / 2 >= b.x && e.x + e.w / 2 <= b.x + b.w && e.y + e.h / 2 >= b.y && e.y + e.h / 2 <= b.y + b.h;
  const boxAmount =
    beside.some((e) => CHOOSABLE_TYPES.has(e.type) && amountOnly(e.name)) ||
    (!!dialog && (context.elements ?? []).some((e) => e !== element && e.name && inside(e, dialog) && !drafts.some((d) => inside(e, d)) && amountOnly(e.name)));
  if (commit && boxAmount) return { reason: "an amount sits right beside that button (a payment or gift box inside the conversation)", level: "transactional" };
  // (Send, Reply and Post there are final presses: they are asked about anyway, amount or not.)
  return null;
}
const MESSAGING_PRESS = /^(?:send(?:\s+(?:message|now|reply|email))?|reply(?:\s+all)?|reply\s+in\s+thread|forward|post|comment|share(?:\s+message)?|react|envoyer|r[ée]pondre|enviar|responder|senden|antworten|verzenden)$/i;
/** Any money context (either strength): unattended runs refuse on either. */
function pressMoneyContext(element: UiElement | null, context: VetContext): string | null {
  return moneyLevel(element, context)?.reason ?? null;
}
/** YouTube's own paid buttons ("Join" is a channel membership, "Thanks" is Super Thanks). */
const YOUTUBE_PAID = /^(?:join|thanks|super\s?thanks)$/i;
const onYouTube = (url: string | null | undefined) => /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be)(?:[/:?#]|$)/i.test(String(url ?? ""));

/**
 * What a spoken yes is bound to besides the window handle (REVIEW-SAFETY-R3 finding 6): the page (title and
 * address, hashed) and the control (type, name, id, help, coarse position). Re-checked right before the
 * press; any change and the press is refused. Pure; no text is kept, only hashes.
 */
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};
/** The page: title, address AND its visible text (R4 finding 6: "Delete 1 row?" → "Delete all 5,000 rows?" re-asks). */
export function pageDigest(title: string | null | undefined, url?: string | null, text?: string | null) {
  return fnv(`${String(title ?? "").trim()}\n${String(url ?? "").trim()}\n${String(text ?? "").replace(/\s+/g, " ").trim()}`);
}
export function elementSignature(e: Pick<UiElement, "type" | "name" | "aid" | "help" | "x" | "y" | "w" | "h"> | null | undefined) {
  return e ? fnv(`${e.type}|${e.name}|${e.aid}|${e.help}|${Math.round(e.x / 16)}|${Math.round(e.y / 16)}|${Math.round(e.w / 16)}|${Math.round(e.h / 16)}`) : "none";
}
export type YesBinding = { page: string; element: string };

export function vetAction(action: Action, context: VetContext): Verdict {
  const yes = (label: string) => !!context.confirmed && clean(context.confirmed) === clean(label);
  if (context.deny) {
    // No spoken yes opens any of these: they're his alone.
    const window = deniedWindow(context.window);
    if (window) return { ok: false, said: window };
    if (action.do === "type") {
      const signIn = deniedTyping(context.window);
      if (signIn) return { ok: false, said: signIn };
      if (secureField(action.field) || secureField(context.focused)) return { ok: false, said: "That's a password or security-code field. You'll have to type that one yourself." };
    }
    if (action.do === "click" && secureField(action.element)) return { ok: false, said: "That's a password or security-code field. You'll have to fill that one yourself." };
    if (action.do === "key") {
      if (forbiddenChord(action.keys)) return { ok: false, said: `I don't press ${action.keys}: lock, sign-out, shut-down and Run keys are yours.` };
      if (secureField(context.focused) && !LEAVE_KEYS.has(canonicalKeys(action.keys.replace(/\s+/g, "")))) return { ok: false, said: "The cursor's in a password or security-code field, so I'm not pressing anything there." };
    }
  }
  if (action.do === "click") {
    const label = labelOf(action.element);
    const all = `${action.element.name} ${action.element.help} ${action.element.aid.replace(/[_-]+/g, " ")}`;
    if (INJECTION.test(all)) return { ok: false, said: "That control's text reads like instructions aimed at me, so I'm leaving it alone." };
    // Putting the cursor in a text box ("Post a comment", "Search to buy") presses nothing.
    const textBox = ["Edit", "ComboBox", "Document", "Spinner", "Slider"].includes(action.element.type);
    // Money buttons (Pay, Buy now, Place your order, Bet, Sell, Swap, Top up, Transfer, Renew, Rent $5.99,
    // Start subscription, Go Pro, Order, Stake, Mint, Claim, Gift, Give now, Approve USDC…): REFUSED, even
    // with his yes (the owner's rule), on every screen path. The label and id only: help text is prose.
    // A table's "Order" column header sorts; "Convert"/"Transfer"/"Checkout"/"Subscribe" in a file, git or
    // YouTube context with no money in sight is an ordinary final (asked, never refused).
    // (…and on his own dashboards, a bare "Order" button sorts his leads, R4 §4.)
    const header = (/^(?:HeaderItem|Header|ColumnHeader)$/.test(action.element.type) || ownDashboard(context.url)) && /^\s*(?:sort\s+)?order(?:\s+by)?\s*$/i.test(action.element.name);
    if (!textBox && onYouTube(context.url) && YOUTUBE_PAID.test(clean(label))) return { ok: false, refused: true, money: true, said: MONEY_BUTTON_SAID };
    if (!textBox && !header && moneyButton(`${action.element.name} ${action.element.aid.replace(/[_-]+/g, " ")}`)) {
      if (!carvedOut(label, action.element, context)) return { ok: false, refused: true, money: true, said: MONEY_BUTTON_SAID };
      if (context.unattended) return { ok: false, refused: true, said: UNATTENDED_SAID };
      if (!yes(label)) return { ok: false, confirm: label, said: `That's the final "${label.slice(0, 40)}" button. Shall I press it?` };
      return { ok: true };
    }
    // Final and continue presses on a checkout (a total or amount due, a pay/order/card control or field, a
    // paying page, a money site): REFUSED outright, even after his yes. Where an amount merely appears in the
    // text (a YouTube description, a pricing PR), they're ASKED (R5 §6).
    // (A committing press, Continue/Confirm/Send/Next/OK…, also reads an offer's signals and embedded frames, R6.)
    const commit = commitPress(label);
    const level = textBox ? null : moneyLevel(action.element, context, commit);
    if (!textBox && level && (FINAL_BUTTON.test(all) || AFFIRM_BUTTON.test(clean(label)) || CONTINUE_BUTTON.test(clean(label)) || commit || ENTRY_BUTTON.test(clean(label)))) {
      if (level.level === "transactional") return { ok: false, refused: true, money: true, said: `That press is on a money page (${level.reason}). I never make those, whatever the approval: it's yours to do yourself. Nothing was pressed.` };
      if (!context.unattended && !yes(label)) return { ok: false, confirm: label || "that button", said: `"${(label || "that button").slice(0, 40)}" is on a page that mentions money. Shall I press it?` };
    }
    // OK / Yes in a dialog about money (a money screen, or an amount on any page that isn't his mail, chat,
    // documents or own dashboards): refused.
    if (!textBox && AFFIRM_BUTTON.test(clean(label)) && moneyDialog(context.dialogText) && (moneySurfaceRefusal({ title: context.dialogText ?? "" }) || level)) return { ok: false, refused: true, money: true, said: MONEY_BUTTON_SAID };
    // Any OTHER press on a money page (REVIEW-SAFETY-R4 finding 1): only navigation and choosing run (Back,
    // Close, Search, Show more, a tab, a list item, a checkbox or radio). A commit-type or unknown control
    // is refused: a pay button in another language, "Charge card", "Get tickets", an icon ("→", "✓", "🛒")
    // or an unnamed button. Whatever his yes.
    // The helper couldn't read the whole context (a cap or its deadline): a commit press there is unknown, so
    // it's asked when he's there and refused when he isn't (R8 review §4). A truncated read is never "no amount".
    if (!textBox && !level && context.truncated && commit) {
      if (context.unattended) return { ok: false, refused: true, said: `I couldn't read all of that page, so I can't tell whether "${(label || "that button").slice(0, 40)}" pays for something. Nobody's at the PC, so I'm not pressing it. Nothing was pressed.` };
      if (!yes(label)) return { ok: false, confirm: label || "that button", said: `I couldn't read all of that page, so I can't rule out money. Shall I press "${(label || "that button").slice(0, 40)}"?` };
    }
    if (!textBox && level && !browsingPress(label, action.element)) {
      if (level.level === "transactional") return { ok: false, refused: true, money: true, said: `That control is on a money page (${level.reason}) and isn't plain navigation, so I'm not pressing it, whatever the approval. It's yours to do yourself. Nothing was pressed.` };
      if (!context.unattended && !yes(label)) return { ok: false, confirm: label || "that button", said: `"${(label || "that button").slice(0, 40)}" is on a page that mentions money. Shall I press it?` };
    }
    // Nobody at the PC: navigation only (deny by default), and never on a money page.
    if (context.unattended && !textBox) {
      const navigation = SAFE_UNATTENDED.test(clean(label)) || (action.element.type === "TabItem" && !FINAL_BUTTON.test(all)) || (/^save$/i.test(clean(label)) && SAVE_DIALOG_TITLE.test(context.window?.title ?? ""));
      if (!navigation || pressMoneyContext(action.element, context)) return { ok: false, refused: true, said: UNATTENDED_SAID };
    }
    if (!textBox && FINAL_BUTTON.test(all) && !yes(label)) return { ok: false, confirm: label || "that button", said: `That's the final "${(label || "that button").slice(0, 40)}" button. Shall I press it?` };
    // Yes / OK / Continue in a dialog raised by a final press, or one that says it's final.
    if (!textBox && AFFIRM_BUTTON.test(clean(label)) && (context.followUp || riskyDialog(context.dialogText)) && !yes(label))
      return { ok: false, confirm: label, said: `"${label.slice(0, 30)}" there confirms something that can't easily be undone. Shall I press it?` };
    return { ok: true };
  }
  if (action.do === "type") {
    // Both the field it's aimed at and whatever holds the focus now: a popup can steal the focus
    // between the click and the typing, and neither may be a password or other sensitive field.
    for (const field of [action.field, context.focused]) {
      if (!field) continue;
      if (field.password) return { ok: false, said: "That's a password field. You'll have to type that one yourself." };
      if (SENSITIVE_FIELD.test(`${field.name} ${field.help} ${field.aid}`))
        return { ok: false, said: `That "${labelOf(field).slice(0, 30)}" field wants something sensitive. Best you type it yourself.` };
    }
    const kind = sensitiveText(action.text);
    if (kind) return { ok: false, said: kind === "card" ? "That looks like a card number. I don't type those; you'll have to." : "That looks like a password, code or account number. I won't type it; you'll have to." };
    // Nobody at the PC: never into a money field (amount, price, payee, card…) or on a money page.
    if (context.unattended) {
      const field = action.field ?? context.focused;
      if ((field && MONEY_FIELD.test(`${field.name} ${field.help} ${field.aid.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")}`)) || pressMoneyContext(field, context))
        return { ok: false, refused: true, said: "Nobody's at the PC, and that's a money field or a page about money, so I'm not typing there. Nothing was typed." };
    }
    return { ok: true };
  }
  if (action.do === "key") {
    const f = context.focused;
    const keys = canonicalKeys(action.keys.replace(/\s+/g, ""));
    const fText = f ? `${f.name} ${f.help} ${f.aid.replace(/[_-]+/g, " ")}` : "";
    // Enter or Space on a focused money button, or in a money dialog, is a money press: refused.
    // (A money dialog: a money screen, a checkout, or OK/Yes focused where an amount shows. Where an amount
    // merely appears and the focus is some other control, the ask below applies, R5 §6.)
    const commitKey = !f || (!["Edit", "ComboBox", "Document", "Spinner"].includes(f.type) && commitPress(labelOf(f)));
    const dialogLevel = moneyDialog(context.dialogText) ? moneyLevel(f, context, commitKey) : null;
    const dialogMoney = moneyDialog(context.dialogText) && (!!moneySurfaceRefusal({ title: context.dialogText ?? "" }) || dialogLevel?.level === "transactional" || (!!dialogLevel && (!f || AFFIRM_BUTTON.test(clean(labelOf(f))) || /^(?:y|alt\+y|alt\+o)$/.test(keys))));
    if (/^(?:enter|space|y|alt\+y|alt\+o)$/.test(keys) && !(f && ["Edit", "ComboBox", "Spinner", "Document"].includes(f.type)) && ((f && moneyButton(`${f.name} ${f.aid.replace(/[_-]+/g, " ")}`)) || dialogMoney))
      return { ok: false, refused: true, money: true, said: MONEY_BUTTON_SAID };
    // Enter, Space or Ctrl+Enter on a money page submits it, even from a text box ("Enter in the Amount box
    // on 'You're sending $500.00 to Sam'"): refused, whatever the approval. A search or address box only searches.
    if (/^(?:enter|space|y|alt\+y|alt\+o|ctrl\+enter)$/.test(keys)) {
      const searchBox = !!f && ["Edit", "ComboBox"].includes(f.type) && FINAL_KEY_FIELDS.test(`${f.name} ${f.help} ${f.aid}`) && !MONEY_FIELD.test(`${f.name} ${f.aid}`);
      const money = searchBox ? null : moneyLevel(f, context, commitKey);
      if (money?.level === "transactional") return { ok: false, refused: true, money: true, said: `That key would submit a money page (${money.reason}). I never do that, whatever the approval: it's yours to do yourself. Nothing was pressed.` };
      if (money && !context.unattended && !yes(keys)) return { ok: false, confirm: keys, said: `${keys} on a page that mentions money might submit something. Shall I?` };
    }
    // Nobody at the PC: navigation keys only; Enter only to save a new file from a Save dialog's File name box.
    if (context.unattended) {
      const textFocus = !!f && ["Edit", "ComboBox", "Document", "Spinner"].includes(f.type);
      const ok = SAFE_UNATTENDED_KEYS.has(keys) || (keys === "enter" && saveDialogEnter(f, context.window?.title)) || (["backspace", "delete", "space"].includes(keys) && textFocus);
      if (!ok) return { ok: false, refused: true, said: UNATTENDED_SAID };
    }
    // Enter or Space on a focused final button presses it, exactly like a click.
    if ((keys === "enter" || keys === "space") && f && !["Edit", "ComboBox", "Document", "Spinner"].includes(f.type) && FINAL_BUTTON.test(fText) && !yes(keys))
      return { ok: false, confirm: keys, said: `That would press "${(labelOf(f) || "that button").slice(0, 40)}". Shall I?` };
    // Enter / Space / Y / Alt+Y in a dialog raised by a final press, or one whose text says it's final
    // ("are you sure", "permanently"…), presses its default Yes/OK (unless the focus is a text box).
    // Only the specific phrases here: a page merely showing a "Share" button doesn't gate Space.
    if (/^(?:enter|space|y|alt\+y|alt\+o)$/.test(keys) && !(f && ["Edit", "ComboBox", "Spinner"].includes(f.type)) && (context.followUp || RISKY_DIALOG.test(context.dialogText ?? "")) && !yes(keys))
      return { ok: false, confirm: keys, said: `${keys} there would confirm something that can't easily be undone. Shall I?` };
    // Enter in a chat or mail app's composer sends, even when it has no "message" label.
    if (keys === "enter" && f && f.type === "Document" && (CHAT_PROCESS.test(context.window?.process ?? "") || (context.browser && CHAT_TITLE.test(context.window?.title ?? ""))) && !yes("enter"))
      return { ok: false, confirm: "enter", said: "Enter there sends it. Shall I?" };
    // Ctrl+Enter and Alt+S send in most mail and chat apps.
    if (/^(?:(?:ctrl|alt|shift)\+)+enter$|^alt\+s$/.test(keys) && !yes(keys)) return { ok: false, confirm: keys, said: `${keys} usually sends it. Shall I?` };
    if (keys === "enter" && f && SENDING_FIELDS.test(fText) && !yes("enter"))
      return { ok: false, confirm: "enter", said: "Enter there sends it. Shall I?" };
    // (In a spreadsheet, document or code editor, Enter in a box moves on; there's no form to submit.)
    if (keys === "enter" && f && ["Edit", "ComboBox"].includes(f.type) && !FINAL_KEY_FIELDS.test(`${f.name} ${f.help} ${f.aid}`) && !EDITOR_APP.test(context.window?.process ?? "") && !yes("enter"))
      return { ok: false, confirm: "enter", said: "Pressing Enter there will probably submit the form. Shall I?" };
    // (With nothing focused, Delete in a follow-up or "are you sure" dialog is the same question.)
    if (keys === "delete" && (f ? !["Edit", "ComboBox", "Document"].includes(f.type) : context.followUp || RISKY_DIALOG.test(context.dialogText ?? "")) && !yes("delete"))
      return { ok: false, confirm: "delete", said: "Delete there would remove whatever's selected. Shall I?" };
    // Shift+Delete (skips the Recycle Bin) or any other modified Delete: always his call.
    if (/\+delete$/.test(keys) && !yes(keys)) return { ok: false, confirm: keys, said: `${keys} deletes it for good. Shall I?` };
    return { ok: true };
  }
  return { ok: true };
}

// --- "can this be undone?" (flag `jevIrreversible`) ---------------------------------------------
/** What Jev is shown: the control's role and label and the app. Never a value; never a secure field. */
export type IrreversibleSubject = { control: string; label: string; app: string; confirm: string };
/** Jev's probability that pressing it can't be undone (or affects other people); null = no answer. */
export type IrreversibleAsk = (subject: Omit<IrreversibleSubject, "confirm">, signal: AbortSignal) => Promise<number | null>;
/** At or above this, a spoken yes is asked for (a false "yes" costs one question; a miss costs a click). */
export const IRREVERSIBLE_MIN = 0.5;
const TEXT_TYPES = ["Edit", "ComboBox", "Document", "Spinner", "Slider"];

/** The press worth asking about, or null (typing, scrolling, a text box, a secure field, a plain key). Pure. */
export function irreversibleSubject(action: Action, context: VetContext & { app?: string }): IrreversibleSubject | null {
  const app = (context.app ?? context.window?.process ?? "").slice(0, 40);
  const keys = action.do === "key" ? canonicalKeys(action.keys.replace(/\s+/g, "")) : "";
  const target = action.do === "click" ? action.element : keys === "enter" || keys === "space" ? context.focused : null;
  if (!target || TEXT_TYPES.includes(target.type) || secureField(target)) return null;
  const label = labelOf(target).replace(/\s+/g, " ").slice(0, 80);
  if (!label || INJECTION.test(label)) return null;
  return { control: target.type, label, app, confirm: action.do === "click" ? label : keys };
}

/**
 * vetAction, then Jev's "can this be undone?" on a press the rules let through. Jev can only ADD a
 * spoken-yes gate: a refusal or a FINAL_BUTTON question from the rules always stands, and no
 * answer (no key, an error, a timeout) leaves the rules' verdict as it was.
 */
export async function vetActionWithJev(action: Action, context: VetContext & { app?: string }, ask: IrreversibleAsk | undefined, signal: AbortSignal): Promise<Verdict & { jev?: number }> {
  const base = vetAction(action, context);
  if (!base.ok || !ask) return base;
  const subject = irreversibleSubject(action, context);
  if (!subject) return base;
  // He already said yes to exactly this button (or key).
  if (context.confirmed && clean(context.confirmed) === clean(subject.confirm)) return base;
  const p = await ask({ control: subject.control, label: subject.label, app: subject.app }, signal).catch(() => null);
  if (p === null || !Number.isFinite(p) || p < IRREVERSIBLE_MIN) return p === null ? base : { ...base, jev: p };
  return { ok: false, confirm: subject.confirm, said: `"${subject.label.slice(0, 40)}" looks like it can't be undone. Shall I press it?`, jev: p };
}

// --- routing -------------------------------------------------------------------------------------
// Not "put", "check", "write" or "enter": "put YouTube on", "check my emails", "write an email" and
// "enter call mode" aren't screen work even while he's sharing ("check the box" is caught below).
const SCREEN_VERB = /^(?:click|tap|press|hit|select|choose|pick|tick|untick|uncheck|scroll|type|fill|go back|go forward|reload|refresh|close (?:this|the) tab|page (?:up|down)|highlight|focus)\b/;
const DEICTIC_ACT = [
  /^(?:type|write|enter|put|input|pop)\b.+\b(?:in|into|on) (?:there|here|this|that|the (?:\w+ )?(?:field|box|input|bar))\b/,
  /^(?:type|write|enter|put)\b.+\b(?:here|there)$/,
  /^(?:select|highlight) (?:all|everything)\b/,
  /\bhelp me (?:do|finish|fill(?: in| out)?|complete|with|get through|sort|submit)\b(?: out| in)? (?:this|that|it|the form|this form|this page|the page|these|what's on (?:my|the) screen)\b/,
  /^(?:can you )?(?:fill|finish|complete) (?:this|that|it|the form|this form)(?: in| out| off)?\b/,
  /^fill (?:in|out) (?:this|the|that) (?:form|page|bit|field)\b/,
  /\b(?:click|press|tap|hit|select|tick|check)\b.*\b(?:this|that|these) (?:button|link|box|field|checkbox|option|one)\b/,
  /\b(?:click|press|tap|type|scroll|select|fill)\b.*\bon (?:my|the) screen\b/,
  /^(?:click|tap|select|focus|tick|untick|check|uncheck)(?: on| into| in)? (?:the )?.+\b(?:field|box|input|text ?box|checkbox|check ?box|drop ?down)\b/,
  /^(?:scroll|click|type)\b.*\band (?:type|click|press|scroll|fill|select|tick)\b/,
];

/**
 * Is this an order for his real screen? `sharing`: screen sharing is on, so every click/type/
 * scroll/press is about what he's showing. Otherwise only deictic or field-level orders ("type
 * this in there", "click the Name field", "help me finish this form", "select all") count; the
 * others stay with browser_act/dictation as before. Returns the goal, or a media key for play/pause.
 */
export function screenActIntent(utterance: string, sharing = false): { goal: string } | { media: "play_pause" } | null {
  const goal = tidy(utterance);
  const u = goal.toLowerCase();
  if (!u || u.length > 240) return null;
  if (sharing && /^(?:pause|play|resume|unpause)(?: (?:the |this |that )?(?:video|clip|it|this|that|music|song))?$/.test(u)) return { media: "play_pause" };
  if (DEICTIC_ACT.some((re) => re.test(u))) return { goal };
  if (sharing && SCREEN_VERB.test(u)) return { goal };
  return null;
}
