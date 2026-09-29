import { cashFlow, minorUnits, normalise, type NormalisedRow } from "./normalise";
import { fixture, type FixtureId } from "./fixtures";
import { financeInsights } from "./insights";

export const NAB_SCOPES = ["accounts", "balances", "transactions"] as const;
export type NabScope = typeof NAB_SCOPES[number];
export type OwnerContext = { tenantId: string; ownerId: string };
export type ConsentInput = { acknowledgement: "synthetic-only"; purpose: "cash-flow-review"; scopes: NabScope[]; accountIds: ["syn-business"]; durationDays: number };
type FailureCode = "FIXTURE_REJECTED" | "PROVIDER_REJECTED";
export type AuditEvent = { sequence: number; at: string; action: "consent" | "import" | "refresh" | "revoke" | "error"; result: "ok" | "rejected"; count: number; code?: FailureCode };
const DAY = 86_400_000;
type State = { ownerId: string; generation: number; consent?: ConsentInput & { expiresAt: number }; revoked: boolean;
  rows: Map<string, NormalisedRow>; balanceMinor: number | null; balanceRevision: number; lastSyncAt: number | null; lastAttemptAt: number | null;
  nextRefreshAt: number | null; error: FailureCode | null; audit: AuditEvent[]; sequence: number };

/** Memory-only synthetic service. Caller context MUST come from trusted authentication, never request JSON. */
export function createNabSyntheticService(options: { now?: () => number } = {}) {
  const clock = options.now ?? Date.now;
  const tenants = new Map<string, State>();
  function now() { const n = clock(); if (!Number.isSafeInteger(n) || n < 0 || n > 8e15) throw new Error("INVALID_CLOCK"); return n; }
  function state(ctx: OwnerContext): State {
    if (!ctx || ![ctx.tenantId, ctx.ownerId].every(x => typeof x === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(x))) throw new Error("UNAUTHORISED");
    let s = tenants.get(ctx.tenantId);
    if (s && s.ownerId !== ctx.ownerId) throw new Error("UNAUTHORISED");
    if (!s) {
      s = { ownerId: ctx.ownerId, generation: 0, revoked: false, rows: new Map(), balanceMinor: null, balanceRevision: 0, lastSyncAt: null, lastAttemptAt: null, nextRefreshAt: null, error: null, audit: [], sequence: 0 };
      tenants.set(ctx.tenantId, s);
    }
    return s;
  }
  function record(s: State, action: AuditEvent["action"], count = 0, rejected = false) {
    s.audit.push({ sequence: ++s.sequence, at: new Date(now()).toISOString(), action, result: rejected ? "rejected" : "ok", count, ...(rejected ? { code: s.error ?? "FIXTURE_REJECTED" } : {}) });
    if (s.audit.length > 100) s.audit.shift();
  }
  function active(s: State) { return !!s.consent && !s.revoked && s.consent.expiresAt > now(); }
  function status(ctx: OwnerContext) {
    const s = state(ctx), enabled = active(s);
    if (s.consent && !enabled) { s.rows.clear(); s.balanceMinor = null; s.balanceRevision = 0; s.nextRefreshAt = null; }
    const phase = s.revoked ? "revoked" : !s.consent ? "not-consented" : !enabled ? "expired" : s.error ? "error" : s.lastSyncAt === null ? "awaiting-import" : now() - s.lastSyncAt >= DAY ? "stale" : "fresh";
    const scopes = enabled ? s.consent!.scopes : [];
    return { mode: "synthetic" as const, connected: false as const, phase, generation: s.generation,
      scopes: [...scopes], consentExpiresAt: s.consent ? new Date(s.consent.expiresAt).toISOString() : null,
      lastSyncAt: s.lastSyncAt === null ? null : new Date(s.lastSyncAt).toISOString(),
      lastAttemptAt: s.lastAttemptAt === null ? null : new Date(s.lastAttemptAt).toISOString(),
      nextRefreshAt: enabled && s.nextRefreshAt !== null ? new Date(s.nextRefreshAt).toISOString() : null,
      error: s.error, stale: s.lastSyncAt === null || now() - s.lastSyncAt >= DAY,
      accounts: scopes.includes("accounts") ? [{ id: "syn-business", name: "Synthetic business account", currency: "AUD" }] : [],
      balanceMinor: scopes.includes("balances") ? s.balanceMinor : null,
      cashFlow: scopes.includes("transactions") && s.lastSyncAt !== null ? cashFlow([...s.rows.values()]) : null,
      insights: scopes.includes("transactions") && s.lastSyncAt !== null ? financeInsights([...s.rows.values()]) : null,
      auditCount: s.audit.length, liveBlocker: "Provider onboarding, account eligibility, agreed costs and owner-approved bank-hosted consent are unverified." };
  }
  function consent(ctx: OwnerContext, input: ConsentInput) {
    const s = state(ctx);
    if (!input || input.acknowledgement !== "synthetic-only" || input.purpose !== "cash-flow-review" || !Array.isArray(input.scopes) ||
      !input.scopes.includes("accounts") || input.scopes.some(x => !NAB_SCOPES.includes(x)) || new Set(input.scopes).size !== input.scopes.length ||
      !Array.isArray(input.accountIds) || input.accountIds.length !== 1 || input.accountIds[0] !== "syn-business" ||
      !Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 30) throw new Error("INVALID_CONSENT");
    s.generation++; s.consent = { ...input, scopes: [...input.scopes], accountIds: ["syn-business"], expiresAt: now() + input.durationDays * DAY };
    s.revoked = false; s.rows.clear(); s.balanceMinor = null; s.balanceRevision = 0; s.lastSyncAt = null; s.lastAttemptAt = null; s.error = null; s.nextRefreshAt = now();
    record(s, "consent"); return status(ctx);
  }
  function ingest(ctx: OwnerContext, id: FixtureId, generation: number, action: "import" | "refresh") {
    const s = state(ctx);
    if (!active(s)) throw new Error("CONSENT_REQUIRED");
    if (generation !== s.generation) throw new Error("STALE_CONSENT_JOB");
    s.lastAttemptAt = now();
    try {
      const data = fixture(id); // Only a catalogue ID; never accept caller payloads.
      const staged = new Map(s.rows); let changed = 0;
      if (s.consent!.scopes.includes("transactions")) for (const raw of data.rows) {
        const row = normalise(raw);
        if (!s.consent!.accountIds.includes(row.accountId as "syn-business")) throw new Error("ACCOUNT_OUT_OF_SCOPE");
        const key = JSON.stringify([row.accountId, row.id]);
        const old = staged.get(key);
        if (old?.status === "posted" && row.status === "pending") continue; // Stale page cannot regress settled row.
        if (JSON.stringify(old) !== JSON.stringify(row)) { staged.set(key, row); changed++; }
      }
      const balance = s.consent!.scopes.includes("balances") ? minorUnits(data.balance) : null;
      cashFlow([...staged.values()]); // Aggregate overflow also fails atomically.
      financeInsights([...staged.values()]);
      s.rows = staged;
      if (data.balanceRevision >= s.balanceRevision) { s.balanceMinor = balance; s.balanceRevision = data.balanceRevision; }
      s.lastSyncAt = now(); s.nextRefreshAt = now() + DAY; s.error = null;
      record(s, action, changed); return { changed, status: status(ctx) };
    } catch {
      s.error = "FIXTURE_REJECTED"; s.nextRefreshAt = now() + DAY; record(s, "error", 0, true);
      throw new Error("FIXTURE_REJECTED");
    }
  }
  return {
    status, consent,
    recordProviderFailure(ctx: OwnerContext, generation: number) {
      const s = state(ctx);
      if (!active(s)) throw new Error("CONSENT_REQUIRED");
      if (s.generation !== generation) throw new Error("STALE_CONSENT_JOB");
      s.lastAttemptAt = now(); s.error = "PROVIDER_REJECTED"; s.nextRefreshAt = now() + DAY;
      record(s, "error", 0, true); return status(ctx);
    },
    importFixture(ctx: OwnerContext, input: { fixtureId: FixtureId; ownerInitiated: true; generation: number }) {
      if (input?.ownerInitiated !== true) throw new Error("OWNER_ACTION_REQUIRED");
      return ingest(ctx, input.fixtureId, input.generation, "import");
    },
    /** Call from an existing scheduler only. No timer is installed; jobs carry the consent generation. */
    refresh(ctx: OwnerContext, input: { generation: number }) {
      const s = state(ctx);
      if (!active(s)) throw new Error("CONSENT_REQUIRED");
      if (input.generation !== s.generation) throw new Error("STALE_CONSENT_JOB");
      if (s.nextRefreshAt !== null && now() < s.nextRefreshAt) return { changed: 0, skipped: true, status: status(ctx) };
      return { ...ingest(ctx, "cashflow-v1", input.generation, "refresh"), skipped: false };
    },
    revoke(ctx: OwnerContext) {
      const s = state(ctx); s.generation++; s.revoked = true; s.consent = undefined; s.rows.clear(); s.balanceMinor = null; s.balanceRevision = 0;
      s.lastSyncAt = null; s.lastAttemptAt = null; s.nextRefreshAt = null; s.error = null;
      record(s, "revoke"); return status(ctx);
    },
    audit(ctx: OwnerContext): AuditEvent[] { return state(ctx).audit.map(event => ({ ...event })); },
  };
}
export type NabSyntheticService = ReturnType<typeof createNabSyntheticService>;
export type NabStatus = ReturnType<NabSyntheticService["status"]>;
