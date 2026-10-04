import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import { isPersonId, type PersonId } from "../devices/types";
import type { AdapterHandle, DesiredState } from "./types";

/** What the hub remembers about each shared computer (computers.json in the data directory). No token, no pairing code. */
export type ComputerRecord = {
  name: string;
  adapter: string;
  createdBy: PersonId;
  createdAt: number;
  label: string;
  display: number;
  resolution: string;
  desired: DesiredState;
  desktop: boolean;
  /** A browser is installed on the host (desktop chromium or a headless one). */
  browser?: boolean;
  /** The device id once its companion has paired (a device in the ONE registry). */
  deviceId?: string;
  handle: AdapterHandle;
  startedAt?: number;
  everOnline?: boolean;
  failure?: { at: number; reason: string };
  recoveries: number;
  /** Automatic recoveries since it was last healthy: the cap on them (maxAutoRecoveries) counts THIS, so a computer that recovered well keeps its full allowance. `recoveries` stays the lifetime count. */
  recoveryStreak?: number;
  lastRecoveredAt?: number;
  destroyedAt?: number;
};

type FileShape = { version: 1; computers: ComputerRecord[] };

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class ComputerStore {
  readonly file: string;
  constructor(root: string, file?: string) {
    this.file = file ?? join(dataDirFor(root), "computers", "computers.json");
  }

  private read(): ComputerRecord[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<FileShape>;
      return (Array.isArray(raw.computers) ? raw.computers : []).filter((c): c is ComputerRecord => !!c && typeof c.name === "string" && NAME.test(c.name) && isPersonId(c.createdBy));
    } catch {
      return [];
    }
  }

  private write(list: ComputerRecord[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, computers: list } satisfies FileShape, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): ComputerRecord[] {
    return this.read().filter((c) => !c.destroyedAt);
  }

  get(name: string): ComputerRecord | undefined {
    return this.list().find((c) => c.name === name);
  }

  put(record: ComputerRecord) {
    const all = this.read().filter((c) => c.name !== record.name);
    this.write([...all, record]);
  }

  patch(name: string, fn: (r: ComputerRecord) => void): ComputerRecord | undefined {
    const all = this.read();
    const row = all.find((c) => c.name === name && !c.destroyedAt);
    if (!row) return undefined;
    fn(row);
    this.write(all);
    return row;
  }

  /** The next X display number nobody uses (per computer, so no two share a screen). */
  nextDisplay(): number {
    const used = new Set(this.read().filter((c) => !c.destroyedAt).map((c) => c.display));
    // MU_COMPUTERS_DISPLAY_BASE lets two hubs share one Linux host without sharing screens (default 101).
    const base = Number(process.env.MU_COMPUTERS_DISPLAY_BASE) || 101;
    for (let d = base; d < base + 199; d++) if (!used.has(d)) return d;
    throw new Error("No free display numbers.");
  }
}

export const validComputerName = (name: unknown): name is string => typeof name === "string" && NAME.test(name);
