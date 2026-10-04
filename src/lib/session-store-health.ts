// R8 F: the sign-in records condition from GET /__health (scripts/cloud/health.ts, components.sessionStore).
export type SessionStoreHealth = { status: string; detail: string; recovery?: string };

/** GET /__health answers 503 when a component failed; the body is still the report. Anything else (401, offline) gives null. */
export async function fetchSessionStoreHealth(
  fetchImpl: typeof fetch = fetch,
): Promise<SessionStoreHealth | null> {
  const res = await fetchImpl("/__health", { headers: { Accept: "application/json" } });
  if (res.status !== 200 && res.status !== 503) return null;
  const body = (await res.json().catch(() => null)) as {
    components?: { sessionStore?: SessionStoreHealth };
  } | null;
  return body?.components?.sessionStore ?? null;
}
