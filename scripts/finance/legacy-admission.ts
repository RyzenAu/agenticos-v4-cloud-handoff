// Fail-closed admission for the legacy NAB-via-Basiq path (scripts/finance/sync.ts and the
// /business/finance/{status,connect,sync,summary,import-csv} routes). Those paths can create a
// Basiq user, call the provider, open .operator-data/finance.sqlite, read/write finance.json and
// scan the owner's Downloads folder. None of that may happen merely because a provider key
// exists: it needs an explicit, reviewed live authorisation recorded in THIS source file.
//
// The authorisation is code-owned on purpose. It is never read from a request body, query
// string, header, environment variable, config file or the finance store — changing it is a
// reviewed source commit. Code-level callers (tests) may inject a record through the explicit
// `authorisation` option; nothing reachable from HTTP or the environment can.
//
// Stripe (/business/finance/stripe/*) and Mercury are separate and deliberately not gated here.
// The safe manual Operations NAB component (scripts/nab/*) never touches this path.
import type { FinanceSync, ImportableFinanceSnapshot } from "./sync";

export type LegacyNabCapability = "status" | "connect" | "sync" | "summary" | "import-csv" | "schedule";
export const LEGACY_NAB_CAPABILITIES: readonly LegacyNabCapability[] = Object.freeze(["status", "connect", "sync", "summary", "import-csv", "schedule"]);

export type LegacyNabLiveAuthorisation = Readonly<{
  kind: "legacy-nab-live-authorisation/v1";
  /** Where the review lives: a commit, PR or dated review document. */
  reviewRef: string;
  reviewedBy: string;
  /** ISO timestamps. The window must be positive and at most MAX_AUTHORISATION_DAYS long. */
  reviewedAt: string;
  expiresAt: string;
  provider: "basiq";
  capabilities: readonly LegacyNabCapability[];
}>;

export const MAX_AUTHORISATION_DAYS = 90;

/**
 * THE code-owned live authorisation. `null` = legacy NAB fully refused (fail closed).
 * Setting it requires the owner's reviewed approval of provider/product/scopes/cost/retention/
 * consent (see docs/NAB-CONNECTION-20260927.md) and a reviewed commit. Do not wire this to env,
 * config or request input.
 */
export const LEGACY_NAB_LIVE_AUTHORISATION: LegacyNabLiveAuthorisation | null = null;

export type LegacyNabRefusalCode =
  | "nab_legacy_not_authorised"
  | "nab_legacy_authorisation_invalid"
  | "nab_legacy_authorisation_expired"
  | "nab_legacy_capability_not_authorised";

export type LegacyNabDecision =
  | { admitted: true; capability: LegacyNabCapability }
  | { admitted: false; capability: LegacyNabCapability; status: 403 | 503; code: LegacyNabRefusalCode; reason: string };

const MANUAL_FALLBACK = "Import a NAB CSV on the Finance page instead.";

export class LegacyNabRefusal extends Error {
  readonly status: 403 | 503;
  readonly code: LegacyNabRefusalCode;
  readonly capability: LegacyNabCapability;
  constructor(decision: Extract<LegacyNabDecision, { admitted: false }>) {
    super(decision.reason);
    this.name = "LegacyNabRefusal";
    this.status = decision.status;
    this.code = decision.code;
    this.capability = decision.capability;
  }
}

const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const instant = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN);

function refuse(capability: LegacyNabCapability, status: 403 | 503, code: LegacyNabRefusalCode, reason: string): LegacyNabDecision {
  return { admitted: false, capability, status, code, reason: `${reason} ${MANUAL_FALLBACK}` };
}

/** Pure decision. Reads nothing but its arguments: no env, no files, no request data. */
export function legacyNabAdmission(capability: LegacyNabCapability, authorisation: LegacyNabLiveAuthorisation | null = LEGACY_NAB_LIVE_AUTHORISATION, now: Date = new Date()): LegacyNabDecision {
  if (!LEGACY_NAB_CAPABILITIES.includes(capability)) return refuse(capability, 403, "nab_legacy_capability_not_authorised", "Unknown legacy NAB operation.");
  if (authorisation === null || authorisation === undefined)
    return refuse(capability, 403, "nab_legacy_not_authorised", "Legacy NAB/Basiq access is disabled: no reviewed live authorisation exists in code.");
  const a = authorisation as Record<string, unknown>;
  const reviewedAt = instant(a.reviewedAt), expiresAt = instant(a.expiresAt), at = now.getTime();
  const valid = typeof a === "object"
    && a.kind === "legacy-nab-live-authorisation/v1"
    && a.provider === "basiq"
    && text(a.reviewRef) && text(a.reviewedBy)
    && Number.isFinite(reviewedAt) && Number.isFinite(expiresAt)
    && expiresAt > reviewedAt && expiresAt - reviewedAt <= MAX_AUTHORISATION_DAYS * 86400000
    && Array.isArray(a.capabilities) && a.capabilities.length > 0
    && a.capabilities.every((c) => LEGACY_NAB_CAPABILITIES.includes(c as LegacyNabCapability));
  if (!valid || !Number.isFinite(at))
    return refuse(capability, 503, "nab_legacy_authorisation_invalid", "Legacy NAB/Basiq access is disabled: the code-owned live authorisation is malformed.");
  if (at < reviewedAt || at >= expiresAt)
    return refuse(capability, 403, "nab_legacy_authorisation_expired", "Legacy NAB/Basiq access is disabled: the reviewed live authorisation is not currently valid.");
  if (!(a.capabilities as readonly string[]).includes(capability))
    return refuse(capability, 403, "nab_legacy_capability_not_authorised", `Legacy NAB/Basiq "${capability}" is not covered by the reviewed live authorisation.`);
  return { admitted: true, capability };
}

/** Throws LegacyNabRefusal unless admitted. */
export function assertLegacyNabAdmitted(capability: LegacyNabCapability, authorisation: LegacyNabLiveAuthorisation | null, now: Date): void {
  const decision = legacyNabAdmission(capability, authorisation, now);
  if (!decision.admitted) throw new LegacyNabRefusal(decision);
}

export function refusalBody(decision: Extract<LegacyNabDecision, { admitted: false }>) {
  return { error: decision.reason, code: decision.code, capability: decision.capability, refused: true as const };
}

// --- Legacy route handler (extracted from scripts/operator-plugin.ts) ----------------------

/** The legacy CSV route is retired, whatever any authorisation says: one NAB CSV importer only. */
export const NAB_CSV_MOVED = Object.freeze({
  error: "NAB CSV import moved to Finance → NAB CSV (the one importer; finance-manual.sqlite). Nothing was imported here.",
  code: "nab_csv_moved", refused: true as const, moved: "/__finance_manual/import",
});

const LEGACY_ROUTE = /^\/business\/finance\/(status|connect|sync|summary|import-csv)\/?$/i;

export type LegacyNabRouteDeps = {
  /** Lazily yields the finance sync. Never called for a refused request. */
  finance: () => FinanceSync;
  /** Shared "already refreshing" set from the operator plugin. */
  syncing: Set<string>;
  /** business.importFinances + demoOffForLiveData + syncBusinessMemory in the operator plugin. */
  importFinances: (snapshot: ImportableFinanceSnapshot) => { finances: { recordedAt: string; monthlyIncome?: unknown } };
  /** Code-level injection only (tests). Defaults to LEGACY_NAB_LIVE_AUTHORISATION. */
  authorisation?: LegacyNabLiveAuthorisation | null;
  now?: () => Date;
};

export type LegacyNabRouteReply = { status: number; body: unknown };

/** Returns undefined for any path that is not a legacy NAB route (Stripe included). Admitted
 *  requests behave exactly as the old inline routes did and throw the same errors. */
export async function handleLegacyNabRoute(req: { method: string; path: string; body?: any }, deps: LegacyNabRouteDeps): Promise<LegacyNabRouteReply | undefined> {
  const match = LEGACY_ROUTE.exec(req.path);
  if (!match) return undefined;
  if (match[1].toLowerCase() === "import-csv") return { status: 410, body: NAB_CSV_MOVED };
  const capability = match[1].toLowerCase() as LegacyNabCapability;
  // Admission first, from code-owned state only: nothing from the request besides the route
  // itself is consulted, and deps (finance, syncing, importFinances) are untouched on refusal.
  // Case/trailing-slash variants are refused too rather than silently falling through.
  const decision = legacyNabAdmission(capability, deps.authorisation === undefined ? LEGACY_NAB_LIVE_AUTHORISATION : deps.authorisation, deps.now?.() ?? new Date());
  if (!decision.admitted) return { status: decision.status, body: refusalBody(decision) };
  const { method, body } = req;
  const route = `/business/finance/${capability}`;
  if (req.path !== route) return undefined;
  const financeSync = deps.finance();
  if (method === "GET" && route === "/business/finance/status") {
    if (!financeSync.configured()) return { status: 200, body: { configured: false, connected: false, accounts: [], connections: [] } };
    return { status: 200, body: await financeSync.status() };
  }
  if (method === "POST" && route === "/business/finance/connect") {
    if (!financeSync.configured()) throw new Error("Add your Basiq key to ~/.config/agentic-os.env first (see docs/FINANCE-NAB.md), then reconnect.");
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const mobile = typeof body?.mobile === "string" ? body.mobile.trim() : "";
    if (!email && !mobile) throw new Error("Enter an email address or mobile number to connect NAB.");
    return { status: 200, body: await financeSync.connect({ email: email || undefined, mobile: mobile || undefined }) };
  }
  if (method === "POST" && route === "/business/finance/sync") {
    if (deps.syncing.has("finance")) throw new Error("NAB is already refreshing.");
    if (!financeSync.configured()) throw new Error("Add your Basiq key to ~/.config/agentic-os.env first, then reconnect.");
    deps.syncing.add("finance");
    try {
      const result = await financeSync.sync();
      const imported = deps.importFinances(result.snapshot);
      return { status: 200, body: { accounts: result.accounts, transactionsSeen: result.transactionsSeen, matches: result.matches, recordedAt: imported.finances.recordedAt, monthlyIncome: imported.finances.monthlyIncome ?? null } };
    } finally { deps.syncing.delete("finance"); }
  }
  if (method === "GET" && route === "/business/finance/summary") {
    if (!financeSync.configured()) throw new Error("NAB is not connected.");
    return { status: 200, body: financeSync.summary() };
  }
  return undefined;
}
