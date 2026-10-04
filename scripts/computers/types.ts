import type { PersonId } from "../devices/types";
import type { ScreenView } from "./screen";

/**
 * Shared agent cloud computers (programme 20261001, Agent F).
 *
 * A computer is a device in the ONE device registry (kind "cloud-computer", owner "shared"), hosted by a provisioning
 * adapter, driven by the same companion worker every PC runs, and used through a CONTROL LEASE: exactly one controller
 * (an agent job or a person) may send it input at a time.
 */

/** starting: coming up. online: idle and ready. busy: a lease is held (agent job or person). asleep: suspended on purpose.
 * offline: stopped on purpose, or not heard from. failed: a process died or a start failed; recover it. */
export type ComputerState = "starting" | "online" | "busy" | "asleep" | "offline" | "failed";
export type DesiredState = "running" | "suspended" | "stopped";

/** Who holds a computer's control lease. */
export type Holder =
  | { kind: "agent"; jobId: string; by: PersonId; agent: string }
  | { kind: "person"; personId: PersonId; session: string };

export type Lease = {
  computerId: string;
  /** Fencing epoch: bumped on every change of holder, so a stale holder's command is refused even if it arrives late. */
  epoch: number;
  holder: Holder;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  /** A person asked for control while an agent holds it: the agent pauses at its next safe step boundary. */
  takeover: { by: PersonId; session: string; requestedAt: number } | null;
  /** While a person holds the computer, the agent job that was paused by it (it resumes on return, same job). */
  paused: { jobId: string; by: PersonId; agent: string; pausedAt: number } | null;
};

export const holderKey = (h: Holder) => (h.kind === "agent" ? `agent:${h.jobId}` : `person:${h.personId}:${h.session}`);

export type ResourceUse = {
  /** Resident memory of everything this computer runs (companion, Xvfb, browser), MB. */
  rssMb: number;
  /** CPU over the last sample, percent of one core. */
  cpuPct: number | null;
  procs: number;
  sampledAt: number;
};

export type ProbeResult = {
  /** Could the host (the WSL distro, the VPS) be reached at all. */
  hostUp: boolean;
  companionAlive: boolean;
  displayAlive: boolean | null;
  vncAlive: boolean | null;
  browserAlive: boolean | null;
  resource: ResourceUse | null;
  at: number;
  error?: string;
};

export type HostCheck = {
  ok: boolean;
  host: string;
  present: string[];
  /** Packages the desktop needs that this host doesn't have. Without them a computer still runs, headless (files, no browser). */
  missing: string[];
  /** The exact command the owner runs to fix `missing` (this code never installs anything). */
  installCommand: string | null;
  notes: string[];
};

export type ComputerSpec = {
  name: string;
  /** X display number (per computer, so no two share one). */
  display: number;
  resolution: string;
  hubUrl: string;
  pairingCode: string;
  label: string;
};

/** What an adapter keeps between calls; saved with the computer's record. No secrets (the token lives only in the computer's own config). */
export type AdapterHandle = Record<string, unknown>;

export type Snapshot = { mime: "image/jpeg" | "image/png"; data: Uint8Array };
export type VncStream = { read: ReadableStream<Uint8Array>; write: WritableStream<Uint8Array>; close(): void };

export interface ProvisioningAdapter {
  readonly kind: string;
  /** What this host has and lacks. Read-only. */
  check(): Promise<HostCheck>;
  /** Create the computer's folders and config, pair its companion with the one-time code, and start it. */
  provision(spec: ComputerSpec): Promise<{ handle: AdapterHandle; desktop: boolean; browser?: boolean }>;
  start(handle: AdapterHandle): Promise<void>;
  /** Stop everything it runs; folders, profile and ledger stay. */
  stop(handle: AdapterHandle): Promise<void>;
  /** Sleep: free the memory, keep the disk. Wake with resume. */
  suspend(handle: AdapterHandle): Promise<void>;
  resume(handle: AdapterHandle): Promise<void>;
  /** Restart what died, without re-pairing and without replaying anything (the ledger is on disk). */
  recover(handle: AdapterHandle): Promise<void>;
  /** Stop and remove the computer's folders. */
  destroy(handle: AdapterHandle): Promise<void>;
  probe(handle: AdapterHandle): Promise<ProbeResult>;
  /** One screen frame, in memory only. Null when this computer has no desktop. */
  snapshot?(handle: AdapterHandle): Promise<Snapshot | null>;
  /** A raw byte stream to the computer's own loopback-only VNC server (no network port on the hub). Null when there is none. */
  openVnc?(handle: AdapterHandle): Promise<VncStream | null>;
  /** Restart ONLY what is not running (display, VNC, companion); what is alive is left alone. Counts as no crash recovery. Absent: `start` is used when it is idempotent. */
  restartLayers?(handle: AdapterHandle): Promise<void>;
  /** Tell the computer a person holds it (its companion then leaves the browser alone: no watchdog restart, nothing reopened under them) or no longer does. */
  setHold?(handle: AdapterHandle, held: boolean): Promise<void>;
  /** Optional: install a headless browser for this host without root (only when the owner asks). */
  installBrowser?(): Promise<void>;
  /**
   * Optional: a person's terminal on this computer, run as the computer's OWN user (a computer without one is refused with the reason). The caller
   * (scripts/computers/terminal.ts) has already checked the confirmed person and the control lease.
   */
  openTerminal?(handle: AdapterHandle, size: { cols: number; rows: number }): Promise<import("./terminal").TerminalProcess | { refused: string }>;
  close?(): Promise<void> | void;
}

export type ComputerView = {
  name: string;
  /** The device id once paired (null while starting). */
  id: string | null;
  label: string;
  kind: "cloud-computer";
  owner: "shared";
  adapter: string;
  state: ComputerState;
  desired: DesiredState;
  desktop: boolean;
  /** A browser is installed (the distro's chromium, or a headless one installed for the host): page steps and snapshots work even with no desktop. */
  browser: boolean;
  capabilities: string[] | null;
  assigned: { agent: string; jobId: string; by: PersonId; title: string } | null;
  controller: { kind: "agent" | "person" | null; who: string | null; jobId: string | null; expiresAt: number | null; epoch: number | null };
  takeoverPending: { by: PersonId; requestedAt: number } | null;
  paused: { jobId: string; agent: string } | null;
  /** The newest job this hub started on this computer (running or finished), so a finished job's result stays reachable. Null when none since the hub started. */
  lastJob: { jobId: string; title: string; agent: string; by: PersonId } | null;
  resource: ResourceUse | null;
  lastSeen: number | null;
  failure: { at: number; reason: string } | null;
  recoveries: number;
  createdBy: PersonId;
  createdAt: number;
  viewer: { snapshot: boolean; vnc: boolean };
  /** Per requester (set only on a response made for a browser session): THIS window holds the controls. */
  heldByThisSession?: boolean;
  /** Per requester: the same person holds the controls in ANOTHER window (this one is view-only until "Take them here"). */
  heldByYouElsewhere?: boolean;
  /** Screen truth (always sent by the hub; optional only so older payloads and fixtures still type-check): which layer of the screen is failing (host, display, VNC, viewer, frame, blank), when, and the next action. Ready only with a recent real frame or a screenshot that came back. */
  screen?: ScreenView;
  /** (Always sent by the hub.) Online (or busy) AND, for a computer with a screen, the screen is ready or a job is working on it. Surfaces that say "ready" use this, never `state` alone. */
  usable?: boolean;
};

/** What the hub sends: the view with the screen truth always present. */
export type HubComputerView = ComputerView & { screen: ScreenView; usable: boolean };
