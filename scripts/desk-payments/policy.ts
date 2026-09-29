// Desk payments (owner decision, 29 Sep 2026: "payments shouldn't be refused if I'm at my desk anyway, only away
// mode"). WHO may do WHAT, in pure code:
//
//   - deskVerdict: is this request from the owner AT HIS DESK? Server-verified: a loopback socket with no relay
//     header (the loopback-owner principal), a live signed-in hub session (a human at the OS in a browser here, never a
//     local program holding only the page token), the owner himself, and away mode read OFF. Anything else (a founder
//     on another device, Telegram, the companion, a script, a scheduled or background job, away mode, or an
//     away state that can't be read) is NOT the desk and keeps the strict path, unchanged.
//   - the never lines: what is refused even at the desk, one short line each.
//   - deskOpenVerdict: bank and payment sites may be OPENED at the desk; trading, crypto and betting hosts may not.
//
// Nothing here presses, opens or pays. Pure.
import { decodeHost, ipLike, moneyHostKind, SHORTENER } from "../../src/lib/money-policy";
import type { PaymentNever } from "../../src/lib/money-policy";
import { hasVerifiedUiSession } from "../approvals/principal";
import { isAtHub, type Principal } from "../identity/principal";

export type DeskVerdict = { ok: true } | { ok: false; why: "not-at-pc" | "not-owner" | "no-session" | "away-on" | "away-unknown" | "locked" | "idle" };
/** How long without touching the PC still counts as at the desk (the hub cookie lives 30 days; presence must be more than a cookie). */
export const DEFAULT_IDLE_LIMIT_MS = 30 * 60 * 1000;

/**
 * At his desk = ALL of: the loopback-owner principal (loopback socket, local Host, no relay header), the owner's own
 * person, a verified interactive UI session (the presence signal: he is at the OS in a browser on this PC), and away
 * mode OFF. `awayOn` null (unreadable) is treated as on: fail closed. Mehroz uses his own principal (a companion or
 * his own tailnet login), so this never says yes for him: the OS has no per-person money settings, so payments are the
 * owner's, at his own desk, only.
 */
export function deskVerdict(input: {
  principal: Principal | null;
  awayOn: boolean | null;
  /** Is he at the PC: the screen locked, and how long since he last touched it. Null or unknown parts don't block; a locked or long-idle PC does. */
  presence?: { locked: boolean | null; idleMs: number | null } | null;
  idleLimitMs?: number;
}): DeskVerdict {
  const p = input.principal;
  if (!p || !isAtHub(p)) return { ok: false, why: "not-at-pc" };
  if (p.personId !== "usman") return { ok: false, why: "not-owner" };
  if (!hasVerifiedUiSession(p)) return { ok: false, why: "no-session" };
  if (input.awayOn === null) return { ok: false, why: "away-unknown" };
  if (input.awayOn) return { ok: false, why: "away-on" };
  if (input.presence?.locked === true) return { ok: false, why: "locked" };
  const limit = input.idleLimitMs ?? DEFAULT_IDLE_LIMIT_MS;
  if (typeof input.presence?.idleMs === "number" && input.presence.idleMs > limit) return { ok: false, why: "idle" };
  return { ok: true };
}

/** One short line for a caller who isn't at the desk (only reached when the desk flag was lost between two calls). */
export const NOT_DESK_LINE = "That's a payment, and I only make those with you at the PC. Nothing was done.";

/** What is refused even at the desk. One short line each, no lecture. */
export const NEVER_LINE: Record<Exclude<PaymentNever, "new-payee" | "bank-transfer">, string> = {
  trade: "I don't make trades or investments; that's research only.",
  crypto: "I don't buy, sell or send crypto.",
  betting: "I don't place bets.",
  "card-details": "Type card numbers, codes and passwords yourself; I'll stop at the field.",
};

/** The line for a payment `never` kind; null for the kinds a desk payment allows (a new payee, a transfer to a person). */
export function neverLine(never: PaymentNever): string | null {
  return never === "new-payee" || never === "bank-transfer" ? null : NEVER_LINE[never];
}

const HOSTILE_KINDS = new Set(["broker", "crypto", "gambling"]);
const KIND_LINE: Record<string, string> = { broker: NEVER_LINE.trade, crypto: NEVER_LINE.crypto, gambling: NEVER_LINE.betting };

/**
 * May the hands OPEN this address at his desk? Banks, payment apps, billers and government money services: yes.
 * A broker, exchange or bookie: no, with the never line. A link shortener, a raw IP, a punycode look-alike or a
 * non-web address: no (nobody can read where it goes). Pure.
 */
export function deskOpenVerdict(url: string): { ok: true } | { ok: false; said: string } {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, said: "I only open web pages." };
    if (u.username || u.password) return { ok: false, said: "I won't open an address with a login in it." };
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { ok: false, said: "That isn't a web address I can open." };
  }
  if (SHORTENER.test(host) || ipLike(host) || /^\[/.test(host) || decodeHost(host) !== host)
    return { ok: false, said: "I can't read where that address goes, so I won't open it." };
  const kind = moneyHostKind(host);
  if (kind && HOSTILE_KINDS.has(kind)) return { ok: false, said: KIND_LINE[kind] };
  return { ok: true };
}
