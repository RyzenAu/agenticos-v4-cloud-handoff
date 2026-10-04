"""Acceptance for the client proxy on the SYNTHETIC instance (proxy 8879 -> API 8889). Synthetic data only.

Proves: clients need no key; retain/recall/correct/receipts work through the proxy; retains are
forced synchronous; document deletes need a valid single-use approval token for that exact
request; bank delete/clear are not exposed; dot-segment and encoded-path traversal is refused; writes can be switched off; banks outside the allowlist and non-allowlisted routes are
refused; MCP works through the proxy with no key while delete/clear tools are absent; the API
itself still refuses unauthenticated calls; and no key, DB password or canary text reaches any
log (API logs, proxy log, supervisor events).

Run: D:\\hindsight\\venv\\Scripts\\python.exe scripts/hindsight/tests/proxy_acceptance.py [--evidence out.json]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import proxy as px  # noqa: E402
import supervisor as sv  # noqa: E402

CFG = Path(r"D:\hindsight\service\hindsight.profiles.json")
P = sv.load_profile(CFG, "synth")
assert P["port"] == 8889 and P["db"]["data_dir"].endswith("hindsight-synth"), "synthetic only"
PROXY = f"http://127.0.0.1:{P['proxy']['port']}"
API = f"http://127.0.0.1:{P['port']}"
RUN = uuid.uuid4().hex[:8]
BANK = f"syn-proxy-{RUN}"
results: list[dict] = []
C = httpx.Client(timeout=300)


def check(name, ok, **detail):
    results.append({"check": name, "pass": bool(ok), **detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  {json.dumps(detail, sort_keys=True, default=str)[:400]}" if detail else ""), flush=True)


def sql(q):
    return sv.app_sql(P, q)


def retain(doc, text, **extra):
    body = {"async": True, "items": [{"content": text, "document_id": doc, "context": "synthetic note", **extra}]}
    return C.post(f"{PROXY}/v1/default/banks/{BANK}/memories", json=body)


def recall(q):
    r = C.post(f"{PROXY}/v1/default/banks/{BANK}/memories/recall", json={"query": q, "max_tokens": 600})
    return r.status_code, " ".join(x.get("text", "") for x in (r.json().get("results", []) if r.status_code == 200 else []))


def mcp(session, method, params=None, rid=1, bank=None):
    h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if session:
        h["mcp-session-id"] = session
    body = {"jsonrpc": "2.0", "method": method, **({"id": rid} if rid is not None else {}), **({"params": params} if params else {})}
    r = C.post(f"{PROXY}/mcp/{bank or BANK}/", headers=h, json=body)
    data = None
    if r.headers.get("content-type", "").startswith("text/event-stream"):
        for line in r.text.splitlines():
            if line.startswith("data:"):
                try:
                    data = json.loads(line[5:].strip())
                except ValueError:
                    pass
    elif r.content:
        try:
            data = r.json()
        except ValueError:
            data = None
    return r.status_code, r.headers.get("mcp-session-id"), data


def raw_request(method: str, raw_path: str, body: str | None = None, extra: dict | None = None) -> int:
    """Send the path byte-for-byte (no client-side normalisation) and return the status code."""
    import socket
    data = (body or "").encode()
    extra = dict(extra or {})
    host = extra.pop("Host", f"127.0.0.1:{P['proxy']['port']}")
    head = f"{method} {raw_path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n"
    head += "Content-Type: application/json\r\n" if body else ""
    head += f"Content-Length: {len(data)}\r\n"
    for k, v in (extra or {}).items():
        head += f"{k}: {v}\r\n"
    s = socket.create_connection(("127.0.0.1", P["proxy"]["port"]), timeout=60)
    try:
        s.sendall(head.encode("latin-1") + b"\r\n" + data)
        resp = b""
        while b"\r\n" not in resp:
            chunk = s.recv(4096)
            if not chunk:
                break
            resp += chunk
    finally:
        s.close()
    try:
        return int(resp.split(b" ", 2)[1])
    except Exception:
        return -1


def raw_http10_no_host(raw_path: str) -> int:
    import socket
    s = socket.create_connection(("127.0.0.1", P["proxy"]["port"]), timeout=60)
    try:
        s.sendall(f"GET {raw_path} HTTP/1.0\r\n\r\n".encode())
        resp = s.recv(4096)
    finally:
        s.close()
    try:
        return int(resp.split(b" ", 2)[1])
    except Exception:
        return -1


def writes(state):
    subprocess.run([sys.executable, str(HERE.parent / "supervisor.py"), "writes", "--profile", "synth",
                    "--config", str(CFG), "--state", state], capture_output=True, timeout=60)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence")
    a = ap.parse_args()
    writes("on")

    r = C.get(f"{PROXY}/health")
    check("proxy health (no key sent by the client)", r.status_code == 200, status=r.status_code)
    r = C.get(f"{API}/v1/default/banks")
    check("API itself still refuses a key-less call", r.status_code == 401, status=r.status_code)
    check("caller identity: this process's SID equals the proxy user's SID", px._sid_of_pid(os.getpid()) == px.MY_SID)
    lsass = next((int(l.split(",")[1].strip('"')) for l in subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq lsass.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout.splitlines()
        if l.startswith('"lsass')), None)
    check("caller identity: a process of another account (lsass, SYSTEM) does NOT match", lsass is not None
          and px._sid_of_pid(lsass) != px.MY_SID)

    # capture (client asked async; the proxy forces synchronous)
    r = retain(f"mem-a-{RUN}", f"The Wren{RUN} clinic opens at 8am on Tuesdays.")
    check("retain through the proxy", r.status_code == 200, status=r.status_code)
    payload_rows = int(sql(f"select count(*) from async_operations where bank_id='{BANK}' and task_payload::text ilike '%Wren{RUN}%'") or 0)
    check("retain was forced synchronous (no async payload row holds the text)", payload_rows == 0, rows=payload_rows)
    st, txt = recall(f"When does the Wren{RUN} clinic open?")
    check("recall through the proxy returns the saved fact", st == 200 and f"wren{RUN}".lower() in txt.lower() and "8" in txt, status=st, recalled=txt[:160])
    r = C.get(f"{PROXY}/v1/default/banks/{BANK}/llm-requests")
    rows = r.json().get("items", r.json().get("requests", [])) if r.status_code == 200 else []
    models = sorted({f"{x.get('provider')}/{x.get('model')}" for x in rows}) if isinstance(rows, list) else []
    check("receipt: which model processed the save is readable through the proxy", r.status_code == 200 and bool(models),
          status=r.status_code, models=models)

    # correction 1: replace the document (supersede) -> the old fact is gone
    r = retain(f"mem-a-{RUN}", f"The Wren{RUN} clinic opens at 9:30am on Tuesdays.", update_mode="replace")
    st, txt = recall(f"When does the Wren{RUN} clinic open?")
    check("correction by replace: recall says 9:30, never 8am", r.status_code == 200 and "9:30" in txt and "8am" not in txt.replace("8 am", "8am"),
          status=r.status_code)
    # correction 2: single-memory PATCH through the proxy
    r = retain(f"mem-b-{RUN}", f"The Finch{RUN} courier collects parcels at noon.")
    unit = sql(f"select id from memory_units where bank_id='{BANK}' and document_id='mem-b-{RUN}' limit 1")
    r = C.patch(f"{PROXY}/v1/default/banks/{BANK}/memories/{unit}",
                json={"text": f"The Finch{RUN} courier collects parcels at 3pm.", "reason": "synthetic correction"})
    st, txt = recall(f"When does the Finch{RUN} courier collect parcels?")
    check("single-memory correction (PATCH) through the proxy suppresses the old fact", r.status_code == 200 and "3pm" in txt.replace("3 pm", "3pm")
          and "noon" not in txt.lower(), status=r.status_code)

    # deletion: document deletes only, approval path only, own secret
    path = f"/v1/default/banks/{BANK}/documents/mem-b-{RUN}"
    r = C.delete(PROXY + path)
    check("forget without an approval token -> 403", r.status_code == 403, status=r.status_code)
    secret = Path(P["proxy"]["docdelete_secret_file"]).read_bytes().strip()
    wrong = px.mint_approval(secret, f"ap-{RUN}-x", "DELETE", f"/v1/default/banks/{BANK}/documents/other")
    r = C.delete(PROXY + path, headers={"X-MU-Approval": wrong})
    check("approval token for a different request -> 403", r.status_code == 403, status=r.status_code)
    forged = px.mint_approval(b"not-the-secret", f"ap-{RUN}-f", "DELETE", path)
    r = C.delete(PROXY + path, headers={"X-MU-Approval": forged})
    check("forged approval token -> 403", r.status_code == 403, status=r.status_code)
    tok = px.mint_approval(secret, f"ap-{RUN}-1", "DELETE", path)
    r = C.delete(PROXY + path, headers={"X-MU-Approval": tok})
    left = int(sql(f"select count(*) from memory_units where bank_id='{BANK}' and document_id='mem-b-{RUN}'") or 0)
    st, txt = recall(f"When does the Finch{RUN} courier collect parcels?")
    check("forget WITH a valid approval token deletes the memory (facts gone, recall empty)",
          r.status_code == 200 and left == 0 and f"finch{RUN}".lower() not in txt.lower(), status=r.status_code, facts_left=left)
    r = C.delete(PROXY + path, headers={"X-MU-Approval": tok})
    check("approval token is single-use (replay -> 403)", r.status_code == 403, status=r.status_code)
    for p2 in (f"/v1/default/banks/{BANK}", f"/v1/default/banks/{BANK}/memories"):
        tok2 = px.mint_approval(secret, f"ap-{RUN}-{len(p2)}", "DELETE", p2)
        r = C.delete(PROXY + p2, headers={"X-MU-Approval": tok2})
        check(f"DELETE {p2.replace(BANK, '<bank>')} is not exposed at all, even with a signed token -> 403",
              r.status_code == 403, status=r.status_code)
    for method, p2 in (("GET", f"/v1/default/banks/{BANK}/export"), ("POST", f"/v1/default/banks/{BANK}/import"),
                       ("POST", f"/v1/default/banks/{BANK}/clone"), ("PATCH", f"/v1/default/banks/{BANK}"),
                       ("GET", f"/v1/default/banks/{BANK}/config"),
                       ("DELETE", f"/v1/default/banks/{BANK}/operations/00000000-0000-0000-0000-000000000000"),
                       ("GET", "/docs"), ("GET", "/metrics"), ("GET", "/openapi.json"), ("HEAD", "/health"),
                       ("OPTIONS", "/health"), ("GET", f"/mcp/{BANK}/extra"), ("HEAD", f"/mcp/{BANK}/")):
        r = C.request(method, PROXY + p2)
        check(f"not allowlisted: {method} {p2.replace(BANK, '<bank>')} -> 403", r.status_code == 403, status=r.status_code)
    r = C.post(f"{PROXY}/v1/default/banks/not-allowed-{RUN}/memories/recall", json={"query": "x"})
    check("bank outside the proxy allowlist -> 403", r.status_code == 403, status=r.status_code)
    r = C.get(f"{PROXY}/v1/default/banks/{BANK}/documents?limit=5")
    check("allowed query string on a list route -> 200", r.status_code == 200, status=r.status_code)
    st = raw_request("GET", f"/v1/default/banks/{BANK}/stats?x=%2e%2e")
    check("query string on a route that takes none / encoded query -> refused", st in (400, 403), status=st)

    # ---- review R2 B1: dot-segment / encoding traversal, sent RAW (httpx would normalise them) ----
    victim = f"syn-victim-{RUN}"
    for bank_, doc_ in ((victim, f"v-{RUN}"), (BANK, f"keep-{RUN}")):
        C.post(f"{PROXY}/v1/default/banks/{bank_}/memories",
               json={"items": [{"content": f"The Heron{RUN} depot opens at 6am.", "document_id": doc_}]})
    before = {"victim_docs": int(sql(f"select count(*) from documents where bank_id='{victim}'") or 0),
              "bank_docs": int(sql(f"select count(*) from documents where bank_id='{BANK}'") or 0)}
    writes("off")
    body = json.dumps({"async": True, "items": [{"content": f"Traversal canary Otterly{RUN}", "document_id": f"t-{RUN}"}]})
    dtok = px.mint_approval(secret, f"ap-{RUN}-dot", "DELETE", f"/v1/default/banks/{BANK}/documents/..")
    bs = "\\"
    attacks = [
        ("DELETE", f"/mcp/{BANK}/../../v1/default/banks/{victim}", None, {}),
        ("DELETE", f"/mcp/{BANK}/..%2F..%2Fv1/default/banks/{victim}", None, {}),
        ("DELETE", f"/mcp/{BANK}/../../v1/default/banks/{BANK}/memories", None, {}),
        ("POST", f"/mcp/{BANK}/../../v1/default/banks/zz-hidden-{RUN}/memories", body, {}),
        ("POST", f"/mcp/{BANK}/%2e%2e/%2E%2E/v1/default/banks/ro-b-{RUN}/memories", body, {}),
        ("GET", f"/mcp/{BANK}/../../docs", None, {}),
        ("GET", f"/mcp/{BANK}/../../v1/default/banks/{BANK}/config", None, {}),
        ("DELETE", f"/v1/default/banks/{BANK}/documents/..", None, {"X-MU-Approval": dtok}),
        ("DELETE", f"/v1/default/banks/{BANK}/documents/%2e%2e", None, {}),
        ("DELETE", f"/v1/default/banks/{BANK}/documents/.%2e", None, {}),
        ("GET", f"/v1/default/banks/{BANK}/./stats", None, {}),
        ("GET", f"/v1/default/banks//{BANK}/stats", None, {}),
        ("GET", f"/v1/default/banks/{BANK}/stats/..", None, {}),
        ("GET", f"/v1/default/banks/{BANK}{bs}..{bs}..{bs}docs", None, {}),
        ("GET", f"/v1/default/banks/{BANK}%5c..%5cdocs", None, {}),
        ("GET", f"/v1/default/banks/{BANK}%2fstats", None, {}),
        ("POST", f"/mcp/{BANK}/;/../../v1/default/banks/{BANK}/memories", body, {}),
        ("GET", f"/mcp/{BANK}/..;/..;/docs", None, {}),
        ("DELETE", f"/mcp/{BANK}/...", None, {}),
    ]
    for method, raw, b, extra in attacks:
        st = raw_request(method, raw, b, extra)
        check(f"traversal refused: {method} {raw.replace(BANK, '<bank>').replace(RUN, '<run>')}", st in (400, 403, 404, 405),
              status=st)
    writes("on")
    after = {"victim_docs": int(sql(f"select count(*) from documents where bank_id='{victim}'") or 0),
             "bank_docs": int(sql(f"select count(*) from documents where bank_id='{BANK}'") or 0),
             "hidden_bank": int(sql(f"select count(*) from banks where bank_id in ('zz-hidden-{RUN}', 'ro-b-{RUN}')") or 0),
             "traversal_payloads": int(sql(f"select count(*) from async_operations where task_payload::text ilike '%Otterly{RUN}%'") or 0)}
    check("no traversal had any effect (victim bank intact, bank not cleared, no hidden bank, no payload)",
          after["victim_docs"] == before["victim_docs"] and after["bank_docs"] == before["bank_docs"]
          and after["hidden_bank"] == 0 and after["traversal_payloads"] == 0, before=before, after=after)
    recent = [json.loads(line) for line in Path(P["run_dir"], "proxy.jsonl").read_text(encoding="utf-8").splitlines()[-80:]]
    n_rej = sum(1 for e in recent if e.get("decision") == "reject_noncanonical")
    check("rejections are logged distinctly (decision=reject_noncanonical)", n_rej >= 12, logged=n_rej)

    # ---- R3 re-check: DNS rebinding and browser requests ----
    browserish = [
        ("GET", "/v1/default/banks", {"Host": "evil.example"}, "rebinding Host evil.example"),
        ("GET", "/v1/default/banks", {"Host": f"evil.example:{P['proxy']['port']}"}, "rebinding Host with port"),
        ("GET", "/v1/default/banks", {"Host": "127.0.0.1"}, "Host without the proxy port"),
        ("POST", f"/v1/default/banks/{BANK}/memories/recall", {"Origin": "http://evil.example"}, "Origin present"),
        ("POST", f"/v1/default/banks/{BANK}/memories/recall", {"Origin": "null"}, "Origin null"),
        ("GET", "/v1/default/banks", {"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors"}, "Sec-Fetch-Site + Sec-Fetch-Mode: cors"),
        ("GET", "/v1/default/banks", {"Sec-Fetch-Site": "cross-site"}, "Sec-Fetch-Site cross-site"),
    ]
    for method, raw, hdrs, label in browserish:
        body = json.dumps({"query": "x"}) if method == "POST" else None
        st = raw_request(method, raw, body, hdrs)
        check(f"browser/rebinding refused: {label}", st == 403, status=st)
    st = raw_request("GET", "/v1/default/banks", None, {"Sec-Fetch-Mode": "cors"})
    check("Sec-Fetch-Mode: cors alone (what Node's server-side fetch sends) is allowed", st == 200, status=st)
    st = raw_request("GET", "/v1/default/banks", None, {"Host": f"localhost:{P['proxy']['port']}"})
    check("Host localhost:<port> allowed", st == 200, status=st)
    st = raw_http10_no_host("/v1/default/banks")
    check("HTTP/1.0 with no Host refused", st in (400, 403), status=st)

    # ---- review R2 B3: reflect must not leave its question or tool queries in the logs ----
    r = C.post(f"{PROXY}/v1/default/banks/{BANK}/reflect", json={"query": f"Wombatreflect{RUN} summarise what is known about Heron{RUN}"})
    check("reflect through the proxy", r.status_code == 200, status=r.status_code)

    # MCP through the proxy, no key on the client side
    st, sid, data = mcp(None, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                             "clientInfo": {"name": "proxy-acceptance", "version": "1"}})
    check("MCP initialize through the proxy with no client key", st == 200 and data and "result" in data, status=st)
    mcp(sid, "notifications/initialized", rid=None)
    st, _, data = mcp(sid, "tools/list", rid=2)
    names = sorted(t["name"] for t in (data or {}).get("result", {}).get("tools", []))
    check("MCP tools exclude delete/clear/async retain", st == 200 and names and not set(names) & {"delete_bank", "clear_memories", "delete_document", "retain"},
          tools=names)
    # SUPPORTED behaviour since a1ec9053 (REVIEW-STAGE-D B3): Hindsight's MCP is READ-ONLY. sync_retain,
    # update_memory and invalidate_memory are no longer enabled (HINDSIGHT_API_MCP_ENABLED_TOOLS), so agents
    # save through the AgenticOS memory API; the one save path HERE is REST retain through the proxy
    # (forced synchronous, writes ON, write bank only).
    check("MCP tools/list does not offer sync_retain, update_memory or invalidate_memory (read-only MCP, a1ec9053)",
          st == 200 and bool(names) and not set(names) & {"sync_retain", "update_memory", "invalidate_memory"}, tools=names)
    canary = f"Zebra{RUN}"
    st, _, data = mcp(sid, "tools/call", {"name": "sync_retain", "arguments": {"content": f"The {canary} depot opens at 4am."}}, rid=3)
    res = (data or {}).get("result") or {}
    stored = int(sql(f"select count(*) from memory_units where text ilike '%{canary}%'") or 0)
    check("MCP tools/call sync_retain is refused: HTTP 200 + isError 'Unknown tool' (not enabled upstream), nothing stored",
          st == 200 and res.get("isError") is True and "unknown tool" in json.dumps(res).lower() and stored == 0,
          status=st, is_error=res.get("isError"), stored=stored)
    r = retain(f"mem-lark-{RUN}", f"The Lark{RUN} studio closes at 5pm.")
    lark_rows = int(sql(f"select count(*) from async_operations where bank_id='{BANK}' and task_payload::text ilike '%Lark{RUN}%'") or 0)
    check("supported save path: REST retain through the proxy (writes ON, write bank) -> 200, forced synchronous (no async payload row)",
          r.status_code == 200 and r.json().get("async") is False and lark_rows == 0, status=r.status_code, async_rows=lark_rows)
    st, _, data = mcp(sid, "tools/call", {"name": "recall", "arguments": {"query": f"When does the Lark{RUN} studio close?"}}, rid=4)
    blob = json.dumps(data).lower()
    check("MCP recall finds the REST-saved item with its source (text, document_id and chunk_id)",
          st == 200 and f"lark{RUN}" in blob and f"mem-lark-{RUN}" in blob and f"_mem-lark-{RUN}_0" in blob, status=st)
    r = C.post(f"{PROXY}/v1/default/banks/{BANK}/memories/recall", json={"query": f"When does the Lark{RUN} studio close?", "max_tokens": 600})
    hits = [x for x in (r.json().get("results", []) if r.status_code == 200 else []) if f"lark{RUN}" in x.get("text", "").lower()]
    check("REST recall finds the same item with its source (document_id and chunk_id)",
          r.status_code == 200 and bool(hits) and hits[0].get("document_id") == f"mem-lark-{RUN}"
          and str(hits[0].get("chunk_id", "")).endswith(f"_mem-lark-{RUN}_0"), status=r.status_code,
          document_id=hits[0].get("document_id") if hits else None)
    st, _, data = mcp(sid, "tools/call", {"name": "delete_bank", "arguments": {}}, rid=5)
    check("MCP delete_bank is not callable", st == 200 and ("error" in (data or {}) or (data or {}).get("result", {}).get("isError")), status=st)

    # writes OFF
    writes("off")
    r = retain(f"mem-c-{RUN}", "Synthetic canary should not be stored.")
    st, _, data = mcp(sid, "tools/call", {"name": "sync_retain", "arguments": {"content": "Synthetic canary should not be stored."}}, rid=6)
    st2, _ = recall(f"When does the Wren{RUN} clinic open?")
    err = (data or {}).get("error") or {}
    check("writes OFF: REST retain -> 403, MCP sync_retain -> JSON-RPC error -32001 'memory writes are OFF' (proxy gate), recall still works",
          r.status_code == 403 and err.get("code") == -32001 and "writes are off" in str(err.get("message", "")).lower() and st2 == 200,
          rest=r.status_code, mcp_error=err.get("code"), recall=st2)
    writes("on")

    # clean up with the OPERATOR command (bank delete is never exposed through the proxy)
    for b in (BANK, victim):
        rc = subprocess.run([sys.executable, str(HERE.parent / "supervisor.py"), "admin", "--profile", "synth",
                             "--config", str(CFG), "--action", "delete-bank", "--bank", b, "--confirm", b],
                            capture_output=True, timeout=300).returncode
        check("operator bank delete of a synthetic bank (console CLI)", rc == 0, rc=rc)

    # leak scan: keys, DB password, canary text
    secrets_ = [Path(P["key_file"]).read_text().strip(), Path(P["db"]["password_file"]).read_text().strip(),
                Path(P["db"]["admin_password_file"]).read_text().strip(), secret.decode()]
    hits = []
    for root in (Path(P["log_dir"]), Path(P["run_dir"])):
        for f in root.rglob("*"):
            if f.is_file() and f.suffix not in (".key", ".db") and "tmp" not in f.parts:
                try:
                    txt = f.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if any(s in txt for s in secrets_):
                    hits.append(f"{f.name}:secret")
                words = ("Wren", "Finch", "Lark", "Heron", "Otterly", "Wombatreflect", "Zebra")
                if RUN in txt:
                    for line in txt.splitlines():
                        if RUN in line and any(w + RUN in line for w in words):
                            hits.append(f"{f.name}:canary")
                            break
    check("no key, DB password or canary text in API logs, proxy log or supervisor events", not hits, hits=hits[:10])
    ok = all(r["pass"] for r in results)
    print(f"\n{sum(r['pass'] for r in results)} passed, {sum(not r['pass'] for r in results)} failed")
    if a.evidence:
        Path(a.evidence).write_text(json.dumps({"run": RUN, "results": results}, indent=2), encoding="utf-8", newline="\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
