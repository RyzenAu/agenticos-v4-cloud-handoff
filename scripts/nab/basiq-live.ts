// Basiq LIVE adapter — SKELETON ONLY, behind a code-owned admission that is currently null
// (refused). It makes no network call, resolves no secret and writes nothing while refused.
//
// Owner decision, 27 Sep 2026: NAB is connected by owner-initiated CSV export for now. A live
// Basiq connection waits on (1) Basiq enabling production for the M&U app and (2) the owner's
// explicit consent on NAB's/Basiq's own hosted screens. Neither has happened.
//
// What this adapter needs before BASIQ_LIVE_ADMISSION may become non-null (reviewed commit):
//  1. Token by secure reference: the API key is resolved at call time through an injected
//     SecretResolver from a reference like { kind: "secret-ref", name: "BASIQ_API_KEY" }.
//     The key string is never stored, logged, returned or put in a status object.
//  2. Idempotent sync: transactions upsert on Basiq's own transaction id + account alias into the
//     owner-scoped manual store (source "basiq-live"), with a persisted cursor; a replayed page
//     changes zero rows; pending→posted follows the same settle rule as the CSV importer.
//  3. Stale/error status: phases not-connected | awaiting-consent | fresh | stale | error | revoked,
//     with lastAttemptAt / lastSuccessAt / nextEligibleAt; stale after 24 h; error codes only.
//  4. Revocation: revoke(owner) deletes the owner's live-synced rows locally and marks the phase
//     revoked; provider-side revocation is the OWNER's action (NAB app → Data sharing → Basiq →
//     Stop sharing, or Basiq support deletes the user). No agent may start or revoke consent.
//  5. Read-only scopes only. No payment-initiation, payee or write endpoint, ever.
//  6. Owner isolation: owner comes from the authenticated session, never from request input.
import type { ManualFinanceStore } from "../finance/manual-store";

export type SecretRef = Readonly<{ kind: "secret-ref"; name: "BASIQ_API_KEY" }>;
export type SecretResolver = (ref: SecretRef) => string | null;
export type BasiqLivePhase = "not-connected" | "awaiting-consent" | "fresh" | "stale" | "error" | "revoked";

export type BasiqLiveAdmission = Readonly<{
  kind: "basiq-live-admission/v1";
  reviewRef: string;
  approvedBy: "owner";
  approvedAt: string;
  productionEnabledEvidence: string;
  ownerConsentEvidence: string;
  scopes: readonly ("accounts" | "transactions")[];
}>;

/** THE code-owned admission. null = refused. Never wire this to env, config, request or store. */
export const BASIQ_LIVE_ADMISSION: BasiqLiveAdmission | null = null;

export const BASIQ_LIVE_REQUIREMENTS = Object.freeze([
  "Basiq enables production for the M&U Ventures app (sandbox only reaches test banks).",
  "Owner confirms Basiq's commercial terms (12-month minimum, platform fee) in writing.",
  "Owner is set up as NAB's business nominated representative for data sharing.",
  "Owner consents on NAB's and Basiq's own hosted screens — never through this app.",
  "A reviewed commit sets BASIQ_LIVE_ADMISSION with the evidence above.",
]);

export class BasiqLiveRefused extends Error {
  readonly code = "BASIQ_LIVE_NOT_ADMITTED" as const;
  constructor() { super("Basiq live connection is not admitted: waiting on Basiq production enablement and the owner's consent."); this.name = "BasiqLiveRefused"; }
}

/** Owner decision, 27 Sep 2026: NAB CSV import is the route; a live feed is deferred. */
export const BASIQ_LIVE_DECISION = Object.freeze({ kind: "deferred-by-owner" as const, decidedAt: "2026-09-27", route: "nab-csv-manual" as const });

export type BasiqLiveStatus = {
  provider: "basiq"; mode: "live"; connected: false; phase: BasiqLivePhase;
  /** Why it isn't connected: the owner deferred it (not a failure, not pending setup work). */
  decision: typeof BASIQ_LIVE_DECISION;
  headline: string; reason: string; requirements: readonly string[];
  lastAttemptAt: null; lastSuccessAt: null; nextEligibleAt: null; error: null;
  fallback: "nab-csv-manual";
};

/** Pure admission check. Reads nothing but its argument. */
export function basiqLiveAdmitted(admission: BasiqLiveAdmission | null = BASIQ_LIVE_ADMISSION): boolean {
  return !!admission && admission.kind === "basiq-live-admission/v1" && admission.approvedBy === "owner"
    && [admission.reviewRef, admission.productionEnabledEvidence, admission.ownerConsentEvidence].every((s) => typeof s === "string" && s.trim().length > 0)
    && Array.isArray(admission.scopes) && admission.scopes.length > 0 && admission.scopes.every((s) => s === "accounts" || s === "transactions");
}

/**
 * Status for the Finance page. Always "not connected" while the admission is null. Pure: no
 * network call, secret, store or consent start — it only reports the code-owned state.
 */
export function basiqLiveStatus(): BasiqLiveStatus {
  return {
    provider: "basiq", mode: "live", connected: false, phase: "not-connected", decision: BASIQ_LIVE_DECISION,
    headline: "Live bank feed: not connected (deferred by owner decision)",
    reason: "You chose the NAB CSV import as the route for now (27 Sep 2026). A live feed would also need Basiq production enablement and your consent; neither is authorised.",
    requirements: BASIQ_LIVE_REQUIREMENTS,
    lastAttemptAt: null, lastSuccessAt: null, nextEligibleAt: null, error: null, fallback: "nab-csv-manual",
  };
}

export type BasiqLiveDeps = {
  token: SecretRef;
  resolveSecret: SecretResolver;
  /** Injected HTTP transport. Never called while refused. */
  transport: typeof fetch;
  store: ManualFinanceStore;
  now?: () => Date;
  /** Code-level injection for tests only. Defaults to the code-owned constant. */
  admission?: BasiqLiveAdmission | null;
};

/**
 * The live adapter's shape. Every method checks admission FIRST and throws BasiqLiveRefused
 * before touching the secret resolver, transport or store. The admitted branches are
 * deliberately unimplemented: implementing them is a separate, reviewed change.
 */
export function createBasiqLiveAdapter(deps: BasiqLiveDeps) {
  const gate = () => {
    if (!basiqLiveAdmitted(deps.admission === undefined ? BASIQ_LIVE_ADMISSION : deps.admission)) throw new BasiqLiveRefused();
  };
  return {
    status(): BasiqLiveStatus { return basiqLiveStatus(); },
    async sync(_owner: string): Promise<never> {
      gate();
      throw new Error("BASIQ_LIVE_SYNC_NOT_IMPLEMENTED");
    },
    async startConsent(_owner: string): Promise<never> {
      gate();
      throw new Error("BASIQ_LIVE_CONSENT_IS_OWNER_ACTION");
    },
    async revoke(_owner: string): Promise<never> {
      gate();
      throw new Error("BASIQ_LIVE_REVOKE_NOT_IMPLEMENTED");
    },
  };
}
