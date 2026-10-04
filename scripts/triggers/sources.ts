// Source adapters: each turns something that already exists in the OS into TriggerEvents, projecting only
// ids and short safe fields. Reading is read-only and goes through the OS's own code paths.
import type { AgencyFeedState } from "../receptionist/types";
import type { TriggerEngine } from "./engine";
import type { TriggerEvent } from "./types";

export const SYNTHETIC_ENQUIRY = "synthetic.enquiry";
export const RECEPTIONIST_FLAG = "receptionist.flag";

/** A made-up "new enquiry" (the speed-to-lead shape: a reference and a topic, nothing about a person). */
export function syntheticEnquiry(ref: string, topic: string, extra: Partial<TriggerEvent> = {}): TriggerEvent {
  return { source: SYNTHETIC_ENQUIRY, eventId: ref, actor: "external", fields: { ref, topic }, ...extra };
}

/** Receptionist QA flags (agency feed) as events. The feed's own open-flag list when it sends one (round 2); otherwise the flagged calls in the full view, projected to id, codes and band only. Identity = the call plus its flag codes, so a new code on the same call is a new event. */
export function flagEvents(feed: AgencyFeedState, options: { now: number; lookbackMs?: number; max?: number }): TriggerEvent[] {
  if (!feed.ok) return [];
  const flags =
    feed.qaFlags ??
    (feed.calls ?? [])
      .filter((c) => (c.qa?.flagCount ?? 0) > 0)
      .map((c) => ({ callId: c.id, codes: c.qa?.flagCodes ?? [], severity: c.qa?.topBand ?? null, orgId: c.organizationId, at: c.startedAt }));
  const since = options.now - (options.lookbackMs ?? 24 * 3600_000);
  const events: TriggerEvent[] = [];
  for (const f of flags) {
    const at = f.at ? Date.parse(f.at) : NaN;
    if (Number.isFinite(at) && at < since) continue;
    const codes = [...f.codes].sort();
    events.push({
      source: RECEPTIONIST_FLAG,
      eventId: `${f.callId}:${codes.join("+")}`,
      occurredAt: Number.isFinite(at) ? at : undefined,
      actor: "external",
      fields: { callId: f.callId, codes: codes.join(","), ...(f.severity ? { severity: f.severity } : {}) },
    });
    if (events.length >= (options.max ?? 10)) break;
  }
  return events;
}

export type PollResult = { ok: boolean; reason?: string; seen: number; jobs: number; duplicates: number; ignored: number };

/** One read-only poll of the receptionist feed: counts out, never contents. */
export async function pollReceptionistFlags(
  engine: TriggerEngine,
  read: (force?: boolean) => Promise<AgencyFeedState>,
  options: { now: number; lookbackMs?: number; max?: number },
): Promise<PollResult> {
  const feed = await read(true);
  if (!feed.ok) return { ok: false, reason: feed.reason, seen: 0, jobs: 0, duplicates: 0, ignored: 0 };
  const events = flagEvents(feed, options);
  const out: PollResult = { ok: true, seen: events.length, jobs: 0, duplicates: 0, ignored: 0 };
  for (const event of events)
    for (const r of await engine.deliver(event)) {
      if (r.status === "job") out.jobs++;
      else if (r.status === "duplicate") out.duplicates++;
      else if (r.status === "ignored") out.ignored++;
    }
  return out;
}
