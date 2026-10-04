/**
 * A SYNTHETIC stand-in for the OS routes scripts/memory/t6-verify-live.ts drives, so the script itself can be
 * run end to end in tests: never 8081, never the pilot, never the real vault.
 *
 *   GET  /memory/vault     a page load: mints the browser session cookie (mu_session)
 *   GET  /__token          the page token
 *   GET  /__devices/me     who the session is: B1's principal (actor) and whether the hub session is pending
 *   *    /__memory/*       the REAL memory routes (plugin.ts memoryMiddleware) over the test harness's api:
 *                          a TEMP copy of the mini-wiki, a TEMP state dir and the FAKE Hindsight in proxy mode
 *
 * `session: "pending"` plays S1: the page load's session isn't confirmed, so the caller is the owner's
 * PROCESS (a program: its forget needs a person's approval and would text a Telegram code, captured by the
 * harness in `h.telegram`). `session: "confirmed"` is the owner's confirmed browser (actor human, a session
 * key: the Memory page's card button works). `refuseCards` makes /approvals/card answer 403, to leave a
 * forget unapproved.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { memoryMiddleware } from "../plugin";
import { agentOf, setup, usman, type Harness } from "./harness";

export type SyntheticOs = {
  port: number;
  h: Harness;
  /** Every request path the script sent to the OS, in order ("POST /__memory/forget", ...). */
  requests: string[];
  stop: () => Promise<void>;
};

export async function startSyntheticOs(opts: { session: "confirmed" | "pending"; refuseCards?: boolean }): Promise<SyntheticOs> {
  const h = await setup({ proxy: true });
  const token = randomBytes(16).toString("hex");
  const cookie = randomBytes(16).toString("hex");
  const requests: string[] = [];
  const hasSession = (req: IncomingMessage) => String(req.headers.cookie ?? "").split(/;\s*/).includes(`mu_session=${cookie}`);
  const human = (req: IncomingMessage) => hasSession(req) && opts.session === "confirmed";
  const mw = memoryMiddleware({
    api: () => h.api,
    // At this PC: the loopback owner. Human only with the confirmed session's cookie; else his process.
    principalFor: (req) => (human(req as IncomingMessage) ? usman : agentOf(usman)),
    tokenOk: (req) => (req as IncomingMessage).headers["x-claude-os-token"] === token,
  });
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://synthetic-os");
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/memory/vault") {
      res.setHeader("Set-Cookie", `mu_session=${cookie}; Path=/; HttpOnly; SameSite=Strict`);
      res.setHeader("Content-Type", "text/html");
      return res.end("<!doctype html><title>Memory</title>");
    }
    if (url.pathname === "/__token") return json(res, 200, { token });
    if (url.pathname === "/__devices/me")
      return json(res, 200, {
        authorised: true,
        via: "loopback-owner",
        principal: { personId: "usman", via: "loopback-owner", actor: human(req) ? "human" : "process", displayName: "Usman" },
        local: true,
        hubSession: hasSession(req) ? { pending: opts.session === "pending" } : null,
      });
    if (url.pathname.startsWith("/__memory")) {
      if (opts.refuseCards && url.pathname === "/__memory/approvals/card") return json(res, 403, { ok: false, reason: "refused by the test" });
      req.url = req.url!.slice("/__memory".length) || "/";
      return mw(req as never, res, () => json(res, 404, { error: "Not found" }));
    }
    json(res, 404, { error: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    h,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
