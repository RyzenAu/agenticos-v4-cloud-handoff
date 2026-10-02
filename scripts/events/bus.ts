// The activity bus (programme S-stream): one in-process, bounded, monotonic log of NOTIFICATIONS about what
// the OS is doing (job and step updates, agent messages, computer and device availability, control leases,
// approval changes). It never runs anything: a producer publishes "this changed", a subscriber is told.
//
// Properties the stream route builds on (all unit-tested in stream.test.ts):
//   - ids are monotonic per boot, and the wire id is `<epoch>:<n>`; a restart is a new epoch, so a client's
//     old Last-Event-ID can never be mistaken for a position in the new log (it gets a fresh snapshot);
//   - the ring is bounded (default 500); an id older than the ring, or from another epoch, or ahead of the
//     head, cannot be replayed, and `since` says so (null) so the caller sends a snapshot instead;
//   - each entry carries a scope (`shared` or one person), applied by the caller per connection;
//   - the frame is serialised once at publish time and capped, so a slow or huge payload can't grow the ring.
import { randomBytes } from "node:crypto";

export type PersonId = "usman" | "mehroz";
/** Who may receive an event: every verified founder, or only one person (their own devices). */
export type Scope = "shared" | PersonId;
export type Topic = "job" | "approval" | "computer" | "lease" | "device" | "agent" | "jarvis" | "thread";

export type PublishInput = {
  topic: Topic;
  /** Short event name inside the topic ("job", "step", "receipt", "message", "online", ...). */
  type: string;
  scope: Scope;
  /** A job or agent reached its end: the finished result a late client must not miss. */
  final?: boolean;
  data: unknown;
};
export type Entry = { id: number; at: number; topic: Topic; type: string; scope: Scope; final: boolean; frame: string; bytes: number };

export const RING_CAPACITY = 500;
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export const wireId = (epoch: string, n: number) => `${epoch}:${n}`;
const WIRE = /^([a-z0-9]{6,16}):(\d{1,12})$/;
/** Parse a Last-Event-ID; null when it is malformed. */
export function parseWireId(value: unknown): { epoch: string; n: number } | null {
  const m = typeof value === "string" ? WIRE.exec(value.trim()) : null;
  return m ? { epoch: m[1], n: Number(m[2]) } : null;
}

export class ActivityBus {
  readonly epoch: string;
  private ring: Entry[] = [];
  private nextId = 1;
  private listeners = new Set<(e: Entry) => void>();
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: { capacity?: number; epoch?: string; now?: () => number } = {}) {
    this.capacity = Math.max(1, options.capacity ?? RING_CAPACITY);
    this.epoch = options.epoch ?? randomBytes(5).toString("hex");
    this.now = options.now ?? Date.now;
  }

  /** Append a notification. A payload over the cap is replaced by a stub that tells the client to refetch. */
  publish(input: PublishInput): Entry {
    const id = this.nextId++;
    const at = this.now();
    const envelope = (data: unknown, truncated?: true) => JSON.stringify({ id, at, topic: input.topic, type: input.type, final: input.final === true, ...(truncated ? { truncated } : {}), data });
    let json: string;
    try {
      json = envelope(input.data);
      if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) json = envelope(null, true);
    } catch {
      json = envelope(null, true);
    }
    const entry: Entry = {
      id,
      at,
      topic: input.topic,
      type: input.type,
      scope: input.scope,
      final: input.final === true,
      frame: `id: ${wireId(this.epoch, id)}\ndata: ${json}\n\n`,
      bytes: Buffer.byteLength(json),
    };
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    for (const l of [...this.listeners]) {
      try {
        l(entry);
      } catch {
        /* a listener never breaks a producer */
      }
    }
    return entry;
  }

  head(): number {
    return this.nextId - 1;
  }

  /** The id of the oldest entry still replayable (head + 1 when the ring is empty). */
  oldest(): number {
    return this.ring[0]?.id ?? this.nextId;
  }

  /**
   * Entries after `afterId` that `allow` accepts, or null when they cannot be replayed faithfully: the id is
   * ahead of the head, or older than the ring (some entries after it were dropped).
   */
  since(afterId: number, allow: (e: Entry) => boolean = () => true): Entry[] | null {
    if (!Number.isInteger(afterId) || afterId < 0 || afterId > this.head()) return null;
    if (afterId < this.oldest() - 1) return null;
    return this.ring.filter((e) => e.id > afterId && allow(e));
  }

  subscribe(listener: (e: Entry) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

/** Does an event with this scope reach this person? */
export const reaches = (scope: Scope, person: PersonId) => scope === "shared" || scope === person;
