// Who decided a step, as the UI shows it (round 10). Pure and shared: the job inspector, the Jarvis thread card and the command pill
// read the SAME label, so a rule's decision is never shown as Jev's anywhere.
//
// Input: a job step's `jev` record (scripts/jobs/types.ts JevDecisionRef) or a streamed decision (scripts/jarvis-command/contracts.ts
// JevDecision). Output: a short label, one plain detail line and a tone for styling. Nothing here is invented: a missing field stays missing.

export type DecidedByInput = {
  decidedBy?: string | null;
  /** A streamed JevDecision says who decided as `source`. */
  source?: string | null;
  op?: string;
  confidence?: number;
  ms?: number;
  requestId?: string;
  model?: string;
  options?: string[];
  cached?: boolean;
  why?: string;
};

export type DecidedByView = {
  /** "Jev", "Rule", "Fallback", "Page context", "Registry" or "Unknown". */
  label: string;
  /** One plain line: what Jev chose and how, or why a rule or fallback ran. */
  detail: string;
  /** For styling only: Jev (decided), rule (deterministic), fallback (Jev was out), neutral (anything else). */
  tone: "jev" | "rule" | "fallback" | "neutral";
};

const by = (x: DecidedByInput) => {
  const v = x.decidedBy ?? x.source ?? "";
  return v === "rules" ? "rule" : v;
};

/** The label and detail for one decision. Pure. */
export function decidedByView(x: DecidedByInput | null | undefined): DecidedByView {
  if (!x) return { label: "Unknown", detail: "No decision was recorded for this step.", tone: "neutral" };
  const who = by(x);
  if (who === "jev") {
    const bits = [
      x.op ? `chose ${x.op}` : "decided",
      typeof x.confidence === "number" ? `at ${Math.round(x.confidence * 100)}%` : null,
      x.options?.length ? `from ${x.options.join(", ")}` : null,
      x.cached ? "(cached)" : typeof x.ms === "number" ? `in ${x.ms} ms` : null,
    ].filter(Boolean);
    return { label: "Jev", detail: `Jev ${bits.join(" ")}.${x.requestId ? ` Request ${x.requestId.slice(0, 12)}.` : ""}`, tone: "jev" };
  }
  if (who === "fallback") {
    const reason = /Jev unavailable: ([\w-]+)/.exec(x.why ?? "")?.[1];
    return { label: "Fallback", detail: `Jev was unavailable${reason ? ` (${reason === "no-key" ? "no TypeSafe key" : reason})` : ""}, so an exact, safe action ran by rule.`, tone: "fallback" };
  }
  if (who === "rule") return { label: "Rule", detail: x.op ? `An exact rule decided this (${x.op}); no model was asked.` : "An exact rule decided this; no model was asked.", tone: "rule" };
  if (who === "context") return { label: "Page context", detail: "Decided from what the page shows.", tone: "rule" };
  if (who === "registry") return { label: "Registry", detail: "Decided from the OS's own page list.", tone: "rule" };
  return { label: "Unknown", detail: "Who decided this wasn't recorded.", tone: "neutral" };
}
