import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevicesService, type DevicesService } from "./service";
import { pageTokenFor } from "../identity/principal";
import { syntheticTailnetForTests } from "../remote-access";

/**
 * A real /__devices server on loopback with synthetic people, for tests only.
 * Tailscale Serve is simulated the way it really arrives: a loopback socket, the tailnet Host,
 * a Tailscale-User-Login header and the tailnet source Serve stamps in X-Forwarded-For (another
 * node's address, never this hub's own: REVIEW-S1 R2-1).
 */

export const TAILNET = "hub.tail-test.ts.net";
/** The hub's own tailnet address in the synthetic tailnet (a Serve request from it is the self-loop: REVIEW-S1 R2-1). */
export const HUB_TAILNET_IP = "100.64.0.1";
/** Tailscale's `status` simulated: this hub owns HUB_TAILNET_IP; every other tailnet address is another node. */
export const SIMULATED_TAILNET = syntheticTailnetForTests(TAILNET, [HUB_TAILNET_IP]);
export const PAGE_TOKEN = "synthetic-page-token";
export const LOGINS = { usman: "owner@example.test", mehroz: "partner@example.test", stranger: "stranger@example.test" } as const;

/**
 * Tailscale Serve simulated over a plain loopback socket: the headers are believed. The real check
 * (identity/serve-peer.ts: the socket's peer is tailscaled in session 0) is tested on its own.
 */
export const SIMULATED_SERVE = () => true;

export type Who = "local" | "usman" | "mehroz" | "stranger";
/** Each remote person's own device on the tailnet (Serve's X-Forwarded-For). */
const TAILNET_SOURCE: Record<Exclude<Who, "local">, string> = { usman: "100.64.0.11", mehroz: "100.64.0.12", stranger: "100.64.0.13" };

export async function startHub(opts: { start?: number; maxWaitMs?: number; observeWaitMs?: number; hubRole?: "pc" | "cloud" | "server" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "devices-hub-"));
  mkdirSync(join(root, ".operator-data"));
  writeFileSync(
    join(root, ".operator-data", "people.json"),
    JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGINS.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGINS.mehroz] }] }),
  );
  let t = opts.start ?? Date.now();
  const clock = { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
  const svc: DevicesService = createDevicesService({ root, token: PAGE_TOKEN, tailnetName: TAILNET, servePeer: SIMULATED_SERVE, tailnet: SIMULATED_TAILNET, now: clock.now, maxWaitMs: opts.maxWaitMs ?? 2_000, observeWaitMs: opts.observeWaitMs, hubRole: opts.hubRole ?? "pc" });
  const server: Server = createServer((req, res) => void svc.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  function headersFor(who: Who): Record<string, string> {
    if (who === "local") return { host: `127.0.0.1:${port}` };
    return { host: `${TAILNET}:8443`, "tailscale-user-login": LOGINS[who], "x-forwarded-for": TAILNET_SOURCE[who] };
  }

  // The owner's own browser at this PC holds a confirmed hub session (the gate mints it on his first
  // page load). REVIEW-S1 F1: device and session administration needs that human session; a local
  // program with no cookie is only a process. One session per hub, shared by every "local" browser.
  let ownerHubCookie: string | null = null;
  const ownerCookie = () => (ownerHubCookie ??= encodeURIComponent(svc.store.mintSession("usman", "This PC's browser", "hub").cookie));

  /** A browser: remembers its own cookies, sends the page token on writes. `program`: a local caller with no browser session. */
  function browser(who: Who, opts: { program?: boolean } = {}) {
    const jar = new Map<string, string>();
    if (who === "local" && !opts.program) jar.set("mu_session", ownerCookie());
    async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
      const headers: Record<string, string> = { ...headersFor(who), ...extra };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      if (method !== "GET") {
        headers["content-type"] = "application/json";
        // Each browser sends its OWN page token (Stage B1): the internal one at this PC, a
        // person-bound one over the tailnet (what GET /__token hands that person).
        headers["x-claude-os-token"] ??= who === "local" ? PAGE_TOKEN : pageTokenFor({ personId: who === "stranger" ? "mehroz" : who, via: "tailnet-person" }, PAGE_TOKEN);
      }
      const res = await fetch(`${base}/__devices${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      for (const c of setCookies) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        const k = pair.slice(0, eq);
        const v = pair.slice(eq + 1);
        if (/Max-Age=0/.test(c) || !v) jar.delete(k);
        else jar.set(k, v);
      }
      return { status: res.status, json: (await res.json().catch(() => ({}))) as any, setCookies };
    }
    return { who, jar, call, get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}, extra?: Record<string, string>) => call("POST", p, b, extra) };
  }

  async function close() {
    svc.close();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }

  return { root, svc, base, port, clock, headersFor, browser, close };
}

export type Hub = Awaited<ReturnType<typeof startHub>>;
