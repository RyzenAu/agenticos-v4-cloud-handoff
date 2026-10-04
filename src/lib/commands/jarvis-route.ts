// Registry-first routing for Jarvis (AUDIT-F4 F2/F3/F9, Track 1). The typed "Ask Jarvis…" box and the
// spoken turn (scripts/free-voice.ts) both ask this FIRST, so "open finance", "show the Professional
// margin" and "open the receptionist's flagged calls" land in the same place however they arrive.
// It only claims what the registry answers clearly: an OS page, section, answer, project, site or lead
// named with a navigation verb; a margin or price question (numbers from the catalogue and economics
// model, never a language model); "explain this margin" from the page context; a device action (typed
// only; the spoken path keeps its own pc_act rules). Anything else returns null and goes where it went.
// Pure: no fetch, no DOM.
import { buildCommandIndex, mayRunEntry, packageMarginAnswer, parseCommandText, planCommand, resolveCommand } from "./registry";
import { getReceptionistPackage } from "../receptionist-packages";

const packageMarginAnswerFor = (id: string) => packageMarginAnswer(getReceptionistPackage(id));
import type { CommandAnswer, CommandIndex, CommandPlan, CommandChannel } from "./types";
import type { PageContextSnapshot } from "../page-context";
import { pageAnswerQuery, type PageAnswerQuery } from "./page-answers";
import { hasTrack2RuleAnswers, ruleAnswerFirst } from "./rule-guard";
import { actsOrPays } from "./action-guard";
import { marginAnswer, parseMarginQuery } from "../../../scripts/jev-margin";

export type JarvisRoute =
  | { kind: "navigate"; entryId: string; path: string; search?: Record<string, string>; focus?: string; label: string; said: string }
  | { kind: "open-url"; entryId: string; url: string; said: string }
  | { kind: "answer"; entryId: string; said: string; answer: CommandAnswer }
  | { kind: "explain"; said: string; source: string | null }
  /** A question answered from the page's own data (models, tools); the browser reads it (page-answers.ts). */
  | { kind: "page-answer"; query: PageAnswerQuery; said: string }
  /** "open the lead Harbour Test Dental": resolved in the browser through the CRM search; several → ask. */
  | { kind: "open-lead"; name: string; said: string }
  | { kind: "device"; entryId: string; plan: Extract<CommandPlan, { kind: "device" }>; said: string }
  | { kind: "ask"; said: string };

// "find" is a search, not a place ("find my notes about pricing" is memory's): only these verbs navigate.
const NAV_VERB = new Set(["open", "show", "launch"]);
/** "open the file X", "open my Downloads folder": files and folders, never an OS page. */
const FILEISH = /\b(?:file|files|document|doc|spreadsheet|sheet|pdf|folder|downloads|documents|desktop|pictures|music|videos)\b/i;
const QUESTION = /^(?:what(?:'s| is| are)?|how (?:much|many)|how's|tell me|give me)\b/i;
const MONEY_WORDS = /\b(?:margin|margins|profit|profitability|contribution|price|prices|pricing|cost|how much)\b/i;
const PRICE_Q = /\b(?:how much|price|pricing|cost)\b/i;
const EXPLAIN = /^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:explain|break down|walk me through|what(?:'s| is) behind|why is)\s+(?:this|that|the)(?:\s+(margin|number|figure|package|price|metric))?\b/i;

let staticIndex: CommandIndex | null = null;
/** The static index (pages, sections, answers): what the server can resolve without the browser's sources. */
export function staticCommandIndex(): CommandIndex {
  staticIndex ??= buildCommandIndex();
  return staticIndex;
}

/** "open the lead Harbour Test Dental" / "show lead #12" → the name or id, else null. Pure. */
export function leadNameIn(text: string): string | null {
  const m = /^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:open|show(?: me)?|pull up|bring up|go to|find)\s+(?:the\s+)?lead\s+(?:for\s+|called\s+|named\s+)?["“']?(.{2,60}?)["”']?\s*[.!?]?$/i.exec(text.trim());
  return m ? m[1].trim() : null;
}

/** Which lead: one hit opens it; several ask which (never the first by default); none says so. Pure. */
export function pickLead(name: string, hits: readonly { leadId: number; title: string; detail?: string }[]): { open: number; title: string } | { ask: string } | { none: string } {
  const unique = [...new Map(hits.map((h) => [h.leadId, h])).values()];
  const exact = unique.filter((h) => h.title.trim().toLowerCase() === name.replace(/^#/, "").trim().toLowerCase() || `#${h.leadId}` === name.trim() || String(h.leadId) === name.trim());
  const pool = exact.length ? exact : unique;
  if (pool.length === 1) return { open: pool[0].leadId, title: pool[0].title };
  if (!pool.length) return { none: `No lead matches "${name}".` };
  return { ask: `Which one? ${pool.slice(0, 4).map((h) => `${h.title} (#${h.leadId})`).join(", ")}${pool.length > 4 ? ", …" : ""}.` };
}

/** "Explain this margin": the figures the page itself computed, with their source. Never a guess. */
export function explainFromContext(text: string, context: PageContextSnapshot | null | undefined): JarvisRoute | null {
  const m = EXPLAIN.exec(text.trim());
  if (!m) return null;
  const noun = m[1]?.toLowerCase() ?? null;
  const item = context?.focused?.facts ? context.focused : context?.selection?.facts ? context.selection : null;
  if (!item || !item.facts) {
    const where = context?.page?.title ? ` on ${context.page.title}` : "";
    return {
      kind: "explain",
      said: `I can't see which ${noun ?? "figure"} you mean${where}, so I won't guess. Open Packages & economics and choose a package, or name it (for example, "the Professional margin").`,
      source: null,
    };
  }
  const facts = Object.entries(item.facts).map(([k, v]) => `${k}: ${v}`);
  const estimate = context?.sources.find((s) => s.state === "simulated");
  return {
    kind: "explain",
    said: `${item.label}. ${facts.join("; ")}.${item.source ? ` Source: ${item.source}.` : ""}${estimate ? " These are estimates from planning assumptions, not measured usage or reconciled invoices." : ""}`,
    source: item.source ?? null,
  };
}

function answerSaid(text: string, answer: CommandAnswer) {
  const price = answer.figures.find((f) => f.label === "Price");
  const lead = PRICE_Q.test(text) && price ? `${answer.headline.split(":")[0]} is ${price.value}. ` : "";
  return `${lead}${answer.headline}. ${answer.caveat ?? ""}`.trim();
}

/**
 * The route for one request, or null when the registry shouldn't claim it. `channel: "voice"` needs a
 * stronger match and never returns a device route (the voice turn's own rules and resolveTarget own those).
 */
/** The same whole-utterance answers the hub treats as an answer to its own question (scripts/jarvis-command/service.ts ANSWER_WORDS). */
const WHOLE_ANSWER = /^(?:jarvis,?\s+)?(?:yes|yeah|yep|yup|yes please|sure|go ahead|do it|start it|start|run it|kick it off|confirm(?:ed)?|approve(?: it)?|okay|ok|no|nope|no thanks|leave it|don't|cancel it)[.!]?$/i;

export function routeJarvisText(
  text: string,
  options: { index?: CommandIndex; channel?: CommandChannel; context?: PageContextSnapshot | null; personId?: string } = {},
): JarvisRoute | null {
  const channel = options.channel ?? "typed";
  // A whole-utterance answer ("start it", "yes", "go ahead") answers the question Jarvis just asked; its "it" is never something on this page.
  // The hub knows the pending question (production 4 Oct: a typed "start it" got "I can't tell which item you mean" and the draft never started).
  if (WHOLE_ANSWER.test(text.trim())) return null;
  // Rules answer first (Track 2): "receptionist status", "what did I spend this month", "remember that …"
  // are answered by their services through the command entry, never turned into opening a page.
  if (ruleAnswerFirst(text)) return null;
  // Money, action and compound words go whole to the gated turn (REVIEW-T1 fix 2): never cut to a plain open.
  if (actsOrPays(text)) return null;
  const explained = explainFromContext(text, options.context);
  // With Track 2 in the build its command entry explains (it receives the page context), typed and spoken.
  if (explained) return hasTrack2RuleAnswers() ? null : explained;
  const lead = leadNameIn(text);
  if (lead) return { kind: "open-lead", name: lead, said: `Looking up the lead ${lead}.` };
  const pageQuestion = pageAnswerQuery(text);
  if (pageQuestion) return { kind: "page-answer", query: pageQuestion, said: pageQuestion === "models.free" ? "Checking the model catalogue." : "Checking the tool registry." };
  const parsed = parseCommandText(text);
  if (!parsed.object) return null;
  const verb = parsed.verb !== null && NAV_VERB.has(parsed.verb);
  const fileish = FILEISH.test(parsed.object);
  const moneyQuestion = !verb && QUESTION.test(text.trim().replace(/^(?:hey\s+)?jarvis[,\s]+/i, "")) && MONEY_WORDS.test(text);
  if (!verb && !moneyQuestion) return null;
  // A margin question with its own scenario ("Essential with 10 clients in a busy month"): the same
  // deterministic answer Jarvis's entry gives (scripts/jev-margin.ts over the catalogue + economics model).
  if (moneyQuestion && !PRICE_Q.test(text)) {
    const q = parseMarginQuery(text);
    if (q) return { kind: "answer", entryId: `answer:margin/${q.pkg.id}`, said: marginAnswer(q).said, answer: packageMarginAnswerFor(q.pkg.id) };
  }
  if (parsed.object.split(" ").length > 9) return null;
  // A question is scored on what it names, not its question words ("what's our margin on the Professional package").
  const asked = moneyQuestion ? text.trim().replace(/^(?:(?:hey\s+)?jarvis[,\s]+)?(?:what(?:'s| is| are)|how much (?:is|are|does|do)|how many|how's|tell me|give me)\s+(?:our|the|my|a)?\s*/i, "") : text;
  const r = resolveCommand(asked, options.index ?? staticCommandIndex(), { channel, context: options.context ?? null });
  if (r.status === "ambiguous") return verb ? { kind: "ask", said: r.ask } : null;
  // "That call" with nothing on the page to point at: say the context is unknown and ask (review item 8).
  if (r.status === "unresolved" && r.parsed.deictic) return { kind: "ask", said: r.reason };
  if (r.status !== "resolved") return null;
  const e = r.entry;
  // Coding work said to Jarvis is a task for the hub: Jev decides it, the draft is bound to THIS conversation and asks "Start it?" here, and
  // the result comes back here. Only the palette jumps to the draft page (production 4 Oct: a typed request opened /coding?request=… and its
  // draft was bound to no conversation).
  if (e.id === "coding:request" || e.id === "websites:make-site") return null;
  if (moneyQuestion) return e.answer ? { kind: "answer", entryId: e.id, said: answerSaid(text, e.answer), answer: e.answer } : null;
  // Files and folders are the device's (the file lane, the PC rules): never an OS page with a similar name.
  if (fileish && e.kind !== "file") return null;
  // A device action or an external site runs only on a full, confident match of his words.
  if (!mayRunEntry({ entry: e, score: r.score }, r.parsed.object)) return null;
  if (e.action.type === "device") {
    if (channel === "voice") return null;
    const plan = planCommand(e, r.parsed, { personId: options.personId });
    return plan.kind === "device" ? { kind: "device", entryId: e.id, plan, said: `Opening ${e.title}` } : null;
  }
  if (e.action.type === "open-url") return { kind: "open-url", entryId: e.id, url: e.action.url, said: `Opening ${e.title}.` };
  const a = e.action;
  return {
    kind: "navigate",
    entryId: e.id,
    path: a.to,
    ...(a.search ? { search: a.search } : {}),
    ...(a.focus ? { focus: a.focus } : {}),
    label: e.title,
    said: e.answer ? `${e.answer.headline}. ${e.answer.caveat ?? ""}`.trim() : `Opened ${e.title}.`,
  };
}

/** "/operations?package=receptionist-professional" for a navigate route (the voice navigate tool's path). */
export function routeHref(r: Extract<JarvisRoute, { kind: "navigate" }>) {
  const q = r.search ? `?${new URLSearchParams(r.search).toString()}` : "";
  return `${r.path}${q}`;
}
