/**
 * Jarvis's hands: hands a spoken task to Hermes (terminal, browser, files, apps,
 * gateways) and gates anything that leaves the machine or destroys data behind an
 * explicit spoken "yes". The gate is enforced here, in code, not by the model.
 *
 * Every task carries a code-computed risk tier (control-risk.ts): read-only,
 * local-reversible or external-effect. external-effect always needs the spoken yes.
 */
import { TASK_GATE } from "./action-keywords";
import { classifyControlTask, controlTaskRefusal, describePlan, MAX_CONTROL_TASK_CHARS, planControlTask, type ControlPlan, type RiskTier } from "./control-risk";

/** Hard refusals, before any yes is asked for and whatever the approval (audit A-H2; Wave 2, 27 Sep):
 * secret-bearing paths and private data, money movement and trading, and banks/brokers/exchanges.
 * The executor policy (scripts/jarvis-execution/control-policy.ts) refuses the same three again. */
const SECRET_REFUSAL = "Not done: that task names a secret-bearing file or private data, which desktop control never opens or reads. Nothing was done.";
const MONEY_REFUSAL = "Not done: moving money, paying, trading, or anything in a bank, broker or exchange never goes through desktop control, whatever the approval. That one is yours to do yourself. Nothing was done.";
const TOO_LONG_REFUSAL = `Not done: that task is over ${MAX_CONTROL_TASK_CHARS} characters, which is too long to check safely. Ask him for a shorter instruction. Nothing was done.`;
const refusalReply = (task: string) => {
  const kind = controlTaskRefusal(task);
  return kind === null ? null : kind === "secret-or-private-data" ? SECRET_REFUSAL : kind === "too-long" ? TOO_LONG_REFUSAL : MONEY_REFUSAL;
};
import {
  hermesReportFailed,
  outcomeFrom,
  runVerifier,
  newTaskId,
  sanitizeAuditEntry,
  targetOf,
  type AuditEntry,
  type AuditSink,
  type ControlOutcome,
  type ControlVerifier,
  type VerificationResult,
} from "./control-outcome";

// --- His answer to a yes/no question (AUDIT F4 F1, 28 Sep) -------------------------------------------------
// A yes is the WHOLE reply, built only from these phrases (plus a few courtesy words): "yes", "yeah, go
// ahead", "okay, do it", "yes please, send it". Anything else is not a yes: "okay, open notepad instead",
// "sure, but first open Spotify", "send it to Mehroz on WhatsApp", "okay wait", "yes?", "haan ji". The old
// rule (starts with yes/ok/sure/correct/send it, then up to 60 characters of anything) confirmed a Submit
// press on "okay, open notepad instead". Speech-to-text runs in English, so other languages re-ask.
const YES_PHRASES = [
  "yes", "yeah", "yep", "yup", "yea", "sure", "sure thing", "certainly", "absolutely", "affirmative", "correct",
  "that's correct", "that is correct", "that's right", "that is right", "confirm", "confirmed", "i confirm",
  "ok", "okay", "do it", "do it now", "go ahead", "go for it", "proceed", "please proceed", "please do",
  "press it", "send it", "submit it", "click it", "approve", "approved", "i approve",
  // Never here (REVIEW-S2 fix 1): "forget it" (after "Shall I press Submit?" it means no) and "save it" (it
  // names another action). Memory keeps its own read-back answers (scripts/memory/voice-intents.ts MEMORY_YES).
];
/** Courtesy words that may sit around a yes; alone they are not one. */
const YES_FILLERS = ["please", "sir", "jarvis", "hey jarvis", "mate", "thanks", "thank you", "thankyou", "cheers"];
/** "ok"/"okay" with thanks is an acknowledgement ("okay, thanks"), not an approval. */
const WEAK_YES = new Set(["ok", "okay"]);
const THANKS = new Set(["thanks", "thank you", "thankyou", "cheers"]);
const NO_START =
  /^(?:no|nope|nah|nay|negative|don'?t|do not|not|never|never ?mind|cancel|stop|abort|wait|hold on|hang on|leave it|skip it|skip that|actually no|not yet|not now|forget it|forget about it|forget that|scrap that|scrap it|drop it|no worries)\b/;
/** A negation anywhere ("absolutely not", "sure thing, actually don't"): never a yes, and read as a no. */
const NEGATION_ANYWHERE = /\b(?:no|not|nope|nah|don'?t|do not|never|cancel|stop|abort)\b/;
/** Words a hedge or a redirect starts with, before the new request itself ("okay, but first open Spotify"). */
const LEAD_IN = new Set(["ok", "okay", "sure", "yes", "yeah", "yep", "yup", "fine", "alright", "right", "well", "so", "and", "but", "then", "actually", "instead", "first", "just", "um", "uh", "er", "erm", "hmm", "oh", "wait", "hold", "on", "please", "jarvis", "hey", "no", "rather", "can", "could", "would", "you"]);
/** A new request's first word, in the imperative. */
const REQUEST_VERB =
  /^(?:open|close|launch|start|play|pause|resume|type|write|send|email|text|message|call|ring|go|search|find|look|show|click|press|tap|scroll|select|navigate|take|make|create|delete|remove|turn|switch|set|mute|unmute|read|tell|check|run|save|copy|paste|move|book|pay|buy|order|submit|post|publish|share|upload|download|minimi[sz]e|maximi[sz]e|bring|put|add|edit|change|update|log|mark|remind|remember|forget|note|do)\b/;
const MAX_YES_CHARS = 60;

const tidyReply = (utterance: string) =>
  String(utterance ?? "")
    .normalize("NFKC")
    .replace(/[‘’ʼ`´]/g, "'")
    .toLowerCase()
    .trim();
const PHRASES = [...YES_PHRASES.map((p) => ({ words: p.split(" "), core: true })), ...YES_FILLERS.map((p) => ({ words: p.split(" "), core: false }))].sort((a, b) => b.words.length - a.words.length);

/** The reply is nothing but yes phrases and courtesy words, with at least one yes. Pure. */
function wholeYes(utterance: string): boolean {
  const t = tidyReply(utterance);
  if (!t || t.length > MAX_YES_CHARS) return false;
  // A question back ("yes?"), a trailing-off ("yes..."), or anything that isn't words and plain punctuation.
  if (/[?…]|\.\.|[^a-z' ,.!;-]/.test(t)) return false;
  const words = t.replace(/[,.!;-]+/g, " ").split(/\s+/).filter(Boolean);
  let i = 0, strong = false, weak = false, thanked = false;
  while (i < words.length) {
    const hit = PHRASES.find((p) => p.words.every((w, k) => words[i + k] === w));
    if (!hit) return false;
    const phrase = hit.words.join(" ");
    if (hit.core) {
      if (WEAK_YES.has(phrase)) weak = true;
      else strong = true;
    } else if (THANKS.has(phrase)) thanked = true;
    i += hit.words.length;
  }
  return strong || (weak && !thanked);
}

/**
 * His reply to a pending yes/no question, in code:
 * - "yes": an unambiguous whole-utterance yes (wholeYes).
 * - "no": it starts with a no, a stop, a wait or a "forget it" ("no, send it later", "not yet", "forget it"), or has
 *   a negation anywhere that isn't a new request ("absolutely not").
 * - "new-request": a hedge or yes-word, then a new order ("okay, open notepad instead", "sure, but first open Spotify").
 * - "unclear": anything else ("okay wait", "sure, but", "yes after I check", "haan ji", "yes?").
 * Only "yes" may approve. Pure.
 */
export type ConfirmationReply = "yes" | "no" | "new-request" | "unclear";
export function confirmationReply(utterance: string): ConfirmationReply {
  if (wholeYes(utterance)) return "yes";
  const t = tidyReply(utterance).replace(/^(?:hey\s+)?jarvis[,\s]+/, "").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  if (NO_START.test(t)) return "no";
  const words = t.split(" ").filter(Boolean);
  let i = 0;
  while (i < words.length && LEAD_IN.has(words[i])) i++;
  const rest = words.slice(i).join(" ");
  // "okay, cancel it", "sure, never mind": a no after the lead-in.
  if (rest && NO_START.test(rest)) return "no";
  // A yes-word or hedge first, then an imperative: a new request, never a yes.
  if (rest && REQUEST_VERB.test(rest)) return "new-request";
  return NEGATION_ANYWHERE.test(t) ? "no" : "unclear";
}
export const CONFIRM_TTL_MS = 2 * 60 * 1000;
/**
 * Starts a screen_act result that is a question about a final button ("Shall I press Submit?"): the
 * voice engine speaks it, and a clear yes next turn re-sends screen_act confirmed for that button.
 */
export const SCREEN_CONFIRM_MARK = "[confirm] ";

export type PendingTask = { task: string; at: number };
/**
 * What the gate hands the executor: the exact task it approved, its tier, and how. runHermesTask
 * refuses an external-effect task unless this says "spoken-yes" for that same task text.
 */
export type ControlApproval = {
  task: string; tier: RiskTier; method: "none" | "spoken-yes"; at: number; nonce?: string; expiresAt?: number;
  /** The voice pipeline's server-side spoken-yes event id (A-M3): the server redeems it once. */
  spokenYes?: string;
};
// Only the confirmation gate issues these. Copies remain bound to one exact task and
// are consumed synchronously before any await, including when transport later fails.
const issuedApprovals = new Map<string, { task: string; at: number; expiresAt: number }>();
function issueApproval(task: string, now: number, spokenYes?: string | null): ControlApproval {
  for (const [nonce, grant] of issuedApprovals) if (grant.expiresAt <= now) issuedApprovals.delete(nonce);
  const nonce = crypto.randomUUID(), expiresAt = now + CONFIRM_TTL_MS;
  issuedApprovals.set(nonce, { task, at: now, expiresAt });
  return { task, tier: classifyControlTask(task).tier, method: "spoken-yes", at: now, nonce, expiresAt, ...(spokenYes ? { spokenYes } : {}) };
}

function consumeApproval(task: string, approval: ControlApproval | null | undefined) {
  const allowed = mayRunWithYolo(task, approval);
  if (allowed.ok && approval?.nonce) issuedApprovals.delete(approval.nonce);
  return allowed;
}
export type GateDecision =
  | { action: "run"; task: string; approval: ControlApproval }
  | { action: "ask"; pending: PendingTask; reply: string }
  | { action: "refuse"; reply: string; clearPending: boolean };

/** The unified keyword gate (action-keywords.ts): outbound, money, publishing, destructive words. */
export function needsConfirmation(task: string) {
  return task.length > MAX_CONTROL_TASK_CHARS || TASK_GATE.test(task);
}

/** Does this task need his spoken yes? The keyword gate or an external-effect tier. */
export function requiresSpokenYes(task: string) {
  return needsConfirmation(task) || classifyControlTask(task).tier === "external-effect";
}

/**
 * A short, unambiguous, whole-utterance yes. "Yes, but wait", "no, don't", "okay, open notepad instead"
 * and "send it to Mehroz" are not a yes (confirmationReply). Every yes path uses this: the voice turn, the
 * client's final-button and control gates, the server's spoken-yes ledger, lessons and memory.
 */
export function isAffirmative(utterance: string) {
  return typeof utterance === "string" && wholeYes(utterance);
}

/**
 * Decide what a control_pc call may do. A confirmed call always runs the task that
 * was read back to the user, never new text the model supplies afterwards.
 */
export function gateControlTask(input: {
  task: string;
  confirmed: boolean;
  pending: PendingTask | null;
  lastUserUtterance: string;
  /** The server's spoken-yes event id for that utterance, when it was spoken (A-M3). A typed yes has none. */
  spokenYes?: string | null;
  now: number;
  ttlMs?: number;
}): GateDecision {
  const task = input.task.trim();
  const ttl = input.ttlMs ?? CONFIRM_TTL_MS;
  const pending = input.pending && input.now >= input.pending.at && input.now - input.pending.at < ttl ? input.pending : null;
  if (!task) return { action: "refuse", reply: "No task was given. Nothing was done.", clearPending: false };
  const refused = refusalReply(task) ?? (input.confirmed && pending ? refusalReply(pending.task) : null);
  if (refused) return { action: "refuse", reply: refused, clearPending: true };
  const risk = classifyControlTask(task);
  const external = risk.tier === "external-effect" || needsConfirmation(task);
  const runNow = (): GateDecision => ({ action: "run", task, approval: { task, tier: risk.tier, method: "none", at: input.now } });
  if (!input.confirmed) {
    if (!external) return runNow();
    return {
      action: "ask",
      pending: { task, at: input.now },
      reply: `CONFIRMATION REQUIRED. Nothing has been done yet. Read this action back to the user in one sentence and ask them to confirm: ${task}
${describePlan(planControlTask(task))}`,
    };
  }
  if (!pending) {
    if (!external) return runNow();
    return {
      action: "refuse",
      reply:
        "There is no pending action awaiting confirmation (it may have expired). Nothing was done. Call control_pc without confirmed so the action can be read back and confirmed.",
      clearPending: true,
    };
  }
  if (!isAffirmative(input.lastUserUtterance))
    return {
      action: "refuse",
      reply: "The user has not clearly said yes. Nothing was done. Ask them plainly whether to go ahead.",
      clearPending: false,
    };
  // The yes covers the task that was read back, never new text the model sends with it.
  return {
    action: "run",
    task: pending.task,
    approval: issueApproval(pending.task, input.now, input.spokenYes),
  };
}

/**
 * The code check before Hermes ever sees a task. Hermes runs with `yolo` (its CLI has no terminal
 * to answer approval prompts, so without it every tool call deadlocks until the 10-minute timeout;
 * the warm API server uses the Jev approval guardian instead). So `yolo` is only ever sent when:
 * - the code tier is read-only or local-reversible AND the unified keyword gate passes, or
 * - the task is external-effect and the approval is his spoken yes for this exact task text.
 * Anything else is refused here and nothing reaches Hermes.
 */
export function mayRunWithYolo(task: string, approval: ControlApproval | null | undefined): { ok: true; tier: RiskTier } | { ok: false; tier: RiskTier; reply: string } {
  const tier = classifyControlTask(task).tier;
  const refused = refusalReply(task);
  if (refused) return { ok: false, tier: "external-effect", reply: refused };
  if (tier !== "external-effect" && !needsConfirmation(task)) return { ok: true, tier };
  const grant = approval?.nonce ? issuedApprovals.get(approval.nonce) : undefined;
  const now = Date.now();
  if (approval?.method === "spoken-yes" && grant && grant.task === task.trim() &&
      approval.task === grant.task && approval.at === grant.at && approval.expiresAt === grant.expiresAt &&
      now >= grant.at && now < grant.expiresAt) return { ok: true, tier: "external-effect" };
  return {
    ok: false,
    tier: "external-effect",
    reply: "Not run: this task has an external effect and there is no spoken yes for it. Nothing was done. Call control_pc without confirmed so it can be read back and confirmed.",
  };
}

/** Only plain http(s) links a person could type; no credentials, no local or script URLs. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname.includes("."))
    return null;
  return url.href;
}

export type SseEvent = { event: string; data: string };

/** Split an SSE buffer into complete events; the incomplete tail is returned. */
export function parseSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.flatMap((block) => {
    let event = "chunk";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data.push(line.slice(6));
      else if (line.startsWith("data:")) data.push(line.slice(5));
    }
    return data.length || event !== "chunk" ? [{ event, data: data.join("\n") }] : [];
  });
  return { events, rest };
}

/** Strip Hermes' benign startup diagnostics and terminal colour codes. */
export function cleanHermesText(text: string) {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .filter((line) => !/^\s*Warning:\s*(Unknown toolset|Unrecognized|Deprecat|No config)/i.test(line))
    .join("\n")
    .trim();
}

const MAX_RESULT = 4000;

export type ExecutionReceipt = {
  id: string; digest: string; tier: RiskTier;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unverified" | "blocked";
  evidence: string | null; usageMicrousd: number | null;
};
export class ReceiptUnavailable extends Error {
  constructor(public status: number) { super(`Execution receipts unavailable (${status})`); }
}
async function receiptRequest(path: string, options: { fetch?: typeof fetch; signal?: AbortSignal }, cancel = false) {
  const request = options.fetch ?? fetch;
  const tokenReply = await request("/__token", { signal: options.signal });
  if (!tokenReply.ok) throw new ReceiptUnavailable(tokenReply.status);
  const token = (await tokenReply.json())?.token;
  if (typeof token !== "string" || !token) throw new ReceiptUnavailable(403);
  const reply = await request(`/__operator/control/jobs${path}`, {
    signal: options.signal, method: cancel ? "POST" : "GET",
    headers: { "X-Claude-OS-Token": token, ...(cancel ? { "Content-Type": "application/json" } : {}) },
    ...(cancel ? { body: "{}" } : {}),
  });
  if (reply.status === 404 && !cancel && path.startsWith("/")) return null;
  if (!reply.ok && !(cancel && reply.status === 409)) throw new ReceiptUnavailable(reply.status);
  try { return await reply.json(); } catch { throw new ReceiptUnavailable(reply.status); }
}
export async function listExecutionReceipts(options: { fetch?: typeof fetch; signal?: AbortSignal; limit?: number } = {}): Promise<ExecutionReceipt[]> {
  const data = await receiptRequest(`?limit=${options.limit ?? 50}`, options);
  if (!Array.isArray(data?.receipts)) throw new ReceiptUnavailable(503);
  return data.receipts;
}
export async function readExecutionReceipt(id: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<ExecutionReceipt | null> {
  return (await receiptRequest(`/${encodeURIComponent(id)}`, options))?.receipt ?? null;
}
export async function cancelExecutionReceipt(id: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<{ cancelRequested: boolean; receipt: ExecutionReceipt }> {
  const data = await receiptRequest(`/${encodeURIComponent(id)}/cancel`, options, true);
  if (!data?.receipt || typeof data.cancelRequested !== "boolean") throw new ReceiptUnavailable(503);
  return data;
}
export type HermesTaskOptions = {
  signal: AbortSignal; session: { id?: string }; fetch?: typeof fetch; approval?: ControlApproval | null;
  requestId?: string; onRequestId?: (id: string) => void; onReceipt?: (receipt: ExecutionReceipt) => void;
};
function receiptReport(receipt: ExecutionReceipt) {
  return `Existing execution ${receipt.id}: ${receipt.status}. This request was not repeated; inspect its receipt before taking further action.`;
}
async function boundReceipt(task: string, options: HermesTaskOptions) {
  if (!options.requestId) return null;
  const receipt = await readExecutionReceipt(options.requestId, options);
  if (receipt) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(task.trim()));
    const digest = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    if (receipt.digest !== digest) throw new Error("Execution request ID is bound to a different task");
    options.onRequestId?.(receipt.id); options.onReceipt?.(receipt);
  }
  return receipt;
}

/**
 * Run one task through Hermes with tools auto-approved (there is no terminal for
 * approval prompts). Reuses one Hermes session per Jarvis conversation.
 */
/** The exact brief control_pc sends Hermes; shared with the acceptance tests. */
export function jarvisTaskPrompt(task: string) {
  return (
    "You are acting as Jarvis's hands on Usman's Windows PC. Do the task below completely, then reply in two or three plain sentences saying exactly what you did and anything that failed or still needs him. No markdown.\n" +
      // Not `cmd /c start`: the launched app inherits the terminal's output pipe, so the
      // terminal tool waits for the app to exit and times out (15 s+). Start-Process doesn't.
      "How to work: open apps, files, folders and links with one terminal command: powershell -NoProfile -Command \"Start-Process '<app, path or https:// link>'\" (it returns at once; never use cmd /c start). Use computer_use only for clicking or typing inside an app, and do not screenshot just to confirm a launch. " +
      // Every task used to open with skill_view (22 KB, ~2.5 s) before doing anything.
      "Use as few steps as possible; don't load a skill unless the task needs its instructions.\n\nTask: " +
      task
  );
}

/**
 * Tell the server the read-back question for this exact task is being asked now (A-M3 binding, 27 Sep
 * night). Call it when gateControlTask returns "ask", BEFORE the question is spoken: the server then
 * grants only a spoken yes said after this moment, for this task, once. Returns false if the server
 * couldn't record it (then no approval can be granted: fail closed).
 */
export async function askControlQuestion(task: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<boolean> {
  const request = options.fetch ?? fetch;
  try {
    const tokenReply = await request("/__token", { signal: options.signal });
    const token = tokenReply.ok ? ((await tokenReply.json())?.token ?? "") : "";
    const reply = await request("/__operator/control/question", {
      method: "POST", signal: options.signal,
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
      body: JSON.stringify({ task: task.trim() }),
    });
    return reply.ok;
  } catch {
    return false;
  }
}

export async function runHermesTask(
  task: string,
  options: HermesTaskOptions,
): Promise<string> {
  options.signal.throwIfAborted();
  const previous = await boundReceipt(task, options);
  if (previous) return receiptReport(previous);
  const allowed = consumeApproval(task, options.approval);
  if (!allowed.ok) return allowed.reply;
  return dispatchHermesTask(task, options);
}

async function dispatchHermesTask(
  task: string,
  options: HermesTaskOptions,
): Promise<string> {
  const request = options.fetch ?? fetch;
  const tokenResponse = await request("/__token", { signal: options.signal });
  const token = tokenResponse.ok ? ((await tokenResponse.json())?.token ?? "") : "";
  const prompt = jarvisTaskPrompt(task);
  const requestId = options.requestId ?? crypto.randomUUID();
  options.onRequestId?.(requestId);
  let approvalNonce: string | undefined;
  if (requiresSpokenYes(task)) {
    if (!options.approval?.expiresAt || Date.now() >= options.approval.expiresAt)
      return "Not run: approval expired before dispatch. Nothing was done.";
    // A-M3: the server grants only against the voice pipeline's own spoken-yes event, never a
    // client-asserted "yes". No event (a typed yes) means no dispatch.
    if (!options.approval.spokenYes) return "Not run: only your spoken yes can approve this (a typed yes can't). Nothing was done.";
    const approved = await request("/__operator/control/approval", {
      method: "POST", signal: options.signal,
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
      body: JSON.stringify({ task, requestId, confirmation: { spokenYes: options.approval.spokenYes } }),
    });
    const data = await approved.json().catch(() => ({}));
    if (!approved.ok || typeof data.nonce !== "string") return "Not run: a fresh server approval is required. Nothing was done.";
    approvalNonce = data.nonce;
  }
  const control = { task, requestId, ...(approvalNonce ? { approvalNonce } : {}) };
  // Warm gateway first (~2 s overhead instead of ~13 s for a fresh `hermes chat` process);
  // 503 means its API server is off, so fall through to the CLI path below. The 503 can carry
  // Jev's toolset plan for the task, which the CLI takes as `-t` (the API server can't).
  let toolsets: string | undefined;
  try {
    const warm = await request("/__operator/hermes/task", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
      body: JSON.stringify({ prompt, control, ...(options.session.id ? { sessionId: options.session.id } : {}) }),
      signal: options.signal,
    });
    if (warm.status !== 503) {
      const data = (await warm.json().catch(() => ({}))) as { text?: string; sessionId?: string; error?: string };
      if (!warm.ok) return `Hermes could not do the task: ${data.error || `status ${warm.status}`}. Nothing is confirmed as done.`;
      if (data.sessionId) options.session.id = data.sessionId;
      const text = cleanHermesText(data.text ?? "");
      if (!text) return "Hermes finished without reporting anything. Treat the outcome as unknown.";
      return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + "\n[truncated]" : text;
    }
    const fallback = (await warm.json().catch(() => ({}))) as { toolsets?: unknown };
    if (Array.isArray(fallback.toolsets) && fallback.toolsets.length && fallback.toolsets.every((t) => typeof t === "string" && /^[a-z_]{2,40}$/.test(t)))
      toolsets = fallback.toolsets.join(",");
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    /* OS route unreachable: use the CLI path */
  }
  const response = await request("/__hermes_chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-claude-os-token": token },
    body: JSON.stringify({
      prompt,
      control,
      // Only reached after mayRunWithYolo above (see its comment for the trade-off).
      yolo: true,
      ...(toolsets ? { toolsets } : {}),
      ...(options.session.id ? { sessionId: options.session.id } : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    let detail = "";
    try {
      const data = await response.json();
      if (data?.receipt) { options.onReceipt?.(data.receipt); return receiptReport(data.receipt); }
      detail = data?.error || "";
    } catch { /* not JSON */ }
    return `Hermes could not start the task${detail ? `: ${detail}` : ` (status ${response.status})`}. Nothing was done.`;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let complete = false;
  let buffer = "",
    output = "",
    failure = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseEvents(buffer);
    buffer = parsed.rest;
    for (const { event, data } of parsed.events) {
      if (event === "chunk" && data) output += data + "\n";
      else if (event === "info") {
        const id = /session_id:\s*([A-Za-z0-9_-]{6,})/.exec(data)?.[1];
        if (id) options.session.id = id;
      } else if (event === "error" && data) failure = data;
      else if (event === "done") complete = data === "ok" || data === "0";
    }
  }
  const text = cleanHermesText(output);
  if (options.onReceipt) {
    try { const receipt = await readExecutionReceipt(requestId, options); if (receipt) options.onReceipt(receipt); }
    catch { /* Completed transport still has an unverified outcome if receipt read fails. */ }
  }
  if (failure) return `Hermes reported an error: ${failure.slice(0, 500)}. Partial output is not proof of completion.`;
  if (!complete) return "Hermes finished without a completion receipt. Treat the outcome as unknown; do not repeat automatically.";
  if (!text) return "Hermes finished without reporting anything. Treat the outcome as unknown.";
  return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + "\n[truncated]" : text;
}

// --- control_pc with a tier, a preview, an honest outcome and an audit entry ------------------------
export type ControlPreview = { kind: "preview"; taskId: string; task: string; plan: ControlPlan; said: string };
export type ControlResult = {
  kind: "result";
  taskId: string;
  task: string;
  tier: RiskTier;
  outcome: ControlOutcome;
  /** Hermes' own report (untrusted narration), or the refusal. */
  report: string;
  verification?: VerificationResult;
  /** What Jarvis should say: never "done" unless an independent check passed. */
  said: string;
  auditFailed?: boolean;
  requestId?: string;
  receipt?: ExecutionReceipt;
};

export type ControlRunOptions = {
  signal: AbortSignal;
  session: { id?: string };
  fetch?: typeof fetch;
  approval: ControlApproval | null;
  /** Return the planned steps and tier without running anything. */
  dryRun?: boolean;
  /** An independent check of the effect; without one, a run that finishes is `unverified`. */
  verifier?: ControlVerifier;
  verifyTimeoutMs?: number;
  audit?: AuditSink;
  taskId?: string;
  requestId?: string;
  onRequestId?: (id: string) => void;
  onReceipt?: (receipt: ExecutionReceipt) => void;
  jevConfidence?: number;
  now?: () => Date;
  /** The executor (tests pass a fake); defaults to runHermesTask. */
  execute?: (task: string, options: HermesTaskOptions) => Promise<string>;
};

/** What to say for a result: the outcome first, so narration alone never sounds like "done". */
export function formatControlResult(r: Pick<ControlResult, "outcome" | "report" | "verification">): string {
  const report = r.report.trim();
  switch (r.outcome) {
    case "success":
      return `Verified done (${r.verification?.verifier ?? "check"}: ${r.verification?.detail ?? "passed"}). ${report}`.trim();
    case "failed":
      return r.verification?.status === "failed" ? `Failed: the independent check says it didn't work (${r.verification.detail}). Hermes said: ${report}` : report;
    case "cancelled":
      return `Cancelled. ${report}`.trim();
    default:
      return `Unverified: no independent check confirmed this, so treat it as not yet confirmed. Hermes' own report: ${report}`;
  }
}

async function record(options: ControlRunOptions, entry: Omit<AuditEntry, "ts">): Promise<boolean> {
  if (!options.audit) return true;
  const clean = sanitizeAuditEntry({ ...entry, ts: (options.now?.() ?? new Date()).toISOString() });
  if (!clean) return false;
  try {
    await options.audit(clean);
    return true;
  } catch {
    return false;
  }
}

/**
 * control_pc end to end: dry run → gate check → Hermes → independent verification → one audit entry.
 * The approval must come from gateControlTask; this re-checks it in code before Hermes sees anything.
 */
export async function runControlTask(task: string, options: ControlRunOptions): Promise<ControlPreview | ControlResult> {
  const text = task.trim();
  const taskId = options.taskId ?? newTaskId();
  const target = targetOf(text);
  if (options.dryRun) {
    const plan = planControlTask(text);
    await record(options, { taskId, action: "preview", target, tier: plan.tier, approval: "not-needed", outcome: "preview", jevConfidence: options.jevConfidence });
    return { kind: "preview", taskId, task: text, plan, said: describePlan(plan) };
  }
  const previous = !options.signal.aborted && !options.execute ? await boundReceipt(text, options) : null;
  const allowed = options.signal.aborted ? { ok: false as const, tier: classifyControlTask(text).tier, reply: "Not run: cancelled before dispatch." } : previous ? { ok: true as const, tier: previous.tier } : consumeApproval(text, options.approval);
  const approval = options.approval?.method === "spoken-yes" ? "spoken-yes" : "none";
  if (!allowed.ok) {
    const ok = await record(options, { taskId, action: "control_pc", target, tier: allowed.tier, approval, outcome: "refused", jevConfidence: options.jevConfidence });
    return { kind: "result", taskId, task: text, tier: allowed.tier, outcome: "failed", report: allowed.reply, said: allowed.reply, ...(ok ? {} : { auditFailed: true }) };
  }
  const started = Date.now();
  let requestId = options.requestId, receipt: ExecutionReceipt | undefined = previous ?? undefined;
  const execute = options.execute ?? dispatchHermesTask;
  let executed: "ok" | "failed" | "cancelled";
  let report: string;
  try {
    report = previous ? receiptReport(previous) : await execute(text, { signal: options.signal, session: options.session, fetch: options.fetch, approval: options.approval,
      requestId, onRequestId: (id) => { requestId = id; options.onRequestId?.(id); },
      onReceipt: (value) => { receipt = value; options.onReceipt?.(value); } });
    executed = options.signal.aborted ? "cancelled" : hermesReportFailed(report) ? "failed" : "ok";
  } catch (error) {
    if ((error as Error).name === "AbortError" || options.signal.aborted) {
      executed = "cancelled";
      report = "The task was cancelled before Hermes reported back. It may have partly run.";
    } else {
      executed = "failed";
      report = `Hermes could not be reached: ${(error as Error).message}. Nothing is confirmed as done.`;
    }
  }
  const verification = executed === "ok" && !receipt && options.verifier ? await runVerifier(options.verifier, { timeoutMs: options.verifyTimeoutMs, signal: options.signal }) : undefined;
  if (options.signal.aborted) executed = "cancelled";
  const outcome = outcomeFrom({ executed, verification });
  const ok = await record(options, {
    taskId,
    action: "control_pc",
    target,
    tier: allowed.tier,
    approval,
    outcome,
    jevConfidence: options.jevConfidence,
    verifier: verification?.verifier,
    verification: verification?.status,
    ms: Date.now() - started,
  });
  const result: ControlResult = { kind: "result", taskId, task: text, tier: allowed.tier, outcome, report, verification, requestId, receipt, said: "", ...(ok ? {} : { auditFailed: true }) };
  result.said = formatControlResult(result);
  return result;
}

/** Browser audit sink: posts sanitised entries to the OS route that appends them to the JSONL log. */
export function httpAuditSink(request: typeof fetch = fetch): AuditSink {
  let token: string | null = null;
  return async (entry) => {
    if (token === null) {
      const r = await request("/__token");
      token = r.ok ? ((await r.json())?.token ?? "") : "";
    }
    const response = await request("/__operator/control/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token ?? "" },
      body: JSON.stringify(entry),
    });
    if (!response.ok) throw new Error(`audit ${response.status}`);
  };
}
