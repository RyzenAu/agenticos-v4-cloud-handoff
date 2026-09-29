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

export function useSignedIn(): SignedIn | null {
  const q = useQuery({
    queryKey: ["devices", "me"],
    queryFn: async () => {
      const res = await fetch("/__devices/me", { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      return signedInFrom(await res.json().catch(() => null));
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  return q.data ?? null;
}
