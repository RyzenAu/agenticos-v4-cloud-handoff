// TEST-ONLY bun preload (synthetic instance): stands in for the one-function connector patch in
// docs/HINDSIGHT-OPS.md section 6 by adding the proxy's X-MU-Approval header to DELETE requests the
// connector sends to the SYNTHETIC proxy (127.0.0.1:8879). It signs exactly the request being sent,
// with the synthetic approval secret, exactly as the connector's approval path would.
// Never used against the pilot proxy.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const SECRET_FILE = "D:\\hindsight\\service\\secrets\\synth-docdelete.key";
const origFetch = globalThis.fetch;

function approvalToken(method: string, path: string, ttlS = 300): string {
  const id = `ap-shim-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const expiry = Math.floor(Date.now() / 1000) + ttlS;
  const secret = readFileSync(SECRET_FILE).toString().trim();
  const mac = createHmac("sha256", secret).update(`${id}|${expiry}|${method.toUpperCase()}|${path}`).digest("hex");
  return `${id}.${expiry}.${mac}`;
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = String(init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  if (method === "DELETE" && url.hostname === "127.0.0.1" && url.port === "8879") {
    const headers = new Headers(init?.headers ?? {});
    headers.set("X-MU-Approval", approvalToken(method, decodeURIComponent(url.pathname)));
    return origFetch(input, { ...init, headers });
  }
  return origFetch(input, init);
}) as typeof fetch;
