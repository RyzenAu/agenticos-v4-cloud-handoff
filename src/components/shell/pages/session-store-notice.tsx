// R8 F: when the sign-in records file (sign-ins, pairing, companions) can't be read, the hub refuses every write to it rather than replacing it.
// Without this the owner saw only "Something went wrong." on pairing. /__health names the condition; this shows it on the System page.
import { useQuery } from "@tanstack/react-query";
import { Notice } from "@/components/ds";
import { fetchSessionStoreHealth, type SessionStoreHealth } from "@/lib/session-store-health";

export function SessionStoreNotice({ health }: { health: SessionStoreHealth | null | undefined }) {
  if (!health || health.status !== "failed") return null;
  return (
    <Notice
      tone="danger"
      title="Sign-in records can't be read — nothing will be overwritten"
      className="mb-6"
    >
      {health.detail} {health.recovery ?? ""}
    </Notice>
  );
}

export function SessionStoreHealthNotice() {
  const q = useQuery({
    queryKey: ["system", "session-store"],
    queryFn: () => fetchSessionStoreHealth(),
    staleTime: 60_000,
    retry: false,
  });
  return <SessionStoreNotice health={q.data} />;
}
