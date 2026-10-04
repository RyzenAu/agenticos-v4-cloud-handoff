import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPersonId, SHARED_OWNER, type PersonId, type TargetDevice } from "./types";
import { dataDirFor } from "../cloud/data-dir";

/**
 * Paired devices and sessions, persisted in `.operator-data/devices.json`.
 *
 * - Browser sessions: a random 256-bit id, signed (HMAC-SHA256, per-install secret in
 *   `.operator-data/devices-secret`) into an HttpOnly cookie. Only the SHA-256 of the id is
 *   stored, so the file alone can't be replayed as a cookie. 30 days, hard expiry, revocable.
 * - One-time pairing codes: 8 characters, 10 minutes, single use, stored hashed. Five wrong
 *   codes lock redemption for 10 minutes, per flow and per requester (REVIEW-S1 R2-2): Mehroz's
 *   typos lock only Mehroz's browser pairing; a pending hub browser gets three tries at its confirm
 *   code and is then revoked, so a program with a forged navigation can't lock out anyone else.
 * - Companions: a paired worker on someone's own PC; bearer token stored hashed, 30 days,
 *   revocable. Companions are command targets (see route.ts); browsers never are.
 *
 * File permissions: `mode: 0o600` only takes effect on POSIX. On Windows Node ignores it, and both
 * files inherit the ACL of `.operator-data`, which sits in the owner's profile (C:/Users/<owner>/
 * source/repos/...): readable by that account, SYSTEM and Administrators only. Keep the checkout
 * inside the profile; a copy on a shared drive needs its own ACL, e.g.
 * `icacls .operator-data /inheritance:r /grant:r "%USERNAME%:F"`. Only hashes of session ids and
 * companion tokens are stored; the signing secret never leaves `devices-secret`.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_FAILURES = 5;
export const CODE_LOCK_MS = 10 * 60 * 1000;
/** Wrong confirm codes one pending hub session may submit; the third revokes it (REVIEW-S1 R2-2). */
export const HUB_CONFIRM_MAX_FAILURES = 3;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** tailnet/code: a paired remote browser. hub: a browser at this PC (Stage B1), minted on navigation. */
export type PairVia = "tailnet" | "code" | "hub";
/** Live hub sessions kept per PC; the oldest is revoked beyond this (a script can't pile them up). */
export const MAX_HUB_SESSIONS = 8;
/**
 * Unconfirmed hub sessions kept per PC, capped on their own: a page navigation is two headers any local
 * program can send (AUDIT-A1-3), so what it mints never evicts a confirmed session (AUDIT-A1-7).
 * REVIEW-S1 N1: they are also capped per SOURCE (the program that made the navigation, e.g. the owner's
 * browser vs a script), so a program looping forged page loads evicts only its own pending sessions, not
 * the owner's new browser waiting for its code. Over the overall cap, the source holding the most loses
 * its oldest; between equals, the NEWEST pending session goes, so a browser that was waiting first stays.
 */
export const MAX_PENDING_HUB_SESSIONS = 12;
export const MAX_PENDING_PER_SOURCE = 4;
/** A confirmed hub session that navigates within this long of its end is renewed (it never lapses in use). */
export const HUB_RENEW_WITHIN_MS = 10 * 24 * 60 * 60 * 1000;
export type SessionRow = {
  id: string; // sha256(session secret), hex — also the public id used for revoke
  personId: PersonId;
  label: string;
  via: PairVia;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  revokedAt?: number;
  /**
   * A hub session a page navigation minted and nobody has confirmed yet (AUDIT-A1-3). It is the owner at
   * this PC but a PROCESS caller, never a human session, until it is confirmed: the browser itself enters a
   * one-time code that only a human context hands out (a confirmed session of his, or the interactive
   * confirm-browser command; REVIEW-S1 F2b). Rows without it are confirmed.
   */
  pending?: true;
  /**
   * For a pending hub session: which program made the navigation that minted it (REVIEW-S1 N1), as a
   * short tag of its image ("chrome.exe#1a2b3c4d"). Only used to cap and evict pending sessions per
   * source; never an identity.
   */
  source?: string;
};
/** "hub": a one-time code that confirms a pending browser at this PC (REVIEW-S1 F2b). */
export type CodePurpose = "browser" | "companion" | "hub" | "computer";
export type PairCodeRow = {
  hash: string;
  personId: PersonId;
  purpose: CodePurpose;
  createdBy: PersonId;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  /** A "computer" code names the shared cloud computer it pairs (set by the hub, never by the redeeming program). */
  computer?: ComputerMeta;
};
/** What a shared cloud computer is (scripts/computers): its unique name, the adapter that hosts it, and who provisioned it. */
export type ComputerMeta = { name: string; adapter: string; createdBy: PersonId };
export type CompanionRow = TargetDevice & { kind: "companion" | "cloud-computer"; tokenHash: string; pairedAt: number; expiresAt: number; computer?: ComputerMeta };
export type DevicePolicy = {
  /** May this person pair a new browser with their Tailscale login alone (no code)? */
  selfPair: Record<PersonId, boolean>;
  /** People Usman has granted his finance view to. Empty by default. */
  financeGrants: PersonId[];
};
export type DeviceState = {
  version: 1;
  sessions: SessionRow[];
  codes: PairCodeRow[];
  companions: CompanionRow[];
  policy: DevicePolicy;
  /**
   * Wrong-code timestamps per lockout scope (REVIEW-S1 R2-2), e.g. "browser:mehroz", "companion:usman",
   * "hub:<session id>". One requester's failures never lock another requester or another flow. (The
   * single shared list this replaced is ignored on read; its entries expired in 10 minutes anyway.)
   */
  codeFailures: Record<string, number[]>;
  /**
   * When this PC first trusted a hub session. Before that (a fresh install) the first navigation is
   * trusted on first use; after it, every new hub session starts pending. Any existing confirmed hub
   * row counts as trusted (the sessions in use when this shipped stay human).
   */
  hubTrustedAt?: number;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");

function emptyState(): DeviceState {
  return {
    version: 1,
    sessions: [],
    codes: [],
    companions: [],
    policy: { selfPair: { usman: true, mehroz: true }, financeGrants: [] },
    codeFailures: {},
  };
}

export function normaliseCode(code: string) {
  return String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * R8 F. What a store file has to look like before anything may be built on it: a JSON object with a `sessions` array (every file
 * write() has ever produced has one). `null`, `[]`, `{}` or a damaged file is "unreadable", never "empty".
 */
export class UnreadableStoreError extends Error {}

export function parseStoreText(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new UnreadableStoreError(`not valid JSON (${(e as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as { sessions?: unknown }).sessions)) {
    throw new UnreadableStoreError("not a sign-in record (expected an object with a sessions list)");
  }
  return raw as Record<string, unknown>;
}

/** Build the in-memory state from an already parsed file (one read, one parse; read() and writes share it). */
function stateFromParsed(raw: ReturnType<typeof JSON.parse>): DeviceState {
  const base = emptyState();
  return {
    version: 1,
    sessions: Array.isArray(raw?.sessions) ? raw.sessions.filter((s: SessionRow) => isPersonId(s?.personId)) : [],
    codes: Array.isArray(raw?.codes) ? raw.codes.filter((c: PairCodeRow) => isPersonId(c?.personId)) : [],
    companions: Array.isArray(raw?.companions) ? raw.companions.filter((c: CompanionRow) => isPersonId(c?.owner) || (c?.kind === "cloud-computer" && c?.owner === SHARED_OWNER)) : [],
    policy: {
      selfPair: { ...base.policy.selfPair, ...(raw?.policy?.selfPair ?? {}) },
      financeGrants: Array.isArray(raw?.policy?.financeGrants) ? raw.policy.financeGrants.filter(isPersonId) : [],
    },
    codeFailures: readFailures(raw?.codeFailures),
    ...(typeof raw?.hubTrustedAt === "number" ? { hubTrustedAt: raw.hubTrustedAt } : {}),
  };
}

export type SessionStoreCondition = { state: "ok" | "absent" | "unreadable"; detail: string };

/** For /__health and the System page: can the sign-in records be read? Reads the file once; never writes, never returns a row. */
export function sessionStoreCondition(file: string, readText: (path: string) => string = (p) => readFileSync(p, "utf8")): SessionStoreCondition {
  try {
    parseStoreText(readText(file));
    return { state: "ok", detail: "Sign-in records read." };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent", detail: "No sign-in records yet (nobody has paired on this hub)." };
    const why = e instanceof UnreadableStoreError ? e.message : `could not be opened (${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? "error"})`;
    return { state: "unreadable", detail: `Sign-in records can't be read (${why}): nothing will be overwritten.` };
  }
}

export type StoreOptions = {
  now?: () => number;
  file?: string;
  secretFile?: string;
  /** Test seam: how the store file is read (default fs.readFileSync utf8). */
  readText?: (path: string) => string;
};

export class DeviceStore {
  readonly file: string;
  private readonly secretFile: string;
  private readonly now: () => number;
  private readonly readText: (path: string) => string;
  private secret?: Buffer;

  constructor(root: string, options: StoreOptions = {}) {
    this.file = options.file ?? join(dataDirFor(root), "devices.json");
    this.secretFile = options.secretFile ?? join(dataDirFor(root), "devices-secret");
    this.now = options.now ?? Date.now;
    this.readText = options.readText ?? ((p) => readFileSync(p, "utf8"));
  }

  // ---------- persistence ----------
  read(): DeviceState {
    try {
      return stateFromParsed(parseStoreText(this.readText(this.file)));
    } catch {
      return emptyState(); // fail closed for a read: nobody is signed in. A write never builds on this (readForWrite).
    }
  }

  private write(state: DeviceState) {
    const t = this.now();
    // Drop what can never matter again: used/expired codes, sessions/companions dead for 30+ days.
    state.codes = state.codes.filter((c) => !c.usedAt && c.expiresAt > t);
    state.sessions = state.sessions.filter((s) => Math.max(s.expiresAt, s.revokedAt ?? 0) + SESSION_TTL_MS > t);
    state.companions = state.companions.filter((c) => Math.max(c.expiresAt, c.revokedAt ?? 0) + SESSION_TTL_MS > t);
    state.codeFailures = liveFailures(state.codeFailures, t);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /**
   * R8 F. read() answers "nobody is signed in" for ANY failure, which is the safe answer for a read. A write built on it is not safe:
   * if the file exists but could not be read this instant (Windows: a virus scan or the 03:15 backup holding it, EBUSY/EPERM) or is
   * not a sign-in record (damaged, or valid JSON of the wrong shape such as null, [] or {}), update() would save that empty state over the real one, signing every browser out, dropping every companion and
   * forgetting that the hub was ever trusted. So a write only starts from "empty" when the file is genuinely absent; otherwise it
   * retries briefly and then refuses, leaving the file as it is.
   */
  private readForWrite(): DeviceState {
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // One read and one parse, and the state is built from exactly that: a second read could hit the lock the first one missed.
        return stateFromParsed(parseStoreText(this.readText(this.file)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return emptyState();
        last = e;
        if (e instanceof UnreadableStoreError) break; // not transient: the rename-into-place write never leaves a half file
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
      }
    }
    throw new Error(`Sign-in records can't be read, so nothing was overwritten (${this.file}): ${(last as Error)?.message ?? last}`);
  }

  private update<T>(fn: (state: DeviceState) => T): T {
    const state = this.readForWrite();
    const out = fn(state);
    this.write(state);
    return out;
  }

  /**
   * R7 review (restore security). A backup carries every login that worked on the machine it came from. After a restore onto a DIFFERENT
   * folder or machine none of them should still open the hub: rotate the signing secret (every cookie stops verifying), mark every session
   * revoked (so the list says so) and drop unused pairing codes. Companion bearer tokens are not signed with this secret and are left alone
   * (they can only reach a hub at the address they were paired to). The hub-trust marker stays, so the next browser at this PC starts pending
   * and is confirmed with scripts/identity/confirm-browser.ts, not trusted on first use.
   */
  freshenForRestore(): { sessionsRevoked: number; codesDropped: number } {
    mkdirSync(dirname(this.secretFile), { recursive: true });
    writeFileSync(this.secretFile, randomBytes(32), { mode: 0o600 });
    this.secret = undefined;
    return this.update((s) => {
      const t = this.now();
      let sessionsRevoked = 0;
      for (const row of s.sessions) if (!row.revokedAt) ((row.revokedAt = t), sessionsRevoked++);
      const codesDropped = s.codes.length;
      s.codes = [];
      return { sessionsRevoked, codesDropped };
    });
  }

  private key(): Buffer {
    if (this.secret) return this.secret;
    try {
      const existing = readFileSync(this.secretFile);
      if (existing.length >= 32) return (this.secret = existing);
    } catch {
      /* first run */
    }
    mkdirSync(dirname(this.secretFile), { recursive: true });
    const fresh = randomBytes(32);
    writeFileSync(this.secretFile, fresh, { mode: 0o600 });
    return (this.secret = fresh);
  }

  private sign(value: string) {
    return b64url(createHmac("sha256", this.key()).update(value).digest());
  }

  // ---------- browser sessions ----------
  /** Returns the cookie value (secret) once; only its hash is stored. */
  mintSession(personId: PersonId, label: string, via: PairVia, options: { pending?: boolean; /** Where it was paired from, as the hub saw it (tailnet address and node), shown to whoever approves it. Never an identity. */ source?: string } = {}): { cookie: string; session: SessionRow } {
    const minted = this.newSession(personId, label, via, options.pending === true);
    if (options.source) minted.session.source = cleanSource(options.source);
    this.update((s) => {
      s.sessions.push(minted.session);
      if (via === "hub" && !minted.session.pending) s.hubTrustedAt ??= minted.session.createdAt;
      this.capHub(s, minted.session.createdAt);
    });
    return minted;
  }

  private newSession(personId: PersonId, label: string, via: PairVia, pending: boolean): { cookie: string; session: SessionRow } {
    const secret = b64url(randomBytes(32));
    const t = this.now();
    const session: SessionRow = {
      id: sha256(secret),
      personId,
      label: cleanLabel(label) || `${cap(personId)}'s browser`,
      via,
      createdAt: t,
      expiresAt: t + SESSION_TTL_MS,
      lastSeen: t,
      ...(pending ? { pending: true as const } : {}),
    };
    return { cookie: `${secret}.${this.sign(secret)}`, session };
  }

  /** Confirmed and pending hub sessions are capped separately, so a pending one never evicts a confirmed one. */
  private capHub(s: DeviceState, t: number) {
    const live = (pending: boolean) =>
      s.sessions.filter((x) => x.via === "hub" && !x.revokedAt && x.expiresAt > t && !!x.pending === pending).sort((a, b) => a.createdAt - b.createdAt);
    const confirmed = live(false);
    for (const old of confirmed.slice(0, Math.max(0, confirmed.length - MAX_HUB_SESSIONS))) old.revokedAt = t;
    // Pending (REVIEW-S1 N1): per source first, oldest of that source out.
    const bySource = new Map<string, SessionRow[]>();
    for (const row of live(true)) {
      const key = row.source ?? UNKNOWN_SOURCE;
      bySource.set(key, [...(bySource.get(key) ?? []), row]);
    }
    for (const rows of bySource.values()) for (const old of rows.splice(0, Math.max(0, rows.length - MAX_PENDING_PER_SOURCE))) old.revokedAt = t;
    // Then overall: the source holding the most gives up its oldest; between equals, the newest goes.
    let total = [...bySource.values()].reduce((n, rows) => n + rows.length, 0);
    while (total > MAX_PENDING_HUB_SESSIONS) {
      const groups = [...bySource.values()].filter((rows) => rows.length);
      const most = Math.max(...groups.map((rows) => rows.length));
      const largest = groups.filter((rows) => rows.length === most);
      const victim =
        most > 1 && largest.length === 1
          ? largest[0].shift()!
          : (() => {
              const newest = largest.map((rows) => rows[rows.length - 1]).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))[0];
              const rows = bySource.get(newest.source ?? UNKNOWN_SOURCE)!;
              return rows.splice(rows.indexOf(newest), 1)[0];
            })();
      victim.revokedAt = t;
      total--;
    }
  }

  /** Has this PC trusted a hub session before (so a new one must be confirmed)? */
  private hubTrusted(s: DeviceState) {
    return s.hubTrustedAt !== undefined || s.sessions.some((x) => x.via === "hub" && !x.pending);
  }

  /**
   * The gate's mint for a page navigation at this PC (AUDIT-A1-3). On a fresh install the first one is
   * trusted on first use; after that every new one is PENDING: the owner at this PC, but a process caller
   * until confirmed. Decided inside one read-modify-write, so two first navigations can't both be trusted.
   */
  mintHubSession(label: string, source?: string | null): { cookie: string; session: SessionRow } {
    return this.update((s) => {
      const minted = this.newSession("usman", label, "hub", this.hubTrusted(s));
      if (minted.session.pending) minted.session.source = cleanSource(source);
      s.sessions.push(minted.session);
      // Trust is recorded for good (this first one, or rows from before the flag), so pruning old
      // sessions can never re-arm trust on first use.
      s.hubTrustedAt ??= minted.session.createdAt;
      this.capHub(s, minted.session.createdAt);
      return minted;
    });
  }

  /**
   * A confirmed hub session near its end, on a page navigation from the browser holding it: a fresh
   * confirmed session replaces it, so a browser in use never lapses into a pending one.
   */
  renewHubSession(row: SessionRow): { cookie: string; session: SessionRow } | null {
    if (row.via !== "hub" || row.pending || row.revokedAt || row.expiresAt - this.now() > HUB_RENEW_WITHIN_MS) return null;
    return this.update((s) => {
      const old = s.sessions.find((x) => x.id === row.id);
      if (!old || old.revokedAt || old.pending) return null;
      const minted = this.newSession("usman", old.label, "hub", false);
      s.sessions.push(minted.session);
      old.revokedAt = minted.session.createdAt;
      this.capHub(s, minted.session.createdAt);
      return minted;
    });
  }

  /**
   * The pending hub browser holding `rowId` confirms ITSELF with a one-time "hub" code (REVIEW-S1 F2b).
   * The code never reaches that browser from the server: a confirmed session of Usman's, or the
   * interactive confirm-browser command, hands it to a human, who types it into the new browser. So a
   * program that forged a navigation holds a pending session but no way to read a code for it. The code
   * is burnt on use. Wrong codes count only against THIS pending session (REVIEW-S1 R2-2): the third
   * revokes it, so guessing needs a fresh forged navigation each time, and nobody else is locked out
   * (the owner's own pending browser, Mehroz's pairing and companion pairing keep their own counters).
   */
  confirmHubSession(rowId: string, code: string): { ok: true; session: SessionRow } | { ok: false; reason: string } {
    return this.update((s) => {
      const t = this.now();
      const row = s.sessions.find((x) => x.id === rowId && x.via === "hub" && x.personId === "usman" && !x.revokedAt && x.expiresAt > t);
      if (!row) return { ok: false as const, reason: "This browser's session has ended. Reload the page and try again." };
      if (!row.pending) return { ok: false as const, reason: "This browser is already confirmed." };
      const scope = `hub:${row.id}`;
      const failures = (s.codeFailures[scope] ?? []).filter((f) => t - f < CODE_LOCK_MS);
      const hash = sha256(normaliseCode(code));
      const hit = s.codes.find((c) => c.hash === hash && c.purpose === "hub" && c.personId === "usman");
      if (!hit || hit.usedAt || hit.expiresAt <= t) {
        failures.push(t);
        s.codeFailures[scope] = failures;
        if (failures.length >= HUB_CONFIRM_MAX_FAILURES) {
          row.revokedAt = t;
          delete s.codeFailures[scope];
          return { ok: false as const, reason: "Too many wrong codes for this browser, so its sign-in was cancelled. Reload the page and use a new code." };
        }
        return { ok: false as const, reason: "That code is wrong, used or expired. Make a new one in System › Devices and people on a browser you already use, or with the confirm-browser command." };
      }
      delete s.codeFailures[scope];
      hit.usedAt = t;
      delete row.pending;
      s.hubTrustedAt ??= t;
      this.capHub(s, t);
      return { ok: true as const, session: row };
    });
  }

  /** The live session behind a cookie value, or null (bad signature, unknown, revoked, expired). */
  verifySession(cookie: string | undefined | null): SessionRow | null {
    if (!cookie || typeof cookie !== "string") return null;
    const dot = cookie.lastIndexOf(".");
    if (dot <= 0) return null;
    const secret = cookie.slice(0, dot);
    const sig = Buffer.from(cookie.slice(dot + 1));
    const want = Buffer.from(this.sign(secret));
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
    const id = sha256(secret);
    const t = this.now();
    const state = this.read();
    const row = state.sessions.find((s) => s.id === id);
    if (!row || row.revokedAt || row.expiresAt <= t) return null;
    // Refresh "last seen" at most once a minute (display only; expiry never slides).
    if (t - row.lastSeen > 60_000) {
      row.lastSeen = t;
      this.write(state);
    }
    return row;
  }

  /**
   * The server-only key for a session (Stage B1: Principal.sessionId). Derived with this install's
   * secret from the stored row id, so the public row id shown for revoking can't be turned into it,
   * and it never appears in any response.
   */
  sessionKey(rowId: string): string {
    return `sk1.${b64url(createHmac("sha256", this.key()).update(`principal-session|${rowId}`).digest())}`;
  }

  sessions(personId?: PersonId): SessionRow[] {
    return this.read().sessions.filter((s) => !personId || s.personId === personId);
  }

  /**
   * Server role: confirm a session a bare Tailscale login paired (it was minted PENDING). Only a live, pending, tailnet-paired
   * session can be approved; hub sessions have their own code confirmation (confirmHubSession).
   */
  approveSession(rowId: string, byPerson?: PersonId): { ok: true; session: SessionRow } | { ok: false; status: number; reason: string } {
    return this.update((s) => {
      const t = this.now();
      const row = s.sessions.find((x) => x.id === rowId && !x.revokedAt && x.expiresAt > t);
      if (!row) return { ok: false as const, status: 404, reason: "No such session." };
      // Manage only your own devices: a confirmed session approves a new browser of the SAME person (the console code is the other route).
      if (byPerson !== undefined && row.personId !== byPerson) return { ok: false as const, status: 403, reason: "You can approve only your own browsers. For someone else's, make a one-time code at the server console." };
      if (row.via !== "tailnet") return { ok: false as const, status: 409, reason: "Only a browser paired with a Tailscale login needs this." };
      if (!row.pending) return { ok: false as const, status: 409, reason: "This browser is already confirmed." };
      delete row.pending;
      return { ok: true as const, session: row };
    });
  }

  revokeSession(id: string): SessionRow | null {
    return this.update((s) => {
      const row = s.sessions.find((x) => x.id === id);
      if (!row) return null;
      row.revokedAt ??= this.now();
      return row;
    });
  }

  // ---------- one-time pairing codes ----------
  createCode(personId: PersonId, purpose: CodePurpose, createdBy: PersonId): { code: string; expiresAt: number } {
    let raw = "";
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const t = this.now();
    const row: PairCodeRow = { hash: sha256(raw), personId, purpose, createdBy, createdAt: t, expiresAt: t + CODE_TTL_MS };
    this.update((s) => void s.codes.push(row));
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: row.expiresAt };
  }

  /**
   * Burns the code on success. Wrong/expired/used codes count towards the lockout of THIS flow and THIS
   * requester only (REVIEW-S1 R2-2): `requester` is the verified person redeeming (their Tailscale login,
   * or the owner at this PC), and only a code made for them is accepted (someone else's code is a wrong
   * code for them, and isn't burnt). Without a requester the flow has one shared counter.
   * `origin` narrows it further (REVIEW-S1 N2): where the attempt came from, e.g. "hub" for any local
   * program, or the tailnet node ID of a remote device, so local programs can't lock the owner's other
   * PC out of pairing a companion.
   */
  redeemCode(code: string, purpose: CodePurpose, requester?: PersonId, origin?: string): { ok: true; personId: PersonId; computer?: ComputerMeta } | { ok: false; reason: string } {
    return this.update((s) => {
      const t = this.now();
      const where = origin ? `@${String(origin).replace(/[^\w.:-]/g, "").slice(0, 64)}` : "";
      const scope = `${purpose}:${requester ?? "*"}${where}`;
      const failures = (s.codeFailures[scope] ?? []).filter((f) => t - f < CODE_LOCK_MS);
      if (failures.length >= CODE_MAX_FAILURES) return { ok: false as const, reason: "Too many wrong codes. Wait 10 minutes, then make a new code." };
      const hash = sha256(normaliseCode(code));
      const row = s.codes.find((c) => c.hash === hash && c.purpose === purpose && (!requester || c.personId === requester));
      if (!row || row.usedAt || row.expiresAt <= t) {
        failures.push(t);
        s.codeFailures[scope] = failures;
        return { ok: false as const, reason: "That code is wrong, used or expired. Make a new one on a paired device." };
      }
      row.usedAt = t;
      return { ok: true as const, personId: row.personId, ...(row.computer ? { computer: row.computer } : {}) };
    });
  }

  // ---------- companions ----------
  registerCompanion(owner: PersonId, input: { label?: string; aliases?: string[] }): { device: CompanionRow; token: string } {
    const token = b64url(randomBytes(32));
    const t = this.now();
    return this.update((s) => {
      const hasPrimary = s.companions.some((c) => c.owner === owner && c.primary && !c.revokedAt && c.expiresAt > t);
      const label = cleanLabel(input.label ?? "") || `${cap(owner)}'s PC`;
      const device: CompanionRow = {
        id: `${owner}-${b64url(randomBytes(6)).toLowerCase().replace(/[^a-z0-9]/g, "x")}`,
        owner,
        kind: "companion",
        label,
        aliases: (input.aliases ?? []).map(cleanLabel).filter(Boolean).slice(0, 8),
        // Usman's hub is his primary; a person's first companion is theirs.
        primary: owner !== "usman" && !hasPrimary,
        tokenHash: sha256(token),
        pairedAt: t,
        expiresAt: t + SESSION_TTL_MS,
      };
      s.companions.push(device);
      return { device, token };
    });
  }

  /**
   * A one-time code that pairs a SHARED CLOUD COMPUTER (scripts/computers): made by the hub for a founder's provisioning
   * request, bound to a unique computer name. Refuses a name already held by a live (not revoked/expired) computer.
   */
  createComputerCode(createdBy: PersonId, computer: { name: string; adapter: string }): { code: string; expiresAt: number } | { error: string } {
    const name = computer.name;
    const t = this.now();
    if (this.read().companions.some((c) => c.kind === "cloud-computer" && c.computer?.name === name && !c.revokedAt && c.expiresAt > t))
      return { error: `A computer called "${name}" already exists.` };
    let raw = "";
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const row: PairCodeRow = { hash: sha256(raw), personId: createdBy, purpose: "computer", createdBy, createdAt: t, expiresAt: t + CODE_TTL_MS, computer: { name, adapter: computer.adapter, createdBy } };
    this.update((s) => void s.codes.push(row));
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: row.expiresAt };
  }

  /** Register the computer a redeemed "computer" code named. Owner is "shared": both founders control it, neither owns it. */
  registerComputer(meta: ComputerMeta, input: { label?: string } = {}): { device: CompanionRow; token: string } {
    const token = b64url(randomBytes(32));
    const t = this.now();
    return this.update((s) => {
      const device: CompanionRow = {
        id: `computer-${meta.name}-${b64url(randomBytes(4)).toLowerCase().replace(/[^a-z0-9]/g, "x")}`,
        owner: SHARED_OWNER,
        kind: "cloud-computer",
        label: cleanLabel(input.label ?? "") || `${meta.name} computer`,
        aliases: [meta.name],
        tokenHash: sha256(token),
        pairedAt: t,
        expiresAt: t + SESSION_TTL_MS,
        computer: meta,
      };
      s.companions.push(device);
      return { device, token };
    });
  }

  verifyCompanion(token: string | undefined | null): CompanionRow | null {
    if (!token) return null;
    const hash = sha256(token);
    const t = this.now();
    const row = this.read().companions.find((c) => c.tokenHash === hash);
    if (!row || row.revokedAt || row.expiresAt <= t) return null;
    return row;
  }

  companions(): CompanionRow[] {
    return this.read().companions;
  }

  revokeCompanion(id: string): CompanionRow | null {
    return this.update((s) => {
      const row = s.companions.find((c) => c.id === id);
      if (!row) return null;
      row.revokedAt ??= this.now();
      return row;
    });
  }

  // ---------- policy ----------
  policy(): DevicePolicy {
    return this.read().policy;
  }

  setSelfPair(personId: PersonId, allowed: boolean) {
    this.update((s) => void (s.policy.selfPair[personId] = allowed));
  }

  setFinanceGrant(personId: PersonId, granted: boolean) {
    this.update((s) => {
      const rest = s.policy.financeGrants.filter((p) => p !== personId);
      s.policy.financeGrants = granted && personId !== "usman" ? [...rest, personId] : rest;
    });
  }
}

const UNKNOWN_SOURCE = "unknown";
/** A navigation source tag, bounded and printable. */
function cleanSource(source: string | null | undefined) {
  const tag = String(source ?? "").replace(/[^\w.#:-]/g, "").slice(0, 80);
  return tag || UNKNOWN_SOURCE;
}

function readFailures(raw: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [scope, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const times = list.filter((n): n is number => typeof n === "number");
    if (times.length) out[scope.slice(0, 128)] = times;
  }
  return out;
}

function liveFailures(all: Record<string, number[]>, t: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [scope, list] of Object.entries(all)) {
    const live = list.filter((f) => t - f < CODE_LOCK_MS);
    if (live.length) out[scope] = live;
  }
  return out;
}

function cleanLabel(value: string) {
  return String(value ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 48);
}
function cap(id: string) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

