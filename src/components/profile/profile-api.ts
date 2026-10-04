/**
 * Browser client for /__devices (scripts/devices/service.ts). Writes carry the page token from
 * /__token; cookies are HttpOnly and handled by the browser.
 */

export type PersonId = "usman" | "mehroz";
export type Permissions = { business: boolean; memory: string[]; finance: boolean; devices: "own" | "none" };
export type SessionView = {
  id: string; personId: PersonId; label: string; via: "tailnet" | "code" | "hub";
  createdAt: number; expiresAt: number; lastSeen: number; revoked: boolean; expired: boolean; current: boolean;
  /** A browser waiting to be confirmed: at this PC (AUDIT-A1-3), or paired with a bare Tailscale login on a server hub. */
  pending?: boolean;
  /** Where a pending Tailscale browser paired from (tailnet address and node), for whoever approves it. */
  source?: string;
  /** Pending Tailscale browser: a short code, returned only to that browser itself (its own page); approving needs it typed from there. Never in the list another session sees. */
  matchCode?: string;
};

/**
 * The exact console command that makes a one-time code on a server hub (scripts/identity/pair-code.ts). It needs the hub's own
 * account, so it is run ON Ryzen-PC, the hub (a terminal there, or over ssh); run anywhere else it makes a code the hub will not accept. The code is never shown to a browser that asks.
 */
export const HUB_CONSOLE_DIR = "C:\\mu-hub\\AgenticOS-v4";
export const consoleCodeCommand = (personId: PersonId | string | null | undefined) =>
  `bun scripts/identity/pair-code.ts --for ${personId === "mehroz" ? "mehroz" : "usman"} --port 8081`;
export type Me = {
  authorised: boolean;
  via: "loopback" | "session" | "tailnet" | "companion" | null;
  person: { id: PersonId; name: string } | null;
  /** The one verified principal (Stage B1); `displayName` is personalisation only, from people.json. */
  principal?: { personId: PersonId; via: "loopback-owner" | "paired-session" | "tailnet-person" | "companion"; actor: "human" | "process"; displayName: string } | null;
  displayAs: PersonId | null;
  sharedOnly: boolean;
  local: boolean;
  session: SessionView | null;
  /** This browser at the PC: confirmed, or waiting for a code a person types into it (REVIEW-S1 F2b). */
  hubSession?: { pending: boolean } | null;
  /**
   * Server hub: THIS browser's own session that a bare Tailscale login opened and nobody has confirmed yet. It is not a session
   * the hub trusts (me.session stays null); it exists so the page can say what is missing instead of offering to pair again.
   */
  waitingSession?: SessionView | null;
  /** Where the hub runs; "server" is the always-on Ryzen hub, where a Tailscale login alone is never confirmed. */
  hubRole?: "pc" | "cloud" | "server";
  canSelfPair: boolean;
  people: { id: PersonId; name: string }[];
  permissions: Permissions;
};
export type DeviceView = {
  id: string; owner: PersonId | "shared"; kind: "hub" | "companion" | "cloud-computer"; label: string; aliases: string[]; primary: boolean;
  online: boolean; lastSeen: number | null; micOwned: boolean | null; busy: boolean;
  pairedAt: number | null; expiresAt: number | null; revoked: boolean;
};
export type PairResult = { paired: true; pending?: boolean; needsApproval?: boolean; session: SessionView };
export type DevicesView = { devices: DeviceView[]; people: { id: PersonId; name: string; online: boolean; lastSeen: number | null }[] };

export class ProfileApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ProfileApi = ReturnType<typeof createProfileApi>;

export function createProfileApi(base = "/__devices", request: typeof fetch = (...a) => fetch(...a)) {
  let token: string | null = null;
  async function pageToken() {
    if (token !== null) return token;
    try {
      const r = await request("/__token", { credentials: "same-origin" });
      token = r.ok ? String((await r.json())?.token ?? "") : "";
    } catch {
      token = "";
    }
    return token;
  }
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      const t = await pageToken();
      if (t) headers["X-Claude-OS-Token"] = t;
    }
    const r = await request(`${base}${path}`, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new ProfileApiError(String((json as { error?: string; reason?: string })?.error ?? (json as { reason?: string })?.reason ?? `Request failed (${r.status})`), r.status);
    return json as T;
  }
  return {
    me: () => call<Me>("GET", "/me"),
    devices: () => call<DevicesView>("GET", "/devices"),
    sessions: () => call<{ sessions: SessionView[] }>("GET", "/sessions"),
    pickName: (personId: PersonId | null) => call<{ displayAs: PersonId; sharedOnly: boolean }>("POST", "/name", { personId }),
    // Pairing can turn a pairing-only token into a signed-in one: fetch a fresh page token afterwards.
    pairWithTailnet: (label: string) => call<PairResult>("POST", "/pair/tailnet", { label }).finally(() => (token = null)),
    redeemCode: (code: string, label: string) => call<PairResult>("POST", "/pair/redeem", { code, label }).finally(() => (token = null)),
    /** A confirmed browser of the same person confirms a pending Tailscale browser (server hub). */
    approveSession: (sessionId: string, matchCode: string) => call<{ approved: SessionView }>("POST", "/sessions/approve", { sessionId, matchCode }),
    createCode: (purpose: "browser" | "companion", personId?: PersonId) => call<{ code: string; expiresAt: number; personId: PersonId; purpose: string }>("POST", "/pair/code", { purpose, personId }),
    /** This pending browser at the PC confirms itself with a code a person typed in. */
    confirmBrowser: (code: string) => call<{ confirmed: SessionView }>("POST", "/sessions/confirm", { code }).finally(() => (token = null)),
    /** On a browser Usman already uses: a one-time code to type into the new one. */
    createConfirmCode: () => call<{ code: string; expiresAt: number }>("POST", "/sessions/confirm-code", {}),
    revokeSession: (sessionId: string, requireCode = false) => call<{ revoked: string }>("POST", "/sessions/revoke", { sessionId, requireCode }),
    revokeDevice: (deviceId: string) => call<{ revoked: string }>("POST", "/devices/revoke", { deviceId }),
  };
}
