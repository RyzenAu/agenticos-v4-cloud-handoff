// Agent workspaces (Computers): the plain-words summary and the typed reads/writes behind a shared computer's workspace.
// Everything here is something a service reported. A field the hub didn't send reads "not reported"; nothing is guessed.
// Open Dot (composio-community/open-dot @ f838e17) was studied for how an agent's workspace is organised; no code or copy is taken from it.
import { screenFailing, type ComputerView } from "./computers-client";
import type { Tone } from "@/components/ds";

/** One computer job, as GET /__computers/jobs/:id returns it (scripts/computers/service.ts jobView). */
export type ComputerJobStep = { seq: number; executor: string; action: string | null; outcome: string; ms: number; intent: string; verification: { method: string; ok: boolean | null; evidence?: string } | null;
  /** Who decided this step, when the job store recorded it (a rule is never shown as Jev). Absent: nothing is claimed. */
  jev?: import("./commands/decided-by").DecidedByInput | null };

/** Pure: a step's check in words ("checked: read it back"), or null when the step wasn't checked. */
export function verificationText(v: ComputerJobStep["verification"]): string | null {
  if (!v) return null;
  return `${v.ok === true ? "checked" : v.ok === false ? "check failed" : "not checked"}: ${v.evidence ?? v.method}`;
}
export type ComputerJobView = {
  id: string;
  state: "queued" | "running" | "awaiting-approval" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
  note: string | null;
  title: string;
  computer: string | null;
  agent: string | null;
  paused: boolean;
  steps: ComputerJobStep[];
};

export const JOB_STATE_WORD: Record<ComputerJobView["state"], string> = {
  queued: "Queued",
  running: "Running",
  "awaiting-approval": "Waiting for approval",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
  unknown: "Outcome not known",
};
export const JOB_STATE_TONE: Record<ComputerJobView["state"], Tone> = {
  queued: "info",
  running: "info",
  "awaiting-approval": "warn",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warn",
  unknown: "warn",
};
export const jobIsFinished = (s: ComputerJobView["state"]) => ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(s);

export type WorkspaceSummary = {
  /** "Research computer — checking three businesses". Always one line. */
  headline: string;
  tone: Tone;
  /** What genuinely waits for this person, or null. */
  waiting: string | null;
};

const lower1 = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Pure: the one-line summary of a shared computer, and what (if anything) waits for the signed-in person. */
/** An agent id as a name a person reads ("research" -> "Research"), when the bot's own name is not known. */
export const agentDisplay = (id: string) => (id ? id.charAt(0).toUpperCase() + id.slice(1) : "The agent");

/** Pure: the one-line summary of a shared computer, and what (if anything) waits for the signed-in person. `agentName`: the bot's name for an agent id (round 8: it said "research's job is paused"). */
export function computerSummary(c: ComputerView, me: string | null, nameOf: (id: string) => string = (id) => id, job: ComputerJobView | null = null, agentName: (id: string) => string = agentDisplay): WorkspaceSummary {
  const name = c.label || c.name;
  const holder = c.controller;
  const mine = holder.kind === "person" && holder.who === me;
  if (c.state === "failed" || c.failure) {
    return { headline: `${name} — failed`, tone: "danger", waiting: `Waiting for you — start ${name} again${c.failure ? `: ${c.failure.reason}` : ""}` };
  }
  if (c.state === "starting") return { headline: `${name} — starting`, tone: "info", waiting: null };
  if (c.state === "offline") return { headline: `${name} — offline`, tone: "neutral", waiting: null };
  if (c.state === "asleep") return { headline: `${name} — asleep`, tone: "neutral", waiting: null };
  if (c.takeoverPending) {
    const who = c.takeoverPending.by === me ? "you are" : `${nameOf(c.takeoverPending.by)} is`;
    return { headline: `${name} — ${who} taking over, the agent pauses at its next safe step`, tone: "info", waiting: null };
  }
  if (holder.kind === "person") {
    const who = mine ? "you have the controls" : `${nameOf(holder.who ?? "someone")} has the controls`;
    if (mine) {
      return { headline: `${name} — ${who}${c.paused ? `, ${agentName(c.paused.agent)}'s job is paused` : ""}`, tone: "accent" as Tone, waiting: c.paused ? `Waiting for you — return the controls so ${agentName(c.paused.agent)}'s job can carry on` : null };
    }
    return { headline: `${name} — ${who}`, tone: "info", waiting: null };
  }
  if (holder.kind === "agent" && c.assigned) return { headline: `${name} — ${lower1(c.assigned.title || c.assigned.jobId)}`, tone: "info", waiting: job?.state === "awaiting-approval" ? `Waiting for you — approve the step ${c.assigned.agent} asked about` : null };
  // Up, but its screen is known to be failing (the hub's own layer and viewer checks): not "ready for work", and not plain online.
  if (screenFailing(c)) return { headline: `${name} — online, but its screen isn't ready`, tone: "warn", waiting: null };
  if (c.lastJob && job && job.id === c.lastJob.jobId) {
    if (job.state === "failed" || job.state === "unknown" || job.state === "interrupted") return { headline: `${name} — ready, the last job did not finish`, tone: "warn", waiting: null };
  }
  return { headline: `${name} — ready for work`, tone: "success", waiting: null };
}

/** Pure: the sentence under "Latest result". The job's own note first, else what the last step did. */
export function jobResultText(job: ComputerJobView | null): string {
  if (!job) return "No job has run on this computer since the hub started.";
  const ran = job.steps.filter((s) => s.outcome !== "skipped");
  const last = ran.at(-1);
  const verified = ran.filter((s) => s.verification?.ok === true).length;
  if (job.state === "running" || job.state === "queued") return last ? `Working: ${last.intent}` : "Starting.";
  const head = JOB_STATE_WORD[job.state];
  const steps = job.steps.length ? ` ${ran.length} of ${job.steps.length} steps ran${verified ? `, ${verified} checked against the real result` : ""}.` : "";
  return `${head}.${job.note ? ` ${job.note}` : ""}${steps}`;
}

/** Pure: the files and outputs this job's steps touched, as the steps reported them (nothing is listed that no step said). */
export function jobFiles(job: ComputerJobView | null): { seq: number; text: string; outcome: string }[] {
  if (!job) return [];
  return job.steps
    .filter((s) => (s.outcome === "ok" || s.outcome === "failed") && /file\.(write|read|list)|\b(wrote|read|listed)\b.*\bbytes?\b/i.test(`${s.executor} ${s.action ?? ""} ${s.intent}`))
    .map((s) => ({ seq: s.seq, text: s.intent.replace(/^step \d+ file\.\w+: /, ""), outcome: s.outcome }));
}

// ------------------------------------------------------------- client

async function token(): Promise<string> {
  const t = await fetch("/__token").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return typeof t?.token === "string" ? t.token : "";
}

export async function readComputerJob(id: string): Promise<ComputerJobView | null> {
  try {
    const r = await fetch(`/__computers/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const b = (await r.json()) as { job?: ComputerJobView };
    return b.job && Array.isArray(b.job.steps) ? b.job : null;
  } catch {
    return null;
  }
}

/** The work a person can hand a computer from the page: open a page it will check, and keep a note of what it was asked. */
export type AssignInput = { title: string; url: string; agent: string };

/** Pure: the typed steps for an assignment. The hub validates them again and refuses anything risky. */
export function assignSteps(input: AssignInput, caps: readonly string[] | null): { ok: true; steps: { executor: string; args: Record<string, unknown>; timeoutMs?: number }[] } | { ok: false; reason: string } {
  const title = input.title.trim();
  if (!title) return { ok: false, reason: "Say what this computer should do." };
  const steps: { executor: string; args: Record<string, unknown>; timeoutMs?: number }[] = [];
  const url = input.url.trim();
  if (url) {
    if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) return { ok: false, reason: "The page address must start with https:// (or http://)." };
    if (caps && !caps.includes("browser.navigate")) return { ok: false, reason: "This computer has no browser, so it can't open a page." };
    steps.push({ executor: "browser.navigate", args: { url }, timeoutMs: 30_000 });
  }
  if (caps && !caps.includes("file.write")) {
    if (!steps.length) return { ok: false, reason: "This computer can't keep notes yet, and no page was given." };
  } else {
    steps.push({ executor: "file.write", args: { name: "task-note.txt", text: `${title}\n${url ? `Page: ${url}\n` : ""}` } });
  }
  return { ok: true, steps };
}

export async function assignWork(computer: string, input: AssignInput, caps: readonly string[] | null): Promise<{ ok: boolean; message: string; jobId?: string }> {
  const built = assignSteps(input, caps);
  if (!built.ok) return { ok: false, message: built.reason };
  try {
    const r = await fetch(`/__computers/${encodeURIComponent(computer)}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-os-token": await token() },
      body: JSON.stringify({ agent: input.agent.trim() || "agent", title: input.title.trim(), steps: built.steps }),
    });
    const d = (await r.json().catch(() => ({}))) as { jobId?: string; error?: string };
    if (!r.ok) return { ok: false, message: d.error ?? `That didn't work (${r.status}).` };
    return { ok: true, message: "Started. Its progress shows here.", ...(d.jobId ? { jobId: d.jobId } : {}) };
  } catch {
    return { ok: false, message: "The computers service couldn't be reached." };
  }
}

/** Cancel a computer job (the hub stops at the current step and skips the rest). */
export async function cancelComputerJob(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetch(`/__computers/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "x-claude-os-token": await token() }, body: "{}" });
    const d = (await r.json().catch(() => ({}))) as { cancelled?: boolean; state?: string };
    return d.cancelled ? { ok: true, message: "Stopped. The steps that hadn't run were skipped." } : { ok: false, message: `It was already ${d.state ?? "finished"}.` };
  } catch {
    return { ok: false, message: "The computers service couldn't be reached." };
  }
}
