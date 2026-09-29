"""READ-ONLY DNS-rebinding / browser-request check against a running proxy (pilot 8878 or synth 8879).
Sends only GET /v1/default/banks and GET /health, byte-for-byte, with hostile Host / Origin / Sec-Fetch
headers. Prints status codes only. Usage: python browser_check.py [port]
"""
import json
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8878


def send(raw: bytes) -> int:
    s = socket.create_connection(("127.0.0.1", PORT), timeout=30)
    try:
        s.sendall(raw)
        r = s.recv(200)
    finally:
        s.close()
    try:
        return int(r.split(b" ", 2)[1])
    except Exception:
        return -1


def get(path: str, headers: dict) -> int:
    h = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
    return send(f"GET {path} HTTP/1.1\r\n{h}Connection: close\r\n\r\n".encode())


ok_host = f"127.0.0.1:{PORT}"
cases = [
    ("rebinding Host evil.example", get("/v1/default/banks", {"Host": "evil.example"}), 403),
    ("rebinding Host evil.example:<port>", get("/v1/default/banks", {"Host": f"evil.example:{PORT}"}), 403),
    ("Host 127.0.0.1 without port", get("/v1/default/banks", {"Host": "127.0.0.1"}), 403),
    ("Origin present", get("/v1/default/banks", {"Host": ok_host, "Origin": "http://evil.example"}), 403),
    ("Origin null", get("/v1/default/banks", {"Host": ok_host, "Origin": "null"}), 403),
    ("Sec-Fetch-Site + Sec-Fetch-Mode: cors", get("/v1/default/banks", {"Host": ok_host, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors"}), 403),
    ("Sec-Fetch-Mode: cors alone (Node server-side fetch)", get("/v1/default/banks", {"Host": ok_host, "Sec-Fetch-Mode": "cors"}), 200),
    ("Host localhost:<port>", get("/health", {"Host": f"localhost:{PORT}"}), 200),
    ("plain client", get("/health", {"Host": ok_host}), 200),
    ("HTTP/1.0 without Host", send(b"GET /v1/default/banks HTTP/1.0\r\n\r\n"), 403),
]
res = [{"case": c, "status": s, "expected": e, "pass": s == e or (e == 403 and s == 400)} for c, s, e in cases]
print(json.dumps({"port": PORT, "results": res, "all_pass": all(r["pass"] for r in res)}, indent=2))
sys.exit(0 if all(r["pass"] for r in res) else 1)
