// Money and action words are never dropped (REVIEW-T1 fix 2). Before the registry claims typed or palette
// words for a page, app or site, it asks: do they order a money move (scripts/jarvis-execution/spoken-money.ts
// moneyOrder over src/lib/money-policy.ts: detection only, nothing is refused), and the shared action-keyword
// gate (needsConfirmation: send, delete, publish, submit, pay …). A compound request ("open Telstra and pay
// the bill", "open notepad and type hello") is never cut down to its first noun either. Any of these → the
// registry stays out and the words go, whole, to the gated turn (typed) or an "Ask Jarvis" row (palette).
// Pure and browser-safe.
import { needsConfirmation } from "../jarvis-control";
import { moneyOrder } from "../../../scripts/jarvis-execution/spoken-money";
import { DESTINATIONS } from "../../components/shell/destinations";
import { WORKSPACE_ENTRIES } from "./registry";

/** Clause joins in his own words ("and", "then", commas); "&" inside a name ("Marden & Rowe") is not one. */
const JOIN = /\s*(?:[,;]+|\b(?:and|then|also|plus|after\s+that|and\s+then)\b)\s+/i;
const LEAD = /^\s*(?:(?:hey|ok|okay)\s+)?(?:jarvis\b[,\s]*)?/i;

export type ActionReason = "money" | "action" | "compound";

const norm = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/&/g, " and ").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
/** Every OS page's own title, normalised ("packages and economics", "ai usage and spend", "share card"). */
const PAGE_TITLES = new Set([
  ...DESTINATIONS.flatMap((d) => [norm(d.label), ...d.drilldowns.map((dd) => norm(dd.label))]),
  ...WORKSPACE_ENTRIES.flatMap((e) => [e.title, ...e.phrases].map(norm)),
  // Words that are also action words ("email") but, straight after "open", name the Inbox page ("open my email").
  "email", "emails", "mail",
]);
const NAV_LEAD = /^(?:(?:can|could|would|will) you\s+|please\s+)?(?:open up|open|launch|go to|take me to|navigate to|jump to|switch to|show me|show|pull up|bring up)\s+(?:the\s+|my\s+|our\s+)?/;
const NAV_TAIL = /\s+(?:page|please|for me|now)$/;

/**
 * "Open Packages and economics", "open Share card", "open AI usage and spend": a navigation verb plus a page's own title and
 * nothing else. The words inside a page's name ("and", "share", "spend") are not a compound or an action (J4, AUDIT-JARVIS #13).
 * Pure.
 */
export function namesWholePage(text: string): boolean {
  let t = norm(String(text ?? "").replace(LEAD, ""));
  t = t.replace(NAV_LEAD, "").replace(NAV_TAIL, "").trim();
  return t.length > 0 && PAGE_TITLES.has(t);
}

/** Why these words must not be claimed as a plain open, or null. Pure. */
export function actsOrPays(text: string): ActionReason | null {
  const t = String(text ?? "").replace(LEAD, "").trim();
  if (!t) return null;
  // A page's own name after a navigation verb is just that page, whatever words its title contains. (Money orders still count.)
  const wholePage = namesWholePage(t);
  if (moneyOrder(t)) return "money";
  if (wholePage) return null;
  if (needsConfirmation(t)) return "action";
  if (t.split(JOIN).filter((c) => c.trim()).length > 1) return "compound";
  return null;
}
