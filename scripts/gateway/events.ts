/**
 * What the live activity stream (/__events) may tell the Dot gateway's principal. Scope already limits Dot to "shared"
 * events (never a founder's own devices or conversations); this narrows the shared ones to what Dot's allowed pages need:
 *
 *   job       only for CODING jobs (the Coding page). Not memory or trigger jobs.
 *   nothing else: no approval (merge, deploy, provider, trigger reviews), computer, lease, device, agent, jarvis or thread.
 *
 * The snapshot a new connection receives is cut the same way.
 */
export const DOT_EVENT_TOPICS: readonly string[] = ["job"];
export const DOT_JOB_KINDS: readonly string[] = ["coding"];

export function dotEventAllowed(e: { topic: string; tag?: string }): boolean {
  return e.topic === "job" && !!e.tag && DOT_JOB_KINDS.includes(e.tag);
}

export function dotSnapshot(snapshot: unknown): Record<string, unknown> {
  const s = (snapshot && typeof snapshot === "object" ? snapshot : {}) as Record<string, unknown>;
  const jobs = Array.isArray(s.jobs) ? s.jobs.filter((j) => DOT_JOB_KINDS.includes(String((j as { kind?: unknown })?.kind))) : [];
  return { jobs, ...(typeof s.jobsHead === "number" ? { jobsHead: s.jobsHead } : {}), approvals: [], computers: [], devices: [] };
}

/** The stream principal for a gateway request (scripts/events/plugin.ts and the tests' hub use this same function). */
export function gatewayStreamPrincipal<P>(personId: P, fullSnapshot: () => unknown) {
  return { personId, allow: dotEventAllowed, snapshot: () => dotSnapshot(fullSnapshot()) };
}
