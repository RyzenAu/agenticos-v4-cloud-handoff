// Startup gate (T8b, review T8 S-6). A few facts every request path needs are looked up once, when the
// server starts: the CLI paths (`where claude`, ...), this PC's tailnet name (`tailscale status`, which
// the identity check reads on EVERY request) and the version's dirty flag (`git status`). They used to
// be looked up synchronously by the first request that needed them, freezing the whole server for up
// to 8 s. Now they run as async children at startup, and requests that arrive before they land wait
// for them (without blocking anything else), bounded by `capMs`. After that the gate is a no-op.
import type { Plugin } from "vite";

type Next = (err?: unknown) => void;

export function startupGate(ready: () => Promise<unknown>, capMs = 10_000) {
  let open = false;
  let settled: Promise<void> | null = null;
  const start = () =>
    (settled ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, capMs);
      (timer as { unref?: () => void }).unref?.();
      Promise.resolve()
        .then(ready)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    }).then(() => {
      open = true;
    }));
  return {
    start,
    get open() {
      return open;
    },
    middleware(req: { url?: string }, _res: unknown, next: Next) {
      // Only the /__* API routes need the lookups; Vite's own page and module requests never wait (review T8b nit).
      if (open || !String(req.url ?? "").startsWith("/__")) return next();
      void start().then(() => next());
    },
  };
}

/** Registers the gate first in the dev server and starts the lookups there (never during `vite build`). */
export function startupGatePlugin(ready: () => Promise<unknown>, capMs?: number): Plugin {
  return {
    name: "startup-gate",
    configureServer(server) {
      const gate = startupGate(ready, capMs);
      void gate.start();
      server.middlewares.use(gate.middleware);
    },
  };
}
