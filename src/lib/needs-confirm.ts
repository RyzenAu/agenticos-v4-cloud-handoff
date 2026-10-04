// A read or write the hub refuses with 403 "needs-human-session": the browser is signed in to the tailnet but has not been confirmed with a
// code, so the server will not show or change owner data. Pages say that once, calmly, instead of a generic failure, a retry loop or a
// wrong state ("Install Hermes"). The server rule is unchanged: this only recognises the answer.
export const NEEDS_CONFIRM_LINE = "This browser isn't confirmed yet. Confirm it in System › Devices and people to see this.";
export const NEEDS_CONFIRM_WRITE_LINE = "Confirm this browser first (System › Devices and people): it can't change this until you do.";

/** The gate's refusal text (scripts/identity/gate.ts SERVER_NEEDS_SESSION) and its machine reason. */
const GATE_TEXT = /needs a confirmed browser session/i;

/** True for an error carrying status 403 plus the gate's reason or text (OperatorRequestError, CrmRequestError, NeedsConfirmError). */
export function isNeedsConfirm(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; reason?: unknown; code?: unknown; message?: unknown };
  if (e.status !== 403) return false;
  return e.reason === "needs-human-session" || e.code === "needs-human-session" || (typeof e.message === "string" && GATE_TEXT.test(e.message));
}

export class NeedsConfirmError extends Error {
  readonly status = 403;
  readonly reason = "needs-human-session";
  constructor() {
    super(NEEDS_CONFIRM_LINE);
    this.name = "NeedsConfirmError";
  }
}

/** For a plain fetch: throws NeedsConfirmError for the gate's 403, otherwise returns the response untouched. */
export async function throwIfNeedsConfirm(res: Response): Promise<Response> {
  if (res.status !== 403) return res;
  const body = (await res.clone().json().catch(() => null)) as { reason?: unknown; error?: unknown } | null;
  if (body?.reason === "needs-human-session" || (typeof body?.error === "string" && GATE_TEXT.test(body.error))) throw new NeedsConfirmError();
  return res;
}

/** react-query `retry` and `refetchInterval` helpers: a needs-confirm answer never repeats on its own. */
export const retryUnlessNeedsConfirm = (failures: number, error: unknown, max = 1) => !isNeedsConfirm(error) && failures < max;
