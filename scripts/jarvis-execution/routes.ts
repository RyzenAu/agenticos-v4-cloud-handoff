import type { ControlExecutionRuntime } from "./runtime";
import { controlDispatchGate, type ControlDispatchGate } from "./server-approval";

/** Call only after the host has checked loopback/host/origin. GET additionally needs
 * the page token here; ordinary operator GET endpoints do not require that token.
 * Runtime is lazy so unauthorised calls cannot create or inspect journal storage.
 */
export function controlReceiptRoute(input: {
  path: string; method: string; url: URL; remote: boolean; authenticated: boolean; body?: unknown;
  /** The approval gate (tests pass their own); default: the process gate /control/approval uses. */
  gate?: ControlDispatchGate;
}, runtime: () => ControlExecutionRuntime): { status: number; body: unknown } | null {
  const quarantinePath = input.path === "/control/quarantine" || input.path === "/control/quarantine/recover";
  const questionPath = input.path === "/control/question";
  if (!quarantinePath && !questionPath && input.path !== "/control/jobs" && !input.path.startsWith("/control/jobs/")) return null;
  if (input.remote || !input.authenticated) return { status: 403, body: { error: "Local owner authentication required." } };
  try {
    // A-M3 binding for control grants: the read-back question for one exact task is recorded here
    // when Jarvis asks it; /control/approval then accepts only a spoken yes said after it, once.
    if (questionPath) {
      if (input.method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
      try { return { status: 200, body: (input.gate ?? controlDispatchGate).ask(input.body) }; }
      catch { return { status: 400, body: { error: "A control question needs the exact task text." } }; }
    }
    // Admission quarantine after an unacknowledged child termination. Recovery is an explicit
    // request: 202 starts independent process accounting; poll GET for `lastRecovery`.
    if (input.path === "/control/quarantine") {
      if (input.method !== "GET") return { status: 405, body: { error: "Method not allowed." } };
      return { status: 200, body: { quarantine: runtime().quarantineState() } };
    }
    if (input.path === "/control/quarantine/recover") {
      if (input.method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
      if (!input.body || typeof input.body !== "object" || Array.isArray(input.body) || Object.keys(input.body).length)
        return { status: 400, body: { error: "Recovery takes an empty JSON object; evidence is server-derived." } };
      const worker = runtime();
      if (!worker.quarantineState().quarantined) return { status: 409, body: { code: "not_quarantined", quarantine: worker.quarantineState() } };
      void worker.recoverQuarantine().catch(() => {});
      return { status: 202, body: { code: "recovery_requested", quarantine: worker.quarantineState() } };
    }
    if (input.path === "/control/jobs" && input.method === "GET") {
      const limit = Number(input.url.searchParams.get("limit") ?? 50);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { status: 400, body: { error: "limit must be a whole number from 1 to 100." } };
      return { status: 200, body: { receipts: runtime().list(limit) } };
    }
    const match = /^\/control\/jobs\/([a-f0-9-]{36})(\/cancel)?$/i.exec(input.path);
    if (!match) return { status: 404, body: { error: "Unknown receipt route." } };
    const receipt = runtime().read(match[1]);
    if (!receipt) return { status: 404, body: { error: "Receipt not found." } };
    if (!match[2] && input.method === "GET") return { status: 200, body: { receipt } };
    if (match[2] && input.method === "POST") {
      if (!input.body || typeof input.body !== "object" || Array.isArray(input.body) || Object.keys(input.body).length)
        return { status: 400, body: { error: "Cancellation takes an empty JSON object; authority is server-derived." } };
      const result = runtime().cancel(match[1]);
      return { status: result.cancelRequested ? 202 : 409, body: result };
    }
    return { status: 405, body: { error: "Method not allowed." } };
  // Input is checked above; what throws here is the worker or its journal (Audit F5 P3: 503, not 400).
  } catch { return { status: 503, body: { error: "The control worker is unavailable." } }; }
}
