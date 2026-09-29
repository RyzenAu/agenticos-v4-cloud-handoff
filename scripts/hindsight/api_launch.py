"""Launch the Hindsight API with log scrubbing (M&U, 28 Sep 2026).

The supervisor runs `python api_launch.py` instead of `python -m hindsight_api.main` so that,
before Hindsight imports anything, every log record and every write to stdout/stderr passes
through a scrubber that removes:
  * secrets: the tenant key, the DB password and any *_API_KEY / *_TOKEN value in this
    process's environment (exact-value replacement);
  * credentials inside URIs (postgresql://user:PASSWORD@..., pg0://user:PASSWORD@...), e.g.
    hindsight_api.pg0's "PostgreSQL started: postgresql://..." line;
  * memory content Hindsight logs at INFO: recall/reflect query previews
    (memory_engine "Starting recall for query: ..." and "[RECALL ...] Query: '...'") and the
    mission-merge response preview (retain/bank_utils).
Nothing else about Hindsight changes. Deployed to D:\\hindsight\\service\\api_launch.py.
"""
from __future__ import annotations

import io
import logging
import os
import re
import sys

_SECRET_ENV = re.compile(r"(_API_KEY|_TOKEN|_PASSWORD|_SECRET)$|^HINDSIGHT_API_DATABASE_URL$")
_SECRETS: list[str] = []
for _k, _v in os.environ.items():
    if _SECRET_ENV.search(_k.upper()) and _v and len(_v) >= 8:
        if _k.upper() == "HINDSIGHT_API_DATABASE_URL":
            m = re.match(r"^pg0://[^:@/]*:([^@]+)@", _v)
            if m and len(m.group(1)) >= 8:
                _SECRETS.append(m.group(1))
        else:
            _SECRETS.append(_v)
_SECRETS.sort(key=len, reverse=True)

_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"((?:postgres(?:ql)?|pg0)://[^:/@\s'\"]+:)[^@\s'\"]+@"), r"\1***@"),
    (re.compile(r"(for query: ).*?(\.\.\.)"), r"\1<redacted>\2"),
    (re.compile(r"(\] Query: ')[^\n]*?(\.\.\.')"), r"\1<redacted>\2"),
    (re.compile(r"(\(first \d+ chars\): ).*"), r"\1<redacted>"),
    # reflect agent lines: `query='...'` for the question and for every tool call (review R2 B3)
    (re.compile(r"""(\bquery=)(['"])(?:\\.|(?!\2).)*\2"""), r"\1\2<redacted>\2"),
    (re.compile(r"""(\b(?:text|content|question|answer)=)(['"])(?:\\.|(?!\2).)*\2"""), r"\1\2<redacted>\2"),
]
# Loggers whose INFO/DEBUG lines narrate memory content (the reflect agent's reasoning and tool
# calls): below WARNING their whole message is replaced, whatever its format.
_CONTENT_LOGGERS = ("hindsight_api.engine.reflect",)


def scrub(text: str) -> str:
    if not text:
        return text
    for s in _SECRETS:
        if s in text:
            text = text.replace(s, "<redacted>")
    for pat, repl in _PATTERNS:
        text = pat.sub(repl, text)
    return text


_old_factory = logging.getLogRecordFactory()


def _factory(*args, **kwargs):
    rec = _old_factory(*args, **kwargs)
    try:
        msg = rec.getMessage()
    except Exception:
        return rec
    if rec.levelno < logging.WARNING and rec.name.startswith(_CONTENT_LOGGERS):
        msg = f"[{rec.name.rsplit('.', 1)[-1]} detail suppressed: may contain memory text]"
    rec.msg = scrub(msg)
    rec.args = ()
    return rec


logging.setLogRecordFactory(_factory)


class _ScrubStream(io.TextIOBase):
    def __init__(self, inner):
        self._inner = inner

    def write(self, s):
        return self._inner.write(scrub(s))

    def flush(self):
        return self._inner.flush()

    def isatty(self):
        return False

    def fileno(self):
        return self._inner.fileno()

    @property
    def encoding(self):
        return getattr(self._inner, "encoding", "utf-8")

    def __getattr__(self, name):
        return getattr(self._inner, name)


sys.stdout = _ScrubStream(sys.stdout)
sys.stderr = _ScrubStream(sys.stderr)

if __name__ == "__main__":
    sys.argv = ["hindsight-api"] + sys.argv[1:]
    from hindsight_api.main import main

    main()
