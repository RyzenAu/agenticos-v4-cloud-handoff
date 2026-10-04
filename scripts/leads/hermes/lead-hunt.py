"""M&U overnight lead hunt (Hermes cron, no-agent, runs ~1:30 am).

Each night takes the next suburb around Mount Druitt and asks the AgenticOS lead engine for new
dentists and real-estate agencies there, via OpenStreetMap (--source osm) — free, no key, no
billing, so there's no monthly budget to protect; this script still keeps each night to ~24
lookups so it's polite to Overpass and moves through the suburb list at a steady pace. Results
land in the CRM and in lead-hunt-last.json, which the 5:30 business-dream job reads for the
morning message and the Leads / Automations pages read for their status. Never dials, emails or
contacts anyone. Google Places (paid, 900/month free cap) stays available as a manual fallback —
`bun scripts/leads/cli.ts find ... --source google` — but this nightly cron never uses it.

Stdout is the job's message, so it stays empty on a normal night. A failed or partly failed
night prints ONE line with the cause and the owner action EVERY night it fails (the first night
names the cause, later nights say how long it has been failing), and one line when it recovers.
The script then exits non-zero, so the Hermes job shows the night as failed instead of "ok"
(AUDIT-A4 #5: two failed nights showed "ok"). The night's status and owner action are always
written to lead-hunt-last.json, so no page can show a failed hunt as ok.

The engine retries Overpass busy/timeout answers itself (scripts/leads/osm.ts
fetchOsmElementsWithRetry) and uses any mirrors the owner lists in OVERPASS_URLS.

Rotation (T5c, 29 Sep 2026): each night hunts the suburb tried LEAST RECENTLY (never-tried first,
in AREAS order), and every night records its attempt, whatever happened: ok, partial, failed, or
0 new leads. So the rotation always moves on. The old counter only advanced after a fully
successful night, which kept it on St Marys NSW for three nights of Overpass 504s. A failed suburb
is retried when its turn comes round again. The state (lead-hunt-state.json, per-area history) is
written atomically with a .bak copy, and an unreadable file never restarts the list.

Repo copy: AgenticOS-v4/scripts/leads/hermes/lead-hunt.py. Hermes runs its own copy from
%LOCALAPPDATA%/hermes/scripts; install by copying this file there (owner step).
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime

REPO = r"C:\Users\Nebula PC\source\repos\AgenticOS-v4"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("LEAD_HUNT_STATE") or os.path.join(HERE, "lead-hunt-state.json")
LAST = os.environ.get("LEAD_HUNT_LAST") or os.path.join(HERE, "lead-hunt-last.json")
# Override for hand tests, so a manual run doesn't use up tonight's one alert.
ALERT = os.environ.get("LEAD_HUNT_ALERT_STATE") or os.path.join(HERE, ".lead-hunt-alert-state.json")

# Home patch first, then outwards. Edit freely; the rotation picks up changes.
AREAS = [
    "Mount Druitt NSW", "Rooty Hill NSW", "St Marys NSW", "Blacktown NSW", "Doonside NSW",
    "Plumpton NSW", "Minchinbury NSW", "Glendenning NSW", "Colyton NSW", "Oxley Park NSW",
    "Kingswood NSW", "Penrith NSW", "Werrington NSW", "Seven Hills NSW", "Quakers Hill NSW",
    "Schofields NSW", "Riverstone NSW", "Glenwood NSW", "Kellyville Ridge NSW", "Marsden Park NSW",
    "Erskine Park NSW", "St Clair NSW", "Emu Plains NSW", "Toongabbie NSW", "Wentworthville NSW",
]
VERTICALS = [("dental", 12), ("real-estate", 12)]

# OpenStreetMap causes are checked first since --source osm is what this cron actually uses; the
# Google causes below only matter if someone runs this script (or the CLI) with --source google.
# Matched on the engine's own wording ("Overpass 504: Gateway Timeout (after 3 attempts: …)"), by
# status first: the old list matched the word "overpass" and called every 504 a rate limit.
OSM_CAUSES = [
    ("osm-timeout", ("overpass 502", "overpass 503", "overpass 504", "overpass timeout", "overpass unreachable",
                     "gateway timeout", "timed out", "timeoutexpired"),
     "OpenStreetMap's Overpass server timed out or was unavailable, even after retries",
     "Nothing to fix tonight: the hunt moves on to the next suburb and retries this one when its turn "
     "comes round. If it keeps failing, approve an Overpass mirror: add OVERPASS_URLS="
     "\"https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter\" to "
     "~/.config/agentic-os.env."),
    ("osm-rate-limit", ("overpass 429", "rate limit", "too many requests"),
     "OpenStreetMap's Overpass server rate-limited tonight's hunt",
     "Nothing to fix: the hunt moves on and retries this suburb when its turn comes round. If this keeps happening most "
     "nights, slow the rotation or approve an Overpass mirror (OVERPASS_URLS)."),
    ("osm-area", ("don't know where", "do not know where"),
     "Tonight's suburb isn't in the area table",
     "Add it to the suburb table in scripts/leads/osm.ts, or check the spelling in this script's AREAS list."),
]
# Known causes -> (short problem, the exact owner action). First match wins.
CAUSES = [
    ("places-403", ("403", "permission_denied", "does not have permission"),
     "Google Places refused the key (403)",
     "Enable Places API (New) for the key: Google Cloud Console > APIs & Services > Library > "
     "Places API (New) > Enable (and check the key's API restrictions allow it)."),
    ("no-key", ("google_places_api_key isn't set", "api key not valid", "api_key_invalid"),
     "the Google Places key is missing or invalid",
     "Put a valid GOOGLE_PLACES_API_KEY in ~/.config/agentic-os.env."),
    ("billing", ("billing", "429", "quota", "resource_exhausted"),
     "Google Places quota or billing stopped the search",
     "Check billing and quotas for Places API (New) in Google Cloud Console."),
    ("budget", ("budget",),
     "this month's Places budget is used up",
     "Nothing to fix: the hunt resumes when the monthly budget resets."),
]


def bun():
    for path in (shutil.which("bun"), os.path.expandvars(r"%APPDATA%\npm\node_modules\bun\bin\bun.exe"),
                 os.path.expandvars(r"%USERPROFILE%\.bun\bin\bun.exe")):
        if path and os.path.exists(path):
            return path
    return None


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, data):
    """Atomic: write a temp file, then replace, so a crash mid-write can't leave half a file."""
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---- rotation state ---------------------------------------------------------------------------
# v2: {"version": 2, "areas": {name: {"last_attempt", "last_status", "last_new", "attempts",
#      "failures", "last_ok"}}, "last_area"}. The v1 shape ({"next": N, ...}) is migrated.
NEVER = ""  # sorts before every attempt timestamp


def migrate(state):
    """v1 {"next": N} -> v2: the first N suburbs count as tried (in order, oldest first)."""
    if isinstance(state, dict) and state.get("version") == 2 and isinstance(state.get("areas"), dict):
        return state
    tried = int(state.get("next", 0)) if isinstance(state, dict) and str(state.get("next", "0")).isdigit() else 0
    areas = {}
    for i in range(min(tried, len(AREAS))):
        # "0000-…" sorts after never-tried ("") and before any real timestamp.
        areas[AREAS[i]] = {"last_attempt": f"0000-00-00T00:00:{i:02d}", "last_status": "migrated", "last_new": None,
                           "attempts": 1, "failures": 0, "last_ok": None}
    return {"version": 2, "areas": areas, "last_area": state.get("last_area") if isinstance(state, dict) else None}


def load_state():
    """The state file, else its .bak, else a fresh state. An unreadable file never silently restarts
    the list at the first suburb unless there is truly nothing to go on."""
    for path in (STATE, STATE + ".bak"):
        data = load(path, None)
        if isinstance(data, dict):
            return migrate(data)
    fresh = migrate({})
    if os.path.exists(STATE) or os.path.exists(STATE + ".bak"):
        # Both exist but neither parses: restarting is the only option, but never silently.
        fresh["_restarted"] = "lead-hunt-state.json and its .bak are unreadable, so the rotation restarted at the first suburb"
    return fresh


def valid_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            json.load(f)
        return True
    except (OSError, ValueError):
        return False


def save_state(state):
    # Only a readable state file becomes the backup: a corrupt one must never overwrite a good .bak.
    if os.path.exists(STATE) and valid_json(STATE):
        try:
            shutil.copyfile(STATE, STATE + ".bak")
        except OSError:
            pass
    state.pop("_restarted", None)
    save(STATE, state)


def pick_area(state):
    """The suburb tried least recently; never-tried first; ties in AREAS order."""
    areas = state.get("areas", {})
    return min(AREAS, key=lambda a: (areas.get(a, {}).get("last_attempt") or NEVER, AREAS.index(a)))


def record_attempt(state, area, night):
    rec = state.setdefault("areas", {}).setdefault(area, {"attempts": 0, "failures": 0, "last_ok": None})
    new = sum(r.get("new", 0) for r in night.get("runs", []))
    rec.update({"last_attempt": night["ran_at"], "last_status": night["status"], "last_new": new,
                "attempts": rec.get("attempts", 0) + 1})
    if night["status"] == "ok":
        rec["last_ok"] = night["ran_at"]
    else:
        rec["failures"] = rec.get("failures", 0) + 1
    state["last_area"] = area
    return state


def classify(errors):
    """(code, problem, owner_action) for the first recognised cause, else a generic one."""
    text = " ".join(errors).lower()
    # The nightly cron searches OpenStreetMap only, so an engine run that hit the wrapper's own
    # time limit (TimeoutExpired) is an Overpass hang too.
    if "overpass" in text or "nominatim" in text or "timeoutexpired" in text:
        for code, needles, problem, action in OSM_CAUSES:
            if any(n in text for n in needles):
                return code, problem, action
        first = errors[0].split(":", 1)[-1].strip() if errors else "unknown error"
        return ("osm-other", f"OpenStreetMap lookup failed ({first[:120]})",
                "Run `bun scripts/leads/cli.ts find --vertical dental --area \"Mount Druitt NSW\" --max 1` "
                "in the AgenticOS-v4 folder to see the full error.")
    for code, needles, problem, action in CAUSES:
        if any(n in text for n in needles):
            return code, problem, action
    first = errors[0].split(":", 1)[-1].strip() if errors else "unknown error"
    return ("other", f"the lead engine failed ({first[:120]})",
            "Run `bun scripts/leads/cli.ts find --vertical dental --area \"Mount Druitt NSW\" --max 1` "
            "in the AgenticOS-v4 folder to see the full error.")


def hunt(area):
    night = {"ran_at": datetime.now().isoformat(timespec="seconds"), "area": area, "runs": [], "errors": []}
    exe = bun()
    if not exe:
        night["errors"].append("all: bun not found")
        return night
    for vertical, cap in VERTICALS:
        try:
            done = subprocess.run([exe, "scripts/leads/cli.ts", "find", "--vertical", vertical, "--area", area,
                                   "--max", str(cap), "--source", "osm", "--json"], cwd=REPO, capture_output=True,
                                  text=True, encoding="utf-8", errors="replace", timeout=600)
        except (OSError, subprocess.TimeoutExpired) as e:
            night["errors"].append(f"{vertical}: {type(e).__name__}")
            continue
        if done.returncode != 0:
            night["errors"].append(f"{vertical}: {(done.stderr or done.stdout).strip()[:300]}")
            continue
        try:
            result = json.loads(done.stdout)
        except ValueError:
            night["errors"].append(f"{vertical}: engine output wasn't JSON")
            continue
        added = result.get("added", [])
        night["runs"].append({
            "vertical": vertical, "found": result.get("searched", 0), "new": len(added),
            "budget_left": result.get("budgetLeft"), "stopped_for_budget": result.get("stoppedForBudget", False),
            # No website first: that's the easiest pitch.
            "no_website": [{"id": l.get("id"), "name": l.get("name"), "phone": l.get("phone"),
                            "score": l.get("score")} for l in added if not l.get("website")],
            "top": [{"id": l.get("id"), "name": l.get("name"), "phone": l.get("phone"), "score": l.get("score"),
                     "pitch": l.get("pitch"), "why": (l.get("reasons") or [])[:2]} for l in added[:5]],
        })
    return night


def main():
    try:  # the alert line has an emoji; never let a console code page crash the run
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    state = load_state()
    restarted = state.get("_restarted")
    area = pick_area(state)
    night = hunt(area)
    if restarted:
        night["state_warning"] = restarted
    errors = night["errors"]
    night["status"] = "ok" if not errors else ("partial" if night["runs"] else "failed")
    if errors:
        code, problem, action = classify(errors)
        night.update({"problem_code": code, "problem": problem, "owner_action": action})
    # Every night moves the rotation on, whatever happened (T5c). A broken setup still can't pass
    # silently: a failed or partial night prints its alert and exits 1 every night (below).
    record_attempt(state, area, night)
    night["next_area"] = pick_area(state)
    save_state(state)

    alert = load(ALERT, {})
    failing_before = bool(alert.get("failing"))
    previous = load(LAST, {})
    if errors:
        # A streak that began before this state file existed still dates from its first failure.
        earlier = previous.get("failing_since") or previous.get("ran_at") if previous.get("errors") else None
        since = alert.get("since") if failing_before else (earlier or night["ran_at"])
        night["failing_since"] = since
        save(ALERT, {"failing": True, "since": since, "code": night["problem_code"]})
    else:
        save(ALERT, {"failing": False})
    save(LAST, night)

    new = sum(r["new"] for r in night["runs"])
    if restarted:
        print(f"⚠️ Lead hunt: {restarted}. Tonight searched {area}.")
    if errors:
        what = "failed" if night["status"] == "failed" else "partly failed"
        skipped = f" Next night: {night['next_area']} ({area} is retried when its turn comes round)."
        if not failing_before or alert.get("code") != night["problem_code"]:
            print(f"⚠️ Lead hunt {what} ({area}): {night['problem']}. {night['owner_action']}{skipped}")
        else:
            print(f"⚠️ Lead hunt {what} again ({area}), failing since {night['failing_since'][:10]}: {night['problem']}.{skipped}")
        return 1
    if failing_before:
        print(f"✅ Lead hunt is working again: {new} new lead{'' if new == 1 else 's'} in {area}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
