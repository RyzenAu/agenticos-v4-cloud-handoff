/**
 * HTTP for the ONE Jarvis command entry (Track 2), mounted under /__operator BEFORE the screen-only
 * routes, so a verified remote founder reaches it too (their command runs on THEIR device, never the hub):
 *
 *   POST /screen/command          CommandBody → NDJSON CommandStreamEvent lines, the last one "done"
 *   GET  /screen/command/attach   ?job=<id>&since=<seq> → NDJSON: the job's events after `since`, then live
 *   POST /screen/command/cancel   { jobId } → { ok, state }
 *
 * Identity is the caller's verified principal (B1), resolved by the host; any `personId` in the body is
 * ignored. The body is validated and bounded here; the page context is parsed by the service.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../identity/principal";
import type { CommandBody, CommandStreamEvent } from "./contracts";
import type { CommandService } from "./service";

/** Validate POST /screen/command. `personId` is never read (identity is the verified principal). */
export function parseCommandBody(body: unknown): CommandBody {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const utterance = typeof b.utterance === "string" ? b.utterance.trim().slice(0, 600) : "";
  if (!utterance) throw new Error("Say what Jarvis should do.");
  const source = b.source === "voice" || b.source === "typed" || b.source === "acceptance" ? b.source : "typed";
  const spokenTarget = typeof b.spokenTarget === "string" && b.spokenTarget.trim() ? b.spokenTarget.trim().slice(0, 60) : undefined;
  const spokenYes = typeof b.spokenYes === "string" && /^[a-f0-9-]{36}$/i.test(b.spokenYes) ? b.spokenYes : undefined;
  let pageContext: CommandBody["pageContext"];
  if (b.pageContext && typeof b.pageContext === "object" && JSON.stringify(b.pageContext).length <= 24_000) pageContext = b.pageContext as CommandBody["pageContext"];
  return { utterance, source, ...(spokenTarget ? { spokenTarget } : {}), ...(spokenYes ? { spokenYes } : {}), ...(pageContext ? { pageContext } : {}) };
}

function ndjson(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  return (event: unknown) => void (res.writableEnded || res.destroyed || res.write(`${JSON.stringify(event)}\n`));
}

export async function commandRoute(input: {
  path: string;
  method: string;
  url: URL;
  body: unknown;
  principal: Principal;
  req: IncomingMessage;
  res: ServerResponse;
  service: CommandService;
  send: (value: unknown, status?: number) => void;
  memoryCaller?: unknown;
}): Promise<boolean> {
  const { path, method, url, body, principal, res, service, send } = input;
  if (path === "/screen/command" && method === "POST") {
    let request: CommandBody;
    try {
      request = parseCommandBody(body);
    } catch (error) {
      send({ type: "done", ok: false, said: (error as Error).message, kind: "ask", jobId: null, runId: "", targetDeviceId: null }, 400);
      return true;
    }
    const write = ndjson(res);
    let jobId: string | null = null;
    let finished = false;
    let sentDone = false;
    const listener = (e: CommandStreamEvent) => {
      if (e.type === "job") jobId = e.jobId;
      if (e.type === "done") sentDone = true;
      write(e);
    };
    // A dropped stream isn't a stop: the job keeps running for the reconnect grace period (see service).
    res.once("close", () => void (!finished && jobId && service.dropped(jobId, listener)));
    try {
      const done = await service.run({ principal, body: request, memoryCaller: input.memoryCaller }, listener);
      // Answers that need no job (a stop, an empty request) come back without a stream: send the done.
      if (!sentDone) write(done);
    } catch (error) {
      write({ type: "done", ok: false, said: `Jarvis couldn't do that: ${(error as Error).message}`.slice(0, 200), kind: "unavailable", jobId, runId: "", targetDeviceId: null });
    }
    finished = true;
    if (!res.writableEnded) res.end();
    return true;
  }
  if (path === "/screen/command/attach" && method === "GET") {
    const job = (url.searchParams.get("job") || "").slice(0, 64);
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    let detach: () => void = () => undefined;
    const write = ndjson(res);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      detach();
      if (!res.writableEnded) res.end();
    };
    const listener = (e: CommandStreamEvent) => {
      write(e);
      if (e.type === "done") queueMicrotask(end);
    };
    const attached = service.attach(job, principal, since, listener);
    if (!attached.ok) {
      write({ type: "done", ok: false, said: attached.reason, kind: "unavailable", jobId: job || null, runId: "", targetDeviceId: null });
      end();
      return true;
    }
    detach = attached.detach;
    res.once("close", () => {
      if (!ended) service.dropped(job, listener);
      ended = true;
    });
    return true;
  }
  if (path === "/screen/command/cancel" && method === "POST") {
    const jobId = typeof (body as { jobId?: unknown } | null)?.jobId === "string" ? String((body as { jobId: string }).jobId).slice(0, 64) : "";
    if (!jobId) return send({ ok: false, error: "Which job?" }, 400), true;
    const r = await service.cancel(jobId, principal);
    send(r, r.ok ? 200 : 409);
    return true;
  }
  return false;
}
