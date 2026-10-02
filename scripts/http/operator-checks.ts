import { HermesApiUnavailable } from "../hermes-api";
import { SearchUnavailable } from "../leads/phone-finder";
import { PayloadTooLarge, ServiceUnavailable } from "./errors";

export { PayloadTooLarge, ServiceUnavailable };

/**
 * Status mapping and input checks for the /__operator API (Audit F5, P2-3 and P3).
 */

/**
 * The status for an error that reached the /__operator catch-all. Anything unrecognised stays
 * 400 (the handlers throw plain Errors for bad input); only the classes that mean "not the
 * caller's fault" or "too big" map elsewhere. `conflict` and `localOnly` are the plugin's own
 * classes, passed in so this module doesn't import the whole plugin graph.
 */
export function operatorErrorStatus(error: unknown, known: { conflict?: Function; localOnly?: Function; forbidden?: Function } = {}): number {
  if (error instanceof PayloadTooLarge) return 413;
  if (known.conflict && error instanceof known.conflict) return 409;
  if (known.localOnly && error instanceof known.localOnly) return 403;
  if (known.forbidden && error instanceof known.forbidden) return 403;
  if (error instanceof ServiceUnavailable || error instanceof HermesApiUnavailable || error instanceof SearchUnavailable) return 503;
  return 400;
}

const SETTING_SWITCHES = new Set(["mission", "openclaw", "news", "inboxAutoRead", "inboxShowAccounts", "inboxShowCategories"]);
const INBOX_ACCOUNTS = new Set(["gmail", "outlook", "capture", "slack", "skool"]);

/**
 * POST /__operator/settings: only the known on/off switches, each a boolean, and inboxAccounts as
 * an object of known providers to booleans. Returns the error to answer 400 with, or null.
 */
export function operatorSettingsError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Settings must be a JSON object.";
  const entries = Object.entries(body as Record<string, unknown>);
  if (!entries.length) return "Say which setting to change.";
  for (const [key, value] of entries) {
    if (key === "inboxAccounts") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return "inboxAccounts must be an object of on/off switches.";
      for (const [provider, on] of Object.entries(value as Record<string, unknown>)) {
        if (!INBOX_ACCOUNTS.has(provider)) return `Unknown inbox account: ${provider}.`;
        if (typeof on !== "boolean") return `inboxAccounts.${provider} must be true or false.`;
      }
      continue;
    }
    if (!SETTING_SWITCHES.has(key)) return `Unknown setting: ${key}.`;
    if (typeof value !== "boolean") return `${key} must be true or false.`;
  }
  return null;
}
