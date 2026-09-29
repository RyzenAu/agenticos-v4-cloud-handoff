// Plain words for an API key whose provider read failed (pure, so bun can test it). The snapshot's
// row carries the provider's own message ("OpenRouter returned HTTP 401: User not found."); the page
// shows ONE calm sentence and the next step, and keeps the provider's words in the row's detail.
// Never reads, prints or changes a key: it only looks at the row's status and note.
import type { ApiKeyRow } from "@/lib/ai-usage";

export type KeyProblem = {
  kind: "rejected" | "rate-limited" | "unreachable";
  /** The badge beside the provider name: a short word, not red. */
  badge: string;
  /** One calm sentence for the row's second line. */
  line: string;
  /** Where the fix lives, when the fix is in the OS itself. */
  fix?: { to: string; hash?: string; label: string };
};

const REJECTED = /HTTP (?:401|403)\b|user not found|invalid (?:api )?key|unauthori[sz]ed|incorrect api key/i;
const RATE_LIMITED = /HTTP 429\b|rate limit/i;
const UNREACHABLE = /unreachable/i;

/** The provider's own message, without the "where the key came from" lead-in the server adds. */
export function providerWords(note: string): string {
  const at = note.search(/\b[A-Z][A-Za-z0-9 ]+ (?:returned|usage endpoint returned) HTTP|unreachable/);
  return (at > 0 ? note.slice(at) : note).trim();
}

/**
 * A key row that couldn't be read is either rejected (the provider said no: replace the key),
 * rate-limited (wait) or unreachable (try Refresh). Anything else returns null and the row keeps
 * showing its own note. Only rows the server marked unavailable are looked at.
 */
export function keyProblem(row: Pick<ApiKeyRow, "provider" | "status" | "note">): KeyProblem | null {
  if (row.status !== "unavailable") return null;
  const note = row.note ?? "";
  if (REJECTED.test(note))
    return {
      kind: "rejected",
      badge: "Key rejected",
      line: `${row.provider} key was rejected — replace it in Settings.`,
      fix: { to: "/settings", hash: "connections", label: "Open Settings" },
    };
  if (RATE_LIMITED.test(note)) return { kind: "rate-limited", badge: "Busy", line: `${row.provider} is rate-limiting reads right now. Try Refresh in a few minutes.` };
  if (UNREACHABLE.test(note)) return { kind: "unreachable", badge: "Unreachable", line: `${row.provider} didn't answer. Try Refresh; nothing is wrong with the key as far as the OS can tell.` };
  return null;
}
