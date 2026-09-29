"""Track 6: the proxy's per-boot writer capability (the bun.exe bypass fix).

Pure logic, no sockets: the TCP-table lookups are injected. Synthetic secrets only.
Run:  D:\\hindsight\\venv\\Scripts\\python.exe -m unittest discover -s scripts/hindsight/tests -p "test_*.py" -v
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import proxy as px  # noqa: E402

SECRET = b"synthetic-docdelete-secret-not-real"
OS_PID, AGENT_PID, NEW_OS_PID = 4242, 5151, 6363


def make_proxy(enforce: bool = True, write_images=("bun.exe",)) -> px.Proxy:
    run = tempfile.mkdtemp(prefix="t6-writer-")
    sec = os.path.join(run, "docdelete.key")
    with open(sec, "wb") as f:
        f.write(SECRET)
    profile = {
        "port": 18893,
        "run_dir": run,
        "key_file": os.path.join(run, "none.key"),
        "api_key_env": "T6_SYNTHETIC_NO_KEY",
        "proxy": {
            "port": 18884,
            "read_banks": ["syn-*"],
            "write_banks": ["syn-*"],
            "docdelete_secret_file": sec,
            "write_images": list(write_images),
            "writer_capability": "on" if enforce else "off",
            "writer_port": 18097,
        },
    }
    p = px.Proxy(profile)
    p.listener = {"pid": OS_PID}
    p.listener_pid = lambda port: p.listener["pid"]  # the OS owns the writer port
    return p


def registration(cap_hex: str, ts: int | None = None, secret: bytes = SECRET) -> tuple[bytes, str]:
    ts = int(time.time()) if ts is None else ts
    cap_sha = hashlib.sha256(cap_hex.encode()).hexdigest()
    proof = hmac.new(secret, px.writer_register_payload(ts, cap_sha), hashlib.sha256).hexdigest()
    return json.dumps({"capability_sha256": cap_sha, "ts": ts, "proof": proof}).encode(), proof


CAP = "a1" * 32
OTHER = "b2" * 32


class WriterCapabilityTests(unittest.TestCase):
    def test_the_os_registers_and_writes_with_its_capability(self):
        p = make_proxy()
        body, _ = registration(CAP)
        self.assertEqual(p.register_writer(OS_PID, "bun.exe", body)[0], 200)
        self.assertIsNone(p.writer_check(OS_PID, CAP))

    def test_another_bun_process_cannot_write_even_with_every_other_header(self):
        p = make_proxy()
        p.register_writer(OS_PID, "bun.exe", registration(CAP)[0])
        self.assertEqual(p.writer_check(AGENT_PID, None)[0], "writer-refused")
        self.assertEqual(p.writer_check(AGENT_PID, OTHER)[0], "writer-refused")
        # Even holding the right capability (stolen from memory), a different PID is refused.
        self.assertEqual(p.writer_check(AGENT_PID, CAP)[0], "writer-refused")

    def test_a_forged_registration_from_a_process_that_isnt_the_listener_is_refused(self):
        p = make_proxy()
        status, out = p.register_writer(AGENT_PID, "bun.exe", registration(OTHER)[0])
        self.assertEqual(status, 403)
        self.assertIn("only the process serving", out["error"])
        self.assertIsNone(p.writer)

    def test_bad_stale_and_replayed_proofs_are_refused(self):
        p = make_proxy()
        self.assertEqual(p.register_writer(OS_PID, "bun.exe", registration(CAP, secret=b"wrong")[0])[0], 403)
        self.assertEqual(p.register_writer(OS_PID, "bun.exe", registration(CAP, ts=int(time.time()) - 600)[0])[0], 403)
        self.assertEqual(p.register_writer(OS_PID, "bun.exe", registration(CAP, ts=int(time.time()) + 600)[0])[0], 403)
        body, _ = registration(CAP)
        self.assertEqual(p.register_writer(OS_PID, "bun.exe", body)[0], 200)
        status, out = p.register_writer(OS_PID, "bun.exe", body)
        self.assertEqual(status, 403)
        self.assertIn("already used", out["error"])
        self.assertEqual(p.register_writer(OS_PID, "bun.exe", b"{not json")[0], 400)
        self.assertEqual(p.register_writer(OS_PID, "bun.exe", json.dumps({"capability_sha256": "x", "ts": 1, "proof": "y"}).encode())[0], 400)

    def test_a_registration_proof_is_never_a_delete_token(self):
        # Domain separation: the registration MAC can't verify as a document-delete approval.
        p = make_proxy()
        ts = int(time.time())
        cap_sha = hashlib.sha256(CAP.encode()).hexdigest()
        proof = hmac.new(SECRET, px.writer_register_payload(ts, cap_sha), hashlib.sha256).hexdigest()
        why = p.check_approval(f"reg{cap_sha[:6]}.{ts + 60}.{proof}", "DELETE", "/v1/default/banks/syn-x/documents/d")
        self.assertIsNotNone(why)

    def test_no_registration_yet_the_os_is_told_to_register_others_are_refused(self):
        p = make_proxy()
        self.assertEqual(p.writer_check(OS_PID, CAP)[0], "writer-unregistered")  # e.g. after a proxy restart
        self.assertEqual(p.writer_check(AGENT_PID, CAP)[0], "writer-refused")

    def test_os_restart_new_pid_must_register_again_and_the_old_capability_dies(self):
        p = make_proxy()
        p.register_writer(OS_PID, "bun.exe", registration(CAP)[0])
        p.listener["pid"] = NEW_OS_PID  # the OS restarted: a new process owns 8081
        self.assertEqual(p.writer_check(OS_PID, CAP)[0], "writer-refused")  # the dead PID (or a reuser of it)
        self.assertIsNone(p.writer)
        self.assertEqual(p.writer_check(NEW_OS_PID, CAP)[0], "writer-unregistered")
        self.assertEqual(p.register_writer(NEW_OS_PID, "bun.exe", registration(OTHER)[0])[0], 200)
        self.assertIsNone(p.writer_check(NEW_OS_PID, OTHER))
        self.assertEqual(p.writer_check(NEW_OS_PID, CAP)[0], "writer-refused")

    def test_pid_reuse_after_the_os_died_is_refused(self):
        p = make_proxy()
        p.register_writer(OS_PID, "bun.exe", registration(CAP)[0])
        p.listener["pid"] = None  # the OS is down: nobody owns 8081
        self.assertEqual(p.writer_check(OS_PID, CAP)[0], "writer-refused")

    def test_a_newer_registration_by_the_same_os_replaces_the_old_capability(self):
        p = make_proxy()
        p.register_writer(OS_PID, "bun.exe", registration(CAP)[0])
        p.register_writer(OS_PID, "bun.exe", registration(OTHER)[0])
        self.assertIsNone(p.writer_check(OS_PID, OTHER))
        self.assertEqual(p.writer_check(OS_PID, CAP)[0], "writer-refused")

    def test_write_images_still_applies_to_registration(self):
        p = make_proxy()
        status, _ = p.register_writer(OS_PID, "python.exe", registration(CAP)[0])
        self.assertEqual(status, 403)

    def test_a_co_bind_on_the_writer_port_is_ambiguous_nobody_writes_and_the_registration_survives(self):
        """REVIEW-T6 finding 2: another process binding 0.0.0.0 or [::] beside the OS's 127.0.0.1."""
        for rows in ([(OS_PID, "127.0.0.1"), (AGENT_PID, "0.0.0.0")], [(OS_PID, "127.0.0.1"), (AGENT_PID, "::")], [(AGENT_PID, "0.0.0.0")], [(AGENT_PID, "::1")]):
            self.assertIsNone(px.unique_loopback_owner(rows), rows)
        self.assertEqual(px.unique_loopback_owner([(OS_PID, "127.0.0.1")]), OS_PID)
        self.assertEqual(px.unique_loopback_owner([(OS_PID, "127.0.0.1"), (OS_PID, "::1")]), OS_PID)  # one process, two addresses
        p = make_proxy()
        p.register_writer(OS_PID, "bun.exe", registration(CAP)[0])
        p.listener_pid = lambda port: px.unique_loopback_owner([(OS_PID, "127.0.0.1"), (AGENT_PID, "0.0.0.0")])
        # The attacker can't register (not the unique owner), can't write, and the OS's own writes wait...
        self.assertEqual(p.register_writer(AGENT_PID, "bun.exe", registration(OTHER)[0])[0], 403)
        self.assertEqual(p.writer_check(AGENT_PID, OTHER)[0], "writer-refused")
        self.assertEqual(p.writer_check(OS_PID, CAP)[0], "writer-refused")
        # ...but the registration is kept: once the co-bind is gone, the OS writes again without re-registering.
        self.assertIsNotNone(p.writer)
        p.listener_pid = lambda port: OS_PID
        self.assertIsNone(p.writer_check(OS_PID, CAP))

    def test_a_same_second_re_registration_with_a_fresh_nonce_is_not_a_replay(self):
        p = make_proxy()
        ts = int(time.time())
        cap_sha = hashlib.sha256(CAP.encode()).hexdigest()
        for nonce in ("0" * 32, "1" * 32):
            proof = hmac.new(SECRET, px.writer_register_payload(ts, cap_sha, nonce), hashlib.sha256).hexdigest()
            body = json.dumps({"capability_sha256": cap_sha, "ts": ts, "nonce": nonce, "proof": proof}).encode()
            self.assertEqual(p.register_writer(OS_PID, "bun.exe", body)[0], 200)
        self.assertEqual(p.register_writer(OS_PID, "bun.exe", body)[0], 403)  # the same body again is a replay

    def test_off_keeps_todays_behaviour(self):
        p = make_proxy(enforce=False)
        self.assertIsNone(p.writer_check(AGENT_PID, None))  # only write_images decides, as before
        # Registration is accepted while off (so the OS can register before enforcement is switched on).
        status, out = p.register_writer(OS_PID, "bun.exe", registration(CAP)[0])
        self.assertEqual((status, out["enforced"]), (200, False))

    def test_the_capability_and_secret_never_reach_the_log(self):
        p = make_proxy()
        body, proof = registration(CAP)
        status, out = p.register_writer(OS_PID, "bun.exe", body)
        p.log(method="POST", route=px.WRITER_REGISTER_PATH, decision="allow", why=None)
        with open(p.log_path, encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn(CAP, text)
        self.assertNotIn(proof, text)
        self.assertNotIn(SECRET.decode(), text)
        self.assertNotIn(CAP, json.dumps(out))

    def test_pilot_profile_enforces_the_capability_on_the_os_port_and_synthetic_profiles_do_not(self):
        with open(os.path.join(os.path.dirname(HERE), "hindsight.profiles.json"), encoding="utf-8") as f:
            prof = json.load(f)
        pilot = prof["profiles"]["pilot"]["proxy"]
        self.assertEqual((pilot.get("writer_capability"), pilot.get("writer_port")), ("on", 8081))
        for name, p in prof["profiles"].items():
            if name != "pilot":
                self.assertEqual(p.get("proxy", {}).get("writer_capability", "off"), "off", name)


if __name__ == "__main__":
    unittest.main()
