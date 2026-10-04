// Browser side of the ONE command registry: reads the dynamic sources (each with its honest state),
// previews a device action's target (GET /__commands/target), runs a device plan through the existing
// Jarvis entry (POST /__operator/screen/command, which resolves the target again and records the job),
// and focuses a named section after navigation. The registry itself (./registry.ts) stays pure.
import type { DynamicSource, DynamicSources } from "./registry";
import type { CommandPlan, SourceState, TargetPreview } from "./types";
import { readPageContext } from "../page-context";

let tokenPromise: Promise<string> | null = null;
/** This page's own token (per person; the identity gate serves it). */
export function pageToken(): Promise<string> {
  tokenPromise ??= fetch("/__token", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((t) => (typeof t?.token === "string" ? t.token : ""))
    .catch(() => "")
    .then((t) => {
      if (!t) tokenPromise = null; // retry next time
      return t;
    });
  return tokenPromise;
}

async function getJson(url: string, withToken = false, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (withToken) headers["x-claude-os-token"] = await pageToken();
  const r = await fetch(url, { headers, signal, cache: "no-store" });
  const body = r.headers.get("content-type")?.includes("json") ? await r.json().catch(() => null) : null;
  return { ok: r.ok, status: r.status, body };
}

const failed = <T>(reason: string): DynamicSource<T> => ({ state: "failed", reason, items: [] });
const isState = (s: unknown): s is SourceState => ["live", "simulated", "stale", "failed", "unknown", "setup-required"].includes(s as string);

type ServerIndex<T> = { state?: unknown; reason?: unknown; lastSuccess?: unknown; items?: T[] };
function fromServer<T>(r: { ok: boolean; status: number; body: unknown }, what: string): DynamicSource<T> {
  if (!r.ok) return failed(`Couldn't read ${what} (HTTP ${r.status}).`);
  const b = (r.body ?? {}) as ServerIndex<T>;
  return {
    state: isState(b.state) ? b.state : "unknown",
    ...(typeof b.reason === "string" ? { reason: b.reason } : {}),
    lastSuccess: typeof b.lastSuccess === "string" ? b.lastSuccess : null,
    items: Array.isArray(b.items) ? b.items : [],
  };
}

// Apps change rarely: one read per 30 minutes per tab.
let appsCache: { at: number; value: DynamicSource<{ name: string }> } | null = null;
let appsInFlight: Promise<DynamicSource<{ name: string }>> | null = null;
/** While the first read is in flight (Windows lists its apps in a few seconds, once). */
export const APPS_LOADING: DynamicSource<{ name: string }> = { state: "unknown", reason: "Reading the installed-app index from Windows…", items: [] };
export function cachedApps() {
  return appsCache && Date.now() - appsCache.at < 30 * 60_000 ? appsCache.value : null;
}
export function loadApps(force = false): Promise<DynamicSource<{ name: string }>> {
  const cached = !force && cachedApps();
  if (cached) return Promise.resolve(cached);
  appsInFlight ??= (async () => {
    try {
      const value = fromServer<{ name: string }>(await getJson("/__commands/apps", true), "the installed-app index");
      if (value.state !== "failed") appsCache = { at: Date.now(), value };
      return value;
    } catch {
      return failed<{ name: string }>("Couldn't reach the installed-app index.");
    } finally {
      appsInFlight = null;
    }
  })();
  return appsInFlight;
}

export async function loadSites(): Promise<NonNullable<DynamicSources["sites"]>> {
  try {
    const r = await getJson("/__websites/overview");
    if (!r.ok) return failed(`Couldn't read /__websites (HTTP ${r.status}).`);
    const sites = ((r.body as { sites?: Array<{ id: string; name: string; url: string; kind: string }> })?.sites ?? []).filter((s) => s?.id && s?.name && /^https?:\/\//.test(s.url ?? ""));
    return { state: "live", lastSuccess: new Date().toISOString(), items: sites.map((s) => ({ id: s.id, name: s.name, url: s.url, kind: s.kind })) };
  } catch {
    return failed("Couldn't reach /__websites.");
  }
}

/** Projects from the aggregator's live data (the Projects page reads the same). */
export function projectsFromLiveData(data: unknown): NonNullable<DynamicSources["projects"]> {
  const rows = (data as { recentProjects?: Array<{ key?: unknown; displayName?: unknown; lastActiveAgo?: unknown }> } | null)?.recentProjects;
  if (!Array.isArray(rows)) return { state: "unknown", reason: "The project list hasn't been aggregated yet.", items: [] };
  return {
    state: "live",
    items: rows
      .filter((p) => typeof p?.key === "string" && p.key)
      .map((p) => ({ id: String(p.key), name: String(p.displayName ?? p.key), detail: `Project${typeof p.lastActiveAgo === "string" ? ` · active ${p.lastActiveAgo}` : ""}` })),
  };
}

export async function loadProjects(): Promise<NonNullable<DynamicSources["projects"]>> {
  try {
    const r = await getJson("/__live-data");
    if (!r.ok) return failed(`Couldn't read projects (HTTP ${r.status}).`);
    return projectsFromLiveData(r.body);
  } catch {
    return failed("Couldn't reach the project list.");
  }
}

export async function searchFiles(q: string, signal?: AbortSignal): Promise<NonNullable<DynamicSources["files"]>> {
  try {
    return fromServer<{ name: string; where: string }>(await getJson(`/__commands/files?q=${encodeURIComponent(q)}`, true, signal), "authorised files");
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return failed("Couldn't search authorised files.");
  }
}

export async function searchLeads(q: string, signal?: AbortSignal): Promise<NonNullable<DynamicSources["leads"]>> {
  try {
    const r = await getJson(`/__operator/leads/search?q=${encodeURIComponent(q)}`, false, signal);
    if (!r.ok) return failed(`Couldn't search the CRM (HTTP ${r.status}).`);
    const hits = ((r.body as { hits?: Array<{ leadId: number; title: string; detail: string }> })?.hits ?? []).filter((h) => typeof h?.leadId === "number");
    return { state: "live", lastSuccess: new Date().toISOString(), items: hits.map((h) => ({ leadId: h.leadId, title: h.title, detail: h.detail })) };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return failed("Couldn't reach the CRM search.");
  }
}

/** resolveTarget for the signed-in person, shown before a device action runs. Never throws. */
export async function previewTarget(spokenTarget?: string, signal?: AbortSignal): Promise<TargetPreview> {
  try {
    const r = await getJson(`/__commands/target${spokenTarget ? `?spoken=${encodeURIComponent(spokenTarget)}` : ""}`, true, signal);
    if (!r.ok) return { ok: false, reason: (r.body as { error?: string })?.error ?? `Device routing answered HTTP ${r.status}.`, routing: "unavailable" };
    return r.body as TargetPreview;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return { ok: false, reason: "Device routing couldn't be reached, so nothing will run.", routing: "unavailable" };
  }
}

export type DeviceRunEvent = { type: "step"; text: string } | { type: "done"; ok: boolean; said: string; runId?: string; kind?: string };

/**
 * Send a device plan to the ONE Jarvis entry and stream its steps. The server resolves the target again
 * (the preview is for the person; the server's check is the one that counts) and records the job.
 */
export async function runDevicePlan(plan: Extract<CommandPlan, { kind: "device" }>, onEvent: (e: DeviceRunEvent) => void, signal?: AbortSignal): Promise<DeviceRunEvent & { type: "done" }> {
  return runTypedEntry(plan.request.utterance, { spokenTarget: plan.request.spokenTarget, signal, onEvent });
}

// Track 2's command client (src/lib/jarvis-command.ts: job-backed, re-attaches a dropped stream, cancels
// through the job service), found by file convention; this branch alone posts the same body itself.
type T2Client = {
  runTypedCommand: (utterance: string, opts: { spokenTarget?: string; signal?: AbortSignal; onEvent?: (e: { type: string; text?: string }) => void }) => Promise<{ ok: boolean; said: string; jobId?: string | null; kind?: string }>;
};
const T2_CLIENT: Record<string, () => Promise<unknown>> = typeof import.meta.glob === "function" ? import.meta.glob("../jarvis-command.ts") : {};

/** Is Track 2's command client (which runs rule answers through the entry) part of this build? */
export const hasCommandClient = () => Object.keys(T2_CLIENT).length > 0;

/** A page context small enough for the command entry (Track 2 bounds: 20 visible items, 8 sources). */
function boundedContext() {
  const c = readPageContext();
  return { ...c, visible: c.visible.slice(0, 20), sources: c.sources.slice(0, 8) };
}

/**
 * Typed words to the ONE command entry (POST /__operator/screen/command): the same entry and body shape
 * voice uses ({ utterance, source, spokenTarget, pageContext }); the person comes from the session.
 */
export async function runTypedEntry(utterance: string, opts: { spokenTarget?: string; signal?: AbortSignal; onEvent: (e: DeviceRunEvent) => void }): Promise<DeviceRunEvent & { type: "done" }> {
  const { spokenTarget, signal, onEvent } = opts;
  const loadT2 = Object.values(T2_CLIENT)[0];
  if (loadT2) {
    try {
      const t2 = (await loadT2()) as Partial<T2Client>;
      if (typeof t2.runTypedCommand === "function") {
        const r = await t2.runTypedCommand(utterance, { ...(spokenTarget ? { spokenTarget } : {}), signal, onEvent: (e) => void (e.type !== "done" && typeof e.text === "string" && onEvent({ type: "step", text: e.text.slice(0, 160) })) });
        const done = { type: "done" as const, ok: !!r.ok, said: String(r.said ?? ""), runId: r.jobId ?? undefined, kind: r.kind };
        onEvent(done);
        return done;
      }
    } catch {
      /* fall through to the plain post */
    }
  }
  const token = await pageToken();
  let res: Response;
  try {
    res = await fetch("/__operator/screen/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-os-token": token },
      body: JSON.stringify({ utterance, source: "typed", ...(spokenTarget ? { spokenTarget } : {}), pageContext: boundedContext() }),
      signal,
    });
  } catch (error) {
    const done = { type: "done" as const, ok: false, said: (error as Error).name === "AbortError" ? "Stopped." : "The Jarvis entry couldn't be reached. Nothing ran." };
    onEvent(done);
    return done;
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string; said?: string } | null;
    const done = { type: "done" as const, ok: false, said: body?.said ?? body?.error ?? `Not run: the server answered HTTP ${res.status}.` };
    onEvent(done);
    return done;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: (DeviceRunEvent & { type: "done" }) | null = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { type?: string; ok?: boolean; said?: string; text?: string; did?: string; runId?: string; jobId?: string; kind?: string };
        if (e.type === "done") {
          // runId (this entry's run log) or jobId (Track 2's job): only a real record makes the palette say "recorded".
          done = { type: "done", ok: !!e.ok, said: String(e.said ?? (e.ok ? "Done." : "Not done.")), runId: e.jobId || e.runId || undefined, kind: e.kind };
          onEvent(done);
        } else if (typeof (e.text ?? e.did) === "string") onEvent({ type: "step", text: String(e.text ?? e.did).slice(0, 160) });
      } catch {
        /* a partial or foreign line */
      }
    }
  }
  if (!done) {
    done = { type: "done", ok: false, said: "The run ended without a result, so its outcome is unknown." };
    onEvent(done);
  }
  return done;
}

/** After navigating: scroll to and focus a named section once it renders (lazy pages take a moment). */
export function focusAnchor(id: string, timeoutMs = 15_000) {
  if (typeof document === "undefined") return;
  const started = Date.now();
  const path = location.pathname;
  const tick = () => {
    if (location.pathname !== path) return; // he moved on: never yank focus later
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.closest?.("input,textarea,select,[contenteditable=true]")) return; // he started typing
    const el = document.getElementById(id);
    if (el) {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "still";
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      el.focus({ preventScroll: true });
      el.setAttribute("data-command-focus", "");
      window.setTimeout(() => el.removeAttribute("data-command-focus"), 1600);
      return;
    }
    if (Date.now() - started < timeoutMs) window.setTimeout(tick, 120);
  };
  tick();
}
