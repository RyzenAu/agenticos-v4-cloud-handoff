/**
 * Honest outcomes for Jarvis's actions, independent checks, and the shape of the audit log.
 *
 * Outcomes: success (an independent check passed), failed, cancelled, and unverified (it ran, but
 * no independent check ran or the check couldn't decide). Hermes' own narration ("I saved the
 * file") is never enough for success.
 *
 * Audit entries hold metadata only: ids, tiers, approval method, outcome, a target (an allow-listed app
 * name, else a SHA-256 prefix of its basename: audit A-L4) and the
 * SHA-256 of any text typed. sanitizeAuditEntry keeps exactly those fields in a restricted form, so a
 * transcript, a screenshot or the typed text itself can't reach the log by accident. Pure; the
 * file writer is scripts/control-audit.ts.
 */
import type { RiskTier } from "./control-risk";

export type ControlOutcome = "success" | "failed" | "cancelled" | "unverified";
export const CONTROL_OUTCOMES: readonly ControlOutcome[] = ["success", "failed", "cancelled", "unverified"];

export type VerificationStatus = "passed" | "failed" | "inconclusive";
export type VerificationResult = { verifier: string; status: VerificationStatus; detail: string; ms: number };

/** An independent check of an action's effect (a file on disk, a UIA value, a window title…). */
export interface ControlVerifier {
  name: string;
  /** Must never return or log private content: `detail` is metadata only (sizes, hash match). */
  verify(signal: AbortSignal): Promise<{ status: VerificationStatus; detail: string }>;
}

export const VERIFY_TIMEOUT_MS = 5000;

/** Run a verifier with a time limit. A timeout, a throw or an abort is "inconclusive", never passed. */
export async function runVerifier(verifier: ControlVerifier, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<VerificationResult> {
  const started = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: VerificationStatus; detail: string }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "inconclusive", detail: "verification timed out" });
    }, options.timeoutMs ?? VERIFY_TIMEOUT_MS);
  });
  try {
    const got = await Promise.race([
      verifier.verify(controller.signal).catch((error: Error) => ({ status: "inconclusive" as const, detail: `verifier error: ${error.name}` })),
      timeout,
    ]);
    const status: VerificationStatus = got.status === "passed" || got.status === "failed" ? got.status : "inconclusive";
    return { verifier: verifier.name, status, detail: String(got.detail ?? "").slice(0, 200), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The one mapping from "what ran" + "what the check said" to an outcome. Without a passed check an
 * action that ran is unverified, never success.
 */
export function outcomeFrom(input: { executed: "ok" | "failed" | "cancelled"; verification?: VerificationResult | null }): ControlOutcome {
  if (input.executed === "cancelled") return "cancelled";
  if (input.executed === "failed") return "failed";
  const v = input.verification;
  if (!v) return "unverified";
  if (v.status === "passed") return "success";
  if (v.status === "failed") return "failed";
  return "unverified";
}

/** Hermes' own words that mean it didn't run or failed (see runHermesTask's replies). */
export function hermesReportFailed(text: string) {
  return /^(?:Hermes (?:could not|reported an error)|Not run:|No task was given)/.test(text.trim());
}

// --- hashing --------------------------------------------------------------------------------------
/** SHA-256 hex of UTF-8 text (WebCrypto: the browser and Bun alike). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- audit ----------------------------------------------------------------------------------------
export type ApprovalMethod = "none" | "spoken-yes" | "flag" | "not-needed";
/**
 * The standard audit shape across control paths (jarvis-deep-research.md §3, P1 item 6): which
 * executor acted, which judgment (if any) decided, its confidence and verdict, the latency and the
 * outcome. Never the state a judgment saw (screen text, page text, a transcript).
 */
export type ControlExecutor = "rules" | "uia" | "win32" | "playwright" | "cdp" | "jev" | "model" | "vision" | "hermes";
export const CONTROL_EXECUTORS: readonly ControlExecutor[] = ["rules", "uia", "win32", "playwright", "cdp", "jev", "model", "vision", "hermes"];
export type AuditVerdict = "allow" | "confirm" | "refuse" | "passed" | "failed" | "inconclusive";
/** "decided": one Jev decision in the Jev-first control loop (what it chose, how sure, how long). */
export type AuditOutcome = ControlOutcome | "preview" | "refused" | "awaiting-approval" | "step-ok" | "step-failed" | "decided";
export type AuditEntry = {
  ts: string;
  taskId: string;
  /** What kind of action: control_pc, preview, open_app, type, keys, save, verify… */
  action: string;
  /** App name or the basename of a path, never a full path or free text. */
  target?: string;
  tier: RiskTier | "n/a";
  approval: ApprovalMethod;
  jevConfidence?: number;
  outcome: AuditOutcome;
  /** SHA-256 of any text typed: never the text. */
  typedSha256?: string;
  verifier?: string;
  verification?: VerificationStatus;
  ms?: number;
  step?: number;
  /** Which executor acted (the standard shape). */
  executor?: ControlExecutor;
  /** The named judgment that decided, e.g. "vet", "jev-succeeded", "file-dialog" (an identifier, never text). */
  judgment?: string;
  verdict?: AuditVerdict;
  /** A Jev call's size (TypeSafe's usage.input_tokens / output_tokens): cost logging, counts only. */
  inputTokens?: number;
  outputTokens?: number;
};
export type AuditSink = (entry: AuditEntry) => void | Promise<void>;

const AUDIT_KEYS = new Set(["ts", "taskId", "action", "target", "tier", "approval", "jevConfidence", "outcome", "typedSha256", "verifier", "verification", "ms", "step", "executor", "judgment", "verdict", "inputTokens", "outputTokens"]);
const EXECUTORS = new Set<string>(CONTROL_EXECUTORS);
const VERDICTS = new Set(["allow", "confirm", "refuse", "passed", "failed", "inconclusive"]);
const TIERS = new Set(["read-only", "local-reversible", "external-effect", "n/a"]);
const APPROVALS = new Set(["none", "spoken-yes", "flag", "not-needed"]);
const OUTCOMES = new Set([...CONTROL_OUTCOMES, "preview", "refused", "awaiting-approval", "step-ok", "step-failed", "decided"]);
const STATUSES = new Set(["passed", "failed", "inconclusive"]);

/** The last path segment, in a restricted alphabet. */
export function basenameOf(value: string) {
  const last = value.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return last.replace(/[^\p{L}\p{N} ._()+-]/gu, "").trim().slice(0, 60);
}

/**
 * App names the audit log may keep in plain text (audit A-L4, 27 Sep 2026). Anything else a target
 * could be (a file name like "Patient-Jane-Smith.pdf", a place, a person) is hashed.
 */
export const AUDIT_APP_NAMES: ReadonlySet<string> = new Set([
  "notepad", "notepad++", "calculator", "calc", "paint", "mspaint", "explorer", "file explorer", "chrome", "google chrome",
  "msedge", "edge", "firefox", "brave", "powerpoint", "powerpnt", "excel", "word", "winword", "outlook", "teams", "slack",
  "discord", "spotify", "youtube", "obsidian", "code", "vs code", "vscode", "terminal", "windowsterminal", "settings",
  "snipping tool", "snippingtool", "photos", "whatsapp", "telegram", "zoom", "vlc", "playwright", "jarvis chrome",
  "task manager", "taskmgr", "clock", "calendar", "mail", "onenote", "wordpad", "cmd", "powershell", "agenticos",
]);
const HASHED_TARGET = /^sha256-[a-f0-9]{16}$/;
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 (hex) of a UTF-8 string: synchronous and dependency-free, so it runs in the browser too. Pure. */
export function sha256Sync(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/**
 * What the audit log keeps of a target (A-L4): an allow-listed app name as written, anything else as
 * "sha256-" + 16 hex of its lower-cased basename (correlatable across entries, not readable). Idempotent. Pure.
 */
export function auditTarget(value: string): string | undefined {
  const trimmed = value.trim();
  if (HASHED_TARGET.test(trimmed)) return trimmed;
  const base = basenameOf(trimmed);
  if (!base) return undefined;
  if (AUDIT_APP_NAMES.has(base.toLowerCase().replace(/\.exe$/, ""))) return base.replace(/\.exe$/i, "");
  return `sha256-${sha256Sync(base.toLowerCase()).slice(0, 16)}`;
}

/** The app or file a task is aimed at, for the log: an allow-listed app word, else a hash (A-L4). Pure. */
export function targetOf(task: string): string | undefined {
  const path = /(?:[A-Za-z]:\\|\\\\|~[\\/])[^\s"'<>|]*[^\s"'<>|.,;]/.exec(task)?.[0];
  if (path) return auditTarget(path);
  const app = /\b(?:open|launch|start|in|into|switch to|close)\s+(?:the\s+|my\s+)?([A-Za-z][\w.+-]{1,30})/i.exec(task)?.[1];
  return app ? auditTarget(app) : undefined;
}

/**
 * Keep only the allowed fields, each in its allowed form. Returns null when a required field is
 * missing or malformed. Unknown fields (task text, transcripts, screenshots, typed text) are dropped.
 */
export function sanitizeAuditEntry(raw: unknown): AuditEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  const ts = str("ts") ?? "";
  const taskId = str("taskId") ?? "";
  const action = str("action") ?? "";
  const tier = str("tier") ?? "";
  const approval = str("approval") ?? "";
  const outcome = str("outcome") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ts)) return null;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(taskId)) return null;
  if (!/^[a-z][a-z0-9_.:-]{0,39}$/.test(action)) return null;
  if (!TIERS.has(tier) || !APPROVALS.has(approval) || !OUTCOMES.has(outcome)) return null;
  const entry: AuditEntry = { ts, taskId, action, tier: tier as AuditEntry["tier"], approval: approval as ApprovalMethod, outcome: outcome as AuditOutcome };
  const target = str("target");
  if (target) {
    const kept = auditTarget(target);
    if (kept) entry.target = kept;
  }
  if (typeof r.jevConfidence === "number" && r.jevConfidence >= 0 && r.jevConfidence <= 1) entry.jevConfidence = Math.round(r.jevConfidence * 1000) / 1000;
  const hash = str("typedSha256");
  if (hash && /^[a-f0-9]{64}$/.test(hash)) entry.typedSha256 = hash;
  const verifier = str("verifier");
  if (verifier && /^[a-z][a-z0-9_.:-]{0,39}$/.test(verifier)) entry.verifier = verifier;
  const verification = str("verification");
  if (verification && STATUSES.has(verification)) entry.verification = verification as VerificationStatus;
  if (typeof r.ms === "number" && Number.isFinite(r.ms) && r.ms >= 0) entry.ms = Math.round(r.ms);
  if (typeof r.step === "number" && Number.isInteger(r.step) && r.step >= 0 && r.step < 1000) entry.step = r.step;
  const executor = str("executor");
  if (executor && EXECUTORS.has(executor)) entry.executor = executor as ControlExecutor;
  const judgment = str("judgment");
  if (judgment && /^[a-z][a-z0-9_.:-]{0,39}$/.test(judgment)) entry.judgment = judgment;
  const verdict = str("verdict");
  if (verdict && VERDICTS.has(verdict)) entry.verdict = verdict as AuditVerdict;
  for (const k of ["inputTokens", "outputTokens"] as const)
    if (typeof r[k] === "number" && Number.isInteger(r[k]) && (r[k] as number) >= 0 && (r[k] as number) < 1_000_000) entry[k] = r[k] as number;
  for (const k of Object.keys(entry)) if (!AUDIT_KEYS.has(k)) delete (entry as Record<string, unknown>)[k];
  return entry;
}

/** A short random id for one task (correlates its preview, approval and outcome entries). */
export function newTaskId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return "t_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
