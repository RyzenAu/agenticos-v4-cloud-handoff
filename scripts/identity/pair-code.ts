/**
 * Server console: make a one-time code that confirms a founder's first browser (MU_HUB_ROLE=server).
 *
 *   bun scripts/identity/pair-code.ts --for usman [--port 8081]
 *
 * In the server role a browser that pairs with a bare Tailscale login is PENDING (shared access, but not a confirmed
 * human session, so it does not open the server's local-owner routes). Run this on the server (over ssh, say); the founder
 * types the printed code into his browser (the pairing page, "a one-time code"), which then earns a CONFIRMED session.
 *
 * Needs the local-owner proof: it reads the local-owner token file (so only the hub's account, SYSTEM and Administrators
 * can run it) and presents it to the hub over loopback. It prints the code and its lifetime, never the token.
 */
import { localOwnerHeaders } from "./local-owner-token";

export async function makePairCode(person: string, port: number, fetchImpl: typeof fetch = fetch) {
  const origin = `http://127.0.0.1:${port}`;
  const proof = localOwnerHeaders();
  if (!proof["X-MU-Local-Owner"]) throw new Error("Cannot read the local-owner token file (bun scripts/identity/local-owner-token.ts path). Run this as the account that runs the hub.");
  const tokenRes = await fetchImpl(`${origin}/__token`, { headers: proof, signal: AbortSignal.timeout(15_000) });
  const token = ((await tokenRes.json().catch(() => ({}))) as { token?: string }).token;
  if (!tokenRes.ok || !token) throw new Error(`The hub did not accept the local-owner token (HTTP ${tokenRes.status}). Is it running in the server role on port ${port}?`);
  const res = await fetchImpl(`${origin}/__devices/pair/console-code`, {
    method: "POST",
    headers: { ...proof, "Content-Type": "application/json", "X-Claude-OS-Token": token },
    body: JSON.stringify({ personId: person }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { code?: string; expiresAt?: number; error?: string };
  if (!res.ok || !body.code) throw new Error(body.error ?? `HTTP ${res.status}`);
  return { code: body.code, expiresAt: body.expiresAt ?? 0 };
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const person = (arg("for") ?? "").toLowerCase();
  if (!person) {
    console.error("usage: bun scripts/identity/pair-code.ts --for <usman|mehroz> [--port 8081]");
    process.exit(2);
  }
  makePairCode(person, Number(arg("port") ?? process.env.ARGENTIC_PORT ?? 8081))
    .then(({ code, expiresAt }) => {
      const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
      console.log(`One-time code for ${person}: ${code}   (single use, valid about ${minutes} minutes)`);
      console.log("Type it into the pairing page: 'Or a one-time code from one of your paired devices'.");
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
