// Plain multi-step requests, split by code into the direct routes they're made of, with no model
// and no Hermes: "set a 25-minute focus timer and mute notifications", "open Notepad and type a
// shopping list: milk, eggs, bread", "open my Vercel dashboard and tell me the last deploy status".
//
// A request is split on "and", "then" or a comma only where EVERY part is something a rule already
// answers (a skill, an app or folder to open, a setting). If any part isn't, nothing is split and
// the request goes on to Jev and the brain as before. A request that reaches other people ("… and
// message Mehroz") is never split: it stays with control_pc's spoken-yes gate.
import { pcIntent, type PcRequest } from "./pc-hands";
import { skillIntent, type SkillContext } from "./jarvis-skills";
import { deploysIntent, settingsIntent } from "./jarvis-skills/pc-control";
import { needsConfirmation } from "../src/lib/jarvis-control";
import { SITES } from "./jev";

export type RuleCall = { name: "skill" | "pc_act" | "open_url"; arguments: Record<string, unknown> };

/** "a 25-minute focus timer" → "a timer for 25 minutes" (the timer grammar's own shape). Pure. */
export function normaliseClause(clause: string) {
  return clause
    .trim()
    .replace(/^(?:and |then |also |plus )+/i, "")
    .replace(/^(?:set|start|put on|give me) (?:a |an )?(\d+|a|an|one|two|three|five|ten|fifteen|twenty|thirty|forty|forty-five|sixty)[- ](second|minute|hour|min)s?(?: long)? (?:\w+ )?timer$/i, "set a timer for $1 $2s")
    .replace(/[.!?]+$/, "")
    .trim();
}

/** One clause → the rule call that answers it, or null. Pure (given the Start-app list). */
export function clauseCall(clause: string, context: SkillContext = {}, pc: (text: string) => PcRequest | null = pcIntent): RuleCall | null {
  const c = normaliseClause(clause);
  if (!c) return null;
  const settings = settingsIntent(c);
  if (settings) return { name: "skill", arguments: settings };
  const deploys = deploysIntent(c);
  if (deploys) return { name: "skill", arguments: deploys };
  const skill = skillIntent(c, context);
  if (skill && skill.skill !== "say") return { name: "skill", arguments: skill };
  const open = pc(c);
  if (open) return { name: "pc_act", arguments: { ...open } };
  // "go to my Vercel dashboard", "open the Vercel dashboard"
  if (/^(?:open|go to|bring up|pull up|show me) (?:my |the )?vercel(?: dashboard)?$/i.test(c)) return { name: "open_url", arguments: { url: "https://vercel.com/dashboard" } };
  return null;
}

/**
 * "Search YouTube for lo-fi beats", "google the weather in Paris", "open Spotify and play my liked
 * songs": straight to the page, no model. Pure.
 */
export function sitePage(utterance: string): RuleCall | null {
  const u = utterance.trim().replace(/[.!?]+$/, "").replace(/^(?:can you |could you |please )/i, "");
  let m = u.match(/^(?:search|look up|find)(?: on)? youtube for (.{2,100})$|^(?:search|look up|find|play) (.{2,100}?) on youtube$|^youtube (.{2,100})$/i);
  if (m) return { name: "open_url", arguments: { url: `https://www.youtube.com/results?search_query=${encodeURIComponent((m[1] ?? m[2] ?? m[3]).trim())}` } };
  m = u.match(/^(?:google|search google for|search the web for) (.{2,120})$/i);
  if (m) return { name: "open_url", arguments: { url: `https://www.google.com/search?q=${encodeURIComponent(m[1].trim())}` } };
  if (/^(?:open |launch |start )?spotify(?: and)? (?:play|put on|open) (?:my )?liked songs$|^play my liked songs(?: on spotify)?$/i.test(u)) return { name: "open_url", arguments: { url: "https://open.spotify.com/collection/tracks" } };
  return null;
}

/** "GitHub" → its address, from the sites Jarvis opens by name (jev.ts SITES: "GitHub (gh)"). Pure. */
export function siteUrl(name: string) {
  const n = name.trim().toLowerCase().replace(/^(?:the|my)\s+/, "");
  for (const [url, label] of Object.entries(SITES)) {
    const names = label.toLowerCase().split(/[()\/,]/).map((x) => x.trim()).filter(Boolean);
    if (names.includes(n) || names.some((x) => x.split(" ")[0] === n)) return url;
  }
  return null;
}
/** "open GitHub and Vercel in new tabs", "open YouTube, Gmail and Notion": each site in its own tab. Pure. */
export function siteTabs(utterance: string): RuleCall[] | null {
  const m = utterance.trim().replace(/[.!?]+$/, "").match(/^(?:open|pull up|bring up|load)(?: up)? (.+?)(?: (?:in|as) (?:new|separate|their own|two|three|different) tabs?| in tabs)?$/i);
  if (!m) return null;
  // ("Open Gmail and then YouTube" is two sites too, J4.)
  const names = m[1].split(/\s*,\s*(?:and\s+(?:then\s+)?)?|\s+and\s+then\s+|\s+then\s+|\s+and\s+/i).filter(Boolean);
  if (names.length < 2 || names.length > 6) return null;
  const urls = names.map(siteUrl);
  return urls.every(Boolean) ? urls.map((url) => ({ name: "open_url" as const, arguments: { url } })) : null;
}

const SPLIT = /\s*(?:,\s*and then|,\s*then|,\s*and|\band then\b|\bthen\b|\band\b|,)\s+/gi;

/** Every way to cut the words into 2-4 rule-answered clauses; the first that works wins. Pure. */
export function compoundCalls(utterance: string, context: SkillContext = {}, pc: (text: string) => PcRequest | null = pcIntent): RuleCall[] | null {
  const u = utterance.trim().replace(/^(?:(?:ok(?:ay)?|hey)[,\s]+)?(?:jarvis[,\s]+)?/i, "").replace(/^(?:can you|could you|please)\s+/i, "").replace(/[\s,]+(?:please|thanks|jarvis)[.!?]*$/i, "");
  if (!u || u.length > 300) return null;
  const page = sitePage(u);
  if (page) return [page];
  const tabs = siteTabs(u);
  if (tabs) return tabs;
  // "Open Chrome, go to my Vercel dashboard and tell me the last deploy status": the status comes
  // straight from the Vercel CLI (no clicking); the dashboard opens too when he asked to see it.
  const deploys = deploysIntent(u);
  if (deploys) {
    const calls: RuleCall[] = [];
    if (/\b(?:open|go to|show me|pull up|bring up)\b.*\bvercel\b|\bdashboard\b/i.test(u)) calls.push({ name: "open_url", arguments: { url: "https://vercel.com/dashboard" } });
    calls.push({ name: "skill", arguments: deploys });
    return calls.length > 1 ? calls : null;
  }
  if (needsConfirmation(u)) return null;
  const cuts: number[] = [];
  for (const m of u.matchAll(SPLIT)) cuts.push(m.index!);
  if (!cuts.length) return null;
  const solve = (text: string, depth: number): RuleCall[] | null => {
    const whole = clauseCall(text, context, pc);
    if (whole) return [whole];
    if (depth >= 3) return null;
    for (const m of text.matchAll(SPLIT)) {
      const head = clauseCall(text.slice(0, m.index!), context, pc);
      if (!head) continue;
      const rest = solve(text.slice(m.index! + m[0].length), depth + 1);
      if (rest) return [head, ...rest];
    }
    return null;
  };
  const calls = solve(u, 0);
  if (!calls || calls.length < 2) return null;
  // Typing right after opening an app goes into that app, once it's in front (never whatever else is).
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const cur = calls[i];
    if (cur.name === "skill" && cur.arguments.skill === "type" && prev.name === "pc_act" && prev.arguments.action === "open_app") cur.arguments = { ...cur.arguments, app: String(prev.arguments.target ?? "") };
  }
  return calls;
}
