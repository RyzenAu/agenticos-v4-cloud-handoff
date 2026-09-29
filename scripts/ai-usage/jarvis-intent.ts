// Jarvis rules intent for AI spend and plan limits:
//   "how much have I spent on AI this month"      → spend
//   "how much have I spent on Claude/OpenAI"      → spend, provider "anthropic"/"openai"
//   "which Codex account is nearly out"           → codex
//   "how much Claude have I got left"             → claude
// Anchored patterns only (no model call); answers come from the /usage snapshot, so Jarvis and the
// page always agree. Hook lines for the router are in docs/AI-USAGE.md (this file is standalone:
// scripts/jarvis-skills/* and scripts/jev*.ts belong to another engineer).
import type { AiUsageSnapshot, SubscriptionCard } from "./types";

/** `wontPay`: the same sentence also ordered a payment ("how much do I owe OpenAI, pay it"); the answer says plainly it only reads. */
export type AiUsageRequest = { skill: "ai_usage"; action: "spend"; provider?: "anthropic" | "openai"; wontPay?: true } | { skill: "ai_usage"; action: "codex" | "claude" };

const clean = (u: string) =>
  u
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/^(?:hey |ok |okay )?jarvis[, ]+/, "")
    .replace(/[?.!,]+/g, " ")
    .replace(/\b(please|mate|sir|right now|so far|currently)\b/g, " ")
    .replace(/\bai's\b|\bais\b|\ba i\b/g, "ai")
    .replace(/\s+/g, " ")
    .trim();

const SPEND = [
  /^how much (?:have|did|am|are) (?:i|we) (?:been )?(?:spent|spend|spending|paid|paying|pay) on (?:ai|the ai|all the ai|models|ai subscriptions|subscriptions)(?: this month| in total| altogether)?$/,
  /^what(?:'s| is| are) (?:my|our|the) (?:total )?ai (?:spend|spending|bill|costs?)(?: this month)?$/,
  /^how much (?:is|are|does|do) (?:ai|the ai|my ai|our ai|all the ai|the ai subscriptions) cost(?:ing)?(?: me| us)?(?: this month| a month| per month)?$/,
  /^ai (?:spend|costs?|bill)(?: this month)?$/,
];
/** A named provider's own slice of the spend, e.g. "how much have I spent on Claude". */
const SPEND_PROVIDER: Array<{ provider: "anthropic" | "openai"; test: RegExp }> = [
  { provider: "anthropic", test: /^how much (?:have|did|am|are) (?:i|we) (?:been )?(?:spent|spend|spending|paid|paying|pay) on claude(?: this month| in total| altogether)?$/ },
  { provider: "anthropic", test: /^what(?:'s| is| are) (?:my|our|the) claude (?:spend|spending|bill|costs?)(?: this month)?$/ },
  { provider: "openai", test: /^how much (?:have|did|am|are) (?:i|we) (?:been )?(?:spent|spend|spending|paid|paying|pay) on (?:openai|chatgpt|codex)(?: this month| in total| altogether)?$/ },
  { provider: "openai", test: /^what(?:'s| is| are) (?:my|our|the) (?:openai|chatgpt|codex) (?:spend|spending|bill|costs?)(?: this month)?$/ },
];
const CODEX = [
  /^which (?:codex|chatgpt|openai|gpt) account (?:is|'s) (?:nearly|almost|closest to being|about to (?:be|run)|running|close to being) (?:out|maxed|capped|full)(?: of (?:usage|credits|limits?))?$/,
  /^which (?:codex|chatgpt|openai|gpt) account is (?:closest to|nearest to|near|nearly at|close to) (?:its|the|their) (?:cap|limit)$/,
  /^(?:is|are) (?:any|either|one) of (?:the|my|our) (?:codex|chatgpt|openai) accounts? (?:nearly|almost|about to run) out$/,
  /^(?:how are|what(?:'s| is)) (?:the|my|our) (?:codex|chatgpt) (?:limits?|usage|accounts?)(?: looking| at)?$/,
];
const CLAUDE = [
  /^how much (?:claude|claude max|claude code) (?:usage |limit )?(?:have i|have we|do i have|do we have|is) (?:got )?left$/,
  /^(?:what(?:'s| is) (?:my|our|the) )?claude (?:usage|limit|limits)(?: looking like| at)?$/,
  /^how close am i to (?:my|the) claude limit$/,
];

// The looser spend question, however it is phrased ("how much have I spent on AI tools this month", "what have I
// spent on AI this month", "how much am I spending on ChatGPT and Claude", the long rambling version): a question,
// an AI name, and a spend word, with nothing that makes it a bank, shopping, time or package-price question. These
// used to fall through to the NAB bank-spend rule and answer a different number (J3, audit top-15 #5).
const AI_NAME = /\b(?:ai|claude|anthropic|chatgpt|codex|openai|gpt)\b/;
const SPEND_WORD = /\b(?:spen[dt]|spending|cost|costs|costing|paying|paid|pay|bill|bills|owe|owing)\b/;
const ASKS = /\b(?:how much|what(?:'s| is| are| have| did| do| does)|tell me|show me|much)\b/;
/** Bank, shopping and time words: those are the finance skill's (or nobody's), never the AI usage page's. */
const NOT_AI_SPEND = /\b(?:bank|nab|groceries|grocery|rent|food|coffee|fuel|petrol|card|balance|transactions?|lunch|dinner|shopping|electricity|internet|mortgage|receptionist|packages?|pricing|price|quote|clients?|customers?|websites?|essential|professional|premium|time|hours?|minutes?|tokens?|messages?|prompts?|requests?)\b/;
const ALSO_DOES = /\b(?:and then|then|also|after that)\b.*\b(?:email|open|call|book|delete|order|text|message|remind|set|create|write)\b/;

/** A payment or money order in the same sentence: "…, pay it", "and transfer 100 to savings", "and top up my credits". */
const PAYMENT_ORDER = /(?:^|[,;.]|\b(?:and|then|also|now|so|please)\b)\s*(?:please\s+)?(?:pay|transfer|send|top\s?up|refund|upgrade|cancel|subscribe|buy|purchase|wire|deposit|withdraw|charge|renew)\b/;
/** "what does ChatGPT cost" is a price question about the product, not his own spend. */
const PRICE_QUESTION = /\b(?:what|how much)\s+(?:does|do|is|are)\b/;
const FIRST_PERSON = /\b(?:my|our|i|i've|we|we've|me|us|owe)\b/;

function looseSpend(u: string, raw: string): AiUsageRequest | null {
  if (u.length > 400 || !AI_NAME.test(u) || !SPEND_WORD.test(u) || !ASKS.test(u) || NOT_AI_SPEND.test(u) || ALSO_DOES.test(u)) return null;
  if (PRICE_QUESTION.test(u) && !FIRST_PERSON.test(u)) return null;
  const claude = /\b(?:claude|anthropic)\b/.test(u);
  const openai = /\b(?:chatgpt|openai|codex|gpt)\b/.test(u);
  // The same sentence also orders a payment: the spend is answered, and the answer says plainly nothing was paid.
  const wontPay = PAYMENT_ORDER.test(raw.toLowerCase().replace(/’/g, "'")) ? { wontPay: true as const } : {};
  if (claude !== openai) return { skill: "ai_usage", action: "spend", provider: claude ? "anthropic" : "openai", ...wontPay };
  return { skill: "ai_usage", action: "spend", ...wontPay };
}

export function aiUsageIntent(utterance: string): AiUsageRequest | null {
  const u = clean(utterance);
  if (!u) return null;
  if (u.length <= 120) {
    const provider = SPEND_PROVIDER.find((p) => p.test.test(u));
    if (provider) return { skill: "ai_usage", action: "spend", provider: provider.provider };
    if (SPEND.some((re) => re.test(u))) return { skill: "ai_usage", action: "spend" };
    if (CODEX.some((re) => re.test(u))) return { skill: "ai_usage", action: "codex" };
    if (CLAUDE.some((re) => re.test(u))) return { skill: "ai_usage", action: "claude" };
  }
  return looseSpend(u, utterance);
}

/** "A$684" spoken as "684 dollars"; cents only under ten dollars. */
export function spokenAud(n: number): string {
  if (!Number.isFinite(n)) return "an unknown amount";
  if (n < 1) return `${Math.round(n * 100)} cents`;
  if (n < 10) return `${n.toFixed(2)} dollars`;
  return `${Math.round(n).toLocaleString("en-AU")} dollars`;
}

function spokenReset(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return ", resetting now";
  const h = ms / 3_600_000;
  if (h < 1) return `, resets in ${Math.max(1, Math.round(ms / 60_000))} minutes`;
  if (h < 36) return `, resets in ${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`;
  return `, resets in ${Math.round(h / 24)} days`;
}

const possessive = (owner: string) => (owner.endsWith("s") ? `${owner}'` : `${owner}'s`);
const shortPlan = (s: SubscriptionCard) => s.plan.replace(/^ChatGPT /, "").replace(/ \(US\$\d+ tier\)/, "");

/** The provider's own slice of the Usage page's spend rules: its plans (fixed) plus API actually billed (metered). */
export function providerSpend(snap: AiUsageSnapshot, provider: "anthropic" | "openai") {
  const named = provider === "anthropic" ? /anthropic|claude/i : /openai|chatgpt|codex/i;
  const fixedAud = snap.subscriptions.filter((s) => s.provider === provider).reduce((sum, s) => sum + (s.monthly?.aud ?? 0), 0);
  // Same rule as the page's totals: real per-key spend rows, never the router-receipt breakdown (already inside them).
  const meteredAud = snap.apiKeys.filter((k) => !k.id.startsWith("router:") && named.test(k.provider)).reduce((sum, k) => sum + (k.spend?.aud ?? 0), 0);
  return { fixedAud, meteredAud, totalAud: fixedAud + meteredAud };
}

/** Said before the spend when the same sentence also ordered a payment: it reads, it never pays. */
export const WONT_PAY = "I can tell you what you've spent, but I won't pay, transfer or send anything: that part is yours to do.";

export function answerAiUsage(req: AiUsageRequest, snap: AiUsageSnapshot, now = Date.now()): string {
  if (req.action === "spend" && req.wontPay) {
    const { wontPay: _ignored, ...plain } = req;
    return `${WONT_PAY} ${answerAiUsage(plain, snap, now)}`;
  }
  if (req.action === "spend" && req.provider) {
    const label = req.provider === "anthropic" ? "Claude" : "OpenAI";
    const month = snap.month.label.split(" ")[0];
    const { fixedAud, meteredAud, totalAud } = providerSpend(snap, req.provider);
    // What Claude's plan usage WOULD cost on the API is worth mentioning, but it is not money spent, and is never added in.
    const worth = req.provider === "anthropic" && "totalApiEquivalent" in snap.claudeModels ? (snap.claudeModels.totalApiEquivalent?.aud ?? 0) : 0;
    const worthLine = worth > 0 ? ` Its usage is worth about ${spokenAud(worth)} at API prices, which is not money you paid.` : "";
    if (!fixedAud && !meteredAud) return worth > 0 ? `I can't see any ${label} spend in Hermes' pool.${worthLine}` : `I can't see any ${label} spend in Hermes' pool.`;
    let out = `About ${spokenAud(totalAud)} on ${label} so far this ${month}`;
    out += fixedAud && meteredAud ? `: ${spokenAud(fixedAud)} in subscriptions and ${spokenAud(meteredAud)} of API use.` : fixedAud ? ", all in subscriptions." : ", all in API use.";
    return out + worthLine;
  }
  if (req.action === "spend") {
    const t = snap.totals;
    const month = snap.month.label.split(" ")[0];
    let out = `About ${spokenAud(t.monthAud)} on AI so far this ${month}: ${spokenAud(t.fixedAud)} in subscriptions and ${spokenAud(t.meteredAud)} of metered API use. On track for ${spokenAud(t.projectedAud)} by month end.`;
    if (t.unknown.length) out += ` Not counted: ${t.unknown.length} item${t.unknown.length === 1 ? "" : "s"} with no readable price.`;
    return out;
  }
  if (req.action === "codex") {
    const codex = snap.subscriptions.filter((s) => s.provider === "openai");
    if (!codex.length) return "I can't see any Codex accounts in Hermes' pool.";
    const known = codex.filter((s) => s.status.ok && s.peakPercent !== null).sort((a, b) => (b.peakPercent ?? 0) - (a.peakPercent ?? 0));
    if (!known.length) return "I can't read any Codex account's limits right now.";
    const top = known[0];
    const topWindow = top.status.ok ? [...top.status.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0] : null;
    const rest = known.slice(1).map((s) => `${possessive(s.owner)} ${shortPlan(s)} ${Math.round(s.peakPercent ?? 0)}%`);
    const missing = codex.length - known.length;
    let out = `${possessive(top.owner)} ${shortPlan(top)} account is closest, at ${Math.round(top.peakPercent ?? 0)}% of its ${topWindow?.label.toLowerCase() ?? ""} limit${spokenReset(topWindow?.resetsAt ?? null, now)}.`;
    if (rest.length) out += ` ${rest.join(", ")}.`;
    if (missing) out += ` ${missing} account${missing === 1 ? "" : "s"} couldn't be read.`;
    return out.replace(/\s+/g, " ");
  }
  const claude = snap.subscriptions.find((s) => s.provider === "anthropic");
  if (!claude || !claude.status.ok) return `I can't read the Claude plan's usage right now${claude && !claude.status.ok ? `: ${claude.status.reason}` : ""}.`;
  const parts = claude.status.windows.slice(0, 2).map((w) => `${Math.round(w.usedPercent)}% of the ${w.label.replace(/^Session \(5-hour\)$/, "5-hour session").replace(/^Weekly · all models$/, "weekly limit").toLowerCase()}`);
  const weekly = claude.status.windows.find((w) => w.label.startsWith("Weekly"));
  return `${claude.plan} is at ${parts.join(" and ")}${spokenReset(weekly?.resetsAt ?? null, now).replace("resets", "the week resets")}.`;
}
