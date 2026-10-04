/** Immutable request binding for the durable jobs ledger. Only the digest is stored. */
import { createHash } from "node:crypto";
import { jarvisThreadId } from "../conversations";
import type { CommandAdmissionKey } from "../jobs/command-admission";
import type { RunInput } from "./service";
import type { CommandDoneEvent } from "./contracts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}

export function commandAdmissionKey(input: RunInput, eventId: string): CommandAdmissionKey {
  const { principal, body } = input;
  const pageContext = body.pageContext ? { ...body.pageContext, capturedAt: undefined } : null;
  const binding = createHash("sha256").update(JSON.stringify(canonical({
    personId: principal.personId,
    actor: principal.actor,
    deviceId: principal.deviceId ?? null,
    conversationId: body.conversationId ?? jarvisThreadId(principal.personId),
    utterance: String(body.utterance ?? "").trim(),
    source: body.source ?? "typed",
    target: body.target ?? null,
    spokenTarget: body.spokenTarget ?? null,
    pageContext,
    steps: body.steps ?? null,
    subjects: body.subjects ?? null,
  }))).digest("hex");
  return { personId: principal.personId, eventId, binding };
}

export const commandPrevented = (): CommandDoneEvent => ({ type: "done", ok: true, stopped: true, said: "Stopped before it started. Nothing ran.", kind: "answer", jobId: null, runId: "", targetDeviceId: null, numbers: { stoppedBeforeStart: true }, verified: true });
