"""Credential-hygiene test for the patched claude-code provider, with a SYNTHETIC credentials fixture.

A fake home holds .claude/.credentials.json with a random marker (never a real credential).
A child process imports the DEPLOYED provider module (D:\\hindsight\\venv ... claude_code_llm.py),
builds the isolation env the provider hands to the `claude` CLI, simulates the CLI writing session
state into it, and then ends in one of three ways: success, failure (unhandled exception), kill
(TerminateProcess). After each, the test proves:
  * the marker exists in exactly one place: the fixture file itself (no copy anywhere);
  * no hindsight-claude-code-* folder remains under the per-launch temp root (after `kill`, only
    once the supervisor sweep has run -- which is what happens on the next supervisor start);
  * no NEW hindsight-claude-code-* folder appeared in the real %TEMP% (names compared only; the
    pre-existing owner folder there is never opened or touched).

Run:  D:\\hindsight\\venv\\Scripts\\python.exe scripts/hindsight/tests/cred_fixture_test.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import supervisor as sv  # noqa: E402

PY = r"D:\hindsight\venv\Scripts\python.exe"
REAL_TEMP = Path(os.environ.get("TEMP", tempfile.gettempdir()))

CHILD = r'''
import json, os, sys, time
mode = sys.argv[1]
from hindsight_api.engine.providers import claude_code_llm as m
if mode == "noroot":
    try:
        m._get_isolated_claude_env()
    except RuntimeError:
        print(json.dumps({"refused": True}), flush=True)
        sys.exit(0)
    print(json.dumps({"refused": False}), flush=True)
    sys.exit(1)
env = m._get_isolated_claude_env()
d = env["CLAUDE_CONFIG_DIR"]
root = os.environ["HINDSIGHT_CLAUDE_ISOLATION_ROOT"]
assert os.path.commonpath([d, root]) == root, "isolation dir is not under the per-launch root"
assert not os.path.exists(os.path.join(d, ".credentials.json")), "credentials were copied"
assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == "synthetic-token-not-real"
os.makedirs(os.path.join(d, "projects"), exist_ok=True)
with open(os.path.join(d, "projects", "session.jsonl"), "w") as f:
    f.write("synthetic session state\n")  # what the CLI would write
print(json.dumps({"dir": d, "files": sorted(os.listdir(d))}), flush=True)
if mode == "failure":
    raise RuntimeError("synthetic failure")
if mode == "kill":
    print("READY", flush=True)
    time.sleep(120)
'''


def temp_names() -> set[str]:
    return {p.name for p in REAL_TEMP.glob(sv.ISOLATION_PREFIX + "*")}


def files_containing(root: Path, marker: bytes) -> list[str]:
    hits = []
    for p in root.rglob("*"):
        if p.is_file():
            try:
                if marker in p.read_bytes():
                    hits.append(str(p.relative_to(root)))
            except OSError:
                pass
    return hits


def run_case(mode: str, base: Path, marker: bytes) -> dict:
    fake_home = base / "home"
    run_dir = base / f"run-{mode}"
    profile = sv.load_profile(HERE.parent / "hindsight.profiles.json", "synth")
    profile = dict(profile, run_dir=str(run_dir), log_dir=str(base / "logs"))
    s = sv.Supervisor(profile)
    launch = s.tmp_root / f"launch-{mode}"
    launch.mkdir(parents=True)
    fake_temp = base / f"temp-{mode}"  # TEMP deliberately NOT the isolation root (review finding)
    fake_temp.mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if k.upper() in sv.PASS_THROUGH_ENV}
    env.update({"USERPROFILE": str(fake_home), "HOME": str(fake_home), "TEMP": str(fake_temp), "TMP": str(fake_temp),
                "CLAUDE_CODE_OAUTH_TOKEN": "synthetic-token-not-real", "PYTHONUTF8": "1"})
    if mode != "noroot":
        env["HINDSIGHT_CLAUDE_ISOLATION_ROOT"] = str(launch)
    before_temp = temp_names()
    p = subprocess.Popen([PY, "-c", CHILD, mode], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    info_line = p.stdout.readline()
    info = json.loads(info_line) if info_line.strip().startswith("{") else {}
    if mode == "noroot":
        p.wait(120)
        in_temp = [x.name for x in fake_temp.iterdir()]
        ok = info.get("refused") is True and p.returncode == 0 and not in_temp and not list(launch.iterdir()) \
            and sorted(temp_names() - before_temp) == []
        return {"mode": mode, "pass": ok, "refused_without_root": info.get("refused"), "exit_code": p.returncode,
                "created_in_temp": in_temp}
    iso_dir = Path(info["dir"]) if info.get("dir") else None
    during = iso_dir.exists() if iso_dir else False
    if mode == "kill":
        assert p.stdout.readline().strip() == "READY"
        p.kill()  # TerminateProcess: no atexit, no finally
        p.wait(30)
        survived_kill = iso_dir.exists()
        s.sweep()  # what the supervisor does on its next (re)start
    else:
        p.wait(120)
        survived_kill = None
    rc = p.returncode
    stderr_tail = p.stderr.read()[-300:] if mode != "kill" else ""
    leftovers = [str(x) for x in s.tmp_root.rglob(sv.ISOLATION_PREFIX + "*")] + [str(x) for x in fake_temp.rglob(sv.ISOLATION_PREFIX + "*")]
    under_root = iso_dir is not None and launch in iso_dir.parents
    copies = [h for h in files_containing(base, marker) if h != str(Path("home/.claude/.credentials.json"))]
    new_in_temp = sorted(temp_names() - before_temp)
    ok = bool(iso_dir) and under_root and during and not leftovers and not copies and not new_in_temp
    if mode == "success":
        ok = ok and rc == 0
    if mode == "failure":
        ok = ok and rc != 0 and "RuntimeError" in stderr_tail
    if mode == "kill":
        ok = ok and survived_kill is True
    return {"mode": mode, "pass": ok, "exit_code": rc, "isolation_dir_existed_while_running": during,
            "files_in_isolation_dir": info.get("files"), "dir_survived_kill_before_sweep": survived_kill,
            "leftover_isolation_dirs": leftovers, "credential_marker_copies": copies, "new_temp_folders": new_in_temp}


def main() -> int:
    marker = ("SYNTHETIC-FIXTURE-" + uuid.uuid4().hex).encode()
    base = Path(r"D:\hindsight\service\run") / f"credtest-{uuid.uuid4().hex[:8]}"
    (base / "home" / ".claude").mkdir(parents=True)
    (base / "home" / ".claude" / ".credentials.json").write_bytes(b'{"synthetic": "' + marker + b'"}')
    results = [run_case(m, base, marker) for m in ("success", "failure", "kill", "noroot")]
    for r in results:
        print(("PASS " if r["pass"] else "FAIL ") + json.dumps(r, sort_keys=True))
    fixture_hits = files_containing(base, marker)
    only_fixture = fixture_hits == [str(Path("home/.claude/.credentials.json"))]
    print(("PASS " if only_fixture else "FAIL ") + f"marker found only in the fixture itself: {fixture_hits}")
    import shutil
    shutil.rmtree(base, ignore_errors=True)
    ok = all(r["pass"] for r in results) and only_fixture
    print("ALL PASS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
