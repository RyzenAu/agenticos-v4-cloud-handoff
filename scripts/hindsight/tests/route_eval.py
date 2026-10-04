"""Memory-processing (retain/extraction) route evaluation on the SYNTHETIC instance only.

For each route, the synthetic Hindsight (port 8889, pg0 hindsight-synth) is started by the real
supervisor with that route as its only LLM, a synthetic fact set is retained through Hindsight's
real extraction pipeline, and the route is scored on:
  * quality     -- checklist of expected facts found in the extracted memory units (+ forbidden
                   hallucinations), per document;
  * latency     -- wall time per synchronous retain;
  * reliability -- HTTP errors / timeouts over N retains;
  * receipts    -- provider/model/tokens from llm_requests (content-free receipts: input/output
                   are truncated to 1 character by HINDSIGHT_API_LLM_TRACE_MAX_CHARS=1), and a
                   check that no canary text reached llm_requests at all;
  * cost        -- tokens x the route's list price (subscription/free routes: no cash cost).
Every test bank is deleted at the end of its route. Never touches the pilot.

Run:  D:\\hindsight\\venv\\Scripts\\python.exe scripts/hindsight/tests/route_eval.py [--routes a,b] [--rounds 2] --evidence out.json
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent
sys.path.insert(0, str(SCRIPTS))
import supervisor as sv  # noqa: E402

BASE_CONFIG = SCRIPTS / "hindsight.profiles.json"
ENV_FILE = r"%USERPROFILE%\.config\agentic-os.env"
HERMES_ENV = r"%LOCALAPPDATA%\hermes\.env"

# price per 1M tokens (input, output) in USD, from the providers' model lists on 28 Sep 2026
ROUTES: dict[str, dict] = {
    "codex": {"member": {"provider": "openai-codex", "model": "gpt-6-astra", "codex_home": r"C:\Users\Nebula PC\.codex"},
              "cost": "ChatGPT subscription allowance (no per-call cash; not free)", "price": None},
    "deepseek": {"member": {"provider": "deepseek", "model": "deepseek-flash",
                            "api_key_ref": {"env": "DEEPSEEK_API_KEY", "file": ENV_FILE}},
                 "cost": "metered (DeepSeek prepaid)", "price": (0.15, 0.60)},
    "openrouter-deepseek": {"member": {"provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash",
                                       "api_key_ref": {"env": "OPENROUTER_API_KEY", "file": ENV_FILE},
                                       "extra_body": {"provider": {"zdr": True, "data_collection": "deny"}},
                                       "timeout": 60, "max_retries": 1},
                            "cost": "metered (OpenRouter credit)", "price": (0.035, 0.29)},
    "groq": {"member": {"provider": "groq", "model": "openai/gpt-oss-120b",
                        "api_key_ref": {"env": "GROQ_API_KEY", "file": ENV_FILE}},
             "cost": "free tier (rate-limited)", "price": (0.0, 0.0)},
    "gemini": {"member": {"provider": "gemini", "model": "gemini-3.8-flash",
                          "api_key_ref": {"env": "GEMINI_API_KEY", "file": ENV_FILE}},
               "cost": "free tier (unpaid terms)", "price": (0.0, 0.0),
               "api_env": {"HINDSIGHT_API_LLM_PROMPT_CACHE_ENABLED": "false"}},
    # Failover proof: the primary gets a deliberately invalid key (synthetic value, set only in the
    # supervisor's environment for this run), so every save must fail over to the next member.
    "failover": {"chain": [{"provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash",
                            "api_key_ref": {"env": "SYNTH_INVALID_OPENROUTER_KEY"}, "timeout": 30, "max_retries": 0},
                           {"provider": "groq", "model": "openai/gpt-oss-120b",
                            "api_key_ref": {"env": "GROQ_API_KEY", "file": ENV_FILE}, "timeout": 60, "max_retries": 1}],
                 "member": {"provider": "chain", "model": "openrouter(invalid key) -> groq"},
                 "env": {"SYNTH_INVALID_OPENROUTER_KEY": "sk-or-v1-synthetic-invalid-key-000000000000"},
                 "cost": "free (groq) after a failed paid attempt", "price": (0.0, 0.0), "docs": 3, "rounds": 1},
    # The production chain with its primary broken (synthetic invalid key): each save must be served
    # by Groq free, and by Codex once Groq's per-minute token limit is hit.
    "failover3": {"chain": [{"provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash",
                             "api_key_ref": {"env": "SYNTH_INVALID_OPENROUTER_KEY"}, "timeout": 30, "max_retries": 0},
                            {"provider": "groq", "model": "openai/gpt-oss-120b",
                             "api_key_ref": {"env": "GROQ_API_KEY", "file": ENV_FILE}, "timeout": 60, "max_retries": 1},
                            {"provider": "openai-codex", "model": "gpt-6-astra", "codex_home": r"C:\Users\Nebula PC\.codex",
                             "timeout": 120}],
                  "member": {"provider": "chain", "model": "openrouter(invalid key) -> groq -> codex"},
                  "env": {"SYNTH_INVALID_OPENROUTER_KEY": "sk-or-v1-synthetic-invalid-key-000000000000"},
                  "cost": "free/subscription after a failed paid attempt", "price": None, "docs": 6, "rounds": 1},
    "hermes": {"member": {"provider": "openai", "model": "hermes-agent", "base_url": "http://127.0.0.1:8642/v1",
                          "api_key_ref": {"env": "API_SERVER_KEY", "file": HERMES_ENV}},
               "cost": "Hermes' own model (Codex subscription) via an agent run", "price": None, "docs": 1, "rounds": 1},
}

DOCS = [
    ("Pelican{R} Dental in Parramatta opens at 7:30am on Mondays and closes at 6pm. It is closed on Sundays.",
     [["parramatta"], ["7:30", "07:30", "7.30"], ["monday"], ["6pm", "6 pm", "18:00", "6:00 pm", "6:00pm", "6 p.m"], ["sunday"]],
     ["saturday"]),
    ("Ada Voss{R} became Pelican{R} Dental's practice manager on 3 March 2026. She prefers SMS over email for urgent matters.",
     [["practice manager"], ["march 2026", "2026-03", "3 march", "march 3"], ["sms", "text message"], ["email"]],
     []),
    ("The Heron{R} Conveyancing quote for the Blacktown unit settlement was A$1,450 including GST, valid until 30 November 2026.",
     [["1,450", "1450"], ["gst"], ["blacktown"], ["november 2026", "2026-11", "30 november", "november 30"]],
     ["excluding gst", "excl. gst"]),
    ("Otter{R} Real Estate moved its weekly team meeting from Tuesday 9am to Thursday 10am, starting in October 2026.",
     [["thursday"], ["10am", "10 am", "10:00"], ["tuesday"], ["october 2026", "2026-10"]],
     []),
    ("Juniper{R} Physio declined the A$999 package because they already use Cliniko for bookings; follow up in January 2027.",
     [["999"], ["cliniko"], ["declin"], ["january 2027", "2027-01"]],
     ["accepted the"]),
    ("The Marten{R} bakery's delivery van, a white 2019 Toyota HiAce, is serviced every six months at the Penrith workshop.",
     [["hiace"], ["2019"], ["six months", "6 months", "every 6", "twice a year", "biannual", "semi-annual"], ["penrith"]],
     []),
]


def http(base, method, path, key, body=None, timeout=300.0):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in b"[{" else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # timeout / connection
        return type(e).__name__, None


def sql(profile, q):
    return sv.app_sql(profile, q, sep="	")


def start_supervisor(cfg: Path, profile: dict, key: str, since: float, extra_env: dict | None = None) -> bool:
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0
    subprocess.Popen([profile["python_exe"], str(SCRIPTS / "supervisor.py"), "run", "--profile", "synth", "--config", str(cfg)],
                     creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=si, stdin=subprocess.DEVNULL,
                     env=dict(os.environ, **(extra_env or {})))
    status_path = Path(profile["run_dir"]) / "status.json"
    for _ in range(120):
        time.sleep(2)
        try:
            st = json.loads(status_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if st.get("state") == "running" and st.get("supervisor_pid") and os.path.getmtime(status_path) > since:
            return True
        if st.get("state") in ("error", "failed_crashloop", "error_no_key") and os.path.getmtime(status_path) > since:
            return False
    return False


def stop_supervisor(cfg: Path):
    subprocess.run([sys.executable, str(SCRIPTS / "supervisor.py"), "stop", "--profile", "synth", "--config", str(cfg)],
                   capture_output=True, timeout=180)


def score(profile, bank, doc_id, checks, forbidden):
    rows = sql(profile, f"select text from memory_units where bank_id='{bank}' and document_id='{doc_id}'")
    facts = [r for r in rows.splitlines() if r.strip()]
    blob = " ".join(facts).lower()
    found = sum(1 for alts in checks if any(a in blob for a in alts))
    halluc = sum(1 for f in forbidden if f in blob)
    return {"facts": len(facts), "found": found, "total": len(checks), "hallucinations": halluc}


def eval_route(name: str, spec: dict, rounds: int, run: str) -> dict:
    raw = json.loads(BASE_CONFIG.read_text(encoding="utf-8"))
    synth = raw["profiles"]["synth"]
    synth["llm"] = {"chain": spec.get("chain") or [spec["member"]], "strategy": {"mode": "failover"}}
    synth["run_dir"] = r"D:\hindsight\service\run\synth"
    synth.setdefault("api_env", {}).update(spec.get("api_env", {}))
    cfg = Path(r"D:\hindsight\service\run") / f"route-eval-{name}.json"
    cfg.write_text(json.dumps(raw, indent=2), encoding="utf-8")
    profile = sv.load_profile(cfg, "synth")
    active, skipped = sv.llm_chain(profile, dict(os.environ, **spec.get("env", {})) if spec.get("env") else None)
    out = {"route": name, "provider": spec["member"]["provider"], "model": spec["member"].get("model"),
           "cost_basis": spec["cost"]}
    if not active:
        out.update({"status": "skipped", "why": "key reference not set"})
        return out
    key, _ = sv.resolve_key(profile)
    base = f"http://127.0.0.1:{profile['port']}"
    t0 = time.time()
    if not start_supervisor(cfg, profile, key, t0, spec.get("env")):
        out.update({"status": "failed_to_start"})
        stop_supervisor(cfg)
        return out
    out["startup_s"] = round(time.time() - t0, 1)
    bank = f"syn-eval-{name}-{run}"
    n_docs = spec.get("docs", len(DOCS))
    rounds = spec.get("rounds", rounds)
    latencies, errors, per_doc = [], [], []
    for r in range(rounds):
        for i, (text, checks, forbidden) in enumerate(DOCS[:n_docs]):
            tag = f"{run}{name[:2]}{r}{i}"
            doc_id = f"ev-{name}-{r}-{i}-{run}"
            body = {"async": False, "items": [{"content": text.replace("{R}", tag), "document_id": doc_id,
                                               "context": "synthetic business note"}]}
            s = time.time()
            st, _ = http(base, "POST", f"/v1/default/banks/{bank}/memories", key, body)
            dt = time.time() - s
            if st == 200:
                latencies.append(dt)
                sc = score(profile, bank, doc_id, checks, forbidden)
            else:
                errors.append({"round": r, "doc": i, "status": st, "seconds": round(dt, 1)})
                sc = {"facts": 0, "found": 0, "total": len(checks), "hallucinations": 0}
            per_doc.append({"round": r, "doc": i, **sc})
    n = rounds * n_docs
    rec = sql(profile, f"select provider, model, status, count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0), "
                       f"coalesce(round(avg(duration_ms)),0) from llm_requests where bank_id='{bank}' group by 1,2,3 order by 1,2,3")
    receipts = []
    tok_in = tok_out = 0
    for line in rec.splitlines():
        p, m, s, c, ti, to, d = line.split("\t")
        receipts.append({"provider": p, "model": m, "status": s, "calls": int(c), "input_tokens": int(ti),
                         "output_tokens": int(to), "avg_ms": int(float(d))})
        tok_in += int(ti)
        tok_out += int(to)
    leaks = int(sql(profile, f"select count(*) from llm_requests where bank_id='{bank}' and (input::text ilike '%{run}%' "
                             f"or output::text ilike '%{run}%' or metadata::text ilike '%{run}%' or llm_info::text ilike '%{run}%' "
                             f"or coalesce(error,'') ilike '%{run}%')") or 0)
    found = sum(d["found"] for d in per_doc)
    total = sum(d["total"] for d in per_doc)
    price = spec.get("price")
    out.update({
        "status": "ok",
        "retains": n,
        "errors": len(errors), "error_detail": errors,
        "quality_pct": round(100 * found / total, 1) if total else 0.0,
        "hallucinations": sum(d["hallucinations"] for d in per_doc),
        "facts_per_doc": round(sum(d["facts"] for d in per_doc) / max(1, n), 1),
        "latency_s": {"median": round(statistics.median(latencies), 1) if latencies else None,
                      "max": round(max(latencies), 1) if latencies else None},
        "receipts": receipts,
        "receipt_rows_with_canary_text": leaks,
        "tokens": {"input": tok_in, "output": tok_out},
        "usd": round(tok_in / 1e6 * price[0] + tok_out / 1e6 * price[1], 6) if price else None,
        "per_doc": per_doc,
    })
    st, _ = http(base, "DELETE", f"/v1/default/banks/{bank}", key)
    out["bank_deleted"] = st == 200
    stop_supervisor(cfg)
    cfg.unlink(missing_ok=True)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", default="codex,deepseek,openrouter-deepseek,groq,gemini,hermes")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--evidence")
    a = ap.parse_args()
    run = uuid.uuid4().hex[:6]
    results = []
    for name in a.routes.split(","):
        print(f"--- {name}", flush=True)
        res = eval_route(name, ROUTES[name], a.rounds, run)
        slim = {k: v for k, v in res.items() if k != "per_doc"}
        print(json.dumps(slim, sort_keys=True), flush=True)
        results.append(res)
    if a.evidence:
        Path(a.evidence).write_text(json.dumps({"run": run, "results": results}, indent=2), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
