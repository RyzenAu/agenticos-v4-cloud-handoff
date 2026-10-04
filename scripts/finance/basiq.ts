// Thin client for Basiq (api.basiq.io / docs.basiq.io) — an Australian Consumer
// Data Right (Open Banking) aggregator. This client never sees or stores bank credentials:
// the owner authorises on Basiq's hosted consent UI and NAB's own screens, and we only ever
// read what NAB (via Basiq) hands back after that consent. This legacy client also exposes
// user creation and connection refresh; callers must enforce their approval boundaries.
// No payment-initiation endpoint is exposed. The NAB demo uses a closed synthetic transport.
//
// API shape, from Basiq's current docs (api.basiq.io/reference/*, api.basiq.io/docs/*):
//  - POST /token with `Authorization: Basic <api key>` (used verbatim, not base64-encoded)
//    and `scope=SERVER_ACCESS` returns a bearer token valid ~60 minutes, used for every
//    server-side call below.
//  - POST /token with `scope=CLIENT_ACCESS&userId=<id>` returns a short-lived token bound to
//    one user; that token becomes `https://consent.basiq.io/home?token=<token>`, the hosted
//    consent page where the owner picks NAB and consents on NAB's own screens.
//  - POST /users creates a Basiq user (needs an email or mobile).
//  - GET /users/{userId}/connections lists bank connections (status active/pending/invalid/
//    pre-init, an institution reference, and — for open-banking connections only —
//    createdDate/expiryDate/lastUsed).
//  - POST /users/{userId}/connections/{connectionId}/refresh kicks off an async refresh job.
//  - GET /jobs/{jobId} polls a job's steps (verify-credentials, retrieve-accounts,
//    retrieve-transactions), each pending/in-progress/success/failed.
//  - GET /users/{userId}/accounts lists accounts with a live `balance` and `availableFunds`.
//  - GET /users/{userId}/transactions lists transactions, cursor-paginated via `links.next`
//    (a full URL), filterable by `transaction.postDate` and up to 500 rows per page.
// All requests carry `basiq-version: 3.0`.
import { providerKey } from "../provider-config";

const API_BASE = "https://au-api.basiq.io";
const BASIQ_VERSION = "3.0";
const CONSENT_BASE = "https://consent.basiq.io/home";
/** Hard ceiling on transaction pages walked in one sync: 30 pages × 500 rows covers even a
 *  very busy 90-day window without an unbounded loop if Basiq's cursor never terminates. */
const MAX_TRANSACTION_PAGES = 30;

export class BasiqConfigError extends Error {}
export class BasiqApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type BasiqAccount = {
  id: string;
  name: string;
  accountNo: string;
  balance: number;
  availableFunds: number | null;
  currency: string;
  institutionId: string;
  connectionId: string;
  status: string;
  lastUpdated: string;
};

export type BasiqTransaction = {
  id: string;
  accountId: string;
  connectionId: string;
  amount: number;
  direction: "debit" | "credit";
  description: string;
  postDate: string | null;
  transactionDate: string | null;
  status: "pending" | "posted";
  class: string;
};

export type BasiqConnection = {
  id: string;
  status: string;
  institutionId: string;
  method: string;
  createdDate: string | null;
  expiryDate: string | null;
  lastUsed: string | null;
};

export type BasiqJobStep = { title: string; status: "pending" | "in-progress" | "success" | "failed" };
export type BasiqJob = { id: string; steps: BasiqJobStep[] };

const str = (value: unknown, max = 300) => (typeof value === "string" ? value.slice(0, max) : "");
/** Canonical decimal amount. Refuse excess precision/exponents instead of rounding money. */
export function basiqDecimal(value: unknown): string {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^-?(0|[1-9]\d*)(\.\d{1,2})?$/.test(raw) || raw.length > 32) throw new BasiqApiError("Invalid provider money.", 502);
  const [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new BasiqApiError("Provider money exceeds safe range.", 502);
  return `${raw.startsWith("-") && minor ? "-" : ""}${whole}.${fraction.padEnd(2, "0")}`;
}
function moneyNumber(value: unknown): number {
  const decimal = basiqDecimal(value), number = Number(decimal);
  if (number.toFixed(2) !== decimal || basiqDecimal(String(number)) !== decimal) throw new BasiqApiError("Provider money cannot be represented by legacy numeric contract.", 502);
  return number;
}
/** Preserve numeric JSON lexemes before IEEE-754 parsing; quoted strings remain untouched. */
function providerJson(text: string): any {
  try {
    return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (token, number) => number === undefined ? token : JSON.stringify(number)));
  } catch { throw new BasiqApiError("Invalid provider JSON.", 502); }
}
export type BasiqAccountIdentity = Pick<BasiqAccount, "id" | "name" | "currency" | "institutionId" | "connectionId" | "status" | "lastUpdated">;
function mapAccountIdentity(raw: any): BasiqAccountIdentity {
  if (!str(raw?.id) || typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) throw new BasiqApiError("Incomplete account identity.", 502);
  return { id: str(raw.id, 100), name: str(raw.name, 160) || "Account", currency: raw.currency,
    institutionId: str(raw.institution, 40), connectionId: str(raw.connection, 40), status: str(raw.status, 40) || "unknown", lastUpdated: str(raw.lastUpdated, 40) };
}

function mapAccount(raw: any): BasiqAccount {
  const identity = mapAccountIdentity(raw);
  const balance = moneyNumber(raw?.balance);
  return {
    id: str(raw.id, 100),
    name: str(raw.name || raw.accountHolder, 160) || "Account",
    accountNo: str(raw.accountNo, 40),
    balance,
    availableFunds: raw.availableFunds == null ? null : moneyNumber(raw.availableFunds),
    currency: identity.currency,
    institutionId: str(raw.institution, 40),
    connectionId: str(raw.connection, 40),
    status: str(raw.status, 40) || "unknown",
    lastUpdated: str(raw.lastUpdated, 40),
  };
}

function mapTransaction(raw: any): BasiqTransaction {
  const amount = moneyNumber(raw?.amount);
  if (!str(raw?.id) || !["debit", "credit"].includes(raw.direction) || !["pending", "posted"].includes(raw.status)) throw new BasiqApiError("Incomplete transaction record.", 502);
  return {
    id: str(raw.id, 100),
    accountId: str(raw.account, 100),
    connectionId: str(raw.connection, 100),
    amount,
    direction: raw.direction === "debit" ? "debit" : "credit",
    description: str(raw.description, 300),
    postDate: str(raw.postDate, 40) || null,
    transactionDate: str(raw.transactionDate, 40) || null,
    status: raw.status === "pending" ? "pending" : "posted",
    class: str(raw.class, 60),
  };
}

function mapConnection(raw: any): BasiqConnection {
  return {
    id: str(raw?.id, 100),
    status: str(raw?.status, 40) || "unknown",
    institutionId: str(raw?.institution?.id ?? raw?.institution, 40),
    method: str(raw?.method, 40),
    createdDate: str(raw?.createdDate, 40) || null,
    expiryDate: str(raw?.expiryDate, 40) || null,
    lastUsed: str(raw?.lastUsed, 40) || null,
  };
}

export function basiqApiKey(root: string, options: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  return providerKey(root, "BASIQ_API_KEY", options);
}

export type BasiqClientOptions = {
  root: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchFn?: typeof fetch;
  /** Milliseconds; overridable in tests. */
  now?: () => number;
};

/**
 * Creates a Basiq client. The server-access token is cached in memory only (never written to
 * disk) and refreshed a minute before it would expire; concurrent callers share one in-flight
 * refresh instead of racing separate token requests.
 */
export function createBasiqClient(options: BasiqClientOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => Date.now());
  let serverToken: { value: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  function apiKey(): string {
    const key = basiqApiKey(options.root, options);
    if (!key) throw new BasiqConfigError("No Basiq API key configured. Add BASIQ_API_KEY to ~/.config/agentic-os.env.");
    return key;
  }

  async function readError(res: Response): Promise<string> {
    try {
      const json: any = await res.json();
      const detail = json?.data?.[0]?.detail || json?.data?.[0]?.title || json?.message;
      if (typeof detail === "string" && detail) return detail;
    } catch { /* Body was not JSON; fall through to a generic message. */ }
    return `Basiq request failed (${res.status}).`;
  }

  async function requestToken(body: URLSearchParams): Promise<{ token: string; expiresIn: number }> {
    const res = await fetchFn(`${API_BASE}/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${apiKey()}`, "Content-Type": "application/x-www-form-urlencoded", "basiq-version": BASIQ_VERSION },
      body: body.toString(),
      redirect: "error",
    });
    if (!res.ok) throw new BasiqApiError(await readError(res), res.status);
    const json: any = await res.json().catch(() => undefined);
    const token = json?.access_token;
    if (typeof token !== "string" || !token) throw new BasiqApiError("Basiq's token response had no access_token.", res.status);
    const expiresIn = typeof json?.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
    return { token, expiresIn };
  }

  async function serverAccessToken(): Promise<string> {
    if (serverToken && serverToken.expiresAt - 60_000 > now()) return serverToken.value;
    if (!pending) {
      pending = requestToken(new URLSearchParams({ scope: "SERVER_ACCESS" }))
        .then(({ token, expiresIn }) => {
          serverToken = { value: token, expiresAt: now() + expiresIn * 1000 };
          return token;
        })
        .finally(() => { pending = undefined; });
    }
    return pending;
  }

  function checkedUrl(pathOrUrl: string, expectedPath?: string) {
    let url: URL;
    try { url = new URL(pathOrUrl, API_BASE); } catch { throw new BasiqApiError("Invalid provider destination.", 502); }
    if (url.origin !== API_BASE || url.username || url.password || url.hash || (expectedPath && url.pathname !== expectedPath)) throw new BasiqApiError("Blocked provider destination.", 502);
    return url;
  }
  async function call<T>(pathOrUrl: string, init: { method?: string; body?: unknown; query?: Record<string, string | undefined>; expectedPath?: string } = {}): Promise<T> {
    const url = checkedUrl(pathOrUrl, init.expectedPath);
    for (const [key, value] of Object.entries(init.query || {})) if (value !== undefined) url.searchParams.set(key, value);
    const token = await serverAccessToken();
    const res = await fetchFn(url.toString(), {
      method: init.method || "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "basiq-version": BASIQ_VERSION },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: "error",
    });
    if (!res.ok) throw new BasiqApiError(await readError(res), res.status);
    return providerJson(await res.text()) as T;
  }

  async function transactionRows(userId: string, sinceIso: string): Promise<any[]> {
    const expectedPath = `/users/${encodeURIComponent(userId)}/transactions`;
    const results: any[] = [], seen = new Set<string>();
    let next: string | undefined = expectedPath;
    let query: Record<string, string> | undefined = { limit: "500", filter: `transaction.postDate.gte.${sinceIso.slice(0, 10)}` };
    for (let page = 0; page < MAX_TRANSACTION_PAGES && next; page++) {
      const key = checkedUrl(next, expectedPath).href;
      if (seen.has(key)) throw new BasiqApiError("Repeated transaction page.", 502);
      seen.add(key);
      const body: any = await call<any>(next, { query, expectedPath }); query = undefined;
      if (!Array.isArray(body?.data)) throw new BasiqApiError("Incomplete transaction page.", 502);
      results.push(...body.data);
      const link = body?.links?.next;
      if (link != null && (typeof link !== "string" || !link)) throw new BasiqApiError("Invalid transaction cursor.", 502);
      next = link ?? undefined;
      if (next) checkedUrl(next, expectedPath);
    }
    if (next) throw new BasiqApiError("Incomplete transaction snapshot: page limit reached.", 502);
    return results;
  }

  return {
    configured(): boolean {
      return !!basiqApiKey(options.root, options);
    },
    async createUser(input: { email?: string; mobile?: string }): Promise<{ id: string }> {
      if (!input.email && !input.mobile) throw new Error("A Basiq user needs an email address or a mobile number.");
      const result = await call<any>("/users", { method: "POST", body: input });
      if (!str(result?.id)) throw new BasiqApiError("Basiq did not return a user id.", 502);
      return { id: result.id };
    },
    /** The CLIENT_ACCESS token bound to `userId`, exposed only via the ready-to-open consent URL. */
    async consentUrl(userId: string): Promise<string> {
      const { token } = await requestToken(new URLSearchParams({ scope: "CLIENT_ACCESS", userId }));
      return `${CONSENT_BASE}?token=${encodeURIComponent(token)}`;
    },
    async listConnections(userId: string): Promise<BasiqConnection[]> {
      const page = await call<any>(`/users/${encodeURIComponent(userId)}/connections`);
      if (!Array.isArray(page?.data)) throw new BasiqApiError("Incomplete connections page.", 502);
      return page.data.map(mapConnection);
    },
    async refreshConnection(userId: string, connectionId: string): Promise<{ jobId: string }> {
      const result = await call<any>(`/users/${encodeURIComponent(userId)}/connections/${encodeURIComponent(connectionId)}/refresh`, { method: "POST" });
      const jobId = str(result?.id) || str(result?.jobId);
      if (!jobId) throw new BasiqApiError("Basiq did not return a refresh job id.", 502);
      return { jobId };
    },
    async job(jobId: string): Promise<BasiqJob> {
      const result = await call<any>(`/jobs/${encodeURIComponent(jobId)}`);
      const steps = Array.isArray(result?.steps) ? result.steps : [];
      return { id: str(result?.id), steps: steps.map((step: any) => ({ title: str(step?.title, 80), status: str(step?.status, 20) || "pending" })) };
    },
    async listAccounts(userId: string): Promise<BasiqAccount[]> {
      const page = await call<any>(`/users/${encodeURIComponent(userId)}/accounts`);
      if (!Array.isArray(page?.data)) throw new BasiqApiError("Incomplete accounts page.", 502);
      return page.data.map(mapAccount);
    },
    async listAccountIdentities(userId: string): Promise<BasiqAccountIdentity[]> {
      const page = await call<any>(`/users/${encodeURIComponent(userId)}/accounts`);
      if (!Array.isArray(page?.data)) throw new BasiqApiError("Incomplete accounts page.", 502);
      return page.data.map(mapAccountIdentity);
    },
    async listAccountsDecimal(userId: string) {
      const page = await call<any>(`/users/${encodeURIComponent(userId)}/accounts`);
      if (!Array.isArray(page?.data)) throw new BasiqApiError("Incomplete accounts page.", 502);
      return page.data.map((raw: any) => ({ ...mapAccountIdentity(raw), balance: basiqDecimal(raw.balance) })) as Array<BasiqAccountIdentity & { balance: string }>;
    },
    async listTransactionsSinceDecimal(userId: string, sinceIso: string) {
      return (await transactionRows(userId, sinceIso)).map(raw => {
        // Validate non-money fields with a safe stand-in; retain the original decimal exactly.
        const mapped = mapTransaction({ ...raw, amount: "0.00" });
        return { ...mapped, amount: basiqDecimal(raw.amount) };
      });
    },
    /** Pages through every transaction since `sinceIso` (inclusive), newest paging concerns
     *  aside — Basiq's own ordering is preserved. Bounded by MAX_TRANSACTION_PAGES. */
    async listTransactionsSince(userId: string, sinceIso: string): Promise<BasiqTransaction[]> {
      return (await transactionRows(userId, sinceIso)).map(mapTransaction);
    },
  };
}

export type BasiqClient = ReturnType<typeof createBasiqClient>;
