import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "../ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog";

/**
 * System › Devices and people: the gateway collaborator (Dot). Dot is not a founder and has no device: it signs in through
 * the gateway with a one-time code a founder makes at the hub's console, and that sign-in is an IDENTITY listed here.
 * Revoking it ends every access it holds, at once. Reads /__gateway/admin/access (founders only); the card is absent when
 * no identity exists and the hub does not accept gateway requests.
 */

export type GatewayIdentity = { id: string; label: string; enrolledBy: string; createdAt: number; expiresAt: number; lastRenewedAt: number | null; renewals: number; state: "active" | "revoked" | "expired"; activeSessions: number; lastSeenAt: number | null };
export type GatewayAccess = {
  trust: boolean;
  killSwitch: boolean;
  identities: GatewayIdentity[];
  capabilities: { name: string; what: string; grantedBy: string | null; expiresAt: number | null }[];
  unusedCodes: number;
  canRevoke: boolean;
  /** A confirmed person may renew Dot's identity and grants for 30 days. */
  canRenew?: boolean;
  expiry?: { grants: { capability: string; expiresAt: number; renewSoon: boolean }[]; renewSoon: boolean };
  console: { enrol: string; revoke: string; grant: string };
};
export type GatewayAccessApi = { load(): Promise<GatewayAccess | null>; revoke(id: string): Promise<void>; renew(): Promise<void> };

async function post(request: typeof fetch, path: string) {
  const t = await request("/__token", { credentials: "same-origin" });
  const token = t.ok ? String((await t.json())?.token ?? "") : "";
  const r = await request(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token }, body: "{}" });
  if (!r.ok) throw new Error(String(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That didn't work."));
}

export function createGatewayAccessApi(request: typeof fetch = (...a) => fetch(...a)): GatewayAccessApi {
  return {
    async load() {
      const r = await request("/__gateway/admin/access", { credentials: "same-origin", headers: { Accept: "application/json" } });
      // 403: not a founder's confirmed view; 404: a hub without the gateway routes. Either way there is nothing to show.
      if (!r.ok) return null;
      return (await r.json()) as GatewayAccess;
    },
    async revoke(id) {
      await post(request, `/__gateway/admin/identities/${encodeURIComponent(id)}/revoke`);
    },
    async renew() {
      await post(request, "/__gateway/admin/renew");
    },
  };
}

const card = "min-w-0 rounded-xl border border-border bg-card p-5 text-card-foreground";
const muted = "text-sm leading-6 text-muted-foreground";
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "never");

/** One line that says what an identity is right now, in words. */
export function identityLine(i: GatewayIdentity): string {
  const made = `signed in ${when(i.createdAt)} with a code from ${i.enrolledBy}`;
  if (i.state === "revoked") return `Revoked · ${made}`;
  if (i.state === "expired") return `Expired ${when(i.expiresAt)} · ${made}`;
  return `${i.activeSessions ? `${i.activeSessions} active ${i.activeSessions === 1 ? "session" : "sessions"}` : "No active session"} · last seen ${when(i.lastSeenAt)} · ${made} · expires ${when(i.expiresAt)}`;
}

export function GatewayAccessCard({ api: given, onNotice, onError }: { api?: GatewayAccessApi; onNotice?: (message: string) => void; onError?: (message: string) => void }) {
  const [api] = useState(() => given ?? createGatewayAccessApi());
  const [access, setAccess] = useState<GatewayAccess | null>(null);
  const [confirm, setConfirm] = useState<GatewayIdentity | null>(null);
  const id = useId();

  const refresh = useCallback(async () => {
    try {
      setAccess(await api.load());
    } catch {
      setAccess(null);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!access || (!access.trust && !access.identities.length)) return null;
  const granted = access.capabilities.filter((c) => c.name !== "view");
  const renew = async () => {
    try {
      await api.renew();
      onNotice?.("Renewed Dot's access for 30 days (its sign-in and the capabilities in force).");
      await refresh();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  const revoke = async (identity: GatewayIdentity) => {
    setConfirm(null);
    try {
      await api.revoke(identity.id);
      onNotice?.(`Revoked "${identity.label}". Its access through the gateway ended.`);
      await refresh();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "That didn't work.");
    }
  };

  return (
    <section aria-labelledby={`${id}-t`} className={card} data-testid="gateway-access">
      <h2 id={`${id}-t`} className="text-lg font-semibold">Gateway access (Dot)</h2>
      <p className={`mt-1 max-w-prose ${muted}`}>
        Dot works from its own cloud browser through the gateway. It is not a founder and has no device here: it never reaches your PC, this hub's desktop, approvals or accounts.
        {access.killSwitch ? " The gateway is switched off right now." : !access.trust ? " This hub is not accepting gateway requests." : ""}
      </p>
      {access.identities.length ? (
        <ul className="mt-3 divide-y divide-border text-sm">
          {access.identities.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">{i.label}<span className="ml-2 font-mono text-xs text-muted-foreground">{i.id}</span></p>
                <p className="text-muted-foreground">{identityLine(i)}</p>
              </div>
              {i.state === "active" && access.canRevoke ? <Button size="sm" variant="outline" className="min-h-11" onClick={() => setConfirm(i)}>Revoke</Button> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={`mt-3 ${muted}`}>Dot is not signed in. A founder makes a one-time code at the hub's console: <span className="font-mono text-foreground">{access.console.enrol}</span></p>
      )}
      <p className={`mt-3 ${muted}`}>
        {granted.length ? `Dot may: ${granted.map((c) => c.name).join(", ")}.` : "Dot can only look (read-only)."} Capabilities are granted at the hub's console and always expire.
        {!access.canRevoke && access.identities.some((i) => i.state === "active") ? " Confirm this browser to revoke from here." : ""}
        {access.expiry?.renewSoon ? " Some of Dot's access ends within 7 days." : ""}
      </p>
      {access.canRenew && access.identities.some((i) => i.state === "active") ? (
        <Button size="sm" variant="outline" className="mt-3 min-h-11" onClick={() => void renew()}>Renew 30 days</Button>
      ) : null}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke Dot's access?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2">
                <p>Everything this sign-in holds ends at once: its open pages, its running requests and its reconnect key.</p>
                <p>Jobs Dot already started keep running; stop them from Activity. To let Dot back in, make a new one-time code at the hub's console.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void revoke(confirm)}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export default GatewayAccessCard;
