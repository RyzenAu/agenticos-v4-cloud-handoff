// Mount GET /__events (and /__events/snapshot) on the hub: one authenticated SSE stream (programme S-stream).
// Identity is B1's: the gate has classified the route as shared; the handler resolves the same principal.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import { activeRegistry } from "../devices/registry";
import { requestPrincipal } from "../identity/gate";
import { jobsRuntime } from "../jobs/runtime";
import { ActivityBus } from "./bus";
import { startActivitySources, type ActivitySources, type ComputersLike } from "./sources";
import { createStream } from "./stream";
import { gatewayStreamPrincipal } from "../gateway/events";

/** The sources plus control of the open streams (shutdown, and tests that drop the network on purpose). */
export type ActivityHandle = ActivitySources & { closeStreams(): void; openStreams(): number };
const instances = new Map<string, ActivityHandle>();

/** The running activity sources for a repo root (so other server code can publish hints), if mounted. */
export function activityFor(root: string): ActivityHandle | undefined {
  return instances.get(root);
}

export function mountActivityStream(server: ViteDevServer, options: { root: string; computers?: ComputersLike | null }): ActivityHandle {
  const bus = new ActivityBus();
  const sources = startActivitySources({
    bus,
    registry: () => activeRegistry() as never,
    jobs: () => jobsRuntime(options.root).jobs as never,
    approvals: () => jobsRuntime(options.root).approvals as never,
    computers: options.computers ?? null,
  });
  const stream = createStream({
    bus,
    resolvePrincipal: (req: IncomingMessage) => {
      const p = requestPrincipal(req as never, { root: options.root }) as { personId?: string; via?: string } | null;
      // The Dot gateway's principal follows the stream too, but "dot" is nobody's person scope: it only ever receives
      // shared-scope events (bus.ts reaches), never a founder's own devices or conversations.
      // And of those, only the topics its allowed pages need (scripts/gateway/events.ts): coding job events, nothing else.
      if (p && p.via === "gateway") return gatewayStreamPrincipal(p.personId as never, () => sources.snapshot(p.personId as never));
      return p && (p.personId === "usman" || p.personId === "mehroz") ? { personId: p.personId } : null;
    },
    snapshot: (person) => sources.snapshot(person),
  });
  const handle: ActivityHandle = Object.assign(sources, { closeStreams: () => stream.closeAll(), openStreams: () => stream.openCount() });
  instances.set(options.root, handle);
  server.middlewares.use("/__events", (req: IncomingMessage, res: ServerResponse) => {
    // Connect strips the mount point; hand the handler the full target ("/" and "/?last=x" are the stream itself).
    const rest = req.url ?? "/";
    req.url = `/__events${rest === "/" ? "" : rest.startsWith("/?") ? rest.slice(1) : rest}`;
    stream.handle(req, res);
  });
  server.httpServer?.once("close", () => {
    stream.closeAll();
    sources.stop();
    instances.delete(options.root);
  });
  return handle;
}
