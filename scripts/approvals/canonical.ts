// Canonical action arguments and their digest (TARGET-ARCHITECTURE §3.2 `argsDigest`).
// Keys sorted at every depth, no undefined, no functions, finite numbers only: the same action always
// hashes the same, and any change to it (a new sha, a different amount, another button) changes the digest.
import { createHash } from "node:crypto";

export type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

function canon(value: unknown, depth: number): Canonical {
  if (depth > 12) throw new Error("Action arguments are nested too deeply");
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error("Action arguments need finite numbers");
      return value;
    case "object": {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("Action arguments must be plain JSON");
        return value.map((v) => canon(v, depth + 1));
      }
      // Plain objects only: a Date, Map, Set or class instance would otherwise hash as "{}".
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error("Action arguments must be plain JSON");
      // Built without a prototype and with defineProperty, so a parsed "__proto__" key is kept, not swallowed.
      const out = Object.create(null) as { [key: string]: Canonical };
      for (const key of Object.keys(value as object).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue;
        Object.defineProperty(out, key, { value: canon(v, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    default:
      throw new Error("Action arguments must be plain JSON");
  }
}

/** Deterministic JSON text for plain data. Throws on anything that isn't plain JSON. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canon(value, 0));
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** sha256 over the canonical {action, args}: the thing an approval is bound to. */
export function argsDigest(action: string, args: unknown): string {
  return sha256(canonicalJson({ action, args }));
}
