// How the OS mounts the trigger service (operator-plugin calls this and nothing else from scripts/triggers).
// Owner process only: a quiet read-only copy (AGENTIC_OS_NO_BACKGROUND=1) never opens or writes the trigger store.
import { personNotifier } from "../approvals/notify";
import { jobsRuntime } from "../jobs/runtime";
import { backgroundJobsDisabled } from "../preview-guard";
import { providerKey } from "../provider-config";
import { createAgencyFeed } from "../receptionist/agency-feed";
import type { ActionDeps } from "./actions";
import { createTriggerService, type TriggerService } from "./service";
import { localOwnerHeaders } from "../identity/local-owner-token";

/** Counts only: how many entries each section of the existing morning-brief context holds. */
export function countSections(context: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!context || typeof context !== "object") return counts;
  for (const [key, value] of Object.entries(context as Record<string, unknown>).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(key)) continue;
    if (Array.isArray(value)) counts[key] = value.length;
    else if (value && typeof value === "object") counts[key] = Object.keys(value).length;
  }
  return counts;
}

export function briefSummaryFrom(origin: () => string, request: typeof fetch = fetch): NonNullable<ActionDeps["briefSummary"]> {
  return async () => {
    const base = origin();
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(base)) throw new Error("The local OS address isn't known yet.");
    const response = await request(`${base}/__operator/business/brief/context`, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: localOwnerHeaders() });
    if (!response.ok) throw new Error(`The brief context returned HTTP ${response.status}.`);
    return { counts: countSections(await response.json()) };
  };
}

export function mountTriggers(options: { root: string; origin: () => string }) {
  let service: TriggerService | null = null;
  /** The service, or null in a quiet read-only copy (it must not write). */
  const get = (): TriggerService | null => {
    if (service) return service;
    if (backgroundJobsDisabled()) return null;
    const runtime = jobsRuntime(options.root);
    service = createTriggerService({
      root: options.root,
      jobs: runtime.jobs,
      approvals: runtime.approvals,
      feed: createAgencyFeed({ providerKey: (name) => providerKey(options.root, name), view: "full" }),
      deps: { briefSummary: briefSummaryFrom(options.origin) },
      // Off unless the owner sets MU_TRIGGERS_NOTIFY=1: it sends the approval code to his OWN Telegram DM.
      notifyCode: process.env.MU_TRIGGERS_NOTIFY === "1" ? (code, summary) => void personNotifier(options.root)("usman", `Approval needed: ${summary}. Reply: approve ${code}`).catch(() => undefined) : undefined,
    });
    return service;
  };
  return {
    get,
    /** Start the periodic tick (60 s). MU_TRIGGERS=off leaves the service mounted but idle. */
    start() {
      if (process.env.MU_TRIGGERS === "off") return;
      try {
        get()?.start();
      } catch {
        /* the stores are unavailable: the Automations page shows no triggers */
      }
    },
    close() {
      service?.close();
      service = null;
    },
  };
}
