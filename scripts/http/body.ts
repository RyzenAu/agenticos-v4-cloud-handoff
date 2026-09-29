import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The one request-body reader for the dev server's /__* routes (Audit F5, P2-1 and P3).
 *
 * Before this, each handler did its own `body += chunk`: some with no limit at all (a 12 MB body
 * was buffered and parsed), some with `req.destroy()` at the limit (the caller saw a socket reset,
 * not an answer), and most let `JSON.parse` throw into a catch that answered 500. Here:
 *   - over the limit: 413 with a JSON error, and the rest of the body is drained, never buffered;
 *   - malformed JSON, or JSON that is not an object: 400 with a JSON error;
 *   - an empty body reads as "" (the JSON readers treat it as {}).
 * Every reader answers the error itself and resolves null, so a handler only has to return.
 */

export const KB = 1024;
export const MB = 1024 * 1024;

/** Past the limit, keep draining at most this much more before hanging up on the sender. */
const DRAIN_CEILING = 64 * MB;

type Req = IncomingMessage;
type Res = ServerResponse;

function formatLimit(limit: number): string {
  if (limit >= MB && limit % MB === 0) return `${limit / MB} MB`;
  if (limit >= KB && limit % KB === 0) return `${limit / KB} KB`;
  return `${limit} bytes`;
}

/** A JSON error answer, unless something was already sent. */
export function sendJsonError(res: Res, status: number, error: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ok: false, error }));
}

export function sendTooLarge(res: Res, limit: number): void {
  sendJsonError(res, 413, `The request body is too large (limit ${formatLimit(limit)}).`);
}

/**
 * Reads the whole body, up to `limit` bytes. Resolves the bytes, or null once it has answered
 * 413 (or the sender went away). A declared Content-Length over the limit is refused without
 * buffering anything; the body is still drained so the sender reads the answer, not a reset.
 */
export function readLimitedBody(req: Req, res: Res, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) over = true;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (over) {
        if (size > limit + DRAIN_CEILING) {
          sendTooLarge(res, limit);
          req.destroy();
          finish(null);
        }
        return;
      }
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (over) {
        sendTooLarge(res, limit);
        return finish(null);
      }
      finish(Buffer.concat(chunks));
    });
    req.on("aborted", () => finish(null));
    req.on("error", () => finish(null));
  });
}

/** The body as UTF-8 text, or null once 413 has been answered. */
export async function readLimitedText(req: Req, res: Res, limit: number): Promise<string | null> {
  const buf = await readLimitedBody(req, res, limit);
  return buf === null ? null : buf.toString("utf8");
}

/** True when `text` is empty or a JSON object (not an array, string, number or null). */
export function isJsonObjectText(text: string): boolean {
  if (!text.trim()) return true;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * The body parsed as a JSON object ({} when empty). Answers 400 for malformed JSON or a
 * non-object, 413 over the limit, and resolves null in both cases.
 */
export async function readJsonObject(req: Req, res: Res, limit: number): Promise<Record<string, any> | null> {
  const text = await readLimitedText(req, res, limit);
  if (text === null) return null;
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    sendJsonError(res, 400, "The request body is not valid JSON.");
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    sendJsonError(res, 400, "The request body must be a JSON object.");
    return null;
  }
  return value as Record<string, any>;
}

/**
 * Callback form for the handlers written as `req.on("data") … req.on("end", () => …)`: calls
 * `onBody` with the raw text once it is all in and under the limit. A drop-in for those two
 * listeners, so the handler body below them stays as it was.
 */
export function withBody(req: Req, res: Res, limit: number, onBody: (body: string) => unknown): void {
  void readLimitedText(req, res, limit).then((body) => {
    if (body !== null) return onBody(body);
  });
}

/**
 * As withBody, but the text is also checked to be empty or a JSON object first (400 otherwise),
 * so the handler's own `JSON.parse(body || "{}")` cannot throw into a 500.
 */
export function withJsonBody(req: Req, res: Res, limit: number, onBody: (body: string) => unknown): void {
  void readLimitedText(req, res, limit).then((body) => {
    if (body === null) return;
    if (!isJsonObjectText(body)) {
      let parses = true;
      try {
        JSON.parse(body);
      } catch {
        parses = false;
      }
      return sendJsonError(res, 400, parses ? "The request body must be a JSON object." : "The request body is not valid JSON.");
    }
    return onBody(body);
  });
}
