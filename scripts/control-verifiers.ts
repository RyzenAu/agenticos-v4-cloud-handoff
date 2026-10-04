/**
 * Independent checks for control_pc and screen actions (the ControlVerifier interface in
 * src/lib/control-outcome.ts). They look at the real effect, not at what an agent said it did, and
 * report metadata only: never file contents.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { ControlVerifier } from "../src/lib/control-outcome";

export const MAX_VERIFY_BYTES = 5 * 1024 * 1024;

/** The same normalisation both sides of the comparison get: no UTF-8 BOM, LF line endings. */
export function normaliseText(text: string) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}
export const sha256OfText = (text: string) => createHash("sha256").update(normaliseText(text), "utf8").digest("hex");

/**
 * The file exists and its (normalised) contents hash to `expectedSha256`. Compares hashes only;
 * the content is never returned, logged or put in `detail`.
 */
export function fileContentVerifier(options: { path: string; expectedSha256: string }): ControlVerifier {
  const expected = options.expectedSha256.toLowerCase();
  return {
    name: "file-content",
    async verify(signal) {
      if (!/^[a-f0-9]{64}$/.test(expected)) return { status: "inconclusive", detail: "no valid expected hash" };
      if (signal.aborted) return { status: "inconclusive", detail: "aborted" };
      if (!existsSync(options.path)) return { status: "failed", detail: "file missing" };
      const stat = statSync(options.path);
      if (!stat.isFile()) return { status: "failed", detail: "not a file" };
      if (stat.size > MAX_VERIFY_BYTES) return { status: "inconclusive", detail: `file too large to check (${stat.size} bytes)` };
      const actual = sha256OfText(readFileSync(options.path, "utf8"));
      return actual === expected
        ? { status: "passed", detail: `sha256 matches (${stat.size} bytes)` }
        : { status: "failed", detail: `sha256 differs (${stat.size} bytes)` };
    },
  };
}
