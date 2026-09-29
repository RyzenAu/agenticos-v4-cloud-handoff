"""Backup + restore test on SYNTHETIC data only.

1. Runs backup.ps1 (the same script the SYSTEM task runs) against the synthetic instance into a
   scratch folder, as the current user.
2. Creates a throw-away Postgres cluster (initdb, port 5439, random superuser password held in memory
   only), restores the dump into it, and compares row counts table by table with the source.
3. Stops and deletes the scratch cluster and the scratch dump.
Prints counts only.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import supervisor as sv  # noqa: E402

P = sv.load_profile(Path(r"D:\hindsight\service\hindsight.profiles.json"), "synth")
assert P["db"]["data_dir"].endswith("hindsight-synth")
BIN = Path(P["db"]["bin_dir"])
SCRATCH = Path(r"D:\hindsight\service\run\restore-test")
DUMPS = SCRATCH / "dumps"
CLUSTER = Path(r"D:\hindsight\db\restore-test")
PORT = 5439
TABLES = ["banks", "documents", "chunks", "memory_units", "memory_links", "entities", "unit_entities",
          "llm_requests", "async_operations", "alembic_version"]


def run(args, env=None, stdin=None, timeout=300):
    return sv._run_to_file([str(a) for a in args], env=env, stdin_text=stdin, timeout=timeout)


def counts(port: int, user: str, password: str) -> dict:
    env = {k: v for k, v in os.environ.items() if k.upper() in sv.PASS_THROUGH_ENV}
    env["PGPASSWORD"] = password
    q = " union all ".join(f"select '{t}', count(*) from {t}" for t in TABLES) + ";"
    rc, out = run([BIN / "psql.exe", "-h", "127.0.0.1", "-p", port, "-U", user, "-d", "hindsight", "-X", "-At", "-F", "=",
                   "-c", q], env=env)
    if rc != 0:
        raise RuntimeError("count query failed: " + out[-200:])
    return {k: int(v) for k, v in (line.split("=") for line in out.split() if "=" in line)}


def seed_bank() -> str:
    """Two synthetic documents so the dump has real rows (facts, embeddings, entities, links)."""
    import urllib.request
    bank = "syn-restore-" + secrets.token_hex(3)
    key, _ = sv.resolve_key(P)
    for i, text in enumerate(("The Plover test clinic opens at 7am on Mondays.",
                              "Ada Plover manages the Plover test clinic and prefers SMS.")):
        body = json.dumps({"async": False, "items": [{"content": text, "document_id": f"r-{i}"}]}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{P['port']}/v1/default/banks/{bank}/memories", data=body,
                                     method="POST", headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        urllib.request.urlopen(req, timeout=300).read()
    return bank


def main() -> int:
    shutil.rmtree(SCRATCH, ignore_errors=True)
    DUMPS.mkdir(parents=True)
    bank = seed_bank()
    rc, out = run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                   HERE.parent / "backup.ps1", "-Profile", "synth", "-Port", P["db"]["port"], "-PasswordFile",
                   P["db"]["password_file"], "-OutDir", DUMPS, "-PgBin", BIN, "-KeepDays", 14])
    status = json.loads((DUMPS / "last-backup.json").read_text(encoding="utf-8-sig"))
    print("backup status:", json.dumps({k: status.get(k) for k in ("ok", "bytes", "entries", "note")}))
    if not status.get("ok"):
        return 1
    src = counts(P["db"]["port"], P["db"]["user"], sv.db_password(P))
    pw = secrets.token_hex(16)
    pwfile = SCRATCH / "su.pw"
    sv.write_secret(pwfile, pw)
    shutil.rmtree(CLUSTER, ignore_errors=True)
    ok = False
    try:
        rc, out = run([BIN / "initdb.exe", "-D", CLUSTER, "-U", "postgres", "--pwfile", pwfile, "-A", "scram-sha-256",
                       "-E", "UTF8", "--no-instructions"])
        assert rc == 0, "initdb failed: " + out[-300:]
        pwfile.unlink()
        rc, out = run([BIN / "pg_ctl.exe", "start", "-D", CLUSTER, "-w", "-t", "60", "-l", CLUSTER / "startup.log",
                       "-o", f"-p {PORT} -c listen_addresses=127.0.0.1"])
        assert rc == 0, "scratch cluster did not start"
        env = {k: v for k, v in os.environ.items() if k.upper() in sv.PASS_THROUGH_ENV}
        env["PGPASSWORD"] = pw
        rc, out = run([BIN / "psql.exe", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres", "-X", "-q",
                       "-v", "ON_ERROR_STOP=1"], env=env,
                      stdin=f"CREATE ROLE hindsight LOGIN PASSWORD '{sv.scram_verifier(pw)}';\nCREATE DATABASE hindsight OWNER hindsight;\n")
        assert rc == 0, "role/db create failed: " + out[-200:]
        dump = next(DUMPS.glob("hindsight-*.dump"))
        # The documented restore procedure: extensions are created by the superuser first, then the
        # dump is restored AS the non-superuser app role, so every object ends up owned by it.
        rc, out = run([BIN / "psql.exe", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "hindsight", "-X", "-q",
                       "-v", "ON_ERROR_STOP=1"], env=env,
                      stdin="CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;\n"
                            "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;\n")
        assert rc == 0, "extension create failed: " + out[-200:]
        rc, out = run([BIN / "pg_restore.exe", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "hindsight",
                       "--no-owner", "--no-comments", "--role=hindsight", "--exit-on-error", dump], env=env, timeout=600)
        assert rc == 0, "pg_restore failed: " + out[-300:]
        dst = counts(PORT, "postgres", pw)
        ok = src == dst and src.get("alembic_version", 0) >= 1
        print("source (synth) counts:  ", json.dumps(src, sort_keys=True))
        print("restored scratch counts:", json.dumps(dst, sort_keys=True))
    finally:
        subprocess.run([sys.executable, str(HERE.parent / "supervisor.py"), "admin", "--profile", "synth", "--config",
                        r"D:\hindsight\service\hindsight.profiles.json", "--action", "delete-bank", "--bank", bank,
                        "--confirm", bank], capture_output=True, timeout=300)
        run([BIN / "pg_ctl.exe", "stop", "-D", CLUSTER, "-m", "fast", "-w", "-t", "60"])
        shutil.rmtree(CLUSTER, ignore_errors=True)
        shutil.rmtree(SCRATCH, ignore_errors=True)
    print("RESTORE TEST " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
