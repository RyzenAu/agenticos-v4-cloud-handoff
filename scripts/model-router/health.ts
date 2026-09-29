// scripts/model-router/health.ts — what the router knows about each model and provider right now.
//
// Two writers: the router (a real call hit a limit or failed) and the zero-cost probes (a list read).
// One small JSON file, so the Models page and a restarted server see the same facts. Nothing here
// holds a key, a prompt or raw provider error text: states, times, HTTP statuses and short
// sanitised details only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type HealthState = "ok" | "limited" | "exhausted" | "down" | "unlisted" | "unknown";

export type ModelHealth = {
  state: HealthState;
  /** A limited/exhausted/down model is skipped until this time (ISO), when known. */
  until: string | null;
  lastProbe: { at: string; method: string; result: string } | null;
  lastFailure: { at: string; errorCode: string; httpStatus: number | null } | null;
  detail: string | null;
};

export type ProviderHealth = {
  lastProbe: { at: string; method: string; result: string } | null;
  /** Provider-reported balance or allowance, verbatim numbers only; null when unreadable. */
  balance: {
    amountUsd: number | null;
    limitUsd: number | null;
    asOf: string;
    source: string;
  } | null;
  failure: { at: string; errorCode: string; detail: string } | null;
};

export type HealthFile = {
  models: Record<string, ModelHealth>;
  providers: Record<string, ProviderHealth>;
  updatedAt: string | null;
};

export const healthFile = (root: string) =>
  join(root, ".operator-data", "model-router", "health.json");

const EMPTY_MODEL: ModelHealth = {
  state: "unknown",
  until: null,
  lastProbe: null,
  lastFailure: null,
  detail: null,
};
const EMPTY_PROVIDER: ProviderHealth = { lastProbe: null, balance: null, failure: null };

export interface HealthStore {
  model(id: string): ModelHealth;
  provider(id: string): ProviderHealth;
  markModel(id: string, patch: Partial<ModelHealth>): void;
  markProvider(id: string, patch: Partial<ProviderHealth>): void;
  snapshot(): HealthFile;
}

/** Skip this model now? (limited/exhausted/down with a future or unknown `until`; unlisted always.) */
export function unavailableReason(h: ModelHealth, now: number): string | null {
  if (h.state === "unlisted") return h.detail ?? "no longer listed by the provider";
  if (h.state === "limited" || h.state === "exhausted" || h.state === "down") {
    if (h.until && Date.parse(h.until) <= now) return null;
    const until = h.until
      ? ` until ${new Date(h.until).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`
      : "";
    return `${h.state}${until}${h.detail ? ` (${h.detail})` : ""}`;
  }
  return null;
}

export class MemoryHealthStore implements HealthStore {
  protected data: HealthFile;
  constructor(initial?: Partial<HealthFile>) {
    this.data = {
      models: { ...(initial?.models ?? {}) },
      providers: { ...(initial?.providers ?? {}) },
      updatedAt: initial?.updatedAt ?? null,
    };
  }
  model(id: string) {
    return { ...EMPTY_MODEL, ...this.data.models[id] };
  }
  provider(id: string) {
    return { ...EMPTY_PROVIDER, ...this.data.providers[id] };
  }
  markModel(id: string, patch: Partial<ModelHealth>) {
    // Read first: a subclass's model() may reload `this.data`, so never hold the old object across it.
    const next = { ...this.model(id), ...patch };
    this.data.models[id] = next;
    this.touch();
  }
  markProvider(id: string, patch: Partial<ProviderHealth>) {
    const next = { ...this.provider(id), ...patch };
    this.data.providers[id] = next;
    this.touch();
  }
  snapshot(): HealthFile {
    return JSON.parse(JSON.stringify(this.data));
  }
  protected touch() {
    this.data.updatedAt = new Date().toISOString();
  }
}

/** File-backed store: re-read on every access (small file), written atomically. */
export class FileHealthStore extends MemoryHealthStore {
  constructor(private file: string) {
    super(FileHealthStore.read(file));
  }
  static read(file: string): Partial<HealthFile> | undefined {
    try {
      if (!existsSync(file)) return undefined;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  private reload() {
    const fresh = FileHealthStore.read(this.file);
    if (fresh)
      this.data = {
        models: { ...(fresh.models ?? {}) },
        providers: { ...(fresh.providers ?? {}) },
        updatedAt: fresh.updatedAt ?? null,
      };
  }
  override model(id: string) {
    this.reload();
    return super.model(id);
  }
  override provider(id: string) {
    this.reload();
    return super.provider(id);
  }
  override snapshot() {
    this.reload();
    return super.snapshot();
  }
  override markModel(id: string, patch: Partial<ModelHealth>) {
    this.reload();
    super.markModel(id, patch);
    this.save();
  }
  override markProvider(id: string, patch: Partial<ProviderHealth>) {
    this.reload();
    super.markProvider(id, patch);
    this.save();
  }
  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      renameSync(tmp, this.file);
    } catch {
      /* health is advisory; a failed write never fails a model call */
    }
  }
}

export function routerHealthStore(root: string): HealthStore {
  return new FileHealthStore(healthFile(root));
}
