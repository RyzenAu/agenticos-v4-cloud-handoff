// Who is signed in, from the devices service (GET /__devices/me): loopback at this PC is Usman; a
// paired session or companion is whoever its Tailscale login proves. A typed or picked name is
// personalisation only and never replaces this (owner decision V7).
import { useQuery } from "@tanstack/react-query";

export type SignedIn = { id: string; name: string; via: string | null };

export function signedInFrom(me: unknown): SignedIn | null {
  const m = me as {
    authorised?: boolean;
    via?: string | null;
    person?: { id?: unknown; name?: unknown } | null;
    principal?: { personId?: unknown; via?: unknown; displayName?: unknown } | null;
  } | null;
  if (!m?.authorised) return null;
  // Stage B1: the display name comes from the verified principal (people.json), never a picked name.
  const p = m.principal;
  if (p && typeof p.displayName === "string" && p.displayName.trim())
    return { id: String(p.personId ?? ""), name: p.displayName.trim().slice(0, 40), via: typeof p.via === "string" ? p.via : m.via ?? null };
  if (!m.person || typeof m.person.name !== "string" || !m.person.name.trim()) return null;
  return { id: String(m.person.id ?? ""), name: m.person.name.trim().slice(0, 40), via: m.via ?? null };
}

/** Is this browser one opened at the PC but not yet confirmed with a code? (`hubSession.pending` in GET /__devices/me.) */
export function pendingFrom(me: unknown): boolean {
  return (me as { hubSession?: { pending?: unknown } | null } | null)?.hubSession?.pending === true;
}

/**
 * Pending, or only a bare tailnet login (principal via "tailnet-person", actor "process"): neither can approve or change owner data until
 * it is confirmed with a code, and the hub refuses those reads and writes with 403 needs-human-session.
 */
export function unconfirmedFrom(me: unknown): boolean {
  const p = (me as { principal?: { via?: unknown; actor?: unknown } | null } | null)?.principal;
  return pendingFrom(me) || (p?.via === "tailnet-person" && p?.actor !== "human");
}

function useMe() {
  return useQuery({
    queryKey: ["devices", "me"],
    queryFn: async () => {
      const res = await fetch("/__devices/me", { headers: { Accept: "application/json" } });
      if (!res.ok) return { signedIn: null, pending: false };
      const me = await res.json().catch(() => null);
      return { signedIn: signedInFrom(me), pending: unconfirmedFrom(me) };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSignedIn(): SignedIn | null {
  return useMe().data?.signedIn ?? null;
}

/** True while this browser still needs its confirm code: it cannot approve anything until then. */
export function useBrowserPending(): boolean {
  return useMe().data?.pending ?? false;
}
