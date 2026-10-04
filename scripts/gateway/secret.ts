/**
 * The gateway -> hub assertion key: 32 random bytes in MU_DATA_DIR/gateway/hub-assertion.key, protected exactly like the
 * local-owner token (scripts/identity/local-owner-token.ts: the hub's account, SYSTEM and Administrators only; POSIX 0600).
 * The gateway signs with it, the hub verifies with it. The value is never logged, printed, put in a response or in the audit.
 *
 * A file whose protection or owner is wrong is not a key: the reader returns null (every assertion then fails closed) and
 * `ensure` replaces it with a fresh value, which revokes anything signed with the old one.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tokenFileProtected, writeProtectedSecret } from "../identity/local-owner-token";
import { FILES } from "./config";

const VALID = /^[A-Za-z0-9_-]{43,128}$/;

export function gatewaySecretPath(dir: string): string {
  return join(dir, FILES.secret);
}

/** Create the key when it is missing or unusable. Returns the PATH, never the value. */
export function ensureGatewaySecret(dir: string): string {
  const file = gatewaySecretPath(dir);
  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8").trim();
  } catch {
    /* missing: create it below */
  }
  if (existing !== null && VALID.test(existing) && tokenFileProtected(file)) return file;
  if (existing) console.warn("gateway assertion key rotated: its permissions were wrong or the file was unusable");
  mkdirSync(dir, { recursive: true });
  writeProtectedSecret(file, randomBytes(32).toString("base64url"));
  if (!tokenFileProtected(file)) throw new Error("gateway assertion key: the key file is not protected as required after creation.");
  return file;
}

/**
 * A reader that re-reads the file when it changes (so a rotation takes effect without a restart) and re-verifies its
 * protection each time it does. Returns null when there is no usable key.
 */
export function gatewaySecretReader(dir: string): () => string | null {
  const file = gatewaySecretPath(dir);
  let stamp = "";
  let value: string | null = null;
  return () => {
    try {
      const s = statSync(file);
      const key = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
      if (key !== stamp) {
        const text = readFileSync(file, "utf8").trim();
        value = VALID.test(text) && tokenFileProtected(file) ? text : null;
        if (!value) console.warn("gateway assertion key ignored: the key file is unusable or its permissions are wrong");
        stamp = key;
      }
    } catch {
      value = null;
      stamp = "";
    }
    return value;
  };
}
