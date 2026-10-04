import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrincipal, isJobPrincipal } from "../approvals/principal";
import { signAssertion } from "./assertion";
import { gatewayActorRef, gatewayHolds, isGatewayActor } from "./actor";
import { runCli } from "./cli";
import { ASSERTION_HEADER, FILES, LIMITS, RECONNECT_KEY_PREFIX, VIA_VALUE } from "./config";
import { createGatewayTrust } from "./hub";
import { CAPABILITIES, GRANTABLE, OPERATE_SET } from "./policy";
import { ControlFile, effectiveCapabilities, expiryView, hashReconnectKey, listIdentities, renewAccess, SessionFile } from "./store";

/**
 * Dot's identity: enrol, renew, revoke. The store and the founder's console (no network), then the hub's own check of a
 * signed assertion for a revoked session or identity.
 */

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gw-identity-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs)
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows may hold a handle briefly */
    }
});

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

function enrolled(dir: string, mint: Parameters<ControlFile["mintCode"]>[0] = { by: "usman" }, now = T0) {
  const control = new ControlFile(dir);
  const { code } = control.mintCode({ ...mint, now });
  const sessions = new SessionFile(dir);
  const first = sessions.redeem(code, control.read(), ["view"], now + 1_000)!;
  return { control, sessions, code, first };
}

describe("enrolment makes an identity; only hashes are stored", () => {
  test("a code is single use and becomes one identity with a reconnect key shown once", () => {
    const dir = tmp();
    const { control, sessions, code, first } = enrolled(dir, { by: "usman", label: "Dot (cloud browser)", identityDays: 14 });
    expect(first.reconnectKey.startsWith(RECONNECT_KEY_PREFIX)).toBe(true);
    expect(first.reconnectKey.length).toBe(RECONNECT_KEY_PREFIX.length + 43);
    expect(first.identity).toMatchObject({ label: "Dot (cloud browser)", enrolledBy: "usman", renewals: 0 });
    expect(first.identity.expiresAt).toBe(T0 + 1_000 + 14 * DAY);
    expect(first.session.identityId).toBe(first.identity.id);
    // The same code again: refused (and it made no second identity).
    expect(sessions.redeem(code, control.read(), ["view"], T0 + 2_000)).toBeNull();
    expect(sessions.identities().length).toBe(1);
    // On disk: the hash of the key, the hash of the cookie, the hash of the code. Never the values.
    const onDisk = readFileSync(join(dir, FILES.sessions), "utf8") + readFileSync(join(dir, FILES.control), "utf8");
    for (const secret of [first.reconnectKey, first.reconnectKey.slice(RECONNECT_KEY_PREFIX.length), first.token, code, code.replace(/-/g, "")]) expect(onDisk.includes(secret)).toBe(false);
    expect(onDisk.includes(hashReconnectKey(first.reconnectKey))).toBe(true);
  });

  test("identity lifetime is clamped: 30 days by default, never more than 90", () => {
    const a = enrolled(tmp()).first.identity;
    expect(a.expiresAt - a.createdAt).toBe(LIMITS.identityDaysDefault * DAY);
    const b = enrolled(tmp(), { by: "usman", identityDays: 5000 }).first.identity;
    expect(b.expiresAt - b.createdAt).toBe(LIMITS.identityDaysMax * DAY);
  });
});

describe("renewal: the reconnect key buys new short-lived access", () => {
  test("a new task, or expired access, gets a new session; the old cookie stays expired", () => {
    const dir = tmp();
    const { control, sessions, first } = enrolled(dir, { by: "usman", sessionHours: 1 });
    // The first access lapses after its hour.
    expect(sessions.verify(first.token, control.read(), T0 + 30 * 60_000).ok).toBe(true);
    expect(sessions.verify(first.token, control.read(), T0 + 62 * 60_000)).toEqual({ ok: false, reason: "expired" });
    // The reconnect key gets new access, with the same limits.
    const again = sessions.renew(first.reconnectKey, control.read(), ["view"], T0 + 63 * 60_000)!;
    expect(again.identity.id).toBe(first.identity.id);
    expect(again.session.id).not.toBe(first.session.id);
    expect(again.token).not.toBe(first.token);
    expect(again.session.expiresAt - again.session.createdAt).toBe(3_600_000);
    expect(sessions.verify(again.token, control.read(), T0 + 64 * 60_000).ok).toBe(true);
    expect(sessions.verify(first.token, control.read(), T0 + 64 * 60_000).ok).toBe(false);
    expect(sessions.identity(first.identity.id)).toMatchObject({ renewals: 1, lastRenewedAt: T0 + 63 * 60_000 });
  });

  test("a wrong, malformed or someone else's key gets nothing, with one answer", () => {
    const dir = tmp();
    const { control, sessions, first } = enrolled(dir);
    const other = enrolled(tmp()).first.reconnectKey;
    for (const key of ["", "nope", RECONNECT_KEY_PREFIX + "A".repeat(43), first.reconnectKey.slice(0, -1), first.reconnectKey + "x", other, first.token, 42 as never, null as never]) expect(sessions.renew(key, control.read(), ["view"], T0 + 5_000)).toBeNull();
    expect(sessions.identity(first.identity.id)!.renewals).toBe(0);
  });

  test("access never outlives the identity, and an expired identity cannot renew", () => {
    const dir = tmp();
    const { control, sessions, first } = enrolled(dir, { by: "usman", identityDays: 1, sessionHours: 12 });
    const late = sessions.renew(first.reconnectKey, control.read(), ["view"], T0 + DAY - 3_600_000)!;
    // An hour of identity left: the 12-hour session is cut to it.
    expect(late.session.expiresAt).toBe(first.identity.expiresAt);
    expect(sessions.verify(late.token, control.read(), first.identity.expiresAt - 1).ok).toBe(true);
    expect(sessions.verify(late.token, control.read(), first.identity.expiresAt + 1)).toEqual({ ok: false, reason: "expired" });
    expect(sessions.renew(first.reconnectKey, control.read(), ["view"], first.identity.expiresAt + 1)).toBeNull();
  });

  test("a token works only in the mode it was issued for (a bearer is never a cookie, or the reverse)", () => {
    const dir = tmp();
    const { control, sessions, first } = enrolled(dir);
    const bearer = sessions.renew(first.reconnectKey, control.read(), ["view"], T0 + 5_000, "bearer")!;
    expect(bearer.session.mode).toBe("bearer");
    expect(sessions.verify(bearer.token, control.read(), T0 + 6_000, "bearer").ok).toBe(true);
    expect(sessions.verify(bearer.token, control.read(), T0 + 6_000, "cookie")).toEqual({ ok: false, reason: "unknown" });
    expect(sessions.verify(first.token, control.read(), T0 + 6_000, "bearer")).toEqual({ ok: false, reason: "unknown" });
    expect(sessions.verify(first.token, control.read(), T0 + 6_000).ok).toBe(true);
  });

  test("one identity holds at most a few live sessions: the oldest is ended when a new task signs in", () => {
    const dir = tmp();
    const { control, sessions, first } = enrolled(dir);
    const tokens = [first.token];
    for (let i = 1; i <= LIMITS.maxSessionsPerIdentity; i++) tokens.push(sessions.renew(first.reconnectKey, control.read(), ["view"], T0 + 1_000 + i * 1_000)!.token);
    const at = T0 + 60_000;
    expect(sessions.verify(tokens[0], control.read(), at).ok).toBe(false);
    for (const t of tokens.slice(1)) expect(sessions.verify(t, control.read(), at).ok).toBe(true);
  });
});

describe("revocation is immediate", () => {
  test("revoking the identity ends every session it holds and its reconnect key, at once", () => {
    const dir = tmp();
    const { control, sessions, first } = enrolled(dir);
    const second = sessions.renew(first.reconnectKey, control.read(), ["view"], T0 + 5_000, "bearer")!;
    expect(sessions.verify(first.token, control.read(), T0 + 6_000).ok).toBe(true);
    expect(sessions.alive(second.session.id, control.read(), T0 + 6_000)).toBe(true);
    control.revokeIdentity(first.identity.id, T0 + 7_000);
    // The very next check: both sessions (cookie and bearer), open streams, and the key.
    expect(sessions.verify(first.token, control.read(), T0 + 7_001)).toEqual({ ok: false, reason: "revoked" });
    expect(sessions.verify(second.token, control.read(), T0 + 7_001, "bearer")).toEqual({ ok: false, reason: "revoked" });
    expect(sessions.alive(second.session.id, control.read(), T0 + 7_001)).toBe(false);
    expect(sessions.renew(first.reconnectKey, control.read(), ["view"], T0 + 7_002)).toBeNull();
    // It stays revoked across a restart of the gateway (a fresh reader of the same files).
    const restarted = new SessionFile(dir);
    expect(restarted.verify(first.token, new ControlFile(dir).read(), T0 + 8_000).ok).toBe(false);
    expect(restarted.renew(first.reconnectKey, new ControlFile(dir).read(), ["view"], T0 + 8_000)).toBeNull();
    expect(listIdentities(dir, T0 + 8_000)[0]).toMatchObject({ id: first.identity.id, state: "revoked", activeSessions: 0 });
  });

  test("another identity is untouched; 'revoke everything' takes identities, sessions and unused codes", () => {
    const dir = tmp();
    const a = enrolled(dir, { by: "usman", label: "Dot A" });
    const control = a.control;
    const { code } = control.mintCode({ by: "mehroz", label: "Dot B", now: T0 + 10_000 });
    const b = a.sessions.redeem(code, control.read(), ["view"], T0 + 11_000)!;
    control.revokeIdentity(a.first.identity.id, T0 + 12_000);
    expect(a.sessions.verify(a.first.token, control.read(), T0 + 13_000).ok).toBe(false);
    expect(a.sessions.verify(b.token, control.read(), T0 + 13_000).ok).toBe(true);
    expect(listIdentities(dir, T0 + 13_000).map((i) => [i.label, i.state, i.activeSessions])).toEqual([["Dot B", "active", 1], ["Dot A", "revoked", 0]]);
    const unused = control.mintCode({ by: "usman", now: T0 + 14_000 }).code;
    control.revokeAllSessions(T0 + 15_000);
    expect(a.sessions.verify(b.token, control.read(), T0 + 15_001)).toEqual({ ok: false, reason: "revoked" });
    expect(a.sessions.renew(b.reconnectKey, control.read(), ["view"], T0 + 15_002)).toBeNull();
    expect(a.sessions.redeem(unused, control.read(), ["view"], T0 + 15_003)).toBeNull();
  });

  test("the founder's console: identities, revoke-identity, and no secret ever printed", () => {
    const dir = tmp();
    const { first, control, sessions } = enrolled(dir, { by: "usman", label: "Dot" }, Date.now());
    const cli = (...argv: string[]) => {
      const lines: string[] = [];
      const code = runCli(argv, dir, (l) => lines.push(l));
      return { code, text: lines.join("\n") };
    };
    const listed = cli("identities");
    expect(listed.code).toBe(0);
    expect(listed.text).toContain(first.identity.id);
    expect(listed.text).toContain("active");
    expect(cli("revoke-identity", "nothex").code).toBe(1);
    expect(cli("revoke-identity", "0123456789abcdef").text).toContain("No such identity");
    const revoked = cli("revoke-identity", first.identity.id);
    expect(revoked.code).toBe(0);
    expect(sessions.verify(first.token, control.read()).ok).toBe(false);
    expect(cli("identities").text).toContain("revoked");
    const everything = [listed.text, revoked.text, cli("status").text, cli("sessions").text, cli("capabilities").text].join("\n");
    for (const secret of [first.reconnectKey, first.token, first.reconnectKey.slice(RECONNECT_KEY_PREFIX.length)]) expect(everything.includes(secret)).toBe(false);
  });

  test("the hub refuses a revoked session or identity itself, whatever the gateway signed", () => {
    const root = tmp();
    const dir = join(root, "gateway");
    const trust = createGatewayTrust({ root, internalToken: () => "internal-token", enabled: true, dir });
    const key = readFileSync(join(dir, FILES.secret), "utf8").trim();
    const control = new ControlFile(dir);
    const screen = (sessionId: string, identityId: string) => {
      const url = "/__gateway/me";
      const req = { url, method: "GET", headers: { host: "127.0.0.1:8081", via: VIA_VALUE, [ASSERTION_HEADER]: signAssertion(key, { method: "GET", target: url, sessionId, caps: ["view"], identityId }) }, socket: { remoteAddress: "127.0.0.1" } };
      return trust.screen(req as never);
    };
    const sid = "ab".repeat(12);
    const iid = "cd".repeat(8);
    expect(screen(sid, iid)).toMatchObject({ ok: true });
    control.revokeIdentity(iid);
    // A perfectly valid, freshly signed assertion: refused, because the founder's control file says so.
    expect(screen(sid, iid)).toMatchObject({ ok: false, status: 401, reason: "revoked" });
    expect(screen("ef".repeat(12), iid)).toMatchObject({ ok: false, reason: "revoked" });
    const otherIdentity = "12".repeat(8);
    expect(screen(sid, otherIdentity)).toMatchObject({ ok: true });
    control.revokeSession(sid);
    expect(screen(sid, otherIdentity)).toMatchObject({ ok: false, reason: "revoked" });
    expect(screen("ef".repeat(12), otherIdentity)).toMatchObject({ ok: true });
  });
});

describe("capabilities: deny by default, granted by a founder, always expiring", () => {
  test("a new identity holds view only; `grant operate` is the operating set, never the terminal", () => {
    const dir = tmp();
    const control = new ControlFile(dir);
    expect(effectiveCapabilities(control.read()).caps).toEqual(["view"]);
    const lines: string[] = [];
    expect(runCli(["grant", "operate", "--by", "usman", "--hours", "2"], dir, (l) => lines.push(l))).toBe(0);
    const { caps, grantedBy } = effectiveCapabilities(control.read());
    expect([...caps].sort()).toEqual(["view", ...OPERATE_SET].sort());
    expect(caps.includes("bots.terminal")).toBe(false);
    expect(grantedBy["crm.write"]).toBe("usman");
    // Every grant lapses on its own.
    expect(effectiveCapabilities(control.read(), Date.now() + 2 * 3_600_000 + 1_000).caps).toEqual(["view"]);
    expect(runCli(["grant", "bots.terminal", "--by", "mehroz"], dir, () => undefined)).toBe(0);
    expect(effectiveCapabilities(control.read()).caps.includes("bots.terminal")).toBe(true);
    expect(runCli(["grant", "owner", "--by", "usman"], dir, () => undefined)).toBe(1);
    expect(runCli(["grant", "view", "--by", "usman"], dir, () => undefined)).toBe(1);
    expect(runCli(["grant", "crm.write"], dir, () => undefined)).toBe(1); // no founder named
    expect(runCli(["revoke-grant", "--all"], dir, () => undefined)).toBe(0);
    expect(effectiveCapabilities(control.read()).caps).toEqual(["view"]);
    expect(GRANTABLE.length).toBe(CAPABILITIES.length - 1);
  });
});

describe("the gateway actor: recognised exactly, never a founder", () => {
  test("isGatewayActor is all three of person, via and actor; B2's isPrincipal still refuses it; only the job store's owner check admits it", () => {
    const dot = { personId: "dot", via: "gateway", actor: "process", sessionId: "gw:abc", capabilities: ["view", "crm.write"] };
    expect(isGatewayActor(dot)).toBe(true);
    expect(isGatewayActor(gatewayActorRef())).toBe(true);
    for (const lookalike of [
      { ...dot, personId: "usman" },
      { ...dot, via: "paired-session" },
      { ...dot, actor: "human" },
      { personId: "dot", via: "gateway" },
      { ...dot, personId: "Dot" },
      { ...dot, sessionId: "x".repeat(201) },
      null,
      "dot",
    ])
      expect(isGatewayActor(lookalike)).toBe(false);
    // B2 (approvals: request, decide, cancel) never accepts it.
    expect(isPrincipal(dot)).toBe(false);
    // The job store may record a job as Dot's, and a founder's as before; nothing else.
    expect(isJobPrincipal(dot)).toBe(true);
    expect(isJobPrincipal({ personId: "usman", via: "paired-session", actor: "human" })).toBe(true);
    expect(isJobPrincipal({ personId: "dot", via: "paired-session", actor: "process" })).toBe(false);
    expect(isJobPrincipal({ personId: "usman", via: "gateway", actor: "process" })).toBe(false);
    expect(gatewayHolds(dot, "crm.write")).toBe(true);
    expect(gatewayHolds(dot, "files.write")).toBe(false);
    expect(gatewayHolds({ personId: "usman", via: "paired-session", actor: "human", capabilities: ["crm.write"] }, "crm.write")).toBe(false);
    expect(gatewayHolds(gatewayActorRef(), "view")).toBe(false); // a stored principal carries no capabilities
  });
});

describe("the renewal cycle: Dot does not go read-only unexpectedly", () => {
  test("grant --until-identity lasts as long as the identity (capped at the grant maximum); renew extends both together", () => {
    const dir = tmp();
    const now = Date.now();
    const control = new ControlFile(dir);
    const { code } = control.mintCode({ by: "usman", identityDays: 30, now });
    new SessionFile(dir).redeem(code, control.read(), ["view"], now);
    const cli = (...argv: string[]) => {
      const lines: string[] = [];
      return { code: runCli(argv, dir, (l) => lines.push(l)), text: lines.join("\n") };
    };
    expect(cli("grant", "operate", "--by", "usman", "--until-identity").code).toBe(0);
    const identity = listIdentities(dir)[0];
    for (const g of control.read().grants) expect(Math.abs(g.expiresAt - identity.expiresAt)).toBeLessThan(5_000);
    // 24 days on: everything ends within 7 days, so Dot is told to ask for renewal.
    const later = now + 24 * DAY;
    const soon = expiryView(control.read(), identity, later);
    expect(soon.renewSoon).toBe(true);
    expect(soon.identity?.renewSoon).toBe(true);
    expect(soon.grants.every((g) => g.renewSoon)).toBe(true);
    expect(expiryView(control.read(), identity, now).renewSoon).toBe(false);
    // One step renews the identity and every grant in force, together.
    const renewed = cli("renew", "--by", "mehroz", "--days", "30");
    expect(renewed.code).toBe(0);
    const after = listIdentities(dir)[0];
    expect(after.expiresAt).toBeGreaterThanOrEqual(identity.expiresAt);
    expect(after.state).toBe("active");
    for (const g of control.read().grants) expect(g.by).toBe("mehroz");
    // Renewing with a longer cycle: the identity follows (up to 90 days), grants stop at the 30-day grant maximum.
    renewAccess(dir, "usman", 60, now);
    const long = listIdentities(dir)[0];
    expect(Math.round((long.expiresAt - now) / DAY)).toBe(60);
    for (const g of control.read().grants) expect(g.expiresAt - now).toBeLessThanOrEqual(LIMITS.grantHoursMax * 3_600_000 + 1_000);
    // A founder must be named; a revoked identity is not brought back.
    expect(cli("renew").code).toBe(1);
    control.revokeIdentity(long.id);
    expect(cli("renew", "--by", "usman").code).toBe(1);
    expect(listIdentities(dir)[0].state).toBe("revoked");
  });

  test("a renewed identity's sessions run past the original expiry; renewal never revives a revoked one", () => {
    const dir = tmp();
    const control = new ControlFile(dir);
    const { code } = control.mintCode({ by: "usman", identityDays: 1, sessionHours: 48, now: T0 });
    const sessions = new SessionFile(dir);
    const first = sessions.redeem(code, control.read(), ["view"], T0)!;
    expect(first.session.expiresAt).toBe(T0 + DAY); // capped at the identity
    control.extendIdentity(first.identity.id, T0 + 10 * DAY, T0);
    // New access after the original day: allowed, because the identity was renewed.
    const later = sessions.renew(first.reconnectKey, control.read(), ["view"], T0 + 2 * DAY)!;
    expect(later).not.toBeNull();
    expect(later.session.expiresAt).toBe(T0 + 2 * DAY + 48 * 3_600_000);
    expect(sessions.verify(later.token, control.read(), T0 + 2 * DAY + 60_000).ok).toBe(true);
  });
});
