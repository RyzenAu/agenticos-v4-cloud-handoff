import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";

/**
 * The companion bridge: how a computer that cannot reach the hub's loopback (a WSL2 distro on a NAT network) talks to it,
 * WITHOUT making the hub think the computer is at the hub.
 *
 * A computer's companion connects OUT to `http://<bridge>:<port>`. The bridge listens on ONE interface (the one the computer
 * can see, e.g. the WSL virtual switch), accepts nothing but the companion wire routes, and forwards them to the hub's own
 * loopback port. The forwarded request:
 *   - keeps the companion's Authorization bearer (its token is its whole identity; scripts/devices/identity.ts checks it),
 *   - gets a Host that is NOT a loopback name, so the hub never mistakes it for "Usman at this PC" (the loopback owner),
 *   - loses any Tailscale or forwarding header, so nothing can pose as a tailnet person,
 *   - keeps Origin and Sec-Fetch-*, so the hub still refuses anything that came from a web page.
 * Everything else (every other hub route, including the OS pages and the whole /__operator API) answers 404 here.
 */

export const BRIDGE_ALLOW = /^\/__devices\/companion\/(pair|heartbeat|next|result|progress|observation|goodbye)$/;
const STRIP = /^(tailscale-|x-forwarded-|x-real-ip|forwarded$|via$|cookie$|x-claude-os-token$|x-mu-bridge$)/i;
/** Stamped on every forwarded request (any incoming copy is stripped first). The hub then treats the caller as a bridge client: only a cloud computer's one-time code and token, never a person's. */
export const BRIDGE_HEADER = "x-mu-bridge";

export type BridgeOptions = {
  listenHost: string;
  listenPort: number;
  targetHost?: string;
  targetPort: number;
};

// The Host the hub sees is its own loopback name: a computer's token is accepted only on the hub's own host (identity.ts), and this
// allow-listed hop IS the hub's own host. Forwarding the bridge's address instead made every computer fail to pair (ee28c40).
export function forwardHeaders(incoming: IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || STRIP.test(k) || k.toLowerCase() === "host" || k.toLowerCase() === "connection") continue;
    out[k] = v;
  }
  out.host = host;
  out[BRIDGE_HEADER] = "1";
  return out;
}

export function createBridge(options: BridgeOptions) {
  const targetHost = options.targetHost ?? "127.0.0.1";
  if (options.listenHost === "0.0.0.0" || options.listenHost === "::" || options.listenHost === "") throw new Error("The bridge must listen on one interface, never all of them.");
  let server: Server | null = null;

  const handler: Parameters<typeof createServer>[1] = (req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge.invalid");
    if (!BRIDGE_ALLOW.test(url.pathname) || (req.method !== "GET" && req.method !== "POST")) {
      res.statusCode = 404;
      return void res.end("Not found");
    }
    const upstream = request(
      { host: targetHost, port: options.targetPort, method: req.method, path: `${url.pathname}${url.search}`, headers: forwardHeaders(req.headers, `${targetHost}:${options.targetPort}`) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { "content-type": String(up.headers["content-type"] ?? "application/json"), "cache-control": "no-store" });
        up.pipe(res);
        up.on("error", () => res.destroy());
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "The hub did not answer." }));
    });
    // A companion that hangs up (its long-poll ended) must release the hub's poller, so the hub can re-queue what it was handed.
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  };

  return {
    async start(): Promise<{ host: string; port: number }> {
      if (server) return { host: options.listenHost, port: options.listenPort };
      server = createServer(handler);
      server.requestTimeout = 0;
      server.headersTimeout = 30_000;
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(options.listenPort, options.listenHost, () => resolve());
      });
      const addr = server.address() as { address: string; port: number };
      return { host: addr.address, port: addr.port };
    },
    async close() {
      const s = server;
      server = null;
      if (!s) return;
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}
