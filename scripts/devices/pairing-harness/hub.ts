import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDevicesService } from "../service";
import { identify } from "../identity";
import { LOGINS, SIMULATED_SERVE, SIMULATED_TAILNET, TAILNET } from "../test-harness";
import { pageTokenFor, pairingTokenFor } from "../../identity/principal";

/**
 * The harness hub: the real /__devices service in the SERVER role, behind a simulated Tailscale Serve. Every request to /__devices and
 * /__token is dressed the way Serve delivers it (the hub's tailnet Host, the Serve origin, a Tailscale-User-Login listed in people.json
 * and the person's own tailnet address), so the browser can stay on plain http://127.0.0.1:<port>. Which person this browser is comes from a
 * non-secret cookie (/__harness/as/<usman|mehroz>), default mehroz. Nothing here reads a real store or any secret.
 */
const INTERNAL_TOKEN = "harness-internal-token";
const SOURCE = { usman: "100.64.0.11", mehroz: "100.64.0.12" } as const;
type Who = keyof typeof SOURCE;

export function harnessMiddleware(dataArg: string, port: number) {
  if (port === 8081) throw new Error("Refusing port 8081 (the live OS).");
  const data = resolve(dataArg);
  if (/[\/]\.operator-data([\/]|$)/i.test(data)) throw new Error("Refusing an .operator-data folder: pass an isolated scratch folder.");
  const root = join(data, "hub-root");
  const dataDir = join(root, ".operator-data");
  mkdirSync(dataDir, { recursive: true });
  process.env.MU_DATA_DIR = dataDir;
  process.env.MU_HUB_ROLE = "server";
  writeFileSync(join(dataDir, "people.json"), JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGINS.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGINS.mehroz] }] }));
  const svc = createDevicesService({ root, hubRole: "server", token: () => INTERNAL_TOKEN, tailnetName: TAILNET, servePeer: SIMULATED_SERVE, tailnet: SIMULATED_TAILNET });
  const idOpts = { root, store: svc.store, tailnetName: TAILNET, servePeer: SIMULATED_SERVE, tailnet: SIMULATED_TAILNET };

  const who = (req: IncomingMessage): Who => (/(?:^|;\s*)mu_harness_as=usman\b/.test(String(req.headers.cookie ?? "")) ? "usman" : "mehroz");
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(value));
  };
  function dress(req: IncomingMessage) {
    const person = who(req);
    req.headers.host = `${TAILNET}:8443`;
    req.headers["tailscale-user-login"] = LOGINS[person];
    req.headers["x-forwarded-for"] = SOURCE[person];
    if (req.headers.origin) req.headers.origin = `https://${TAILNET}:8443`;
  }

  return (req: IncomingMessage, res: ServerResponse, next: (e?: unknown) => void) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path.startsWith("/__harness/as/")) {
      const person = path.endsWith("/usman") ? "usman" : "mehroz";
      res.statusCode = 302;
      res.setHeader("Set-Cookie", `mu_harness_as=${person}; Path=/; SameSite=Lax`);
      res.setHeader("Location", "/");
      return void res.end();
    }
    if (path === "/__harness/console-code") {
      // What `bun scripts/identity/pair-code.ts --for <who>` asks the hub for (a one-time browser code, 10 minutes), without the loopback proof.
      const person = new URL(req.url ?? "/", "http://x").searchParams.get("for") === "usman" ? "usman" : "mehroz";
      return json(res, 200, svc.store.createCode(person, "browser", "usman"));
    }
    if (path === "/__harness/state") {
      const rows = svc.store.sessions().map((s) => ({ person: s.personId, via: s.via, pending: !!s.pending, revoked: !!s.revokedAt, label: s.label }));
      return json(res, 200, { role: "server", sessions: rows });
    }
    if (path === "/__token") {
      dress(req);
      const id = identify(req, idOpts);
      if (id.verified && id.verified.via !== "companion") return json(res, 200, { token: pageTokenFor(id.verified, INTERNAL_TOKEN) });
      if (!id.verified && id.tailnet) return json(res, 200, { token: pairingTokenFor(id.tailnet, INTERNAL_TOKEN), scope: "pairing" });
      return json(res, 401, { error: "Sign in first" });
    }
    if (path.startsWith("/__devices")) {
      dress(req);
      return void svc.handle(req, res);
    }
    next();
  };
}
