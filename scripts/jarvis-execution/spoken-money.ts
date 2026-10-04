/**
 * Money requests in his own words: DETECTED here, never refused (owner decision 29 Sep: "money requests are
 * fine"). Until 29 Sep this refused "pay the Telstra bill" or "transfer $500 to Mehroz" before any rule, Jev
 * or model on the voice turn, the Jev reflex and free-text Telegram (AUDIT F4 F5). Those request refusals are
 * gone: money phrases go to the normal brain / Jev routing like any other request.
 *
 * What never changed, and still stops a payment, transfer or trade from EXECUTING (execution side):
 * - control_pc refuses money movement, trading and banks whatever the approval (src/lib/control-risk.ts
 *   controlTaskRefusal over src/lib/money-policy.ts), in the client gate and the server executor policy;
 * - screen_act refuses a money goal and never drives a bank, broker, exchange or payment screen, and every
 *   money button is refused (scripts/screen-hands/refusals.ts, plan.ts vetAction and money context);
 * - Jarvis Chrome never presses a final or money button, or a committing press on a money page, from
 *   /browser/act (scripts/browser-hands.ts, S2c); the app browser never opens a money site;
 * - away mode refuses money tasks unless away.payment is on (it is OFF) and every approvable payment needs
 *   his one-time code for that exact payment; trades, crypto, betting, new payees and card details never;
 * - T6 durable approvals.
 *
 * What stays here, as detection for ROUTING only:
 * - moneyOrder: the words order a money move ("pay the invoice", "buy 1 bitcoin"). The typed registry and
 *   the palette use it (src/lib/commands/action-guard.ts) so such words are never cut down to "open
 *   Telstra": they go, whole, to the gated turn. Nothing is refused because of it;
 * - readOnlyMoneyQuestion: a finance question the finance skill answers, his own records read, or a
 *   question that asks nothing to be done (the Jarvis entry keeps these off the coding lane);
 * - codeChangeNotPayment: a code change that only NAMES a money feature (REVIEW-T3 F7b).
 * Pure: no I/O.
 */
import { moneyRefusal, paymentIntent } from "../../src/lib/money-policy";
import { matchFinanceIntent } from "../finance/jarvis-intent";
import { matchStripeIntent } from "../finance/stripe-jarvis-intent";
import { isCodingRequest } from "../../src/lib/commands/coding";

/** Clauses: "what's my balance, then pay the bill" is two; so is "how do I pay it? just do it for me". */
const CLAUSE_SPLIT = /\s*(?:[,;:.!?]+|\b(?:and|then|also|but|so|plus|after\s+that)\b)\s*/i;
/** A clause that orders a money move or opens a money site. */
const ACTS =
  /^(?:(?:then|also|now|please|just|go|and)\s+)*(?:(?:can|could|would|will)\s+you\s+)?(?:pay|send|transfer|wire|move|buy|sell|order|purchase|renew|top\s?up|donate|bet|wager|deposit|withdraw|invest|trade|subscribe|check\s?out|book|tip|remit|swap|stake|log\s?(?:in|on)|sign\s?in|open|go\s+to|visit|click|press)\b/i;
/**
 * A clause that STARTS with a spend verb, after any yes-words or fillers: "yes pay it", "okay, renew it",
 * "issue a refund", "upgrade my OpenRouter plan". Not "pay attention", "transfer the files", "subscribe to
 * the channel" or "upgrade Windows".
 */
const SPEND_START =
  /^(?:(?:yes|yeah|yep|ok|okay|sure|alright|go\s+ahead(?:\s+and)?|and|then|also|just|please|now|so|jarvis|can\s+you|could\s+you|would\s+you)\s+)*(?:order(?:\s+(?:it|this|that|them|one|some|now|online))?(?=\s*$)|order\s+(?:it|this|that|them|one|some)\b|place\s+(?:it|them)(?=\s*$)|place\s+(?:the|an?|my)\s+(?:order|bet|trade|wager|buy|sell)\b|book\s+(?:it|them|that|this)(?=\s*$)|book\s+(?:(?:[\w'-]+\s+){0,4}?)(?:tickets?|flights?|seats?|fares?|hotel|room|stay|accommodation|trip)\b|(?:grab|snag|cop|get)\s+me\b(?=[^.;]*(?:[$£€₿]|\d|\b(?:btc|bitcoin|eth|ethereum|sol|crypto|shares?|stocks?|tickets?|flights?|from\s+(?:amazon|ebay|jb|jb\s+hi-?fi|big\s?w|kmart|target|officeworks|coles|woolworths|temu|shein|the\s+(?:shop|store))|for\s+me))\b)|(?:grab|snag|cop)\b(?=[^.;]*(?:\b(?:tickets?|flights?|seats?|btc|bitcoin|eth|shares?|stocks?)\b|\bfrom\s+(?:amazon|ebay|jb|jb\s+hi-?fi|big\s?w|kmart|target|officeworks|coles|woolworths|temu|shein|the\s+(?:shop|store))\b|\bfor\s+me\b))|pay(?!\s+(?:attention|heed|respects?|tribute|a\s+visit)\b)|buy|purchase|renew|top\s?up|donate|refund|issue\s+(?:a\s+|the\s+)?refunds?|check\s?out|wire|remit|transfer(?!\s+(?:the\s+|this\s+|that\s+|these\s+|those\s+|my\s+|our\s+|a\s+)?(?:[\w'-]+\s+)?(?:files?|folders?|documents?|docs?|photos?|pictures?|videos?|calls?|leads?|contacts?|chats?|notes?|tasks?|projects?|repos?|ownership)\b)|upgrade\s+(?:(?:my|the|our|to\s+(?:the\s+)?|to\s+a)\s+)?(?:[\w'-]+\s+){0,2}?(?:plan|subscription|tier|account|membership|pro|premium|plus))\b/i;
/**
 * Code that moves money when run ("write and run a Stripe refund script", "execute the payout job"): not a
 * code change that merely names a money feature. "run the payment tests" is ordinary.
 */
const RUN_MONEY =
  /\b(?:run|execute|trigger|fire\s+off)\b[^.;]{0,80}?\b(?:refunds?|payments?|payouts?|transfers?|charges?|purchases?|trades?|withdrawals?|deposits?)\b(?!\s+(?:tests?|specs?|suites?|checks?|lint|linter|unit|e2e|fixtures?|mocks?|docs?)\b)|\b(?:script|bot|cron(?:\s+job)?|job|program|service|function|lambda|agent|workflow|automation)\s+(?:that|which|to)\s+(?:(?:\w+\s+){0,3}?)(?:buys?|sells?|trades?|bets?|wagers?|places?\s+(?:bets?|orders?|trades?|wagers?)|tops?\s+up|pays?|purchases?|orders?|transfers?|withdraws?|deposits?|stakes?|swaps?|donates?)\b/i;
/** "…just do it for me", "go ahead and handle it": after a money question, an order. */
const DO_IT = /\b(?:(?:just\s+)?do\s+it|handle\s+it|sort\s+it(?:\s+out)?|take\s+care\s+of\s+it|make\s+it\s+happen)\b/i;
/** "search YouTube for …", "google …", "look up …": the query. */
const SEARCH = /^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:search|look\s+up|google)\s+(?:(?:on\s+)?(?:youtube|google|the\s+web|the\s+internet|online)\s+)?(?:for\s+)?(.+)$/i;
/** A question that only asks: what/when/why/which/who/where, "how much", "how do I…", "is it…". */
const QUESTION =
  /^(?:(?:hey\s+)?jarvis[,\s]+)?(?:what(?:'s|s)?|when(?:'s|s)?|why|which|who(?:'s|s|se)?|where(?:'s|s)?|how\s+(?:much|many|long|often|far)|how\s+(?:do|does|did|can|could|should|would|is|are|was)\s+(?:i|we|people|one|they|it|my|our|the|a|an|this|that|he|she|someone|anyone)|is|are|was|were|does|did|do\s+(?:i|we)|have\s+(?:i|we)|has)\b/i;
/** …but asks Jarvis to do it: "for me", "on my behalf", "you pay", "can you buy". */
const ASKS_JARVIS =
  /\b(?:for\s+me|on\s+my\s+behalf|you\s+(?:to\s+|go\s+(?:and\s+)?)?(?:pay|send|transfer|wire|buy|sell|order|purchase|renew|top\s?up|donate|bet|book|subscribe|trade|invest|deposit|withdraw|move))\b/i;
/** His own records, read or imported: transactions, balances, statements, payouts, a CSV (REVIEW-S2 fix 2). */
const RECORDS =
  /\b(?:transactions?|balances?|statements?|payouts?|csv|spend(?:ing)?|spent|income|earnings|takings|invoices?|charges?|history|activity|portfolio|holdings|fees)\b/i;
/** Any action verb at all, anywhere: then it isn't only a read. */
const ANY_ACT =
  /\b(?:pay|paid|paying|transfer|send|sending|wire|buy|sell|trade|withdraw|top\s?up|renew|donate|bet|refund|issue|log\s?(?:in|on)|sign\s?in|open|go\s+to|visit|navigate|click|press|check\s?out|order|purchase|subscribe|upgrade|move|invest|settle|settling|clear|clearing|cover|covering|process|processing|approve|action|handle|sort\s+(?:it\s+)?out|take\s+care\s+of|deposit\s+(?:\$|money|funds|cash))\b/i;

/** An amount of money anywhere: "$50", "50 dollars", "AUD 20", "a few bucks". */
const AMOUNT = /[$£€]\s?\d|\b\d[\d,.]*\s?(?:dollars?|bucks|aud|usd|cents?)\b|\b(?:aud|usd)\s?\d|\b(?:dollars?|bucks)\b/i;
/** A spend verb as the thing to do: "to pay", "and buy", "you transfer". */
const TO_SPEND =
  /\b(?:to|and|then|also|please|you)\s+(?:pay|buy|purchase|transfer|wire|renew|refund|donate|bet|wager|trade|invest|deposit|withdraw|top\s?up|check\s?out|subscribe|order|book|remit|swap|stake|tip|send\s+(?:money|funds|cash|payment))\b/i;

/**
 * A code change that only NAMES a money feature (REVIEW-T3 F7b): the coding detector says it is one, and
 * nothing in it moves money — no amount, no clause that starts with or orders a spend, no "for me" or
 * "do it". Pure.
 */
export function codeChangeNotPayment(text: string): boolean {
  const t = tidy(text);
  if (!isCodingRequest(t)) return false;
  if (AMOUNT.test(t) || TO_SPEND.test(t) || ASKS_JARVIS.test(t) || DO_IT.test(t) || RUN_MONEY.test(t) || laterClauseActs(t)) return false;
  return !clausesOf(t).some((clause) => SPEND_START.test(clause) || ACTS.test(clause));
}

const tidy = (text: string) => String(text ?? "").normalize("NFKC").replace(/[‘’`´]/g, "'").replace(/\s+/g, " ").trim();
const clausesOf = (t: string) => t.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);

/** "what's my balance, then pay the bill": a later clause acts, so the whole request isn't read-only. */
const laterClauseActs = (t: string) => clausesOf(t).slice(1).some((clause) => ACTS.test(clause));

/** Reading or importing his own records, with no action verb anywhere ("NAB transactions last week"). Pure. */
export function readsOwnRecords(text: string): boolean {
  const t = tidy(text);
  // Only for a bank, broker, exchange or Stripe named in a read (REVIEW-S2 R2): the shared table's
  // money-or-trading hits ("settle the Telstra invoice", "clear my credit card balance") stay refused.
  return moneyRefusal(t)?.kind === "bank-broker-or-exchange" && RECORDS.test(t) && !ANY_ACT.test(t);
}

/** Read-only: a finance question the local skill answers, his own records read, or a question that asks nothing to be done. */
export function readOnlyMoneyQuestion(text: string): boolean {
  const t = tidy(text);
  if (laterClauseActs(t)) return false;
  if (matchFinanceIntent(t) || matchStripeIntent(t) || readsOwnRecords(t)) return true;
  return QUESTION.test(t) && !ASKS_JARVIS.test(t);
}

/**
 * His words order a money move, a purchase, a trade, a bet, or driving a bank, broker, exchange or payment
 * service (the shapes the voice turn used to refuse before 29 Sep). DETECTION ONLY, for routing: nothing is
 * refused because of it, and execution stays gated elsewhere (see the header). Pure.
 */
export function moneyOrder(text: string): boolean {
  const t = tidy(text);
  if (!t) return false;
  const money = moneyRefusal(t);
  const intent = paymentIntent(t);
  const orders = clausesOf(t).some((clause) => SPEND_START.test(clause)) || (!!intent && (ASKS_JARVIS.test(t) || DO_IT.test(t)));
  if (!money && !orders) return false;
  if (!orders && readOnlyMoneyQuestion(t)) return false;
  if (codeChangeNotPayment(t)) return false;
  const search = SEARCH.exec(t);
  if (!orders && search && money?.kind === "money-or-trading" && !ACTS.test(search[1]) && !laterClauseActs(t)) return false;
  return true;
}

/**
 * An EXPLICIT order to move money in the words: a clause led by a spend verb, "…to pay" / "and buy", a payment
 * with "…do it for me", or code that moves money when run. Stricter than moneyOrder: naming a money feature
 * ("fix the checkout bug") is not one. Pure.
 */
/** A reminder or note about paying ("remind me to pay the bill Friday") asks for a reminder, not a payment. */
const REMINDER = /^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:remind\s+(?:me|us|mehroz|usman)|set\s+(?:a\s+|me\s+a\s+)?reminder|remember\s+to|note\s+(?:that|to|down)|add\s+(?:a\s+)?(?:task|to-?do|reminder)|put\s+(?:a\s+)?reminder)\b/i;
export function spendOrder(text: string): boolean {
  const t = tidy(text);
  if (!t || REMINDER.test(t)) return false;
  const intent = paymentIntent(t);
  return clausesOf(t).some((clause) => SPEND_START.test(clause)) || TO_SPEND.test(t) || RUN_MONEY.test(t) || (!!intent && (ASKS_JARVIS.test(t) || DO_IT.test(t)));
}

/**
 * A coding draft or job that would move money (REVIEW S2d-2): the words order a spend, or they are a money
 * order that is a coding request but not a code change that only NAMES a money feature. The line to say, or
 * null. Checked server-side where drafts are shaped and jobs start (scripts/coding), whatever lane sent the
 * words (voice, typed, the brain's delegate_task / run_workflow, the Coding page). Pure.
 */
/** A leading account or device phrase before a money verb ("on Claude Max 2 buy …", "using opus sell …", "on my laptop buy …"): round 10 review. */
const ACCOUNT_LEAD = /^(?:on|with|using|via|from)\s+(?:my\s+|the\s+|our\s+|his\s+|her\s+)?(?:[\w.'-]+\s+){1,3}?(?=(?:buy|sell|short|trade|purchase|invest|pay|transfer|order|stake|swap|bet|wager|donate|refund)\b)/i;

export function codingMoneyRefusal(text: string): string | null {
  const t = tidy(text);
  if (!t) return null;
  // The order after an account or device phrase is judged as the order it is: that phrase never makes a trade a coding request.
  const led = t.replace(ACCOUNT_LEAD, "");
  if (spendOrder(t) || (led !== t && (spendOrder(led) || moneyOrder(led))) || (moneyOrder(t) && isCodingRequest(t) && !codeChangeNotPayment(t)))
    return "A coding job never pays, buys, refunds, transfers, trades or bets: that part is yours to do yourself. Nothing was drafted or started.";
  return null;
}

/**
 * "open Stake and buy 10 Tesla shares": the launch happens, the money part doesn't. The sentence to add after
 * the launch, or "" when the words order no money move. Pure.
 */
export function launchOnlyNote(text: string): string {
  // A later clause that orders money ("…and buy 10 Tesla shares", "…and place a bet"); "open Stake" alone is a launch.
  const later = clausesOf(tidy(text)).slice(1);
  return later.some((clause) => moneyOrder(clause) || spendOrder(clause)) ? " I won't do the paying, buying, trading or betting part: that's yours to do yourself. That was a launch only." : "";
}

/** Code work in his words ("fix the checkout bug", "implement BPAY support"): naming a money feature isn't an order. */
const CODE_WORK = /^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:fix|debug|refactor|implement|build|update|change|rename|write|review|test|add|remove|design|style|document)\b/i;
/**
 * A chat message that ORDERS a money move (REVIEW S2d-1): an explicit spend order, or a money order that isn't
 * code work. Questions ("what did I spend", "how do I pay a BPAY bill") and reminders are not. Pure.
 */
export function chatMoneyOrder(text: string, people: readonly string[] = []): boolean {
  const t = tidy(text);
  if (addressedToSomeoneElse(t, people)) return false;
  return spendOrder(t) || (moneyOrder(t) && !CODE_WORK.test(t) && !isCodingRequest(t));
}
/**
 * "Mehroz, can you buy milk on the way home?": a line addressed to one of the PEOPLE in the shared chat (their
 * names from .operator-data/people.json), not to Jarvis. Only real names count (REVIEW S2e): "Quick, buy 1
 * bitcoin", "Urgent: pay the Telstra bill" and "Listen, place a bet" are orders. Pure.
 */
export function addressedToSomeoneElse(text: string, people: readonly string[] = []): boolean {
  const m = /^\s*(?:(?:hey|hi|oi)\s+)?(\p{L}[\p{L}'-]{1,30})\s*[,:]/u.exec(String(text ?? ""));
  if (!m) return false;
  const word = m[1].toLowerCase();
  return people.some((name) => String(name ?? "").trim().split(/\s+/)[0]?.toLowerCase() === word);
}

/** A chat message that orders a money move: Telegram free text never hands one to Hermes (REVIEW S2d-1). Pure. */
export const CHAT_MONEY_REFUSAL =
  "I don't pay, buy, trade or bet from a chat message, from anyone's chat. Nothing was done. Do it yourself, or say it to Jarvis at the PC, where every money press waits for your spoken yes.";
