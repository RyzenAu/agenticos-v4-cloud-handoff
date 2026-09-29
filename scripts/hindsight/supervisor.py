#!/usr/bin/env python3
"""Hindsight supervisor for Windows (M&U Ventures, 28 Sep 2026).

Runs ONE Hindsight API (with its supervisor-managed Postgres and in-process worker) per profile,
keeps it on loopback with API-key auth, restarts it with a bounded backoff, and records
sanitised diagnostics (timestamps, exit codes, error CLASS names -- never content, never keys).

Source of truth: AgenticOS-v4 `scripts/hindsight/` (branch d/hindsight-ops-20260928).
Deployed copy:   D:\\hindsight\\service\\ (deploy.ps1 copies it; never edit the deployed copy).

Commands (run with the Hindsight venv's python.exe):
    supervisor.py run    --profile pilot [--clear-alert]   long-running supervisor
    supervisor.py stop   --profile pilot                   clean shutdown: API first, then Postgres
    supervisor.py status --profile pilot                   sanitised JSON status
    supervisor.py init-key --profile pilot [--rotate]      random key into a user-only file (never printed)
    supervisor.py sweep  --profile pilot                   remove stale per-launch temp dirs; fail loudly
                                                           if a hindsight-claude-code-* dir survives
    supervisor.py clear-alert --profile pilot              remove the crash-loop lock after investigating

Launch it OUTSIDE any Claude/agent session job (processes started from a Claude desktop session die
with that session): Startup\\Hindsight.vbs, the scheduled task, or `hindsightctl.ps1 start` (WMI).

Only the Python standard library + ctypes is used, so the supervisor itself stays small and does
not import Hindsight.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import datetime as _dt
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "hindsight.profiles.json"

ISOLATION_PREFIX = "hindsight-claude-code-"
STILL_ACTIVE = 259
EXIT_OK, EXIT_ALREADY, EXIT_CRASHLOOP, EXIT_PREFLIGHT, EXIT_NO_KEY, EXIT_FOREIGN, EXIT_SECURITY = 0, 0, 3, 4, 5, 6, 7

# Environment passed through to the API. Everything else from the launching user's environment
# (API keys for other tools, tokens, proxies ...) is deliberately NOT inherited.
PASS_THROUGH_ENV = {
    "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "USERNAME", "USERDOMAIN",
    "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "OS", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
    "APPDATA", "LOCALAPPDATA", "PUBLIC", "ALLUSERSPROFILE", "DRIVERDATA",
}

# --------------------------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------------------------


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8", newline="\n")
    os.replace(tmp, path)


_ERROR_CLASS_RE = re.compile(r"(?m)^(?:[A-Za-z_][\w.]*\.)?([A-Z][A-Za-z0-9_]*(?:Error|Exception|Exit|Interrupt|Failure))\b")


def error_class_from_text(text: str) -> str:
    """Return the LAST Python exception class name found in a log tail -- the name only, never the
    message, so diagnostics carry no memory content, paths or secrets."""
    found = _ERROR_CLASS_RE.findall(text or "")
    if not found:
        return "none"
    name = found[-1]
    return name if re.fullmatch(r"[A-Za-z0-9_]{1,80}", name) else "unknown"


def exit_hex(code: int | None) -> str | None:
    if code is None:
        return None
    return "0x%08X" % (code & 0xFFFFFFFF)


def classify_exit(code: int | None) -> str:
    """Human label for common Windows exit codes (no content involved)."""
    if code is None:
        return "unknown"
    c = code & 0xFFFFFFFF
    return {
        0: "clean_exit",
        1: "error_exit_or_taskkill",
        0xFFFFFFFF: "terminated_externally(-1, e.g. Stop-Process/TerminateProcess)",
        0xC000013A: "ctrl_c_or_console_close",
        0x40010004: "debugger_or_logoff_terminate",
        0xC000026B: "dll_init_failed_during_logoff",
        0xC0000005: "access_violation(native crash)",
        0xC0000409: "stack_buffer_overrun/fail_fast(native crash)",
        0xC00000FD: "stack_overflow(native crash)",
        3: "abort()",
    }.get(c, "other")


class Backoff:
    """Bounded restart policy. Three independent limits; hitting ANY stops and alerts:
      * rate:        at most `max_restarts` restarts inside a sliding `window_s`;
      * total:       at most `max_attempts` restarts inside a longer rolling `attempts_window_s`
                     (catches slow cycles such as a 240 s startup hang, which the rate window misses);
      * consecutive: at most `max_consecutive` failed launches in a row -- the count only resets
                     after a launch that stayed up for `stable_uptime_s`.
    """

    def __init__(self, max_restarts: int, window_s: float, delays: list[float], max_attempts: int = 8,
                 attempts_window_s: float = 3600.0, max_consecutive: int = 5, stable_uptime_s: float = 900.0,
                 max_per_day: int = 12):
        self.max_restarts = max_restarts
        self.window_s = window_s
        self.delays = delays or [5]
        self.max_attempts = max_attempts
        self.attempts_window_s = attempts_window_s
        self.max_consecutive = max_consecutive
        self.stable_uptime_s = stable_uptime_s
        self.max_per_day = max_per_day
        self.history: list[float] = []
        self.long_history: list[float] = []
        self.day_history: list[float] = []
        self.consecutive = 0
        self.reason: str | None = None

    def in_window(self, now: float) -> int:
        self.history = [t for t in self.history if now - t < self.window_s]
        return len(self.history)

    def in_long_window(self, now: float) -> int:
        self.long_history = [t for t in self.long_history if now - t < self.attempts_window_s]
        return len(self.long_history)

    def next_delay(self, now: float, uptime_s: float = 0.0) -> float | None:
        """None means a bound is reached (see `reason`): stop and alert. Otherwise the delay."""
        if uptime_s >= self.stable_uptime_s:
            self.consecutive = 0
        self.consecutive += 1
        n = self.in_window(now)
        if n >= self.max_restarts:
            self.reason = f"{n + 1} exits within {int(self.window_s)} s"
            return None
        if self.in_long_window(now) >= self.max_attempts:
            self.reason = f"{self.max_attempts} restarts within {int(self.attempts_window_s)} s"
            return None
        self.day_history = [x for x in self.day_history if now - x < 86400]
        if len(self.day_history) >= self.max_per_day:
            self.reason = f"{self.max_per_day} restarts within 24 h (crashes after long uptimes)"
            return None
        if self.consecutive > self.max_consecutive:
            self.reason = f"{self.consecutive} failed launches in a row without {int(self.stable_uptime_s)} s of stable uptime"
            return None
        self.history.append(now)
        self.long_history.append(now)
        self.day_history.append(now)
        return float(self.delays[min(n, len(self.delays) - 1)])


# --------------------------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------------------------


def load_profile(config_path: Path, name: str) -> dict:
    raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
    defaults = raw.get("defaults", {})
    profiles = raw.get("profiles", {})
    if name not in profiles:
        raise SystemExit(f"unknown profile '{name}' (have: {', '.join(sorted(profiles))})")

    def merge(a: dict, b: dict) -> dict:
        out = dict(a)
        for k, v in b.items():
            out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
        return out

    p = merge(defaults, profiles[name])
    p["name"] = name
    p["_config_path"] = str(Path(config_path).resolve())
    host = p.get("host", "127.0.0.1")
    if host not in ("127.0.0.1", "::1"):
        raise SystemExit(f"profile '{name}': host must be loopback (127.0.0.1 or ::1), got {host!r}")
    for key in ("run_dir", "log_dir", "home_dir", "hf_home", "key_file", "python_exe"):
        if key in p and p[key]:
            p[key] = str(Path(os.path.expandvars(p[key])))
    if p.get("db"):
        for key in ("bin_dir", "data_dir", "password_file", "admin_password_file"):
            if p["db"].get(key):
                p["db"][key] = str(Path(os.path.expandvars(p["db"][key])))
    return p


def resolve_key(profile: dict, env: dict | None = None) -> tuple[str | None, str]:
    """The API key, by reference: the env var NAMED in the profile (default HINDSIGHT_API_KEY) if it
    is set, otherwise the user-only key file. Returns (key, source-label). Never logs the key."""
    env = os.environ if env is None else env
    name = profile.get("api_key_env", "HINDSIGHT_API_KEY")
    val = (env.get(name) or "").strip()
    if val:
        return val, f"env:{name}"
    kf = Path(profile["key_file"])
    if kf.is_file():
        val = kf.read_text(encoding="utf-8").strip()
        if val:
            return val, "file"
    return None, "missing"


def _env_file_value(path: str, name: str) -> str | None:
    """Value of NAME in a KEY=VALUE env file, read in memory only (never logged)."""
    try:
        text = Path(os.path.expandvars(path)).read_text(encoding="utf-8-sig")
    except OSError:
        return None
    for line in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$", line)
        if m and m.group(1) == name:
            v = m.group(2).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                v = v[1:-1]
            return v or None
    return None


def _user_registry_env(name: str) -> str | None:
    """HKCU\\Environment value: user env vars set after this process's parent started (or when
    launched through WMI) are not always in os.environ."""
    if not IS_WIN:
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            v, _ = winreg.QueryValueEx(k, name)
            return str(v) or None
    except OSError:
        return None


def resolve_secret(ref: dict | None, env: dict | None = None) -> str | None:
    """A secret BY REFERENCE: {"env": NAME[, "file": path]} -> process env, then the user's
    registry environment, then the named env file. The value is returned, never logged."""
    if not ref:
        return None
    use_registry = env is None  # an explicit env (tests) is authoritative for env/registry lookups
    env = os.environ if env is None else env
    name = ref.get("env")
    if name:
        v = (env.get(name) or "").strip() or ((_user_registry_env(name) or "").strip() if use_registry else "")
        if v:
            return v
        if ref.get("file"):
            v = (_env_file_value(ref["file"], name) or "").strip()
            if v:
                return v
    return None


def llm_chain(profile: dict, env: dict | None = None) -> tuple[list[dict], list[dict]]:
    """(active members, skipped members). Members come from profile["llm"]["chain"] (primary
    first) or, for older profiles, the single profile["llm"]. A member whose key reference does
    not resolve is SKIPPED (recorded by name), so one missing key never stops the service."""
    llm = profile["llm"]
    members = llm.get("chain") or [llm]
    active, skipped = [], []
    for m in members:
        m = dict(m)
        if m.get("api_key_ref"):
            key = resolve_secret(m["api_key_ref"], env)
            if not key:
                skipped.append({"provider": m["provider"], "model": m.get("model"), "why": "key reference not set"})
                continue
            m["_api_key"] = key
        active.append(m)
    return active, skipped


def _member_env(prefix: str, m: dict) -> dict:
    out = {prefix + "PROVIDER": m["provider"]}
    if m.get("model"):
        out[prefix + "MODEL"] = m["model"]
    if m.get("_api_key"):
        out[prefix + "API_KEY"] = m["_api_key"]
    if m.get("base_url"):
        out[prefix + "BASE_URL"] = m["base_url"]
    if m.get("codex_home"):
        out[prefix + "CODEX_HOME"] = m["codex_home"]
    if m.get("extra_body") is not None:
        out[prefix + "EXTRA_BODY"] = json.dumps(m["extra_body"])
    if m.get("timeout"):
        out[prefix + "TIMEOUT"] = str(m["timeout"])
    if m.get("max_retries") is not None:
        out[prefix + "MAX_RETRIES"] = str(m["max_retries"])
    return out


def _read_secret_file(f: str | None) -> str | None:
    if f and Path(f).is_file():
        v = Path(f).read_text(encoding="utf-8").strip()
        return v or None
    return None


def db_password(profile: dict) -> str | None:
    """The APP role's password (user-only file). Never logged."""
    return _read_secret_file((profile.get("db") or {}).get("password_file") or profile.get("db_password_file"))


def db_admin_password(profile: dict) -> str | None:
    """The `postgres` superuser's password: a SEPARATE user-only file, used only by operator
    commands on this console (harden-db, backups), never by the API."""
    return _read_secret_file((profile.get("db") or {}).get("admin_password_file"))


def database_url(profile: dict) -> str:
    """postgresql://<app role>:<pw>@127.0.0.1:<port>/<db> for the supervisor-managed Postgres.
    Built in memory only; api_launch.py scrubs it from every log line."""
    db = profile.get("db")
    if not db:
        return profile.get("database_url", "postgresql://127.0.0.1:1/unused")
    pw = db_password(profile) or ""
    return f"postgresql://{db.get('user', 'hindsight')}:{pw}@127.0.0.1:{int(db['port'])}/{db.get('name', 'hindsight')}"


def build_api_env(profile: dict, key: str, launch_tmp: Path, base_env: dict | None = None) -> dict:
    base_env = os.environ if base_env is None else base_env
    env: dict[str, str] = {}
    for k, v in base_env.items():
        if k.upper() in PASS_THROUGH_ENV:
            env[k.upper()] = v
    home = profile["home_dir"]
    env.update({
        # Python-side home lookups follow these, so they stay on D:.
        "USERPROFILE": home,
        "HOME": home,
        "TEMP": str(launch_tmp),
        "TMP": str(launch_tmp),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HF_HOME": profile["hf_home"],
        "HINDSIGHT_API_HOST": profile.get("host", "127.0.0.1"),
        "HINDSIGHT_API_PORT": str(profile["port"]),
        "HINDSIGHT_API_DATABASE_URL": database_url(profile),
        # Authentication: API-key tenant extension for REST and MCP, plus the MCP bearer token.
        "HINDSIGHT_API_TENANT_EXTENSION": "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension",
        "HINDSIGHT_API_TENANT_API_KEY": key,
        "HINDSIGHT_API_MCP_AUTH_TOKEN": key,
        # Where the (patched) claude-code provider puts its isolation dir: inside this launch's
        # user-only temp dir, which the supervisor deletes after the process ends.
        "HINDSIGHT_CLAUDE_ISOLATION_ROOT": str(launch_tmp),
    })
    if profile.get("hf_offline", True):
        env["HF_HUB_OFFLINE"] = "1"
    llm = profile["llm"]
    active, _skipped = llm_chain(profile, base_env)
    if not active:
        raise SystemExit("no usable LLM member: every key reference in the chain is unset")
    # Member 0 is Hindsight's unindexed primary; the rest are HINDSIGHT_API_LLM_<n>_* failover
    # members tried in order (HINDSIGHT_API_LLM_STRATEGY mode "failover").
    env.update(_member_env("HINDSIGHT_API_LLM_", active[0]))
    for i, m in enumerate(active[1:], start=1):
        env.update(_member_env(f"HINDSIGHT_API_LLM_{i}_", m))
    if len(active) > 1:
        env["HINDSIGHT_API_LLM_STRATEGY"] = json.dumps(llm.get("strategy") or {"mode": "failover"})
    if any(m["provider"] == "claude-code" for m in active):
        token_env = llm.get("claude_oauth_token_env", "MU_HINDSIGHT_CLAUDE_OAUTH_TOKEN")
        token = (base_env.get(token_env) or "").strip()
        if token:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = token  # passed in memory only; never written or logged
    for k, v in (profile.get("api_env") or {}).items():
        if not k.startswith("HINDSIGHT_API_"):
            raise SystemExit(f"api_env may only set HINDSIGHT_API_* names, got {k}")
        if k in ("HINDSIGHT_API_TENANT_API_KEY", "HINDSIGHT_API_MCP_AUTH_TOKEN", "HINDSIGHT_API_HOST") \
                or re.match(r"HINDSIGHT_API_LLM_(\d+_)?(PROVIDER|MODEL|API_KEY|BASE_URL|CODEX_HOME)$", k) \
                or k == "HINDSIGHT_API_LLM_STRATEGY":
            raise SystemExit(f"{k} is managed by the supervisor and may not be set in api_env")
        env[k] = str(v)
    return env


# --------------------------------------------------------------------------------------------
# Win32 bits (ctypes)
# --------------------------------------------------------------------------------------------

IS_WIN = sys.platform == "win32"
if IS_WIN:
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    u32 = ctypes.WinDLL("user32", use_last_error=True)
    k32.CreateMutexW.restype = wt.HANDLE
    k32.CreateMutexW.argtypes = [ctypes.c_void_p, wt.BOOL, wt.LPCWSTR]
    k32.OpenMutexW.restype = wt.HANDLE
    k32.OpenMutexW.argtypes = [wt.DWORD, wt.BOOL, wt.LPCWSTR]
    k32.CreateEventW.restype = wt.HANDLE
    k32.CreateEventW.argtypes = [ctypes.c_void_p, wt.BOOL, wt.BOOL, wt.LPCWSTR]
    k32.OpenEventW.restype = wt.HANDLE
    k32.OpenEventW.argtypes = [wt.DWORD, wt.BOOL, wt.LPCWSTR]
    k32.SetEvent.argtypes = [wt.HANDLE]
    k32.ResetEvent.argtypes = [wt.HANDLE]
    k32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
    k32.WaitForSingleObject.restype = wt.DWORD
    k32.CloseHandle.argtypes = [wt.HANDLE]
    k32.OpenProcess.restype = wt.HANDLE
    k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    k32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
    k32.GetProcessTimes.argtypes = [wt.HANDLE] + [ctypes.POINTER(wt.FILETIME)] * 4
    k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
    k32.GenerateConsoleCtrlEvent.argtypes = [wt.DWORD, wt.DWORD]
    k32.GetConsoleWindow.restype = wt.HWND
    HANDLER_ROUTINE = ctypes.WINFUNCTYPE(wt.BOOL, wt.DWORD)
    k32.SetConsoleCtrlHandler.argtypes = [HANDLER_ROUTINE, wt.BOOL]
    k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    k32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.c_void_p]
    k32.Process32NextW.argtypes = [wt.HANDLE, ctypes.c_void_p]

SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
EVENT_MODIFY_STATE = 0x0002
CTRL_BREAK_EVENT = 1
WAIT_OBJECT_0, WAIT_TIMEOUT = 0, 0x102


def resource_id(profile: dict) -> str:
    """Port-based id (stop event, window class)."""
    return f"port{int(profile['port'])}"


def db_resource(profile: dict) -> str | None:
    db = profile.get("db")
    if not db:
        return None
    import hashlib
    return "db-" + hashlib.sha256(str(Path(db["data_dir"]).resolve()).lower().encode()).hexdigest()[:16]


def mutex_names(profile: dict) -> list[str]:
    """TWO independent locks: the API port and the database directory. Two profiles that share
    either one can never run side by side (review R2 item 6)."""
    names = [f"Local\\MU-Hindsight-Supervisor-{resource_id(profile)}"]
    if db_resource(profile):
        names.append(f"Local\\MU-Hindsight-Supervisor-{db_resource(profile)}")
    return names


def mutex_name(profile: dict) -> str:
    return mutex_names(profile)[0]


def stop_event_name(profile: dict) -> str:
    return f"Local\\MU-Hindsight-Supervisor-Stop-{resource_id(profile)}"


def supervisor_running(profile: dict) -> bool:
    for name in mutex_names(profile):
        h = k32.OpenMutexW(SYNCHRONIZE, False, name)
        if h:
            k32.CloseHandle(h)
            return True
    return False


def open_process(pid: int):
    return k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid)


def process_alive(pid: int) -> bool:
    h = open_process(pid)
    if not h:
        return False
    try:
        code = wt.DWORD()
        k32.GetExitCodeProcess(h, ctypes.byref(code))
        return code.value == STILL_ACTIVE
    finally:
        k32.CloseHandle(h)


def process_create_time(pid: int) -> int | None:
    h = open_process(pid)
    if not h:
        return None
    try:
        c, e, k, u = wt.FILETIME(), wt.FILETIME(), wt.FILETIME(), wt.FILETIME()
        if not k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(k), ctypes.byref(u)):
            return None
        return (c.dwHighDateTime << 32) | c.dwLowDateTime
    finally:
        k32.CloseHandle(h)


def process_image(pid: int) -> str | None:
    h = open_process(pid)
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if not k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return None
        return buf.value
    finally:
        k32.CloseHandle(h)


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


def parent_pid(pid: int) -> int | None:
    """Parent PID from a Toolhelp snapshot (the venv's python.exe is a redirector: the process that
    owns the listening socket is the CHILD of the process the supervisor started)."""
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snap in (None, 0, ctypes.c_void_p(-1).value):
        return None
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.th32ProcessID == pid:
                return int(entry.th32ParentProcessID)
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
        return None
    finally:
        k32.CloseHandle(snap)


def process_cmdline(pid: int) -> str:
    """Command line of another process (CIM). Used only to recognise Hindsight processes."""
    try:
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"],
            capture_output=True, text=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return (out.stdout or "").strip()
    except Exception:
        return ""


def listeners(port: int) -> list[tuple[str, int]]:
    """(local address, pid) for every TCP listener on `port`, IPv4 and IPv6."""
    found: list[tuple[str, int]] = []
    for proto in ("TCP", "TCPv6"):
        try:
            out = subprocess.run(["netstat", "-ano", "-p", proto], capture_output=True, text=True, timeout=30,
                                 creationflags=subprocess.CREATE_NO_WINDOW).stdout
        except Exception:
            continue
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[0].upper().startswith("TCP") and parts[3].upper() == "LISTENING":
                addr, _, p = parts[1].rpartition(":")
                if p == str(port):
                    try:
                        found.append((addr.strip("[]"), int(parts[4])))
                    except ValueError:
                        pass
    return found


CODEX_GROUP = "CodexSandboxUsers"
# Folders that hold data, secrets, logs or code the supervisor runs: each carries its OWN explicit
# deny for the Codex sandbox group, so a Codex workspace grant on a parent cannot override it.
PROTECTED_DIRS = [r"D:\hindsight", r"D:\hindsight\db", r"D:\hindsight\service", r"D:\hindsight\service\secrets",
                  r"D:\hindsight\service\run", r"D:\hindsight\_backups", r"D:\hindsight\logs", r"D:\hindsight\venv",
                  r"D:\hindsight\pgsql", r"D:\hindsight\home", r"D:\hindsight\pg0-home", r"D:\hindsight\onnx-cache"]


def _codex_sid():
    try:
        import win32security
        return win32security.LookupAccountName(None, CODEX_GROUP)[0]
    except Exception:
        return None


def codex_allow_entries(path: str) -> tuple[int, bool]:
    """(number of EXPLICIT allow ACEs for the Codex sandbox group, has explicit deny) on one object."""
    import win32security
    sid = _codex_sid()
    if sid is None:
        return 0, False
    sd = win32security.GetNamedSecurityInfo(path, win32security.SE_FILE_OBJECT, win32security.DACL_SECURITY_INFORMATION)
    dacl = sd.GetSecurityDescriptorDacl()
    allows, deny = 0, False
    for i in range(dacl.GetAceCount() if dacl else 0):
        (ace_type, flags), _mask, ace_sid = dacl.GetAce(i)
        if ace_sid != sid or flags & 0x10:  # INHERITED_ACE
            continue
        if ace_type == 0:  # ACCESS_ALLOWED_ACE_TYPE
            allows += 1
        elif ace_type == 1:  # ACCESS_DENIED_ACE_TYPE
            deny = True
    return allows, deny


def codex_acl_guard(root: str = r"D:\hindsight", fix: bool = True) -> dict:
    """Find every object under `root` that carries an EXPLICIT allow for the Codex sandbox group (the
    Codex CLI/app adds one to its workspace folder, which would override an inherited deny) and remove
    those allow entries; then make sure every protected folder has its own explicit deny."""
    r = subprocess.run(["icacls", root, "/findsid", CODEX_GROUP, "/T", "/C", "/Q"], capture_output=True, text=True,
                       timeout=900, creationflags=subprocess.CREATE_NO_WINDOW)
    found = [m.group(1) for m in re.finditer(r"SID Found: (.+?)\.\s*$", r.stdout or "", re.M)]
    removed, flagged = [], []
    for path in found:
        try:
            allows, _ = codex_allow_entries(path)
        except Exception:
            continue
        if allows:
            flagged.append(path)
            if fix:
                subprocess.run(["icacls", path, "/remove:g", CODEX_GROUP, "/C", "/Q"], capture_output=True,
                               timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
                if codex_allow_entries(path)[0] == 0:
                    removed.append(path)
    denied_added = []
    for d in PROTECTED_DIRS:
        if not d.lower().startswith(root.lower()) or not Path(d).exists():
            continue
        try:
            if not codex_allow_entries(d)[1]:
                if fix:
                    subprocess.run(["icacls", d, "/deny", f"{CODEX_GROUP}:(OI)(CI)(F)", "/C", "/Q"], capture_output=True,
                                   timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
                denied_added.append(d)
        except Exception:
            continue
    return {"objects_with_codex_ace": len(found), "explicit_allow_found": flagged, "allow_removed": removed,
            "deny_added": denied_added}


def kill_tree(pid: int) -> None:
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=60,
                   creationflags=subprocess.CREATE_NO_WINDOW)


def restrict_acl(path: Path) -> bool:
    """Owner + SYSTEM ACL: remove inheritance, grant the current user and SYSTEM full control only.
    SYSTEM is needed by the nightly backup task (it reads the app DB password); the Codex sandbox deny
    (an explicit deny entry) is kept."""
    user = f"{os.environ.get('USERDOMAIN', '')}\\{os.environ.get('USERNAME', '')}".strip("\\")
    inh = "(OI)(CI)" if path.is_dir() else ""
    r = subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:{inh}F", f"*S-1-5-18:{inh}F"],
                       capture_output=True, text=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
    return r.returncode == 0


# --------------------------------------------------------------------------------------------
# Postgres (managed by the supervisor with pg_ctl; data under D:\hindsight\db)
# --------------------------------------------------------------------------------------------


def _run_to_file(args: list[str], env: dict | None = None, stdin_text: str | None = None,
                 timeout: int = 180) -> tuple[int, str]:
    """Run a tool with stdio in a temp FILE (pg_ctl start leaves Postgres holding inherited handles,
    which would hang a pipe reader). Output is scrubbed of URI passwords and never printed raw."""
    import tempfile
    with tempfile.TemporaryFile() as out:
        r = subprocess.run(args, input=(stdin_text.encode() if stdin_text is not None else None),
                           stdin=None if stdin_text is not None else subprocess.DEVNULL, stdout=out, stderr=out,
                           env=env, timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW)
        out.seek(0)
        text = out.read().decode("utf-8", "replace")
    return r.returncode, re.sub(r"((?:postgres(?:ql)?|pg0)://[^:/@\s]+:)[^@\s]+@", r"\1***@", text)


def _pg_bin(profile: dict, exe: str) -> str:
    return str(Path(profile["db"]["bin_dir"]) / exe)


def pg_state(profile: dict) -> str:
    """'running' / 'stopped' / 'missing' / 'unmanaged' for the profile's Postgres data dir."""
    db = profile.get("db")
    if not db:
        return "unmanaged"
    if not (Path(db["data_dir"]) / "PG_VERSION").exists():
        return "missing"
    rc, _ = _run_to_file([_pg_bin(profile, "pg_ctl.exe"), "status", "-D", db["data_dir"]], timeout=60)
    return "running" if rc == 0 else "stopped"


def pg_start(profile: dict) -> tuple[int, str]:
    """Start Postgres on 127.0.0.1/::1 only. fsync stays ON (pg0 ran it with -F, fsync OFF)."""
    db = profile["db"]
    opts = [f"-p {int(db['port'])}", "-c listen_addresses=127.0.0.1,::1"] + [f"-c {o}" for o in db.get("options", [])]
    return _run_to_file([_pg_bin(profile, "pg_ctl.exe"), "start", "-D", db["data_dir"], "-w", "-t", "120",
                         "-l", str(Path(db["data_dir"]) / "log" / "pg_ctl.log"), "-o", " ".join(opts)], timeout=180)


def pg_stop(profile: dict, timeout: int = 60) -> int:
    db = profile.get("db")
    if not db:
        return 0
    rc, _ = _run_to_file([_pg_bin(profile, "pg_ctl.exe"), "stop", "-D", db["data_dir"], "-m", "fast", "-w",
                          "-t", str(timeout)], timeout=timeout + 30)
    return rc


def psql(profile: dict, sql_text: str, user: str = "postgres", password: str | None = None,
         database: str | None = None, at: bool = True, sep: str | None = None) -> tuple[int, str]:
    """psql against the managed Postgres; the password goes in the child's environment only."""
    db = profile["db"]
    env = {k: v for k, v in os.environ.items() if k.upper() in PASS_THROUGH_ENV}
    env["PGPASSWORD"] = password if password is not None else (db_admin_password(profile) or "")
    args = [_pg_bin(profile, "psql.exe"), "-h", "127.0.0.1", "-p", str(int(db["port"])), "-U", user,
            "-d", database or db.get("name", "hindsight"), "-X", "-q", "-v", "ON_ERROR_STOP=1"] + (["-At"] if at else [])         + (["-F", sep] if sep else [])
    return _run_to_file(args, env=env, stdin_text=sql_text, timeout=120)


# --------------------------------------------------------------------------------------------
# the supervisor
# --------------------------------------------------------------------------------------------


class LoudError(RuntimeError):
    pass


class StartFailure(RuntimeError):
    """A launch attempt failed before the API ran; counts against the restart bounds."""


class Supervisor:
    def __init__(self, profile: dict):
        self.p = profile
        self.run_dir = Path(profile["run_dir"])
        self.log_dir = Path(profile["log_dir"])
        self.tmp_root = self.run_dir / "tmp"
        self.events_path = self.run_dir / "events.jsonl"
        self.status_path = self.run_dir / "status.json"
        self.lock_path = self.run_dir / "crashloop.lock"
        self.api_meta_path = self.run_dir / "api.json"
        self.port = int(profile["port"])
        self.health = profile.get("health", {})
        r = profile.get("restart", {})
        self.backoff = Backoff(int(r.get("max_restarts", 5)), float(r.get("window_s", 600)),
                               [float(x) for x in r.get("backoff_s", [5, 10, 20, 40, 80])],
                               max_attempts=int(r.get("max_attempts", 8)),
                               attempts_window_s=float(r.get("attempts_window_s", 3600)),
                               max_consecutive=int(r.get("max_consecutive", 5)),
                               stable_uptime_s=float(r.get("stable_uptime_s", 900)),
                               max_per_day=int(r.get("max_per_day", 12)))
        self.proxy_proc: subprocess.Popen | None = None
        self.proxy_restarts: list[float] = []
        self._shutdown_lock = threading.Lock()
        self._last_guard = time.monotonic()
        self.session_ending = False
        self.key: str | None = None
        self.key_source = "missing"
        self.proc: subprocess.Popen | None = None
        self.adopted_pid: int | None = None
        self.adopted_healthy = False
        self.launch_id: str | None = None
        self.launch_tmp: Path | None = None
        self.api_started: float | None = None
        self.stop_event = None
        self.last_exit: dict | None = None
        self.state = "starting"
        self._stopping = False

    def llm_summary(self) -> dict:
        """Provider/model NAMES of the failover chain (never keys)."""
        active, skipped = llm_chain(self.p)
        return {"llm_chain": [f"{m['provider']}/{m.get('model') or 'default'}" for m in active],
                "llm_skipped": [f"{m['provider']}/{m.get('model') or 'default'}" for m in skipped]}

    # ---- diagnostics (sanitised) ----
    def event(self, name: str, **fields) -> None:
        rec = {"ts": now_iso(), "event": name, "profile": self.p["name"], **fields}
        self.run_dir.mkdir(parents=True, exist_ok=True)
        line = json.dumps(rec, sort_keys=True)
        if self.key and self.key in line:  # defence in depth: a key must never reach a log
            line = json.dumps({"ts": rec["ts"], "event": name, "redacted": True})
        try:
            if self.events_path.exists() and self.events_path.stat().st_size > 5 * 1024 * 1024:
                self.events_path.replace(self.events_path.with_suffix(".1.jsonl"))
        except OSError:
            pass
        with open(self.events_path, "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")

    def write_status(self, **extra) -> None:
        data = {
            "profile": self.p["name"],
            "state": self.state,
            "updated_at": now_iso(),
            "supervisor_pid": os.getpid(),
            "host": self.p.get("host", "127.0.0.1"),
            "port": self.port,
            "api_pid": self.proc.pid if self.proc else self.adopted_pid,
            "adopted": self.adopted_pid is not None,
            "launch_id": self.launch_id,
            "auth": {"tenant_api_key": bool(self.key), "mcp_token": bool(self.key), "key_source": self.key_source},
            "llm": self.llm_summary(),
            "restarts_in_window": self.backoff.in_window(time.monotonic()),
            "restart_bound": {"max_restarts": self.backoff.max_restarts, "window_s": self.backoff.window_s},
            "last_exit": self.last_exit,
            "alert": self.lock_path.exists(),
        }
        data.update(extra)
        atomic_write_json(self.status_path, data)

    # ---- isolation temp dirs (credential hygiene) ----
    def sweep(self) -> None:
        """Delete every per-launch temp dir left by earlier runs (they may hold claude-code
        isolation dirs if a process was killed), then FAIL LOUDLY if any hindsight-claude-code-*
        dir under our temp root survived."""
        self.tmp_root.mkdir(parents=True, exist_ok=True)
        restrict_acl(self.tmp_root)
        live = self.live_launch_dir()
        if live is not None and self.launch_tmp is None:
            # An API started by an earlier supervisor is still running: keep its TEMP dir (it will
            # be adopted) and clean it when that process ends.
            self.launch_tmp = live
            self.launch_id = live.name
        removed = 0
        for child in list(self.tmp_root.iterdir()):
            if self.launch_tmp and child.resolve() == self.launch_tmp.resolve():
                continue
            shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
            removed += 1
        leftovers = [p for p in self.tmp_root.rglob(ISOLATION_PREFIX + "*")
                     if not (self.launch_tmp and self.launch_tmp in p.parents)]
        if removed:
            self.event("stale_temp_removed", count=removed)
        if leftovers:
            self.event("isolation_leftover", count=len(leftovers))
            raise LoudError(f"{len(leftovers)} {ISOLATION_PREFIX}* folder(s) under {self.tmp_root} could not be removed; "
                            "refusing to start. Find the process holding them, stop it, then run `sweep` again.")

    def live_launch_dir(self) -> Path | None:
        try:
            meta = json.loads(self.api_meta_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        pid, lid = meta.get("pid"), meta.get("launch_id")
        if not pid or not lid or not IS_WIN:
            return None
        if process_alive(pid) and meta.get("create_time") == process_create_time(pid):
            return self.tmp_root / lid
        return None

    def run_acl_guard(self, when: str) -> None:
        """Remove any Codex-sandbox ALLOW entry under D:\\hindsight (a Codex workspace inside it would
        override the inherited deny) and re-assert the explicit denies. Paths only in the event."""
        root = self.p.get("acl_guard_root", r"D:\hindsight")
        if not root or not IS_WIN:
            return
        try:
            res = codex_acl_guard(root)
        except Exception as e:
            self.event("acl_guard_failed", when=when, error_class=type(e).__name__)
            return
        if res["explicit_allow_found"] or res["deny_added"] or when == "start":
            self.event("acl_guard", when=when, found=len(res["explicit_allow_found"]),
                       removed=len(res["allow_removed"]), deny_added=len(res["deny_added"]),
                       paths=res["explicit_allow_found"][:20])

    def check_provider_patch(self) -> None:
        """Refuse to start if the claude-code provider lost its no-credential-copy patch (e.g. a
        `pip install --upgrade` restored the upstream file)."""
        import patch_provider
        target = Path(self.p.get("provider_file") or patch_provider.DEFAULT_TARGET)
        if not target.exists():
            return
        state = patch_provider.state_of(target)
        if state != "v3":
            self.event("provider_patch_missing", state=state[:120])
            raise LoudError(f"claude-code provider patch is not in place ({state}); run patch_provider.py, then start again")

    def cleanup_launch_tmp(self) -> None:
        if not self.launch_tmp:
            return
        shutil.rmtree(self.launch_tmp, ignore_errors=True)
        if self.launch_tmp.exists():
            left = list(self.launch_tmp.rglob(ISOLATION_PREFIX + "*"))
            self.event("launch_tmp_not_removed", isolation_dirs=len(left))
        self.launch_tmp = None

    # ---- process management ----
    def healthy(self, timeout: float = 3.0) -> int | None:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/health")
        if self.key:
            req.add_header("Authorization", f"Bearer {self.key}")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code
        except Exception:
            return None

    def our_launcher_pid(self, listener_pid: int) -> int | None:
        """The PID recorded at launch (the venv python.exe redirector) if the listening process is it
        or its direct child and the recorded creation time still matches (no PID reuse)."""
        try:
            meta = json.loads(self.api_meta_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        rec = meta.get("pid")
        if not rec or meta.get("create_time") != process_create_time(rec):
            return None
        return rec if listener_pid == rec or parent_pid(listener_pid) == rec else None

    def is_hindsight_process(self, pid: int) -> bool:
        img = (process_image(pid) or "").lower()
        venv = str(Path(self.p["python_exe"]).parent.parent).lower()
        if img.startswith(venv):
            return True
        cmd = process_cmdline(pid).lower()
        return "hindsight" in cmd and ("hindsight_api" in cmd or "hindsight-api" in cmd)

    def owner_of_listener(self) -> int | None:
        ls = listeners(self.port)
        return ls[0][1] if ls else None

    def check_bind(self) -> None:
        bad = [a for a, _ in listeners(self.port) if a not in ("127.0.0.1", "::1")]
        if bad:
            self.event("security_non_loopback_listener", addresses=sorted(set(bad)))
            raise LoudError(f"port {self.port} is listening on a non-loopback address {sorted(set(bad))}")

    def launch(self) -> None:
        self.launch_id = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        self.launch_tmp = self.tmp_root / self.launch_id
        self.launch_tmp.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.rotate_logs()
        out = open(self.log_dir / f"api-{self.launch_id}.out.log", "ab")
        err = open(self.log_dir / f"api-{self.launch_id}.err.log", "ab")
        env = build_api_env(self.p, self.key or "", self.launch_tmp)
        # api_launch.py scrubs secrets, credentials in URIs and memory text from every log line
        # before it imports Hindsight (see that file). Test profiles may point api_script elsewhere.
        script = self.p.get("api_script") or str(HERE / "api_launch.py")
        cmd = [self.p["python_exe"], "-X", "utf8", script]
        # New process group so CTRL_BREAK reaches only the API; it shares our (hidden) console.
        self.proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                     cwd=self.p["home_dir"], creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        out.close()
        err.close()
        self.adopted_pid = None
        self.api_started = time.monotonic()
        atomic_write_json(self.api_meta_path, {"pid": self.proc.pid, "create_time": process_create_time(self.proc.pid),
                                               "launch_id": self.launch_id, "started_at": now_iso()})
        self.event("api_started", pid=self.proc.pid, launch_id=self.launch_id,
                   **self.llm_summary())
        self.state = "starting"
        self.write_status()

    def rotate_logs(self) -> None:
        keep = int(self.p.get("keep_launch_logs", 10))
        max_age = float(self.p.get("log_max_age_days", 14)) * 86400
        logs = sorted(self.log_dir.glob("api-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        for i, old in enumerate(logs):
            if i >= keep * 2 or time.time() - old.stat().st_mtime > max_age:
                old.unlink(missing_ok=True)

    def err_class_for_launch(self) -> str:
        if not self.launch_id:
            return "none"
        p = self.log_dir / f"api-{self.launch_id}.err.log"
        try:
            with open(p, "rb") as f:
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 65536))
                return error_class_from_text(f.read().decode("utf-8", "replace"))
        except OSError:
            return "none"

    def api_alive(self) -> bool:
        if self.proc is not None:
            return self.proc.poll() is None
        if self.adopted_pid is not None:
            return process_alive(self.adopted_pid)
        return False

    def stop_api(self, reason: str, timeout: float | None = None) -> None:
        """Graceful first (CTRL_BREAK -> uvicorn shutdown), then force. Postgres is stopped separately."""
        pid = self.proc.pid if self.proc else self.adopted_pid
        if pid is None:
            return
        graceful = False
        if self.proc is not None and self.proc.poll() is None:
            k32.GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, self.proc.pid)
            deadline = time.monotonic() + (float(self.p.get("stop_timeout_s", 30)) if timeout is None else timeout)
            while time.monotonic() < deadline and self.proc.poll() is None:
                time.sleep(0.5)
            graceful = self.proc.poll() is not None
        if self.api_alive():
            kill_tree(pid)
            for _ in range(40):
                if not self.api_alive():
                    break
                time.sleep(0.25)
        code = self.proc.poll() if self.proc else None
        self.event("api_stopped", pid=pid, reason=reason, graceful=graceful, exit_code=code, exit_hex=exit_hex(code))

    def stop_postgres(self, reason: str, timeout: int = 60) -> None:
        st = pg_state(self.p)
        if st == "running":
            rc = pg_stop(self.p, timeout)
            self.event("postgres_stopped", reason=reason, rc=rc, state_after=pg_state(self.p))

    def ensure_postgres(self) -> None:
        """Start the managed Postgres if it is not running (it is reused across API restarts)."""
        st = pg_state(self.p)
        if st in ("running", "unmanaged"):
            return
        if st == "missing":
            raise LoudError(f"database directory missing: {self.p['db']['data_dir']}")
        rc, _ = pg_start(self.p)
        self.event("postgres_started", rc=rc, state_after=pg_state(self.p))
        if pg_state(self.p) != "running":
            raise StartFailure("postgres did not start")

    def shutdown(self, reason: str, fast: bool = False) -> None:
        """fast=True is for logoff: Windows kills console processes a few seconds after
        CTRL_LOGOFF_EVENT, so the graceful wait is capped at 3 s and Postgres gets 5 s."""
        # A lock, not a flag: a second caller (e.g. the main thread after the session-end
        # handler started stopping) WAITS until the first has finished, instead of returning and
        # letting the process exit half-way through stopping Postgres.
        with self._shutdown_lock:
            if self.state == "stopped" and self.proc is None and self.adopted_pid is None and self.proxy_proc is None:
                return
            self.state = "stopping"
            self.write_status()
            self.stop_proxy(reason)  # order: proxy (clients), then API, then Postgres
            self.stop_api(reason, timeout=3.0 if fast else None)
            self.stop_postgres(reason, timeout=5 if fast else 60)
            self.cleanup_launch_tmp()
            self.proc = None
            self.adopted_pid = None
            self.state = "stopped"
            self.write_status()

    # ---- client proxy (the only client-facing route; see proxy.py) ----
    def proxy_port(self) -> int | None:
        px = self.p.get("proxy")
        return int(px["port"]) if px else None

    def start_proxy(self) -> None:
        port = self.proxy_port()
        if port is None or (self.proxy_proc is not None and self.proxy_proc.poll() is None):
            return
        for addr, pid in listeners(port):
            if "proxy.py" in process_cmdline(pid):
                kill_tree(pid)  # a stale proxy from an earlier supervisor; the proxy is stateless
                self.event("stale_proxy_replaced", pid=pid)
            else:
                self.event("proxy_port_in_use", pid=pid)
                return
        now = time.monotonic()
        self.proxy_restarts = [t for t in self.proxy_restarts if now - t < 600]
        if len(self.proxy_restarts) >= 5:
            if not getattr(self, "_proxy_gave_up", False):
                self._proxy_gave_up = True
                self.event("proxy_restart_bound_reached")
            return
        self.proxy_restarts.append(now)
        log = open(self.log_dir / "proxy.err.log", "ab")
        env = {k: v for k, v in os.environ.items() if k.upper() in PASS_THROUGH_ENV}
        env.update({"PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"})
        cfg = self.p.get("_config_path") or str(DEFAULT_CONFIG)
        self.proxy_proc = subprocess.Popen(
            [self.p["python_exe"], "-X", "utf8", str(HERE / "proxy.py"), "--profile", self.p["name"], "--config", cfg],
            env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=str(HERE),
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        log.close()
        self.event("proxy_started", pid=self.proxy_proc.pid, port=port)

    def stop_proxy(self, reason: str) -> None:
        if self.proxy_proc is None:
            return
        if self.proxy_proc.poll() is None:
            kill_tree(self.proxy_proc.pid)
            try:
                self.proxy_proc.wait(15)
            except Exception:
                pass
        self.event("proxy_stopped", reason=reason)
        self.proxy_proc = None

    # ---- main loop ----
    def wait_stop(self, seconds: float) -> bool:
        return k32.WaitForSingleObject(self.stop_event, int(seconds * 1000)) == WAIT_OBJECT_0

    def monitor(self) -> tuple[str, dict]:
        interval = float(self.health.get("interval_s", 10))
        grace = float(self.health.get("startup_grace_s", 240))
        threshold = int(self.health.get("fail_threshold", 6))
        healthy_seen = self.adopted_pid is not None and self.adopted_healthy
        fails = 0
        last_bind_check = 0.0
        guard_every = float(self.p.get("acl_guard_interval_s", 1800))
        while True:
            if self.wait_stop(interval):
                return "stop", {}
            if not self.api_alive():
                code = self.proc.poll() if self.proc else None
                if self.proc is None and self.adopted_pid is not None:
                    code = None  # exit code of a process we did not start is not available
                return "exit", {"exit_code": code}
            code = self.healthy()
            now = time.monotonic()
            if code == 200:
                if not healthy_seen:
                    healthy_seen = True
                    self.event("api_healthy", pid=self.proc.pid if self.proc else self.adopted_pid,
                               startup_s=round(now - (self.api_started or now), 1))
                fails = 0
                self.state = "running"
                if self.proxy_port() is not None and (self.proxy_proc is None or self.proxy_proc.poll() is not None):
                    if self.proxy_proc is not None:
                        self.event("proxy_exited", exit_code=self.proxy_proc.poll(), exit_hex=exit_hex(self.proxy_proc.poll()))
                        self.proxy_proc = None
                    self.start_proxy()
                if now - self._last_guard > guard_every and not getattr(self, "_guard_running", False):
                    self._last_guard = now

                    def _guard():
                        self._guard_running = True
                        try:
                            self.run_acl_guard("periodic")
                        finally:
                            self._guard_running = False
                    threading.Thread(target=_guard, name="acl-guard", daemon=True).start()
                if now - last_bind_check > 60:
                    last_bind_check = now
                    self.check_bind()
            elif not healthy_seen:
                if now - (self.api_started or now) > grace:
                    return "hang", {"why": "startup_timeout", "last_health": code}
            else:
                fails += 1
                self.state = "degraded"
                if fails >= threshold:
                    return "hang", {"why": "health_failures", "last_health": code, "failures": fails}
            self.write_status()

    def adopt_or_clear_port(self) -> bool:
        """True if an instance we started earlier is healthy and has been adopted."""
        pid = self.owner_of_listener()
        if pid is None:
            return False
        self.check_bind()
        ours = self.our_launcher_pid(pid)
        if ours:
            # Started by an earlier supervisor (e.g. one that was itself killed). No duplicate:
            # watch it; the monitor's startup grace / health threshold still applies.
            self.adopted_pid = ours
            self.adopted_healthy = self.healthy() == 200
            self.api_started = time.monotonic()
            self.event("adopted_existing_instance", pid=ours, listener_pid=pid, healthy=self.adopted_healthy)
            return True
        if self.is_hindsight_process(pid):
            # An instance this supervisor did not start (e.g. the old hindsight.ps1 launcher, which
            # ran without auth). Replace it rather than run a duplicate or leave it unauthenticated.
            self.event("replacing_unmanaged_instance", pid=pid, healthy=self.healthy() == 200)
            kill_tree(pid)
            for _ in range(40):
                if not process_alive(pid):
                    break
                time.sleep(0.25)
            return False
        self.event("port_in_use_by_foreign_process", pid=pid)
        raise LoudError(f"port {self.port} is held by a non-Hindsight process (pid {pid}); not starting")

    def run(self, clear_alert: bool = False) -> int:
        if not IS_WIN:
            print("Windows only", file=sys.stderr)
            return 1
        mutexes = []
        for name in mutex_names(self.p):
            h = k32.CreateMutexW(None, False, name)
            if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
                for m in mutexes + [h]:
                    k32.CloseHandle(m)
                print(f"a supervisor for this port or database is already running (profile '{self.p['name']}')")
                return EXIT_ALREADY
            mutexes.append(h)
        for d in (self.run_dir, self.log_dir):
            d.mkdir(parents=True, exist_ok=True)
            restrict_acl(d)  # API logs carry operational metadata (e.g. the Codex account id)
        self.stop_event = k32.CreateEventW(None, True, False, stop_event_name(self.p))
        k32.ResetEvent(self.stop_event)
        self.event("supervisor_started", pid=os.getpid())
        if self.lock_path.exists():
            if not clear_alert:
                self.state = "failed_crashloop"
                self.event("refused_crashloop_lock")
                self.write_status()
                return EXIT_CRASHLOOP
            self.lock_path.unlink(missing_ok=True)
            self.event("crashloop_lock_cleared")
        self.ensure_console()
        self.install_ctrl_handler()
        try:
            self.sweep()
            threading.Thread(target=self.run_acl_guard, args=("start",), name="acl-guard", daemon=True).start()
            self.check_provider_patch()
            self.key, self.key_source = resolve_key(self.p)
            if not self.key:
                self.state = "error_no_key"
                self.event("no_api_key")
                self.write_status()
                return EXIT_NO_KEY
            while True:
                outcome, info = None, {}
                if not self.adopt_or_clear_port():
                    try:
                        self.ensure_postgres()
                        self.launch()
                    except StartFailure as e:
                        self.event("launch_failed", why=str(e)[:80])
                        outcome, info = "exit", {"exit_code": None, "why": str(e)[:80]}
                        self.api_started = time.monotonic()
                if outcome is None:
                    outcome, info = self.monitor()
                if outcome == "stop":
                    self.shutdown("stop_requested")
                    self.event("supervisor_stopped")
                    return EXIT_OK
                uptime = round(time.monotonic() - (self.api_started or time.monotonic()), 1)
                if self.wait_stop(0):  # stop requested (or session ending) while the API exited
                    self.shutdown("stop_requested")
                    self.event("supervisor_stopped")
                    return EXIT_OK
                if outcome == "hang":
                    self.event("api_unhealthy", uptime_s=uptime, **info)
                    self.stop_api("unhealthy")
                    code = self.proc.poll() if self.proc else None
                else:
                    code = info.get("exit_code")
                self.last_exit = {"at": now_iso(), "exit_code": code, "exit_hex": exit_hex(code),
                                  "kind": classify_exit(code) if outcome == "exit" else f"hang:{info.get('why')}",
                                  "uptime_s": uptime, "error_class": self.err_class_for_launch()}
                self.event("api_exited", **self.last_exit)
                self.proc = None
                self.adopted_pid = None
                self.cleanup_launch_tmp()
                delay = self.backoff.next_delay(time.monotonic(), uptime)
                if delay is None:
                    self.stop_proxy("crashloop_bound")
                    self.stop_postgres("crashloop_bound")
                    self.state = "failed_crashloop"
                    alert = {"at": now_iso(), "profile": self.p["name"],
                             "message": f"Hindsight restart bound reached ({self.backoff.reason}); supervisor "
                                        f"stopped. Investigate the api-*.err.log files, then run "
                                        f"`supervisor.py clear-alert`.",
                             "bound": self.backoff.reason,
                             "last_exit": self.last_exit}
                    atomic_write_json(self.lock_path, alert)
                    atomic_write_json(self.run_dir / "ALERT.json", alert)
                    self.event("crashloop_stopped", bound=self.backoff.reason,
                               restarts_in_window=self.backoff.in_window(time.monotonic()),
                               consecutive_failures=self.backoff.consecutive)
                    self.write_status()
                    return EXIT_CRASHLOOP
                self.state = "restarting"
                self.event("restart_scheduled", delay_s=delay,
                           restarts_in_window=self.backoff.in_window(time.monotonic()),
                           consecutive_failures=self.backoff.consecutive)
                self.write_status()
                if self.wait_stop(delay):
                    self.shutdown("stop_requested")
                    self.event("supervisor_stopped")
                    return EXIT_OK
                self.sweep()
        except LoudError as e:
            self.state = "error"
            self.event("supervisor_error", error_class=type(e).__name__)
            self.write_status(error=str(e))
            print(f"ERROR: {e}", file=sys.stderr)
            try:
                if self.proc is not None or self.adopted_pid is not None or self.proxy_proc is not None:
                    self.shutdown("error")
            finally:
                return EXIT_SECURITY if "non-loopback" in str(e) else (EXIT_FOREIGN if "non-Hindsight" in str(e) else EXIT_PREFLIGHT)
        finally:
            for m in mutexes:
                k32.CloseHandle(m)

    # ---- console plumbing ----
    def ensure_console(self) -> None:
        """CTRL_BREAK needs a console shared with the API. Under pythonw there is none."""
        if not k32.GetConsoleWindow():
            k32.AllocConsole()
            hwnd = k32.GetConsoleWindow()
            if hwnd:
                u32.ShowWindow(hwnd, 0)

    def install_ctrl_handler(self) -> None:
        """Ctrl-C/Break/close aimed at our own console -> clean stop. Logoff/shutdown is handled by
        a hidden window (see start_session_window): a process that has loaded user32 (this one
        does) never receives CTRL_LOGOFF_EVENT/CTRL_SHUTDOWN_EVENT through a console handler."""
        def handler(ctrl_type: int) -> bool:
            if ctrl_type in (0, 1, 2):
                if self.stop_event:
                    k32.SetEvent(self.stop_event)
                return True
            return False

        self._handler = HANDLER_ROUTINE(handler)  # keep a reference
        k32.SetConsoleCtrlHandler(self._handler, True)
        self.start_session_window()

    def session_ending_shutdown(self, source: str) -> None:
        self.session_ending = True
        self.event("session_ending", source=source)
        if self.stop_event:
            k32.SetEvent(self.stop_event)  # the main loop must not restart anything now
        try:
            self.shutdown("session_ending", fast=True)
        except Exception:
            pass

    def start_session_window(self) -> None:
        """A hidden top-level window whose WM_ENDSESSION stops proxy, API and Postgres cleanly
        (fast mode) before Windows ends the process at logoff or shutdown."""
        WM_QUERYENDSESSION, WM_ENDSESSION, WM_CLOSE = 0x0011, 0x0016, 0x0010
        LRESULT = ctypes.c_ssize_t
        WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)
        u32.DefWindowProcW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
        u32.DefWindowProcW.restype = LRESULT

        class WNDCLASSW(ctypes.Structure):
            _fields_ = [("style", wt.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                        ("cbWndExtra", ctypes.c_int), ("hInstance", wt.HINSTANCE), ("hIcon", wt.HICON),
                        ("hCursor", wt.HANDLE), ("hbrBackground", wt.HBRUSH), ("lpszMenuName", wt.LPCWSTR),
                        ("lpszClassName", wt.LPCWSTR)]

        def wndproc(hwnd, msg, wparam, lparam):
            if msg == WM_QUERYENDSESSION:
                return 1
            if msg == WM_ENDSESSION:
                if wparam:
                    self.session_ending_shutdown("WM_ENDSESSION")
                return 0
            if msg == WM_CLOSE:
                return 0
            return u32.DefWindowProcW(hwnd, msg, wparam, lparam)

        self._wndproc = WNDPROC(wndproc)
        cls_name = f"MUHindsightSupervisor-{resource_id(self.p)}"
        self.window_class = cls_name

        def loop():
            hinst = k32.GetModuleHandleW(None)
            wc = WNDCLASSW()
            wc.lpfnWndProc = self._wndproc
            wc.hInstance = hinst
            wc.lpszClassName = cls_name
            u32.RegisterClassW(ctypes.byref(wc))
            u32.CreateWindowExW.restype = wt.HWND
            u32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int,
                                           ctypes.c_int, ctypes.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
            hwnd = u32.CreateWindowExW(0, cls_name, cls_name, 0, 0, 0, 0, 0, None, None, hinst, None)
            if not hwnd:
                self.event("session_window_failed")
                return
            msg = wt.MSG()
            while u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                u32.TranslateMessage(ctypes.byref(msg))
                u32.DispatchMessageW(ctypes.byref(msg))

        threading.Thread(target=loop, name="session-window", daemon=True).start()

# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------


def cmd_stop(p: dict) -> int:
    name = p["name"]
    if supervisor_running(p):
        h = k32.OpenEventW(EVENT_MODIFY_STATE, False, stop_event_name(p))
        if not h:
            print("supervisor is running but its stop event is missing", file=sys.stderr)
            return 1
        k32.SetEvent(h)
        k32.CloseHandle(h)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and supervisor_running(p):
            time.sleep(0.5)
        print("stopped" if not supervisor_running(p) else "stop requested; supervisor still exiting")
        return 0 if not supervisor_running(p) else 1
    # No supervisor: stop whatever is there directly (API first, then Postgres).
    s = Supervisor(p)
    s.run_dir.mkdir(parents=True, exist_ok=True)
    if s.proxy_port() is not None:
        for _a, ppid in listeners(s.proxy_port()):
            if "proxy.py" in process_cmdline(ppid):
                kill_tree(ppid)
                s.event("proxy_stopped", reason="stop_without_supervisor")
    pid = s.owner_of_listener()
    if pid and s.is_hindsight_process(pid):
        kill_tree(pid)
        s.event("api_stopped", pid=pid, reason="stop_without_supervisor", graceful=False)
    s.stop_postgres("stop_without_supervisor")
    s.state = "stopped"
    s.write_status()
    print("stopped (no supervisor was running)")
    return 0


def cmd_status(p: dict) -> int:
    s = Supervisor(p)
    try:
        status = json.loads(s.status_path.read_text(encoding="utf-8"))
    except Exception:
        status = {"state": "never_started"}
    key, src = resolve_key(p)
    s.key = key
    live = {
        "supervisor_running": supervisor_running(p),
        "listeners": [{"address": a, "pid": pid} for a, pid in listeners(s.port)],
        "health_http": s.healthy(),
        "postgres": pg_state(p),
        "key_configured": bool(key),
        "key_source": src,
        "crashloop_lock": s.lock_path.exists(),
    }
    print(json.dumps({"recorded": status, "live": live}, indent=2, sort_keys=True))
    return 0


def write_secret(path: Path, value: str) -> None:
    """Write a secret to a user-only file (ACL set before the value lands in its final name)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    restrict_acl(path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(value, encoding="utf-8", newline="")
    restrict_acl(tmp)
    os.replace(tmp, path)
    restrict_acl(path)


def cmd_init_key(p: dict, rotate: bool) -> int:
    kf = Path(p["key_file"])
    if kf.exists() and not rotate:
        print(f"key file already exists: {kf} (use --rotate to replace it)")
    else:
        write_secret(kf, secrets.token_urlsafe(32))
        print(f"wrote a new random API key to {kf} (user-only ACL); the value was not printed")
    ap = (p.get("proxy") or {}).get("docdelete_secret_file")
    if ap and (not Path(ap).exists() or rotate):
        write_secret(Path(ap), secrets.token_hex(32))
        print(f"wrote a new document-delete approval secret to {ap} (user-only ACL); the value was not printed")
    return 0


def scram_verifier(password: str, iterations: int = 4096) -> str:
    """PostgreSQL SCRAM-SHA-256 verifier, so ALTER ROLE never carries the plaintext password (even
    a server-side statement log would only ever see the verifier)."""
    import base64
    import hashlib
    import hmac as _hmac
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    client_key = _hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = _hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


def app_sql(profile: dict, sql_text: str, sep: str | None = None) -> str:
    """Run SQL as the APP role (tests and read-only checks). Raises on failure; output never has secrets."""
    rc, out = psql(profile, sql_text, user=profile["db"].get("user", "hindsight"), password=db_password(profile), sep=sep)
    if rc != 0:
        raise RuntimeError("psql failed: " + out.strip()[-200:])
    return out.strip()


def cmd_harden_db(p: dict, bootstrap_password_file: str | None = None) -> int:
    """Separate passwords and least privilege for the managed Postgres:
      * `postgres` (superuser) gets its OWN random password in db.admin_password_file;
      * the app role (`hindsight`) gets a random password in db.password_file and is made
        NOSUPERUSER NOCREATEROLE NOREPLICATION, while keeping ownership of its database;
      * only SCRAM verifiers are sent (ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...').
    Connects as `postgres` with the admin password, or, on first run, with the password in
    --bootstrap-password-file. Nothing is printed except status."""
    db = p["db"]
    s = Supervisor(p)
    s.run_dir.mkdir(parents=True, exist_ok=True)
    was_running = pg_state(p) == "running"
    if not was_running:
        rc, _ = pg_start(p)
        if pg_state(p) != "running":
            print("could not start Postgres", file=sys.stderr)
            return 3
    admin_now = db_admin_password(p) or _read_secret_file(bootstrap_password_file)
    if not admin_now:
        print("no admin password available (admin file missing and no --bootstrap-password-file)", file=sys.stderr)
        return 2
    user = db.get("user", "hindsight")
    rc, out = psql(p, "select 1;", password=admin_now)
    if rc != 0:
        print("cannot log in as postgres with the current admin password", file=sys.stderr)
        return 4
    new_admin = secrets.token_hex(24)
    new_app = db_password(p) or secrets.token_hex(24)
    sql = (f"ALTER ROLE postgres WITH PASSWORD '{scram_verifier(new_admin)}';\n"
           f"ALTER ROLE \"{user}\" WITH NOSUPERUSER NOCREATEROLE NOREPLICATION PASSWORD '{scram_verifier(new_app)}';\n"
           f"ALTER DATABASE \"{db.get('name', 'hindsight')}\" OWNER TO \"{user}\";\n")
    rc, out = psql(p, sql, password=admin_now)
    if rc != 0:
        print("ALTER ROLE failed; nothing changed: " + out.strip()[-160:], file=sys.stderr)
        return 5
    write_secret(Path(db["admin_password_file"]), new_admin)
    write_secret(Path(db["password_file"]), new_app)
    rc1, o1 = psql(p, f"select rolsuper from pg_roles where rolname = '{user}';", password=new_admin)
    rc2, o2 = psql(p, "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema') "
                      f"and tableowner <> '{user}';", user=user, password=new_app)
    ok = rc1 == 0 and o1.strip() == "f" and rc2 == 0
    s.event("db_hardened", app_role_superuser=o1.strip(), foreign_owned_tables=o2.strip(), ok=ok)
    if not was_running:
        pg_stop(p)
    print(f"DB hardened (values not shown): app role superuser={o1.strip()}, tables not owned by "
          f"{user}={o2.strip()}, verification {'ok' if ok else 'FAILED'}")
    return 0 if ok else 6


def cmd_admin(p: dict, action: str, bank: str, confirm: str) -> int:
    """Operator-only destructive bank operations, on this console, straight to the API with the
    key (never exposed through the client proxy). --confirm must repeat the bank name."""
    if action not in ("delete-bank", "clear-bank"):
        print("unknown admin action", file=sys.stderr)
        return 2
    if not bank or confirm != bank or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", bank) or bank in (".", ".."):
        print("refused: --confirm must repeat a valid bank name exactly", file=sys.stderr)
        return 2
    key, _ = resolve_key(p)
    path = f"/v1/default/banks/{bank}" + ("/memories" if action == "clear-bank" else "")
    req = urllib.request.Request(f"http://127.0.0.1:{int(p['port'])}{path}", method="DELETE")
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
    Supervisor(p).event("admin_" + action.replace("-", "_"), bank=bank, status=status)
    print(f"{action} {bank}: HTTP {status}")
    return 0 if status == 200 else 1


def cmd_mint_approval(p: dict, method: str, path: str, approval_id: str, ttl: int) -> int:
    """For the approval path only: prints a single-use token for ONE exact destructive request."""
    import proxy as _proxy  # noqa: F401  (same HMAC format as the proxy verifies)
    ap = Path((p.get("proxy") or {}).get("docdelete_secret_file", ""))
    if method.upper() != "DELETE" or "/documents/" not in path:
        print("only document deletes can be approved; bank delete and clear are operator-only (admin)", file=sys.stderr)
        return 2
    if not ap.is_file():
        print("no document-delete secret configured", file=sys.stderr)
        return 1
    print(_proxy.mint_approval(ap.read_bytes().strip(), approval_id, method, path, ttl))
    return 0


def cmd_scrub_logs(p: dict) -> int:
    """Scrub existing log files (written before api_launch.py existed): credentials in URIs and the
    recall/reflect query previews. Files still held open by a running API are skipped."""
    import api_launch  # same patterns the live scrubber uses
    root = Path(p["log_dir"]).parent
    changed = skipped = 0
    for f in root.rglob("*.log*"):
        if not f.is_file():
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
            clean = api_launch.scrub(text)
            if clean != text:
                tmp = f.with_name(f.name + ".scrub")
                tmp.write_text(clean, encoding="utf-8", newline="")
                os.replace(tmp, f)
                changed += 1
        except OSError:
            skipped += 1
    Supervisor(p).event("logs_scrubbed", changed=changed, skipped_locked=skipped)
    print(f"scrubbed {changed} log file(s); {skipped} skipped (in use)")
    return 0


def cmd_writes(p: dict, state: str) -> int:
    flag = Path(p["run_dir"]) / "WRITES_ENABLED"
    Supervisor(p).run_dir.mkdir(parents=True, exist_ok=True)
    if state == "on":
        flag.write_text(now_iso(), encoding="utf-8")
    elif state == "off":
        flag.unlink(missing_ok=True)
    Supervisor(p).event("memory_writes", state="on" if flag.exists() else "off")
    print("memory writes through the proxy: " + ("ON" if flag.exists() else "OFF"))
    return 0


def cmd_sweep(p: dict) -> int:
    s = Supervisor(p)
    s.run_dir.mkdir(parents=True, exist_ok=True)
    if IS_WIN and supervisor_running(p):
        print("supervisor is running; it sweeps on every (re)start", file=sys.stderr)
        return 1
    try:
        s.sweep()
    except LoudError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return EXIT_PREFLIGHT
    print("sweep ok: no hindsight-claude-code-* folders remain under " + str(s.tmp_root))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Hindsight supervisor (Windows)")
    ap.add_argument("command", choices=["run", "stop", "status", "init-key", "sweep", "clear-alert",
                                        "harden-db", "admin", "mint-approval", "writes", "scrub-logs", "acl-guard"])
    ap.add_argument("--profile", default="pilot")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--clear-alert", action="store_true")
    ap.add_argument("--rotate", action="store_true")
    ap.add_argument("--method")
    ap.add_argument("--path")
    ap.add_argument("--approval-id")
    ap.add_argument("--ttl", type=int, default=600)
    ap.add_argument("--state", choices=["on", "off", "show"], default="show")
    ap.add_argument("--bootstrap-password-file")
    ap.add_argument("--action")
    ap.add_argument("--bank")
    ap.add_argument("--confirm")
    a = ap.parse_args(argv)
    p = load_profile(Path(a.config), a.profile)
    if a.command == "acl-guard":
        res = codex_acl_guard(p.get("acl_guard_root", r"D:\hindsight"))
        Supervisor(p).event("acl_guard", when="manual", found=len(res["explicit_allow_found"]),
                            removed=len(res["allow_removed"]), deny_added=len(res["deny_added"]),
                            paths=res["explicit_allow_found"][:20])
        print(json.dumps(res, indent=2))
        return 0 if len(res["allow_removed"]) == len(res["explicit_allow_found"]) else 1
    if a.command == "harden-db":
        return cmd_harden_db(p, a.bootstrap_password_file)
    if a.command == "admin":
        return cmd_admin(p, a.action, a.bank, a.confirm)
    if a.command == "mint-approval":
        return cmd_mint_approval(p, a.method, a.path, a.approval_id, a.ttl)
    if a.command == "writes":
        return cmd_writes(p, a.state)
    if a.command == "scrub-logs":
        return cmd_scrub_logs(p)
    if a.command == "run":
        return Supervisor(p).run(clear_alert=a.clear_alert)
    if a.command == "stop":
        return cmd_stop(p)
    if a.command == "status":
        return cmd_status(p)
    if a.command == "init-key":
        return cmd_init_key(p, a.rotate)
    if a.command == "sweep":
        return cmd_sweep(p)
    if a.command == "clear-alert":
        s = Supervisor(p)
        existed = s.lock_path.exists()
        s.lock_path.unlink(missing_ok=True)
        (s.run_dir / "ALERT.json").unlink(missing_ok=True)
        if existed:
            s.event("crashloop_lock_cleared")
            try:
                st = json.loads(s.status_path.read_text(encoding="utf-8"))
                st.update({"state": "stopped_alert_cleared", "alert": False, "updated_at": now_iso()})
                atomic_write_json(s.status_path, st)
            except Exception:
                pass
        print("alert cleared" if existed else "no alert to clear")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
