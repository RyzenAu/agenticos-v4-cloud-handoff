// GET /__events: the ONE authenticated server-sent event stream (programme S-stream).
//
//   - Auth first: the identity gate has already classified /__events as shared (any verified founder); the
//     handler resolves the same principal again and answers 401 without one. A person only ever receives
//     events whose scope reaches them (shared business events, plus their own devices' events).
//   - On connect: a `hello` frame, then EITHER a replay of everything after the client's Last-Event-ID (header,
//     or `?last=` for a client that reconnects by hand), when this boot's ring still covers it, OR a fresh
//     `snapshot` frame built from the durable stores (jobs, approvals) and live state (computers, devices).
//     A restart is a new epoch, so an old id always lands on a snapshot: no completion state is missed.
//   - Events are NOTIFICATIONS ONLY. There is no write path here and nothing in this module can start, resume
//     or retry work, so replaying the same events twice cannot duplicate anything.
//   - Cleanup: the listener, the heartbeat timer and the slot are released on close, error, finish, a failed
//     write or a slow consumer; there is nothing left after the last connection goes.
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseWireId, reaches, wireId, type ActivityBus, type Entry, type PersonId } from "./bus";

export const HEARTBEAT_MS = 15_000;
/** A live stream re-checks that its session is still valid this often (a revoked session or device ends the stream). */
export const RECHECK_MS = 60_000;
/** ...and before delivering an event when the last check is older than this. */
export const DELIVERY_RECHECK_MS = 5_000;
export const MAX_STREAMS_PER_PERSON = 8;
export const MAX_STREAMS_TOTAL = 24;
export const MAX_BUFFERED_BYTES = 512 * 1024;

/** `allow` and `snapshot` narrow a connection further than scope does (the Dot gateway's principal: scripts/gateway/events.ts). */
export type StreamPrincipal = { personId: PersonId; allow?: (e: Entry) => boolean; snapshot?: () => unknown } | null;
export type StreamOptions = {
  bus: ActivityBus;
  resolvePrincipal: (req: IncomingMessage) => StreamPrincipal;
  /** The snapshot for one person (synchronous, so it and the subscription are taken in the same tick). */
  snapshot: (person: PersonId) => unknown;
  heartbeatMs?: number;
  recheckMs?: number;
  deliveryRecheckMs?: number;
  maxPerPerson?: number;
  maxTotal?: number;
  maxBufferedBytes?: number;
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

/** The one shared guard for every /__events request: GET only, same-origin, signed in. */
export function createStream(options: StreamOptions) {
  const { bus } = options;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const deliveryRecheckMs = options.deliveryRecheckMs ?? DELIVERY_RECHECK_MS;
  const maxPerPerson = options.maxPerPerson ?? MAX_STREAMS_PER_PERSON;
  const maxTotal = options.maxTotal ?? MAX_STREAMS_TOTAL;
  const maxBuffered = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const open = new Map<ServerResponse, PersonId>();

  const frame = (event: string, data: unknown, id?: string) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  /** GET /__events/snapshot: the same payload as a snapshot frame, for a slow safety poll. Same auth, same scope. */
  function snapshotRoute(req: IncomingMessage, res: ServerResponse) {
    const principal = guard(req, res);
    if (!principal) return;
    json(res, 200, { epoch: bus.epoch, head: bus.head(), ...((principal.snapshot ? principal.snapshot() : options.snapshot(principal.personId)) as object) });
  }

  function guard(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD") return void json(res, 405, { error: "GET only" });
    if (req.headers["sec-fetch-site"] === "cross-site") return void json(res, 403, { error: "Cross-site request blocked" });
    const host = String(req.headers.host ?? "");
    if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return void json(res, 403, { error: "Unknown origin" });
    const principal = options.resolvePrincipal(req);
    if (!principal) return void json(res, 401, { error: "Sign in to follow live activity." });
    return principal;
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__events/snapshot") return snapshotRoute(req, res);
    if (url.pathname !== "/__events") return json(res, 404, { error: "Unknown events route" });
    const principal = guard(req, res);
    if (!principal) return;
    const person = principal.personId;
    const allowed = (e: Entry) => reaches(e.scope, person) && (principal.allow ? principal.allow(e) : true);
    const mine = [...open.values()].filter((p) => p === person).length;
    if (open.size >= maxTotal || mine >= maxPerPerson) {
      res.setHeader("Retry-After", "10");
      return json(res, 429, { error: "Too many live streams open; close another tab." });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    req.socket?.setNoDelay?.(true);
    req.socket?.setKeepAlive?.(true);

    let closed = false;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const release = () => {
      if (closed) return;
      closed = true;
      off?.();
      if (timer) clearInterval(timer);
      open.delete(res);
    };
    const write = (text: string) => {
      if (closed) return;
      try {
        res.write(text);
        // A consumer that doesn't read is dropped, not buffered: it reconnects and replays (or snapshots).
        if (res.writableLength > maxBuffered) {
          release();
          res.end();
        }
      } catch {
        release();
      }
    };
    open.set(res, person);
    req.on("close", release);
    res.on("close", release);
    res.on("error", release);
    req.on("error", release);

    // Everything below is synchronous: the replay or snapshot and the subscription are one tick, so no
    // event can fall in the gap between them.
    const last = parseWireId(req.headers["last-event-id"] ?? url.searchParams.get("last"));
    const replay = last && last.epoch === bus.epoch ? bus.since(last.n, allowed) : null;
    write(`retry: 3000\n${frame("hello", { epoch: bus.epoch, head: bus.head(), mode: replay ? "replay" : "snapshot", heartbeatMs })}`);
    if (replay) {
      for (const e of replay) write(e.frame);
    } else {
      write(frame("snapshot", { epoch: bus.epoch, head: bus.head(), ...((principal.snapshot ? principal.snapshot() : options.snapshot(person)) as object) }, wireId(bus.epoch, bus.head())));
    }
    if (closed) return; // dropped while writing the opening frames (a consumer that cannot keep up)
    // Authorised at connect AND kept authorised: a revoked session, a revoked device or a changed identity ends the stream.
    let checkedAt = Date.now();
    let recheckTimer: ReturnType<typeof setInterval> | undefined;
    const stillSignedIn = () => {
      checkedAt = Date.now();
      let p: StreamPrincipal = null;
      try {
        p = options.resolvePrincipal(req);
      } catch {
        p = null;
      }
      if (p && p.personId === person) return true;
      release();
      if (recheckTimer) clearInterval(recheckTimer);
      try {
        res.end();
      } catch {
        /* gone */
      }
      return false;
    };
    off = bus.subscribe((e) => {
      if (!allowed(e)) return;
      if (Date.now() - checkedAt >= deliveryRecheckMs && !stillSignedIn()) return;
      write(e.frame);
    });
    timer = setInterval(() => write(frame("ping", { t: Date.now() })), heartbeatMs);
    timer.unref?.();
    recheckTimer = setInterval(() => void stillSignedIn(), recheckMs);
    recheckTimer.unref?.();
    req.on("close", () => recheckTimer && clearInterval(recheckTimer));
    res.on("close", () => recheckTimer && clearInterval(recheckTimer));
  }

  return {
    handle,
    openCount: () => open.size,
    /** Hub shutdown: end every stream (clients reconnect to whatever comes next). */
    closeAll() {
      for (const res of [...open.keys()]) {
        try {
          res.end();
        } catch {
          /* gone */
        }
      }
    },
  };
}
export type ActivityStream = ReturnType<typeof createStream>;
