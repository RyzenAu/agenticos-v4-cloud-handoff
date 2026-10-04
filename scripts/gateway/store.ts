/**
 * Dot gateway state under MU_DATA_DIR/gateway. Two files, ONE writer each, so the CLI and the running gateway can never
 * overwrite each other's changes:
 *
 *   control.json   written only by the founder CLI (scripts/gateway/cli.ts): enrolment codes (hashed), capability
 *                  grants (always with an expiry), session revocations. The gateway re-reads it when it changes.
 *   sessions.json  written only by the gateway: sessions (hashed cookie values), used enrolment codes, lockout state.
 *   KILL           presence = refuse everything.
 *
 * No cookie value, enrolment code or key is ever stored: only SHA-256 hashes of the first two, and the key lives in its own
 * protected file (secret.ts).
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, LIMITS, RECONNECT_KEY_PREFIX } from "./config";
import { BASE_CAPABILITIES, GRANTABLE, isCapability, type Capability } from "./policy";

export type CodeRow = { id: string; hash: string; by: string; createdAt: number; expiresAt: number; idleMinutes: number; sessionMinutes: number; /** How long the identity this code creates lasts (its reconnect key). */ identityDays?: number; /** A founder's name for this identity, shown in Devices and people. */ label?: string };
export type GrantRow = { capability: Capability; by: string; at: number; expiresAt: number };
export type Control = {
  version: 1;
  codes: CodeRow[];
  grants: GrantRow[];
  revokedSessions: Record<string, number>;
  /** Every session created at or before this moment is revoked. */
  revokeAllBefore: number;
  /** Clears an enrolment lockout that started before this moment. */
  unlockAt: number;
  /** Dot's identities a founder revoked (public id -> when). Every session of a revoked identity is refused at once. */
  revokedIdentities: Record<string, number>;
  /** Mailboxes a founder authorised for the gateway (mail.read, mail.draft). None by default. */
  mailboxes?: MailboxGrant[];
  /** A founder's renewal of an identity (public id -> its new expiry, ms). The gateway honours the later of this and the original. */
  identityExtensions?: Record<string, number>;
};
export type MailboxGrant = { address: string; by: string; at: number };
/**
 * Dot's identity: what an enrolment code turns into. It holds no access by itself; its reconnect key (stored only as a hash)
 * lets Dot ask for a new short-lived access session, in a new task or after the last one expired, until the identity
 * expires or a founder revokes it. Written only by the gateway process.
 */
export type IdentityRow = {
  id: string;
  keyHash: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  enrolledBy: string;
  codeId: string;
  /** The access limits every session of this identity gets (from the code). */
  idleMs: number;
  sessionMs: number;
  lastRenewedAt?: number;
  renewals: number;
};
export type AccessMode = "cookie" | "bearer";
export type SessionRow = {
  id: string;
  tokenHash: string;
  prevTokenHash?: string;
  prevValidUntil?: number;
  createdAt: number;
  lastSeenAt: number;
  idleMs: number;
  expiresAt: number;
  enrolledBy: string;
  codeId: string;
  /** The capability set this cookie value was issued for; a change rotates the cookie. */
  caps: Capability[];
  /** The identity this access belongs to (absent on a session made before identities existed). */
  identityId?: string;
  /** How the access token is presented: the browser cookie (default), or an Authorization bearer for Dot's own programs. Never both. */
  mode?: AccessMode;
  endedAt?: number;
  endReason?: "logout" | "expired" | "idle" | "revoked";
};
export type Sessions = { version: 1; sessions: SessionRow[]; usedCodes: Record<string, number>; enrol: { failures: number[]; lockedUntil: number }; burnedCodes?: Record<string, number>; identities?: IdentityRow[] };

const sha = (label: string, value: string) => createHash("sha256").update(`${label}|${value}`).digest("hex");
export const hashToken = (token: string) => sha("mu-gw-session", token);
/** Codes are compared after removing separators and case, so "abcd-efgh" and "ABCDEFGH" are the same code. */
export const normaliseCode = (code: string) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashCode = (code: string) => sha("mu-gw-code", normaliseCode(code));
export const hashReconnectKey = (key: string) => sha("mu-gw-reconnect", key);
const RECONNECT_KEY = new RegExp(`^${RECONNECT_KEY_PREFIX}[A-Za-z0-9_-]{43}$`);

const emptyControl = (): Control => ({ version: 1, codes: [], grants: [], revokedSessions: {}, revokeAllBefore: 0, unlockAt: 0, revokedIdentities: {} });
const emptySessions = (): Sessions => ({ version: 1, sessions: [], usedCodes: {}, enrol: { failures: [], lockedUntil: 0 } });

function readJson<T>(file: string, fallback: () => T): T {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as T;
    return value && typeof value === "object" ? { ...fallback(), ...value } : fallback();
  } catch {
    return fallback();
  }
}

/** Write a temp file beside the target and rename it into place (retrying while a reader holds the old one on Windows). */
export function writeJsonAtomic(file: string, value: unknown) {
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 1));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      if (attempt >= 20) {
        rmSync(temp, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
}

const stampOf = (file: string) => {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
};

// ── kill switch ──────────────────────────────────────────────────────────────────────────────────────────────────

export const killPath = (dir: string) => join(dir, FILES.kill);
export const isKilled = (dir: string) => existsSync(killPath(dir));
export function setKilled(dir: string, on: boolean, note = "") {
  mkdirSync(dir, { recursive: true });
  if (on) writeFileSync(killPath(dir), `${new Date().toISOString()} ${note.replace(/[^\w .,:-]/g, "").slice(0, 120)}\n`);
  else rmSync(killPath(dir), { force: true });
}

// ── control (the founder CLI's file) ─────────────────────────────────────────────────────────────────────────────

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U

/** 20 characters from a 30-letter alphabet: about 98 bits. Shown once at the console, stored only as a hash. */
export function newCode(): string {
  let out = "";
  for (let i = 0; i < 20; i++) out += ALPHABET[randomInt(ALPHABET.length)] + (i % 5 === 4 && i < 19 ? "-" : "");
  return out;
}

export class ControlFile {
  readonly file: string;
  private cached: Control = emptyControl();
  private stamp = "?";
  constructor(readonly dir: string) {
    this.file = join(dir, FILES.control);
  }
  /** The current control state, re-read only when the file changed. */
  read(): Control {
    const stamp = stampOf(this.file);
    if (stamp !== this.stamp) {
      this.cached = readJson(this.file, emptyControl);
      this.stamp = stamp;
    }
    return this.cached;
  }
  private update(change: (c: Control) => void) {
    mkdirSync(this.dir, { recursive: true });
    const c = readJson(this.file, emptyControl);
    change(c);
    const now = Date.now();
    // Housekeeping: expired codes and grants are dropped a day after they lapse.
    c.codes = c.codes.filter((r) => r.expiresAt > now - 86_400_000);
    c.grants = c.grants.filter((g) => g.expiresAt > now - 86_400_000);
    writeJsonAtomic(this.file, c);
    this.stamp = "?";
  }

  mintCode(input: { by: string; minutes?: number; idleMinutes?: number; sessionHours?: number; sessionMinutes?: number; identityDays?: number; label?: string; now?: number }): { code: string; id: string; expiresAt: number } {
    const now = input.now ?? Date.now();
    const minutes = clamp(input.minutes ?? LIMITS.codeMinutesDefault, SHORTEST_MINUTES, LIMITS.codeMinutesMax);
    const code = newCode();
    const row: CodeRow = {
      id: randomBytes(6).toString("hex"),
      hash: hashCode(code),
      by: cleanName(input.by),
      createdAt: now,
      expiresAt: Math.round(now + minutes * 60_000),
      // Short values are allowed on purpose: staging uses a one- or two-minute expiry so it can be watched happening.
      idleMinutes: clamp(input.idleMinutes ?? LIMITS.idleMinutesDefault, SHORTEST_MINUTES, 24 * 60),
      sessionMinutes: clamp(input.sessionMinutes ?? (input.sessionHours ?? LIMITS.sessionHoursDefault) * 60, SHORTEST_MINUTES, LIMITS.sessionHoursMax * 60),
      identityDays: clamp(input.identityDays ?? LIMITS.identityDaysDefault, SHORTEST_MINUTES / 1440, LIMITS.identityDaysMax),
      label: cleanLabel(input.label),
    };
    this.update((c) => c.codes.push(row));
    return { code, id: row.id, expiresAt: row.expiresAt };
  }
  /** `until`: an absolute expiry instead of `hours` (e.g. the identity's own); still capped at LIMITS.grantHoursMax from now. */
  grant(input: { capability: Capability; by: string; hours?: number; until?: number; now?: number }): GrantRow {
    if (!GRANTABLE.includes(input.capability)) throw new Error(`"${input.capability}" is not a grantable capability (${GRANTABLE.join(", ")}).`);
    const now = input.now ?? Date.now();
    const hours = clamp(input.until !== undefined ? (input.until - now) / 3_600_000 : (input.hours ?? LIMITS.grantHoursDefault), 1 / 60, LIMITS.grantHoursMax);
    const row: GrantRow = { capability: input.capability, by: cleanName(input.by), at: now, expiresAt: Math.round(now + hours * 3_600_000) };
    this.update((c) => {
      c.grants = c.grants.filter((g) => g.capability !== input.capability);
      c.grants.push(row);
    });
    return row;
  }
  revokeGrant(capability: Capability) {
    this.update((c) => (c.grants = c.grants.filter((g) => g.capability !== capability)));
  }
  revokeSession(id: string, now = Date.now()) {
    this.update((c) => (c.revokedSessions[id] = now));
  }
  revokeAllSessions(now = Date.now()) {
    this.update((c) => {
      c.revokeAllBefore = now;
      c.codes = []; // an unused code must not outlive "revoke everything"
    });
  }
  /**
   * Revoke one of Dot's identities: its reconnect key stops working and every access session it holds is refused from the
   * next request (the gateway re-reads this file when it changes; open streams close within about a second). Not undoable:
   * a founder enrols Dot again with a new code.
   */
  /** Authorise one mailbox (by address) for the gateway's mail.read and mail.draft. */
  authoriseMailbox(address: string, by: string, now = Date.now()): MailboxGrant {
    const row: MailboxGrant = { address: address.toLowerCase(), by: cleanName(by), at: now };
    this.update((c) => {
      c.mailboxes = [...(c.mailboxes ?? []).filter((m) => m.address !== row.address), row];
    });
    return row;
  }
  /** Take a mailbox back: refused from the next request. */
  revokeMailbox(address: string) {
    this.update((c) => {
      c.mailboxes = (c.mailboxes ?? []).filter((m) => m.address !== address.toLowerCase());
    });
  }
  /** A founder renews an identity: its expiry moves to `until` (capped at LIMITS.identityDaysMax from now). */
  extendIdentity(id: string, until: number, now = Date.now()): number {
    const capped = Math.round(Math.min(until, now + LIMITS.identityDaysMax * 86_400_000));
    this.update((c) => {
      c.identityExtensions = { ...(c.identityExtensions ?? {}), [id]: capped };
    });
    return capped;
  }
  revokeIdentity(id: string, now = Date.now()) {
    this.update((c) => {
      c.revokedIdentities ??= {};
      c.revokedIdentities[id] = now;
    });
  }
}

/** Shorter is always safer, so a code or a session may be made to lapse within seconds (staging, tests). */
const SHORTEST_MINUTES = 0.02;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const cleanName = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "unknown";
const cleanLabel = (s: string | undefined) => String(s ?? "").replace(/[^A-Za-z0-9 ._()-]/g, "").trim().slice(0, 40) || "Dot";

/** Is this identity revoked by a founder (by id, or by "revoke everything")? */
export const identityRevoked = (identity: Pick<IdentityRow, "id" | "createdAt">, control: Control) => control.revokedIdentities?.[identity.id] !== undefined || identity.createdAt <= control.revokeAllBefore;
export type IdentityState = "active" | "revoked" | "expired";
/** When an identity really ends: its original expiry, or later when a founder renewed it. */
export const identityExpiry = (identity: Pick<IdentityRow, "id" | "expiresAt">, control: Control) => Math.max(identity.expiresAt, control.identityExtensions?.[identity.id] ?? 0);
export const identityState = (identity: IdentityRow, control: Control, now = Date.now()): IdentityState => (identityRevoked(identity, control) ? "revoked" : now >= identityExpiry(identity, control) ? "expired" : "active");

/** The capabilities in force right now, and who granted each. `view` is every valid session's. */
export function effectiveCapabilities(control: Control, now = Date.now()): { caps: Capability[]; grantedBy: Partial<Record<Capability, string>> } {
  const grantedBy: Partial<Record<Capability, string>> = {};
  const caps = new Set<Capability>(BASE_CAPABILITIES);
  for (const g of control.grants)
    if (isCapability(g.capability) && GRANTABLE.includes(g.capability) && g.expiresAt > now) {
      caps.add(g.capability);
      grantedBy[g.capability] = g.by;
    }
  return { caps: [...caps].sort(), grantedBy };
}

/**
 * Dot's identities as a founder sees them (System, Devices and people; `cli identities`): read fresh from the two files,
 * never a key, a hash or a token. Read-only: the hub and the CLI never write sessions.json.
 */
export type IdentityView = { id: string; label: string; enrolledBy: string; createdAt: number; expiresAt: number; lastRenewedAt: number | null; renewals: number; state: IdentityState; activeSessions: number; lastSeenAt: number | null };
export function listIdentities(dir: string, now = Date.now()): IdentityView[] {
  const control = readJson(join(dir, FILES.control), emptyControl);
  const sessions = readJson(join(dir, FILES.sessions), emptySessions);
  return (sessions.identities ?? [])
    .map((i) => {
      const state = identityState(i, control, now);
      const own = sessions.sessions.filter((s) => s.identityId === i.id);
      const live = state === "active" ? own.filter((s) => !s.endedAt && control.revokedSessions[s.id] === undefined && now < s.expiresAt && now - s.lastSeenAt < s.idleMs) : [];
      return { id: i.id, label: i.label, enrolledBy: i.enrolledBy, createdAt: i.createdAt, expiresAt: identityExpiry(i, control), lastRenewedAt: i.lastRenewedAt ?? null, renewals: i.renewals ?? 0, state, activeSessions: live.length, lastSeenAt: own.length ? Math.max(...own.map((s) => s.lastSeenAt)) : null };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Within this long of an expiry, Dot is told to ask the owner to renew (`renewSoon`). */
export const RENEW_SOON_MS = 7 * 86_400_000;

/**
 * The renewal cycle in one step (cli renew, and the "Renew 30 days" button in Devices and people): every ACTIVE identity is
 * extended to `days` from now (at most LIMITS.identityDaysMax), and every capability in force now is granted again until the
 * latest new identity expiry, capped at LIMITS.grantHoursMax. Revoked or expired identities are not brought back.
 */
export function renewAccess(dir: string, by: string, days = 30, now = Date.now()): { identities: Array<{ id: string; expiresAt: number }>; grants: Array<{ capability: Capability; expiresAt: number }> } {
  const control = new ControlFile(dir);
  const active = listIdentities(dir, now).filter((i) => i.state === "active");
  if (!active.length) throw new Error("No active identity to renew. Enrol Dot again with enrol-code.");
  const until = now + clamp(days, 1, LIMITS.identityDaysMax) * 86_400_000;
  const identities = active.map((i) => ({ id: i.id, expiresAt: control.extendIdentity(i.id, Math.max(until, i.expiresAt), now) }));
  const latest = Math.max(...identities.map((i) => i.expiresAt));
  const inForce = effectiveCapabilities(control.read(), now).caps.filter((c) => c !== "view");
  const grants = inForce.map((capability) => ({ capability, expiresAt: control.grant({ capability, by, until: latest, now }).expiresAt }));
  return { identities, grants };
}

/** What Dot (and the founders) should know about expiry: the identity's end, each grant's end, and whether to renew soon. */
export function expiryView(control: Control, identity: { id: string; expiresAt: number } | null, now = Date.now()) {
  const grants = control.grants.filter((g) => g.expiresAt > now).map((g) => ({ capability: g.capability, by: g.by, expiresAt: g.expiresAt, renewSoon: g.expiresAt - now < RENEW_SOON_MS }));
  const identityEnds = identity ? identityExpiry(identity, control) : null;
  const identityView = identity ? { id: identity.id, expiresAt: identityEnds, renewSoon: identityEnds !== null && identityEnds - now < RENEW_SOON_MS } : null;
  return { identity: identityView, grants, renewSoon: !!identityView?.renewSoon || grants.some((g) => g.renewSoon), renewal: "Ask a founder to run: bun scripts/gateway/cli.ts renew --by <founder> (or press Renew 30 days in System, Devices and people)." };
}

// ── sessions (the gateway's file) ────────────────────────────────────────────────────────────────────────────────

export type SessionCheck =
  | { ok: true; session: SessionRow; viaPrevious: boolean }
  | { ok: false; reason: "none" | "unknown" | "expired" | "idle" | "revoked" | "ended" };

export class SessionFile {
  readonly file: string;
  private state: Sessions;
  private dirty = false;
  private lastFlush = 0;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, FILES.sessions);
    this.state = readJson(this.file, emptySessions);
    this.state.enrol ??= { failures: [], lockedUntil: 0 };
    this.state.usedCodes ??= {};
    this.state.identities ??= [];
  }
  private flush() {
    writeJsonAtomic(this.file, this.state);
    this.dirty = false;
    this.lastFlush = Date.now();
  }
  /** lastSeen changes on every request; it is written at most every 20 s. Everything else is written at once. */
  flushIfStale(now = Date.now()) {
    if (this.dirty && now - this.lastFlush > 20_000) this.flush();
  }
  close() {
    if (this.dirty) this.flush();
  }

  list(): SessionRow[] {
    return this.state.sessions;
  }
  identities(): IdentityRow[] {
    return this.state.identities ?? [];
  }
  identity(id: string | undefined): IdentityRow | null {
    return (id && this.identities().find((i) => i.id === id)) || null;
  }

  /** Why this session may no longer be used, or null. Marks it ended when it has lapsed. */
  private lapse(s: SessionRow, control: Control, now: number): Exclude<SessionCheck, { ok: true }>["reason"] | null {
    if (s.endedAt) return s.endReason === "revoked" ? "revoked" : "ended";
    let reason: SessionRow["endReason"] | null = null;
    const identity = this.identity(s.identityId);
    if (control.revokedSessions[s.id] !== undefined || s.createdAt <= control.revokeAllBefore) reason = "revoked";
    // The identity behind this access: revoked means every session it holds ends NOW, whatever their own expiry says.
    else if (s.identityId && (!identity || identityRevoked(identity, control))) reason = "revoked";
    else if (now >= s.expiresAt || (identity && now >= identityExpiry(identity, control))) reason = "expired";
    else if (now - s.lastSeenAt >= s.idleMs) reason = "idle";
    if (!reason) return null;
    s.endedAt = now;
    s.endReason = reason;
    this.flush();
    return reason;
  }

  /** Is the session with this public id still valid (for open streams and sockets)? Does not count as activity. */
  alive(id: string, control: Control, now = Date.now()): boolean {
    const s = this.state.sessions.find((r) => r.id === id);
    return !!s && this.lapse(s, control, now) === null;
  }

  /**
   * Verify a presented access token (the cookie value, or the bearer value without its prefix). Counts as activity when
   * valid. A token is good only in the mode it was issued for: a bearer token is never accepted as a cookie, or the reverse.
   */
  verify(token: string | null, control: Control, now = Date.now(), mode: AccessMode = "cookie"): SessionCheck {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: token ? "unknown" : "none" };
    const hash = hashToken(token);
    let viaPrevious = false;
    let s = this.state.sessions.find((r) => r.tokenHash === hash);
    if (!s) {
      s = this.state.sessions.find((r) => r.prevTokenHash === hash && (r.prevValidUntil ?? 0) > now);
      viaPrevious = !!s;
    }
    if (!s || (s.mode ?? "cookie") !== mode) return { ok: false, reason: "unknown" };
    const lapsed = this.lapse(s, control, now);
    if (lapsed) return { ok: false, reason: lapsed };
    s.lastSeenAt = now;
    this.dirty = true;
    return { ok: true, session: s, viaPrevious };
  }

  /**
   * Redeem an enrolment code: single use, unexpired. It creates Dot's IDENTITY (with a reconnect key, returned once and
   * stored only as a hash) and the first short-lived access session. Returns null for a wrong, used, expired or burned code.
   */
  redeem(code: string, control: Control, caps: Capability[], now = Date.now(), mode: AccessMode = "cookie"): { session: SessionRow; token: string; identity: IdentityRow; reconnectKey: string } | null {
    const hash = hashCode(code);
    const row = control.codes.find((c) => c.hash === hash);
    if (!row || row.expiresAt <= now || this.state.usedCodes[row.id] !== undefined || this.state.burnedCodes?.[row.id] !== undefined) return null;
    // Spent before anything is issued, and on disk before the cookie leaves.
    this.state.usedCodes[row.id] = now;
    const reconnectKey = RECONNECT_KEY_PREFIX + randomBytes(32).toString("base64url");
    const identity: IdentityRow = {
      id: randomBytes(8).toString("hex"),
      keyHash: hashReconnectKey(reconnectKey),
      label: row.label || "Dot",
      createdAt: now,
      expiresAt: Math.round(now + (row.identityDays ?? LIMITS.identityDaysDefault) * 86_400_000),
      enrolledBy: row.by,
      codeId: row.id,
      idleMs: Math.round(row.idleMinutes * 60_000),
      sessionMs: Math.round(row.sessionMinutes * 60_000),
      renewals: 0,
    };
    (this.state.identities ??= []).push(identity);
    const { session, token } = this.open(identity, caps, now, mode, identityExpiry(identity, control));
    this.prune(now);
    this.flush();
    return { session, token, identity, reconnectKey };
  }

  /** A new access session for an identity (the caller flushes). Ends the oldest when the identity already holds the maximum. */
  private open(identity: IdentityRow, caps: Capability[], now: number, mode: AccessMode, identityEnds: number): { session: SessionRow; token: string } {
    const live = this.state.sessions.filter((s) => s.identityId === identity.id && !s.endedAt && now < s.expiresAt && now - s.lastSeenAt < s.idleMs).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const old of live.slice(0, Math.max(0, live.length - (LIMITS.maxSessionsPerIdentity - 1)))) {
      old.endedAt = now;
      old.endReason = "expired";
    }
    const token = randomBytes(32).toString("base64url");
    const session: SessionRow = {
      id: randomBytes(12).toString("hex"),
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
      idleMs: identity.idleMs,
      expiresAt: Math.min(Math.round(now + identity.sessionMs), identityEnds),
      enrolledBy: identity.enrolledBy,
      codeId: identity.codeId,
      caps: [...caps],
      identityId: identity.id,
      mode,
    };
    this.state.sessions.push(session);
    return { session, token };
  }

  /**
   * Renew: Dot presents its reconnect key and gets a NEW short-lived access session (a new task, or the last access
   * expired). Refused, with one answer for every reason, when the key is unknown, or its identity is revoked or expired.
   */
  renew(reconnectKey: string, control: Control, caps: Capability[], now = Date.now(), mode: AccessMode = "cookie"): { session: SessionRow; token: string; identity: IdentityRow } | null {
    if (typeof reconnectKey !== "string" || !RECONNECT_KEY.test(reconnectKey)) return null;
    const hash = hashReconnectKey(reconnectKey);
    const identity = this.identities().find((i) => i.keyHash === hash);
    if (!identity || identityState(identity, control, now) !== "active") return null;
    identity.lastRenewedAt = now;
    identity.renewals = (identity.renewals ?? 0) + 1;
    const opened = this.open(identity, caps, now, mode, identityExpiry(identity, control));
    this.prune(now);
    this.flush();
    return { ...opened, identity };
  }

  /** Privilege changed: issue a new cookie value. The old one works only for the short grace (requests in flight). */
  rotate(session: SessionRow, caps: Capability[], now = Date.now()): string {
    const token = randomBytes(32).toString("base64url");
    session.prevTokenHash = session.tokenHash;
    session.prevValidUntil = now + LIMITS.rotationGraceMs;
    session.tokenHash = hashToken(token);
    session.caps = [...caps];
    this.flush();
    return token;
  }

  /** A bearer session's capability set changed: recorded, nothing to rotate (no browser holds the token as a cookie). */
  retag(session: SessionRow, caps: Capability[]) {
    session.caps = [...caps];
    this.flush();
  }

  end(session: SessionRow, reason: NonNullable<SessionRow["endReason"]>, now = Date.now()) {
    if (session.endedAt) return;
    session.endedAt = now;
    session.endReason = reason;
    this.flush();
  }

  private prune(now: number) {
    // Ended sessions are kept a week (so "revoked stays revoked" is a fact on disk, and the audit can be read against them).
    this.state.sessions = this.state.sessions.filter((s) => !s.endedAt || now - s.endedAt < 7 * 86_400_000);
    for (const [id, at] of Object.entries(this.state.usedCodes)) if (now - at > 7 * 86_400_000) delete this.state.usedCodes[id];
    // An expired identity stays listed for 30 days (so Devices and people can show that it lapsed), then goes.
    this.state.identities = this.identities().filter((i) => now - i.expiresAt < 30 * 86_400_000);
  }

  // ── wrong sign-in codes (survive a restart) ───────────────────────────────────────────────────────────────────
  //
  // A wrong code cannot say which code it was aimed at, so every wrong guess counts against EVERY unused code. A code that
  // has seen LIMITS.enrolFailuresPerCode wrong guesses since it was made is burned: it can no longer be redeemed, from any
  // address, and a founder makes a new one. That bounds guessing per code no matter how many addresses an attacker has,
  // without ever locking the gateway itself. The global count only raises an alert (the caller logs and audits it).
  enrolFailed(control: Control, now = Date.now()): { burned: string[]; recent: number } {
    const e = this.state.enrol;
    e.failures = e.failures.filter((t) => now - t < 24 * 3_600_000);
    e.failures.push(now);
    if (e.failures.length > 5_000) e.failures.splice(0, e.failures.length - 5_000);
    this.state.burnedCodes ??= {};
    const burned: string[] = [];
    for (const code of control.codes) {
      if (code.expiresAt <= now || this.state.usedCodes[code.id] !== undefined || this.state.burnedCodes[code.id] !== undefined) continue;
      if (e.failures.filter((t) => t >= code.createdAt).length >= LIMITS.enrolFailuresPerCode) {
        this.state.burnedCodes[code.id] = now;
        burned.push(code.id);
      }
    }
    this.flush();
    return { burned, recent: e.failures.filter((t) => now - t < LIMITS.enrolWindowMs).length };
  }
  isBurned(codeId: string): boolean {
    return this.state.burnedCodes?.[codeId] !== undefined;
  }
}
