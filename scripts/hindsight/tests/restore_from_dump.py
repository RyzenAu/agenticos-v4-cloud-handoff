"""Verify a REAL backup file by restoring it into a throw-away cluster (never over the live database).

  python restore_from_dump.py <dump file> [--profile pilot]

Creates a scratch cluster (initdb, port 5439, random superuser password held in memory only) under
D:\\hindsight\\db\\restore-verify, creates the role, database and extensions, restores the dump as the
non-superuser app role, compares table row counts with the live database (READ-ONLY transaction),
then stops and DELETES the scratch cluster. Prints counts only.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import supervisor as sv  # noqa: E402

TABLES = ["banks", "documents", "chunks", "memory_units", "memory_links", "entities", "unit_entities",
          "llm_requests", "async_operations", "alembic_version"]
CLUSTER = Path(r"D:\hindsight\db\restore-verify")
PORT = 5439


def run(args, env=None, stdin=None, timeout=600):
    return sv._run_to_file([str(a) for a in args], env=env, stdin_text=stdin, timeout=timeout)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dump")
    ap.add_argument("--profile", default="pilot")
    a = ap.parse_args()
    P = sv.load_profile(Path(r"D:\hindsight\service\hindsight.profiles.json"), a.profile)
    BIN = Path(P["db"]["bin_dir"])
    q = " union all ".join(f"select '{t}', count(*) from {t}" for t in TABLES) + ";"
    live = dict(line.split("=") for line in sv.app_sql(P, "begin transaction read only;\n" + q + "\nrollback;\n", sep="=").split() if "=" in line)
    pw = secrets.token_hex(16)
    shutil.rmtree(CLUSTER, ignore_errors=True)
    CLUSTER.parent.mkdir(parents=True, exist_ok=True)
    pwfile = CLUSTER.parent / "restore-verify.pw"
    startlog = CLUSTER.parent / "restore-verify-startup.log"  # kept outside the cluster so a failure can be read
    sv.write_secret(pwfile, pw)
    env = {k: v for k, v in os.environ.items() if k.upper() in sv.PASS_THROUGH_ENV}
    env["PGPASSWORD"] = pw
    ok = False
    try:
        rc, out = run([BIN / "initdb.exe", "-D", CLUSTER, "-U", "postgres", "--pwfile", pwfile, "-A", "scram-sha-256",
                       "-E", "UTF8", "--no-instructions"])
        pwfile.unlink(missing_ok=True)
        assert rc == 0, "initdb failed"
        rc, _ = run([BIN / "pg_ctl.exe", "start", "-D", CLUSTER, "-w", "-t", "60", "-l", startlog,
                     "-o", f"-p {PORT} -c listen_addresses=127.0.0.1"])
        if rc != 0 and startlog.exists():
            print("scratch cluster startup log (tail):")
            print("".join(startlog.read_text(errors="replace").splitlines(True)[-15:]))
        assert rc == 0, "scratch cluster did not start"
        psql = [BIN / "psql.exe", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"]
        rc, out = run(psql + ["-d", "postgres"], env=env, stdin=f"CREATE ROLE hindsight LOGIN PASSWORD '{sv.scram_verifier(pw)}';\n"
                                                              "CREATE DATABASE hindsight OWNER hindsight;\n")
        assert rc == 0, "role/db create failed"
        rc, out = run(psql + ["-d", "hindsight"], env=env, stdin="CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;\n"
                                                              "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;\n")
        assert rc == 0, "extension create failed"
        rc, out = run([BIN / "pg_restore.exe", "-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "hindsight",
                       "--no-owner", "--no-comments", "--role=hindsight", "--exit-on-error", a.dump], env=env)
        assert rc == 0, "pg_restore failed: " + out.strip()[-200:]
        rc, out = run(psql + ["-d", "hindsight", "-At", "-F", "=", "-c", q], env=env)
        restored = dict(line.split("=") for line in out.split() if "=" in line)
        ok = restored == live
        print("live (read-only) counts:", json.dumps(live, sort_keys=True))
        print("restored scratch counts:", json.dumps(restored, sort_keys=True))
    finally:
        run([BIN / "pg_ctl.exe", "stop", "-D", CLUSTER, "-m", "fast", "-w", "-t", "60"])
        shutil.rmtree(CLUSTER, ignore_errors=True)
        pwfile.unlink(missing_ok=True)
        if ok:
            startlog.unlink(missing_ok=True)
    print("RESTORE FROM REAL BACKUP " + ("PASS (counts identical; scratch cluster deleted)" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
