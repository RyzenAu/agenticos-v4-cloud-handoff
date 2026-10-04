"""READ-ONLY check of the live pilot (port 8888, bank mu-pilot). Writes nothing to Hindsight.

Prints: auth status (unauthenticated requests must get 401), listening addresses for 8888/5432,
and mu-pilot COUNTS ONLY (API stats + SQL row counts). No memory content is read or printed.

Run:  D:\\hindsight\\venv\\Scripts\\python.exe scripts/hindsight/tests/pilot_check.py [--evidence out.json]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import supervisor as sv  # noqa: E402

P = sv.load_profile(HERE.parent / "hindsight.profiles.json", "pilot")
BASE = f"http://127.0.0.1:{P['port']}"
KEY, KEY_SRC = sv.resolve_key(P)
BANK = "mu-pilot"

COUNTS_SQL = f"""
select 'banks', count(*) from banks where bank_id='{BANK}'
union all select 'documents', count(*) from documents where bank_id='{BANK}'
union all select 'chunks', count(*) from chunks where bank_id='{BANK}'
union all select 'memory_units', count(*) from memory_units where bank_id='{BANK}'
union all select 'memory_units_with_embedding', count(*) from memory_units where bank_id='{BANK}' and embedding is not null
union all select 'memory_links', count(*) from memory_links where bank_id='{BANK}'
union all select 'entities', count(*) from entities where bank_id='{BANK}'
union all select 'unit_entities', count(*) from unit_entities ue join memory_units mu on mu.id=ue.unit_id where mu.bank_id='{BANK}'
union all select 'mental_models', count(*) from mental_models where bank_id='{BANK}'
union all select 'async_operations', count(*) from async_operations where bank_id='{BANK}'
union all select 'llm_requests', count(*) from llm_requests where bank_id='{BANK}'
union all select 'audit_log', count(*) from audit_log where bank_id='{BANK}'
union all select 'llm_requests_all_banks', count(*) from llm_requests
union all select 'banks_total', count(*) from banks
"""


def http(method, path, body=None, key=None, headers=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in b"[{" else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def http_base(base, method, path, body=None):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return None, (r.status, json.loads(raw) if raw[:1] in b"[{" else None)
    except urllib.error.HTTPError as e:
        return None, (e.code, None)
    except Exception:
        return None, (None, None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence")
    a = ap.parse_args()
    out: dict = {"port": P["port"], "key_configured": bool(KEY), "key_source": KEY_SRC}
    out["health_no_key"] = http("GET", "/health")[0]
    out["unauthenticated"] = {
        "GET /banks": http("GET", "/v1/default/banks")[0],
        "POST recall": http("POST", f"/v1/default/banks/{BANK}/memories/recall", {"query": "x"})[0],
        "GET stats": http("GET", f"/v1/default/banks/{BANK}/stats")[0],
        # No destructive probe is ever sent to the pilot, even unauthenticated: the synthetic
        # acceptance proves DELETE -> 401 on port 8889.
        "MCP initialize": http("POST", f"/mcp/{BANK}/", {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                                         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                                                    "clientInfo": {"name": "check", "version": "1"}}},
                               headers={"Accept": "application/json, text/event-stream"})[0],
    }
    st, stats = http("GET", f"/v1/default/banks/{BANK}/stats", key=KEY)
    keep = ("total_nodes", "total_links", "total_documents", "total_observations", "pending_operations", "failed_operations")
    out["authenticated_stats"] = {"status": st, **{k: (stats or {}).get(k) for k in keep}}
    out["listeners"] = {str(port): sorted({a for a, _ in sv.listeners(port)}) for port in (P["port"], 5432, P["proxy"]["port"])}
    # Through the client proxy (no key from the caller): READ-ONLY recall on mu-pilot, and a write
    # attempt that must be refused while memory writes are OFF. The write probe targets mu-shared
    # (never mu-pilot) and the proxy refuses it before it reaches Hindsight.
    PX = f"http://127.0.0.1:{P['proxy']['port']}"
    _, rec = http_base(PX, "POST", f"/v1/default/banks/{BANK}/memories/recall", {"query": "M&U Ventures", "max_tokens": 300})
    out["proxy_readonly_recall_mu_pilot"] = {"status": rec[0], "results": len((rec[1] or {}).get("results", []))}
    out["proxy_write_while_off"] = http_base(PX, "POST", "/v1/default/banks/mu-shared/memories",
                                             {"items": [{"content": "probe"}]})[1][0]
    out["proxy_bank_delete_without_approval"] = http_base(PX, "DELETE", f"/v1/default/banks/{BANK}")[1][0]
    try:
        res = sv.app_sql(P, "begin transaction read only;\n" + COUNTS_SQL.strip() + ";\nrollback;\n", sep="=")
        out["sql_counts"] = dict(line.split("=", 1) for line in res.split() if "=" in line)
    except RuntimeError:
        out["sql_counts"] = "psql failed"
    ok = (all(v == 401 for v in out["unauthenticated"].values()) and out["authenticated_stats"]["status"] == 200
          and all(all(x in ("127.0.0.1", "::1") for x in v) and v for v in out["listeners"].values())
          and out["proxy_readonly_recall_mu_pilot"]["status"] == 200 and out["proxy_write_while_off"] == 403
          and out["proxy_bank_delete_without_approval"] == 403)
    out["pass"] = ok
    print(json.dumps(out, indent=2, sort_keys=True))
    if a.evidence:
        Path(a.evidence).write_text(json.dumps(out, indent=2, sort_keys=True), encoding="utf-8", newline="\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
