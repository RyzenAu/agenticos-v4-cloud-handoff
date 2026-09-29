// Workspace data sources. Each panel reads the EXISTING loopback APIs of this same server — the
// ones the full pages already use — and projects them down (projections.ts). Nothing is
// duplicated and nothing writes: every call here is a GET.
//
//   today         calling window + approvals.json + /__receptionist readiness
//   callQueue     /__operator/leads/list?deals=1 → selectCallQueue (the /leads page's queue)
//   receptionist  /__receptionist (its own 60 s snapshot cache)
//   websites      server-side uptime checks (sites.ts, 5 min cache)
//   email         /__operator/inbox/triage + /__operator/connections + /__operator/native-connections
//   pipeline      /__operator/leads/pipeline?summary=1 + /leads/summary + /leads/overview
//   enquiries     speed-to-lead's `enquiries` table in .operator-data/crm.sqlite, read-only
//                 (metadata only: ref, topic, clock; see docs/SPEED-TO-LEAD.md)
//   needsYou      the ONE "needs you" count (needs-you.ts): today's decisions + email threads to
//                 answer + agent approvals (/__operator/jarvis/status). Sidebar, Today and HUD show it.
//
// Concurrent reads of a panel share one in-flight request. KEEPS_LAST_GOOD panels keep their last good
// read: a read within FRESH_REUSE_MS is reused, and when a fresh read fails or times out the last good
// one (up to SERVE_STALE_MAX_MS old) is served marked `stale` with the failure, never as fresh.
import { readFileSync } from "node:fs";
import { runPanel, type PanelResult } from "./aggregate";
import { mergeApprovals, validateApprovals, type Approval } from "./approvals";
import { callingWindowStatus, type CallingWindowStatus } from "./calling-window";
import { projectCallQueue, projectEmail, projectPipeline, projectReceptionist, type CallQueuePanel, type EmailPanel, type PipelinePanel, type ReceptionistPanel } from "./projections";
import { createSiteChecker, type SitesPanel } from "./sites";
import { needsYouFrom, type NeedsYouPanel } from "./needs-you";
import { projectSpeedToLead } from "../speed-to-lead/panel";
import type { EnquiryRecord } from "../speed-to-lead/store";
import type { EnquiryPanel } from "../../src/lib/speed-to-lead";

export type TodayPanel = {
  now: string;
  callingWindow: CallingWindowStatus;
  approvals: Approval[];
  /** Approval-file problems (bad items are skipped, never shown half-valid). */
  approvalsErrors: string[];
  /** Set when live receptionist gates couldn't be read (file items still show). */
  derivedError: string | null;
};

export type WorkspaceSnapshot = {
  today: PanelResult<TodayPanel>;
  callQueue: PanelResult<CallQueuePanel>;
  receptionist: PanelResult<ReceptionistPanel>;
  websites: PanelResult<SitesPanel>;
  email: PanelResult<EmailPanel>;
  pipeline: PanelResult<PipelinePanel>;
  enquiries: PanelResult<EnquiryPanel>;
  needsYou: PanelResult<NeedsYouPanel>;
};
export type PanelName = keyof WorkspaceSnapshot;
export const PANELS: PanelName[] = ["today", "callQueue", "receptionist", "websites", "email", "pipeline", "enquiries", "needsYou"];

/**
 * Per-source timeouts (ms). The receptionist builds from Retell/Twilio/the agency feed, so it gets the longest.
 * Email's mailbox discovery can take ~4.5 s cold (UI-truth M9), so it gets 9 s; needsYou waits on today + email.
 */
export const TIMEOUTS: Record<PanelName, number> = { today: 12_000, callQueue: 8_000, receptionist: 15_000, websites: 12_000, email: 9_000, pipeline: 8_000, enquiries: 4_000, needsYou: 13_000 };
/** Panels that keep their last good read (see the header). */
// pipeline and callQueue walk the whole CRM (~1-2 s for ~1,000 leads, UI-truth M10), so a read within
// FRESH_REUSE_MS is reused too; it's shown with the time it was actually read.
export const KEEPS_LAST_GOOD: PanelName[] = ["today", "email", "pipeline", "callQueue"];
export const FRESH_REUSE_MS = 30_000;
/**
 * Stale-while-revalidate panels (email): once the reuse window has passed, a read waits at most
 * SWR_WAIT_MS for the source; if it's still running, the last good read is served marked
 * `refreshing` (with its real read time) and the fresh read finishes in the background for the next
 * request. A background read that failed is not swallowed: the next answer carries it as `stale`.
 */
export const SWR_PANELS: PanelName[] = ["email"];
export const SWR_WAIT_MS = 1_500;
export const SERVE_STALE_MAX_MS = 6 * 3_600_000;

export type GetJson = (path: string, signal: AbortSignal) => Promise<any>;

/** A GET against this server's own loopback API. Non-2xx and non-JSON replies become errors. */
export function loopbackJson(origin: () => string, f: typeof fetch = fetch): GetJson {
  return async (path, signal) => {
    const res = await f(`${origin()}${path}`, { signal, headers: { Accept: "application/json" } });
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) throw new Error(`${path.split("?")[0]} answered without JSON (HTTP ${res.status})`);
    const body = await res.json();
    if (!res.ok) throw new Error(`${path.split("?")[0]}: ${typeof body?.error === "string" ? body.error.slice(0, 120) : `HTTP ${res.status}`}`);
    return body;
  };
}

export type WorkspaceDeps = {
  get: GetJson;
  approvalsFile: string;
  sites?: { check(force?: boolean): Promise<SitesPanel> };
  /** Open speed-to-lead enquiries (read-only). Absent: the panel reports it isn't connected. */
  enquiries?: () => EnquiryRecord[];
  /** True only once something runs the enquiry watcher on a schedule (owner yes; none today). */
  enquiryWatcherScheduled?: boolean;
  now?: () => number;
  timeouts?: Partial<Record<PanelName, number>>;
  /**
   * A cheap fingerprint of what a panel reads (e.g. the CRM file's size and mtime). A reused read is
   * only served while the fingerprint is unchanged, so a call logged on /leads shows on the next
   * read instead of up to FRESH_REUSE_MS later. Null/absent: time-based reuse only.
   */
  changeKey?: (name: PanelName) => string | null;
};

/** A read request: `fresh` (Refresh / Retry) always reads the source again. */
export type ReadOptions = { fresh?: boolean };

export function createWorkspace(deps: WorkspaceDeps) {
  const now = deps.now ?? Date.now;
  const sites = deps.sites ?? createSiteChecker();
  const timeouts = { ...TIMEOUTS, ...deps.timeouts };

  function readApprovals() {
    try {
      return validateApprovals(JSON.parse(readFileSync(deps.approvalsFile, "utf8")), now());
    } catch (error) {
      return { items: [], done: 0, decided: 0, expired: [], errors: [`approvals.json unreadable: ${String((error as Error)?.message ?? error).slice(0, 120)}`] };
    }
  }

  const inflight = new Map<PanelName, Promise<PanelResult<any>>>();
  const lastGood = new Map<PanelName, PanelResult<any> & { ok: true }>();
  /** The change key each last good read was made under. */
  const readUnder = new Map<PanelName, string | null>();
  /** The most recent failed read per panel (cleared by a success). */
  const lastFailure = new Map<PanelName, PanelResult<any> & { ok: false }>();
  const keyOf = (name: PanelName) => {
    try {
      return deps.changeKey?.(name) ?? null;
    } catch {
      return null;
    }
  };

  /** One in-flight read per panel; a success becomes the panel's last good read. */
  function fresh(name: PanelName, options: ReadOptions = {}): Promise<PanelResult<any>> {
    let work = inflight.get(name);
    if (!work) {
      const key = keyOf(name);
      work = runPanel((signal) => sources[name](signal, options), timeouts[name], now)
        .then((result) => {
          if (result.ok) {
            lastGood.set(name, result);
            readUnder.set(name, key);
            lastFailure.delete(name);
          } else lastFailure.set(name, result);
          return result;
        })
        .finally(() => inflight.delete(name));
      inflight.set(name, work);
    }
    return work;
  }

  async function read(name: PanelName, options: ReadOptions = {}): Promise<PanelResult<any>> {
    if (!KEEPS_LAST_GOOD.includes(name)) return fresh(name, options);
    const last = lastGood.get(name);
    const age = last ? now() - Date.parse(last.updatedAt) : Infinity;
    const unchanged = readUnder.get(name) === keyOf(name);
    // Refresh/Retry always read again; otherwise a recent read of an unchanged source is reused,
    // marked `reused` and keeping its real read time and duration.
    if (last && !options.fresh && age < FRESH_REUSE_MS && unchanged) return { ...last, reused: true };
    let settled: PanelResult<any> | null = null;
    if (last && !options.fresh && SWR_PANELS.includes(name) && age <= SERVE_STALE_MAX_MS) {
      const failedBefore = lastFailure.get(name);
      const work = fresh(name, options);
      const quick = await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), SWR_WAIT_MS))]);
      if (quick === null) {
        // Still reading: serve the last good read now, honestly marked, and let the read finish.
        const failed = failedBefore && Date.parse(failedBefore.updatedAt) > Date.parse(last.updatedAt) ? failedBefore : null;
        return { ...last, reused: true, refreshing: true, ...(failed ? { stale: { error: failed.error, timedOut: failed.timedOut, failedAt: failed.updatedAt } } : {}) };
      }
      settled = quick;
    }
    const result = settled ?? (await fresh(name, options));
    if (result.ok || !last || age > SERVE_STALE_MAX_MS) return result;
    return { ...last, ms: result.ms, stale: { error: result.error, timedOut: result.timedOut, failedAt: result.updatedAt } };
  }

  const sources: { [K in PanelName]: (signal: AbortSignal, options?: ReadOptions) => Promise<any> } = {
    async today(signal) {
      const file = readApprovals();
      // The receptionist is optional here: its gates add to the list, its absence doesn't hide it.
      const readiness = await runPanel((s) => deps.get("/__receptionist", AbortSignal.any([signal, s])), Math.max(1000, timeouts.today - 2000), now);
      return {
        now: new Date(now()).toISOString(),
        callingWindow: callingWindowStatus(new Date(now())),
        approvals: mergeApprovals(file.items, readiness.ok ? readiness.data?.readiness ?? null : null),
        // An expired item left the waiting count; say so, so it gets closed or renewed (UI-truth M6).
        approvalsErrors: [...file.errors, ...file.expired.map((x) => `"${x.title}" expired unreviewed on ${x.expiredOn}: mark it done or decided, or renew it with a later expires date`)],
        derivedError: readiness.ok ? null : `Receptionist gates unavailable: ${readiness.error}`,
      } satisfies TodayPanel;
    },
    async callQueue(signal) {
      const list = await deps.get("/__operator/leads/list?deals=1", signal);
      return projectCallQueue(Array.isArray(list?.leads) ? list.leads : [], now());
    },
    async receptionist(signal) {
      return projectReceptionist(await deps.get("/__receptionist", signal));
    },
    async websites() {
      return sites.check();
    },
    async email(signal) {
      const [triage, accounts, native] = await Promise.all([
        deps.get("/__operator/inbox/triage", signal).catch(() => null),
        deps.get("/__operator/connections", signal).catch(() => null),
        deps.get("/__operator/native-connections", signal).catch(() => null),
      ]);
      if (!accounts && !native) throw new Error("Mailbox connection status unavailable");
      const panel = projectEmail({ triage, accounts, native });
      if (panel.connected && !triage) throw new Error("Inbox is connected but the triage log couldn't be read");
      return panel;
    },
    async pipeline(signal) {
      const [summary, status, overview] = await Promise.all([
        deps.get("/__operator/leads/pipeline?summary=1", signal),
        deps.get("/__operator/leads/summary", signal).catch(() => null),
        deps.get("/__operator/leads/overview", signal).catch(() => null),
      ]);
      return projectPipeline({ summary, statusCounts: status?.pipeline ?? null, overview, hunt: status?.hunt ?? null });
    },
    async enquiries() {
      if (!deps.enquiries) throw new Error("Enquiry store not connected");
      return { ...projectSpeedToLead(deps.enquiries(), new Date(now())), watcherScheduled: deps.enquiryWatcherScheduled === true } satisfies EnquiryPanel;
    },
    async needsYou(signal, options = {}) {
      const [today, email, agent] = await Promise.all([
        read("today", options),
        read("email", options),
        deps
          .get("/__operator/jarvis/status", signal)
          .then((s: any) =>
            s?.approvals?.ok === true && typeof s.approvals.data?.count === "number"
              ? ({ ok: true, count: s.approvals.data.count, at: typeof s.approvals.at === "string" ? s.approvals.at : null } as const)
              : ({ ok: false, error: typeof s?.approvals?.error === "string" ? s.approvals.error.slice(0, 160) : "Agent approvals unavailable" } as const),
          )
          .catch((error: unknown) => ({ ok: false, error: String((error as Error)?.message ?? error).slice(0, 160) }) as const),
      ]);
      return needsYouFrom({ today, email, agent }) satisfies NeedsYouPanel;
    },
  };

  return {
    panel<K extends PanelName>(name: K, options: ReadOptions = {}): Promise<WorkspaceSnapshot[K]> {
      return read(name, options) as Promise<WorkspaceSnapshot[K]>;
    },
    async all(options: ReadOptions = {}): Promise<WorkspaceSnapshot> {
      const results = await Promise.all(PANELS.map((n) => read(n, options)));
      return Object.fromEntries(PANELS.map((n, i) => [n, results[i]])) as unknown as WorkspaceSnapshot;
    },
  };
}
