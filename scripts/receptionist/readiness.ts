import type { AgentFacts } from "./retell";
import type {
  Blocker,
  BlockerId,
  CallRow,
  CommercialBlock,
  FlagCode,
  IncidentPatch,
  ReadinessBlock,
  ReadinessPatch,
  Source,
} from "./types";
export type Signoffs = Partial<
  Record<BlockerId, { done: boolean; by: string; at: string; note?: string }>
>;
export const manualIds = [
  "urgent-wording",
  "compliance",
  "hours-handoff",
  "cost-reconciliation",
] as const;
/**
 * Who a stored sign-off or follow-up is attributed to: trimmed, 1–40 characters. The server passes
 * the verified principal's name; it never comes from a request body (audit RX-5).
 */
export function validateActor(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 40) throw new Error("Invalid actor");
  return value.trim();
}

/** The verified principal's name for the audit trail: people.json display name, else the person id. */
export function actorName(principal: { displayName?: string; personId: string } | null | undefined): string {
  const name = principal?.displayName?.trim() || principal?.personId?.trim() || "";
  if (!name) throw new Error("No verified principal");
  return name.slice(0, 40);
}

/**
 * A readiness patch from a request body. A `by` key is tolerated (older pages sent one) but IGNORED:
 * the recorded signer is always the verified principal (audit RX-5).
 */
export function validatePatch(value: unknown): ReadinessPatch {
  const p = value as ReadinessPatch;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some((k) => !["id", "done", "by", "note"].includes(k)) ||
    !(manualIds as readonly string[]).includes(p.id) ||
    typeof p.done !== "boolean" ||
    (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 200))
  )
    throw new Error("Invalid readiness patch");
  return {
    id: p.id,
    done: p.done,
    ...(p.note !== undefined ? { note: p.note } : {}),
  };
}

/** Follow-ups on flagged calls, stored beside the sign-offs. */
export type FollowUps = Record<string, { by: string; at: string; note?: string }>;
const CALL_ID = /^call_[A-Za-z0-9]{6,64}$/;
/** A follow-up from a request body; as with sign-offs, a body `by` is ignored (audit RX-5). */
export function validateIncidentPatch(value: unknown): IncidentPatch {
  const p = value as IncidentPatch;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some((k) => !["callId", "by", "note"].includes(k)) ||
    typeof p.callId !== "string" ||
    !CALL_ID.test(p.callId) ||
    (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 200))
  )
    throw new Error("Invalid follow-up");
  return { callId: p.callId, ...(p.note !== undefined ? { note: p.note } : {}) };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "26 Sep", in Sydney. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const sydneyShort = (iso: string) => {
  // en-AU writes "Sept"; the page and Jarvis use three-letter months.
  const [, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(iso))
    .split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
};

/** A real call we can learn from: a phone call of 20 s or more whose transcript was checked. */
export const qualifying = (c: CallRow) => c.kind === "phone" && (c.durationSec ?? 0) >= 20 && c.checked;

const RELEVANT: Record<BlockerId, FlagCode[]> = {
  "no-false-actions": ["FALSE_BOOKING", "SMS_PROMISE"],
  "urgent-wording": ["URGENT_NO_000", "CLINICAL_ADVICE", "DANGER_LANGUAGE", "LEGAL_URGENT", "URGENT_NO_HUMAN_ROUTE"],
  compliance: ["NO_AI_DISCLOSURE"],
  "hours-handoff": ["URGENT_NO_HUMAN_ROUTE"],
  "cost-reconciliation": [],
};

export function buildReadiness(input: {
  calls: Source<{ rows: CallRow[] }>;
  agent: Source<AgentFacts>;
  sms: boolean | null;
  legal: "present" | "missing" | "unknown";
  signoffs: Signoffs;
  economics: CommercialBlock["economics"];
  twilioMonth: Source<{ usd: number }>;
  /** The resolved line, formatted (plugin.ts resolveLine); never a hard-coded number (audit RX-6). */
  line?: string;
}): ReadinessBlock {
  const rows = input.calls.ok
    ? [...input.calls.rows].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    : [];
  // Everything is judged against the agent as it is NOW: calls before the last agent/prompt change
  // are history, not evidence about the current prompt.
  const changedAt = input.agent.ok && input.agent.modified ? Date.parse(input.agent.modified) : null;
  const changeLabel = changedAt !== null ? `the ${sydneyShort(input.agent.ok ? input.agent.modified! : "")} prompt change` : null;
  const after = (c: CallRow) => changedAt === null || (!!c.startedAt && Date.parse(c.startedAt) > changedAt);
  const real = rows.filter(qualifying);
  const realAfter = real.filter(after);

  let count = 0;
  // An unchecked real call breaks the streak: we can't vouch for what it said.
  for (const c of rows.filter((c) => c.kind === "phone" && (c.durationSec ?? 0) >= 20 && after(c))) {
    if (!c.checked || c.flags.some((f) => RELEVANT["no-false-actions"].includes(f))) break;
    count++;
  }
  const total = (flag: FlagCode) => (input.calls.ok ? String(rows.filter((c) => c.flags.includes(flag)).length) : "unknown");
  const fact = (key: "prompt000" | "disclosure" | "recording" | "overseas" | "transfer") =>
    input.agent.ok && input.agent.promptKnown ? (input.agent[key] ? "yes" : "no") : "unknown";
  const last = rows.find((c) => c.flags.includes("FALSE_BOOKING") || c.flags.includes("SMS_PROMISE"));
  const e = input.economics;

  const missing: string[] = [];
  if (fact("disclosure") === "no") missing.push("AI disclosure");
  if (fact("recording") === "no") missing.push("NSW recording consent");
  if (fact("overseas") === "no") missing.push("APP 8 overseas-processing wording");
  const complianceNext = missing.length
    ? `Add ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")} to the prompt, then sign off`
    : "Hear the disclosure and consent on a real call, then sign off";

  const blockers: Blocker[] = [
    {
      id: "no-false-actions",
      title: "No false bookings or SMS promises",
      mode: "derived",
      done: count >= 5,
      state: "open",
      evidence: [
        `Clean real calls in a row${changeLabel ? ` since ${changeLabel}` : ""}: ${input.calls.ok ? count : "unknown"}/5`,
        `Last false booking/SMS flag: ${input.calls.ok ? (last?.startedAt ? sydneyShort(last.startedAt) : "none on record") : "unknown"}`,
      ],
      next: `Make 5 real test calls on ${input.line?.trim() || "the receptionist line"} that try to book and ask for a text`,
    },
    {
      id: "urgent-wording",
      title: "Urgent wording (000, no diagnosis)",
      mode: "manual",
      done: false,
      state: "open",
      evidence: [
        `Prompt mentions 000: ${fact("prompt000")}`,
        `Calls flagged urgent-without-000: ${total("URGENT_NO_000")} · clinical advice: ${total("CLINICAL_ADVICE")}`,
        `Danger language: ${total("DANGER_LANGUAGE")} · legal urgency: ${total("LEGAL_URGENT")} · missing human route: ${total("URGENT_NO_HUMAN_ROUTE")}`,
      ],
      next: "Run the urgent scenarios on a real call, then sign off",
    },
    {
      id: "compliance",
      title: "AI disclosure, recording consent, APP 8",
      mode: "manual",
      done: false,
      state: "open",
      evidence: [
        `Prompt: AI disclosure ${fact("disclosure")} · recording ${fact("recording")} · overseas/APP 8 ${fact("overseas")}`,
        `Calls missing AI disclosure: ${total("NO_AI_DISCLOSURE")}`,
      ],
      next: complianceNext,
    },
    {
      id: "hours-handoff",
      title: "Per-client hours and human handoff",
      mode: "manual",
      done: false,
      state: "open",
      evidence: [`Transfer tool on agent: ${fact("transfer")}`, "Handoff alerts delivered: not verified"],
      next: "Set per-client hours and prove one live transfer + alert",
    },
    {
      id: "cost-reconciliation",
      title: "Cost reconciliation (Retell + Twilio)",
      mode: "manual",
      done: false,
      state: "open",
      evidence: [
        e.retellAudPerMinute === null
          ? "Retell cost: unavailable"
          : `Retell A$${e.retellAudPerMinute.toFixed(2)}/min measured on ${plural(e.measuredCalls, "call")} (${Math.round(e.measuredMinutes)} min)`,
        `Twilio month to date: ${input.twilioMonth.ok ? `US$${input.twilioMonth.usd.toFixed(2)} (whole account)` : "unavailable"}`,
      ],
      next: "Match one month of Retell + Twilio invoices to calls",
    },
  ];

  // What each gate's evidence needs to show NOW. A sign-off never stands in for it (UI-truth H5):
  // "Transfer tool on agent: no" can't pass "Per-client hours and human handoff" on a signature.
  const evidenceGaps: Record<BlockerId, string[]> = {
    "no-false-actions": count >= 5 ? [] : [`${input.calls.ok ? count : "unknown"}/5 clean real calls`],
    "urgent-wording": fact("prompt000") === "yes" ? [] : [`prompt mentions 000: ${fact("prompt000")}`],
    compliance: (["disclosure", "recording", "overseas"] as const)
      .filter((k) => fact(k) !== "yes")
      .map((k) => `${k === "overseas" ? "overseas/APP 8" : k === "disclosure" ? "AI disclosure" : "recording consent"}: ${fact(k)}`),
    "hours-handoff": fact("transfer") === "yes" ? [] : [`transfer tool on agent: ${fact("transfer")}`],
    "cost-reconciliation": [
      ...(e.retellAudPerMinute === null ? ["Retell cost not measured"] : []),
      ...(input.twilioMonth.ok ? [] : ["Twilio month unavailable"]),
    ],
  };

  for (const b of blockers) {
    const relevant = RELEVANT[b.id];
    const gaps = evidenceGaps[b.id];
    b.evidencePresent = gaps.length === 0;
    const flaggedAfter = realAfter.filter((c) => c.flags.some((f) => relevant.includes(f)));
    const flaggedBefore = real.filter((c) => !after(c) && c.flags.some((f) => relevant.includes(f)));
    const sign = b.mode === "manual" ? input.signoffs[b.id] : undefined;
    if (sign) {
      b.done = sign.done;
      // A reopened gate is not "signed off" (audit RX-4): it records who reopened it instead.
      const record = { by: sign.by, at: sign.at, ...(sign.note ? { note: sign.note } : {}) };
      if (sign.done) b.signedOff = record;
      else b.reopened = record;
    }
    if (relevant.length && flaggedAfter.length) {
      b.state = "fail";
      b.done = false;
      b.stateNote = `${plural(flaggedAfter.length, "flagged call")} since ${changeLabel ?? "the current prompt"}`;
      if (sign?.done) b.warning = "Signed off, but a real call since the last prompt change was flagged";
    } else if (b.done) {
      b.state = "pass";
      b.stateNote = sign?.done ? `Signed off by ${sign.by}` : `${count} clean real calls since ${changeLabel ?? "records began"}`;
    } else if (relevant.length && !input.calls.ok) {
      // Calls unread: whether a real call tested this gate is unknown, never "no real call" (RX-8).
      b.state = "unknown";
      b.stateNote = `Unknown · couldn't read calls (${input.calls.reason})`;
      b.next = `Refresh once the Retell calls can be read, then: ${b.next[0].toLowerCase()}${b.next.slice(1)}`;
    } else if (relevant.length && !realAfter.length) {
      b.state = "not-tested";
      b.stateNote = flaggedBefore.length
        ? `${plural(flaggedBefore.length, "flagged call")}, before ${changeLabel}`
        : `No real call since ${changeLabel ?? "records began"}`;
    } else {
      b.state = b.mode === "derived" ? "not-tested" : "open";
      b.stateNote = b.mode === "manual" ? "Needs sign-off" : `${count} of 5 clean real calls so far`;
    }
    // A sign-off made before the agent/prompt last changed may no longer describe the agent.
    if (
      sign?.done &&
      b.state === "pass" &&
      changedAt !== null &&
      changedAt > Date.parse(sign.at) &&
      input.agent.ok &&
      ((b.id === "urgent-wording" && !input.agent.prompt000) ||
        (b.id === "compliance" && (!input.agent.disclosure || !input.agent.recording || !input.agent.overseas)) ||
        (b.id === "hours-handoff" && !input.agent.transfer))
    ) {
      b.warning = "The prompt changed after this sign-off and no longer shows the evidence; review it";
      b.state = "evidence-missing";
      b.done = false;
      b.stateNote = "Evidence missing after the prompt change";
      b.next = b.id === "urgent-wording"
        ? "Restore 000 wording, run the urgent scenarios on a real call, then sign off"
        : b.id === "compliance" ? complianceNext
          : "Restore the transfer tool, set per-client hours and prove one live transfer + alert";
    } else if (sign?.done && b.state === "pass" && gaps.length) {
      // Signed off, but the evidence isn't there (never was, or can't be read): not a pass.
      b.warning = `Signed off, but the evidence doesn't show it: ${gaps.join("; ")}`;
      b.state = "evidence-missing";
      b.done = false;
      b.stateNote = `Evidence missing: ${gaps.join("; ")}`;
      b.next = b.id === "urgent-wording"
        ? "Add 000 wording to the prompt, run the urgent scenarios on a real call, then sign off"
        : b.id === "compliance" ? complianceNext
          : b.id === "hours-handoff" ? "Add the transfer tool to the agent, set per-client hours and prove one live transfer + alert"
            : "Measure Retell cost on real calls and read the Twilio month, then reconcile the invoices";
    } else if (!sign?.done && b.state === "open" && gaps.length) {
      b.stateNote = `Evidence missing: ${gaps.join("; ")}`;
    }
  }

  return {
    blockers,
    open: blockers.filter((b) => b.state !== "pass").length,
    cleanStreak: { count, target: 5 },
    ownerRetestCalls: rows.some(c => c.ownerTestBy?.trim())
      ? { count: new Set(realAfter.filter(c => c.ownerTestBy?.trim()).map(c => c.id)).size, target: 5 }
      : null,
    facts: [
      {
        id: "legal-template",
        label: "LEGAL template",
        tone: input.legal === "present" ? "ok" : input.legal === "missing" ? "bad" : "neutral",
        detail:
          input.legal === "present"
            ? "Legal niche playbook present in MU-Receptionist"
            : input.legal === "missing"
              ? "No legal niche playbook in MU-Receptionist yet (dental and real estate only)"
              : "Couldn't read MU-Receptionist's niche list",
      },
      {
        id: "sms",
        label: "SMS",
        tone: input.sms === null ? "neutral" : input.sms ? "ok" : "warn",
        detail: input.sms === null ? "Unknown" : input.sms ? "Configured on the number" : "Not configured on the number — the agent must never promise a text",
      },
    ],
  };
}
