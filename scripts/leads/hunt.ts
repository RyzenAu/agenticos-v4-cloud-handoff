// Last night's lead hunt, as the Leads page, Automations, the HUD and Jarvis report it. Hermes'
// `lead-hunt` cron (~/.hermes/scripts/lead-hunt.py) writes lead-hunt-last.json after every run;
// a run where Google refused every search must never read as "ok" anywhere.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HuntStatus = "ok" | "partial" | "failed" | "never";
export type HuntReport = {
  status: HuntStatus;
  ranAt: string | null;
  area: string | null;
  added: number;
  errors: string[];
  problem?: string;
  ownerAction?: string;
  failingSince?: string | null;
  /** No run in the last 36 hours: the nightly job itself may not be running. */
  overdue: boolean;
};

export const PLACES_403_ACTION =
  "Enable Places API (New) for the key: Google Cloud Console → APIs & Services → Library → Places API (New) → Enable (and check the key's API restrictions allow it).";

/** Plain problem + owner action for engine errors from older runs that didn't record them.
 *  OpenStreetMap is the default source, so its own failure modes (Overpass rate limits/timeouts,
 *  an unrecognised area) are checked first; the Google-specific causes below only ever fire for a
 *  run made with `--source google`. */
export function explainHuntErrors(errors: string[]): { problem: string; ownerAction: string } | null {
  if (!errors.length) return null;
  const text = errors.join(" ").toLowerCase();
  if (/overpass|nominatim/.test(text)) {
    if (/429|rate.?limit/.test(text))
      return {
        problem: "OpenStreetMap's Overpass server rate-limited tonight's hunt",
        ownerAction: "Nothing to fix: it retries the same area next run. If this keeps happening most nights, slow the rotation or self-host Overpass.",
      };
    if (/timed out|timeout/.test(text))
      return { problem: "OpenStreetMap's Overpass server timed out", ownerAction: "Nothing to fix: it retries next run." };
    if (/don't know where|do not know where/.test(text))
      return {
        problem: "Tonight's suburb isn't in the area table",
        ownerAction: "Add it to the suburb table in scripts/leads/osm.ts, or check the spelling in the Hermes cron.",
      };
    return {
      problem: `OpenStreetMap lookup failed (${(errors[0].split(":").slice(1).join(":").trim() || errors[0]).slice(0, 120)})`,
      ownerAction: 'Run `bun scripts/leads/cli.ts find --vertical dental --area "Mount Druitt NSW" --max 1` to see the full error.',
    };
  }
  if (/403|permission_denied|does not have permission/.test(text))
    return { problem: "Google Places refused the key (403)", ownerAction: PLACES_403_ACTION };
  if (/google_places_api_key isn't set|api key not valid|api_key_invalid/.test(text))
    return {
      problem: "The Google Places key is missing or invalid",
      ownerAction: "Put a valid GOOGLE_PLACES_API_KEY in ~/.config/agentic-os.env.",
    };
  if (/billing|429|quota|resource_exhausted/.test(text))
    return {
      problem: "Google Places quota or billing stopped the search",
      ownerAction: "Check billing and quotas for Places API (New) in Google Cloud Console.",
    };
  const first = errors[0].split(":").slice(1).join(":").trim() || errors[0];
  return {
    problem: `The lead engine failed (${first.slice(0, 120)})`,
    ownerAction: 'Run `bun scripts/leads/cli.ts find --vertical dental --area "Mount Druitt NSW" --max 1` to see the full error.',
  };
}

export function huntFile(env: Record<string, string | undefined> = process.env, home = homedir()) {
  const candidates = [
    env.LEAD_HUNT_LAST,
    join(home, ".hermes", "scripts", "lead-hunt-last.json"),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "hermes", "scripts", "lead-hunt-last.json") : undefined,
  ].filter(Boolean) as string[];
  return candidates.find((path) => existsSync(path)) ?? null;
}

// The script writes Sydney local time without an offset ("2026-09-24T01:30:32").
function parseLocal(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function readHunt(file: string | null = huntFile(), now = Date.now()): HuntReport {
  const never: HuntReport = { status: "never", ranAt: null, area: null, added: 0, errors: [], overdue: true };
  if (!file) return never;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return never;
  }
  const errors: string[] = Array.isArray(raw?.errors) ? raw.errors.map(String).slice(0, 10) : [];
  const runs: any[] = Array.isArray(raw?.runs) ? raw.runs : [];
  const status: HuntStatus = ["ok", "partial", "failed"].includes(raw?.status)
    ? raw.status
    : !errors.length
      ? "ok"
      : runs.length
        ? "partial"
        : "failed";
  const explained = explainHuntErrors(errors);
  const ranAt = parseLocal(raw?.ran_at);
  return {
    status,
    ranAt,
    area: typeof raw?.area === "string" ? raw.area : null,
    added: runs.reduce((sum, run) => sum + (Number(run?.new) || 0), 0),
    errors,
    ...(status !== "ok" && explained
      ? {
          problem: typeof raw?.problem === "string" ? raw.problem : explained.problem,
          ownerAction:
            typeof raw?.owner_action === "string"
              ? raw.owner_action.replace(/ > /g, " → ")
              : explained.ownerAction,
        }
      : {}),
    failingSince: status === "ok" ? null : parseLocal(raw?.failing_since) ?? ranAt,
    overdue: !ranAt || now - Date.parse(ranAt) > 36 * 3_600_000,
  };
}
