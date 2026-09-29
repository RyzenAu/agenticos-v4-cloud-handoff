// System page wording from measured data only (pure, so bun can test it). A timing the server
// didn't report is "unavailable", never a remembered default.

/** GET /__dev_restart (scripts/dev-restart-policy.ts). `quietMs`/`maxDeferMs` are absent on older servers. */
export type RestartState = {
  pending: boolean;
  waitingFor: string[];
  requestedAt: string | number | null;
  restartsAfter: string | null;
  quietMs?: number;
  maxDeferMs?: number;
};

/** GET /__operator/capabilities. `firstBuildAfterMs` (null = background jobs off) only when the server reports it. */
export type Capabilities = {
  generatedAt: string | null;
  capabilities: { id: string; name: string; category: string; status: string; ownerAction?: string; evidence?: string }[];
  note?: string;
  firstBuildAfterMs?: number | null;
};

const measured = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** 850 → "850 ms", 4000 → "4 s", 2500 → "2.5 s", 600000 → "10 min". */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms / 6_000) / 10} min`;
}

export type RestartTile = { value: string | null; tone?: "warn"; hint: string; failed: boolean };

/** The "Server restarts" tile: pending state and the quiet window as the server reports them. */
export function restartTile(state: RestartState | undefined, error: unknown): RestartTile {
  if (!state) return { value: null, hint: error ? `Status unavailable: ${(error as Error)?.message ?? "no answer"}` : "Checking", failed: Boolean(error) };
  if (state.pending) {
    const held = state.waitingFor.filter(Boolean);
    return {
      value: "Waiting",
      tone: "warn",
      hint: held.length ? `Held for ${held.join(", ")}` : "Restarts by itself once things are quiet",
      failed: false,
    };
  }
  return { value: "None pending", hint: "Saves automatically", failed: false };
}

/** Why the tool check hasn't run, from what the server says: no remembered start-up delay. */
export function capabilitiesPendingText(caps: Capabilities | undefined, error: unknown): string {
  if (error) return `The capability registry didn't answer: ${(error as Error)?.message ?? "no answer"}`;
  if (!caps) return "Checking the capability registry.";
  if (measured(caps.firstBuildAfterMs)) return `The capability registry hasn't built yet; this server builds it ${fmtDuration(caps.firstBuildAfterMs)} after start-up.`;
  if (caps.firstBuildAfterMs === null) return "Background jobs are off on this server, so the capability registry doesn't build here.";
  return "The capability registry hasn't reported on this server yet.";
}

// ── Tools (H2) ─────────────────────────────────────────────────────────────────────────────────
// Registry statuses (scripts/capability-registry.ts): working = tested and passing, available =
// present but not tested, setup-required = the owner has to act, broken = its last test failed.
// Only setup-required and broken need attention; a status the page doesn't recognise is counted
// as unknown, never as fine and never as zero.

export type ToolCounts = {
  working: number;
  available: number;
  setup: number;
  broken: number;
  unknown: number;
  total: number;
  /** Broken first, then setup-required, each tool once. */
  attention: Capabilities["capabilities"];
  /** Tools whose check didn't answer ("unchecked") or whose status isn't recognised: shown, not counted as fine. */
  unknownItems: Capabilities["capabilities"];
};

export function toolCounts(caps: Capabilities | undefined): ToolCounts {
  const seen = new Map<string, Capabilities["capabilities"][number]>();
  // A tool listed twice counts once: the last entry is the registry's latest word on it.
  for (const c of caps?.capabilities ?? []) seen.set(c.id, c);
  const list = [...seen.values()];
  const by = (status: string) => list.filter((c) => c.status === status);
  const known = new Set(["working", "available", "setup-required", "broken"]);
  const broken = by("broken");
  const setup = by("setup-required");
  return {
    working: by("working").length,
    available: by("available").length,
    setup: setup.length,
    broken: broken.length,
    unknown: list.filter((c) => !known.has(c.status)).length,
    total: list.length,
    attention: [...broken, ...setup],
    unknownItems: list.filter((c) => !known.has(c.status)),
  };
}

/** "2 need setup · 0 broken" (and "· 1 unknown" only when there is one). */
export function toolAttentionLabel(c: ToolCounts): string {
  const parts = [`${c.setup} ${c.setup === 1 ? "needs" : "need"} setup`, `${c.broken} broken`];
  if (c.unknown) parts.push(`${c.unknown} unknown`);
  return parts.join(" · ");
}

/**
 * The "Tools needing attention" tile (review should-fix): a status the page doesn't recognise could
 * need attention, so with any unknown the count is a floor ("0+"), neutral, never the green "zero".
 */
export function toolsTile(
  caps: Capabilities | undefined,
  error: unknown,
): { value: string | number | null; tone: "danger" | "warn" | "success" | undefined; state: "failed" | "unknown" | "zero" | "ok" | undefined } {
  if (error) return { value: null, tone: undefined, state: "failed" };
  if (!caps) return { value: null, tone: undefined, state: undefined };
  if (!caps.generatedAt) return { value: null, tone: undefined, state: "unknown" };
  const c = toolCounts(caps);
  const need = c.setup + c.broken;
  if (c.unknown) return { value: `${need}+`, tone: c.broken ? "danger" : c.setup ? "warn" : undefined, state: "ok" };
  return { value: need, tone: c.broken ? "danger" : c.setup ? "warn" : "success", state: need ? "ok" : "zero" };
}

/** Badge wording and tone for one tool status. */
export function toolStatusView(status: string): { label: string; tone: "success" | "neutral" | "warn" | "danger" } {
  if (status === "working") return { label: "Working", tone: "success" };
  if (status === "available") return { label: "Available · not tested", tone: "neutral" };
  if (status === "setup-required") return { label: "Needs setup", tone: "warn" };
  if (status === "broken") return { label: "Broken", tone: "danger" };
  // The registry's probe didn't answer in time (a busy server): unknown, never "Broken" (F3-06).
  if (status === "unchecked") return { label: "Not checked · timed out", tone: "neutral" };
  return { label: "Unknown", tone: "neutral" };
}

// ── Model providers (M3) ───────────────────────────────────────────────────────────────────────
// GET /__operator/models statuses (scripts/assistant-adapters.ts). `ready` there means different
// things per provider: a signed-in probe for Codex and Claude Code, "installed" for Hermes, "a
// public catalogue downloaded" for OpenRouter. Only a verified probe reads as Ready.

export type ProviderStatus = { id: string; ready: boolean; installed?: boolean; catalogReady?: boolean; detail: string };
export type ProviderState = "verified" | "installed" | "configured" | "failed" | "setup" | "unknown";
export type ProviderView = { state: ProviderState; label: string; tone: "success" | "neutral" | "warn" };

export function providerView(s: ProviderStatus): ProviderView {
  const detail = s.detail ?? "";
  const setup = (label: string): ProviderView => ({ state: "setup", label, tone: "neutral" });
  const failed = (label: string): ProviderView => ({ state: "failed", label, tone: "warn" });
  switch (s.id) {
    case "ollama":
    case "lmstudio":
      // The local server answered /models: a live probe of the thing itself.
      if (s.ready) return { state: "verified", label: "Ready", tone: "success" };
      if (/^Running/i.test(detail)) return { state: "installed", label: "Running · no model loaded", tone: "neutral" };
      return setup("Not running");
    case "codex":
      if (s.ready) return { state: "verified", label: "Ready · signed in", tone: "success" };
      if (/^Install/i.test(detail)) return setup("Not installed");
      if (/sign-in was not confirmed|codex login/i.test(detail)) return setup("Sign-in needed");
      return failed("Check failed");
    case "claude":
      if (s.ready && s.catalogReady === false) return failed("Model discovery failed");
      if (s.ready) return { state: "verified", label: "Ready · signed in", tone: "success" };
      if (s.installed === false || /^Install/i.test(detail)) return setup("Not installed");
      if (/could not verify/i.test(detail)) return failed("Check failed");
      if (/signed out|sign in/i.test(detail)) return setup("Sign-in needed");
      return failed("Check failed");
    case "hermes":
      return s.ready || s.installed ? { state: "installed", label: "Installed · not verified", tone: "neutral" } : setup("Not installed");
    case "openrouter":
      if (s.ready) return { state: "configured", label: "Catalogue only · not verified", tone: "neutral" };
      if (/could not be refreshed/i.test(detail)) return failed("Catalogue failed");
      return setup("Not connected");
    case "deepseek":
      return s.ready ? { state: "configured", label: "Configured · not verified", tone: "neutral" } : setup("Setup required");
    default:
      return { state: "unknown", label: s.ready ? "Reported ready · not verified" : "Unknown", tone: "neutral" };
  }
}

export type CatalogModel = { key?: string; name?: string; backend: string; provider: string; harness?: string };

/**
 * Which provider row a model belongs to. `backend` is the send route, not the harness: Codex
 * models travel the "claude" route, so they are attributed by `harness` (or, from servers that
 * don't send it, by provider), never counted under Claude Code.
 */
export function modelHarness(m: CatalogModel): string {
  if (m.harness) return m.harness;
  if (m.backend === "local") return m.provider;
  if (m.backend === "claude") return /codex/i.test(m.provider ?? "") ? "codex" : "claude";
  return m.backend;
}

const modelKey = (m: CatalogModel) => m.key ?? `${m.backend}|${m.provider}|${m.name ?? ""}`;

/** Distinct models per provider row (a model listed twice counts once). */
export function modelCountsByProvider(models: CatalogModel[]): Record<string, number> {
  const keys = new Map<string, Set<string>>();
  for (const m of models) {
    const id = modelHarness(m);
    const set = keys.get(id) ?? new Set<string>();
    set.add(modelKey(m));
    keys.set(id, set);
  }
  return Object.fromEntries([...keys].map(([id, set]) => [id, set.size]));
}

export function distinctModelCount(models: CatalogModel[]): number {
  return new Set(models.map(modelKey)).size;
}

export type ProviderSummary = { verified: number; unverified: number; failed: number; setup: number; unknown: number; total: number };

export function providerSummary(statuses: ProviderStatus[]): ProviderSummary {
  const out: ProviderSummary = { verified: 0, unverified: 0, failed: 0, setup: 0, unknown: 0, total: statuses.length };
  for (const s of statuses) {
    const { state } = providerView(s);
    if (state === "verified") out.verified++;
    else if (state === "installed" || state === "configured") out.unverified++;
    else if (state === "failed") out.failed++;
    else if (state === "setup") out.setup++;
    else out.unknown++;
  }
  return out;
}

const joinNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`);

/**
 * One plain line for "N not verified" (and a failure, when there is one), so the count is never
 * a bare number: which providers, and what "not verified" means. Null when nothing is unverified
 * or failed. `nameOf` maps a provider id to its label.
 */
export function providerExplain(statuses: ProviderStatus[], nameOf: (id: string) => string = (id) => id): string | null {
  const names = (state: ProviderState) => statuses.filter((s) => providerView(s).state === state).map((s) => nameOf(s.id));
  const unverified = [...names("installed"), ...names("configured")];
  const failed = names("failed");
  const parts: string[] = [];
  if (failed.length) parts.push(`${failed.length} failed: ${joinNames(failed)}.`);
  if (unverified.length) parts.push(`${unverified.length} not verified: ${joinNames(unverified)} ${unverified.length === 1 ? "is" : "are"} set up but not tested live.`);
  return parts.length ? parts.join(" ") : null;
}

/** The System page's one headline sentence, from the same reads as its widgets. */
export function systemHeadline(input: { providers: ProviderSummary | null; providersEmpty: boolean; toolsNeedingAttention: number | null }): string {
  const parts: string[] = [];
  if (input.providers && !input.providersEmpty) parts.push(`${input.providers.verified} of ${input.providers.total} model providers verified`);
  if (input.toolsNeedingAttention !== null) parts.push(`${input.toolsNeedingAttention} ${input.toolsNeedingAttention === 1 ? "tool needs" : "tools need"} attention`);
  return parts.length ? `${parts.join("; ")}.` : "Model providers, tools, plan limits and devices.";
}

/**
 * A provider check that verified nothing, failed nothing and listed no models ("0 of 7 · 0 models") read
 * nothing (REVIEW-T1 R2, low item): the tile says "Unknown", not a "Live" zero. Failures are real facts.
 */
export function providersHollow(p: ProviderSummary | null, modelTotal: number): boolean {
  if (!p) return false;
  return p.total === 0 || (p.verified === 0 && p.failed === 0 && modelTotal === 0);
}

// ── Model check freshness (L7) ─────────────────────────────────────────────────────────────────
// GET /__operator/models?snapshot=1 answers at once with the last check and its time, and starts
// a background re-check when due. Older servers ignore `snapshot` and answer with a full check.

export type ModelSnapshot = { models: CatalogModel[]; statuses: ProviderStatus[]; checking?: boolean; checkedAt?: string | null; error?: string | null; notChecked?: boolean };

export type ModelCheckView = {
  /**
   * checking = nothing to show yet and a probe is running; failed = no result and the probe failed;
   * unchecked = nothing has asked the providers yet (a page read never does, T8c).
   */
  phase: "checking" | "ready" | "failed" | "unchecked";
  /** When the rows shown were produced (ms), or null. */
  checkedAt: number | null;
  /** A background re-check is running while older rows are shown. */
  rechecking: boolean;
  note: string | null;
};

export function modelCheckView(data: ModelSnapshot | undefined, fetchedAt: number): ModelCheckView {
  if (!data) return { phase: "checking", checkedAt: null, rechecking: false, note: null };
  // An older server has no snapshot fields: its answer is a check made for this request.
  if (data.checkedAt === undefined && data.checking === undefined) return { phase: "ready", checkedAt: fetchedAt || null, rechecking: false, note: null };
  const at = data.checkedAt ? Date.parse(data.checkedAt) : NaN;
  if (!Number.isFinite(at)) {
    if (data.checking) return { phase: "checking", checkedAt: null, rechecking: false, note: null };
    if (data.notChecked && !data.error) return { phase: "unchecked", checkedAt: null, rechecking: false, note: "Not checked yet. Check now asks the model providers." };
    return { phase: "failed", checkedAt: null, rechecking: false, note: data.error ?? "The model check hasn't produced a result." };
  }
  return { phase: "ready", checkedAt: at, rechecking: Boolean(data.checking), note: data.error ?? null };
}

// ── Plan limits (L1) ───────────────────────────────────────────────────────────────────────────

/** "5 h window · resets in 2 h 10 min": `resetText` (fmtResetIn) already carries its verb. */
export function planWindowLine(label: string, resetText: string): string {
  return `${label} window · ${resetText}`;
}
