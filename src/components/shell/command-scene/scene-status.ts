// The Command scene's five objects and their REAL status (NEXUS-ADDENDUM item 3): each says its source,
// last update and honest state, and opens its existing 2D page. Pure mapping from the reads the OS already
// makes (Workspace panels, the job history, /__memory/status, /__finance_manual/status); bun-tested.
import { honestFromPanel, type HonestState } from "../../../lib/honest-state";

export type SceneObjectId = "receptionist" | "leads" | "coding" | "memory" | "finance";
export type SceneObject = {
  id: SceneObjectId;
  label: string;
  /** The existing 2D page it opens. */
  to: string;
  value: string | null;
  detail: string;
  state: HonestState;
  source: string;
  lastUpdate: string | number | null;
};

type Panel<T> = { ok: true; data: T; updatedAt: string; stale?: unknown } | { ok: false; error: string; updatedAt: string };
type Q<T> = { data?: T; error?: unknown };

export function receptionistObject(q: Q<Panel<{ verdict: { decision: string }; gatesPassed: number; gates: unknown[]; incidents: unknown[] }>>, now: number): SceneObject {
  const r = q.data;
  const base = { id: "receptionist" as const, label: "Receptionist", to: "/receptionist", source: "Receptionist status" };
  if (!r) return { ...base, value: null, detail: q.error ? "Couldn't reach the status." : "Loading…", state: q.error ? "failed" : "unknown", lastUpdate: null };
  if (!r.ok) return { ...base, value: null, detail: r.error, state: "failed", lastUpdate: null };
  const d = r.data;
  // "Status unknown" is unknown, never Live (REVIEW-T1 B12); missing counts say so, never "null".
  const unknownVerdict = !d?.verdict?.decision || /unknown/i.test(d.verdict.decision);
  const gates = typeof d?.gatesPassed === "number" && Array.isArray(d?.gates) && d.gates.length ? `${d.gatesPassed} of ${d.gates.length} go-live gates` : "Go-live gates not reported";
  const flagged = Array.isArray(d?.incidents) ? ` · ${d.incidents.length} flagged` : "";
  return { ...base, value: unknownVerdict ? null : d.verdict.decision, detail: `${gates}${flagged}`, state: unknownVerdict ? "unknown" : honestFromPanel(r, now), lastUpdate: r.updatedAt };
}

export function leadsObject(q: Q<Panel<{ total: number; crmLeads?: number }>>, now: number): SceneObject {
  const r = q.data;
  const base = { id: "leads" as const, label: "Leads", to: "/leads", source: "CRM call queue" };
  if (!r) return { ...base, value: null, detail: q.error ? "Couldn't reach the CRM." : "Loading…", state: q.error ? "failed" : "unknown", lastUpdate: null };
  if (!r.ok) return { ...base, value: null, detail: r.error, state: "failed", lastUpdate: null };
  // An empty CRM can't say "0 to call" (REVIEW-T1 B12).
  if (r.data.crmLeads === 0) return { ...base, value: null, detail: "No leads in the CRM yet", state: "unknown", lastUpdate: r.updatedAt };
  return { ...base, value: `${r.data.total} to call`, detail: "Due today or overdue", state: honestFromPanel(r, now), lastUpdate: r.updatedAt };
}

/** Where coding jobs live: /coding once Track 3's page is in the build, else the Claude Code page. */
export function codingPage(paths: readonly string[]): string {
  return paths.includes("/coding") ? "/coding" : "/agents/claude-code";
}

const DAY = 86_400_000;
const ageState = (at: string | null | undefined, now: number, limitMs: number): HonestState => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) && now - t > limitMs ? "stale" : "live";
};

export function codingObject(read: boolean, job: { title: string; state: string; updatedAt: string } | null, now = Date.now(), to = "/agents/claude-code"): SceneObject {
  const base = { id: "coding" as const, label: "Coding", to, source: "Job history" };
  if (!read) return { ...base, value: null, detail: "Reading the job history…", state: "unknown", lastUpdate: null };
  if (!job) return { ...base, value: null, detail: "No coding job in the job history.", state: "unknown", lastUpdate: null };
  // The latest coding job's own age: a finished job from last week isn't "live" news (review item 13).
  return { ...base, value: job.state.replace(/-/g, " "), detail: job.title, state: ageState(job.updatedAt, now, DAY), lastUpdate: job.updatedAt };
}

export type MemoryStatusLike = { settings?: { mode?: string; hindsight_enabled?: boolean; reason?: string | null }; last_success_at?: string | null; pending?: number };
export function memoryObject(q: Q<MemoryStatusLike>, now = Date.now()): SceneObject {
  const base = { id: "memory" as const, label: "Memory", to: "/memory", source: "Memory status" };
  const s = q.data;
  if (!s) return { ...base, value: null, detail: q.error ? "Couldn't read memory status." : "Loading…", state: q.error ? "failed" : "unknown", lastUpdate: null };
  const mode = s.settings?.mode ?? "unknown";
  const hindsight = s.settings?.hindsight_enabled ? "Hindsight on" : "Hindsight off";
  return {
    ...base,
    value: mode === "on" ? "Saving on" : mode === "read" ? "Read only" : mode === "off" ? "Writes off" : "Unknown",
    detail: `${hindsight}${typeof s.pending === "number" ? ` · ${s.pending} pending` : ""}`,
    state: mode === "off" ? "setup-required" : s.last_success_at ? ageState(s.last_success_at, now, DAY) : "unknown",
    lastUpdate: s.last_success_at ?? null,
  };
}

export type FinanceStatusLike = { rowCount?: number; lastImportAt?: string | null; asOf?: string | null; stale?: boolean; sourceLabel?: string };
export function financeObject(q: Q<FinanceStatusLike>): SceneObject {
  const base = { id: "finance" as const, label: "Finance", to: "/finance", source: "NAB CSV import" };
  const s = q.data;
  if (!s) return { ...base, value: null, detail: q.error ? "Couldn't read the import status." : "Loading…", state: q.error ? "failed" : "unknown", lastUpdate: null };
  if (!s.rowCount) return { ...base, value: null, detail: "No NAB CSV imported yet.", state: "setup-required", lastUpdate: null };
  return { ...base, value: s.asOf ? `As of ${s.asOf.slice(0, 10)}` : "Imported", detail: s.sourceLabel ?? `${s.rowCount} rows`, state: s.stale ? "stale" : "live", lastUpdate: s.lastImportAt ?? null };
}
