/**
 * The control executor's code-owned policy (audit A-H2, 27 Sep 2026). Approval cannot lift it.
 *
 * Denylist first (src/lib/control-risk.ts controlTaskRefusal): the shared money policy (moneyRefusal:
 * trades, transfers, payments, payees, crypto sends, bank/broker logins, named institutions and their
 * sites, in digits or words), the control-only money verbs (send, pay, transfer, PayID, BPAY, Osko,
 * buy, sell, trade, order, withdraw, deposit), plain finance words, and any secret-bearing path or
 * private data.
 *
 * Then an allowlist: every clause must start with a permitted verb, and a clause that opens,
 * launches, switches to or closes something must name a permitted app, a path, a URL or a
 * plain new tab/window/file. Anything else is refused (fail closed). Pure; no I/O.
 */
import { controlTaskRefusal, splitClauses, type ControlRefusal } from "../../src/lib/control-risk";

const FILLER = /^(?:(?:please|pls|hey jarvis|jarvis|ok(?:ay)?|can you|could you|would you|now|then|and|also|just)[,\s]+)*/i;

/** Verbs a desktop-control clause may start with. */
const ALLOWED_LEAD =
  /^(?:open|launch|start(?: up)?|bring up|pull up|switch to|focus(?: on)?|close|minimi[sz]e|maximi[sz]e|restore|snap|go to|navigate to|visit|browse to|play|pause|resume|stop (?:the )?(?:music|song|track|video|playback)|skip|next (?:song|track|tab|page)|previous (?:song|track|tab|page)|mute|unmute|volume|turn (?:the )?volume|turn (?:it )?(?:up|down)|set (?:a |an )?(?:timer|reminder|alarm)|take (?:a )?screenshot|screenshot|type|write|paste|copy|select|scroll|zoom|create|make|new|save|click|double[- ]click|right[- ]click|press|find|search(?: for)?|look up|look (?:for|at)|show(?: me)?|list|read(?: me)?|check|count|describe|summari[sz]e|what(?:'s|s)?|which|where|how|is|are)\b/i;

/** Apps a launch-type clause may name. Messaging, terminals, settings and finance apps are absent on purpose. */
const ALLOWED_APPS =
  /\b(?:notepad|calculator|calc|paint|file explorer|explorer|this pc|chrome|google chrome|edge|microsoft edge|firefox|spotify|vs ?code|visual studio code|word|microsoft word|excel|powerpoint|onenote|obsidian|snipping tool|photos|clock|alarms|sticky notes|media player|vlc|youtube)\b/i;
const LAUNCH = /^(?:open|launch|start(?: up)?|bring up|pull up|switch to|focus(?: on)?|close)\b\s*(.*)$/i;
/**
 * A launch names ONLY an allowed app, path or URL (REVIEW-SAFETY-R4 finding 5): "open YouTube" passes;
 * "open YouTube and rent Dune", "start the YouTube Premium trial", "start Spotify Premium" don't (the tail
 * is its own action, which the allowlist never saw).
 */
const APP_NAMES = ALLOWED_APPS.source.replace(/^\\b\(\?:/, "").replace(/\)\\b$/, "");
const ALLOWED_APP_ONLY = new RegExp(
  // "YouTube", "the Excel app", or one thing opened IN an allowed app ("the invoice template in Word"), with no second action
  `^(?:the\\s+|my\\s+)?(?:${APP_NAMES})(?:\\s+(?:app|window|browser))?\\s*$|^(?!.*\\b(?:and|then|to|so)\\b)[^,;]{1,80}\\s+(?:in|on|with|using)\\s+(?:the\\s+|my\\s+)?(?:${APP_NAMES})(?:\\s+app)?\\s*$`,
  "i",
);
const PATH_OR_URL = /(?:[A-Za-z]:\\|\\\\|~[\\/])\S+|\bhttps?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|dev|app|au|co|gov|edu|invalid|test|localhost)(?:\.[a-z]{2})?(?:\/\S*)?/i;
/**
 * A plain new tab/window/file, and nothing after it (REVIEW-SAFETY-R3 §6 item 7): "open the tab" passes,
 * "open the TAB app" (the betting app) doesn't.
 */
/** A path or URL and nothing after it but, at most, which app opens it ("open D:\tmp\a.txt in Notepad"). */
const PATH_ONLY = new RegExp(`^(?:the\\s+)?(?:${PATH_OR_URL.source})(?:\\s+in\\s+(?:notepad|excel|word|chrome|edge|firefox|vs ?code|explorer|file explorer))?\\s*$`, "i");
const PLAIN_TARGET = /^(?:a |an |the |this |that |my )?(?:new )?(?:tab|window|folder|file|note|document|text file|browser)(?:\s+(?:in|on|from)\s+(?:my\s+|the\s+)?(?:desktop|downloads|documents|chrome|edge|firefox|browser|notepad|explorer|file explorer))?\s*$/i;

export type ControlPolicyDecision =
  | { permitted: true }
  | { permitted: false; reason: ControlRefusal | "verb-not-allowed" | "app-not-allowed" | "empty" };

/**
 * `extraLeads`: a caller-owned widening of the lead verbs, never of the denylist (away mode adds the
 * reversible file verbs its own Hermes brief allows, e.g. "tidy Downloads"; see away-mode/policy.ts).
 */
export function controlPolicyDecision(task: string, options: { extraLeads?: RegExp } = {}): ControlPolicyDecision {
  const text = typeof task === "string" ? task.trim() : "";
  if (!text) return { permitted: false, reason: "empty" };
  const refusal = controlTaskRefusal(text);
  if (refusal) return { permitted: false, reason: refusal };
  const clauses = splitClauses(text);
  for (const raw of clauses.length ? clauses : [text]) {
    const clause = raw.replace(FILLER, "").trim();
    if (!ALLOWED_LEAD.test(clause) && !options.extraLeads?.test(clause)) return { permitted: false, reason: "verb-not-allowed" };
    const launch = LAUNCH.exec(clause);
    if (launch) {
      const object = launch[1] ?? "";
      if (!ALLOWED_APP_ONLY.test(object.trim()) && !PATH_ONLY.test(object.trim()) && !PLAIN_TARGET.test(object))
        return { permitted: false, reason: "app-not-allowed" };
    }
  }
  return { permitted: true };
}

/** Code-owned deny rules supplement risk tiers. Approval cannot authorise money movement,
 * trading, banking/broker/exchange apps, or secret/private-data extraction through this executor. */
export function controlPolicyPermits(task: string) {
  return controlPolicyDecision(task).permitted;
}
