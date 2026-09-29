#!/usr/bin/env python3
"""jev-decide: ask TypeSafe Jev for typed decisions from the command line.

Reads TYPESAFE_API_KEY from the environment or ~/.config/agentic-os.env (never printed),
so Hermes and scripts can use Jev without a second copy of the key.

  python jev-decide.py --state "text or JSON" --questions '{"q": {"type": "choice", ...}}'
  python jev-decide.py --state-file state.json --questions-file questions.json
  python jev-decide.py check

Questions follow docs.typesafe.ai/api: a map of name -> {type: choice|score|noul,
instructions, criteria}. Prints the API's JSON answer (answers, probabilities, usage).

The model id comes from the router catalogue (scripts/model-router/catalogue.json, model
typesafe/jev-latest), the one place model ids live. The TypeScript Jev client
(scripts/jev-client.ts) is the OS's one Jev client; this Python CLI can't import it, so its
calls write NO router receipts (TypeScript-only today). Prefer jevDecide() from TypeScript.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# Same endpoint as JEV_URL in scripts/jev-client.ts (Python can't import that constant).
URL = "https://api.typesafe.ai/v1/systemone"
CATALOGUE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model-router", "catalogue.json")
CATALOGUE_ID = "typesafe/jev-latest"
ENV_FILE = os.path.join(os.path.expanduser("~"), ".config", "agentic-os.env")


def api_key():
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    try:
        with open(ENV_FILE, encoding="utf-8") as handle:
            match = re.search(r"(?m)^\s*TYPESAFE_API_KEY\s*=\s*(\S+)", handle.read())
            return match.group(1).strip("'\"") if match else ""
    except OSError:
        return ""


def catalogue_model():
    """The provider model id for typesafe/jev-latest from the router catalogue, or "" if unreadable."""
    try:
        with open(CATALOGUE, encoding="utf-8") as handle:
            models = json.load(handle).get("models", [])
    except (OSError, ValueError):
        return ""
    for model in models:
        if isinstance(model, dict) and model.get("id") == CATALOGUE_ID:
            return str(model.get("providerModel") or "")
    return ""


def load(value, path):
    raw = open(path, encoding="utf-8").read() if path else value
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return raw


def main():
    parser = argparse.ArgumentParser(description="TypeSafe Jev decisions")
    parser.add_argument("command", nargs="?", default="decide", choices=["decide", "check"])
    parser.add_argument("--state")
    parser.add_argument("--state-file")
    parser.add_argument("--questions")
    parser.add_argument("--questions-file")
    parser.add_argument("--model", default=None, help=f"defaults to the catalogue's {CATALOGUE_ID}")
    args = parser.parse_args()

    key = api_key()
    if args.command == "check":
        print(f"TYPESAFE_API_KEY: {'set, ' + str(len(key)) + ' chars' if key else 'NOT SET'}")
        return 0 if key else 1
    if not key:
        print("TYPESAFE_API_KEY is not set (environment or ~/.config/agentic-os.env).", file=sys.stderr)
        return 1
    # As before E2, an unreadable catalogue never stops a decision: fall back to Jev's own alias.
    model = args.model or catalogue_model() or "jev-latest"
    state = load(args.state, args.state_file)
    questions = load(args.questions, args.questions_file)
    if state in (None, "") or not isinstance(questions, dict) or not questions:
        print("Give --state/--state-file and a JSON object of questions.", file=sys.stderr)
        return 2
    body = json.dumps({"model": model, "state": state, "questions": questions}).encode()
    request = urllib.request.Request(URL, data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    for attempt in range(3):
        started = time.time()
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
            data["latency_ms"] = int((time.time() - started) * 1000)
            print(json.dumps(data, indent=2))
            return 0
        except urllib.error.HTTPError as error:
            # 429 / 529: back off and retry, per TypeSafe's guidance. Anything else is final.
            if error.code in (429, 529) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            print(f"Jev error {error.code}: {error.read().decode(errors='replace')[:300]}", file=sys.stderr)
            return 1
        except (urllib.error.URLError, TimeoutError) as error:
            print(f"Jev unreachable: {error}", file=sys.stderr)
            return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
