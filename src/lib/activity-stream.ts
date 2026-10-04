// The browser side of /__events (programme S-stream): one connection per BROWSER, not per component or tab.
//
//   ActivityClient   one EventSource with our own reconnect: exponential backoff, capped at 30 s, with jitter
//                    (so two founders' tabs don't retry in lockstep after a hub restart); resumes from the last
//                    id it saw (`?last=`), so the server replays what was missed, or sends a fresh snapshot when
//                    it can't (too old, or a new boot). A watchdog treats three missed heartbeats as a dead
//                    connection and reconnects, which is what makes a hub that vanished show offline in seconds.
//   ActivityHub      leader election across tabs (Web Locks): one tab holds the stream and relays every message
//                    over a BroadcastChannel; the others just listen. Why: the dev hub speaks HTTP/1.1, where a
//                    browser allows 6 connections per origin, so one stream per tab would starve a fourth tab's
//                    own fetches. When the leader tab closes, its lock is released and another tab takes over
//                    (and gets a snapshot, so nothing it missed is lost). Without Locks/BroadcastChannel a tab
//                    simply leads for itself.
//
// Events are notifications: a handler may refetch or fold state, it never starts work, so receiving an event twice
// (a replay, a poll that overlaps) is harmless. Everything here is injectable so it is tested without a browser.

export type ActivityTopic = "job" | "approval" | "computer" | "lease" | "device" | "agent" | "jarvis" | "thread" | "crm";
export type ActivityEvent = { id: number; at: number; topic: ActivityTopic; type: string; final: boolean; truncated?: boolean; data: any };
export type ActivitySnapshot = {
  epoch: string;
  head: number;
  jobs: any[];
  jobsHead: number;
  approvals: any[];
  computers: any[];
  devices: any[];
  at: number;
};
export type ActivityMessage = { kind: "event"; event: ActivityEvent } | { kind: "snapshot"; snapshot: ActivitySnapshot };
export type ConnectionState = "idle" | "connecting" | "open" | "retrying";
export type ActivityStatus = { state: ConnectionState; lastSignalAt: number; attempts: number; everOpened: boolean; /** When the connection was lost (0 while it is up): the HUD shows offline once this is old enough. */ lostAt: number };

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** The server pings every 15 s; three missed pings and the connection is declared dead. */
export const WATCHDOG_MS = 45_000;
/** retryNow() is a nudge, not a loop: never more than one connect attempt per this long, whatever calls it. */
export const RETRY_NOW_MIN_GAP_MS = 2_000;

/** Pure: delay before reconnect attempt `attempt` (0-based): 1 s, 2 s, 4 s ... capped at 30 s, then 50-100% of that (jitter). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
  return Math.round(base * (0.5 + 0.5 * Math.min(1, Math.max(0, random()))));
}

export type SourceLike = {
  close(): void;
  addEventListener(type: string, listener: (e: { data?: string; lastEventId?: string }) => void): void;
};
export type ClientDeps = {
  url?: string;
  createSource?: (url: string) => SourceLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  random?: () => number;
  now?: () => number;
  watchdogMs?: number;
};

export class ActivityClient {
  private source: SourceLike | null = null;
  private reconnectTimer: unknown;
  private watchdog: unknown;
  private lastId = "";
  private lastConnectAt = -Infinity;
  private running = false;
  private status: ActivityStatus = { state: "idle", lastSignalAt: 0, attempts: 0, everOpened: false, lostAt: 0 };
  private messageListeners = new Set<(m: ActivityMessage) => void>();
  private statusListeners = new Set<(s: ActivityStatus) => void>();
  private signalListeners = new Set<() => void>();
  private readonly deps: Required<ClientDeps>;

  constructor(deps: ClientDeps = {}) {
    this.deps = {
      url: deps.url ?? "/__events",
      createSource: deps.createSource ?? ((url) => new EventSource(url) as unknown as SourceLike),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((id) => clearTimeout(id as number)),
      random: deps.random ?? Math.random,
      now: deps.now ?? Date.now,
      watchdogMs: deps.watchdogMs ?? WATCHDOG_MS,
    };
  }

  getStatus(): ActivityStatus {
    return this.status;
  }
  onMessage(l: (m: ActivityMessage) => void) {
    this.messageListeners.add(l);
    return () => void this.messageListeners.delete(l);
  }
  onStatus(l: (s: ActivityStatus) => void) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }
  /** Any frame from the server, a heartbeat included: proof the hub is alive. */
  onSignal(l: () => void) {
    this.signalListeners.add(l);
    return () => void this.signalListeners.delete(l);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }
  stop() {
    this.running = false;
    this.teardown();
    this.setStatus({ state: "idle" });
  }
  /** Connect now, skipping the backoff (the tab came back into view, the network came back). */
  retryNow() {
    if (!this.running || this.status.state === "open" || this.status.state === "connecting") return;
    if (this.deps.now() - this.lastConnectAt < RETRY_NOW_MIN_GAP_MS) return;
    if (this.reconnectTimer !== undefined) this.deps.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connect();
  }

  private setStatus(patch: Partial<ActivityStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of [...this.statusListeners]) l(this.status);
  }
  private teardown() {
    if (this.reconnectTimer !== undefined) this.deps.clearTimer(this.reconnectTimer);
    if (this.watchdog !== undefined) this.deps.clearTimer(this.watchdog);
    this.reconnectTimer = this.watchdog = undefined;
    try {
      this.source?.close();
    } catch {
      /* already closed */
    }
    this.source = null;
  }
  private armWatchdog() {
    if (this.watchdog !== undefined) this.deps.clearTimer(this.watchdog);
    this.watchdog = this.deps.setTimer(() => this.fail(), this.deps.watchdogMs);
  }
  private signal() {
    this.setStatus({ lastSignalAt: this.deps.now() });
    this.armWatchdog();
    for (const l of [...this.signalListeners]) l();
  }
  private connect() {
    this.teardown();
    if (!this.running) return;
    this.lastConnectAt = this.deps.now();
    this.setStatus({ state: "connecting" });
    const url = this.lastId ? `${this.deps.url}?last=${encodeURIComponent(this.lastId)}` : this.deps.url;
    let src: SourceLike;
    try {
      src = this.deps.createSource(url);
    } catch {
      return this.fail();
    }
    this.source = src;
    const mine = () => this.source === src;
    src.addEventListener("open", () => {
      if (mine()) this.armWatchdog();
    });
    src.addEventListener("hello", () => {
      if (!mine()) return;
      // Open, and the attempt counter resets. A snapshot answer means the position we held is gone: the
      // snapshot frame that follows replaces it; a replay answer just delivers what was missed.
      this.setStatus({ state: "open", attempts: 0, everOpened: true, lostAt: 0 });
      this.signal();
    });
    src.addEventListener("ping", () => mine() && this.signal());
    src.addEventListener("snapshot", (e) => {
      if (!mine()) return;
      this.signal();
      if (e.lastEventId) this.lastId = e.lastEventId;
      const snapshot = parse(e.data) as ActivitySnapshot | null;
      if (snapshot) this.emit({ kind: "snapshot", snapshot });
    });
    src.addEventListener("message", (e) => {
      if (!mine()) return;
      this.signal();
      if (e.lastEventId) this.lastId = e.lastEventId;
      const event = parse(e.data) as ActivityEvent | null;
      if (event) this.emit({ kind: "event", event });
    });
    src.addEventListener("error", () => mine() && this.fail());
  }
  private emit(m: ActivityMessage) {
    for (const l of [...this.messageListeners]) {
      try {
        l(m);
      } catch {
        /* one consumer never stops the others */
      }
    }
  }
  private fail() {
    if (!this.running) return;
    this.teardown();
    const delay = backoffDelay(this.status.attempts, this.deps.random);
    this.setStatus({ state: "retrying", attempts: this.status.attempts + 1, lostAt: this.status.lostAt || this.deps.now() });
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}

function parse(text: string | undefined): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// --- the hub: one connection per browser ---------------------------------------------------------------------

type Wire = { t: "msg"; msg: ActivityMessage } | { t: "status"; status: ActivityStatus } | { t: "signal"; at: number } | { t: "hello" };
export type HubDeps = {
  client?: ActivityClient;
  /** Web Locks `request(name, cb)`: the callback runs while this tab holds the lock. */
  lock?: ((name: string, cb: () => Promise<void>) => Promise<unknown>) | null;
  channel?: { postMessage(m: Wire): void; onmessage: ((e: { data: Wire }) => void) | null; close(): void } | null;
  now?: () => number;
};
export const LOCK_NAME = "agenticos-activity-leader";
export const CHANNEL_NAME = "agenticos-activity";
/** The stream counts as healthy while the hub has spoken (a heartbeat is enough) within this window. */
export const HEALTHY_WINDOW_MS = 40_000;

export class ActivityHub {
  private status: ActivityStatus = { state: "idle", lastSignalAt: 0, attempts: 0, everOpened: false, lostAt: 0 };
  private lastSnapshot: ActivitySnapshot | null = null;
  private listeners = new Set<(m: ActivityMessage) => void>();
  private statusListeners = new Set<() => void>();
  private users = 0;
  private leader = false;
  private releaseLock: (() => void) | undefined;
  private lockRequested = false;
  private readonly client: ActivityClient;
  private readonly channel: HubDeps["channel"];
  private readonly lock: HubDeps["lock"];
  private readonly now: () => number;

  constructor(deps: HubDeps = {}) {
    this.client = deps.client ?? new ActivityClient();
    this.now = deps.now ?? Date.now;
    this.channel = deps.channel === undefined ? (typeof BroadcastChannel !== "undefined" ? (new BroadcastChannel(CHANNEL_NAME) as never) : null) : deps.channel;
    this.lock =
      deps.lock === undefined
        ? typeof navigator !== "undefined" && (navigator as { locks?: LockManager }).locks
          ? (name, cb) => (navigator as Navigator).locks.request(name, { mode: "exclusive" }, cb)
          : null
        : deps.lock;
    if (this.channel)
      this.channel.onmessage = (e) => {
        const w = e.data;
        if (this.leader) {
          if (w.t === "hello") {
            // A tab that just opened asks the leader for what it has now.
            this.channel!.postMessage({ t: "status", status: this.status });
            if (this.lastSnapshot) this.channel!.postMessage({ t: "msg", msg: { kind: "snapshot", snapshot: this.lastSnapshot } });
          }
          return;
        }
        if (w.t === "msg") this.dispatch(w.msg);
        else if (w.t === "status") this.setStatus(w.status);
        else if (w.t === "signal") this.setStatus({ ...this.status, lastSignalAt: w.at });
      };
    this.client.onMessage((m) => {
      if (m.kind === "snapshot") this.lastSnapshot = m.snapshot;
      this.dispatch(m);
      this.channel?.postMessage({ t: "msg", msg: m });
    });
    this.client.onStatus((s) => {
      this.setStatus(s);
      this.channel?.postMessage({ t: "status", status: s });
    });
    this.client.onSignal(() => this.channel?.postMessage({ t: "signal", at: this.client.getStatus().lastSignalAt }));
  }

  private dispatch(m: ActivityMessage) {
    for (const l of [...this.listeners]) {
      try {
        l(m);
      } catch {
        /* isolated */
      }
    }
  }
  private setStatus(s: ActivityStatus) {
    this.status = s;
    for (const l of [...this.statusListeners]) l();
  }

  isLeader() {
    return this.leader;
  }
  getStatus() {
    return this.status;
  }
  /** True while the stream is the reliable source: connected and the hub has spoken recently. */
  healthy(): boolean {
    return this.status.state === "open" && this.now() - this.status.lastSignalAt < HEALTHY_WINDOW_MS;
  }
  /** Down for good measure: never opened, or lost and not back. Used to fall back to polling at the old rate. */
  down(): boolean {
    return !this.healthy();
  }
  subscribe(l: (m: ActivityMessage) => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  onStatus(l: () => void) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }
  /** The newest snapshot this tab knows (the leader's, relayed to followers). */
  snapshot() {
    return this.lastSnapshot;
  }
  /** Reconnect now (skip the backoff) if this tab leads and is waiting to retry. A successful poll is proof the hub is back. */
  retryNow() {
    if (this.leader) this.client.retryNow();
  }

  /** Reference-counted: the first user starts the stream (or queues for leadership), the last one stops it. */
  acquire(): () => void {
    // The owner's switch back to plain polling (and how "before" is measured): localStorage "mu-activity-stream" = "off".
    if (streamDisabled()) return () => {};
    this.users++;
    if (this.users === 1) {
      this.begin();
      this.watchPage();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.users = Math.max(0, this.users - 1);
      if (this.users === 0) this.end();
    };
  }
  private unwatch: (() => void) | undefined;
  /** The tab came back into view or the network came back: a leader that is waiting out a backoff reconnects now. */
  private watchPage() {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const nudge = () => {
      if (typeof document.visibilityState === "string" && document.visibilityState === "hidden") return;
      this.retryNow();
    };
    document.addEventListener("visibilitychange", nudge);
    window.addEventListener("online", nudge);
    this.unwatch = () => {
      document.removeEventListener("visibilitychange", nudge);
      window.removeEventListener("online", nudge);
    };
  }
  private begin() {
    if (!this.lock) {
      this.leader = true;
      this.client.start();
      return;
    }
    this.channel?.postMessage({ t: "hello" });
    if (this.lockRequested) return;
    this.lockRequested = true;
    const settled = () => {
      this.lockRequested = false;
      if (this.users > 0 && !this.leader) this.begin();
    };
    void this.lock(LOCK_NAME, () => {
      if (this.users === 0) return Promise.resolve();
      this.leader = true;
      this.client.start();
      // Hold the lock until this hub is released (or the tab closes, which releases it for the next tab).
      return new Promise<void>((resolve) => {
        this.releaseLock = () => {
          this.leader = false;
          this.client.stop();
          resolve();
        };
      });
    }).then(settled, settled);
  }
  private end() {
    this.unwatch?.();
    this.unwatch = undefined;
    if (this.leader && !this.lock) {
      this.leader = false;
      this.client.stop();
    }
    this.releaseLock?.();
    this.releaseLock = undefined;
  }
}

/** True when this browser has switched the live stream off; every poll then runs at its old rate. */
export function streamDisabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("mu-activity-stream") === "off";
  } catch {
    return false;
  }
}

let shared: ActivityHub | undefined;
/** This browser tab's hub (created lazily, so server rendering and tests never open anything). */
export function activityHub(): ActivityHub {
  if (!shared) shared = new ActivityHub();
  return shared;
}
/** For tests. */
export function setActivityHub(hub: ActivityHub | undefined) {
  shared = hub;
}
