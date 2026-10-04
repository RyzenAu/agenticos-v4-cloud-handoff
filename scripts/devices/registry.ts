import type { Presence, TargetDevice } from "./types";

/**
 * The in-process view of every command target: the hub (this PC, always online while this
 * server runs) plus paired companions, with their last heartbeat. The device store
 * (store.ts) persists pairings; this registry adds live presence on top.
 */

export const HEARTBEAT_INTERVAL_MS = 10_000;
/** A companion that has not heart-beaten for this long is offline. */
export const PRESENCE_TTL_MS = 30_000;

export const HUB_DEVICE_ID = "usman-pc";

export function defaultHub(): TargetDevice {
  return {
    id: HUB_DEVICE_ID,
    owner: "usman",
    kind: "hub",
    label: "Usman's PC",
    aliases: ["pc", "desktop", "computer", "nebula", "main pc", "home pc"],
    primary: true,
  };
}

export type DeviceSource = () => TargetDevice[];

export class DeviceRegistry {
  private presence = new Map<string, Presence>();
  private offlineMarks = new Set<string>();

  constructor(
    private readonly source: DeviceSource,
    private readonly now: () => number = Date.now,
    readonly ttlMs = PRESENCE_TTL_MS,
  ) {}

  /** All targets that are neither revoked nor expired. */
  targets(): TargetDevice[] {
    const t = this.now();
    return this.source().filter((d) => !d.revokedAt && !(d.expiresAt !== undefined && d.expiresAt <= t));
  }

  /** Every stored target, including revoked/expired ones (for the UI). */
  all(): TargetDevice[] {
    return this.source();
  }

  get(id: string): TargetDevice | undefined {
    return this.targets().find((d) => d.id === id);
  }

  heartbeat(id: string, info: Omit<Presence, "lastSeen"> = {}) {
    this.offlineMarks.delete(id);
    this.presence.set(id, { ...this.presence.get(id), ...info, lastSeen: this.now() });
  }

  /** A companion said goodbye: offline now, not after the TTL. */
  markOffline(id: string) {
    this.offlineMarks.add(id);
  }

  presenceOf(id: string): Presence | undefined {
    return this.presence.get(id);
  }

  /**
   * Microphone ownership (Track 2): the ONE online companion of this person whose heartbeat says it holds
   * the mic. A voice command from that person's browser originates there. None, or more than one → null
   * (the router then uses the person's primary/only device, or asks which one; never the hub for anyone else).
   */
  micOwner(personId: string): string | null {
    const holders = this.targets().filter((d) => d.owner === personId && d.kind === "companion" && this.isOnline(d) && this.presence.get(d.id)?.micOwned === true);
    return holders.length === 1 ? holders[0].id : null;
  }

  isOnline(device: TargetDevice): boolean {
    const t = this.now();
    if (device.revokedAt || (device.expiresAt !== undefined && device.expiresAt <= t)) return false;
    // The hub is this process: if this code runs, the hub is up.
    if (device.kind === "hub") return true;
    if (this.offlineMarks.has(device.id)) return false;
    const seen = this.presence.get(device.id)?.lastSeen;
    return seen !== undefined && t - seen <= this.ttlMs;
  }
}

/** A registry over a fixed list (tests, and the fallback before the server plugin starts). */
export function staticRegistry(devices: TargetDevice[], now: () => number = Date.now, ttlMs = PRESENCE_TTL_MS) {
  return new DeviceRegistry(() => devices, now, ttlMs);
}

let active: DeviceRegistry | undefined;

/** The server plugin installs the live registry; until then only the hub exists. */
export function setActiveRegistry(registry: DeviceRegistry | undefined) {
  active = registry;
}

export function activeRegistry(): DeviceRegistry {
  if (!active) active = staticRegistry([defaultHub()]);
  return active;
}
