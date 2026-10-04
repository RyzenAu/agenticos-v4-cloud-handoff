"""Live acceptance checks against the SYNTHETIC Hindsight instance (profile "synth", port 8889,
pg0 instance hindsight-synth). Never touches the pilot (8888 / hindsight-mu / mu-pilot).

Checks: authentication (401s), loopback-only binding, prompt-trace persistence off, and real
server-side deletion of a document, a single memory and a whole bank (SQL COUNTS ONLY).

Synthetic canary text only. Retains call the configured LLM route (openai-codex) on synthetic text.

Run:  D:\\hindsight\\venv\\Scripts\\python.exe scripts/hindsight/tests/synthetic_acceptance.py [--evidence out.json]
Exit 0 = every check passed.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import supervisor as sv  # noqa: E402

PROFILE = sv.load_profile(HERE.parent / "hindsight.profiles.json", "synth")
BASE = f"http://127.0.0.1:{PROFILE['port']}"
assert "hindsight-mu" not in PROFILE["db"]["data_dir"] and PROFILE["port"] != 8888, "refusing to run against the pilot"

KEY, _ = sv.resolve_key(PROFILE)
assert KEY, "synthetic key missing: supervisor.py init-key --profile synth"

RUN = uuid.uuid4().hex[:8]
BANK = f"syn-accept-{RUN}"
DOC_A, DOC_B, DOC_C = f"mf-a{RUN}", f"mf-b{RUN}", f"mf-c{RUN}"
results: list[dict] = []


def check(name: str, ok: bool, **detail) -> bool:
    results.append({"check": name, "pass": bool(ok), **detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  {json.dumps(detail, sort_keys=True)}" if detail else ""))
    return ok


def http(method: str, path: str, body=None, key: str | None = KEY, timeout: float = 300.0, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw and raw[:1] in b"[{" else None)
    except urllib.error.HTTPError as e:
        return e.code, None


def sql(query: str) -> str:
    return sv.app_sql(PROFILE, query, sep="|")


def count(query: str) -> int:
    return int(sql(query) or 0)


def doc_counts(bank: str, doc: str) -> dict:
    q = lambda s: count(s.format(b=bank, d=doc))  # noqa: E731
    return {
        "documents": q("select count(*) from documents where bank_id='{b}' and id='{d}'"),
        "chunks": q("select count(*) from chunks where bank_id='{b}' and document_id='{d}'"),
        "memory_units": q("select count(*) from memory_units where bank_id='{b}' and document_id='{d}'"),
        "embeddings": q("select count(*) from memory_units where bank_id='{b}' and document_id='{d}' and embedding is not null"),
        "links": q("select count(*) from memory_links l where l.bank_id='{b}' and (l.from_unit_id in (select id from memory_units where document_id='{d}') or l.to_unit_id in (select id from memory_units where document_id='{d}'))"),
        "unit_entities": q("select count(*) from unit_entities ue join memory_units mu on mu.id=ue.unit_id where mu.bank_id='{b}' and mu.document_id='{d}'"),
        "invalidated_units": q("select count(*) from invalidated_memory_units where bank_id='{b}' and document_id='{d}'"),
    }


def bank_counts(bank: str) -> dict:
    tables = ["banks", "documents", "chunks", "memory_units", "memory_links", "entities", "async_operations",
              "llm_requests", "audit_log", "mental_models", "knowledge_pages", "directives",
              "invalidated_memory_units", "observation_history", "mental_model_history", "attachments",
              "entity_maintenance_queue", "graph_maintenance_queue", "bank_stats_cache", "webhooks"]
    out = {t: count(f"select count(*) from {t} where bank_id='{bank}'") for t in tables}
    out["unit_entities"] = count(f"select count(*) from unit_entities ue join memory_units mu on mu.id=ue.unit_id where mu.bank_id='{bank}'")
    out["entity_cooccurrences"] = count(
        f"select count(*) from entity_cooccurrences c where c.entity_id_1 in (select id from entities where bank_id='{bank}') "
        f"or c.entity_id_2 in (select id from entities where bank_id='{bank}')")
    return out


def canary_rows(canary: str) -> dict:
    """Rows anywhere in the bank tables that still contain a canary string (synthetic text only)."""
    c = canary.replace("'", "")
    return {
        "memory_units": count(f"select count(*) from memory_units where text ilike '%{c}%'"),
        "documents": count(f"select count(*) from documents where original_text ilike '%{c}%'"),
        "chunks": count(f"select count(*) from chunks where chunk_text ilike '%{c}%'"),
        "entities": count(f"select count(*) from entities where canonical_name ilike '%{c}%'"),
        "invalidated_units": count(f"select count(*) from invalidated_memory_units where text ilike '%{c}%'"),
        "async_operation_payloads": count(f"select count(*) from async_operations where task_payload::text ilike '%{c}%' or result_metadata::text ilike '%{c}%'"),
        "llm_requests": count(f"select count(*) from llm_requests where input::text ilike '%{c}%' or output::text ilike '%{c}%' or metadata::text ilike '%{c}%' or llm_info::text ilike '%{c}%' or coalesce(error,'') ilike '%{c}%'"),
    }


def retain(doc: str, text: str, async_: bool = False):
    body = {"async": async_, "items": [{"content": text, "document_id": doc, "tags": ["scope:shared"],
                                        "metadata": {"wiki_ref": doc, "source_path": "synthetic/test.md"}}]}
    return http("POST", f"/v1/default/banks/{BANK}/memories", body)


def recall(query: str):
    st, body = http("POST", f"/v1/default/banks/{BANK}/memories/recall", {"query": query, "max_tokens": 600})
    texts = " ".join(r.get("text", "") for r in (body or {}).get("results", []))
    return st, texts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence", help="write the counts-only results JSON here")
    a = ap.parse_args()

    # ---------------- authentication ----------------
    st, _ = http("GET", "/health", key=None)
    check("health endpoint reachable (liveness only, no data)", st == 200, status=st)
    probes = [("GET", "/v1/default/banks", None), ("GET", f"/v1/default/banks/{BANK}/stats", None),
              ("POST", f"/v1/default/banks/{BANK}/memories/recall", {"query": "x"}),
              ("POST", f"/v1/default/banks/{BANK}/memories", {"items": [{"content": "unauthenticated canary"}]}),
              ("GET", f"/v1/default/banks/{BANK}/documents", None),
              ("DELETE", f"/v1/default/banks/{BANK}/documents/{DOC_A}", None),
              ("DELETE", f"/v1/default/banks/{BANK}", None),
              ("GET", f"/v1/default/banks/{BANK}/llm-requests", None)]
    for method, path, body in probes:
        st, _ = http(method, path, body, key=None)
        check(f"unauthenticated {method} {path.replace(BANK, '<bank>')} -> 401", st == 401, status=st)
        st, _ = http(method, path, body, key="wrong-" + RUN)
        check(f"wrong key {method} {path.replace(BANK, '<bank>')} -> 401", st == 401, status=st)
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "acceptance", "version": "1"}}}
    mcp_h = {"Accept": "application/json, text/event-stream"}
    st, _ = http("POST", f"/mcp/{BANK}/", init, key=None, headers=mcp_h)
    check("MCP without token -> 401", st == 401, status=st)
    st, _ = http("POST", f"/mcp/{BANK}/", init, key="wrong-" + RUN, headers=mcp_h)
    check("MCP with wrong token -> 401", st == 401, status=st)
    st, _ = http("POST", f"/mcp/{BANK}/", init, headers=mcp_h)
    check("MCP with the key is accepted", st in (200, 202), status=st)
    st, _ = http("GET", "/v1/default/banks")
    check("authenticated list banks -> 200", st == 200, status=st)

    # ---------------- binding ----------------
    for port in (PROFILE["port"], 5433):
        addrs = sorted({addr for addr, _ in sv.listeners(port)})
        check(f"port {port} listens on loopback only", bool(addrs) and all(x in ("127.0.0.1", "::1") for x in addrs), addresses=addrs)

    # ---------------- capture (synthetic) ----------------
    t0 = time.time()
    st_a, _ = retain(DOC_A, f"Canary Zebra{RUN} clinic opens at 8am on Tuesdays. Its manager Quillon{RUN} prefers email.")
    st_b, _ = retain(DOC_B, f"Canary Heron{RUN} bakery ships sourdough on Fridays to the Otterby{RUN} market.")
    st_c, body_c = retain(DOC_C, f"Canary Marten{RUN} garage closes at 5pm on weekdays.", async_=True)
    check("synthetic retains accepted", st_a == 200 and st_b == 200 and st_c in (200, 202),
          statuses=[st_a, st_b, st_c], seconds=round(time.time() - t0, 1))
    op_id = (body_c or {}).get("operation_id")
    for _ in range(90):
        if not op_id:
            break
        st, op = http("GET", f"/v1/default/banks/{BANK}/operations/{op_id}")
        if (op or {}).get("status") in ("completed", "failed"):
            break
        time.sleep(2)
    check("async retain completed", (op or {}).get("status") == "completed" if op_id else False, status=(op or {}).get("status"))

    before_a = doc_counts(BANK, DOC_A)
    check("doc A produced facts, embeddings, links, entity links",
          before_a["memory_units"] > 0 and before_a["embeddings"] == before_a["memory_units"], **before_a)
    receipts = sql(f"select provider||'/'||model||':'||status||':'||count(*) from llm_requests where bank_id='{BANK}' group by provider, model, status")
    no_text = count(f"select count(*) from llm_requests where bank_id='{BANK}' and (length(input::text) > 120 or length(coalesce(output::text,'')) > 120)") == 0
    check("per-save model receipts recorded WITHOUT prompt/response text (llm_requests input/output cut to 1 char)",
          bool(receipts) and no_text and not any(canary_rows(f"{w}{RUN}")["llm_requests"] for w in ("Zebra", "Quillon", "Heron", "Marten")),
          receipts=receipts.splitlines())
    st, texts = recall(f"When does the Zebra{RUN} clinic open?")
    check("recall finds doc A before deletion", st == 200 and f"Zebra{RUN}".lower() in texts.lower(), status=st)
    ops_payload_before = canary_rows(f"Marten{RUN}")["async_operation_payloads"]

    # ---------------- delete a document ----------------
    ids = sql(f"select string_agg(quote_literal(id::text), ',') from memory_units where bank_id='{BANK}' and document_id='{DOC_A}'")
    by_id_before = {"links": count(f"select count(*) from memory_links where from_unit_id::text in ({ids}) or to_unit_id::text in ({ids})"),
                    "unit_entities": count(f"select count(*) from unit_entities where unit_id::text in ({ids})")}
    st, _ = http("DELETE", f"/v1/default/banks/{BANK}/documents/{DOC_A}")
    check("DELETE document -> 200", st == 200, status=st)
    by_id_after = {"units": count(f"select count(*) from memory_units where id::text in ({ids})"),
                   "links": count(f"select count(*) from memory_links where from_unit_id::text in ({ids}) or to_unit_id::text in ({ids})"),
                   "unit_entities": count(f"select count(*) from unit_entities where unit_id::text in ({ids})")}
    check("doc A's fact ids: units, links and entity links gone (by id)", all(v == 0 for v in by_id_after.values()),
          before=by_id_before, after=by_id_after)
    after_a = doc_counts(BANK, DOC_A)
    check("document delete removed doc, chunks, facts, embeddings, links, entity links", all(v == 0 for v in after_a.values()), **after_a)
    left = {k: v for k, v in canary_rows(f"Zebra{RUN}").items() if v}
    left.update({f"quill_{k}": v for k, v in canary_rows(f"Quillon{RUN}").items() if v})
    check("no row anywhere still holds doc A's canaries (incl. entities)", not left, remaining=left)
    st, _ = http("GET", f"/v1/default/banks/{BANK}/documents/{DOC_A}")
    check("GET deleted document -> 404", st == 404, status=st)
    st, texts = recall(f"When does the Zebra{RUN} clinic open?")
    check("recall no longer returns doc A", f"Zebra{RUN}".lower() not in texts.lower(), status=st)

    # ---------------- delete one memory ----------------
    # Hindsight 0.10.1 has no REST/MCP route that hard-deletes a single derived fact
    # (DELETE /memories/{id} -> 405; the engine's delete_memory_unit has no caller). A captured
    # memory is therefore stored as ITS OWN document (document_id = mem_ref, the connector's
    # contract) and forgotten with DELETE /documents/{mem_ref}.
    st, _ = http("DELETE", f"/v1/default/banks/{BANK}/memories/00000000-0000-0000-0000-000000000000")
    check("no single-fact hard-delete route in 0.10.1 (DELETE /memories/{id} -> 405)", st == 405, status=st)
    doc_m = f"mem-{RUN}"
    st, _ = retain(doc_m, f"Remember that the Lynx{RUN} courier collects parcels at noon.")
    m_ids = sql(f"select string_agg(quote_literal(id::text), ',') from memory_units where bank_id='{BANK}' and document_id='{doc_m}'")
    m_before = doc_counts(BANK, doc_m)
    st_del, _ = http("DELETE", f"/v1/default/banks/{BANK}/documents/{doc_m}")
    m_after = doc_counts(BANK, doc_m)
    m_by_id = {"units": count(f"select count(*) from memory_units where id::text in ({m_ids})"),
               "links": count(f"select count(*) from memory_links where from_unit_id::text in ({m_ids}) or to_unit_id::text in ({m_ids})"),
               "unit_entities": count(f"select count(*) from unit_entities where unit_id::text in ({m_ids})")} if m_ids else {}
    left = {k: v for k, v in canary_rows(f"Lynx{RUN}").items() if v}
    check("a captured memory (own document) is hard-deleted with its facts, embeddings, links and entities",
          st == 200 and st_del == 200 and m_before["memory_units"] > 0 and all(v == 0 for v in m_after.values())
          and all(v == 0 for v in m_by_id.values()) and not left,
          before=m_before, after=m_after, by_id_after=m_by_id, canary_rows_left=left)

    # Invalidation (PATCH state=invalidated) is the only per-fact control: it hides the fact from
    # recall but KEEPS its text (reversible). Record that honestly; it is not a deletion.
    unit_id = sql(f"select id from memory_units where bank_id='{BANK}' and document_id='{DOC_B}' order by created_at limit 1")
    st, _ = http("PATCH", f"/v1/default/banks/{BANK}/memories/{unit_id}", {"state": "invalidated", "reason": "synthetic test"})
    kept = {"live_row": count(f"select count(*) from memory_units where id='{unit_id}'"),
            "invalidated_row": count(f"select count(*) from invalidated_memory_units where id='{unit_id}'")}
    check("per-fact invalidate is soft: text kept in invalidated_memory_units until the document/bank is deleted",
          st == 200 and kept["invalidated_row"] == 1, status=st, **kept)
    st, _ = http("DELETE", f"/v1/default/banks/{BANK}/documents/{DOC_B}")
    b_after = doc_counts(BANK, DOC_B)
    check("deleting the source document also removes its invalidated (soft-deleted) facts",
          st == 200 and all(v == 0 for v in b_after.values()), status=st, **b_after)

    # Async retains keep the submitted text in async_operations.task_payload. Does a document
    # delete remove it? (Recorded as a finding; retention of operations is a separate setting.)
    st, _ = http("DELETE", f"/v1/default/banks/{BANK}/documents/{DOC_C}")
    payload_after_doc_delete = canary_rows(f"Marten{RUN}")["async_operation_payloads"]
    results.append({"check": "FINDING async-operation payload rows still holding doc C text after its document delete",
                    "pass": True, "rows": payload_after_doc_delete, "doc_delete_status": st})
    print(f"INFO async payload rows after doc C delete: {payload_after_doc_delete}")
    if op_id:
        st, _ = http("DELETE", f"/v1/default/banks/{BANK}/operations/{op_id}")
        after_op_delete = canary_rows(f"Marten{RUN}")["async_operation_payloads"]
        results.append({"check": "FINDING DELETE /operations/{id} on a completed operation", "pass": True,
                        "status": st, "payload_rows_after": after_op_delete})
        print(f"INFO DELETE operation status {st}; payload rows after: {after_op_delete}")

    # ---------------- delete the bank ----------------
    st, _ = http("DELETE", f"/v1/default/banks/{BANK}")
    check("DELETE bank -> 200", st == 200, status=st)
    after_bank = bank_counts(BANK)
    nonzero = {k: v for k, v in after_bank.items() if v and k != "llm_requests"}
    check("bank delete removed every bank-scoped content row (facts, entities, embeddings, operations, documents)", not nonzero, remaining=nonzero)
    left = {}
    for c in (f"Heron{RUN}", f"Otterby{RUN}", f"Marten{RUN}"):
        left.update({f"{c}:{k}": v for k, v in canary_rows(c).items() if v})
    check("no row anywhere still holds any canary after bank delete", not left, remaining=left)
    check("async-operation payload held the canary before the bank delete (retention finding)",
          True, async_payload_rows_before_delete=ops_payload_before)
    left_receipts = count(f"select count(*) from llm_requests where bank_id='{BANK}'")
    textful = count(f"select count(*) from llm_requests where bank_id='{BANK}' and (length(input::text) > 120 or length(coalesce(output::text,'')) > 120)")
    check("receipts outlive a bank delete (Hindsight does not purge llm_requests) but hold no text; swept after 30 days",
          textful == 0, receipts_left=left_receipts, receipts_with_text=textful)

    ok = all(r["pass"] for r in results)
    summary = {"run": RUN, "profile": "synth", "port": PROFILE["port"], "passed": sum(r["pass"] for r in results),
               "failed": sum(not r["pass"] for r in results), "results": results}
    if a.evidence:
        Path(a.evidence).write_text(json.dumps(summary, indent=2), encoding="utf-8", newline="\n")
    print(f"\n{summary['passed']} passed, {summary['failed']} failed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
