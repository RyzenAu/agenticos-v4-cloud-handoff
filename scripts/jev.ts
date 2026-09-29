/**
 * Jev reflex layer for Jarvis's voice. TypeSafe AI's Jev is a "System One" model: it
 * cannot write text, it makes typed decisions (choice / score / noul) with calibrated
 * probabilities in ~70–500 ms, and it cannot return an answer outside the options given.
 *
 * One fan-out request per utterance decides the lane (which tool), the page or site, and
 * whether the request is complete, addressed to Jarvis, or consequential. When Jev is
 * confident and the tool's arguments follow from those choices alone, Jarvis acts on the
 * decision directly instead of waiting for the language model; otherwise the brain gets
 * Jev's guess as a hint. No key, a slow answer or an error simply means no reflex.
 *
 * Every call goes through the one Jev client (scripts/jev-client.ts): the endpoint, the catalogue's
 * model id, the 1.5 s budget (surface voice.reflex: the community routers fall back at 1.5 s; so do
 * we), bounded retries and a router receipt per decision all live there.
 *   request: { state, model, questions: { name: { type, instructions, criteria } } }
 *   → { answers: { name: { type, choice?, noul?, score?, confidence?, probabilities? } } }
 */
import { jevAnswers, type JevAnswer } from "./jev-client";

// Re-exported for callers that still read them (scripts/away-mode/jev-fallback.ts).
export { JEV_MODEL, JEV_URL } from "./jev-client";

export const LANES = {
  navigate: "Open one of the OS's own pages: inbox, calendar, memory, business, chat, design, websites, code graph, Hermes, settings.",
  open_url: "Show a website in a browser tab (YouTube, Gmail, a named site or a spoken web address) — only showing it, nothing else.",
  control_pc: "Do something on the computer or the web: open or use an app, a file or folder, Obsidian, WhatsApp or messages, take a screenshot, clip or save a page, any multi-step task.",
  get_recent_emails: "Check for the newest or latest emails right now.",
  search_saved_emails: "Find or show a specific email, thread or sender.",
  search_memory: "Recall something he saved or remembered before.",
  get_recent_meetings: "Meetings, calls or Granola notes.",
  ask_workspace: "A question about his calendar, schedule, business numbers, goals or connections.",
  delegate_task: "Coding or agent work for Codex or Claude to build or fix.",
  chat: "Just talking: a question, opinion, joke or small talk that needs no tool.",
} as const;
export type Lane = keyof typeof LANES;

export const PAGES: Record<string, string> = {
  "/inbox": "inbox, email, mail",
  "/calendar": "calendar, schedule, events",
  "/memory": "memory, notes, second brain",
  "/business": "business, dashboard, revenue, audience",
  "/chat": "chat",
  "/design": "design studio, images",
  "/websites": "websites",
  "/codegraph": "code graph",
  "/agents/hermes": "Hermes agent page",
  "/settings": "settings",
  // AUDIT-F4 F3 (Track 1): the eight destinations and the pages people ask for by name (src/components/shell/destinations.ts).
  "/today": "today, home, what needs me",
  "/jarvis": "Jarvis page",
  "/receptionist": "receptionist, calls, safe to sell",
  "/operations": "operations, packages, pricing, margins",
  "/work": "work, approvals",
  "/finance": "finance, money, invoices",
  "/studio": "studio, proposals, decks, videos",
  "/system": "system, devices, diagnostics",
  "/models": "models, model routes",
  "/agents/claude-code": "coding jobs, Claude Code",
};

/** Sites Jarvis can open by name. Anything spoken as a domain is added per request. */
export const SITES: Record<string, string> = {
  "https://www.youtube.com": "YouTube (yt)",
  "https://mail.google.com": "Gmail (email, mail)",
  "https://calendar.google.com": "Google Calendar (gcal)",
  "https://drive.google.com": "Google Drive (gdrive)",
  "https://www.google.com": "Google search",
  "https://maps.google.com": "Google Maps",
  "https://github.com": "GitHub (gh)",
  "https://vercel.com/dashboard": "Vercel",
  "https://www.notion.so": "Notion",
  "https://www.linkedin.com": "LinkedIn (li)",
  "https://x.com": "X / Twitter (tw)",
  "https://www.instagram.com": "Instagram (ig, insta)",
  "https://www.facebook.com": "Facebook (fb)",
  "https://chatgpt.com": "ChatGPT (gpt)",
  "https://claude.ai": "Claude",
  "https://notebooklm.google.com": "NotebookLM (nlm)",
  "https://www.skool.com": "Skool",
  // No Spotify app is installed on this PC (24 Sep), so "fire up spotify" opens the web player.
  "https://open.spotify.com": "Spotify",
};

export type Reflex = {
  lane: Lane;
  laneConfidence: number;
  page?: string;
  pageConfidence: number;
  site?: string;
  siteConfidence: number;
  complete: number;
  addressed: number;
  stakes: number;
  ms: number;
};

/** Domains spoken or typed in the utterance ("open example dot com"), as candidate URLs. */
export function spokenUrls(text: string) {
  const normalised = text.replace(/\s+dot\s+/gi, ".").replace(/\s+slash\s+/gi, "/");
  const found = normalised.match(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|au|net|org|io|ai|dev|app|co|so|gg|tv|me)\b(?:\/[\w\-./?=&%#]*)?/gi) ?? [];
  return [...new Set(found.map((u) => (u.startsWith("http") ? u : `https://${u}`)))].slice(0, 10);
}

export function reflexQuestions(text: string) {
  const sites: Record<string, string> = { ...SITES, none: "No website is involved" };
  for (const url of spokenUrls(text)) sites[url] = `The address he said: ${url}`;
  const questions = {
    lane: { type: "choice", instructions: "Which single action best serves what the user just said to their assistant, Jarvis?", criteria: LANES },
    page: { type: "choice", instructions: "If the user wants one of the OS's own pages, which one?", criteria: { ...PAGES, none: "No OS page" } },
    site: { type: "choice", instructions: "If the user wants a website shown, which one?", criteria: sites },
    complete: { type: "noul", instructions: "The user has finished a complete, actionable request (not cut off mid-sentence)." },
    addressed: { type: "noul", instructions: "The user is speaking to the assistant, not to someone else in the room." },
    stakes: { type: "noul", instructions: "Doing this would send a message or email, spend or move money, book, publish, post, delete, deploy or push — something that affects other people or can't be undone." },
  };
  return { questions, sites };
}

export async function jevReflex(text: string, key: string, request?: typeof fetch, shorthand: string[] = []): Promise<Reflex | null> {
  if (!key || !text.trim()) return null;
  const { questions } = reflexQuestions(text);
  const started = Date.now();
  // His shorthand travels with the words ("yt = YouTube"), so Jev reads him as he means it.
  const state = shorthand.length ? { utterance: text.slice(0, 2000), shorthand } : { utterance: text.slice(0, 2000) };
  const a = await jevAnswers({ surface: "voice.reflex", caller: "scripts/jev.ts", key, state, questions, request });
  if (!a) return null;
  const lane = a.lane?.choice as Lane | undefined;
  if (!lane || !(lane in LANES)) return null;
  const pick = (answer?: JevAnswer) => (answer?.choice && answer.choice !== "none" ? answer.choice : undefined);
  return {
    lane,
    laneConfidence: a.lane?.confidence ?? 0,
    page: pick(a.page),
    pageConfidence: a.page?.confidence ?? 0,
    site: pick(a.site),
    siteConfidence: a.site?.confidence ?? 0,
    complete: a.complete?.noul ?? 0,
    addressed: a.addressed?.noul ?? 1,
    stakes: a.stakes?.noul ?? 0,
    ms: Date.now() - started,
  };
}

export const FAST_PATH_CONFIDENCE = 0.85;

/**
 * The tool call Jarvis can make straight from Jev's decision, or null when the language
 * model should decide (low confidence, an incomplete request, arguments that need
 * writing, or just conversation). Consequential PC tasks still go through control_pc's
 * spoken-yes gate on the client; the reflex never marks anything confirmed.
 */
export function reflexToolCall(reflex: Reflex | null, text: string): { name: string; arguments: Record<string, unknown> } | null {
  if (!reflex || reflex.laneConfidence < FAST_PATH_CONFIDENCE || reflex.complete < 0.6 || reflex.addressed < 0.5) return null;
  const utterance = text.trim().slice(0, 2000);
  switch (reflex.lane) {
    case "navigate":
      return reflex.page && reflex.pageConfidence >= FAST_PATH_CONFIDENCE ? { name: "navigate", arguments: { path: reflex.page } } : null;
    case "open_url":
      // "search / play / find X" needs X in the URL; let the brain build the search link.
      if (/\b(search|play|find|look\s*up|watch|videos?|songs?)\b/i.test(utterance)) return null;
      return reflex.site && reflex.siteConfidence >= FAST_PATH_CONFIDENCE ? { name: "open_url", arguments: { url: reflex.site } } : null;
    case "control_pc":
      return { name: "control_pc", arguments: { task: utterance } };
    case "get_recent_emails":
      return { name: "get_recent_emails", arguments: {} };
    case "search_memory":
      return { name: "search_memory", arguments: { query: utterance } };
    case "ask_workspace":
      return { name: "ask_workspace", arguments: { request: utterance } };
    default:
      // search_saved_emails needs keywords, meetings a topic, delegation a brief, chat a reply.
      return null;
  }
}

export const SPECULATIVE_CONFIDENCE = 0.9;

/**
 * Acting before he finishes speaking. Only show-only, instantly reversible actions qualify:
 * opening one of the OS's pages or showing a website. Everything that runs a task, reads or
 * sends data, or could matter to anyone else waits for the end of speech (reflexToolCall), and
 * this is stricter than that on every axis: 0.9 confidence on both the lane and the target, a
 * request that already sounds complete, clearly addressed to Jarvis, with negligible stakes.
 */
export function speculativeToolCall(reflex: Reflex | null, text: string): { name: "navigate" | "open_url"; arguments: Record<string, unknown> } | null {
  if (!reflex || reflex.laneConfidence < SPECULATIVE_CONFIDENCE || reflex.complete < 0.8 || reflex.addressed < 0.7 || reflex.stakes >= 0.2) return null;
  const call = reflexToolCall(reflex, text);
  if (call?.name === "navigate" && reflex.pageConfidence >= SPECULATIVE_CONFIDENCE) return call as { name: "navigate"; arguments: Record<string, unknown> };
  if (call?.name === "open_url" && reflex.siteConfidence >= SPECULATIVE_CONFIDENCE) return call as { name: "open_url"; arguments: Record<string, unknown> };
  return null;
}

/** A one-line hint for the language model when the reflex didn't act on its own. */
export function reflexHint(reflex: Reflex | null) {
  if (!reflex) return "";
  const bits = [`likely ${reflex.lane} (${Math.round(reflex.laneConfidence * 100)}%)`];
  if (reflex.page) bits.push(`page ${reflex.page}`);
  if (reflex.site) bits.push(`site ${reflex.site}`);
  if (reflex.stakes >= 0.5) bits.push("consequential: needs his yes");
  if (reflex.complete < 0.6) bits.push("he may not have finished speaking");
  return `Fast decision layer (Jev): ${bits.join("; ")}.`;
}
