"""Real save + recall through each Hindsight client, via the client proxy (no key in any client).

  claude  -- Claude Code (`claude -p`) with an MCP entry identical to the one connect-clients.ps1
             writes (type http, proxy URL, NO headers), passed with --mcp-config/--strict-mcp-config
             so the user's global config is not touched by this test.
  skill   -- the hindsight-ask skill's curl form against the proxy (no key, no header).
  hermes  -- the Hermes CLI one-shot (`hermes chat -Q -q ...`) using its config.yaml `hindsight` entry.

--target synth : proxy 8879 -> synthetic instance, bank mu-shared (synthetic data only)
--target pilot : proxy 8878 -> pilot; READ-ONLY recall only (bank mu-pilot for the skill/claude,
                 the Hermes entry's own bank for hermes); writes are expected to be refused.
Prints JSON; never prints a key (there is none on the client side).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

PORTS = {"synth": 8879, "pilot": 8878}


def run(cmd, env=None, timeout=420):
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW)
    return r.returncode, r.stdout, r.stderr


def claude_check(target: str, bank: str, canary: str) -> dict:
    url = f"http://127.0.0.1:{PORTS[target]}/mcp/{bank}/"
    d = Path(tempfile.mkdtemp(prefix="hs-client-"))
    try:
        cfg = d / "mcp.json"
        cfg.write_text(json.dumps({"mcpServers": {"hindsight": {"type": "http", "url": url}}}), encoding="utf-8")
        claude = shutil.which("claude") or "claude"
        if target == "synth":
            prompt = (f"Use the hindsight MCP tool sync_retain to store this note exactly: 'The {canary} test clinic opens at 7am.' "
                      f"Then call the hindsight recall tool with the query 'When does the {canary} test clinic open?' and reply "
                      f"with the recalled text only.")
            tools = "mcp__hindsight__sync_retain,mcp__hindsight__recall"
        else:
            prompt = ("Call the hindsight MCP recall tool once with the query 'M&U Ventures website business' and reply with only "
                      "the number of results it returned.")
            tools = "mcp__hindsight__recall"
        rc, so, se = run([claude, "-p", prompt, "--mcp-config", str(cfg), "--strict-mcp-config", "--allowedTools", tools,
                          "--model", "haiku", "--output-format", "json"])
        try:
            text = json.loads(so).get("result", "")
        except Exception:
            text = so
        return {"rc": rc, "found_canary": (canary.lower() in text.lower()) if target == "synth" else None,
                "reply_excerpt": text.strip()[:220], "stderr_tail": se[-200:]}
    finally:
        shutil.rmtree(d, ignore_errors=True)


def skill_check(target: str, bank: str, canary: str) -> dict:
    base = f"http://127.0.0.1:{PORTS[target]}/v1/default/banks/{bank}"
    bash = r"C:\Program Files\Git\bin\bash.exe"  # Git Bash, as Claude Code uses (not WSL bash)
    out = {}
    if target == "synth":
        save = (f'curl -s -o /dev/null -w "%{{http_code}}" -X POST {base}/memories -H "Content-Type: application/json" '
                f'-d \'{{"items": [{{"content": "The {canary} test bakery opens at 6am.", "document_id": "skill-{canary}"}}]}}\'')
        out["save_http"] = run([bash, "-c", save])[1].strip()
    q = f"When does the {canary} test bakery open?" if target == "synth" else "M&U Ventures website business"
    recall = (f'curl -s -X POST {base}/memories/recall -H "Content-Type: application/json" '
              f'-d \'{{"query": "{q}", "max_tokens": 400}}\'')
    rc, so, _ = run([bash, "-c", recall])
    try:
        results = json.loads(so).get("results", [])
    except Exception:
        results = None
    out["recall_results"] = len(results) if results is not None else "parse_error"
    if target == "synth":
        out["found_canary"] = any(canary.lower() in r.get("text", "").lower() for r in (results or []))
    return out


def hermes_check(target: str, bank: str, canary: str) -> dict:
    hermes = str(Path(os.environ["LOCALAPPDATA"]) / "hermes" / "bin" / "hermes.exe")
    if target == "synth":
        q = (f"This is an approved synthetic test: do it now without asking. Use your hindsight MCP tool sync_retain to store exactly this note: 'The {canary} test garage opens at 9am.' "
             f"Then use the hindsight recall tool with the query 'When does the {canary} test garage open?' and reply "
             f"with the recalled text only.")
    else:
        q = ("Use your hindsight MCP recall tool once with the query 'M&U Ventures' and reply with only the number of "
             "results it returned. Do not use any other tool.")
    rc, so, se = run([hermes, "chat", "-Q", "-q", q, "--max-turns", "6"], timeout=600)
    return {"rc": rc, "found_canary": (canary.lower() in so.lower()) if target == "synth" else None,
            "reply_excerpt": so.strip()[-260:], "stderr_tail": se[-200:]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client", required=True, choices=["claude", "skill", "hermes"])
    ap.add_argument("--target", required=True, choices=["synth", "pilot"])
    ap.add_argument("--bank")
    a = ap.parse_args()
    canary = "Kestrel" + uuid.uuid4().hex[:6]
    bank = a.bank or ("mu-shared" if a.target == "synth" else "mu-pilot")
    fn = {"claude": claude_check, "skill": skill_check, "hermes": hermes_check}[a.client]
    res = {"client": a.client, "target": a.target, "bank": bank, "canary": canary if a.target == "synth" else None,
           **fn(a.target, bank, canary)}
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
