// Desk payments: the pending payments and how one becomes a ConfirmedPress. In memory only: a restart drops every
// pending payment, so nothing on disk can ever confirm anything.
//
// A pending payment is bound to ONE page, ONE control and ONE exact payment (payee, amount, currency, host, the page's
// money lines, the control's signature), lives 2 minutes, and is consumed exactly once by his click on the card or
// his yes (spoken or typed) at the desk. A yes carries a one-time ticket the turn rules mint (the model never can), so
// a made-up "confirm" from a model or a page confirms nothing. Two live payments are never confirmed by one yes.
import { randomBytes } from "node:crypto";
import { mintConfirmed, type ConfirmedPress } from "./confirmed";
import type { DeskRequest } from "./request";
import type { PayControl } from "./page";

export const DESK_CONFIRM_TTL_MS = 2 * 60 * 1000;
export const TICKET_TTL_MS = 60 * 1000;
/** A press that hasn't finished by now is released as UNKNOWN, so one hung browser call can't block payments until a restart. */
export const CONFIRMING_MAX_MS = 60 * 1000;
const MAX_LIVE = 5;
const MAX_RECENT = 8;

export type PendingState = "pending" | "confirming" | "done" | "unknown" | "failed" | "cancelled" | "expired" | "stopped";
export type PaymentSource = "voice" | "typed" | "screen" | "control_pc" | "hands";
export type PendingPayment = {
  id: string;
  createdAt: number;
  expiresAt: number;
  state: PendingState;
  source: PaymentSource;
  request: DeskRequest;
  what: string;
  payee: string;
  amount: string;
  currency: string;
  raw: string;
  host: string;
  url: string;
  title: string;
  button: string;
  last4: string | null;
  bound: { targetId: string; control: PayControl; lines: string[]; digest: string };
  /** The one line that asked him ("Pay A$120 to … on …? Say yes to go."): a yes counts only right after Jarvis said THIS. */
  prompt: string;
  /** The site he named when the page's site differs from it (shown on the card), else null. */
  named: string | null;
  /** A larger or repeating figure the page shows besides today's charge ("Renews at A$499.00/year"), else null. */
  recurring: string | null;
  /** Typed box: the count of his typed commands when this was asked (a newer typed command supersedes it). */
  typedEpoch: number | null;
  /** When the press started: a press that never finishes is released (CONFIRMING_MAX_MS). */
  confirmStartedAt?: number;
  result?: string;
  /** When it finished (paid, stopped, cancelled or timed out). */
  settledAt?: number;
};
export type NewPayment = Omit<PendingPayment, "id" | "createdAt" | "expiresAt" | "state" | "confirmStartedAt">;

/** What the card and the OS may see: never the page's lines, the digest or a ticket. */
export type PublicPayment = { id: string; named: string | null; recurring: string | null; what: string; payee: string; amount: string; currency: string; host: string; button: string; last4: string | null; source: PaymentSource; expiresAt: number; state: PendingState };
export const publicView = (p: PendingPayment): PublicPayment => ({ id: p.id, named: p.named, recurring: p.recurring, what: p.what, payee: p.payee, amount: p.amount, currency: p.currency, host: p.host, button: p.button, last4: p.last4, source: p.source, expiresAt: p.expiresAt, state: p.state });

export type ConsumeResult =
  | { ok: true; pending: PendingPayment; confirmed: ConfirmedPress }
  | { ok: false; why: "missing" | "expired" | "used" | "busy" };

export function createDeskStore(options: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = options.ttlMs ?? DESK_CONFIRM_TTL_MS;
  const clock = options.now ?? Date.now;
  const all = new Map<string, PendingPayment>();
  const tickets = new Map<string, { id: string; how: "spoken-yes" | "typed-yes"; expiresAt: number }>();
  const recent: PendingPayment[] = [];

  const sweep = (now: number) => {
    for (const p of all.values()) {
      if (p.state === "pending" && now >= p.expiresAt) settle(p, "expired", "It timed out, so nothing was paid.");
      else if (p.state === "confirming" && now - (p.confirmStartedAt ?? now) > CONFIRMING_MAX_MS) settle(p, "unknown", `That didn't finish: check ${p.host} before trying again.`);
    }
    for (const [t, v] of tickets) if (now >= v.expiresAt) tickets.delete(t);
  };
  const settle = (p: PendingPayment, state: PendingState, result?: string) => {
    p.state = state;
    p.settledAt = clock();
    if (result !== undefined) p.result = result;
    all.delete(p.id);
    recent.push(p);
    if (recent.length > MAX_RECENT) recent.shift();
  };

  return {
    ttl,
    /** A new pending payment. Beyond MAX_LIVE the oldest live one is cancelled: nothing piles up. */
    create(input: NewPayment, now: number): PendingPayment {
      sweep(now);
      const live = [...all.values()].filter((p) => p.state === "pending");
      while (live.length >= MAX_LIVE) settle(live.shift()!, "cancelled", "Replaced by a newer request.");
      const p: PendingPayment = { ...input, id: `dp_${randomBytes(6).toString("hex")}`, createdAt: now, expiresAt: now + ttl, state: "pending" };
      all.set(p.id, p);
      return p;
    },
    /** The live (waiting, unexpired) payments, oldest first. */
    live(now: number): PendingPayment[] {
      sweep(now);
      return [...all.values()].filter((p) => p.state === "pending").sort((a, b) => a.createdAt - b.createdAt);
    },
    /** A live payment for the same page and payment (a repeated "pay this" must not stack a second card). */
    same(digest: string, now: number): PendingPayment | null {
      return this.live(now).find((p) => p.bound.digest === digest) ?? null;
    },
    get: (id: string) => all.get(id) ?? recent.find((p) => p.id === id) ?? null,
    /** A payment being pressed right now, if any. */
    confirming: () => {
      sweep(clock());
      return [...all.values()].find((p) => p.state === "confirming") ?? null;
    },
    /** The last finished payments, newest last (the card's "Paid" or "Stopped" line). */
    recent: () => recent.slice(),
    /** Cancel one live payment, or all of them; returns how many. */
    cancel(id: string | "all", now: number, reason = "Cancelled: nothing was paid."): number {
      sweep(now);
      let n = 0;
      for (const p of [...all.values()]) if (p.state === "pending" && (id === "all" || p.id === id)) (settle(p, "cancelled", reason), n++);
      return n;
    },
    /**
     * His confirmation: one live payment, once. The ConfirmedPress it returns is the only thing that lets the hands press,
     * for that payment's control. `used`, `expired`, `missing` and a second payment already being pressed all press nothing.
     */
    consume(id: string, how: ConfirmedPress["how"], now: number): ConsumeResult {
      sweep(now);
      const p = all.get(id);
      if (!p) {
        const done = recent.find((x) => x.id === id);
        return { ok: false, why: done ? (done.state === "expired" ? "expired" : "used") : "missing" };
      }
      if (p.state !== "pending") return { ok: false, why: "used" };
      if (now >= p.expiresAt) {
        settle(p, "expired", "It timed out, so nothing was paid.");
        return { ok: false, why: "expired" };
      }
      if (this.confirming()) return { ok: false, why: "busy" };
      p.state = "confirming";
      p.confirmStartedAt = now;
      const c = mintConfirmed(p.id, how, { element: p.bound.control.sig, targetId: p.bound.targetId, url: p.url, host: p.host }, now);
      return { ok: true, pending: p, confirmed: c };
    },
    /** The outcome of a consumed payment (never returns it to "pending"). */
    finish(id: string, state: Exclude<PendingState, "pending" | "confirming">, result: string) {
      const p = all.get(id);
      if (p) settle(p, state, result);
    },
    /** A one-time yes ticket for one live payment: minted by the turn rules when his whole reply was a yes. */
    mintTicket(id: string, how: "spoken-yes" | "typed-yes", now: number): string {
      sweep(now);
      const ticket = randomBytes(16).toString("hex");
      tickets.set(ticket, { id, how, expiresAt: now + TICKET_TTL_MS });
      return ticket;
    },
    /** How he said yes (the verified path the turn recorded), once per ticket, only for its own payment, only while fresh; else null. */
    redeemTicket(ticket: unknown, id: string, now: number): "spoken-yes" | "typed-yes" | null {
      sweep(now);
      if (typeof ticket !== "string") return null;
      const t = tickets.get(ticket);
      if (!t) return null;
      tickets.delete(ticket);
      return t.id === id && now < t.expiresAt ? t.how : null;
    },
    clear() {
      all.clear();
      tickets.clear();
      recent.length = 0;
    },
  };
}
export type DeskStore = ReturnType<typeof createDeskStore>;
