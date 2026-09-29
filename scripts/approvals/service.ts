// The durable Approval service (TARGET-ARCHITECTURE §3.2 with the V7 and V8 amendments).
//
//   request  → refusal list first (policy.ts), then ONE pending record per exact action (asked once)
//   ask      → server-internal (the TTS path): the question goes into the ONE question registry shared
//              with screen, lesson and control (voice-confirmation.ts), superseding any open question
//   card     → a per-approval confirm nonce for a verified interactive UI session (the rendered card)
//   decide   → approve/reject by a verified Principal with evidence the action accepts:
//                spokenYes  a server STT event stamped with THIS approval's question, from the person asked
//                uiConfirm  a verified UI session (B1's session) with the card nonce, never the requester itself
//                awayCode   the away one-time code, only from the owner's Telegram channel, or his OS card
//                           (human session + card nonce) when he made the request himself
//                telegramCode  for requests a PROCESS made (a coding job, Hermes, a script): the one-time
//                           code the owner sends back in his Telegram DM. A UI confirm can't answer those:
//                           any local program can drive the owner's browser (policy.allowedEvidence)
//              Codes: 3 tries per approval, never stored plain, keyed in memory only
//   consume  → atomic one-shot bound to argsDigest; a changed action voids it; expiry refuses
//   outcome  → written once by the job after execution (succeeded / failed / unknown)
//
// Restart (recover, called once by the recovery owner): pending stays pending; approved-but-unconsumed
// stays usable until it expires; nothing consumed is ever replayed, and a consumed approval with no
// outcome becomes `unknown`. Exception, stated plainly: an away code is keyed in memory only (so nothing
// on disk can approve anything), so a still-pending away approval is cancelled at restart and must be
// asked again. Stored in SQLite (WAL) under .operator-data; no prompts, transcripts or codes are stored.
import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { newCode } from "../away-mode/policy";
import { spokenConfirmations, SPOKEN_YES_TTL_MS } from "../jarvis-execution/voice-confirmation";
import { maskLine } from "../screen-hands/run-log";
import { argsDigest as digestArgs } from "./canonical";
import { actionPolicy, allowedEvidence, refuseBeforeRequest, type EvidenceKind, type Refusal, type RequestOrigin } from "./policy";
import { hasVerifiedUiSession, isHuman, isPrincipal, principalRef, publicPrincipal, type PersonId, type Principal } from "./principal";

export type ApprovalState = "pending" | "approved" | "rejected" | "cancelled" | "expired" | "consumed";
export type ApprovalOutcome = "succeeded" | "failed" | "unknown";
export type ApprovalScope = { deviceId?: string; targetUserId?: string; resource?: string; approverPersonId?: PersonId };
export type Approval = {
  id: string;
  state: ApprovalState;
  requester: Principal;
  approver?: Principal;
  action: string;
  scope: ApprovalScope;
  argsDigest: string;
  questionId?: string;
  /** What exactly would happen, in plain (masked) words. */
  summary: string;
  jobId?: string;
  evidence?: EvidenceKind;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  consumedAt?: string;
  outcome?: ApprovalOutcome;
  /** Why it was cancelled/rejected/voided (a code, never free text from a page). */
  reason?: string;
};
export type Evidence =
  | { spokenYes: string; questionId: string }
  | { uiConfirm: true; cardNonce: string }
  | { awayCode: string; cardNonce?: string }
  | { telegramCode: string };
/** The ONE question registry (safety-r3, voice-confirmation.ts SpokenConfirmationLedger). */
export type SpokenLedger = {
  ask(surface: "screen" | "lesson" | "control"): { id: string; at: number };
  redeem(id: unknown, options?: { after?: number; maxAgeMs?: number; question?: string }): { id: string; at: number } | null;
};
/** How long a card's confirm nonce stays usable. */
export const CARD_NONCE_TTL_MS = 10 * 60_000;
export type ApprovalEvent = { type: "approval"; approval: Approval };

/** How long a question the server put stays answerable (matches the control gate's). */
export const QUESTION_TTL_MS = 2 * 60_000;
const MAX_WRONG_CODES = 3;
/**
 * The two code formats (documented in docs/APPROVAL-CODES.md; the payments track relies on the away code):
 *   awayCode      4 characters, letters and digits, at least one digit ("K7PQ"): away mode (away.run,
 *                 away.payment), answered "approve K7PQ" from the owner's Telegram DM or his own OS card.
 *   telegramCode  8 characters from an unambiguous alphabet (no 0/O, 1/I/L, U), written with a dash:
 *                 "K7PQ-M4XZ" (31^8, about 8.5 x 10^11). Any request a PROCESS made (a forget, a coding apply),
 *                 answered "approve K7PQ-M4XZ" from the requester's own Telegram DM.
 * A telegramCode reply that matches nothing is a MISS against the sender (REVIEW-T6 finding 1: 248 wrong
 * codes used to cost nothing): MAX_CODE_MISSES misses within CODE_MISS_WINDOW_MS void every live Telegram
 * code of that person's pending approvals and lock further guesses until the window passes. Each miss also
 * counts against each of those approvals (`wrong`), so a code dies after MAX_WRONG_CODES misses either way.
 */
export const TELEGRAM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TELEGRAM_CODE = /^([2-9A-HJ-NP-TV-Z]{4})-?([2-9A-HJ-NP-TV-Z]{4})$/;
export const MAX_CODE_MISSES = 3;
export const CODE_MISS_WINDOW_MS = 15 * 60_000;
export function newTelegramCode(pick: (n: number) => number = (n) => randomInt(n)): string {
  const c = () => TELEGRAM_CODE_ALPHABET[pick(TELEGRAM_CODE_ALPHABET.length)];
  return `${c()}${c()}${c()}${c()}-${c()}${c()}${c()}${c()}`;
}
/** A typed Telegram code in its canonical form ("k7pq m4xz" and "K7PQM4XZ" both give "K7PQ-M4XZ"), or null. */
export function canonicalTelegramCode(given: string): string | null {
  const m = TELEGRAM_CODE.exec(String(given ?? "").trim().toUpperCase().replace(/\s+/g, "-").replace(/-+/g, "-"));
  return m ? `${m[1]}-${m[2]}` : null;
}
export type CodeClaim =
  | { kind: "match"; approvalId: string; action: string }
  | { kind: "miss"; misses: number; voided: number; /** this miss started a lockout (tell the person) */ lockedNow: boolean; until: number }
  | { kind: "nothing-pending" }
  | { kind: "locked"; until: number }
  | { kind: "not-a-code" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type Row = {
  id: string; state: ApprovalState; action: string; scope: string; args_digest: string; requester: string; approver: string | null;
  summary: string; job_id: string | null; question_id: string | null; evidence: string | null; created_at: number; expires_at: number;
  decided_at: number | null; consumed_at: number | null; outcome: string | null; reason: string | null; code_hash: string | null; wrong: number;
};
type QuestionRow = { id: string; approval_id: string; asked_at: number; expires_at: number; spent: number; person_id: string | null; device_id: string | null };

const iso = (ms: number | null) => (ms === null ? undefined : new Date(ms).toISOString());
function toApproval(r: Row): Approval {
  return {
    id: r.id,
    state: r.state,
    requester: publicPrincipal(JSON.parse(r.requester)),
    ...(r.approver ? { approver: publicPrincipal(JSON.parse(r.approver)) } : {}),
    action: r.action,
    scope: JSON.parse(r.scope),
    argsDigest: r.args_digest,
    ...(r.question_id ? { questionId: r.question_id } : {}),
    summary: r.summary,
    ...(r.job_id ? { jobId: r.job_id } : {}),
    ...(r.evidence ? { evidence: r.evidence as EvidenceKind } : {}),
    createdAt: iso(r.created_at)!,
    expiresAt: iso(r.expires_at)!,
    ...(r.decided_at !== null ? { decidedAt: iso(r.decided_at) } : {}),
    ...(r.consumed_at !== null ? { consumedAt: iso(r.consumed_at) } : {}),
    ...(r.outcome ? { outcome: r.outcome as ApprovalOutcome } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

export type RequestInput = {
  action: string;
  /** The exact action arguments. Only their digest is stored. */
  args: unknown;
  requester: Principal;
  /** Plain words shown to the approver ("Merge coding/x @ 9c1e2ab into main of mu-receptionist"). */
  summary: string;
  origin: RequestOrigin;
  scope?: ApprovalScope;
  jobId?: string;
  ttlMs?: number;
};
export type RequestResult =
  | {
      ok: true;
      approval: Approval;
      reused: boolean;
      /** Away actions: sent to the owner's Telegram once; never stored. */
      awayCode?: string;
      /** Process-requested actions: sent to the owner's Telegram DM once; never stored. */
      telegramCode?: string;
    }
  | { ok: false; refusal: Refusal };
export type DecideResult = { ok: true; approval: Approval } | { ok: false; code: string; reason: string; approval?: Approval };
export type ConsumeResult =
  | { ok: true; approval: Approval }
  | { ok: false; code: "unknown" | "not-approved" | "expired" | "consumed" | "digest-mismatch"; approval?: Approval };

export type ApprovalServiceOptions = {
  path: string;
  now?: () => number;
  spoken?: SpokenLedger;
  /** Away-code generator (tests inject a fixed one). */
  code?: () => string;
  /** Telegram-code generator for a process's requests (tests inject a fixed one); default newTelegramCode. */
  telegramCode?: () => string;
  /** Open an existing store without writing (a quiet second server). */
  readOnly?: boolean;
};

export class ApprovalService {
  private db: Database;
  private now: () => number;
  private spoken: SpokenLedger;
  private code: () => string;
  private telegramCode: () => string;
  /** The away-code HMAC key: memory only, so a code can never be checked from disk after a restart. */
  private codeKey = randomBytes(32);
  /** Card confirm nonces (memory only; a restart just needs the card rendered again). */
  private cards = new Map<string, { approvalId: string; sessionId: string; personId: string; expires: number }>();
  private listeners = new Set<(event: ApprovalEvent) => void>();
  readonly readOnly: boolean;

  constructor(options: ApprovalServiceOptions) {
    this.now = options.now ?? Date.now;
    this.spoken = options.spoken ?? spokenConfirmations;
    this.code = options.code ?? (() => newCode());
    this.telegramCode = options.telegramCode ?? (() => newTelegramCode());
    this.readOnly = options.readOnly === true;
    if (!this.readOnly) mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path, this.readOnly ? { readonly: true } : { create: true });
    this.db.exec("PRAGMA busy_timeout=3000;");
    if (this.readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, action TEXT NOT NULL, scope TEXT NOT NULL, args_digest TEXT NOT NULL,
        requester TEXT NOT NULL, approver TEXT, summary TEXT NOT NULL, job_id TEXT, question_id TEXT, evidence TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, consumed_at INTEGER,
        outcome TEXT, reason TEXT, code_hash TEXT, wrong INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS approvals_state ON approvals(state, expires_at);
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, asked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0,
        person_id TEXT, device_id TEXT);
      CREATE TABLE IF NOT EXISTS code_misses (person_id TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS code_misses_person ON code_misses(person_id, at);`);
  }

  close() {
    this.db.close();
  }
  subscribe(listener: (event: ApprovalEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private emit(id: string) {
    const approval = this.get(id);
    if (!approval) return;
    for (const l of this.listeners) {
      try {
        l({ type: "approval", approval });
      } catch {
        /* a listener never breaks an approval */
      }
    }
  }
  private writable() {
    if (this.readOnly) throw new Error("The approvals store is open read-only here");
  }
  private row(id: string): Row | null {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    return this.db.query("SELECT * FROM approvals WHERE id=?").get(id) as Row | null;
  }
  private hashCode(id: string, code: string) {
    const c = canonicalTelegramCode(code) ?? code.trim().toUpperCase();
    return createHmac("sha256", this.codeKey).update(`${id}:${c}`).digest("hex");
  }

  /** Pending/approved records past their expiry become `expired`. */
  sweep(): number {
    if (this.readOnly) return 0;
    const now = this.now();
    const due = this.db.query("SELECT id FROM approvals WHERE state IN ('pending','approved') AND expires_at<=?").all(now) as { id: string }[];
    if (!due.length) return 0;
    this.db.query("UPDATE approvals SET state='expired', code_hash=NULL WHERE state IN ('pending','approved') AND expires_at<=?").run(now);
    for (const { id } of due) this.emit(id);
    return due.length;
  }

  get(id: string): Approval | null {
    const r = this.row(id);
    return r ? toApproval(r) : null;
  }
  list(filter: { state?: ApprovalState; jobId?: string; limit?: number } = {}): Approval[] {
    this.sweep();
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 200);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.state) (where.push("state=?"), params.push(filter.state));
    if (filter.jobId) (where.push("job_id=?"), params.push(filter.jobId));
    const sql = `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    return (this.db.query(sql).all(...params, limit) as Row[]).map(toApproval);
  }

  /** The refusal list runs first; nothing is written for a refused request. */
  request(input: RequestInput): RequestResult {
    this.writable();
    const refusal = refuseBeforeRequest({ action: input.action, args: input.args, origin: input.origin });
    if (refusal) return { ok: false, refusal };
    if (!isPrincipal(input.requester)) return { ok: false, refusal: { code: "unknown-action", reason: "A verified requester is required." } };
    const policy = actionPolicy(input.action)!;
    const digest = digestArgs(input.action, input.args);
    const scope: ApprovalScope = { ...(input.scope ?? {}) };
    // V8: an away payment is answered only by the person whose away session asked for it.
    if (input.action === "away.payment") scope.approverPersonId = input.requester.personId;
    const ttl = Math.min(Math.max(1_000, Math.floor(input.ttlMs ?? policy.maxTtlMs)), policy.maxTtlMs);
    const kinds = allowedEvidence(input.action, isHuman(input.requester));
    const codeField = kinds.includes("awayCode") ? "awayCode" : kinds.includes("telegramCode") ? "telegramCode" : null;
    const needsCode = codeField !== null;
    this.sweep();
    const now = this.now();
    // Asked ONCE: the same person asking for the same exact action gets the same live record. The actor is
    // part of the key (Track 6): a person's own request is never merged into a program's (which only a
    // spoken yes or the Telegram code can answer), and a program's never into a person's (which a click can).
    const same = this.db
      .query(
        "SELECT * FROM approvals WHERE action=? AND args_digest=? AND json_extract(requester,'$.personId')=? AND json_extract(requester,'$.actor')=? AND state IN ('pending','approved') AND expires_at>? ORDER BY created_at DESC LIMIT 1",
      )
      .get(input.action, digest, input.requester.personId, isHuman(input.requester) ? "human" : "process", now) as Row | null;
    if (same) {
      if (same.state === "pending" && needsCode) {
        const code = codeField === "telegramCode" ? this.telegramCode() : this.code();
        // A new code, but the three tries are per approval, not per code.
        this.db.query("UPDATE approvals SET code_hash=? WHERE id=? AND state='pending'").run(this.hashCode(same.id, code), same.id);
        return { ok: true, approval: toApproval(same), reused: true, [codeField!]: code };
      }
      return { ok: true, approval: toApproval(same), reused: true };
    }
    const id = randomUUID();
    const code = needsCode ? (codeField === "telegramCode" ? this.telegramCode() : this.code()) : undefined;
    this.db
      .query(`INSERT INTO approvals (id, state, action, scope, args_digest, requester, summary, job_id, created_at, expires_at, code_hash)
        VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.action, JSON.stringify(scope), digest, JSON.stringify(principalRef(input.requester)), maskLine(input.summary, 300) || input.action,
        input.jobId ?? null, now, now + ttl, code ? this.hashCode(id, code) : null);
    this.emit(id);
    return { ok: true, approval: this.get(id)!, reused: false, ...(code ? { [codeField!]: code } : {}) };
  }

  /**
   * Server-internal (the TTS path, never an HTTP route): Jarvis is putting this approval's question to
   * `to` now. The question goes into the ONE registry shared with screen, lesson and control, so it
   * supersedes any open question on any surface, and only a yes heard while it is open (and stamped with
   * it) can answer it. The yes must also come from the person, and device, it was put to.
   */
  ask(id: string, to: Principal): { questionId: string; askedAt: number; expiresAt: number } {
    this.writable();
    this.sweep();
    const r = this.row(id);
    if (!r || r.state !== "pending") throw new Error("Only a pending approval can be asked");
    if (!actionPolicy(r.action)?.evidence.includes("spokenYes")) throw new Error("This approval isn't answered by voice");
    if (!isPrincipal(to)) throw new Error("A question is put to a verified person");
    const now = this.now();
    // The shared registry's surface type predates approvals; the surface is a label only.
    const { id: questionId } = (this.spoken.ask as (surface: string) => { id: string; at: number }).call(this.spoken, "approval");
    this.db.transaction(() => {
      this.db.query("UPDATE questions SET spent=1 WHERE spent=0").run();
      this.db.query("INSERT INTO questions (id, approval_id, asked_at, expires_at, spent, person_id, device_id) VALUES (?, ?, ?, ?, 0, ?, ?)")
        .run(questionId, id, now, now + QUESTION_TTL_MS, to.personId, to.deviceId ?? null);
      this.db.query("UPDATE approvals SET question_id=? WHERE id=?").run(questionId, id);
    })();
    this.emit(id);
    return { questionId, askedAt: now, expiresAt: now + QUESTION_TTL_MS };
  }

  /**
   * The approval card was rendered in a verified interactive UI session (B1's session, not the file
   * token): a single-use nonce bound to this approval and this session. A click on the card sends it back.
   * A local process holding only the page token has no UI session, so it can't get one.
   */
  card(id: string, viewer: Principal): { cardNonce: string; expiresAt: number } | null {
    this.sweep();
    const r = this.row(id);
    if (!r || r.state !== "pending" || !isPrincipal(viewer) || !hasVerifiedUiSession(viewer)) return null;
    const now = this.now();
    for (const [k, c] of this.cards) if (c.expires <= now) this.cards.delete(k);
    if (this.cards.size >= 1024) return null;
    const nonce = randomUUID();
    this.cards.set(sha256Hex(nonce), { approvalId: id, sessionId: viewer.sessionId!, personId: viewer.personId, expires: now + CARD_NONCE_TTL_MS });
    return { cardNonce: nonce, expiresAt: now + CARD_NONCE_TTL_MS };
  }
  /** One-shot check of a card nonce for this approval and this exact session. */
  private redeemCard(id: string, approver: Principal, nonce: unknown): boolean {
    if (typeof nonce !== "string" || !UUID.test(nonce) || !hasVerifiedUiSession(approver)) return false;
    const key = sha256Hex(nonce);
    const c = this.cards.get(key);
    if (!c) return false;
    this.cards.delete(key);
    return c.approvalId === id && c.sessionId === approver.sessionId && c.personId === approver.personId && c.expires > this.now();
  }

  decide(id: string, approver: Principal, decision: "approve" | "reject", evidence?: Evidence): DecideResult {
    this.writable();
    this.sweep();
    const r = this.row(id);
    if (!r) return { ok: false, code: "unknown", reason: "No such approval." };
    const current = toApproval(r);
    if (r.state !== "pending") return { ok: false, code: r.state, reason: `That approval is ${r.state}.`, approval: current };
    // The approver is a Principal from the server's resolver; screen text or a body never is one.
    if (!isPrincipal(approver)) return { ok: false, code: "unverified", reason: "A verified person must decide.", approval: current };
    const scope = JSON.parse(r.scope) as ApprovalScope;
    if (scope.approverPersonId && scope.approverPersonId !== approver.personId)
      return { ok: false, code: "wrong-approver", reason: "Only the person this is for can decide it.", approval: current };
    const now = this.now();
    if (decision === "reject") {
      // AUDIT-A1-7: a program can't void a decision a person is waiting on.
      if (!mayWithdraw(current, approver))
        return { ok: false, code: "wrong-approver", reason: "Only a person, or whoever asked for it, can turn this down.", approval: current };
      const changed = this.db.query("UPDATE approvals SET state='rejected', approver=?, decided_at=?, reason='rejected', code_hash=NULL WHERE id=? AND state='pending'")
        .run(JSON.stringify(principalRef(approver)), now, id).changes;
      if (changed !== 1) return { ok: false, code: "race", reason: "It changed while deciding.", approval: this.get(id)! };
      this.emit(id);
      return { ok: true, approval: this.get(id)! };
    }
    if (decision !== "approve") return { ok: false, code: "bad-decision", reason: "Approve or reject.", approval: current };
    const policy = actionPolicy(r.action);
    if (!policy) return { ok: false, code: "unknown-action", reason: "That action isn't approvable.", approval: current };
    const kind = evidenceKind(evidence);
    const accepted = allowedEvidence(r.action, isHuman(current.requester));
    if (!kind || !accepted.includes(kind))
      return { ok: false, code: "evidence-required", reason: evidenceHint(accepted), approval: current };

    if (kind === "awayCode" || kind === "telegramCode") {
      // V8 / the process rule: the code counts from the owner's verified Telegram DM. The away code may also
      // be typed on his OS card (human session + card nonce), but only for a request he made himself.
      const card = (evidence as { cardNonce?: unknown }).cardNonce;
      const telegram = approver.via === "telegram-owner" && approver.actor !== "process";
      const channelOk = telegram || (kind === "awayCode" && isHuman(current.requester) && card !== undefined && this.redeemCard(id, approver, card));
      if (!channelOk || approver.personId !== current.requester.personId)
        return { ok: false, code: "wrong-channel", reason: "Only the owner's Telegram DM (or his own OS card, for a request he made) can answer with the code.", approval: current };
      const given = String((evidence as { awayCode?: string; telegramCode?: string })[kind] ?? "");
      const want = r.code_hash;
      const wellFormed = kind === "telegramCode" ? canonicalTelegramCode(given) !== null : /^[A-Za-z0-9]{4}$/.test(given.trim());
      const got = wellFormed ? this.hashCode(id, given) : "";
      const match = !!want && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
      if (!match) {
        const wrong = r.wrong + 1;
        if (wrong >= MAX_WRONG_CODES || !want) {
          this.db.query("UPDATE approvals SET state='rejected', wrong=wrong+1, decided_at=?, reason=?, code_hash=NULL WHERE id=? AND state='pending'")
            .run(now, want ? "three-wrong-codes" : "code-unavailable", id);
          this.emit(id);
          return { ok: false, code: "rejected", reason: want ? "Three wrong codes: not approved. Nothing was done." : "That code can't be checked any more. Ask again.", approval: this.get(id)! };
        }
        this.db.query("UPDATE approvals SET wrong=wrong+1 WHERE id=? AND state='pending'").run(id);
        return { ok: false, code: "wrong-code", reason: `That code doesn't match (${wrong}/${MAX_WRONG_CODES}). Nothing was done.`, approval: this.get(id)! };
      }
    } else if (kind === "uiConfirm") {
      if (!hasVerifiedUiSession(approver))
        return { ok: false, code: "unverified-session", reason: "A UI yes counts only from a verified signed-in session.", approval: current };
      // (A process's request never gets here: allowedEvidence drops uiConfirm for it. A person may confirm,
      // in the same session, the request they made there themselves.)
      if (!this.redeemCard(id, approver, (evidence as { cardNonce?: unknown }).cardNonce))
        return { ok: false, code: "no-card", reason: "Confirm on the approval card shown in your session.", approval: current };
    } else {
      const { spokenYes, questionId } = evidence as { spokenYes: string; questionId: string };
      const q = (typeof questionId === "string" && UUID.test(questionId)
        ? this.db.query("SELECT * FROM questions WHERE id=?").get(questionId)
        : null) as QuestionRow | null;
      if (!q || q.approval_id !== id || q.spent || now >= q.expires_at || r.question_id !== q.id)
        return { ok: false, code: "no-question", reason: "A spoken yes answers only the question just asked for this exact action.", approval: current };
      if (q.person_id !== approver.personId || (q.device_id && q.device_id !== approver.deviceId))
        return { ok: false, code: "not-asked", reason: "Only the person (and device) the question was put to can answer it.", approval: current };
      // A typed yes has no server STT event, and a yes heard while another question was open (any surface)
      // isn't stamped with this one, so neither passes here.
      const yes = this.spoken.redeem(spokenYes, { after: q.asked_at, maxAgeMs: SPOKEN_YES_TTL_MS, question: q.id });
      if (!yes) return { ok: false, code: "no-spoken-yes", reason: "A fresh spoken yes, said after the question, is required.", approval: current };
      this.db.query("UPDATE questions SET spent=1 WHERE id=?").run(q.id);
    }
    const changed = this.db
      .query("UPDATE approvals SET state='approved', approver=?, evidence=?, decided_at=?, code_hash=NULL WHERE id=? AND state='pending' AND expires_at>?")
      .run(JSON.stringify(principalRef(approver)), kind, now, id, now).changes;
    if (changed !== 1) return { ok: false, code: "race", reason: "It changed or expired while deciding.", approval: this.get(id) ?? current };
    this.emit(id);
    return { ok: true, approval: this.get(id)! };
  }

  /**
   * Atomic one-shot, immediately before the action runs. The digest must be the digest of the action
   * about to run (re-derived from the live page/sha, not copied from the approval). A different digest
   * means the action changed: the approval is voided and a fresh one is needed.
   */
  consume(id: string, argsDigest: string, options: { jobId?: string } = {}): ConsumeResult {
    this.writable();
    this.sweep();
    const now = this.now();
    const changed = this.db
      .query("UPDATE approvals SET state='consumed', consumed_at=?, job_id=COALESCE(job_id, ?) WHERE id=? AND state='approved' AND args_digest=? AND expires_at>?")
      .run(now, options.jobId ?? null, typeof id === "string" ? id : "", String(argsDigest), now).changes;
    const r = this.row(id);
    if (changed === 1 && r) {
      this.emit(id);
      return { ok: true, approval: toApproval(r) };
    }
    if (!r) return { ok: false, code: "unknown" };
    if (r.state === "consumed") return { ok: false, code: "consumed", approval: toApproval(r) };
    if (r.state === "expired" || (r.state === "approved" && r.expires_at <= now)) return { ok: false, code: "expired", approval: toApproval(r) };
    if (r.state === "approved" && r.args_digest !== argsDigest) {
      this.db.query("UPDATE approvals SET state='cancelled', reason='args-changed' WHERE id=? AND state='approved'").run(id);
      this.emit(id);
      return { ok: false, code: "digest-mismatch", approval: this.get(id)! };
    }
    return { ok: false, code: "not-approved", approval: toApproval(r) };
  }

  /**
   * A Telegram code reply from a person's own DM ("approve K7PQ-M4XZ" arrives without an approval id): which
   * of THEIR pending approvals it belongs to, compared in constant time. A code that matches none of them is
   * a MISS (REVIEW-T6 finding 1): it counts against the sender, and against each of their pending code
   * approvals; after MAX_CODE_MISSES in the window every such code is voided (a spoken yes still works, and
   * asking again sends a fresh code) and further guesses are refused until the window passes.
   */
  claimCode(code: string, requesterPersonId: PersonId): CodeClaim {
    this.writable();
    this.sweep();
    const given = canonicalTelegramCode(code);
    if (!given) return { kind: "not-a-code" };
    const now = this.now();
    const since = now - CODE_MISS_WINDOW_MS;
    this.db.query("DELETE FROM code_misses WHERE at<?").run(since);
    const misses = (this.db.query("SELECT COUNT(*) AS n FROM code_misses WHERE person_id=? AND at>=?").get(requesterPersonId, since) as { n: number }).n;
    if (misses >= MAX_CODE_MISSES) {
      const first = (this.db.query("SELECT MIN(at) AS t FROM code_misses WHERE person_id=? AND at>=?").get(requesterPersonId, since) as { t: number }).t;
      return { kind: "locked", until: first + CODE_MISS_WINDOW_MS };
    }
    const rows = this.db
      .query("SELECT id, action, code_hash FROM approvals WHERE state='pending' AND code_hash IS NOT NULL AND expires_at>? AND json_extract(requester,'$.personId')=?")
      .all(now, requesterPersonId) as { id: string; action: string; code_hash: string }[];
    // Nothing of theirs is waiting for a code: a code can't be a guess at anything, so it isn't a miss. That
    // stops a relay-token holder pre-tripping the owner's lockout while nothing is pending (REVIEW-T6 R2).
    if (!rows.length) return { kind: "nothing-pending" };
    for (const r of rows) {
      const got = this.hashCode(r.id, given);
      if (got.length === r.code_hash.length && timingSafeEqual(Buffer.from(got), Buffer.from(r.code_hash))) return { kind: "match", approvalId: r.id, action: r.action };
    }
    let voided = 0;
    const lockout = misses + 1 >= MAX_CODE_MISSES;
    this.db.transaction(() => {
      this.db.query("INSERT INTO code_misses (person_id, at) VALUES (?, ?)").run(requesterPersonId, now);
      for (const r of rows) this.db.query("UPDATE approvals SET wrong=wrong+1 WHERE id=? AND state='pending'").run(r.id);
      voided = this.db
        .query(
          `UPDATE approvals SET code_hash=NULL WHERE state='pending' AND code_hash IS NOT NULL AND json_extract(requester,'$.personId')=? AND (wrong>=? OR ?)`,
        )
        .run(requesterPersonId, MAX_WRONG_CODES, lockout ? 1 : 0).changes;
    })();
    const first = (this.db.query("SELECT MIN(at) AS t FROM code_misses WHERE person_id=? AND at>=?").get(requesterPersonId, since) as { t: number }).t;
    return { kind: "miss", misses: misses + 1, voided, lockedNow: lockout, until: first + CODE_MISS_WINDOW_MS };
  }

  /** People whose Telegram codes are paused right now (3 misses in the window): for the Memory page. */
  codeLockouts(): { personId: string; misses: number; until: string }[] {
    const now = this.now();
    const since = now - CODE_MISS_WINDOW_MS;
    const rows = this.db.query("SELECT person_id, COUNT(*) AS n, MIN(at) AS first FROM code_misses WHERE at>=? GROUP BY person_id").all(since) as { person_id: string; n: number; first: number }[];
    return rows.filter((r) => r.n >= MAX_CODE_MISSES).map((r) => ({ personId: r.person_id, misses: r.n, until: new Date(r.first + CODE_MISS_WINDOW_MS).toISOString() }));
  }

  /** Compatibility: the approval a code belongs to among `actions`, or null (a miss is counted as in claimCode). */
  matchCode(code: string, filter: { actions: readonly string[]; requesterPersonId: PersonId }): string | null {
    const c = this.claimCode(code, filter.requesterPersonId);
    return c.kind === "match" && filter.actions.includes(c.action) ? c.approvalId : null;
  }

  /**
   * Withdraw a pending or approved (unused) approval. Server modules call it bare; the HTTP route passes
   * the caller, who must be a person or the principal that asked for it (AUDIT-A1-7).
   */
  cancel(id: string, reason = "cancelled", by?: Principal): boolean {
    this.writable();
    if (by !== undefined) {
      const current = this.get(id);
      if (!current || !isPrincipal(by) || !mayWithdraw(current, by)) return false;
    }
    const changed = this.db.query("UPDATE approvals SET state='cancelled', reason=?, code_hash=NULL WHERE id=? AND state IN ('pending','approved')")
      .run(reason.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "cancelled", id).changes;
    if (changed) this.emit(id);
    return changed === 1;
  }

  /** Written once, by the job, after the consumed action ran. */
  recordOutcome(id: string, outcome: ApprovalOutcome): boolean {
    this.writable();
    if (!["succeeded", "failed", "unknown"].includes(outcome)) return false;
    const changed = this.db.query("UPDATE approvals SET outcome=? WHERE id=? AND state='consumed' AND outcome IS NULL").run(outcome, id).changes;
    if (changed) this.emit(id);
    return changed === 1;
  }

  /** Once, by the single recovery owner at startup. Never replays and never consumes anything. */
  recover(): { unknownOutcomes: number; awayCodesDropped: number; expired: number } {
    this.writable();
    const expired = this.sweep();
    const awayActions = ["away.run", "away.payment"];
    let unknownOutcomes = 0, awayCodesDropped = 0;
    this.db.transaction(() => {
      unknownOutcomes = this.db.query("UPDATE approvals SET outcome='unknown' WHERE state='consumed' AND outcome IS NULL").run().changes;
      awayCodesDropped = this.db
        .query(`UPDATE approvals SET state='cancelled', reason='restart-code-lost', code_hash=NULL WHERE state='pending' AND action IN (${awayActions.map(() => "?").join(",")})`)
        .run(...awayActions).changes;
      // A Telegram code for another action dies with its key too; a spoken yes can still answer it, and
      // asking again issues a fresh code.
      this.db.query("UPDATE approvals SET code_hash=NULL WHERE state='pending' AND code_hash IS NOT NULL").run();
      this.db.query("UPDATE questions SET spent=1 WHERE spent=0").run();
    })();
    return { unknownOutcomes, awayCodesDropped, expired };
  }
}

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
/**
 * Who may reject or cancel: a person acting now (a human session, their own Telegram DM), or the very
 * principal that asked (same person, channel, actor and device), so a job can withdraw its own request.
 * A program never voids a person's pending approval (AUDIT-A1-7).
 */
export function mayWithdraw(approval: Approval, by: Principal): boolean {
  // The owner's verified Telegram DM counts as the person, as it does for the code (decide above).
  if (isHuman(by) || (by.via === "telegram-owner" && by.actor !== "process")) return true;
  const r = approval.requester;
  return !isHuman(r) && r.personId === by.personId && r.via === by.via && (r.deviceId ?? null) === (by.deviceId ?? null);
}
function evidenceKind(evidence: unknown): EvidenceKind | null {
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as Record<string, unknown>;
  if (typeof e.awayCode === "string") return "awayCode";
  if (typeof e.telegramCode === "string") return "telegramCode";
  if (e.uiConfirm === true) return "uiConfirm";
  if (typeof e.spokenYes === "string" && typeof e.questionId === "string") return "spokenYes";
  return null;
}
function evidenceHint(kinds: readonly EvidenceKind[]) {
  if (kinds.length === 1 && kinds[0] === "awayCode") return "This needs the away one-time code from the owner's verified channel.";
  if (!kinds.includes("uiConfirm") && kinds.includes("telegramCode"))
    return "A program asked for this, so it needs your spoken yes to the question, or the code sent to your Telegram DM; a click can't answer it.";
  if (kinds.length === 1 && kinds[0] === "spokenYes") return "This needs a spoken yes to the question just asked.";
  return "This needs a spoken yes to the question just asked, or a confirm in a verified session.";
}

export { digestArgs as argsDigest };
