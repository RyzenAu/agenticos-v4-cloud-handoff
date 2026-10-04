/**
 * Shared types for people, devices and command targets (Wave 2 devices track).
 *
 * Two people use Agentic OS: Usman (owner, runs the hub on his PC) and Mehroz (co-founder).
 * A "target" is a machine that can execute desktop/browser actions: the hub itself, or a
 * paired companion worker on someone's own PC. Browsers are never targets; they are sessions.
 */

export const PERSON_IDS = ["usman", "mehroz"] as const;
export type PersonId = (typeof PERSON_IDS)[number];

export function isPersonId(value: unknown): value is PersonId {
  return typeof value === "string" && (PERSON_IDS as readonly string[]).includes(value);
}

/** "Usman" / " MEHROZ " → "usman" / "mehroz"; anything else → null. */
export function normalisePersonId(value: unknown): PersonId | null {
  const id = String(value ?? "").trim().toLowerCase();
  return isPersonId(id) ? id : null;
}

export type TargetKind = "hub" | "companion" | "cloud-computer";

/**
 * Who owns a device. A person (a personal PC: only that person may control it) or `shared`: a cloud computer both
 * founders may control and take over (scripts/computers). `shared` is never a PersonId, so every existing
 * `device.owner === person` check fails closed for it; only code that means to allow it does.
 */
export const SHARED_OWNER = "shared" as const;
export type DeviceOwner = PersonId | typeof SHARED_OWNER;

export type TargetDevice = {
  id: string;
  owner: DeviceOwner;
  kind: TargetKind;
  /** Human label, e.g. "Usman's PC" or "Mehroz's laptop". */
  label: string;
  /** Words a person may say to name it ("pc", "laptop", "study"). */
  aliases: string[];
  /** The owner's default device when a command names none. */
  primary?: boolean;
  pairedAt?: number;
  /** Hard expiry of the companion's pairing (ms epoch). Hubs never expire. */
  expiresAt?: number;
  revokedAt?: number;
};

export type Presence = {
  lastSeen: number;
  micOwned?: boolean;
  busy?: boolean;
  /** The companion worker's own version (what the running program says it is). */
  version?: string;
  /** Executors this companion runs (from its allow-list), as reported by its own heartbeat. */
  capabilities?: string[];
  /** Whether an interactive, unlocked desktop session is available right now (null: this worker can't tell). */
  interactive?: boolean | null;
};

/** The contract other tracks code against (WAVE2-CONTRACT.md). */
export type ResolveContext = {
  personId: string;
  spokenTarget?: string;
  /** Optional: the device the request came from (a companion relaying its own voice command). */
  originDeviceId?: string;
};

export type ResolveResult =
  | { ok: true; deviceId: string; owner: DeviceOwner; online: boolean }
  | { ok: false; reason: string; deviceId?: string };

/** A shared agent cloud computer (kind cloud-computer, owner shared): both founders may use it. */
export function isSharedComputer(device: Pick<TargetDevice, "kind" | "owner">): boolean {
  return device.kind === "cloud-computer" && device.owner === SHARED_OWNER;
}
