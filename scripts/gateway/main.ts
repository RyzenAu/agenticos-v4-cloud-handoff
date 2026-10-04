/**
 * Start the Dot gateway:
 *
 *   bun scripts/gateway/main.ts
 *
 * Environment (names only; values are never printed):
 *   MU_GATEWAY_PUBLIC_ORIGIN   required. The one origin browsers use, e.g. https://ryzen-pc.tailnet-name.ts.net
 *   MU_GATEWAY_PORT            default 8092 (8090 and 8091 are taken on Ryzen: the Hermes gateway and another listener). Always bound to 127.0.0.1.
 *   MU_GATEWAY_UPSTREAM        default http://127.0.0.1:8081. Must be loopback.
 *   MU_GATEWAY_FORWARDED_FOR   "1" to take the client address from the LAST X-Forwarded-For entry (rate limits and audit only).
 *                              Default OFF: what Tailscale Funnel puts in that header is UNVERIFIED, so behind Funnel every
 *                              client looks like 127.0.0.1 and sign-in relies on the per-code limit instead.
 *   MU_GATEWAY_UI_DIR          the built UI (dist/client from scripts/gateway/build-ui.ts, with its manifest). Unset: API only.
 *   MU_DATA_DIR                the hub's data directory; the gateway keeps its files in <data>/gateway.
 *
 * This script only listens on loopback. It never turns on Funnel, a tunnel or a firewall rule.
 */
import { resolve } from "node:path";
import { gatewayDir } from "./config";
import { startGateway } from "./server";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

if (import.meta.main) {
  const env = process.env;
  const publicOrigin = (env.MU_GATEWAY_PUBLIC_ORIGIN ?? "").trim();
  if (!publicOrigin) {
    console.error("MU_GATEWAY_PUBLIC_ORIGIN is required (the one https origin browsers will use).");
    process.exit(2);
  }
  try {
    const gateway = startGateway({
      dir: gatewayDir(REPO_ROOT, env),
      port: Number(env.MU_GATEWAY_PORT ?? 8092),
      upstream: (env.MU_GATEWAY_UPSTREAM ?? "http://127.0.0.1:8081").trim(),
      publicOrigin,
      forwardedFor: env.MU_GATEWAY_FORWARDED_FOR === "1",
      ...(env.MU_GATEWAY_UI_DIR?.trim() ? { uiDir: env.MU_GATEWAY_UI_DIR.trim() } : {}),
      ...(env.MU_GATEWAY_RECHECK_MS ? { recheckMs: Math.max(50, Number(env.MU_GATEWAY_RECHECK_MS)) } : {}),
    });
    const stop = () => void gateway.stop().finally(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (error) {
    console.error(`gateway did not start: ${(error as Error).message}`);
    process.exit(1);
  }
}
