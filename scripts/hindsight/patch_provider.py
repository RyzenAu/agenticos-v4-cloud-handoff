#!/usr/bin/env python3
"""Replace the 25 Sep "M&U Ventures local patch" in Hindsight's claude-code provider.

The old patch (v1) copied C:\\Users\\Nebula PC\\.claude\\.credentials.json into a fresh
%TEMP%\\hindsight-claude-code-* folder on every process start and never deleted it.

The current block (v3):
  * copies NOTHING -- auth for the isolated `claude` CLI comes only from CLAUDE_CODE_OAUTH_TOKEN
    (Claude Code's supported token variable, made with `claude setup-token`), which the supervisor
    passes into the API process in memory from an owner-set variable (by reference);
  * creates the isolation dir ONLY under HINDSIGHT_CLAUDE_ISOLATION_ROOT -- the supervisor's
    per-launch, user-only temp dir -- and FAILS CLOSED (raises) when that is unset, so a manual
    run can never fall back to %TEMP% (v2 fell back silently);
  * removes it at interpreter exit; the supervisor removes the whole per-launch dir after the
    process ends, including after a hard kill, and refuses to start if one survives.

Usage:  python patch_provider.py [--check] [--file <path>]
Exit 0 = file is (now) v3; 1 = --check and not v3; 2 = unrecognised file (nothing written).
"""
from __future__ import annotations

import argparse
import hashlib
import py_compile
import sys
from pathlib import Path

DEFAULT_TARGET = Path(r"D:\hindsight\venv\Lib\site-packages\hindsight_api\engine\providers\claude_code_llm.py")

MKDTEMP = '        path = tempfile.mkdtemp(prefix="hindsight-claude-code-")'
V1_START = "M&U Ventures local patch (2026-09-25"
V1_END = "        # --- end local patch ---"
V2_START = "        # --- M&U Ventures local patch v2"
V2_END = "        # --- end local patch v2 ---"
V3_MARKER = "M&U Ventures local patch v3"

V3_BLOCK = [
    "        # --- M&U Ventures local patch v3 (2026-09-28): no credential copies, fail closed ---",
    "        # Replaces the 2026-09-25 patch, which copied ~/.claude/.credentials.json into a",
    "        # %TEMP% folder and never deleted it. Nothing credential-bearing is written here: the",
    "        # isolated CLI authenticates only via CLAUDE_CODE_OAUTH_TOKEN, which the supervisor",
    "        # passes in memory from an owner-set variable. The isolation dir is created ONLY under",
    "        # HINDSIGHT_CLAUDE_ISOLATION_ROOT (the supervisor's per-launch, user-only temp dir);",
    "        # without it this refuses rather than falling back to %TEMP%.",
    "        import atexit",
    "        import os",
    "        import shutil",
    "",
    '        _root = os.environ.get("HINDSIGHT_CLAUDE_ISOLATION_ROOT") or ""',
    "        if not _root or not os.path.isdir(_root):",
    "            raise RuntimeError(",
    '                "claude-code provider: HINDSIGHT_CLAUDE_ISOLATION_ROOT is not an existing directory; "',
    '                "refusing to create an isolation dir in %TEMP% (run Hindsight through its supervisor)"',
    "            )",
    '        path = tempfile.mkdtemp(prefix="hindsight-claude-code-", dir=_root)',
    "        atexit.register(shutil.rmtree, path, True)",
    '        if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):',
    "            logger.warning(",
    '                "Claude Code: CLAUDE_CODE_OAUTH_TOKEN is not set; the isolated CLI will report "',
    "                \"'Not logged in' (no credential file is copied any more)\"",
    "            )",
    "        # --- end local patch v3 ---",
]


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def transform(text: str) -> tuple[str, str]:
    """Return (new_text, previous_state). Raises ValueError if the file is unrecognised."""
    if V3_MARKER in text:
        return text, "v3"
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(nl)
    if any(line.startswith(V2_START) for line in lines):
        start = next(i for i, line in enumerate(lines) if line.startswith(V2_START))
        end = lines.index(V2_END, start)
        state = "v2"
    else:
        try:
            start = lines.index(MKDTEMP)
        except ValueError as e:
            raise ValueError("mkdtemp line not found; unknown provider version") from e
        if V1_START in text:
            try:
                end = lines.index(V1_END, start)
            except ValueError as e:
                raise ValueError("v1 patch start found but not its end marker") from e
            state = "v1"
        else:
            end = start
            state = "upstream"
    new_lines = lines[:start] + V3_BLOCK + lines[end + 1:]
    return nl.join(new_lines), state


def verify(text: str) -> list[str]:
    problems = []
    if V3_MARKER not in text:
        problems.append("v3 marker missing")
    if ".credentials.json" in text.replace("~/.claude/.credentials.json into a", ""):
        problems.append("a .credentials.json reference remains")
    if "shutil.copy(" in text:
        problems.append("shutil.copy remains")
    if "local patch v2" in text or "local patch (2026-09-25" in text:
        problems.append("an older patch block remains")
    return problems


def state_of(path: Path = DEFAULT_TARGET) -> str:
    """'v3' when the deployed provider carries the current patch and nothing older; else a reason."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        return f"unreadable: {type(e).__name__}"
    problems = verify(text)
    return "v3" if not problems else "; ".join(problems)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(DEFAULT_TARGET))
    ap.add_argument("--check", action="store_true", help="report state only; write nothing")
    a = ap.parse_args(argv)
    target = Path(a.file)
    raw = target.read_bytes()
    text = raw.decode("utf-8")
    try:
        new_text, state = transform(text)
    except ValueError as e:
        print(f"unrecognised file: {e}", file=sys.stderr)
        return 2
    print(f"state before: {state}; sha256 before: {sha256(raw)}")
    if a.check:
        return 0 if state == "v3" and not verify(text) else 1
    if state != "v3":
        target.write_bytes(new_text.encode("utf-8"))
    problems = verify(target.read_bytes().decode("utf-8"))
    if problems:
        print("verification failed: " + "; ".join(problems), file=sys.stderr)
        return 3
    py_compile.compile(str(target), doraise=True)
    print(f"state after: v3; sha256 after: {sha256(target.read_bytes())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
