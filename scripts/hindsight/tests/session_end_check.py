"""Session-end (logoff/shutdown) handling, SYNTHETIC instance: sends the supervisor's hidden window
the same WM_QUERYENDSESSION / WM_ENDSESSION messages Windows sends at logoff, then checks that
proxy, API and Postgres were stopped cleanly, in order, and nothing is left running.
Requires the synth supervisor to be running (hindsightctl.ps1 start -Profile synth).
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import supervisor as sv  # noqa: E402

P = sv.load_profile(Path(r"D:\hindsight\service\hindsight.profiles.json"), "synth")
u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.FindWindowW.restype = wt.HWND
u32.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
u32.SendMessageTimeoutW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM, wt.UINT, wt.UINT, ctypes.POINTER(ctypes.c_size_t)]


def main() -> int:
    cls = f"MUHindsightSupervisor-{sv.resource_id(P)}"
    hwnd = u32.FindWindowW(cls, None)
    status = json.loads(Path(P["run_dir"], "status.json").read_text(encoding="utf-8"))
    sup_pid = status["supervisor_pid"]
    print(json.dumps({"window_found": bool(hwnd), "supervisor_pid": sup_pid, "state_before": status["state"]}))
    if not hwnd:
        return 1
    mark = sv.now_iso()
    res = ctypes.c_size_t(0)
    u32.SendMessageTimeoutW(hwnd, 0x0011, 0, 0x80000000, 0x0002, 5000, ctypes.byref(res))  # WM_QUERYENDSESSION, ENDSESSION_LOGOFF
    ok_query = res.value == 1
    t0 = time.monotonic()
    u32.SendMessageTimeoutW(hwnd, 0x0016, 1, 0x80000000, 0x0002, 30000, ctypes.byref(res))  # WM_ENDSESSION(TRUE)
    handler_s = round(time.monotonic() - t0, 1)
    time.sleep(5)
    events = [json.loads(line) for line in Path(P["run_dir"], "events.jsonl").read_text(encoding="utf-8").splitlines()
              if line.strip() and json.loads(line)["ts"] >= mark]
    names = [e["event"] for e in events]
    left = {"api_listener": bool(sv.listeners(P["port"])), "proxy_listener": bool(sv.listeners(P["proxy"]["port"])),
            "postgres": sv.pg_state(P), "supervisor_alive": sv.process_alive(sup_pid)}
    order_ok = (names.index("proxy_stopped") < names.index("api_stopped") < names.index("postgres_stopped")
                if all(n in names for n in ("proxy_stopped", "api_stopped", "postgres_stopped")) else
                ("proxy_stopped" in names and "api_stopped" in names and left["postgres"] != "running"))
    ok = ok_query and "session_ending" in names and order_ok and not left["api_listener"] and not left["proxy_listener"] \
        and left["postgres"] != "running" and not left["supervisor_alive"] and handler_s <= 20
    print(json.dumps({"query_allowed": ok_query, "handler_seconds": handler_s, "events": names, "left_running": left,
                      "pass": ok}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
