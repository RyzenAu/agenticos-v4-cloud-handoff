#!/usr/bin/env python3
"""Hindsight client proxy (M&U, 28 Sep 2026): the ONLY client-facing route to Hindsight.

Clients (AgenticOS' memory connector, Claude Code, Hermes, the hindsight-ask skill) talk to this
proxy on 127.0.0.1 with NO key. The proxy:
  * accepts a connection only if the calling process runs as the SAME Windows user as the proxy
    (the peer's PID is looked up in the TCP table and its token SID compared) -- other local
    accounts, e.g. CodexSandboxOffline/Online, are refused even on loopback;
  * holds the Hindsight API key itself (read from the user-only key file; never in any client
    config or in the user environment) and adds it upstream;
  * allowlists: health, list/get, recall, reflect, receipts (llm-requests), retain (forced
    synchronous) and single-memory correction (PATCH), plus MCP (whose tool list is already
    restricted server-side, with write tools gated here);
  * gates writes: OFF unless the flag file <run_dir>/WRITES_ENABLED exists, and only to the
    profile's write banks;
  * allows a DOCUMENT delete only with a valid, unexpired, single-use approval token for that
    exact request (HMAC with its own user-only document-delete secret; `supervisor.py
    mint-approval`), rate-limited (default 20 an hour);
  * never exposes bank delete or clear (operator-only: `supervisor.py admin` on this console);
  * canonicalises first (review R2 B1): the RAW request path must already be canonical -- no
    `%`-encoding, no `.`/`..` segments, no `//`, no backslash, only [A-Za-z0-9_-.:/] -- it is
    matched against the exact route templates, and the upstream URL is rebuilt from that same
    canonical path and refused unless its raw path is byte-identical; MCP is exactly
    /mcp/<bank>/ (GET, POST, DELETE);
  * refuses every other route (exports, imports, clones, transfers, bulk operations, config);
  * the WRITER CAPABILITY (Track 6, profile `writer_capability: "on"`): only the process that owns the
    OS's listening port (`writer_port`, 8081) may write, and only with the per-boot capability it
    registered here. The OS makes a random capability at start (memory only) and registers its sha256 at
    POST /_mu/writer/register with a proof (HMAC with the document-delete secret, domain-separated) from
    the process that owns the writer port's LISTEN socket. The proxy keeps {pid, sha256} in memory only.
    Every write then needs `X-MU-Writer: <capability>` from that same PID, which must still own the port.
    Any other bun.exe (an agent's `bun -e fetch(...)`) is refused, even with every other header copied.
Every decision is logged to <run_dir>/proxy.jsonl with the route TEMPLATE, WITHOUT bodies or content.

Run by the supervisor:  python proxy.py --profile pilot [--config hindsight.profiles.json]
"""
from __future__ import annotations

import argparse
import fnmatch
import ctypes
import ctypes.wintypes as wt
import hashlib
import hmac
import json
import os
import re
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import supervisor as sv  # noqa: E402

SEG = r"(?!\.+(?:/|$))"  # a segment may never be only dots
BANK = rf"{SEG}(?P<bank>[A-Za-z0-9_.\-]{{1,64}})"
DOC = rf"{SEG}(?P<doc>[A-Za-z0-9_.:\-]{{1,200}})"
UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
B = rf"/v1/default/banks/{BANK}"
# (method, pattern, kind, template, query allowed)
RULES: list[tuple[str, re.Pattern, str, str, bool]] = [
    ("GET", re.compile(r"^/health$"), "health", "/health", False),
    ("GET", re.compile(r"^/v1/default/banks$"), "list", "/v1/default/banks", True),
    ("GET", re.compile(rf"^{B}$"), "read", "/banks/{bank}", False),
    ("GET", re.compile(rf"^{B}/stats$"), "read", "/banks/{bank}/stats", False),
    ("POST", re.compile(rf"^{B}/memories/recall$"), "read", "/banks/{bank}/memories/recall", False),
    ("POST", re.compile(rf"^{B}/reflect$"), "read", "/banks/{bank}/reflect", False),
    ("GET", re.compile(rf"^{B}/memories/list$"), "read", "/banks/{bank}/memories/list", True),
    ("GET", re.compile(rf"^{B}/memories/{UUID}$"), "read", "/banks/{bank}/memories/{id}", False),
    ("GET", re.compile(rf"^{B}/memories/{UUID}/history$"), "read", "/banks/{bank}/memories/{id}/history", False),
    ("GET", re.compile(rf"^{B}/documents$"), "read", "/banks/{bank}/documents", True),
    ("GET", re.compile(rf"^{B}/documents/{DOC}$"), "read", "/banks/{bank}/documents/{doc}", False),
    ("GET", re.compile(rf"^{B}/tags$"), "read", "/banks/{bank}/tags", True),
    ("GET", re.compile(rf"^{B}/llm-requests$"), "read", "/banks/{bank}/llm-requests", True),
    ("GET", re.compile(rf"^{B}/llm-requests/stats$"), "read", "/banks/{bank}/llm-requests/stats", True),
    ("GET", re.compile(rf"^{B}/operations$"), "read", "/banks/{bank}/operations", True),
    ("GET", re.compile(rf"^{B}/operations/{UUID}$"), "read", "/banks/{bank}/operations/{id}", False),
    ("POST", re.compile(rf"^{B}/memories$"), "write_retain", "/banks/{bank}/memories", False),
    ("PATCH", re.compile(rf"^{B}/memories/{UUID}$"), "write", "/banks/{bank}/memories/{id}", False),
    ("DELETE", re.compile(rf"^{B}/documents/{DOC}$"), "doc_delete", "/banks/{bank}/documents/{doc}", False),
]
MCP_PATH = re.compile(rf"^/mcp/{BANK}/?$")
MCP_METHODS = {"GET", "POST", "DELETE"}
CANONICAL_CHARS = re.compile(r"^[A-Za-z0-9_.:/\-]+$")
QUERY_CHARS = re.compile(r"^[A-Za-z0-9_.,=&\-]*$")


def canonical_path(raw_path: bytes | None, decoded_path: str) -> tuple[str | None, str]:
    """(path, "") if the RAW request path is already canonical, else (None, reason).
    Canonical = identical to its decoded form (no %-encoding), starts with '/', only
    [A-Za-z0-9_-.:/], no '//' and no '.' or '..' (or any dots-only) segment, no backslash."""
    raw = (raw_path or decoded_path.encode()).decode("latin-1")
    if raw != decoded_path:
        return None, "encoded characters in path"
    if not raw.startswith("/") or "\\" in raw or "//" in raw:
        return None, "non-canonical path (slashes)"
    if not CANONICAL_CHARS.match(raw):
        return None, "non-canonical path (characters)"
    segs = raw.split("/")[1:]
    for i, s in enumerate(segs):
        if s == "" and i != len(segs) - 1:
            return None, "non-canonical path (empty segment)"
        if s and set(s) == {"."}:
            return None, "non-canonical path (dot segment)"
    return raw, ""


MCP_WRITE_TOOLS = {"retain", "sync_retain", "update_memory", "invalidate_memory"}
WRITER_REGISTER_PATH = "/_mu/writer/register"
WRITER_REGISTER_DOMAIN = "mu-writer-register-v1"
WRITER_REGISTER_SKEW_S = 60
HEX64 = re.compile(r"^[0-9a-f]{64}$")
DOC_DELETES_PER_HOUR = 20
MAX_BODY = 8 * 1024 * 1024
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization",
       "proxy-authenticate", "host", "content-length", "authorization"}


# ------------------------------------------------------------------ OS identity of the caller
class _MIB_TCPROW_OWNER_PID(ctypes.Structure):
    _fields_ = [("dwState", wt.DWORD), ("dwLocalAddr", wt.DWORD), ("dwLocalPort", wt.DWORD),
                ("dwRemoteAddr", wt.DWORD), ("dwRemotePort", wt.DWORD), ("dwOwningPid", wt.DWORD)]


_iphlp = ctypes.WinDLL("iphlpapi")
_adv = ctypes.WinDLL("advapi32", use_last_error=True)
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.OpenProcess.restype = wt.HANDLE
_adv.OpenProcessToken.argtypes = [wt.HANDLE, wt.DWORD, ctypes.POINTER(wt.HANDLE)]
_adv.GetTokenInformation.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD)]
_adv.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wt.LPWSTR)]


def _pid_for_client(client_port: int, server_port: int) -> int | None:
    """PID owning the client end of the ESTABLISHED connection 127.0.0.1:client_port -> 127.0.0.1:server_port."""
    size = wt.DWORD(0)
    AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS = 2, 4
    _iphlp.GetExtendedTcpTable(None, ctypes.byref(size), False, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0)
    buf = ctypes.create_string_buffer(size.value + 4096)
    if _iphlp.GetExtendedTcpTable(buf, ctypes.byref(size), False, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) != 0:
        return None
    n = ctypes.cast(buf, ctypes.POINTER(wt.DWORD))[0]
    rows = ctypes.cast(ctypes.addressof(buf) + 4, ctypes.POINTER(_MIB_TCPROW_OWNER_PID * n)).contents
    want_l, want_r = socket.htons(client_port), socket.htons(server_port)
    loopback, established = 0x0100007F, 5  # 127.0.0.1 as a little-endian DWORD; MIB_TCP_STATE_ESTAB
    for r in rows:
        if (
            (r.dwLocalPort & 0xFFFF) == want_l
            and (r.dwRemotePort & 0xFFFF) == want_r
            and r.dwLocalAddr == loopback
            and r.dwRemoteAddr == loopback
            and r.dwState == established
        ):
            return int(r.dwOwningPid)
    return None


class _MIB_TCP6ROW_OWNER_PID(ctypes.Structure):
    _fields_ = [("ucLocalAddr", ctypes.c_ubyte * 16), ("dwLocalScopeId", wt.DWORD), ("dwLocalPort", wt.DWORD),
                ("ucRemoteAddr", ctypes.c_ubyte * 16), ("dwRemoteScopeId", wt.DWORD), ("dwRemotePort", wt.DWORD),
                ("dwState", wt.DWORD), ("dwOwningPid", wt.DWORD)]


def _listeners(port: int) -> list[tuple[int, str]]:
    """Every LISTEN socket on <port>, IPv4 and IPv6, at any address: [(pid, address)]."""
    out: list[tuple[int, str]] = []
    want = socket.htons(port)
    TCP_TABLE_OWNER_PID_LISTENER = 3
    for fam, row_t in ((2, _MIB_TCPROW_OWNER_PID), (23, _MIB_TCP6ROW_OWNER_PID)):
        size = wt.DWORD(0)
        _iphlp.GetExtendedTcpTable(None, ctypes.byref(size), False, fam, TCP_TABLE_OWNER_PID_LISTENER, 0)
        buf = ctypes.create_string_buffer(size.value + 4096)
        if _iphlp.GetExtendedTcpTable(buf, ctypes.byref(size), False, fam, TCP_TABLE_OWNER_PID_LISTENER, 0) != 0:
            raise OSError("listener table unavailable")
        n = ctypes.cast(buf, ctypes.POINTER(wt.DWORD))[0]
        rows = ctypes.cast(ctypes.addressof(buf) + 4, ctypes.POINTER(row_t * n)).contents
        for r in rows:
            if (r.dwLocalPort & 0xFFFF) == want:
                addr = socket.inet_ntoa(int(r.dwLocalAddr).to_bytes(4, "little")) if fam == 2 else socket.inet_ntop(socket.AF_INET6, bytes(r.ucLocalAddr))
                out.append((int(r.dwOwningPid), addr))
    return out


def unique_loopback_owner(listeners: list[tuple[int, str]]) -> int | None:
    """The writer port's owner: exactly ONE process listens on the port (at every address, v4 and v6),
    and it holds 127.0.0.1. Anyone else co-binding 0.0.0.0, [::] or another address makes it ambiguous:
    None, and nobody is the writer until it's gone (REVIEW-T6 finding 2)."""
    pids = {pid for pid, _ in listeners}
    if len(pids) != 1:
        return None
    return next(iter(pids)) if any(a == "127.0.0.1" for _, a in listeners) else None


def _listener_pid(port: int) -> int | None:
    """The OS's own server on the writer port, or None if nobody (or more than one process) holds it."""
    try:
        return unique_loopback_owner(_listeners(port))
    except OSError:
        return None


def writer_register_payload(ts: int, capability_sha256: str, nonce: str = "") -> bytes:
    """What the registration proof signs. v1 (no nonce) is still accepted; v2 adds a fresh nonce so two
    registrations in the same second are two different proofs (REVIEW-T6 nit)."""
    return (f"{WRITER_REGISTER_DOMAIN}|{ts}|{capability_sha256}" + (f"|{nonce}" if nonce else "")).encode()


def _sid_of_pid(pid: int) -> str | None:
    h = _k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return None
    tok = wt.HANDLE()
    try:
        if not _adv.OpenProcessToken(h, 0x0008, ctypes.byref(tok)):  # TOKEN_QUERY
            return None
        need = wt.DWORD(0)
        _adv.GetTokenInformation(tok, 1, None, 0, ctypes.byref(need))  # TokenUser
        buf = ctypes.create_string_buffer(need.value)
        if not _adv.GetTokenInformation(tok, 1, buf, need, ctypes.byref(need)):
            return None
        psid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        s = wt.LPWSTR()
        if not _adv.ConvertSidToStringSidW(psid, ctypes.byref(s)):
            return None
        val = s.value
        _k32.LocalFree(s)
        return val
    finally:
        if tok:
            _k32.CloseHandle(tok)
        _k32.CloseHandle(h)


MY_SID = _sid_of_pid(os.getpid())


def _image_name(pid: int) -> str:
    img = sv.process_image(pid) or ""
    return os.path.basename(img)[:60]


# ------------------------------------------------------------------ approvals
def approval_payload(approval_id: str, expiry: int, method: str, path: str) -> bytes:
    return f"{approval_id}|{expiry}|{method.upper()}|{path}".encode()


def mint_approval(secret: bytes, approval_id: str, method: str, path: str, ttl_s: int = 600) -> str:
    expiry = int(time.time()) + ttl_s
    mac = hmac.new(secret, approval_payload(approval_id, expiry, method, path), hashlib.sha256).hexdigest()
    return f"{approval_id}.{expiry}.{mac}"


class Proxy:
    def __init__(self, profile: dict):
        self.p = profile
        px = profile["proxy"]
        self.port = int(px["port"])
        self.read_patterns = list(px.get("read_banks", []))
        self.write_patterns = list(px.get("write_banks", []))
        self.run_dir = Path(profile["run_dir"])
        self.flag = self.run_dir / "WRITES_ENABLED"
        self.log_path = self.run_dir / "proxy.jsonl"
        self.used_path = self.run_dir / "approvals-used.txt"
        self.upstream_port = int(profile["port"])
        self.key, _ = sv.resolve_key(profile)
        sec = Path(px.get("docdelete_secret_file", ""))
        self.approval_secret = sec.read_bytes().strip() if sec.is_file() else None
        self.doc_deletes_per_hour = int(px.get("doc_deletes_per_hour", DOC_DELETES_PER_HOUR))
        self.doc_delete_times: list[float] = []
        # Stage D (REVIEW-STAGE-D B3): when set, only these executables may WRITE (retain, correct,
        # delete, MCP write tools). The AgenticOS memory API (bun.exe) screens every save, records its
        # model and can forget it; Claude Code, Hermes and hindsight-ask save through it, and read here.
        self.write_images = [str(x).lower() for x in px.get("write_images", [])]
        # Track 6: the per-boot writer capability. Off (missing) = exactly the write_images behaviour.
        self.writer_capability = str(px.get("writer_capability", "off")).lower() == "on"
        self.writer_port = int(px.get("writer_port", 8081))
        self.writer: dict | None = None  # {"pid", "cap", "at"}: memory only, never on disk
        self.writer_proofs: dict[str, float] = {}
        self.listener_pid = _listener_pid  # injectable for tests
        self._lock = threading.Lock()
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))

    # -- audit log (no bodies, no content)
    def log(self, **rec):
        rec["ts"] = sv.now_iso()
        line = json.dumps(rec, sort_keys=True)
        if self.key and self.key in line:
            return
        with self._lock:
            if self.log_path.exists() and self.log_path.stat().st_size > 5 * 1024 * 1024:
                self.log_path.replace(self.log_path.with_suffix(".1.jsonl"))
            with open(self.log_path, "a", encoding="utf-8", newline="\n") as f:
                f.write(line + "\n")

    def can_read(self, bank: str) -> bool:
        return any(fnmatch.fnmatchcase(bank, pat) for pat in self.read_patterns)

    def can_write(self, bank: str) -> bool:
        return any(fnmatch.fnmatchcase(bank, pat) for pat in self.write_patterns)

    def writes_enabled(self) -> bool:
        return self.flag.exists()

    def writer_refusal(self, image: str) -> str | None:
        """None if this client may write; otherwise why not (writes go through AgenticOS)."""
        if not self.write_images or (image or "").lower() in self.write_images:
            return None
        return "writes go through AgenticOS (http://127.0.0.1:8081/__memory/mcp); this client may read only"

    def register_writer(self, pid: int | None, image: str, body: bytes | None, now: float | None = None) -> tuple[int, dict]:
        """POST /_mu/writer/register. Accepted only from the process that owns the writer port's LISTEN
        socket, with a fresh, single-use proof made with the document-delete secret. Returns (status, body)."""
        now = time.time() if now is None else now
        refuse = lambda why, code="writer-refused": (403, {"error": f"refused: {why}", "code": code})  # noqa: E731
        if not self.approval_secret:
            return 503, {"error": "writer registration is not configured on this proxy (no document-delete secret)", "code": "writer-unconfigured"}
        try:
            j = json.loads(body or b"{}")
            cap = str(j.get("capability_sha256", ""))
            ts = int(j.get("ts"))
            proof = str(j.get("proof", ""))
            nonce = str(j.get("nonce", ""))
        except (ValueError, TypeError):
            return 400, {"error": "malformed registration", "code": "writer-refused"}
        if not HEX64.match(cap) or not HEX64.match(proof) or (nonce and not re.fullmatch(r"[0-9a-f]{16,64}", nonce)):
            return 400, {"error": "malformed registration", "code": "writer-refused"}
        if abs(now - ts) > WRITER_REGISTER_SKEW_S:
            return refuse("registration is stale or from the future")
        want = hmac.new(self.approval_secret, writer_register_payload(ts, cap, nonce), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(want, proof):
            return refuse("registration proof does not verify")
        with self._lock:
            self.writer_proofs = {k: v for k, v in self.writer_proofs.items() if now - v < 2 * WRITER_REGISTER_SKEW_S}
            if proof in self.writer_proofs:
                return refuse("registration proof already used")
            self.writer_proofs[proof] = now
        listener = self.listener_pid(self.writer_port)
        if pid is None or listener is None or listener != pid:
            return refuse(
                f"only the process serving 127.0.0.1:{self.writer_port} (the OS), alone on that port, may register as the writer"
            )
        if self.write_images and (image or "").lower() not in self.write_images:
            return refuse("this executable may not write")
        with self._lock:
            self.writer = {"pid": pid, "cap": cap, "at": now}
        return 200, {"ok": True, "registered_pid": pid, "enforced": self.writer_capability}

    def writer_check(self, pid: int | None, header: str | None) -> tuple[str, str] | None:
        """None if this write may go ahead under the writer capability; else (code, why)."""
        if not self.writer_capability:
            return None
        listener = self.listener_pid(self.writer_port)
        w = self.writer
        if listener is None:
            # Nobody, or more than one process, holds the writer port (a co-bind on 0.0.0.0 or [::]): refuse
            # everyone but keep the registration, so a co-bind can't force re-registrations (REVIEW-T6 finding 2).
            return "writer-refused", f"the writer port {self.writer_port} isn't held by exactly one process on 127.0.0.1; writes wait"
        if w is not None and listener != w["pid"]:
            with self._lock:  # the registered OS is gone (or restarted): its capability dies with it
                if self.writer is w:
                    self.writer = None
            w = None
        if w is None:
            if pid is not None and pid == listener:
                return "writer-unregistered", "the OS has not registered its writer capability with this proxy (register, then retry)"
            return "writer-refused", "writes go through AgenticOS (http://127.0.0.1:8081/__memory/mcp); this process isn't the registered writer"
        if pid != w["pid"]:
            if pid is not None and pid == listener:
                return "writer-unregistered", "the OS restarted and must register its writer capability again"
            return "writer-refused", "writes go through AgenticOS (http://127.0.0.1:8081/__memory/mcp); this process isn't the registered writer"
        got = hashlib.sha256((header or "").encode()).hexdigest()
        if not header or not hmac.compare_digest(got, w["cap"]):
            return "writer-refused", "the writer capability does not match"
        return None

    def check_approval(self, token: str | None, method: str, path: str) -> str | None:
        """None if valid; otherwise the reason it was refused. Only document deletes reach here."""
        if not self.approval_secret:
            return "approval path not configured"
        if not token:
            return "approval token required (forget goes through the approval path)"
        now = time.time()
        with self._lock:
            self.doc_delete_times = [x for x in self.doc_delete_times if now - x < 3600]
            if len(self.doc_delete_times) >= self.doc_deletes_per_hour:
                return f"document-delete rate limit reached ({self.doc_deletes_per_hour} an hour)"
        try:
            approval_id, expiry_s, mac = token.split(".")
            expiry = int(expiry_s)
        except ValueError:
            return "malformed approval token"
        if not re.fullmatch(r"[A-Za-z0-9_\-]{6,80}", approval_id):
            return "malformed approval id"
        if expiry < time.time() or expiry > time.time() + 3600:
            return "approval token expired or too long-lived"
        want = hmac.new(self.approval_secret, approval_payload(approval_id, expiry, method, path), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(want, mac):
            return "approval token does not match this exact request"
        with self._lock:
            used = set(self.used_path.read_text(encoding="utf-8").split()) if self.used_path.exists() else set()
            if approval_id in used:
                return "approval token already used"
            with open(self.used_path, "a", encoding="utf-8", newline="\n") as f:
                f.write(approval_id + "\n")
            self.doc_delete_times.append(time.time())
        return None

    def identify(self, request: Request) -> tuple[bool, int | None, str]:
        client = request.client
        if not client or client.host != "127.0.0.1":
            return False, None, ""
        pid = _pid_for_client(client.port, self.port)
        if pid is None:
            return False, None, ""
        sid = _sid_of_pid(pid)
        return (sid is not None and sid == MY_SID), pid, _image_name(pid)

    async def forward(self, request: Request, path: str, query: str, body: bytes | None) -> Response | None:
        """Forward exactly the checked canonical path. Returns None (caller refuses) if the URL the
        HTTP library would send is not byte-identical to what was checked."""
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP and not k.lower().startswith("x-mu-")}
        headers["Authorization"] = f"Bearer {self.key}"
        headers["Accept-Encoding"] = "identity"  # stream bytes through unchanged, never re-encoded
        expected = (path + (("?" + query) if query else "")).encode("ascii")
        url = httpx.URL(scheme="http", host="127.0.0.1", port=self.upstream_port, raw_path=expected)
        req = self.client.build_request(request.method, url, headers=headers, content=body)
        if req.url.raw_path != expected or req.url.host != "127.0.0.1" or req.url.port != self.upstream_port:
            return None
        up = await self.client.send(req, stream=True)
        out_headers = {k: v for k, v in up.headers.items() if k.lower() not in HOP}

        async def gen():
            try:
                async for chunk in up.aiter_raw():
                    yield chunk
            finally:
                await up.aclose()

        return StreamingResponse(gen(), status_code=up.status_code, headers=out_headers)

    def browser_or_rebinding(self, request: Request) -> str | None:
        """Clients are CLIs and servers, never browsers. Refuse:
          * a Host other than 127.0.0.1:<port> / localhost:<port> (DNS rebinding: a page on
            evil.example that resolves to 127.0.0.1 runs as the same Windows user);
          * any Origin header, and any Sec-Fetch-Site header (browsers send these; Bun, curl, httpx
            and the Claude/Hermes clients do not). Node's server-side fetch sends only
            `Sec-Fetch-Mode: cors` (checked 28 Sep), which carries no browser signal on its own."""
        host = (request.headers.get("host") or "").strip().lower()
        if host not in (f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
            return "Host header is not this proxy's loopback address"
        if "origin" in request.headers:
            return "browser request (Origin header)"
        if "sec-fetch-site" in request.headers:
            return "browser request (Sec-Fetch-Site header)"
        return None

    async def handle(self, request: Request) -> Response:
        method = request.method.upper()
        ok, pid, image = self.identify(request)
        base = {"method": method, "route": None, "client_pid": pid, "client": image}
        why = self.browser_or_rebinding(request)
        if why:
            self.log(**base, decision="reject_browser", why=why)
            return JSONResponse({"error": f"rejected: {why}"}, status_code=403)
        if not ok:
            self.log(**base, decision="deny", why="caller is not a process of the proxy's Windows user")
            return JSONResponse({"error": "forbidden: caller identity not verified"}, status_code=403)

        path, why = canonical_path(request.scope.get("raw_path"), request.scope.get("path", ""))
        if path is None:
            self.log(**base, decision="reject_noncanonical", why=why)
            return JSONResponse({"error": f"rejected: {why}"}, status_code=400)
        query = (request.scope.get("query_string") or b"").decode("latin-1")

        if path == WRITER_REGISTER_PATH:
            base.update(route=WRITER_REGISTER_PATH)
            if method != "POST" or query:
                return JSONResponse({"error": "POST only"}, status_code=405)
            body = await request.body()
            if len(body) > 4096:
                return JSONResponse({"error": "request too large"}, status_code=413)
            status, out = self.register_writer(pid, image, body)
            self.log(**base, decision="allow" if status == 200 else "deny", why=None if status == 200 else out.get("error"))
            return JSONResponse(out, status_code=status)

        m = MCP_PATH.match(path)
        if m:
            bank = m.group("bank")
            base.update(route="/mcp/{bank}/", bank=bank)
            if method not in MCP_METHODS or query:
                self.log(**base, decision="deny", why="MCP method or query not allowed")
                return JSONResponse({"error": "not allowed"}, status_code=403)
            if not self.can_read(bank):
                self.log(**base, decision="deny", why="bank not allowed")
                return JSONResponse({"error": f"bank '{bank}' is not available through the proxy"}, status_code=403)
            body = await request.body() if method == "POST" else None
            if body and len(body) > MAX_BODY:
                return JSONResponse({"error": "request too large"}, status_code=413)
            if body:
                try:
                    msg = json.loads(body)
                except ValueError:
                    msg = None
                calls = msg if isinstance(msg, list) else [msg]
                for c in calls:
                    if isinstance(c, dict) and c.get("method") == "tools/call":
                        name = (c.get("params") or {}).get("name")
                        base["tool"] = name
                        if name in MCP_WRITE_TOOLS:
                            why = None
                            if not self.writes_enabled():
                                why = "memory writes are OFF"
                            elif self.writer_refusal(image):
                                why = self.writer_refusal(image)
                            elif self.writer_check(pid, request.headers.get("x-mu-writer")):
                                why = self.writer_check(pid, request.headers.get("x-mu-writer"))[1]
                            elif not self.can_write(bank):
                                why = "bank is read-only through the proxy"
                            if why:
                                self.log(**base, decision="deny", why=why)
                                return JSONResponse({"jsonrpc": "2.0", "id": c.get("id"),
                                                     "error": {"code": -32001, "message": f"refused by proxy: {why}"}},
                                                    status_code=200)
            resp = await self.forward(request, path, "", body)
            if resp is None:
                self.log(**base, decision="reject_noncanonical", why="upstream URL differs from the checked path")
                return JSONResponse({"error": "rejected: non-canonical upstream URL"}, status_code=400)
            self.log(**base, decision="allow", status=resp.status_code)
            return resp

        kind = bank = template = None
        query_ok = False
        for meth, rx, k, tpl, qok in RULES:
            mm = rx.match(path)
            if meth == method and mm:
                kind, bank, template, query_ok = k, mm.groupdict().get("bank"), tpl, qok
                break
        base.update(route=template, bank=bank)
        if kind is None:
            self.log(**base, decision="deny", why="route not allowed through the proxy")
            return JSONResponse({"error": "route not allowed through the proxy"}, status_code=403)
        if query and (not query_ok or not QUERY_CHARS.match(query)):
            self.log(**base, decision="deny", why="query string not allowed on this route")
            return JSONResponse({"error": "query string not allowed on this route"}, status_code=403)
        if bank is not None and not self.can_read(bank):
            self.log(**base, decision="deny", why="bank not allowed")
            return JSONResponse({"error": f"bank '{bank}' is not available through the proxy"}, status_code=403)
        body = await request.body() if method in ("POST", "PATCH") else None
        if body and len(body) > MAX_BODY:
            return JSONResponse({"error": "request too large"}, status_code=413)
        if kind in ("write", "write_retain", "doc_delete"):
            if not self.writes_enabled():
                self.log(**base, decision="deny", why="memory writes are OFF")
                return JSONResponse({"error": "memory writes are OFF (enabled by the lead after acceptance)"}, status_code=403)
            if self.writer_refusal(image):
                self.log(**base, decision="deny", why="client may read only")
                return JSONResponse({"error": f"refused: {self.writer_refusal(image)}", "code": "writer-refused"}, status_code=403)
            wc = self.writer_check(pid, request.headers.get("x-mu-writer"))
            if wc:
                self.log(**base, decision="deny", why=wc[0])
                return JSONResponse({"error": f"refused: {wc[1]}", "code": wc[0]}, status_code=403)
            if not self.can_write(bank):
                self.log(**base, decision="deny", why="bank is read-only through the proxy")
                return JSONResponse({"error": f"bank '{bank}' is read-only through the proxy"}, status_code=403)
            if kind == "write_retain" and body:
                try:
                    j = json.loads(body)
                    if isinstance(j, dict):
                        j["async"] = False  # async payloads outlive a forget; always synchronous here
                        body = json.dumps(j).encode()
                except ValueError:
                    return JSONResponse({"error": "retain body must be JSON"}, status_code=400)
        if kind == "doc_delete":
            why = self.check_approval(request.headers.get("x-mu-approval"), method, path)
            if why:
                self.log(**base, decision="deny", why=why)
                return JSONResponse({"error": f"refused: {why}"}, status_code=403)
        resp = await self.forward(request, path, query, body)
        if resp is None:
            self.log(**base, decision="reject_noncanonical", why="upstream URL differs from the checked path")
            return JSONResponse({"error": "rejected: non-canonical upstream URL"}, status_code=400)
        self.log(**base, decision="allow", status=resp.status_code)
        return resp


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="pilot")
    ap.add_argument("--config", default=str(sv.DEFAULT_CONFIG))
    a = ap.parse_args(argv)
    profile = sv.load_profile(Path(a.config), a.profile)
    px = Proxy(profile)
    if not px.key:
        print("no API key available to the proxy", file=sys.stderr)
        return 5
    if not MY_SID:
        print("cannot determine the proxy's own user SID", file=sys.stderr)
        return 7
    app = Starlette(routes=[Route("/{path:path}", px.handle, methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"])])
    uvicorn.run(app, host="127.0.0.1", port=px.port, log_level="warning", access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
