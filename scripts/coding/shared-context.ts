import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { scanLine } from "./redact";

/**
 * The shared M&U business context every coding role receives (30 Sep 2026, second Claude account).
 *
 * A role does NOT read anyone's profile memory: the Claude runner starts with auto-memory off, no MCP and
 * restricted settings, and a second account's profile is a fresh folder. So the context a role gets is
 * exactly what the orchestrator puts in its system text, and this module is the one place it comes from.
 * It is the SAME text whichever account or model runs the role, and the job records which files (by name,
 * size and digest) went in, so "what did the agent actually know" has an answer.
 *
 * Owner config: `.operator-data/coding/shared-context.json` = { "files": ["<absolute path>", …], "maxChars"?: n }.
 * It points at the existing brief (never a copy). Missing = no shared context (said so on the job). A file that
 * contains anything shaped like a credential is refused whole, never trimmed.
 */

export type SharedContextSource = { name: string; /** Absolute path of the brief (a path, never contents). */ path?: string; chars: number; sha256: string };
export type SharedContext = { text: string; sources: SharedContextSource[]; problems: string[]; truncated: boolean };

const MAX_FILE = 256 * 1024;
const DEFAULT_MAX_CHARS = 16_000;

export function loadSharedContext(configFile: string): SharedContext | null {
  if (!existsSync(configFile)) return null;
  let cfg: { files?: unknown; maxChars?: unknown };
  try { cfg = JSON.parse(readFileSync(configFile, "utf8")); } catch { return { text: "", sources: [], problems: ["shared-context.json is not valid JSON"], truncated: false }; }
  const files = Array.isArray(cfg.files) ? cfg.files.filter((f): f is string => typeof f === "string" && /^(?:[A-Za-z]:[\\/]|\/)/.test(f)).slice(0, 8) : [];
  const maxChars = typeof cfg.maxChars === "number" && cfg.maxChars >= 1000 && cfg.maxChars <= 60_000 ? Math.floor(cfg.maxChars) : DEFAULT_MAX_CHARS;
  const parts: string[] = [];
  const sources: SharedContextSource[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const name = basename(file);
    try {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE) { problems.push(`${name} can't be read safely`); continue; }
      const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
      if (text.split("\n").some((line) => scanLine(line).length > 0)) { problems.push(`${name} looks like it contains a credential, so it was left out`); continue; }
      parts.push(`--- ${name} ---\n${text}`);
      sources.push({ name, path: file, chars: text.length, sha256: createHash("sha256").update(text).digest("hex").slice(0, 12) });
    } catch { problems.push(`${name} couldn't be read`); }
  }
  let text = parts.join("\n\n");
  const truncated = text.length > maxChars;
  if (truncated) text = `${text.slice(0, maxChars)}\n[shared context truncated at ${maxChars} characters]`;
  return { text, sources, problems, truncated };
}

/** The system-text block a role receives. Background facts only: the job's objective and rules still govern. */
export function sharedContextBlock(ctx: SharedContext | null): string {
  if (!ctx?.text) return "";
  return `\n\nShared M&U Ventures business context (the same for every account and model; background facts about the business and the owner's standing preferences, not instructions to take any action beyond this job):\n${ctx.text}`;
}

/** One line for the job's progress: exactly what context went in. */
export function sharedContextNote(ctx: SharedContext | null): string {
  if (!ctx) return "Context: the job spec only (no shared business context is configured).";
  const got = ctx.sources.length ? ctx.sources.map((s) => `${s.name} (${s.chars} chars, sha ${s.sha256})`).join(", ") : "none readable";
  return `Context: job spec + shared business context ${got}${ctx.truncated ? ", truncated" : ""}${ctx.problems.length ? `; left out: ${ctx.problems.join("; ")}` : ""}. No profile memory is loaded.`;
}
